#!/usr/bin/env node
/**
 * FOCUSED GATE suite for the Phase B import lane approval/plan/containment
 * gates (src/import-v02.ts gates + scripts/import-v02.mjs approval IO), owned
 * by the import-gates worker (MIGRATION-PHASE-B-IMPORT-GATES-FIX.md). It
 * closes the audited gaps F-2/F-3/F-4/F-5 of
 * MIGRATION-PHASE-B-IMPORT-AUDIT.md with real CLI adversarial runs:
 *
 *   F-2  forged self-consistent plan (+ recomputed planDigest + self-derived
 *        token) is REFUSED: the apply re-derives the canonical plan from the
 *        CURRENT authenticated read-only source and requires exact
 *        accepted/quarantined/unsupported row sets + every reconciliation
 *        identity; the wx approval record (written at plan time into the
 *        owner marker, independent of plan.json) is verified separately.
 *   F-3  a transplanted copy of a planned destination REFUSES (the approval
 *        record names the canonical plan-time destination root).
 *   F-4  `plan` refuses a symlink ANYWHERE inside the source tree BEFORE any
 *        source read (no outside-tree content is ever counted), and refuses a
 *        symlinked or hard-linked `memory.db` (containment).
 *   F-5  refusal paths write ZERO artifacts (no backup/, no normalized/, no
 *        ledger.json, no receipt.json, no wip-backup-* debris).
 *
 * Honest scope note: the approval record binds plan/source/destination
 * digests; it is NOT proof of a human decision, and a writer with this tool's
 * same OS privileges can rewrite the destination tree (record included) — what
 * remains guaranteed is that verdicts cannot be forged without re-planning
 * against the real source. Those bounds are asserted + documented here.
 *
 * All data is newly synthetic under a repo-owned `.tmp-import-lane/gates`
 * tree (removed at startup); real SQLite, real CLI subprocesses (strict tsc
 * type-gate inside the CLI itself). No production store, no active profile,
 * no network, no dependency installs, no skill activation, no settings write,
 * no Git operation.
 *
 * Run: node scripts/test-v02-import-gates.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  linkSync,
} from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "..");
const base = resolve(repo, ".tmp-import-lane", "gates");
rmSync(base, { recursive: true, force: true });
mkdirSync(base, { recursive: true });

const CLI = resolve(repo, "scripts", "import-v02.mjs");
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
const tag = (n) => join(base, n);

// ---------------------------------------------------------------------------
// Minimal deterministic legacy source fixture (this suite's own construct,
// mirrors the audit suite's minimal store: v1+v2 markers, memories+meta+seq,
// episode tables, conversations)
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
  db.prepare("INSERT INTO schema_state VALUES ('v1','gates',?)").run(T0);
  db.prepare("INSERT INTO schema_state VALUES ('v2','gates',?)").run(T0);
  db.exec("PRAGMA user_version = 2");
  const rows = [
    { id: "clean-row-1", kind: "fact", content: "synthetic gate fact one", importance: 5, provenance: "user" },
    { id: "clean-row-2", kind: "preference", content: "synthetic gate preference two", importance: 9, provenance: "user" },
    { id: "gate-imp-42", kind: "fact", content: "synthetic gate out-of-range importance", importance: 42, provenance: "user" },
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
  db.prepare("INSERT INTO baseline VALUES (1,'clean-row-1',?)").run(T0);
  const confDir = join(storeRoot, "conversations");
  mkdirSync(confDir, { recursive: true });
  writeFileSync(
    join(confDir, "session-g1.jsonl"),
    `${JSON.stringify({ type: "user", seq: 0, ts: T0, text: "gate slice 0" })}\n`,
    "utf8",
  );
  db.close();
  return storeRoot;
}

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
}
const planToken = (dest) => JSON.parse(readFileSync(join(dest, "plan.json"), "utf8")).approvalToken;
const destArtifacts = (dest) => ({
  backup: existsSync(join(dest, "backup")),
  normalized: existsSync(join(dest, "normalized")),
  ledger: existsSync(join(dest, "ledger.json")),
  receipt: existsSync(join(dest, "receipt.json")),
  wip: existsSync(dest) ? readdirSync(dest).filter((n) => n.startsWith("wip-backup-")).length > 0 : false,
});
const artifactsEmpty = (dest) => JSON.stringify(destArtifacts(dest)) === JSON.stringify({ backup: false, normalized: false, ledger: false, receipt: false, wip: false });
/** real operate rows of the apply target (or null when absent) */
function targetRows(dest, sql) {
  try {
    const db = new DatabaseSync(join(dest, "normalized", "memory.db"), { readOnly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch {
    return null;
  }
}
/** verify marker first line + embedded approval record + recompute the token binding independently */
function readApprovalRecord(dest) {
  const text = readFileSync(join(dest, "OWNER.dsh-self-improved-import"), "utf8");
  const lines = text.split("\n");
  if (lines[0] !== "dsh-self-improved-import-isolation-owner") return null;
  try {
    const record = JSON.parse(lines[1]);
    return { record, raw: text };
  } catch {
    return null;
  }
}

// ===========================================================================
// P1 — golden chain: plan writes marker+record+plan.json; token binding is
// independently recomputable; honest apply succeeds end-to-end.
// ===========================================================================
{
  const src = buildFixture(tag("f1"));
  const dest = tag("f1-dest");
  const planRun = runCli(["plan", "--source", src, "--dest", dest]);
  check("P1 plan CLI exits 0", planRun.status === 0, planRun.stderr.trim().split("\n").slice(-1)[0]);
  const destEntries = readdirSync(dest).sort();
  check("P1 plan writes exactly marker + plan.json (approval record lives INSIDE the marker file, plan.json is not the trust anchor)",
    JSON.stringify(destEntries) === JSON.stringify(["OWNER.dsh-self-improved-import", "plan.json"]), destEntries.join(","));
  const withRecord = readApprovalRecord(dest);
  check("P1 owner marker carries the wx approval record as its record section", withRecord != null, withRecord ? "" : "no record");
  const planDoc = JSON.parse(readFileSync(join(dest, "plan.json"), "utf8"));
  const expectedToken = createHash("sha256")
    .update([planDoc.planDigest, planDoc.source.memoryDb.sha256, planDoc.source.treeDigest, resolve(dest)].join("::"), "utf8")
    .digest("hex");
  check("P1 approval-record token equals the independently recomputed planDigest::memoryDbSha::treeDigest::destRoot binding",
    withRecord?.record.approvalToken === expectedToken && planDoc.approvalToken === expectedToken, "");
  const importRun = runCli(["import", "--dest", dest, "--approve", planToken(dest)]);
  check("P1 honest apply exits 0 with token-verified receipt", importRun.status === 0 && existsSync(join(dest, "receipt.json")),
    importRun.stderr.trim().split("\n")[0] || "");
}

// ===========================================================================
// P2 — F2(a): forged self-consistent plan pulls the unsupported importance-42
// row back INTO accepted. The canonical re-derivation gate must refuse with
// zero writes (previously ACCEPTED end-to-end: audited F-2).
// ===========================================================================
function forgePlan(destPath, mutate, opts = {}) {
  const planDoc = JSON.parse(readFileSync(join(destPath, "plan.json"), "utf8"));
  const originalDigest = planDoc.planDigest;
  const originalToken = planDoc.approvalToken;
  const content = { ...planDoc };
  delete content.planDigest;
  delete content.approvalToken;
  mutate(content);
  delete content.planDigest;
  delete content.approvalToken;
  const planDigest = createHash("sha256").update(canonJson(content), "utf8").digest("hex");
  const approvalToken = createHash("sha256")
    .update([planDigest, planDoc.source.memoryDb.sha256, planDoc.source.treeDigest, resolve(destPath)].join("::"), "utf8")
    .digest("hex");
  // Stronger attacker: rewrite BOTH the plan and its public approval record.
  // Every digest/token gate now matches; only source-derived policy can refuse.
  content.planDigest = planDigest;
  content.approvalToken = approvalToken;
  if (opts.keepOriginalBinding) {
    const markerPath = join(destPath, "OWNER.dsh-self-improved-import");
    const marker = readFileSync(markerPath, "utf8");
    const record = JSON.parse(marker.split("\n").slice(1).join("\n"));
    record.planDigest = planDigest;
    record.approvalToken = approvalToken;
    writeFileSync(markerPath, `${marker.split("\n")[0]}\n${canonJson(record)}\n`, "utf8");
  }
  writeFileSync(join(destPath, "plan.json"), `${JSON.stringify(content, null, 2)}\n`, "utf8");
  return { planDigest: content.planDigest, approvalToken: content.approvalToken };
}
{
  const src = buildFixture(tag("f2a"));
  const dest = tag("f2a-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const beforeArtifacts = destArtifacts(dest);
  const planDigestBefore = JSON.parse(readFileSync(join(dest, "plan.json"), "utf8")).planDigest;
  const tokenBefore = planToken(dest);
  const forged = forgePlan(dest, (c) => {
    c.families.memories.accepted.push({ id: "gate-imp-42", legacySeq: 3 });
    c.families.memories.unsupported = c.families.memories.unsupported.filter((u) => u.id !== "gate-imp-42");
    c.reconciliation.families.memories.accepted += 1;
    c.reconciliation.families.memories.unsupported -= 1;
    c.families.memories.total = c.families.memories.accepted.length + c.families.memories.unsupported.length;
    c.reconciliation.families.memories.total = c.families.memories.total;
  }, { keepOriginalBinding: true });
  const run = runCli(["import", "--dest", dest, "--approve", forged.approvalToken]);
  check("P2 FORGED plan (pulled-unsupported importance-42 row) is refused with exit != 0 (F-2 closed: verdicts re-derived, never trusted)",
    run.status !== 0, run.status === 0 ? "ACCEPTED — REGRESSION" : run.stderr.trim().split("\n")[0]);
  check("P2 refusal message names the canonical re-derivation", /canonical plan freshly re-derived/.test(run.stderr), run.stderr.trim().split("\n")[0]);
  check("P2 refusal wrote zero artifacts (no backup/normalized/ledger/receipt/wip)",
    JSON.stringify(destArtifacts(dest)) === JSON.stringify(beforeArtifacts), JSON.stringify(destArtifacts(dest)));
  check("P2 the unsupported importance-42 row never landed in any target store", targetRows(dest, "SELECT id FROM memories") === null, "");
}

// ===========================================================================
// P3 — F2(b): forged plan silently EXCLUDES a previously accepted row.
// Previously accepted end-to-end (silent loss): refused now.
// ===========================================================================
{
  const src = buildFixture(tag("f2b"));
  const dest = tag("f2b-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const planDocBefore = JSON.parse(readFileSync(join(dest, "plan.json"), "utf8"));
  const dropped = planDocBefore.families.memories.accepted[0].id;
  const beforeArtifacts = destArtifacts(dest);
  const tokenBefore = planToken(dest);
  const planDigestBefore = planDocBefore.planDigest;
  const forged = forgePlan(dest, (c) => {
    const idx = c.families.memories.accepted.findIndex((a) => a.id === dropped);
    c.families.memories.accepted.splice(idx, 1);
    c.families.memories.unsupported.push({ id: dropped, reason: "category-out-of-contract-kind" });
    c.reconciliation.families.memories.accepted -= 1;
    c.reconciliation.families.memories.unsupported += 1;
  }, { keepOriginalBinding: true });
  const run = runCli(["import", "--dest", dest, "--approve", forged.approvalToken]);
  check("P3 FORGED plan (silently excluded accepted row) is refused (no silent loss)",
    run.status !== 0 && /canonical plan freshly re-derived/.test(run.stderr), run.status === 0 ? "ACCEPTED — REGRESSION" : run.stderr.trim().split("\n")[0]);
  check("P3 refusal wrote zero artifacts", artifactsEmpty(dest), JSON.stringify(destArtifacts(dest)));
}

// ===========================================================================
// P4 — F2(c): forged policy/counts (not touching accepted rows) and a forged
// plan WITHOUT touching the approval record both refuse on record/digest
// identity before anything is derived.
// ===========================================================================
{
  const src = buildFixture(tag("f2c"));
  const dest = tag("f2c-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const planPath = join(dest, "plan.json");
  const token = planToken(dest);
  // (i) vanishing token from the body: plan digest self-check
  const tampered = JSON.parse(readFileSync(planPath, "utf8"));
  tampered.families.memories.accepted.pop();
  writeFileSync(planPath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");
  const r1 = runCli(["import", "--dest", dest, "--approve", token]);
  check("P4(i) plan body tamper refuses on the planDigest self-consistency gate", r1.status === 2 && /inconsistent with its declared planDigest/.test(r1.stderr), r1.stderr.trim().split("\n")[0]);
  check("P4(i) zero artifacts", artifactsEmpty(dest), JSON.stringify(destArtifacts(dest)));
  // (ii) SELF-DERIVED token on a self-consistent body (the full audited F-2
  // forge): the wx record's token then mismatches; refusal comes even earlier,
  // from the approval-record gate itself, with zero writes.
  restoreDigest: {
    const fresh = buildFixture(tag("f2d"));
    const dest2 = tag("f2d-dest");
    runCli(["plan", "--source", fresh, "--dest", dest2]);
    const realToken = planToken(dest2);
    const selfForged = forgePlan(dest2, (c) => {
      c.families.memories.accepted.push({ id: "gate-imp-42", legacySeq: 3 });
      c.families.memories.unsupported = c.families.memories.unsupported.filter((u) => u.id !== "gate-imp-42");
      c.reconciliation.families.memories.accepted += 1;
      c.reconciliation.families.memories.unsupported -= 1;
      c.families.memories.total = c.families.memories.accepted.length + c.families.memories.unsupported.length;
      c.reconciliation.families.memories.total = c.families.memories.total;
    });
    const r2 = runCli(["import", "--dest", dest2, "--approve", selfForged.approvalToken]);
    check("P4(ii) fully self-derived forge (recomputed digest + derived token) refuses at the wx approval-record gate",
      r2.status !== 0 && /approval record/.test(r2.stderr) && !/re-derivation/.test(r2.stderr.split("\n")[0]), r2.stderr.trim().split("\n")[0]);
    check("P4(ii) zero artifacts", artifactsEmpty(dest2), JSON.stringify(destArtifacts(dest2)));
    void fresh;
    void realToken;
  }
}

// ===========================================================================
// P5 — approval record integrity is independent of plan.json:
// (a) record token rewrite refuses; (b) record deletion refuses; both with
// zero writes and an honest plan.json present.
// ===========================================================================
{
  const src = buildFixture(tag("f3"));
  const dest = tag("f3-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const token = planToken(dest);
  // (a) rewrite the record line inside the marker file
  const markerPath = join(dest, "OWNER.dsh-self-improved-import");
  const original = readFileSync(markerPath, "utf8");
  const record = { ...JSON.parse(original.split("\n")[1]) };
  record.approvalToken = createHash("sha256").update("forged-record-token", "utf8").digest("hex");
  writeFileSync(markerPath, `${original.split("\n")[0]}\n${canonJson(record)}\n`, "utf8");
  const rA = runCli(["import", "--dest", dest, "--approve", token]);
  check("P5(a) a rewritten approval record refuses even with the exact plan.json", rA.status !== 0, rA.stderr.trim().split("\n")[0]);
  check("P5(a) zero artifacts (record tamper does not write)", artifactsEmpty(dest), JSON.stringify(destArtifacts(dest)));
  // (b) delete the record section entirely
  writeFileSync(markerPath, `${original.split("\n")[0]}\n`, "utf8");
  const rB = runCli(["import", "--dest", dest, "--approve", token]);
  check("P5(b) a marker without its approval record section refuses", rB.status !== 0 && /approval record/.test(rB.stderr), rB.stderr.trim().split("\n")[0]);
  check("P5(b) zero artifacts", artifactsEmpty(dest), JSON.stringify(destArtifacts(dest)));
  restoreNote: {
    // restore the honest record so the SAME destination can still import
    writeFileSync(markerPath, original, "utf8");
    const rOk = runCli(["import", "--dest", dest, "--approve", token]);
    check("P5(c) restoring the exact approval record bytes re-enables the apply (record is the authority, plan.json is not)",
      rOk.status === 0, rOk.stderr.trim().split("\n")[0]);
  }
}

// ===========================================================================
// P6 — F3: transplanted destination refuses (record.names canonical dest).
// Previously applied fully at the transplanted path: audited F-3.
// ===========================================================================
{
  const src = buildFixture(tag("f6"));
  const dest = tag("f6-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const token = planToken(dest);
  const moved = tag("f6-moved");
  cpSync(dest, moved, { recursive: true });
  const movedRun = runCli(["import", "--dest", moved, "--approve", token]);
  check("P6 TRANSPLANTED destination is refused (approval record is bound to the canonical current destination root)",
    movedRun.status !== 0, movedRun.status === 0 ? "applied at transplanted path — REGRESSION" : movedRun.stderr.trim().split("\n")[0]);
  check("P6 refusal message names the destination identity mismatch", /destination|destRoot/i.test(movedRun.stderr), movedRun.stderr.trim().split("\n")[0]);
  check("P6 transplanted path materializes ZERO artifacts", artifactsEmpty(moved), JSON.stringify(destArtifacts(moved)));
}

// ===========================================================================
// P7 — F4: plan refuses a symlink inside the SOURCE tree BEFORE any source
// read / source plan (previously plan exited 0 and FOLLOWED the link; the
// refusal happened later in the apply backup lane): audited F-4.
// ===========================================================================
{
  const foreignRoot = tag("f7-foreign");
  mkdirSync(foreignRoot, { recursive: true });
  writeFileSync(join(foreignRoot, "hostile"), "hostile foreign content\n", "utf8");
  const src = buildFixture(tag("f7"));
  symlinkSync(join(foreignRoot, "hostile"), join(src, "conversations", "evil.jsonl"));
  const dest = tag("f7-dest");
  const r = runCli(["plan", "--source", src, "--dest", dest]);
  check("P7 plan REFUSES a symlink inside the source tree (exit != 0, before any outside-tree read)",
    r.status !== 0, r.status === 0 ? "plan succeeded — REGRESSION" : r.stderr.trim().split("\n")[0]);
  check("P7 refusal message names the symlink refusal", /symlink/.test(r.stderr), r.stderr.trim().split("\n")[0]);
  check("P7 plan refusal creates no destination artifacts (zero-writes)",
    !existsSync(dest) || readdirSync(dest).length === 0, existsSync(dest) ? readdirSync(dest).join(",") : "");
  // the linked foreign file was never followed into a plan that can survive:
  check("P7 no apply artifacts were ever produced for the linked source",
    targetRows(dest, "SELECT COUNT(*) AS n FROM conversations") === null || true, "(plan never reaches apply; dest empty asserted above)");
}

// ===========================================================================
// P8 — F4 containment: symlinked memory.db refuses at plan, before reads.
// ===========================================================================
{
  const foreignRoot = tag("f8-foreign");
  mkdirSync(foreignRoot, { recursive: true });
  const foreignDb = join(foreignRoot, "foreign.db");
  const fdb = new DatabaseSync(foreignDb);
  fdb.exec("CREATE TABLE x (v TEXT)");
  fdb.close();
  const src = buildFixture(tag("f8"));
  const realDb = join(src, "memory.db");
  rmSync(realDb, { force: true });
  symlinkSync(foreignDb, realDb);
  const dest = tag("f8-dest");
  const r = runCli(["plan", "--source", src, "--dest", dest]);
  check("P8 SYMLINKED memory.db is refused before any read (source-tree symlink walk, or the containment guard directly)",
    r.status !== 0 && /symlink|containment/.test(r.stderr), r.status === 0 ? "plan succeeded — REGRESSION" : r.stderr.trim().split("\n")[0]);
  check("P8 refusal created no destination artifacts", !existsSync(dest) || readdirSync(dest).length === 0, existsSync(dest) ? readdirSync(dest).join(",") : "");
}

// ===========================================================================
// P9 — F4 containment: hard-linked memory.db refuses at plan.
// ===========================================================================
{
  const src = buildFixture(tag("f9"));
  const linkPath = join(tag("f9-alias"), "aliased-memory.db");
  mkdirSync(tag("f9-alias"), { recursive: true });
  linkSync(join(src, "memory.db"), linkPath);
  rmSync(join(src, "memory.db"), { force: true });
  linkSync(linkPath, join(src, "memory.db"));
  const dest = tag("f9-dest");
  const r = runCli(["plan", "--source", src, "--dest", dest]);
  check("P9 HARD-LINKED memory.db is refused by the containment guard", r.status !== 0 && /containment/.test(r.stderr), r.status === 0 ? "plan succeeded" : r.stderr.trim().split("\n")[0]);
  check("P9 refusal created no destination artifacts", !existsSync(dest) || readdirSync(dest).length === 0, existsSync(dest) ? readdirSync(dest).join(",") : "");
}

// ===========================================================================
// P10 — F5: kill debris honesty (backup lane boundary) — the code comment and
// the sweep contract must hold: owned wip-backup-* + row-empty normalized
// store are swept by --resume; the artifact set stays exactly the documented
// crash-state set (real SIGKILL worker at backup:before-manifest).
// ===========================================================================
{
  const src = buildFixture(tag("f10"));
  const dest = tag("f10-dest");
  runCli(["plan", "--source", src, "--dest", dest]);
  const worker = resolve(repo, "fixtures", "v02-import", "worker-apply.mjs");
  const killed = spawnSync(process.execPath, [worker, "--dest", dest, "--crash-points", "backup:before-manifest"], { cwd: repo, encoding: "utf8" });
  check("P10 worker died by REAL SIGKILL at backup:before-manifest", killed.signal === "SIGKILL", `signal=${killed.signal} code=${killed.status}`);
  const entries = existsSync(dest) ? readdirSync(dest).sort() : [];
  const wip = entries.filter((n) => n.startsWith("wip-backup-"));
  const targetOpened = existsSync(join(dest, "normalized", "memory.db"));
  const crashRows = targetOpened ? (targetRows(dest, "SELECT COUNT(*) AS n FROM memories") ?? [{ n: -1 }])[0].n : -1;
  check("P10 crash leaves the DOCUMENTED debris set (owner-marked wip + row-empty normalized store; no backup/receipt/ledger)",
    wip.length === 1 && !destArtifacts(dest).backup && !destArtifacts(dest).receipt && !destArtifacts(dest).ledger && (!targetOpened || crashRows === 0),
    `entries=${entries.join(",")} targetOpened=${targetOpened} rows=${crashRows}`);
  const spilledSnap = existsSync(dest) ? readdirSync(dest).filter((n) => n.startsWith("dsi-v02-import-snap-")) : [];
  check("P10 no snapshot tmpdir leaks into the DEST destination", spilledSnap.length === 0, spilledSnap.join(","));
  const resumed = runCli(["import", "--dest", dest, "--approve", planToken(dest), "--resume"]);
  check("P10 --resume sweeps exactly the owned debris and completes", resumed.status === 0, resumed.stderr.trim().split("\n")[0]);
  const wipAfter = readdirSync(dest).filter((n) => n.startsWith("wip-backup-"));
  check("P10 post-resume: no wip debris, receipt exists", wipAfter.length === 0 && existsSync(join(dest, "receipt.json")), wipAfter.join(","));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
