/**
 * Focused synthetic SQLite suite for the Phase B import seam
 * MemoryStore.importMemoryInTx (MIGRATION-PHASE-B-IMPORT-DESIGN §11 blocked
 * dependency; storage-only increment — no importer, no reader, no journal or
 * capture/index file touched).
 *
 * Proves, on REAL SQLite (node:sqlite) in synthetic temp trees:
 *  1. tx-only: the seam refuses to run outside runInImmediateTransaction;
 *  2. lossless roundtrip: preserved id/created/updated/status/supersedes/meta
 *     verbatim, target seq minted strictly increasing, FTS mirrors active rows;
 *  3. collision = reject, never overwrite, identical duplicate also refuses;
 *  4. revision bumps exactly once per imported row, in the SAME transaction,
 *     persisted across reopen; failures leave the revision untouched;
 *  5. no automatic trusted provenance: omitted provenance stays fail-closed
 *     'unknown', import never reaches the 'user-direct' shortcut, imported
 *     persona-provenance rows cannot land as active authority;
 *  6. shape/legacy vocabulary refusals happen before the first write;
 *  7. crash safety via REAL child-process SIGKILL at two boundaries: rollback
 *     leaks no row/FTS/meta/seq/revision/ledger row; post-commit durability
 *     covers the same-tx ledger row (fixtures/v02-import-seam/worker-import.mjs).
 *
 * Run: node scripts/test-v02-import-seam.mjs
 */
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { MemoryStore, MemoryImportCollisionError } from "../lib/storage.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = join(scriptDir, "..");
const baseDir = join(tmpdir(), "dsh-import-seam-tests");
rmSync(baseDir, { recursive: true, force: true });

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!cond) failed++;
  else passed++;
};
const uniqueDir = (tag) => join(baseDir, tag);

// ---------------------------------------------------------------------------
// 1) TX-ONLY: the seam owns no transaction of its own
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("tx-required");
  const store = new MemoryStore(dir);
  const before = currentCounts(store);
  let threw = null;
  try {
    store.importMemoryInTx({ id: "legacy-1", kind: "fact", content: "x", createdAt: 1, updatedAt: 1 });
  } catch (e) {
    threw = e;
  }
  check("importMemoryInTx refuses outside an open transaction", threw instanceof Error && /requires an open store transaction/.test(String(threw.message)));
  check("refuse outside tx left no state", countsEqual(currentCounts(store), before));
  check("refuse outside tx left revision untouched", store.getMemoryRevision() === 0);

  // The sanctioned pattern: caller holds runInImmediateTransaction, nested uses reuse it.
  let rec = null;
  store.runInImmediateTransaction(() => {
    rec = store.importMemoryInTx({ id: "legacy-1", kind: "fact", content: "x", createdAt: 1, updatedAt: 1 });
  });
  check("import inside runInImmediateTransaction succeeds", rec && rec.id === "legacy-1");
  store.close();
}

{
  // Nesting: insertMemoryInTx/journal-style outer tx must admit the import seam.
  const dir = uniqueDir("tx-nested");
  const store = new MemoryStore(dir);
  let sawBoth = null;
  store.runInImmediateTransaction(() => {
    const a = store.insertMemoryInTx({ kind: "fact", content: "tx row", importance: 5 });
    const b = store.importMemoryInTx({ id: "legacy-nested", kind: "fact", content: "nested import", createdAt: 7, updatedAt: 9 });
    sawBoth = [a.id, b.id];
  });
  check("import seam nests inside the shared transaction with insertMemoryInTx", sawBoth[0] && sawBoth[1] === "legacy-nested");
  store.close();
}

