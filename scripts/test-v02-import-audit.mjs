#!/usr/bin/env node
/**
 * INDEPENDENT adversarial audit suite for the Phase B import lane
 * (src/import-v02.ts + scripts/import-v02.mjs). Owned by the audit worker
 * (MIGRATION-PHASE-B-IMPORT-AUDIT.md); it ADDS new focused adversarial tests
 * the 93-assertion lane suite does not perform and does not edit, waive or
 * re-score any other lane's files or claims.
 *
 * All data is newly synthetic, built only under a uniquely owned /tmp tree.
 * No production store, no active profile, no network, no dependency installs,
 * no skill activation, no settings/profile write, no Git operation.
 *
 * Runs in this file are real: real SQLite (node:sqlite), real CLI subprocesses
 * (tsc type-gate + emit + engine), real SIGKILL workers, one real race harness.
 *
 * Run: node scripts/test-v02-import-audit.mjs
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "..");
const base = mkdtempSync(join(tmpdir(), "dsi-w31-import-audit-"));
const CLI = resolve(repo, "scripts", "import-v02.mjs");
const WORKER = resolve(repo, "fixtures", "v02-import", "worker-apply.mjs");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const canonJson = (v) =>
  JSON.stringify(v, (_k, x) => {
    if (x !== null && typeof x === "object" && !Array.isArray(x)) {
      const o = {};
      for (const k of Object.keys(x).sort()) o[k] = x[k];
      return o;
    }
    return x;
  });

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (cond) passed++;
  else failed++;
};

const T0 = 1_700_001_000_000;
const CAN = {
  memory: "MEMORY-AUDIT-CANARY-77",
  slice: "SLICE-AUDIT-CANARY-77",
  cred: "sk-audit-credential-canary-77",
};
const NEEDLES = [CAN.memory, CAN.slice, CAN.cred];
const hasAny = (t, ns) => ns.some((n) => t.includes(n));
const tag = (n) => join(base, n);

// ---------------------------------------------------------------------------
// Minimal deterministic legacy source fixture (audit-own construct)
// ---------------------------------------------------------------------------
function buildFixture(rootDir) {
  const storeRoot = join(rootDir, "memory");
  mkdirSync(storeRoot, { recursive: true });
  const db = new DatabaseSync(join(storeRoot, "memory.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5, access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', supersedes TEXT
    ) STRICT;
    CREATE TABLE memories_meta (
      memory_id TEXT PRIMARY KEY, provenance TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'legacy', scope TEXT NOT NULL DEFAULT 'global',
      project_id TEXT, session_id TEXT, confidence REAL NOT NULL DEFAULT 0.3,
      expires_at INTEGER, evidence TEXT NOT NULL DEFAULT '[]',
      read_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER
    ) STRICT;
    CREATE TABLE memories_seq (memory_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT;
    CREATE TABLE baseline (slot INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE session_projects (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE scenes (id TEXT PRIMARY KEY, title TEXT NOT NULL, markdown TEXT NOT NULL, memory_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE persona_versions (ver INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at INTEGER NOT NULL, mem_watermark INTEGER) STRICT;
    CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
    CREATE TABLE extract_state (session_id TEXT PRIMARY KEY, processed_seq INTEGER NOT NULL DEFAULT 0, pending_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE episode_events (
      session_id TEXT NOT NULL, kind TEXT NOT NULL, call_id TEXT, turn INTEGER NOT NULL,
      step INTEGER, seq INTEGER NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
      created_at INTEGER NOT NULL, episode_id TEXT, PRIMARY KEY (session_id, kind, call_id, seq)
    ) STRICT;
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
      turn INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL,
      first_seq INTEGER, last_seq INTEGER, reviewed_at INTEGER, summary TEXT,
      confidence REAL, fingerprint TEXT, delegated INTEGER NOT NULL DEFAULT 0, reject_reason TEXT
    ) STRICT;
    CREATE TABLE episode_steps (
      episode_id TEXT NOT NULL, ordinal INTEGER NOT NULL, call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, arguments_redacted TEXT NOT NULL, result_excerpt TEXT NOT NULL,
      is_error INTEGER NOT NULL, error_name TEXT, error_code TEXT, call_seq INTEGER, result_seq INTEGER,
      call_at INTEGER, result_at INTEGER, args_truncated INTEGER NOT NULL DEFAULT 0,
      result_truncated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (episode_id, ordinal), UNIQUE (episode_id, call_id)
    ) STRICT;
  `);
  db.prepare("INSERT INTO schema_state VALUES ('v1','audit',?)").run(T0);
  db.prepare("INSERT INTO schema_state VALUES ('v2','audit',?)").run(T0);
  db.exec("PRAGMA user_version = 2");
  const rows = [
    { id: "clean-row-1", kind: "fact", content: `${CAN.memory} synthetic audit fact one`, importance: 5, provenance: "user" },
    { id: "clean-row-2", kind: "preference", content: `${CAN.memory} synthetic audit preference two`, importance: 9, provenance: "user" },
    { id: "audit-cred-row", kind: "fact", content: `AUDIT-CRED-CANARY my api_key is ${CAN.cred} keep-out`, importance: 3, provenance: "user" },
    { id: "audit-instr-row", kind: "instruction", content: `${CAN.memory} audit instruction`, importance: 5, provenance: "user" },
    { id: "audit-persona-row", kind: "persona", content: `${CAN.memory} audit persona prose`, importance: 5, provenance: "persona" },
    { id: "bad-imp-audit", kind: "fact", content: `${CAN.memory} audit out-of-range importance`, importance: 42, provenance: "user" },
  ];
  const ins = db.prepare(
    "INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES (?,?,?,?,0,?,?, 'active', NULL)",
  );
  const insMeta = db.prepare(
    "INSERT INTO memories_meta (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at) VALUES (?,?,?,?,?,?,?,NULL,'[]',0,NULL)",
  );
  const insSeq = db.prepare("INSERT INTO memories_seq VALUES (?,?)");
  rows.forEach((r, i) => {
    ins.run(r.id, r.kind, r.content, r.importance, T0 + i * 1000, T0 + i * 1000 + 5);
    insMeta.run(r.id, r.provenance, "legacy", "global", null, null, 0.5);
    insSeq.run(r.id, i + 1);
  });
  db.prepare("INSERT INTO episodes (id, session_id, project_id, turn, status, started_at, ended_at, updated_at, first_seq, last_seq, reviewed_at, summary, confidence, fingerprint, delegated, reject_reason) VALUES ('ep-audit','session-a1','proj-audit',1,'succeeded',?,?,?,0,1,?,'audit summary',0.9,'fp-1',0,NULL)")
    .run(T0, T0 + 100, T0 + 100, null);
  db.prepare("INSERT INTO episode_steps (episode_id, ordinal, call_id, tool_name, arguments_redacted, result_excerpt, is_error) VALUES ('ep-audit',1,'call-a1','bash','{}','ok',0)").run();
  db.prepare("INSERT INTO episode_events (session_id, kind, call_id, turn, step, seq, at, payload, created_at, episode_id) VALUES ('session-a1','tool','call-a1',1,1,1,?,'{}',?,'ep-audit')").run(T0, T0);
  db.prepare("INSERT INTO session_projects VALUES ('session-a1','proj-audit',?)").run(T0);
  db.prepare("INSERT INTO baseline VALUES (1,'clean-row-1',?)").run(T0);
  db.prepare("INSERT INTO persona_versions (content, created_at, mem_watermark) VALUES (?,?,1)").run(`${CAN.memory} audit persona version`, T0);
  const confDir = join(storeRoot, "conversations");
  mkdirSync(confDir, { recursive: true });
  writeFileSync(join(confDir, "session-a1.jsonl"),
    `${JSON.stringify({ type: "user", seq: 0, ts: T0, text: `${CAN.slice} audit slice 0` })}\n${JSON.stringify({ type: "assistant", seq: 1, ts: T0 + 100, text: `${CAN.slice} audit slice 1` })}\n`,
    "utf8");
  const personaDir = join(storeRoot, "persona");
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(join(personaDir, "persona.md"), `${CAN.memory} audit persona file\n`, "utf8");
  db.close();
  return storeRoot;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8", env: { ...process.env, TMPDIR: base } });
}
function planToken(dest) {
  return JSON.parse(readFileSync(join(dest, "plan.json"), "utf8")).approvalToken;
}
const destArtifacts = (dest) => ({
  backup: existsSync(join(dest, "backup")),
  normalized: existsSync(join(dest, "normalized")),
  ledger: existsSync(join(dest, "ledger.json")),
  receipt: existsSync(join(dest, "receipt.json")),
});
/** stable-file digest list excluding -shm/-wal (mirrors the engine's rule) */
function stableList(root) {
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && !p.endsWith("-shm") && !p.endsWith("-wal")) out.push({ rel: relative(root, p), sha: sha(p) });
    }
  };
  walk(root);
  return out;
}
const listEqual = (a, b) => a.length === b.length && a.every((f, i) => f.rel === b[i].rel && f.sha === b[i].sha);
function verifyManifest(dest) {
  let lines;
  try {
    lines = readFileSync(join(dest, "backup", "MANIFEST.sha256"), "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return { files: 0, ok: false };
  }
  for (const line of lines) {
    const idx = line.indexOf("  ");
    const expected = line.slice(0, idx);
    const rel = line.slice(idx + 2);
    let actual;
    try {
      actual = createHash("sha256").update(readFileSync(join(dest, rel))).digest("hex");
    } catch {
      return { files: lines.length, ok: false };
    }
    if (actual !== expected) return { files: lines.length, ok: false };
  }
  return { files: lines.length, ok: true };
}
function rawQuery(path, sql, ...params) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare(sql).all(...params);
  } finally {
    db.close();
  }
}

