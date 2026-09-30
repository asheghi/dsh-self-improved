/**
 * M1 storage module unit tests: insert / FTS5 search / list / forget / delete / sqlite-vec extension loading.
 * Run: node scripts/test-storage.mjs
 */
import { rmSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { assembleSessionEpisodes } from "../lib/episodes.js";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "m1-unit");
rmSync(dir, { recursive: true, force: true });

const store = new MemoryStore(dir);
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!cond) failed++;
};

// 1) Files and database files
check("memory.db created", existsSync(join(dir, "memory.db")));
check("conversations directory logic available", typeof store.appendConversationSlice === "function");

// 2) Insert
const m1 = store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 }, { provenance: "user" });
const m2 = store.insertMemory({ kind: "fact", content: "Project E:\\dshPro manages dependencies with pnpm", importance: 7 }, { provenance: "user" });
const m3 = store.insertMemory({ kind: "event", content: "5/14 completed the payment module migration, took about 4 hours", importance: 6 }, { provenance: "user" });
check("inserting 3 memories returns ids", m1.id && m2.id && m3.id);

// 2b) Fail-closed provenance: an insert that omits provenance must land in the
// untrusted 'unknown' tier (never injectable, never recallable), never in the
// trusted tier the old default stamped.
const noMeta = store.insertMemory({ kind: "fact", content: "Insert without provenance metadata", importance: 9 });
const noMetaMeta = store.getMeta(noMeta.id);
check("insertMemory without provenance defaults to unknown", noMetaMeta?.provenance === "unknown", JSON.stringify(noMetaMeta));
check("unknown-tier insert is not injectable", !store.getActiveMemories(50, 0, true).some((m) => m.id === noMeta.id));
check("unknown-tier insert is not keyword-searchable via recall lane", !store.searchMemories("provenance metadata", { limit: 10, injectableOnly: true }).some((h) => h.id === noMeta.id));

// 3) FTS5 search (BM25)
let hits = store.searchMemories("PowerShell", { limit: 5 });
check("FTS hits preference", hits.length === 1 && hits[0].kind === "preference", `got ${hits.length}`);
hits = store.searchMemories("pnpm dependencies", { limit: 5 });
check("FTS hits fact (multi-term)", hits.length >= 1 && hits[0].content.includes("pnpm"), `got ${hits.length}`);
hits = store.searchMemories("nonexistentwordxyzzy", { limit: 5 });
check("no match returns empty", hits.length === 0);

// 4) List / single lookup / forget / delete
check("listMemories returns 4", store.listMemories().length === 4);
check("getMemory hits", store.getMemory(m1.id)?.kind === "preference");
check("forgetMemory works", store.forgetMemory(m1.id) === true);
hits = store.searchMemories("PowerShell", { limit: 5 });
check("no hits after forget", hits.length === 0);
check("deleteMemory works", store.deleteMemory(m2.id) === true);
// listMemories is a browse view: forgotten records are kept for recovery, so m1(forgotten) + m3 = 2 records remain
check("list has 3 records left after delete (including forgotten)", store.listMemories().length === 3, `got ${store.listMemories().length}`);
check("listMemories includes the forgotten record", store.listMemories().some((m) => m.status === "forgotten"));

// 5) L0 slice persistence
store.appendConversationSlice("session-test-1", [
  { type: "user", seq: 1, ts: Date.now(), text: "Hello", sessionId: "session-test-1" },
  { type: "assistant", seq: 2, ts: Date.now(), text: "Hello, how can I help?", sessionId: "session-test-1" },
]);
const convDir = join(dir, "conversations");
check("conversations directory created", existsSync(convDir));
check("slices persisted to JSONL", readdirSync(convDir).length === 1);

// 6) sqlite-vec extension (whether vectors.db was created)
check("sqlite-vec loaded (vectors.db)", existsSync(join(dir, "vectors.db")), "if not created, vectors are disabled (does not block M1)");

// 7) schemaVersion: fresh store is at v2 (v1 + v2 markers recorded)
check("schemaVersion on fresh store is 2", store.schemaVersion() === 2, String(store.schemaVersion()));

store.close();