// ---------------------------------------------------------------------------
// 2) LOSSLESS ROUNDTRIP: stable identity, timestamps, scope, supersedes, meta
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("roundtrip");
  const store = new MemoryStore(dir);
  const rev0 = store.getMemoryRevision();
  const metaIn = {
    provenance: "user",
    source: "legacy",
    scope: "project",
    projectId: "proj-alpha",
    sessionId: null,
    confidence: 0.85,
    expiresAt: 9_000_000_000_000,
    evidence: [{ sessionId: "s-9", seq: 4, snippet: "source line" }],
  };
  const imported = store.runInImmediateTransaction(() =>
    store.importMemoryInTx({
      id: "legacy-0ff1ce-000A",
      kind: "preference",
      content: "Imported stable identity row with preserved timestamps",
      createdAt: 1_700_000_000_123,
      updatedAt: 1_700_000_001_999,
      importance: 8,
      supersedes: "legacy-0ff1ce-0009",
    }, metaIn),
  );
  const expected = {
    id: "legacy-0ff1ce-000A",
    kind: "preference",
    content: "Imported stable identity row with preserved timestamps",
    importance: 8,
    accessCount: 0,
    createdAt: 1_700_000_000_123,
    updatedAt: 1_700_000_001_999,
    status: "active",
    supersedes: "legacy-0ff1ce-0009",
  };
  const actual = store.getMemory("legacy-0ff1ce-000A");
  check("preserved identity roundtrips verbatim", actual && fieldsMatch(expected, actual));
  check("returned record equals persisted record", imported && imported.id === actual.id && actual.meta?.provenance === "user");
  const metaGot = store.getMeta("legacy-0ff1ce-000A");
  check(
    "imported meta roundtrips (scope/project/confidence/expires/evidence verbatim)",
    metaGot?.scope === "project" && metaGot.projectId === "proj-alpha" && metaGot.confidence === 0.85 &&
      metaGot.expiresAt === 9_000_000_000_000 && JSON.stringify(metaGot.evidence) === JSON.stringify(metaIn.evidence),
    JSON.stringify(metaGot),
  );
  check("imported source label carried verbatim ('legacy' is a label, not a trust grant)", metaGot?.source === "legacy");
  check("imported row entered memories_seq with a fresh strictly-increasing seq", seqOf(store, "legacy-0ff1ce-000A") === 1);
  check("recall finds the imported active user-provenance row (FTS + injectableOnly lane)",
    store.searchMemories("preserved timestamps", { limit: 5 }).some((h) => h.id === "legacy-0ff1ce-000A") &&
      store.searchMemories("preserved", { limit: 5, injectableOnly: true }).some((h) => h.id === "legacy-0ff1ce-000A"));
  const rev1 = store.getMemoryRevision();
  check("one import row = one revision bump in the same tx", rev1 === rev0 + 1, `${rev0} -> ${rev1}`);
  store.close();

  const reloaded = new MemoryStore(dir);
  check("preserved row + revision survive reopen", reloaded.getMemory("legacy-0ff1ce-000A")?.createdAt === 1_700_000_000_123 && reloaded.getMemoryRevision() === rev1);
  const seqRow2 = reloaded.runInImmediateTransaction(() =>
    reloaded.importMemoryInTx({ id: "legacy-0ff1ce-000B", kind: "fact", content: "second", createdAt: 5, updatedAt: 6 }));
  check("target seq keeps increasing across import calls", seqOf(reloaded, "legacy-0ff1ce-000B") === 2);
  reloaded.close();
}

// ---------------------------------------------------------------------------
// 3) COLLISION = REJECT (identical duplicates included), never overwrite
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("collisions");
  const store = new MemoryStore(dir);
  store.runInImmediateTransaction(() =>
    store.importMemoryInTx({ id: "dup-1", kind: "fact", content: "original content", createdAt: 100, updatedAt: 100 }));

  // a) conflicting payload, same id
  let threw = safeTx(() =>
    store.runInImmediateTransaction(() =>
      store.importMemoryInTx({ id: "dup-1", kind: "fact", content: "REWRITTEN content", createdAt: 100, updatedAt: 100 })));
  check("conflicting duplicate rejects with MemoryImportCollisionError", threw instanceof MemoryImportCollisionError && threw.memoryId === "dup-1");
  check("conflicting duplicate did NOT overwrite", store.getMemory("dup-1")?.content === "original content");

  // b) byte-identical payload, same id: still a refusal (design §5: no dedup at import)
  threw = safeTx(() =>
    store.runInImmediateTransaction(() =>
      store.importMemoryInTx({ id: "dup-1", kind: "fact", content: "original content", createdAt: 100, updatedAt: 100 })));
  check("byte-identical duplicate ALSO refuses (no dedup/absorb lane)", threw instanceof MemoryImportCollisionError);

  // c) orphan meta/seq leftover (pre-transactional debris) → refusal
  const raw = store.getJournalSqlite();
  raw.exec("BEGIN IMMEDIATE");
  raw.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, confidence, evidence) VALUES ('orphan-1', 'unknown', 'legacy', 'global', 0.3, '[]')").run();
  raw.exec("COMMIT");
  threw = safeTx(() =>
    store.runInImmediateTransaction(() =>
      store.importMemoryInTx({ id: "orphan-1", kind: "fact", content: "x", createdAt: 1, updatedAt: 1 })));
  check("orphan memories_meta entry refuses the import", threw instanceof MemoryImportCollisionError && /memories_meta/.test(String(threw?.message)));

  const revAfter = store.getMemoryRevision();
  const counts = currentCounts(store);
  check("collision refusals left revision untouched", revAfter === 1, `rev=${revAfter}`);
  check("collision refusals left no duplicate/orphan rows", counts.memories === 1 && counts.meta === 2 && counts.seq === 1);
  store.close();
}

