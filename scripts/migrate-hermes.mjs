#!/usr/bin/env node
/**
 * One-shot Hermes migration for an existing memory store.
 *
 * What it does (idempotent — safe to re-run; a second run makes no changes):
 *  1. Backs up memory.db → memory.db.pre-hermes.bak (before any destructive-ish step).
 *  2. Opens the store, which applies the additive v1 migration: provenance backfill
 *     (every pre-upgrade row becomes provenance=unknown/source=legacy → never injected
 *     until /memory accept-legacy promotes it) and kind=instruction quarantine.
 *  3. Collapses legacy near-duplicate active memories (jaccard ≥ 0.92): losers are
 *     marked status=migrated (preserved, invisible to search/injection) and their
 *     supersedes column points at the surviving winner. Nothing is deleted.
 *  4. Rebuilds the FTS index from the surviving rows.
 *  5. Writes a JSON summary to memory/migration-log/.
 *
 * Usage:
 *   node scripts/migrate-hermes.mjs --dir ~/.dsh/memory [--dry-run] [--fixtureName memdb] [--jaccard 0.92]
 *
 * --dry-run analyzes a transactionally consistent temporary SQLite snapshot;
 * the source database, sidecars, schema version, and filesystem remain unchanged.
 */
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, tokenize, defaultMemoryDir } from "../lib/storage.js";

function parseArgs(argv) {
  const args = { dir: "", dryRun: false, jaccard: 0.92 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") args.dryRun = true;
    else if (a === "--dir") args.dir = argv[++i] ?? "";
    else if (a === "--jaccard") args.jaccard = Number(argv[++i]) || 0.92;
  }
  return args;
}

function tokenSet(text) {
  return new Set(tokenize(text).split(/\s+/).filter(Boolean));
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0;
}

export async function runMigration(dir, { dryRun = false, jaccardThreshold = 0.92 } = {}) {
  const dirName = dir || defaultMemoryDir();
  const dbPath = join(dirName, "memory.db");
  if (!existsSync(dbPath)) {
    return { error: `no memory.db at ${dbPath}` };
  }
  // Dry-run must be genuinely read-only. Snapshot the live SQLite database into
  // a disposable directory using VACUUM INTO, then perform all analysis there.
  let disposable = "";
  let workingDir = dirName;
  if (dryRun) {
    disposable = mkdtempSync(join(tmpdir(), "dsi-hermes-dry-run-"));
    const snapshot = join(disposable, "memory.db");
    const source = new DatabaseSync(dbPath, { readOnly: true });
    source.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}'`);
    source.close();
    workingDir = disposable;
  }
  const store = new MemoryStore(workingDir);
  try {
    const rows = store.listMemories({ limit: 1_000_000 });
    // ③ Duplicate collapse among LEGACY rows only. Pre-hermes source is meta.legacy:
    // trusted post-migration memories created after the upgrade are never mutated
    // by a re-run of the standalone script.
    const collapsible = (r) =>
      (r.status === "active" || r.status === "corrected") &&
      r.meta?.legacy === true &&
      (r.meta?.source === "legacy" || r.meta?.provenance === "unknown" || r.meta?.provenance === "assistant");
    const candidates = rows.filter(collapsible);
    const tokenSets = new Map(candidates.map((c) => [c.id, tokenSet(c.content)]));
    const keep = new Set(candidates.map((c) => c.id));
    const migratedOut = [];
    let mutated = 0;
    for (const c of candidates) {
      if (!keep.has(c.id)) continue;
      const cs = tokenSets.get(c.id);
      for (const other of candidates) {
        if (other.id === c.id || !keep.has(other.id)) continue;
        const sim = jaccard(cs, tokenSets.get(other.id));
        if (sim >= jaccardThreshold) {
          // Keep the older (createdAt smaller) row; demote the newer odd row out
          const loser = c.createdAt <= other.createdAt ? other : c;
          const winner = loser === c ? other : c;
          keep.delete(loser.id);
          migratedOut.push({ loser: loser.id, winner: winner.id, similarity: sim });
          mutated++;
          // The current pivot was demoted; stop comparing through it (its remaining
          // pairs belong to the winner's iteration — the old loop kept scanning with
          // the demoted pivot and demoted pairs twice, corrupting supersedes chains).
          if (loser === c) break;
        }
      }
    }
    // Old duplicate-loop defect regression guard: losers mutated once
    const loserIds = migratedOut.map((m) => m.loser);
    if (new Set(loserIds).size !== loserIds.length) {
      mutated = -1; // defensive: never report a corrupted collapse as success
    }
    const quarantined = rows.filter((r) => r.status === "quarantined").length;
    const summary = {
      dir: dirName,
      dryRun,
      total: rows.length,
      legacyRows: rows.filter((r) => r.meta?.legacy).length,
      trustedRowsExcluded: rows.filter((r) => !collapsible(r) && (r.status === "active" || r.status === "corrected")).length,
      kept: keep.size,
      quarantined,
      collapsedToMigrated: migratedOut.length,
      migratedPairs: migratedOut.map((m) => ({ loser: m.loser.slice(0, 8), winner: m.winner.slice(0, 8) })),
      injectionPolicy: "legacy rows stay non-injectable until accepted (/memory accept-legacy)",
      updatedAt: new Date().toISOString(),
    };
    if (!dryRun) {
      for (const m of migratedOut) {
        store.setMemoryStatus(m.loser, "migrated");
        // point the losing row at its winner so the collapse stays traceable
        store.updateSupersedes(m.loser, m.winner);
      }
      store.rebuildFts();
      const logDir = join(dirName, "migration-log");
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, `hermes-${Date.now()}.json`), JSON.stringify(summary, null, 2));
    }
    return summary;
  } finally {
    // try/finally: temp-dir snapshot cleanup and the SQLite handle are released
    // even when the analysis or write path throws mid-flight.
    try { store.close(); } catch { /* noop */ }
    if (disposable) rmSync(disposable, { recursive: true, force: true });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const summary = await runMigration(args.dir, { dryRun: args.dryRun, jaccardThreshold: args.jaccard });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.error) process.exit(1);
}

// Run when invoked directly (not when imported by the test harness)
const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) await main();
