#!/usr/bin/env node
/**
 * Retro-scrub provenance for memories whose evidence originates in delegated
 * (coordinator-authored) sessions rather than direct human turns.
 *
 * What counts as a delegated chain (deterministic):
 *  1) every session id whose persisted harness SessionHeader stamps
 *     `origin: 'subagent'` / `delegationDepth > 0` / a `parentSession` — the same
 *     signal the runtime capture now uses (src/capture.ts isDelegatedHeader);
 *  2) an explicit id allowlist on the command line (--session <id>, repeatable).
 *
 * Demotion is conservative and reversible — rows are never deleted:
 *  - memories whose meta.session_id, or ANY evidence.sessionId, resolves to a
 *    delegated session: provenance → 'coordinator' (non-injectable, out of recall
 *    lanes and persona synthesis; still searchable-less and fully recoverable);
 *  - any evidence entry whose sessionId resolves to a delegated session is dropped
 *    from the row's evidence list (the snippet stays quoted in the audit trail);
 *  - any baseline pin pointing at a demoted row is removed;
 *  - rows whose ONLY human-looking signal was the demoted session are additionally
 *    quarantined only when they have NO other evidence at all (still recoverable).
 *
 * Usage:
 *   node scripts/retro-scrub-provenance.mjs --dry-run
 *   node scripts/retro-scrub-provenance.mjs [--session <id> ...]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { MemoryStore, defaultMemoryDir } from "../lib/storage.js";

const args = process.argv.slice(2);
const dry = args.includes("--dry-run");
const sessionAllowlist = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--session") sessionAllowlist.push(String(args[++i]));
}

/** Scan the harness session store and collect delegated (subagent-chain) session ids. */
function collectDelegatedSessionIds() {
  const root = join(resolveDshHome(undefined, process.env), "sessions");
  const delegated = new Map();
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      const st = statSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) { walk(p); continue; }
      if (!st.isFile()) continue;
      if (e === "session.jsonl.zstd") {
        try {
          const head = execFileSync("zstd", ["-dc", p], { maxBuffer: 1 << 26 }).toString().split("\n")[0];
          const header = JSON.parse(head);
          if (header?.type === "session" && (header.origin === "subagent" || (header.delegationDepth ?? 0) > 0 || typeof header.parentSession === "string")) {
            delegated.set(String(header.id), { origin: header.origin ?? null, depth: header.delegationDepth ?? 0 });
          }
        } catch { /* unreadable session file: skip */ }
      }
    }
  };
  walk(root);
  return delegated;
}

const delegated = collectDelegatedSessionIds();
for (const id of sessionAllowlist) delegated.set(id, { origin: "allowlist", depth: 0 });
console.log(`[scrub] delegated sessions detected in harness session store: ${delegated.size}`);

const store = new MemoryStore(defaultMemoryDir());
const db = store.db;

// Evidence-snippet phrasing that matches delegation prompts / agent briefs rather
// than spoken user phrasing (verbatim-match backstop beyond the session-id rule).
const BRIEF_PHRASING_RES = [
  /\b(?:task brief|delegating agent|delegated subagent|coordinator (?:model|session)|parent agent report)\b/i,
  /\b(?:previous agents|prior agents|earlier agents)'(?:s)? (?:task briefs|design docs|briefs)\b/i,
  /\b(?:user-approved baseline-seed brief|baseline-seed brief)\b/i,
  /\byou are a delegated subagent\b/i,
  /\breported?:\s*\b/i,
  /\bprove the two failures\b/i,
];
const isBriefPhrasing = (s) =>
  typeof s === "string" && BRIEF_PHRASING_RES.some((re) => re.test(s));

const rows = db
  .prepare(`SELECT memory_id, provenance, source, session_id, evidence FROM memories_meta WHERE provenance IN ('user','persona')`)
  .all();

let demoted = 0;
let unpinned = 0;
let quarantined = 0;
const demotedIds = new Set();

for (const row of rows) {
  const id = String(row.memory_id);
  const evidence = (() => {
    try {
      const arr = JSON.parse(String(row.evidence ?? "[]"));
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  })();
  const delegatedHits = [];
  const humanHits = [];
  const sessionId = row.session_id == null ? null : String(row.session_id);
  if (sessionId) (delegated.has(sessionId) ? delegatedHits : humanHits).push(sessionId);
  for (const ev of evidence) {
    if (!ev?.sessionId) continue; // sessionId-less snippets: no decidable origin here
    (delegated.has(String(ev.sessionId)) ? delegatedHits : humanHits).push(String(ev.sessionId));
  }
  const briefEvidence = evidence.filter((ev) => isBriefPhrasing(ev?.snippet));
  const isDelegatedTrace = delegatedHits.length > 0 || briefEvidence.length > 0;
  if (!isDelegatedTrace) continue;
  // Exclusion (post over-demotion fix): many seeded rows APPENDED subagent-cited
  // evidence, but the underlying fact was verbatim-stated by the human in a
  // TOP-LEVEL session. Evidence citing ANY resolvable top-level (non-delegated)
  // session id proves human authorship — downgrade only when ALL evidence
  // references trace to a delegated chain (or unverifiable brief phrasing alone).
  if (humanHits.length > 0) {
    console.log(`[scrub] skip ${id} — human-evidence found in ${humanHits.join(", ")}`);
    continue;
  }

  if (dry) {
    console.log(`[scrub dry-run] would demote ${id} (limit to summary: content below)`);
  } else {
    db.prepare(`UPDATE memories_meta SET provenance = 'coordinator', evidence = ? WHERE memory_id = ?`).run(
      // keep only evidence that did not originate from a delegated chain
      JSON.stringify(evidence.filter((ev) =>
        !(ev?.sessionId && delegated.has(String(ev.sessionId))) && !isBriefPhrasing(ev?.snippet)
      )),
      id,
    );
    demoted++;
    demotedIds.add(id);
    db.prepare(`UPDATE memories SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
  }
  console.log(
    `[scrub] demote ${id} (was provenance=${String(row.provenance)}) — delegated evidence: ${delegatedHits.join(", ") || "brief phrasing"}`,
  );
}

// Pins: a baseline slot whose memory was demoted is removed from the curated profile.
const pins = db.prepare(`SELECT slot, memory_id FROM baseline`).all();
for (const pin of pins) {
  if (!demotedIds.has(pin.memory_id) && dry) continue;
  if (dry) {
    console.log(`[scrub dry-run] would unpin slot ${pin.slot} (${pin.memory_id})`);
    continue;
  }
  if (demotedIds.has(pin.memory_id)) {
    const res = db.prepare(`DELETE FROM baseline WHERE slot = ?`).run(pin.slot);
    if (res.changes > 0) unpinned++;
    console.log(`[scrub] unpinned baseline slot ${pin.slot} (${pin.memory_id})`);
  }
}

if (!dry) {
  // Quarantine rows that no longer carry any trusted evidence (kept recoverable; never deleted)
  for (const id of [...demotedIds]) {
    const meta = store.getMeta(id);
    if (meta && (meta.evidence ?? []).length === 0) {
      store.setMemoryStatus(id, "quarantined");
      quarantined++;
      console.log(`[scrub] quarantined (no human evidence left): ${id}`);
    }
  }
  console.log(`[scrub] done: demoted=${demoted}, unpinned=${unpinned}, quarantined=${quarantined}`);
} else {
  console.log("[scrub] dry run complete — pass no --dry-run to apply");
}
store.close();