// ---------------------------------------------------------------------------
// 4) REVISION CONTRACT: exactly one same-tx bump per row; failures don't count
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("revision");
  const store = new MemoryStore(dir);
  const rev0 = store.getMemoryRevision();
  store.runInImmediateTransaction(() => {
    const r1 = store.getMemoryRevision();
    store.importMemoryInTx({ id: "r-1", kind: "fact", content: "one", createdAt: 1, updatedAt: 1 });
    const r2 = store.getMemoryRevision();
    check("revision bumps once per call INSIDE the tx (not only at commit)", r2 === r1 + 1, `${r1} -> ${r2}`);
    store.importMemoryInTx({ id: "r-2", kind: "fact", content: "two", createdAt: 1, updatedAt: 1 });
    store.importMemoryInTx({ id: "r-3", kind: "fact", content: "three", createdAt: 1, updatedAt: 1 });
    check("three imported rows = exactly three same-tx bumps", store.getMemoryRevision() === r1 + 3, `end=${store.getMemoryRevision()}`);
  });
  check("committed chunk's revision delta is exactly N rows", store.getMemoryRevision() === rev0 + 3, `rev0=${rev0}`);
  const reason = revisionReason(store);
  check("last revision reason names the import lane", reason === "import", `reason=${reason}`);

  // failing chunk: bump rolls back with the tx → no orphan revision counter
  const revBefore = store.getMemoryRevision();
  safeTx(() =>
    store.runInImmediateTransaction(() => {
      store.importMemoryInTx({ id: "r-4", kind: "fact", content: "doomed", createdAt: 1, updatedAt: 1 });
      throw new Error("simulated chunk failure");
    }));
  check("rolled-back chunk leaves revision exactly where it was", store.getMemoryRevision() === revBefore);
  check("rolled-back chunk left no row/meta/seq debris", countsEqual(currentCounts(store), { memories: 3, meta: 3, fts: 3, seq: 3 }), JSON.stringify(currentCounts(store)));
  store.close();
}

// ---------------------------------------------------------------------------
// 5) PROVENANCE / STATUS POLICY: no automatic trust, persona stays inactive
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("provenance-policy");
  const store = new MemoryStore(dir);

  // a) omitted provenance → fail-closed 'unknown', never the trusted tier
  const um = store.runInImmediateTransaction(() =>
    store.importMemoryInTx({ id: "up-1", kind: "fact", content: "unclaimed origin", createdAt: 1, updatedAt: 1 }));
  let metaGot = store.getMeta("up-1");
  check("omitted provenance lands 'unknown' (fail closed, no widening)", metaGot?.provenance === "unknown", JSON.stringify(metaGot));
  check("import lane never defaults to the trusted 'user-direct' origin", metaGot?.source === "legacy");
  check("unclaimed-origin confidence stays at the untrusted 0.3 default", metaGot?.confidence === 0.3);
  check("unknown-tier import is NOT injectable", !store.getActiveMemories(50, 0, true).some((m) => m.id === "up-1") &&
    !store.searchMemories("unclaimed origin", { limit: 5, injectableOnly: true }).some((h) => h.id === "up-1"));

  // b) carried provenance preserved verbatim — import neither upgrades nor strips
  store.runInImmediateTransaction(() =>
    store.importMemoryInTx({ id: "up-2", kind: "fact", content: "carried claim", createdAt: 1, updatedAt: 1 }, { provenance: "user" }));
  metaGot = store.getMeta("up-2");
  check("carried provenance preserved verbatim", metaGot?.provenance === "user");

  // c) persona policy: imported persona prose can never land as active authority
  const pm = store.runInImmediateTransaction(() =>
    store.importMemoryInTx({ id: "pp-1", kind: "persona", content: "imported persona prose", createdAt: 1, updatedAt: 1 }, { provenance: "persona" }));
  check("persona-provenance request for 'active' is demoted to 'quarantined'", pm?.status === "quarantined", `status=${pm?.status}`);
  check("demoted persona row is persisted and not injectable",
    store.getMemory("pp-1")?.status === "quarantined" &&
      !store.searchMemories("imported persona prose", { limit: 5, injectableOnly: true }).some((h) => h.id === "pp-1"));
  const activated = store.setMemoryStatus("pp-1", "active");
  check("activation stays an explicit user path (setMemoryStatus), never the seam",
    activated && store.getMemory("pp-1")?.status === "active" &&
      store.searchMemories("imported persona prose", { limit: 5, injectableOnly: true }).some((h) => h.id === "pp-1"));

  // d) derived imports stay verbatim ('derived' is non-injectable by the recall policy itself)
  const dm = store.runInImmediateTransaction(() =>
    store.importMemoryInTx({ id: "dp-1", kind: "fact", content: "derived import", createdAt: 1, updatedAt: 1 }, { provenance: "derived", status: "active" }));
  check("derived import preserves active status but stays off the injectable lane",
    dm?.status === "active" && !store.getActiveMemories(50, 0, true).some((m) => m.id === "dp-1"));
  store.close();
}