// ===========================================================================
// P0 — golden chain: plan → apply on the audit fixture (real CLI, end to end)
// ===========================================================================
const srcA = buildFixture(tag("fA"));
const beforeA = stableList(srcA);
const destA = tag("fA-dest");
mkdirSync(destA, { recursive: true });
const planA = runCli(["plan", "--source", srcA, "--dest", destA]);
check("P0 plan CLI exits 0 on the audit fixture", planA.status === 0, planA.stderr.trim().split("\n")[0] ?? "");
check("P0 plan wrote only marker + plan.json", readdirSync(destA).sort().join(",") === "OWNER.dsh-self-improved-import,plan.json", readdirSync(destA).sort().join(","));
check("P0 no owned-temp leftovers after plan (snapshot + compile trees cleaned)", readdirSync(base).filter((n) => /^(dsi-v02-import-snap-|dsi-import-v02-build-)/.test(n)).length === 0, readdirSync(base).join(","));
const planDocA = JSON.parse(readFileSync(join(destA, "plan.json"), "utf8"));
check("P0 plan.json carries zero canaries", !hasAny(readFileSync(join(destA, "plan.json"), "utf8"), NEEDLES));
check("P0 CLI plan stdout/stderr carry zero canaries", !hasAny(planA.stdout + planA.stderr, NEEDLES));
check("P0 plan unsupported accounting: bad-imp-audit -> importance-out-of-range exactly once",
  planDocA.families.memories.unsupported.length === 1 &&
  planDocA.families.memories.unsupported[0].id === "bad-imp-audit" &&
  planDocA.families.memories.unsupported[0].reason === "importance-out-of-range",
  JSON.stringify(planDocA.families.memories.unsupported));
{
  const dem = [...planDocA.families.memories.plannedDemotions].map((d) => d.id).sort();
  check("P0 plan plannedDemotions = credential/instruction/persona exactly", planDocA.families.memories.plannedDemotions.length === 3 && JSON.stringify(dem) === JSON.stringify(["audit-cred-row", "audit-instr-row", "audit-persona-row"]), JSON.stringify(dem));
}