// =====================================================================
// 8) v1 → v2 migration: legacy v1-era database gains episode tables and the
//    v2 marker WITHOUT touching memories rows or their meta/fts content.
// =====================================================================
{
  const { DatabaseSync } = await import("node:sqlite");
  const legacyDir = join(dir, "v1-to-v2");
  rmSync(legacyDir, { recursive: true, force: true });
  mkdirSync(legacyDir, { recursive: true });
  // Seed v1-era memories through a full store build, then snapshot the memory rows
  {
    const seeded = new MemoryStore(legacyDir);
    seeded.insertMemory({ kind: "fact", content: "legacy fact row one", importance: 7 }, { provenance: "user" });
    seeded.insertMemory({ kind: "preference", content: "legacy preference row two", importance: 6 }, { provenance: "user" });
    seeded.close();
  }
  const snapshotBefore = () => {
    const db = new DatabaseSync(join(legacyDir, "memory.db"));
    const rows = db.prepare("SELECT id, kind, content, importance, status FROM memories ORDER BY content").all();
    const meta = db.prepare("SELECT memory_id, provenance, source, scope FROM memories_meta ORDER BY memory_id").all();
    db.close();
    return JSON.stringify({ rows, meta });
  };
  const before = snapshotBefore();
  // Simulate a v1-era db: drop the v2 marker (episode tables already exist — this is exactly
  // the interrupted-migration recovery state the migration must handle idempotently)
  {
    const db = new DatabaseSync(join(legacyDir, "memory.db"));
    db.exec("DELETE FROM schema_state WHERE key = 'v2'");
    db.exec("PRAGMA user_version = 1");
    // Also drop the episode tables to exercise the FULL first-time v2 upgrade path
    db.exec(`
      DROP INDEX IF EXISTS idx_episode_steps_call; DROP TABLE IF EXISTS episode_steps;
      DROP INDEX IF EXISTS idx_episode_events_session; DROP TABLE IF EXISTS episode_events;
      DROP INDEX IF EXISTS idx_episodes_project_status; DROP INDEX IF EXISTS idx_episodes_session_turn;
      DROP INDEX IF EXISTS idx_episodes_reviewed; DROP INDEX IF EXISTS idx_episodes_fingerprint;
      DROP TABLE IF EXISTS episodes;`);
    db.close();
  }
  check("pre-upgrade db is at v1", (() => {
    const db = new DatabaseSync(join(legacyDir, "memory.db"));
    const v = db.prepare("SELECT value FROM schema_state WHERE key = 'v1'").get()?.value;
    const v2 = db.prepare("SELECT value FROM schema_state WHERE key = 'v2'").get()?.value;
    db.close();
    return Boolean(v) && !v2;
  })());
  const store2 = new MemoryStore(legacyDir);
  check("v1→v2 migration reaches version 2", store2.schemaVersion() === 2, String(store2.schemaVersion()));
  check("memories rows unchanged through migration", snapshotBefore() === before, "memory content+meta identical");
  const mem2 = store2.listMemories({ kind: "fact" });
  check("upgraded store keeps memories searchable", mem2.some((m) => m.content === "legacy fact row one"));
  // Episode tables exist and are usable after the migration
  store2.appendEpisodeEvents("mig-session", "legacy-fact", false, [
    { kind: "call", callId: "c-mig", turn: 1, step: 0, seq: 1, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-mig" }) },
    { kind: "result", callId: "c-mig", turn: 1, step: 0, seq: 2, at: 1001, payload: JSON.stringify({ toolCallId: "c-mig", resultExcerpt: "ok", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn: 1, step: null, seq: 3, at: 1002, payload: JSON.stringify({ reason: "none" }) },
  ]);
  assembleSessionEpisodes(store2, "mig-session");
  check("episode tables functional after migration", store2.listEpisodes({ projectId: "legacy-fact" }).length === 1);
  store2.close();

  // Interrupted-migration recovery: strip only the v2 marker, reopen → clean re-run
  {
    const db = new DatabaseSync(join(legacyDir, "memory.db"));
    db.exec("DELETE FROM schema_state WHERE key = 'v2'");
    db.exec("PRAGMA user_version = 1");
    db.close();
  }
  const beforeRecover = snapshotBefore();
  const store3 = new MemoryStore(legacyDir);
  check("interrupted v2 recovery reaches version 2", store3.schemaVersion() === 2, String(store3.schemaVersion()));
  check("memories rows unchanged through recovery", snapshotBefore() === beforeRecover);
  check("existing episodes intact through recovery", store3.listEpisodes().length === 1);
  store3.close();
}

// =====================================================================
// 9) Episode purge: created_at comparison + project scoping (no seq-vs-epoch bug)
// =====================================================================
{
  const purgeDir = join(dir, "purge");
  rmSync(purgeDir, { recursive: true, force: true });
  const pstore = new MemoryStore(purgeDir);
  const rows = [
    // session ps-1 → project "proj-p"
    { kind: "call", callId: "c-p1", turn: 1, step: 0, seq: 1, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-p1" }) },
    { kind: "result", callId: "c-p1", turn: 1, step: 0, seq: 2, at: 1001, payload: JSON.stringify({ toolCallId: "c-p1", resultExcerpt: "ok", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn: 1, step: null, seq: 3, at: 1002, payload: JSON.stringify({ reasonKind: "completed" }) },
    // fresh unclaimed call row session ps-1 (project "proj-p")
    { kind: "call", callId: "c-fresh", turn: 2, step: 0, seq: 4, at: 1003, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-fresh" }) },
    // fresh unclaimed call row session ps-2 → project "proj-q"
    { kind: "call", callId: "c-other", turn: 1, step: 0, seq: 5, at: 1004, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-other" }) },
  ];
  pstore.appendEpisodeEvents("ps-1", "proj-p", false, rows.slice(0, 4));
  // a second FRESH unclaimed row that must survive any age purge
  pstore.appendEpisodeEvents("ps-1", "proj-p", false, [
    { kind: "call", callId: "c-fresh2", turn: 3, step: 0, seq: 9, at: 1006, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-fresh2" }) },
  ]);
  // The age-purge target: its own single-row session in project proj-p, never
  // closed → stays unclaimed/pending
  pstore.appendEpisodeEvents("ps-3", "proj-p", false, [
    { kind: "call", callId: "c-old", turn: 1, step: 0, seq: 10, at: 1007, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-old" }) },
  ]);
  pstore.appendEpisodeEvents("ps-2", "proj-q", false, rows.slice(4));
  assembleSessionEpisodes(pstore, "ps-1");
  const epId = pstore.getEpisodeBySessionTurn("ps-1", 1).id;
  check("flush(state by fresh rows only): purge is a no-op", pstore.purgeEpisodes({ olderThanTs: Date.now() - 86_400_000 }).events === 0, JSON.stringify(pstore.totalEpisodeEventCount()));
  check("kept episode intact", pstore.getEpisode(epId).status === "succeeded");
  check("kept claimed rows intact", pstore.getEpisodeSteps(epId).length === 1);
  const evs = pstore.getTurnEpisodeEvents("ps-1", 1);
  check("claimed event rows intact", evs.length === 3 && evs.every((e) => e.episodeId !== null), JSON.stringify(evs.map((e) => e.episodeId)));

  // Age one unclaimed row of project proj-p (via direct SQL: created_at is a persistence detail).
  // c-old sits on an open turn (no later turn), so it stays unclaimed/pending.
  const { DatabaseSync } = await import("node:sqlite");
  const pdb = new DatabaseSync(join(purgeDir, "memory.db"));
  pdb.prepare(`UPDATE episode_events SET created_at = ? WHERE session_id = 'ps-3' AND episode_id IS NULL AND call_id = 'c-old'`).run(Date.now() - 90 * 86_400_000);
  // A row of the OTHER project that is equally old must survive project scope
  pdb.prepare(`UPDATE episode_events SET created_at = ? WHERE session_id = 'ps-2' AND episode_id IS NULL AND call_id = 'c-other'`).run(Date.now() - 90 * 86_400_000);
  pdb.close();
  const cutoff = Date.now() - 86_400_000;
  const scoping = pstore.purgeEpisodes({ projectId: "proj-p", olderThanTs: cutoff });
  check("only old unclaimed rows in scope are purged", scoping.events === 1 && scoping.episodes === 0, JSON.stringify(scoping));
  check("other project's old row survives", pstore.getPendingEpisodeEvents("ps-2").length === 1);
  check("fresh unclaimed rows survive (created_at respected)", pstore.getPendingEpisodeEvents("ps-1").some((r) => r.callId === "c-fresh2"), JSON.stringify(pstore.getPendingEpisodeEvents("ps-1")));
  check("kept episode survives", pstore.getEpisode(epId) !== undefined && pstore.getEpisodeSteps(epId).length === 1);
  pstore.close();
}

// =====================================================================
// 10) Gates: commitEpisode refuses frozen episodes; setEpisodeReview only on
//     succeeded/failed unreviewed rows
// =====================================================================
{
  const gDir = join(dir, "gates");
  rmSync(gDir, { recursive: true, force: true });
  const gstore = new MemoryStore(gDir);
  gstore.appendEpisodeEvents("gs-1", "proj-g", false, [
    { kind: "call", callId: "c-g1", turn: 1, step: 0, seq: 1, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-g1" }) },
    { kind: "result", callId: "c-g1", turn: 1, step: 0, seq: 2, at: 1001, payload: JSON.stringify({ toolCallId: "c-g1", resultExcerpt: "ok", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn: 1, step: null, seq: 3, at: 1002, payload: JSON.stringify({ reasonKind: "completed" }) },
  ]);
  assembleSessionEpisodes(gstore, "gs-1");
  const gateEp = gstore.getEpisodeBySessionTurn("gs-1", 1);
  check("review accepts succeeded unreviewed", gstore.setEpisodeReview(gateEp.id, { summary: "ok", confidence: 0.8, status: "reviewed" }) === true);
  const reread = gstore.getEpisode(gateEp.id);
  check("review persisted", reread.status === "reviewed" && reread.summary === "ok" && reread.reviewedAt !== null);
  check("review refuses already-reviewed", gstore.setEpisodeReview(gateEp.id, { summary: "again", confidence: 0.5, status: "rejected" }) === false);
  check("review does not overwrite", gstore.getEpisode(gateEp.id).summary === "ok");

  // commitEpisode at a frozen (reviewed) episode: no steps, no claims.
  const stepCountBefore = gstore.getEpisodeSteps(gateEp.id).length;
  gstore.appendEpisodeEvents("gs-1", "proj-g", false, [
    { kind: "call", callId: "c-g2", turn: 1, step: 1, seq: 4, at: 1003, payload: JSON.stringify({ toolName: "grep", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-g2" }) },
  ]);
  gstore.commitEpisode(
    { sessionId: "gs-1", projectId: "proj-g", turn: 1, status: "succeeded", startedAt: 1000, endedAt: 1003, firstSeq: 1, lastSeq: 4, fingerprint: null, delegated: false },
    [{ episodeId: "x", ordinal: 9, callId: "c-g2", toolName: "grep", argumentsRedacted: "{}", resultExcerpt: "r", isError: 0, errorName: null, errorCode: null, callSeq: 4, resultSeq: null, callAt: 1003, resultAt: null, argsTruncated: 0, resultTruncated: 0 }],
    ["c-g2", "c-g1"],
  );
  check("commitEpisode refuses frozen episode (no steps)", gstore.getEpisodeSteps(gateEp.id).length === stepCountBefore, JSON.stringify(gstore.getEpisodeSteps(gateEp.id).length));
  check("commitEpisode refuses frozen episode (no claims)", gstore.getPendingEpisodeEvents("gs-1").filter((r) => r.turn === 1 && r.callId === "c-g2").length === 1);
  // gate episode row itself untouched
  check("frozen episode never reclassified by commit", gstore.getEpisode(gateEp.id).status === "reviewed");

  // setEpisodeReview refuses on ambiguous/pending rows
  gstore.appendEpisodeEvents("gs-1", "proj-g", false, [
    { kind: "call", callId: "c-g3", turn: 2, step: 0, seq: 5, at: 1005, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-g3" }) },
    { kind: "turn-end", callId: "", turn: 2, step: null, seq: 6, at: 1006, payload: JSON.stringify({ reasonKind: "completed" }) },
  ]);
  assembleSessionEpisodes(gstore, "gs-1");
  const amb = gstore.getEpisodeBySessionTurn("gs-1", 2);
  check("setup: unpaired turn is ambiguous", amb && amb.status === "ambiguous", JSON.stringify(amb?.status));
  check("review refuses ambiguous", gstore.setEpisodeReview(amb.id, { summary: "no", confidence: 0.5, status: "reviewed" }) === false);
  check("ambiguous untouched by refused review", gstore.getEpisode(amb.id).status === "ambiguous" && gstore.getEpisode(amb.id).summary === null);
  gstore.close();
}

console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