// ---------------------------------------------------------------------------
// 6) SHAPE REFUSALS BEFORE THE FIRST WRITE (imported rows must be schema-legal)
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("shape-refusals");
  const store = new MemoryStore(dir);
  const bads = [
    ["empty id", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "", kind: "fact", content: "x", createdAt: 1, updatedAt: 1 }))],
    ["float timestamp", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "s-1", kind: "fact", content: "x", createdAt: 1.5, updatedAt: 1 }))],
    ["negative timestamp", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "s-2", kind: "fact", content: "x", createdAt: -1, updatedAt: 1 }))],
    ["invalid kind", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "s-3", kind: "nope", content: "x", createdAt: 1, updatedAt: 1 }))],
    ["invalid status", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "s-4", kind: "fact", content: "x", createdAt: 1, updatedAt: 1, status: "deleted" }))],
    ["invalid provenance", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "s-5", kind: "fact", content: "x", createdAt: 1, updatedAt: 1 }, { provenance: "human" }))],
    ["invalid scope", () => store.runInImmediateTransaction(() => store.importMemoryInTx({ id: "s-6", kind: "fact", content: "x", createdAt: 1, updatedAt: 1 }, { scope: "team" }))],
  ];
  let allThrew = true;
  for (const [label, fn] of bads) {
    const e = safeTx(fn);
    if (!(e instanceof Error)) { allThrew = false; console.log(`  expected throw for ${label}`); }
  }
  check("every illegal imported shape refuses before any write", allThrew);
  check("shape refusals left zero rows and zero revisions", countsEqual(currentCounts(store), { memories: 0, meta: 0, fts: 0, seq: 0 }) && store.getMemoryRevision() === 0);
  store.close();
}

// ---------------------------------------------------------------------------
// 7) IN-PROCESS ROLLBACK + REAL CHILD SIGKILL (real SQLite, cross-process)
// ---------------------------------------------------------------------------
{
  const dir = uniqueDir("rollback-inproc");
  const store = new MemoryStore(dir);
  store.runInImmediateTransaction(() =>
    store.importMemoryInTx({ id: "keep-1", kind: "fact", content: "keeper", createdAt: 1, updatedAt: 1 }));
  const seqBefore = maxSeq(store);
  const rev = store.getMemoryRevision();
  safeTx(() =>
    store.runInImmediateTransaction(() => {
      store.importMemoryInTx({ id: "doomed-1", kind: "fact", content: "doomed", createdAt: 2, updatedAt: 2 }, { evidence: [{ sessionId: "s", seq: 1 }] });
      const doomedSeq = maxSeq(store); // seq counter continues even past the doomed row
      if (doomedSeq <= seqBefore) throw new Error("seq watermark must not go backwards");
      throw new Error("chunk failure");
    }));
  const after = currentCounts(store);
  check("in-process rollback leaks NOTHING (row/meta/FTS/seq/revision)", countsEqual(after, { memories: 1, meta: 1, fts: 1, seq: 1 }) && store.getMemoryRevision() === rev, JSON.stringify(after));
  const seqNext = store.runInImmediateTransaction(() =>
    seqOf(store, store.importMemoryInTx({ id: "keep-2", kind: "fact", content: "next", createdAt: 3, updatedAt: 3 }).id));
  check("seq watermark stays strictly increasing across a rollback (gaps are legal, reuse is not)", seqNext > seqBefore, `${seqBefore} -> ${seqNext}`);
  store.close();
}