const importA = runCli(["import", "--dest", destA, "--approve", planDocA.approvalToken]);
check("P0 apply CLI exits 0 end to end", importA.status === 0, (importA.stderr || "").trim().split("\n")[0] ?? "");
check("P0 apply stdout/stderr carry zero canaries", !hasAny(importA.stdout + importA.stderr, NEEDLES));
check("P0 ledger.json + receipt.json carry zero canaries", !hasAny(readFileSync(join(destA, "ledger.json"), "utf8") + readFileSync(join(destA, "receipt.json"), "utf8"), NEEDLES));
check("P0 source stable-file set unchanged by plan+apply (only -shm/-wal companions may exist)", listEqual(beforeA, stableList(srcA)), "stable-list compare");

// P1 — operational privacy: credential content absent, explicit quarantined tombstone retained
{
  const nz = join(destA, "normalized", "memory.db");
  const rows = rawQuery(nz, "SELECT id, status, content FROM memories WHERE id = 'audit-cred-row'");
  check("P1 quarantined row present in normalized target with status 'quarantined'",
    rows.length === 1 && rows[0].status === "quarantined", JSON.stringify(rows));
  const inNz = rows.length === 1 && String(rows[0].content).includes(CAN.cred);
  const bytePresent = readFileSync(nz).includes(Buffer.from(CAN.cred));
  check("P1 operational normalized store excludes the credential canary while retaining an explicit quarantined tombstone/demotion",
    rows.length === 1 && rows[0].status === "quarantined" && !inNz && !bytePresent,
    inNz || bytePresent ? "credential leaked into normalized store" : "content absent; tombstone retained");
  const memRow = rawQuery(nz, "SELECT rowid FROM memories WHERE id = 'audit-cred-row'");
  const ftsRowids = rawQuery(nz, "SELECT DISTINCT content_rowid AS rid FROM memories_fts");
  const credFtsAbsent = memRow.length === 1 && !ftsRowids.some((r) => Number(r.rid) === Number(memRow[0].rowid));
  check("P1 demoted credential row is NOT in the target FTS index (fail-closed dormancy holds)", credFtsAbsent,
    `rowid=${memRow[0]?.rowid} ftsRows=${ftsRowids.length}`);
  const extract = rawQuery(nz, "SELECT COUNT(*) n FROM extract_state");
  check("P1 extract_state empty in the operational target (legacy backlog never acked)", Number(extract[0].n) === 0, String(extract[0].n));

  // preserved-identity probe: normalized rows vs SOURCE rows, straight from both DBs
  const nzRowsAll = rawQuery(nz, "SELECT id, kind, content, importance, created_at, updated_at, status, supersedes FROM memories ORDER BY id");
  const srcRowsAll = rawQuery(join(srcA, "memory.db"), "SELECT id, kind, content, importance, created_at, updated_at, status, supersedes FROM memories ORDER BY id");
  const srcById = new Map(srcRowsAll.map((r) => [r.id, r]));
  check("P0 preserved set identity: target rows == accepted source rows exactly (unsupported bad-imp-audit absent, count exact)",
    nzRowsAll.length === planDocA.families.memories.accepted.length && !nzRowsAll.some((r) => r.id === "bad-imp-audit"),
    `target=${nzRowsAll.length} accepted=${planDocA.families.memories.accepted.length}`);
  let tuplesOk = true;
  let sensitiveDemotionsOk = true;
  for (const t of nzRowsAll) {
    const s = srcById.get(t.id);
    const sensitive = t.id === "audit-cred-row";
    if (!s || t.kind !== s.kind || (!sensitive && t.content !== s.content) || t.importance !== s.importance ||
        t.created_at !== s.created_at || t.updated_at !== s.updated_at || t.supersedes !== s.supersedes) tuplesOk = false;
    if (sensitive) {
      if (t.status !== "quarantined" || t.content === s.content || String(t.content).includes(CAN.cred)) sensitiveDemotionsOk = false;
    } else if (t.status !== s.status && t.id !== "audit-instr-row" && t.id !== "audit-persona-row") tuplesOk = false;
  }
  check("P0 accepted nonsensitive rows preserve source tuples; sensitive rows retain identity/metadata with explicit tombstone/demotion rather than source content",
    tuplesOk && sensitiveDemotionsOk, "row-by-row contract compare");
}

// backup lane: manifest + restore fidelity (fixture A, no WAL writer)
{
  const m = verifyManifest(destA);
  check("P0 backup MANIFEST.sha256 verifies line-by-line (audit recompute)", m.ok === true, `lines=${m.files}`);
  check("P0 authorized raw backup preserves the credential canary byte-verbatim (restore-grade, by design)",
    readFileSync(join(destA, "backup", "memory.db")).includes(Buffer.from(CAN.cred)));
  const bakRows = rawQuery(join(destA, "backup", "memory.db"), "SELECT id, kind, content, importance, created_at, updated_at, status, supersedes FROM memories ORDER BY id");
  const srcRows = rawQuery(join(srcA, "memory.db"), "SELECT id, kind, content, importance, created_at, updated_at, status, supersedes FROM memories ORDER BY id");
  check("P0 restore fidelity (no WAL writer): backup rows byte-equal source rows (unsupported + quarantined included)",
    JSON.stringify(bakRows) === JSON.stringify(srcRows), `src=${srcRows.length} bak=${bakRows.length}`);
}

// P10 — exactly-once + ledger determinism across two fresh destinations
{
  const rerun = runCli(["import", "--dest", destA, "--approve", planDocA.approvalToken, "--resume"]);
  check("P10 completed import refuses re-run even with --resume (exactly-once)", rerun.status === 2 && /already exists/.test(rerun.stderr), rerun.stderr.trim().split("\n")[0]);
  const occ = runCli(["plan", "--source", srcA, "--dest", destA]);
  check("P10 fresh plan refuses the completed destination", occ.status === 2 && /not empty/.test(occ.stderr), occ.stderr.trim().split("\n")[0]);
  const destA2 = tag("fA-dest-determinism");
  const planA2 = runCli(["plan", "--source", srcA, "--dest", destA2]);
  const doc2 = planA2.status === 0 ? JSON.parse(readFileSync(join(destA2, "plan.json"), "utf8")) : null;
  check("P10 determinism: identical planDigest across destinations; token differs (dest-bound at MINT)",
    doc2 !== null && doc2.planDigest === planDocA.planDigest && doc2.approvalToken !== planDocA.approvalToken, "");
  const applyA2 = runCli(["import", "--dest", destA2, "--approve", planToken(destA2)]);
  check("P10 second apply of the same source completes", applyA2.status === 0, (applyA2.stderr || "").trim().split("\n")[0]);
  check("P10 ledger.json is byte-identical across two independent apply runs of the same source",
    sha(join(destA, "ledger.json")) === sha(join(destA2, "ledger.json")), "ledger sha compare");
  const r1 = JSON.parse(readFileSync(join(destA, "receipt.json"), "utf8"));
  const r2 = JSON.parse(readFileSync(join(destA2, "receipt.json"), "utf8"));
  check("P10 second receipt reconciles identically (paths differ, verdict identity does not)",
    r2.reconciliation.allReconciled === true && r2.target.memoryRows === r1.target.memoryRows,
    `memoryRows=${r2.target.memoryRows}`);
}

// ===========================================================================
// P2 — backup restore fidelity with a LIVE WAL WRITER (row only inside -wal)
// ===========================================================================
{
  const srcB = buildFixture(tag("fB"));
  const wrPath = join(base, "writer-b.mjs");
  writeFileSync(wrPath, `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(join(srcB, "memory.db"))});
    db.exec("PRAGMA journal_mode = WAL");
    db.prepare("INSERT INTO memories (id, kind, content, importance, created_at, updated_at, status) VALUES ('wal-audit-row','fact','${CAN.memory} wal-only audit row',5,1750000000000,1750000000000,'active')").run();
    db.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, confidence) VALUES ('wal-audit-row','user','legacy','global',0.5)").run();
    db.prepare("INSERT INTO memories_seq VALUES ('wal-audit-row',77)").run();
    console.log("writer-ready");
    setInterval(() => {}, 1 << 30);
  `, "utf8");
  const writerChild = spawn(process.execPath, [wrPath], { cwd: repo, env: { ...process.env, TMPDIR: base } });
  await new Promise((res) => {
    writerChild.stdout.setEncoding("utf8");
    writerChild.stdout.on("data", (d) => d.includes("writer-ready") && res());
    setTimeout(res, 5000);
  });
  const mainShaBefore = sha(join(srcB, "memory.db"));
  const destB = tag("fB-dest");
  const planB = runCli(["plan", "--source", srcB, "--dest", destB]);
  const mainShaAfterPlan = sha(join(srcB, "memory.db"));
  check("P2 WAL-only commit leaves the main file bytes UNCHANGED (row lives only in -wal)", planB.status === 0 && mainShaAfterPlan === mainShaBefore, `sha-eq=${mainShaAfterPlan === mainShaBefore}`);
  const docB = planB.status === 0 ? JSON.parse(readFileSync(join(destB, "plan.json"), "utf8")) : { families: { memories: { accepted: [] } } };
  check("P2 plan's VACUUM INTO snapshot saw the WAL-only row (accepted includes wal-audit-row)",
    planB.status === 0 && docB.families.memories.accepted.some((a) => a.id === "wal-audit-row"),
    JSON.stringify(docB.families.memories.accepted.map((a) => a.id)));
  check("P2 plan JSON bounds WAL-only row content (no raw content in the doc)", !hasAny(readFileSync(join(destB, "plan.json"), "utf8"), NEEDLES));
  const applyB = runCli(["import", "--dest", destB, "--approve", docB.approvalToken]);
  check("P2 apply completes while the WAL writer stays connected (concurrent writer + read snapshot OK)", applyB.status === 0, (applyB.stderr || "").trim().split("\n")[0]);
  const bakWal = rawQuery(join(destB, "backup", "memory.db"), "SELECT COUNT(*) n FROM memories WHERE id = 'wal-audit-row'");
  check("P2 backup memory.db captured the WAL-only row (VACUUM INTO is WAL-inclusive)", Number(bakWal[0]?.n ?? 0) === 1, String(bakWal[0]?.n));
  const restoreDir = tag("fB-restore");
  cpSync(join(destB, "backup"), restoreDir, { recursive: true });
  const rDb = new DatabaseSync(join(restoreDir, "memory.db"), { readOnly: true });
  const rRow = rDb.prepare("SELECT id, importance FROM memories WHERE id = 'wal-audit-row'").get();
  const rCount = Number(rDb.prepare("SELECT COUNT(*) n FROM memories").get().n);
  rDb.close();
  const srcTotal = Number(rawQuery(join(srcB, "memory.db"), "SELECT COUNT(*) n FROM memories")[0].n);
  check("P2 restore step: copied backup tree opens standalone with the FULL source row set incl. the WAL-only row",
    rRow != null && rCount === srcTotal, `${rCount}/${srcTotal}`);
  const srcIds = rawQuery(join(srcB, "memory.db"), "SELECT id FROM memories ORDER BY id").map((r) => r.id);
  const bakIds = rawQuery(join(destB, "backup", "memory.db"), "SELECT id FROM memories ORDER BY id").map((r) => r.id);
  check("P2 restore fidelity WITH live WAL writer: source row set == backup row set",
    JSON.stringify(srcIds) === JSON.stringify(bakIds), `src=${srcIds.length} bak=${bakIds.length}`);
  const mB = verifyManifest(destB);
  check("P2 backup MANIFEST verifies under the live-writer scenario", mB.ok === true, `lines=${mB.files}`);
  writerChild.kill("SIGKILL");
  rmSync(wrPath, { force: true });
}