if (typeof spawnSync === "function" && typeof process.kill === "function") {
  for (const boundary of ["mid", "post"]) {
    const dir = uniqueDir(`crash-${boundary}`);
    const scenarioDir = mkdtempSync(join(tmpdir(), "import-seam-sc-"));
    const scenarioPath = join(scenarioDir, "scenario.json");
    writeFileSync(scenarioPath, JSON.stringify({ dir, boundary }));
    const worker = join(repo, "fixtures", "v02-import-seam", "worker-import.mjs");
    let res;
    try {
      res = spawnSync(process.execPath, [worker, scenarioPath], { encoding: "utf8", timeout: 90_000, cwd: repo });
    } finally {
      try { rmSync(scenarioDir, { recursive: true, force: true }); } catch { /* temp */ }
    }
    const killed = res.signal === "SIGKILL";
    if (boundary === "mid") {
      check(`crash-at-mid worker died by real SIGKILL (${boundary})`, killed, `signal=${res.signal} code=${res.status} stderr=${(res.stderr || "").slice(0, 200)}`);
      const reopened = new MemoryStore(dir);
      const counts = currentCounts(reopened);
      check("SIGKILL mid-chunk: no imported row, no FTS/meta/seq orphan", countsEqual(counts, { memories: 0, meta: 0, fts: 0, seq: 0 }), JSON.stringify(counts));
      check("SIGKILL mid-chunk: revision and same-tx ledger row rolled back with the data",
        reopened.getMemoryRevision() === 0 &&
          rawStateValue(reopened, "memoryRevision") === undefined &&
          rawStateValue(reopened, "import:test:ledger") === undefined &&
          revisionReason(reopened) === "");
      const seqAfterCrash = reopened.runInImmediateTransaction(() =>
        reopened.importMemoryInTx({ id: "post-crash-1", kind: "fact", content: "after crash", createdAt: 5, updatedAt: 5 }));
      check("a fresh process resumes cleanly: one clean import yields seq 1 and revision 1", seqOf(reopened, seqAfterCrash.id) === 1 && reopened.getMemoryRevision() === 1);
      reopened.close();
    } else {
      check(`worker died by SIGKILL after COMMIT (${boundary})`, killed, `signal=${res.signal} code=${res.status} stderr=${(res.stderr || "").slice(0, 200)}`);
      const reopened = new MemoryStore(dir);
      const counts = currentCounts(reopened);
      check("SIGKILL post-commit: both row-sets AND the same-tx ledger row are durable",
        counts.memories === 2 && counts.seq === 2 && counts.meta === 2 && counts.fts === 2 &&
          rawStateValue(reopened, "import:test:ledger") === "boundary-ok" && reopened.getMemoryRevision() === 2,
        JSON.stringify(counts));
      check("committed imported rows recall after reopen",
        reopened.getMemory("legacy-crash-0001")?.createdAt === 1_700_000_000_111 &&
          getMetaSafe(reopened, "legacy-crash-0001")?.provenance === "user");
      reopened.close();
    }
  }
}

// ---------------------------------------------------------------------------
console.log(`\nimport-seam suite: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

// ---------------------------------------------------------------------------

function safeTx(fn) {
  try { fn(); return null; } catch (e) { return e; }
}

function currentCounts(store) {
  const raw = store.getJournalSqlite();
  const n = (sql) => Number(raw.prepare(sql).get()?.n ?? 0);
  return {
    memories: n("SELECT COUNT(*) n FROM memories"),
    meta: n("SELECT COUNT(*) n FROM memories_meta"),
    fts: n("SELECT COUNT(*) n FROM memories_fts"),
    seq: n("SELECT COUNT(*) n FROM memories_seq"),
  };
}

function countsEqual(a, b) {
  return a.memories === b.memories && a.meta === b.meta && a.fts === b.fts && a.seq === b.seq;
}

function seqOf(store, id) {
  const row = store.getJournalSqlite().prepare("SELECT seq FROM memories_seq WHERE memory_id = ?").get(id);
  return row === undefined ? -1 : Number(row.seq);
}

function maxSeq(store) {
  const row = store.getJournalSqlite().prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM memories_seq").get();
  return Number(row.m);
}

function revisionReason(store) {
  const row = store.getJournalSqlite().prepare("SELECT value FROM store_state WHERE key = 'memoryRevisionReason'").get();
  return row === undefined ? "" : String(row.value);
}

function rawStateValue(store, key) {
  const row = store.getJournalSqlite().prepare("SELECT value FROM store_state WHERE key = ?").get(key);
  return row === undefined ? undefined : String(row.value);
}

function getMetaSafe(store, id) {
  try { return store.getMeta(id); } catch { return null; }
}

function fieldsMatch(expected, actual) {
  for (const k of Object.keys(expected)) {
    if (expected[k] !== actual[k]) return false;
  }
  return true;
}