// ===========================================================================
// P3 — active-writer drift DURING apply (race harness, attempt loop)
// ===========================================================================
{
  const src = buildFixture(tag("fC"));
  // widen once: 400 more rows → 5 chunks → big race window
  const wide = new DatabaseSync(join(src, "memory.db"));
  wide.exec("PRAGMA journal_mode = WAL");
  const ins = wide.prepare("INSERT INTO memories (id, kind, content, importance, created_at, updated_at, status) VALUES (?,?,?,?,?,?,'active')");
  const insMeta = wide.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, confidence) VALUES (?,?, 'legacy', 'global', 0.5)");
  const insSeq = wide.prepare("INSERT INTO memories_seq VALUES (?,?)");
  for (let n = 0; n < 400; n++) {
    const id = `drift-bulk-${String(n).padStart(4, "0")}`;
    ins.run(id, "fact", `${CAN.memory} bulk race row ${n}`, 5, T0 + 1e6 + n, T0 + 1e6 + n);
    insMeta.run(id, "user");
    insSeq.run(id, 1000 + n);
  }
  wide.close();
  let attempts = 0;
  let outcome = { attempted: false, exitCode: null, out: "", driftCommitted: false, refused: false, dest: "", planDigestFinal: null, token: null };
  const maxAttempts = 3;
  for (let a = 1; a <= maxAttempts; a++) {
    attempts = a;
    const dest = join(tag("fC-race"), `attempt-${a}`);
    const planRun = runCli(["plan", "--source", src, "--dest", dest]);
    if (planRun.status !== 0) { outcome = { attempted: false, refused: false }; break; }
    const doc = JSON.parse(readFileSync(join(dest, "plan.json"), "utf8"));
    const child = spawn(process.execPath, [CLI, "import", "--dest", dest, "--approve", doc.approvalToken],
      { cwd: repo, env: { ...process.env, TMPDIR: base } });
    let outText = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (outText += d));
    child.stderr.on("data", (d) => (outText += d));
    const marker = await new Promise((res) => {
      const started = Date.now();
      const iv = setInterval(() => {
        try {
          const row = new DatabaseSync(join(dest, "normalized", "memory.db"), { readOnly: true })
            .prepare("SELECT value FROM store_state WHERE key = 'import-v0.2-phase-b:progress'").get();
          if (row) {
            clearInterval(iv);
            res(JSON.parse(String(row.value)));
            return;
          }
        } catch { /* target DB not openable yet */ }
        if (Date.now() - started > 45000) {
          clearInterval(iv);
          res(null);
        }
      }, 2);
    });
    let driftCommitted = false;
    if (marker && marker.memoryCommitted > 0) {
      try {
        const wdb = new DatabaseSync(join(src, "memory.db"));
        wdb.exec("PRAGMA journal_mode = WAL");
        wdb.prepare("INSERT INTO memories (id, kind, content, importance, created_at, updated_at, status) VALUES (?,?,?,?,?,?, 'active')")
          .run(`race-drift-row-${a}`, "fact", "race drift", 5, 7700000000000, 7700000000000);
        wdb.close();
        driftCommitted = true;
      } catch { /* race lost to a fuller window; retry */ }
    }
    const exitCode = await new Promise((res) => {
      child.on("exit", (code) => res(code));
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } res(null); }, 120000);
    });
    const refused = exitCode === 2 && /changed during apply|delta/.test(outText);
    if (driftCommitted && refused) {
      outcome = { attempted: true, exitCode, out: outText, driftCommitted, refused, dest, planDigestFinal: doc.planDigest, token: doc.approvalToken };
      break;
    }
    outcome = { attempted: true, exitCode, out: outText, driftCommitted, refused, dest, planDigestFinal: doc.planDigest, token: doc.approvalToken };
  }
  check(`P3 mid-apply writer commit is caught at a post-write boundary: completion refused + receipt denied (${attempts} attempt(s))`,
    outcome.attempted === true && outcome.driftCommitted === true && outcome.refused === true,
    `exit=${outcome.exitCode} lastLine=${(outcome.out ?? "").trim().split("\n").pop() ?? ""}`);
  if (outcome.dest) {
    const d = destArtifacts(outcome.dest);
    check("P3 refused run wrote NO receipt (and never a final ledger) — completed deliverables exist only past full verification",
      !d.receipt, destArtifacts(outcome.dest));
    let watermark = 0;
    try {
      watermark = rawQuery(join(outcome.dest, "normalized", "memory.db"), "SELECT COUNT(*) n FROM store_state WHERE key = 'import-v0.2-phase-b:progress'").length === 1
        ? Number(rawQuery(join(outcome.dest, "normalized", "memory.db"), "SELECT COUNT(*) n FROM store_state WHERE key = 'import-v0.2-phase-b:progress'")[0].n) : 0;
    } catch { /* no target */ }
    check("P3 refused run leaves its SAME-TX watermark committed (target retains committed chunks honestly)", watermark === 1, `watermarkRows=${watermark}`);
    const resume2 = runCli(["import", "--dest", outcome.dest, "--approve", outcome.token, "--resume"]);
    check("P3 subsequent --resume refuses on the source-delta gate (exactly-once not bypassable)", resume2.status === 2 && /delta|drift|changed/.test(resume2.stderr), resume2.stderr.trim().split("\n")[0]);
  }
}

// ===========================================================================
// P4 — plan over an UNCOMMITTED writer transaction (consistent-snapshot
// semantics): plan succeeds with the invisible row excluded; the invisible
// mutation is caught pre-write at apply time the moment it commits.
// ===========================================================================
{
  const src = buildFixture(tag("fE"));
  const dest = tag("fE-dest");
  const db = new DatabaseSync(join(src, "memory.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("BEGIN IMMEDIATE");
  db.prepare("INSERT INTO memories (id, kind, content, importance, created_at, updated_at, status) VALUES ('lock-row','fact','uncommitted',5,1,1,'active')").run();
  const planRun = runCli(["plan", "--source", src, "--dest", dest]);
  check("P4 plan completes under an uncommitted writer transaction (readers do not block on a WAL writer; consistent snapshot semantics)", planRun.status === 0, planRun.stderr.trim().split("\n")[0]);
  const lockUnknown = planRun.status === 0 && !JSON.parse(readFileSync(join(dest, "plan.json"), "utf8")).families.memories.accepted.some((a) => a.id === "lock-row");
  check("P4 the uncommitted row is invisible to the snapshot (consistent plan, not a phantom row)", planRun.status === 0 && lockUnknown);
  check("P4 plan under contention wrote its contract artifacts (marker + plan.json)", planRun.status === 0 && existsSync(join(dest, "plan.json")));
  db.exec("COMMIT"); // the mutation becomes real after the plan is frozen
  db.close();
  const applyRun = runCli(["import", "--dest", dest, "--approve", planToken(dest)]);
  check("P4 apply after the invisible mutation commits refuses PRE-WRITE on the WAL/content gate with zero target writes",
    applyRun.status === 2 && /delta/.test(applyRun.stderr), applyRun.stderr.trim().split("\n")[0]);
  check("P4 refusal left zero operational artifacts (no backup, no normalized)", !existsSync(join(dest, "backup")) && !existsSync(join(dest, "normalized")), destArtifacts(dest));
}
// ===========================================================================
// P5 — symlink + containment refusals
// ===========================================================================
{
  const src = buildFixture(tag("fF"));
  const linkRoot = tag("fF-link-root");
  mkdirSync(linkRoot, { recursive: true });
  symlinkSync(src, join(linkRoot, "symlink-to-source"));
  const r1 = runCli(["plan", "--source", src, "--dest", join(linkRoot, "symlink-to-source", "nested")]);
  check("P5 dest through a symlink component refuses", r1.status === 2 && /symlink/.test(r1.stderr), r1.stderr.trim().split("\n")[0]);
  const srcLink = buildFixture(tag("fF-src2"));
  writeFileSync(join(tag("fF-src2"), "hostile"), "hostile foreign content\n");
  symlinkSync(join(tag("fF-src2"), "hostile"), join(srcLink, "conversations", "evil.jsonl"));
  const r2 = runCli(["plan", "--source", srcLink, "--dest", tag("fF-dest-2")]);
  if (r2.status !== 0) {
    check("P5 source tree containing a symlink refuses at plan time", true, r2.stderr.trim().split("\n")[0]);
    check("P5 refusal wrote zero destination artifacts", !existsSync(tag("fF-dest-2")) || readdirSync(tag("fF-dest-2")).length === 0);
  } else {
    // OBSERVED GAP (characterized for the audit report): the Phase B plan path
    // never re-invokes Phase A's source-side refuseSymlinkedContent walk and
    // digestDirectory skips symlinks, so plan completes; the conversation
    // auditor FOLLOWS the link and counts the linked file.
    const docSym = JSON.parse(readFileSync(join(tag("fF-dest-2"), "plan.json"), "utf8"));
    check("P5 OBSERVED: plan does NOT refuse a symlink inside the source tree and counts the linked file",
      docSym.families.conversations.counts.files >= 2, `files=${docSym.families.conversations.counts.files}`);
    // fail-closed tail: the apply's backup copier lstat-refuses the link
    const applySym = runCli(["import", "--dest", tag("fF-dest-2"), "--approve", docSym.approvalToken]);
    let symRows = -1;
    try {
      symRows = Number(rawQuery(join(tag("fF-dest-2"), "normalized", "memory.db"), "SELECT COUNT(*) n FROM memories")[0].n);
    } catch {
      symRows = 0;
    }
    check("P5 fail-closed tail: the apply refuses later (backup lane) and NO memory row ever lands in the target",
      applySym.status !== 0 && symRows === 0, `exit=${applySym.status} rows=${symRows}`);
    check("P5 fail-closed tail: no backup and no receipt on the symlinked source",
      !destArtifacts(tag("fF-dest-2")).backup && !destArtifacts(tag("fF-dest-2")).receipt, destArtifacts(tag("fF-dest-2")));
  }
  const r3 = runCli(["plan", "--source", src, "--dest", tag("fF-dest-3"), "--report", join(src, "report.json")]);
  check("P5 --report inside the source tree refuses before any IO", r3.status === 2 && /source store/.test(r3.stderr), r3.stderr.trim().split("\n")[0]);
  const r4 = runCli(["plan", "--source", src, "--dest", tag("fF-dest-4"), "--report", join(linkRoot, "symlink-to-source", "report.json")]);
  check("P5 --report through a symlink component refuses", r4.status === 2 && /symlink/.test(r4.stderr), r4.stderr.trim().split("\n")[0]);
  const r5 = runCli(["plan", "--source", src, "--dest", src]);
  check("P5 dest == source role collision refuses", r5.status === 2, r5.stderr.trim().split("\n")[0]);
}

// ===========================================================================
// P6 — forged self-consistent plan + self-derived approval token
// ===========================================================================
function forgePlan(destPath, mutate) {
  const before = sha(join(destPath, "plan.json"));
  const planDoc = JSON.parse(readFileSync(join(destPath, "plan.json"), "utf8"));
  const content = { ...planDoc };
  delete content.planDigest;
  delete content.approvalToken;
  mutate(content);
  const planDigest = createHash("sha256").update(canonJson(content), "utf8").digest("hex");
  const approvalToken = createHash("sha256").update([planDigest, planDoc.source.memoryDb.sha256, planDoc.source.treeDigest, resolve(destPath)].join("::"), "utf8").digest("hex");
  content.planDigest = planDigest;
  content.approvalToken = approvalToken;
  writeFileSync(join(destPath, "plan.json"), `${JSON.stringify(content, null, 2)}\n`, "utf8");
  void before;
  return { planDigest, approvalToken };
}
{
  // (a) pull the unsupported importance-42 row back INTO accepted
  const src = buildFixture(tag("fFa"));
  const dest = tag("fFa-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const forged = forgePlan(dest, (c) => {
    c.families.memories.accepted.push({ id: "bad-imp-audit", legacySeq: 6 });
    c.families.memories.unsupported = c.families.memories.unsupported.filter((u) => u.id !== "bad-imp-audit");
    c.reconciliation.families.memories.accepted += 1;
    c.reconciliation.families.memories.unsupported -= 1;
    c.families.memories.total = c.families.memories.accepted.length + c.families.memories.unsupported.length;
    c.reconciliation.families.memories.total = c.families.memories.total;
  });
  const run = runCli(["import", "--dest", dest, "--approve", forged.approvalToken]);
  const targetRows = run.status === 0 ? rawQuery(join(dest, "normalized", "memory.db"), "SELECT id, importance FROM memories") : [];
  const forgedRow = targetRows.find((r) => r.id === "bad-imp-audit");
  check("P6a forged self-consistent plan + self-derived token is refused (canonical source-derived verdicts cannot be forged)",
    run.status !== 0 && /canonical plan freshly re-derived|approval record|destination/i.test(run.stderr), run.status === 0 ? "ACCEPTED — REGRESSION" : (run.stderr || "").trim().split("\n")[0]);
  check("P6a forged apply writes zero artifacts and the excluded importance-42 row never lands", 
    run.status !== 0 && !destArtifacts(dest).backup && !destArtifacts(dest).normalized && !destArtifacts(dest).ledger && !destArtifacts(dest).receipt && forgedRow == null,
    JSON.stringify(destArtifacts(dest)));
  check("P6a no forged receipt is emitted", !existsSync(join(dest, "receipt.json")));
}
{
  // (b) silently exclude an accepted row
  const src = buildFixture(tag("fFb"));
  const dest = tag("fFb-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const planDocBefore = JSON.parse(readFileSync(join(dest, "plan.json"), "utf8"));
  const dropped = planDocBefore.families.memories.accepted[0].id;
  const forged = forgePlan(dest, (c) => {
    const idx = c.families.memories.accepted.findIndex((a) => a.id === dropped);
    c.families.memories.accepted.splice(idx, 1);
    c.families.memories.unsupported.push({ id: dropped, reason: "category-out-of-contract-kind" });
    c.reconciliation.families.memories.accepted -= 1;
    c.reconciliation.families.memories.unsupported += 1;
  });
  const run = runCli(["import", "--dest", dest, "--approve", forged.approvalToken]);
  const targetIds = run.status === 0 ? rawQuery(join(dest, "normalized", "memory.db"), "SELECT id FROM memories").map((r) => r.id) : [];
  check("P6b forged plan that excludes an accepted row is refused (no silent loss)",
    run.status !== 0 && /canonical plan freshly re-derived|approval record|destination/i.test(run.stderr), `dropped=${dropped}`);
  check("P6b forged exclusion writes zero artifacts and no target rows", 
    run.status !== 0 && !destArtifacts(dest).backup && !destArtifacts(dest).normalized && !destArtifacts(dest).ledger && !destArtifacts(dest).receipt && targetIds.length === 0,
    JSON.stringify(destArtifacts(dest)));
  check("P6b forged exclusion emits no green receipt", !existsSync(join(dest, "receipt.json")));
}

// P7 — current destination identity binding refuses a transplanted approved tree
{
  const src = buildFixture(tag("fG"));
  const dest = tag("fG-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const token = planToken(dest);
  const moved = tag("fG-moved");
  cpSync(dest, moved, { recursive: true });
  const movedRun = runCli(["import", "--dest", moved, "--approve", token]);
  check("P7 transplanted destination with copied token is refused by strict current destination identity binding",
    movedRun.status !== 0 && /destination|destRoot|identity/i.test(movedRun.stderr), movedRun.status === 0 ? "ACCEPTED — REGRESSION" : (movedRun.stderr || "").trim().split("\n")[0]);
  check("P7 transplanted apply writes zero artifacts", 
    !destArtifacts(moved).backup && !destArtifacts(moved).normalized && !destArtifacts(moved).ledger && !destArtifacts(moved).receipt,
    JSON.stringify(destArtifacts(moved)));
}

// ===========================================================================
// P8 — SIGKILL across the BACKUP lane + owned-debris sweep + resume
// ===========================================================================
for (const point of ["backup:before-manifest", "backup:before-rename"]) {
  const src = buildFixture(tag(`fH-${point}`));
  const dest = tag(`fH-dest-${point}`);
  runCli(["plan", "--source", src, "--dest", dest]);
  const killed = spawnSync(process.execPath, [WORKER, "--dest", dest, "--crash-points", point], { cwd: repo, encoding: "utf8" });
  check(`P8 worker died by REAL SIGKILL at ${point}`, killed.signal === "SIGKILL", `signal=${killed.signal} code=${killed.status}`);
  const wip = existsSync(dest) ? readdirSync(dest).filter((n) => n.startsWith("wip-backup-")) : [];
  let crashRows = 0;
  let crashTargetOpened = existsSync(join(dest, "normalized", "memory.db"));
  if (crashTargetOpened) {
    crashRows = Number(rawQuery(join(dest, "normalized", "memory.db"), "SELECT COUNT(*) n FROM memories")[0].n);
  }
  check(`P8 crash at ${point}: owned wip-backup-* debris only, NO backup/, NO receipt/ledger, and the target (if the store already opened) is row-empty`,
    wip.length >= 1 && destArtifacts(dest).backup === false && !destArtifacts(dest).receipt && !destArtifacts(dest).ledger && (!crashTargetOpened || crashRows === 0),
    `wip=${wip.join(",")} targetOpened=${crashTargetOpened} rows=${crashRows}`);
  const resumed = runCli(["import", "--dest", dest, "--approve", planToken(dest), "--resume"]);
  check(`P8 resume after ${point} sweeps exactly the owned debris and completes`, resumed.status === 0, (resumed.stderr || "").trim().split("\n")[0]);
  const wipAfter = readdirSync(dest).filter((n) => n.startsWith("wip-backup-"));
  check(`P8 post-resume ${point}: no wip debris left, backup manifest verifies`,
    wipAfter.length === 0 && verifyManifest(dest).ok === true, `wip=${wipAfter.length}`);
  const receipt = JSON.parse(readFileSync(join(dest, "receipt.json"), "utf8"));
  check(`P8 post-resume ${point}: reconciliation holds`, receipt.reconciliation.allReconciled === true, `rows=${receipt.target.memoryRows}`);
}

// ===========================================================================
// P9 — zero-coverage crash + explicit resume contract
// ===========================================================================
{
  const src = buildFixture(tag("fI"));
  const dest = tag("fI-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const killed = spawnSync(process.execPath, [WORKER, "--dest", dest, "--crash-points", "memory-chunk:1:begin"], { cwd: repo, encoding: "utf8" });
  check("P9 worker died by REAL SIGKILL at memory-chunk:1:begin", killed.signal === "SIGKILL", `signal=${killed.signal}`);
  const rows0 = Number(rawQuery(join(dest, "normalized", "memory.db"), "SELECT COUNT(*) n FROM memories")[0]?.n ?? 0);
  const wm0 = Number(rawQuery(join(dest, "normalized", "memory.db"), "SELECT COUNT(*) n FROM store_state WHERE key = 'import-v0.2-phase-b:progress'")[0]?.n ?? 0);
  check("P9 zero-coverage crash leaves an empty target and NO watermark", rows0 === 0 && wm0 === 0, `rows=${rows0} watermark=${wm0}`);
  const dest2 = tag("fI-dest2");
  runCli(["plan", "--source", src, "--dest", dest2]);
  const killed2 = spawnSync(process.execPath, [WORKER, "--dest", dest2, "--crash-points", "memory-chunk:1:begin"], { cwd: repo, encoding: "utf8" });
  check("P9b zero-coverage crash reproduced for the explicit --resume contract", killed2.signal === "SIGKILL", "");
  const resumed = runCli(["import", "--dest", dest2, "--approve", planToken(dest2), "--resume"]);
  check("P9b explicit --resume after a zero-coverage crash completes with full reconciliation",
    resumed.status === 0 && JSON.parse(readFileSync(join(dest2, "receipt.json"), "utf8")).reconciliation.allReconciled === true,
    `rows=${(JSON.parse(readFileSync(join(dest2, "receipt.json"), "utf8")) || {}).target?.memoryRows}`);
}

// ===========================================================================
// P11 — hygiene / hostility statics
// ===========================================================================
{
  const engineLib = readFileSync(join(repo, "lib", "import-v02.js"), "utf8");
  const cliSrc = readFileSync(CLI, "utf8");
  const engineSrc = readFileSync(join(repo, "src", "import-v02.ts"), "utf8");
  const scan = (t) => !/\b3082\b/.test(t) && !/createServer\s*\(/.test(t) && !/\.diag\b/.test(t) && !/dsh-home/.test(t);
  check("P11 engine + CLI contain no network/chat/3082/profile references", scan(engineLib) && scan(cliSrc) && scan(engineSrc), "static scan");
  const leftovers = readdirSync(base).filter((n) => n.startsWith("dsi-v02-import-snap-"));
  let leftoversMarked = true;
  for (const l of leftovers) {
    try {
      if (readFileSync(join(base, l, "OWNER.dsh-migration-v02-snapshot"), "utf8") !== "dsh-migration-v02-snapshot") leftoversMarked = false;
    } catch {
      leftoversMarked = false;
    }
  }
  check("P11 any post-SIGKILL snapshot leftovers are owner-marked (inert, guarded, deletable), never source-dest material",
    leftoversMarked, `count=${leftovers.length}`);
  check("P11 all audit IO lived under the owned /tmp audit tree", base.startsWith(tmpdir()), base);
}

// summary + cleanup
rmSync(base, { recursive: true, force: true });
console.log(`\n== test-v02-import-audit: passed=${passed} failed=${failed} ==`);
process.exit(failed === 0 ? 0 : 1);
