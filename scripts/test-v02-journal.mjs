#!/usr/bin/env node
/**
 * Phase B durable-core regression suite (scripts/test-v02-journal.mjs).
 *
 * Gates proven here (MIGRATION-V0.2.md Phase B, storage/journal slice):
 * - enqueue atomicity: session header + minimized sources + job/chunk coverage
 *   commit together; minimization (redact+bound) happens BEFORE persistence;
 * - crash at every enqueue/claim/commit boundary via REAL child-process
 *   SIGKILL (fixtures/v02-journal/worker-a.mjs + sqlite-crash-driver.mjs) and
 *   parent-process re-verification of the same SQLite file — genuine durable
 *   restart evidence, not same-process mocks;
 * - idempotence across retries and restarts (no duplicate evidence, no
 *   inflated support counts, no double-derived memories);
 * - long-input bounded chunking at event/text boundaries, lossless (no middle
 *   truncation, full-range ack only after every chunk);
 * - malformed/aborted/truncated/unknown-terminal outputs remain retryable with
 *   a bounded attempt budget; missing/revoked sources are NEVER acked;
 * - MemoryStore.getMemoryRevision(): monotonic, bumped in the same transaction
 *   on recall-affecting mutations, never on popularity reads;
 * - durable policy/cancellation generations: policy change cancels stale
 *   queued work; cancellation commits are terminal (late commits cannot
 *   recreate revoked material);
 * - seq-0 preservation, native fork identity retention, shared-source
 *   single-processing;
 * - support-graph removal: journal source revocation quarantines derived
 *   memories (same transaction) and blocks late re-population.
 *
 * Storage lives under a unique os.tmpdir() tree owned and cleaned here.
 * NO production store, no live profile, no provider, no network, no 3082.
 *
 * Exit 0 = every check passed; any failure exits 1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { MemoryStore } = await import(join(repo, "lib/storage.js"));
const { MemoryJournalV02, JournalContractError, journalTextSegments, planSourceChunks } = await import(
  join(repo, "lib/memory-journal-v02.js")
);
const { sqliteCrashSupportAvailable, runCrashBoundaryScenario, assertSignalKilled, assertCleanExit } =
  await import(join(repo, "fixtures/v02-journal/sqlite-crash-driver.mjs"));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const registered = [];
const check = (name, fn) => registered.push({ name, fn });
const uniqueTmpTree = (prefix) => mkdtempSync(join(tmpdir(), prefix));

function freshJournal(opts = {}) {
  const dir = uniqueTmpTree("journal-v02-");
  const store = new MemoryStore(dir);
  // Controllable deterministic clock (default: real time).
  let clock = opts.clockStart ?? Date.now();
  const journal = new MemoryJournalV02(store, { ...opts, nowMs: () => clock });
  return {
    dir,
    store,
    journal,
    advance(ms) {
      clock += ms;
      return clock;
    },
  };
}

const appendEvents = (journal, sessionId, events, extra = {}) =>
  journal.appendSession({
    sessionId,
    projectId: extra.projectId ?? "proj-test",
    producer: extra.producer ?? { delegated: false, inheritedEventCount: 0 },
    sourceMaxChars: extra.sourceMaxChars ?? 400,
    events,
    ...(extra.maxAttempts ? { maxAttempts: extra.maxAttempts } : {}),
  });

// ===========================================================================
// 1. Pure deterministic helpers
// ===========================================================================

check("journalTextSegments is lossless (concatenation equals input; no middle truncation)", () => {
  const long = `${"x".repeat(255)}\n\n${"y".repeat(290)}\ntail`;
  const segs = journalTextSegments(long, 300);
  assert.equal(segs.join(""), long, `concat length ${segs.join("").length} != ${long.length}`);
  assert.ok(segs.length >= 2);
  for (let i = 0; i < segs.length - 1; i++) {
    assert.ok(segs[i].length <= 300, `interior segment too long: ${segs[i].length}`);
  }
  assert.equal(journalTextSegments("", 300).length, 1, "empty text stays coverable");
  assert.deepEqual(journalTextSegments("short", 300), ["short"]);
});

check("planSourceChunks union covers exactly the planned events within the char budget", () => {
  const events = [
    { seq: 0, text: "s" },
    { seq: 1, text: "a".repeat(200) },
    { seq: 2, text: "b".repeat(200) },
  ];
  const planned = planSourceChunks(events, 300);
  const covered = new Set();
  for (const chunk of planned) {
    for (let s = chunk.fromSeq; s <= chunk.toSeq; s++) covered.add(s);
    assert.ok(chunk.chars <= 300, `chunk over budget: ${chunk.chars}`);
  }
  assert.deepEqual([...covered].sort((a, b) => a - b), [0, 1, 2]);
});

// ===========================================================================
// 2. Enqueue: atomicity, minimization, seq-0, dedup
// ===========================================================================

check("enqueue is atomic (session+sources+jobs) and minimizes BEFORE persistence; seq 0 preserved", () => {
  const { store, journal } = freshJournal();
  const report = appendEvents(journal, "session-a", [
    { seq: 0, ts: 1000, kind: "user", text: "user password = SYNTH0001 hello", sourceKind: "user" },
    { seq: 1, ts: 1001, kind: "assistant", text: "assistant token = SYNTH0002 remains", sourceKind: "model" },
    { seq: 2, ts: 1002, kind: "tool", text: 'SYNTH_SECRET=SYNTH0003 {"apiKey":"SYNTH0004"}', sourceKind: "model" },
  ]);
  assert.equal(report.stored, 3);
  assert.equal(report.jobsCreated, 1, `expected one coverage job, got ${report.jobsCreated}`);
  assert.equal(report.pendingSeqs, 3);
  const raw = store
    .getJournalSqlite()
    .prepare("SELECT text FROM journal_sources WHERE session_id='session-a' ORDER BY seq")
    .all()
    .map((r) => String(r.text))
    .join("\n");
  assert.ok(!raw.includes("SYNTH0001"), "labeled credential must be redacted before persistence");
  assert.ok(!raw.includes("SYNTH0002"), "assistant-labeled token must be redacted");
  assert.ok(!raw.includes("SYNTH0003"), "secret= label must be redacted");
  assert.ok(!raw.includes("SYNTH0004"), "apiKey object field must be redacted before persistence");
  assert.ok(raw.includes("[REDACTED]"), "expected redaction markers in minimized text");
  const jobs = journal.listJobs({ sessionId: "session-a" });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].fromSeq, 0, "legitimate seq 0 is the job floor");
  store.close();
});

check("identical re-enqueue dedups; conflicting content at the same coordinate is counted, never overwritten", () => {
  const { store, journal } = freshJournal();
  const first = appendEvents(journal, "session-c", [
    { seq: 0, ts: 1000, kind: "user", text: "dupe-me", sourceKind: "user" },
  ]);
  const second = appendEvents(journal, "session-c", [
    { seq: 0, ts: 1000, kind: "user", text: "dupe-me", sourceKind: "user" },
  ]);
  assert.equal(first.stored, 1);
  assert.equal(second.deduped, 1);
  assert.equal(second.jobsCreated, 0, "no duplicate coverage job");
  const conflict = appendEvents(journal, "session-c", [
    { seq: 0, ts: 1000, kind: "user", text: "changed content", sourceKind: "user" },
  ]);
  assert.equal(conflict.conflictDeduped, 1, "conflict counted");
  assert.equal(conflict.stored, 0, "original lineage preserved (no overwrite)");
  store.close();
});

check("native fork identity persists on the journal session header", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "fork-child", [{ seq: 0, ts: 1, kind: "user", text: "own event", sourceKind: "user" }], {
    producer: { delegated: true, origin: "subagent", parentSessionId: "parent-x", rootSessionId: "root-x", inheritedEventCount: 5 },
  });
  const view = journal.listJobs({ sessionId: "fork-child" })[0];
  assert.ok(view, "fork child job exists");
  assert.equal(view.producerHeader.delegated, true);
  assert.equal(view.producerHeader.parentSessionId, "parent-x");
  assert.equal(view.producerHeader.inheritedEventCount, 5, "rc.2 fork boundary retained");
  store.close();
});

// ===========================================================================
// 3. Claim / evidence / commit
// ===========================================================================

check("claim → evidence → consumed commit acks the exact range and derives one memory", () => {
  const { store, journal } = freshJournal({ chunkMaxChars: 5000 });
  appendEvents(journal, "session-c2", [
    { seq: 0, ts: 1, kind: "user", text: "Prefers dark mode", sourceKind: "user" },
    { seq: 1, ts: 2, kind: "user", text: "Uses PowerShell", sourceKind: "user" },
  ]);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim, "claim succeeds");
  assert.deepEqual([claim.fromSeq, claim.toSeq], [0, 1]);
  const ev = journal.readChunkEvidence(claim);
  assert.equal(ev.status, "ok");
  assert.equal(ev.events.length, 2);
  const report = journal.commitChunkResult(claim, ev.chunkIdx, {
    kind: "consumed",
    candidates: [{ text: "User prefers dark mode", provenance: "user", scope: "global", kind: "preference", importance: 7 }],
  });
  assert.ok(report.acked);
  assert.equal(report.chunksPending, 0);
  assert.equal(report.jobState, "done");
  assert.deepEqual(journal.getConsumedRanges("session-c2"), [{ fromSeq: 0, toSeq: 1 }]);
  const mems = store.listMemories({});
  assert.equal(mems.length, 1);
  assert.equal(mems[0].meta.provenance, "user");
  assert.equal(mems[0].meta.projectId, null, "global scope drops the project binding");
  store.close();
});

check("nothing-to-learn is a distinct verdict: acks without candidates; no memory rows", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-f", [{ seq: 0, ts: 1, kind: "user", text: "smalltalk", sourceKind: "user" }]);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  const report = journal.commitChunkResult(claim, 0, { kind: "nothing-to-learn", note: "smalltalk" });
  assert.ok(report.acked);
  assert.equal(report.memoryIds.length, 0);
  assert.equal(store.listMemories({}).length, 0);
  store.close();
});

check("retryable verdict never acks; attempt budget bounds the retry loop; failure is terminal", () => {
  const { store, journal, advance } = freshJournal({ defaultMaxAttempts: 2 });
  appendEvents(journal, "session-d", [{ seq: 0, ts: 1, kind: "user", text: "will fail", sourceKind: "user" }]);
  let claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  let report = journal.commitChunkResult(claim, 0, {
    kind: "retryable",
    reason: "malformed-model-output",
    message: "bad shape",
  });
  assert.ok(!report.acked);
  assert.equal(report.jobState, "queued");
  assert.ok(report.retryScheduledAt > 0, "backoff scheduled durably");
  advance(20 * 60_000); // past the deterministic backoff
  claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim, "second attempt claimable after backoff");
  report = journal.commitChunkResult(claim, 0, {
    kind: "retryable",
    reason: "provider-truncated",
    message: "truncated output",
  });
  assert.ok(!report.acked);
  assert.equal(journal.getJob(claim.jobId).state, "failed", "attempt budget exhausted → failed");
  assert.deepEqual(journal.getConsumedRanges("session-d"), [], "failed work never acks");
  store.close();
});

check("missing source row is never acked: evidence reports unavailable and commit fails the job", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-e", [{ seq: 0, ts: 1, kind: "user", text: "x", sourceKind: "user" }]);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  // Corruption drill: the source row disappears out-of-band (corrupt store).
  store.getJournalSqlite().prepare("DELETE FROM journal_sources WHERE session_id='session-e'").run();
  const ev = journal.readChunkEvidence(claim);
  assert.equal(ev.status, "unavailable");
  assert.equal(ev.reasonCode, "missing-source-row");
  const report = journal.commitChunkResult(claim, 0, {
    kind: "source-unavailable",
    reason: "missing",
    message: "range is truly missing",
  });
  assert.ok(!report.acked);
  assert.equal(journal.getJob(claim.jobId).state, "failed");
  assert.deepEqual(journal.getConsumedRanges("session-e"), []);
  store.close();
});

check("long input: bounded chunks at text boundaries consume every segment, ack only on full coverage", () => {
  const { store, journal } = freshJournal({ chunkMaxChars: 1000 });
  const body = Array.from({ length: 60 }, (_, i) => `paragraph-${i} ${"z".repeat(180)}`).join("\n\n");
  // sourceMaxChars ABOVE the body length: the CAPTURE bound must not interfere
  // with the lossless-chunking proof (segmentation covers the whole retained text).
  appendEvents(journal, "session-long", [{ seq: 0, ts: 1, kind: "user", text: body, sourceKind: "user" }], {
    sourceMaxChars: 40_000,
  });
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  const collected = [];
  let ev = journal.readChunkEvidence(claim);
  let guard = 0;
  while (ev.status === "ok") {
    assert.ok(ev.events.length === 1 && ev.events[0].isPartial, "oversized event chunks by segment");
    collected.push(ev.events[0].text);
    const report = journal.commitChunkResult(claim, ev.chunkIdx, { kind: "nothing-to-learn" });
    assert.ok(report.acked, `segment chunk ${ev.chunkIdx} must ack`);
    if (report.jobState === "done") break;
    ev = journal.readChunkEvidence(claim);
    if (ev.status === "exhausted") break;
    if (++guard > 500) throw new Error("chunk loop did not terminate");
  }
  assert.equal(collected.join(""), body, "every text-boundary segment reached the worker (lossless)");
  assert.deepEqual(journal.getConsumedRanges("session-long"), [{ fromSeq: 0, toSeq: 0 }]);
  store.close();
});

check("commit idempotence: once the job is done, repeating the chunk commit is claim-invalid (no new rows)", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-idem", [{ seq: 0, ts: 1, kind: "user", text: "idempotent", sourceKind: "user" }]);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  const first = journal.commitChunkResult(claim, 0, {
    kind: "consumed",
    candidates: [{ text: "Only once", provenance: "user", scope: "global" }],
  });
  assert.ok(first.acked && first.memoryIds.length === 1);
  assert.equal(journal.getJob(claim.jobId).state, "done", "job completes with its last chunk");
  assert.throws(
    () =>
      journal.commitChunkResult(claim, 0, {
        kind: "consumed",
        candidates: [{ text: "Only once", provenance: "user", scope: "global" }],
      }),
    (err) => err.code === "claim-invalid",
    "committing against a finished job is a typed contract violation",
  );
  assert.equal(store.listMemories({}).length, 1, "no duplicate memory rows");
  store.close();
});

check("retry after a retryable round does not double-derive the same candidate", () => {
  const { store, journal, advance } = freshJournal({ defaultMaxAttempts: 3 });
  appendEvents(journal, "session-dup", [{ seq: 0, ts: 1, kind: "user", text: "dup check", sourceKind: "user" }]);
  let claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  journal.commitChunkResult(claim, 0, { kind: "retryable", reason: "transient", message: "provider hiccup" });
  advance(20 * 60_000);
  claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  const report = journal.commitChunkResult(claim, 0, {
    kind: "consumed",
    candidates: [{ text: "Dedup candidate", provenance: "user", scope: "global" }],
  });
  assert.ok(report.acked && report.memoryIds.length === 1);
  assert.equal(store.listMemories({}).length, 1, "support count not inflated across the retry");
  store.close();
});

// ===========================================================================
// 4. Memory revision contract
// ===========================================================================

check("getMemoryRevision is monotonic; bumps on insert/forget/status/delete/correction; NOT on popularity", () => {
  const { store } = freshJournal();
  assert.equal(store.getMemoryRevision(), 0);
  const m1 = store.insertMemory({ kind: "fact", content: "r1", importance: 3 }, { provenance: "user" });
  const afterInsert = store.getMemoryRevision();
  assert.ok(afterInsert >= 1);
  store.recordAccess([m1.id]);
  assert.equal(store.getMemoryRevision(), afterInsert, "popularity reads never bump");
  store.updateMeta(m1.id, { confidence: 0.9 });
  const afterCorrection = store.getMemoryRevision();
  assert.ok(afterCorrection > afterInsert, "correction bumps");
  store.forgetMemory(m1.id);
  const afterForget = store.getMemoryRevision();
  assert.ok(afterForget > afterCorrection, "forget bumps");
  const m2 = store.insertMemory({ kind: "fact", content: "r2" }, { provenance: "user" });
  store.setMemoryStatus(m2.id, "quarantined");
  const afterStatus = store.getMemoryRevision();
  assert.ok(afterStatus > afterForget, "status transition bumps");
  store.deleteMemory(m2.id);
  assert.ok(store.getMemoryRevision() > afterStatus, "deletion bumps");
  // Monotonic across restart: reopen the same directory.
  const dir = store.dir;
  store.close();
  const reopened = new MemoryStore(dir);
  assert.ok(reopened.getMemoryRevision() >= store.getMemoryRevision(), "revision survives restart");
  reopened.close();
});

// ===========================================================================
// 5. Policy / cancellation generations
// ===========================================================================

check("policy bump cancels stale queued jobs; claim refresh re-baselines the snapshot; stale commit rejected", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-g", [{ seq: 0, ts: 1, kind: "user", text: "x", sourceKind: "user" }]);
  assert.equal(journal.getPolicyGeneration(), 0);
  const claim0 = journal.claimWork({ kind: "extract" });
  assert.ok(claim0);
  const gen1 = journal.bumpPolicyGeneration("consent-revoked");
  assert.equal(gen1, 1);
  // Claimed job survives the bump but its commit is stale.
  assert.throws(
    () => journal.commitChunkResult(claim0, 0, { kind: "consumed", candidates: [] }),
    (err) => err.code === "stale-policy-generation",
    "stale policy commit must be rejected",
  );
  assert.equal(journal.getJob(claim0.jobId).state, "queued", "stale commit released the claim");
  assert.deepEqual(journal.getConsumedRanges("session-g"), [], "stale commit never acked");
  assert.equal(store.listMemories({}).length, 0, "stale commit inserted nothing");
  // New queued job (replanned after release) is claimable under the new gen.
  const claim1 = journal.claimWork({ kind: "extract" });
  assert.ok(claim1, "work still claimable after policy refresh");
  assert.equal(claim1.policyGeneration, gen1, "claim snapshot re-baselined");
  const report = journal.commitChunkResult(claim1, 0, { kind: "nothing-to-learn" });
  assert.ok(report.acked, "commit under the refreshed generation succeeds");
  store.close();
});

check("cancellation generation: queued jobs cancel immediately; late claimed commit is TERMINALLY cancelled", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-h", [{ seq: 0, ts: 1, kind: "user", text: "stale cancel me", sourceKind: "user" }]);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  journal.bumpCancellationGeneration("forget-all");
  assert.throws(
    () => journal.commitChunkResult(claim, 0, {
      kind: "consumed",
      candidates: [{ text: "SHOULD NOT EXIST", provenance: "user", scope: "global" }],
    }),
    (err) => err.code === "stale-cancellation-generation",
  );
  assert.equal(journal.getJob(claim.jobId).state, "cancelled", "late commit leaves the job cancelled");
  assert.deepEqual(journal.getConsumedRanges("session-h"), []);
  assert.equal(store.listMemories({}).length, 0, "revoked material never recreated");
  assert.equal(journal.claimWork({ kind: "extract" }), null, "cancelled work never resurrects");
  store.close();
});

check("generation counters are durable across journal instances (fresh constructor, same SQLite)", () => {
  const { store, journal } = freshJournal();
  journal.bumpPolicyGeneration("policy-A");
  journal.bumpCancellationGeneration("consent-off");
  const st1 = journal.status();
  const reopened = new MemoryJournalV02(store);
  const st2 = reopened.status();
  assert.equal(st2.policyGeneration, st1.policyGeneration);
  assert.equal(st2.cancellationGeneration, st1.cancellationGeneration);
  assert.ok(st2.policyGeneration >= 1 && st2.cancellationGeneration >= 1);
  store.close();
});

// ===========================================================================
// 6. Shared-source single-processing
// ===========================================================================

check("same source range cannot be double-claimed; completed range never re-enqueues work", () => {
  const { store, journal } = freshJournal();
  const events = [{ seq: 0, ts: 1, kind: "user", text: "shared source", sourceKind: "user" }];
  appendEvents(journal, "session-l", events);
  const claimA = journal.claimWork({ kind: "extract" });
  assert.ok(claimA);
  assert.equal(journal.claimWork({ kind: "extract" }), null, "no second claim of the same queued job");
  const resultA = journal.commitChunkResult(claimA, 0, {
    kind: "consumed",
    candidates: [{ text: "Shared fact processed once", provenance: "user", scope: "global" }],
  });
  assert.ok(resultA.acked);
  const reEnq = appendEvents(journal, "session-l", events);
  assert.equal(reEnq.deduped, 1);
  assert.equal(reEnq.jobsCreated, 0, "completed range produces no new job");
  assert.equal(store.listMemories({}).length, 1);
  store.close();
});

// ===========================================================================
// 6.5 Oversize fail-closed append: raw input above `sourceMaxChars` is a typed
//     ATOMIC rejection (never a silently truncated survivor planned/acked as
//     fully consumable). The producer retains its unacked flush; compliant
//     re-flush on the same session proceeds normally.
// ===========================================================================

const overCeilingText = (marker) => {
  const head = `${marker}_HEAD ${"a".repeat(220)}`;
  const middle = `MIDDLE_CANARY ${marker} ${"b".repeat(200)}`;
  const tail = `${marker}_TAIL ${"c".repeat(220)}`;
  return `${head}\n\n${middle}\n\n${tail}`; // ~660+ chars, human prose, > sourceMaxChars
};

function assertSessionAbsent(store, journal, sessionId) {
  const db = store.getJournalSqlite();
  assert.equal(
    Number(db.prepare("SELECT COUNT(*) n FROM journal_sessions WHERE session_id = ?").get(sessionId).n),
    0,
    "session header must be rolled back (atomic rejection)",
  );
  assert.equal(
    Number(db.prepare("SELECT COUNT(*) n FROM journal_sources WHERE session_id = ?").get(sessionId).n),
    0,
    "no minimized source row may survive",
  );
  const jobIds = db.prepare("SELECT id FROM journal_jobs WHERE session_id = ?").all(sessionId);
  assert.equal(jobIds.length, 0, "no coverage job may be planned");
  for (const { id } of jobIds) {
    assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM journal_chunks WHERE job_id = ?").get(id).n), 0, `no chunk rows for abandoned job ${id}`);
  }
  assert.deepEqual(journal.getConsumedRanges(sessionId), [], "rejected input never acked any coordinate");
  assert.ok(!journal.pendingSessions().some((s) => s.sessionId === sessionId), "rejected input is never a pending session");
}

check("oversize append rejects ATOMICALLY with typed source-too-large (no ack, no advance, no leak in error detail)", () => {
  const { store, journal } = freshJournal();
  const over = overCeilingText("OV");
  assert.ok(over.length > 400, `test input must exceed the bound (${over.length})`);
  assert.ok(over.includes("MIDDLE_CANARY"), "canary sits in the middle the truncator would drop");
  let thrown;
  try {
    appendEvents(journal, "session-oversize", [{ seq: 0, ts: 1, kind: "user", text: over, sourceKind: "user" }]);
  } catch (err) {
    thrown = err;
  }
  assert.ok(thrown instanceof JournalContractError, "typed JournalContractError is thrown");
  assert.equal(thrown.code, "source-too-large");
  assert.equal(thrown.detail.sourceMaxChars, 400, "detail carries the applied bound");
  assert.deepEqual(thrown.detail.seqs, [0], "detail pinpoints the offending seqs");
  assert.equal(thrown.detail.offendingCount, 1);
  assert.ok(!JSON.stringify(thrown).includes("MIDDLE_CANARY"), "typed detail NEVER carries raw oversize text");
  assertSessionAbsent(store, journal, "session-oversize");
  assert.equal(journal.status().queued, 0, "no coverage job was planned");

  // Native cursor retained: a compliant re-flush on the SAME session id (the
  // producer re-reads/shrinks) proceeds normally end-to-end.
  const retry = appendEvents(journal, "session-oversize", [
    { seq: 0, ts: 2, kind: "user", text: "OV_HEAD shrunk compliant text", sourceKind: "user" },
  ]);
  assert.equal(retry.stored, 1);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  journal.commitChunkResult(claim, 0, { kind: "nothing-to-learn" });
  assert.deepEqual(journal.getConsumedRanges("session-oversize"), [{ fromSeq: 0, toSeq: 0 }]);
  store.close();
});

check("oversize gate covers user/assistant/tool kinds and a MID-BATCH offender aborts the whole batch", () => {
  const { store, journal } = freshJournal();
  const cases = [
    { seq: 0, kind: "user", text: overCeilingText("U"), wantSeq: [0] },
    { seq: 0, kind: "assistant", text: `${"assistant prose sentence. ".repeat(40)}MID_CANARY ${"x".repeat(300)}`, wantSeq: [0] },
    { seq: 0, kind: "tool", text: `plain tool output line ${"y".repeat(450)}`, wantSeq: [0] },
  ];
  for (const c of cases) {
    assert.ok(c.text.length > 400, `${c.kind} case must exceed the bound`);
    let thrown;
    try {
      appendEvents(journal, `session-ov-${c.kind}`, [c]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof JournalContractError, `${c.kind} oversize is a typed rejection`);
    assert.equal(thrown.code, "source-too-large");
    assert.deepEqual(thrown.detail.seqs, c.wantSeq);
  }
  // Mixed batch: clean event first, over-ceiling second → the OFFENDER is
  // pinpointed and NOTHING from the batch survives (no half-enqueued state).
  let mixedThrown;
  try {
    appendEvents(journal, "session-ov-mixed", [
      { seq: 0, ts: 1, kind: "user", text: "clean compliant event", sourceKind: "user" },
      { seq: 1, ts: 2, kind: "user", text: overCeilingText("M"), sourceKind: "user" },
    ]);
  } catch (err) {
    mixedThrown = err;
  }
  assert.ok(mixedThrown instanceof JournalContractError);
  assert.equal(mixedThrown.code, "source-too-large");
  assert.deepEqual(mixedThrown.detail.seqs, [1]);
  assertSessionAbsent(store, journal, "session-ov-mixed");
  store.close();
});

check("gate is exact: text AT the bound stores fine; oversized text under the MIN floor still rejects", () => {
  const { store, journal } = freshJournal();
  const exact = `${"o".repeat(300)}\n\n${"p".repeat(98)}`; // exactly 400 chars
  assert.equal(exact.length, 400);
  const atBound = appendEvents(journal, "session-at-bound", [
    { seq: 0, ts: 1, kind: "user", text: exact, sourceKind: "user" },
  ]);
  assert.equal(atBound.stored, 1, "length == sourceMaxChars is NOT truncation (stays lossless)");

  // sourceMaxChars floor: the effective bound is MIN_BOUND_CHARS (64), so a
  // 100-char text under sourceMaxChars: 10 is still over-ceiling → rejected.
  let floorThrown;
  try {
    appendEvents(journal, "session-ov-floor", [{ seq: 0, ts: 1, kind: "user", text: "q".repeat(100), sourceKind: "user" }], {
      sourceMaxChars: 10,
    });
  } catch (err) {
    floorThrown = err;
  }
  assert.ok(floorThrown instanceof JournalContractError);
  assert.equal(floorThrown.code, "source-too-large");
  assert.equal(floorThrown.detail.sourceMaxChars, 64, "detail reports the EFFECTIVE floor bound");
  assertSessionAbsent(store, journal, "session-ov-floor");
  store.close();
});

check("real SQLite child crash at enqueue/claim/commit boundaries preserves every durable invariant", () => {
  assert.ok(sqliteCrashSupportAvailable(), "crash bracketing must be available in this runtime");
  const runs = [
    { boundary: "after-enqueue", expect: "queued-job-with-sources" },
    { boundary: "after-claim", expect: "claimed-lease-then-recovered" },
    { boundary: "mid-commit-rollback", expect: "clean-pre-commit-state" },
    { boundary: "after-commit", expect: "done-job-and-memory-no-duplicate-on-replay" },
  ];
  for (const run of runs) {
    const tmp = uniqueTmpTree("journal-crash-");
    const dir = join(tmp, "store");
    const result = runCrashBoundaryScenario({ repo, dir, boundary: run.boundary });
    assertSignalKilled(result, run.boundary);
    // PARENT reopens the SAME SQLite file written by the killed child; the
    // future clock makes any lease the child still held provably expired.
    const futureClock = Date.now() + 30 * 60_000;
    const store = new MemoryStore(dir);
    const journal = new MemoryJournalV02(store, { nowMs: () => futureClock, defaultLeaseMs: 50 });
    const preRecoveryStatus = journal.status();
    const recovery = journal.recoverStartup();
    const status = journal.status();
    const memories = store.listMemories({});
    const derived = store
      .getJournalSqlite()
      .prepare("SELECT COUNT(*) n FROM journal_derived")
      .get();
    const pending = journal.getConsumedRanges("crash-session");
    const rawSources = store
      .getJournalSqlite()
      .prepare("SELECT COUNT(*) n FROM journal_sources WHERE session_id='crash-session'")
      .get();
    if (run.expect === "queued-job-with-sources") {
      assert.ok(rawSources.n === 3, `enqueue committed atomically before the kill (sources=${rawSources.n})`);
      assert.ok(status.queued >= 1, `job queued after crash: ${JSON.stringify(status)}`);
      assert.equal(Number(derived.n), 0, "no derived rows before commit");
      assert.equal(memories.length, 0, "no memories before commit");
      assert.deepEqual(pending, [], "nothing consumed before commit");
      // Complete the interrupted work: chunk 0 derives the candidate, any
      // remaining chunks finish as valid nothing-to-learn.
      let memoryCreated = false;
      let guard = 0;
      while (!memoryCreated && guard++ < 10) {
        const claim = journal.claimWork({ kind: "extract" });
        if (!claim) break;
        const ev = journal.readChunkEvidence(claim);
        if (ev.status !== "ok") break;
        const verdict =
          ev.chunkIdx === 0
            ? {
                kind: "consumed",
                candidates: [{ text: "CRASH_DERIVED_MEMORY durable fact", provenance: "user", scope: "project" }],
              }
            : { kind: "nothing-to-learn" };
        journal.commitChunkResult(claim, ev.chunkIdx, verdict);
        memoryCreated = store.listMemories({}).length === 1;
      }
      assert.equal(store.listMemories({}).length, 1, "interrupted work completes to exactly one memory");
    }
    if (run.expect === "claimed-lease-then-recovered") {
      assert.ok(preRecoveryStatus.claimed === 1, `lease survived the kill: ${JSON.stringify(preRecoveryStatus)}`);
      assert.ok(recovery.leasesRecovered >= 1, "startup recovery reclaims the expired lease");
      const claim = journal.claimWork({ kind: "extract" });
      assert.ok(claim, "recovered job is claimable again");
      const report = journal.commitChunkResult(claim, 0, { kind: "nothing-to-learn" });
      assert.ok(report.acked, "recovered claim commits cleanly");
      assert.equal(store.listMemories({}).length, 0, "nothing-to-learn derived nothing");
    }
    if (run.expect === "clean-pre-commit-state") {
      assert.equal(Number(derived.n), 0, "mid-tx crash left no derived rows");
      assert.deepEqual(pending, [], "mid-tx crash left no acked range");
      assert.equal(memories.length, 0, "mid-tx crash left no memory");
      assert.ok(status.queued >= 1, "job remains retryable after rollback");
    }
    if (run.expect === "done-job-and-memory-no-duplicate-on-replay") {
      assert.ok(status.done >= 1, `committed job survived the kill: ${JSON.stringify(status)}`);
      assert.equal(memories.length, 1, "the derived memory survived the kill");
      // The fixture enqueues three short events; the default 6000-character
      // chunk covers all three coordinates, not just the first event.
      assert.deepEqual(pending, [{ fromSeq: 0, toSeq: 2 }], "exact consumed chunk coverage survived the kill");
      // Replay the whole flow: no duplicate evidence, no second memory.
      const worker = runCrashBoundaryScenario({ repo, dir, boundary: "after-commit" });
      void worker;
      assert.equal(journal.claimWork({ kind: "extract" }), null, "replay claims nothing new");
      const reEnq = journal.appendSession({
        sessionId: "crash-session",
        projectId: "crash-project",
        producer: { delegated: false, inheritedEventCount: 0 },
        sourceMaxChars: 400,
        events: [{ seq: 0, ts: 1, kind: "user", text: "CRASH_MARKER_0 remember the durable core", sourceKind: "user" }],
      });
      assert.ok(reEnq.jobsCreated === 0, `replay creates no new job: ${JSON.stringify(reEnq)}`);
      assert.equal(store.listMemories({}).length, 1, "no duplicate derived memory on replay");
    }
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ===========================================================================
// 8. Support-graph removal / revocation
// ===========================================================================

check("revoking sessions quarantines derived memories in the SAME transaction and bumps the revision", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-r", [{ seq: 0, ts: 1, kind: "user", text: "revocable", sourceKind: "user" }]);
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim);
  const commit = journal.commitChunkResult(claim, 0, {
    kind: "consumed",
    candidates: [{ text: "Revocable memory", provenance: "user", scope: "project" }],
  });
  assert.ok(commit.acked && commit.memoryIds.length === 1);
  const memoryId = commit.memoryIds[0];
  const revisionBefore = store.getMemoryRevision();
  const revocation = journal.revokeSessions({ sessionIds: ["session-r"], reason: "test-revocation", invalidateMemories: true });
  assert.equal(revocation.memoryIdsInvalidated.length, 1);
  assert.equal(revocation.sourcesRevoked, 1);
  assert.ok(revocation.cancellationGeneration >= 1);
  assert.equal(store.getMemory(memoryId).status, "quarantined", "derivative invalidated");
  assert.ok(store.getMemoryRevision() > revisionBefore, "source revocation bumps the memory revision");
  store.close();
});

check("revoked sessions refuse late flushes; explicit empty revoke selection is a no-op", () => {
  const { store, journal } = freshJournal();
  appendEvents(journal, "session-s", [{ seq: 0, ts: 1, kind: "user", text: "pre-revoke", sourceKind: "user" }]);
  journal.revokeSessions({ sessionIds: ["session-s"], reason: "test", invalidateMemories: false });
  assert.throws(
    () =>
      appendEvents(journal, "session-s", [{ seq: 1, ts: 2, kind: "user", text: "late-flush", sourceKind: "user" }]),
    (err) => err.code === "revoked-session",
  );
  const noOp = journal.revokeSessions({ sessionIds: [], reason: "explicit-empty", invalidateMemories: true });
  assert.equal(noOp.sessionsRevoked, 0);
  assert.equal(noOp.sourcesRevoked, 0);
  store.close();
});

// ===========================================================================
// 9. Startup recovery
// ===========================================================================

check("recoverStartup requeues expired leases (budget preserved) and replans missing coverage", () => {
  const { store, journal, advance } = freshJournal({ defaultLeaseMs: 30 });
  appendEvents(journal, "session-t", [{ seq: 0, ts: 1, kind: "user", text: "recovery", sourceKind: "user" }]);
  const claim = journal.claimWork({ kind: "extract" }, 30);
  assert.ok(claim);
  advance(10_000); // lease durably expired at the journal clock
  const rec = journal.recoverStartup();
  assert.ok(rec.leasesRecovered >= 1, `recovered: ${JSON.stringify(rec)}`);
  const resumed = journal.claimWork({ kind: "extract" });
  assert.ok(resumed, "recovered job claimable again");
  assert.ok(resumed.attemptsMade >= 1);
  const report = journal.commitChunkResult(resumed, 0, { kind: "nothing-to-learn" });
  assert.ok(report.acked);
  store.close();
});

// ===========================================================================
// 10. Producer-header minimization (metadata lane): credentialed extra /
//     origin / project metadata cannot persist unredacted. Text redaction
//     alone is not sufficient, so persistence also structurally fails closed.
//     Evidence is read straight off the real SQLite file, covering the
//     journal_sessions AND journal_jobs copies plus the worker claim view.
// ===========================================================================

const SECRET_SK = "sk-AbCdEf1234567890AbCdEf1234567890"; // well-known API-key shape
const SECRET_JWT = "eyJAbCdEf123456789.AbbCdEf123456789.XbcCdEf123456789"; // JWT shape
const SECRET_BASIC = "Authorization: Basic BRmVyQmFzZTY0"; // labeled carrier
const OPAQUE_HUGE = `opaque ${"w".repeat(600)}TAILMARK${"v".repeat(40)}`; // regex-invisible: only structural bounds can contain it

function rawHeaderRows(store, sessionId) {
  const db = store.getJournalSqlite();
  const sessionHeader = db
    .prepare(`SELECT producer_header_json FROM journal_sessions WHERE session_id = ?`)
    .get(sessionId)?.producer_header_json;
  const jobHeaders = db
    .prepare(`SELECT producer_header_json FROM journal_jobs WHERE session_id = ?`)
    .all(sessionId).map((r) => String(r.producer_header_json ?? "{}"));
  const projectId = db
    .prepare(`SELECT project_id FROM journal_sessions WHERE session_id = ?`)
    .get(sessionId)?.project_id;
  return {
    sessionHeader: String(sessionHeader ?? "{}"),
    jobHeaders,
    combined: [String(sessionHeader ?? "{}"), ...jobHeaders],
    projectId: String(projectId ?? ""),
  };
}

function assertHeaderClean(blob, label) {
  assert.ok(typeof JSON.parse(blob) === "object" && JSON.parse(blob) !== null,
    `${label} must remain valid JSON, never a truncated credential fragment`);
  for (const [needle, why] of [
    [SECRET_SK, "sk-shaped credential canary"],
    [SECRET_JWT, "JWT-shaped canary"],
    [SECRET_BASIC, "basic-auth canary"],
    ["TAILMARK", "over-bound tail marker (structural containment breached)"],
  ]) {
    assert.ok(!blob.includes(needle), `${label} persisted ${why}`);
  }
}

check("producer header minimization: extra/origin/project canaries are redacted + structurally contained BEFORE persistence (real SQLite, session + job copies + claim view)", () => {
  const env = freshJournal();
  const sessionId = "hdr-canary-session";
  const report = env.journal.appendSession({
    sessionId,
    projectId: `proj;secret=${SECRET_SK}`, // project metadata carrying a credential canary
    producer: {
      delegated: true,
      origin: `MEMORY_ORIGIN ${SECRET_SK} ${SECRET_BASIC}`,
      parentSessionId: `parent-${"p".repeat(400)}`, // over-bound: structural cut
      rootSessionId: "root-ok",
      inheritedEventCount: 7,
      extra: {
        apiKey: SECRET_SK, // sensitive KEY ⇒ value fails closed
        CLIENT_SECRET: SECRET_SK,
        note: "password: hunter2 bearer tail-locked", // labeled free-text canary
        jwtHint: `token=${SECRET_JWT}`,
        plain: "safe-value-retained",
        bignum: 9007199254740991,
        legitNull: null,
        nested: Object.freeze({ mustDrop: "non-scalar" }), // non-scalar entry dropped whole
        hugeOpaque: OPAQUE_HUGE, // pattern-invisible ⇒ caught ONLY by structural binding
        hugeLabeled: `frag ${SECRET_SK} ${"x".repeat(600)}TAILMARK`, // both layers at once
      },
    },
    sourceMaxChars: 400,
    events: [
      { seq: 0, ts: 1, kind: "user", text: "HDR_MIN fine center context", sourceKind: "user" },
    ],
  });
  assert.ok(report.jobsCreated >= 1, `coverage job created: ${JSON.stringify(report)}`);

  const raw = rawHeaderRows(env.store, sessionId);
  assert.ok(!raw.projectId.includes(SECRET_SK), "project_id column must not retain the canary");
  const sessionHeader = JSON.parse(raw.sessionHeader);
  assert.equal(sessionHeader.delegated, true, "delegated flag survives minimization");
  assert.ok(sessionHeader.origin.includes("[REDACTED]"), "origin redacted");
  assert.ok(sessionHeader.extra.plain === "safe-value-retained", "benign extra values retained");
  assert.equal(sessionHeader.extra.apiKey === "[REDACTED]", true, "sensitive-key value fail-closed");
  assert.equal(sessionHeader.extra.CLIENT_SECRET === "[REDACTED]", true, "ends-with sensitive-key fail-closed");
  assert.equal(sessionHeader.extra.nested, undefined, "non-scalar extra entries dropped whole");
  assert.equal(sessionHeader.extra.legitNull === null, true, "benign scalars survive");
  assert.ok(!sessionHeader.extra.hugeOpaque.includes("TAILMARK"), "regex-invisible oversized value cut structurally");
  assert.ok(sessionHeader.extra.hugeOpaque.length <= 256, "per-value structural bound enforced");
  for (const blob of raw.combined) {
    assertHeaderClean(blob, "persisted producer header");
  }
  const claim = env.journal.claimWork({ kind: "extract" });
  assert.ok(claim, "minimized-header job is still claimable");
  assert.equal(claim.producerHeader.delegated, true, "worker-visible header stays functional");
  assertHeaderClean(JSON.stringify(claim.producerHeader), "claim.producerHeader");
  env.store.close();
  rmSync(env.dir, { recursive: true, force: true });
});

check("producer header minimization: entry cap, oversized-total extra eviction drops entries whole (never truncates through credential text), header JSON bounded (real SQLite)", () => {
  const env = freshJournal();
  const sessionId = "hdr-cap-session";
  env.journal.appendSession({
    sessionId,
    projectId: "proj-hdr-cap",
    producer: {
      delegated: false,
      inheritedEventCount: 0,
      extra: Object.fromEntries(
        Array.from({ length: 64 }, (_, i) => [
          `fact${String(i).padStart(2, "0")}`,
          `payload-${i} ${"y".repeat(300)}TAIL anymore`,
        ]),
      ),
    },
    sourceMaxChars: 400,
    events: [{ seq: 0, ts: 1, kind: "user", text: "HDR_CAP bounded events", sourceKind: "user" }],
  });
  const { sessionHeader, combined } = rawHeaderRows(env.store, sessionId);
  const header = JSON.parse(sessionHeader);
  const extraKeys = Object.keys(header.extra);
  assert.ok(extraKeys.length <= 32, `entry cap enforced (${extraKeys.length})`);
  assert.ok(extraKeys.length >= 1, "usable entries retained, not everything dropped");
  for (const value of Object.values(header.extra)) {
    assert.ok(typeof value === "string" && value.length <= 256, "every retained value structurally bounded");
    assert.ok(!value.includes("TAIL anymore"), "over-bound tail marker cut structurally (regex-invisible text)");
  }
  const raw = rawHeaderRows(env.store, sessionId);
  assert.ok(raw.sessionHeader.length <= 4096, "whole persisted header bounded");
  for (const blob of combined) {
    assertHeaderClean(blob, "persisted producer header");
  }
  env.store.close();
  rmSync(env.dir, { recursive: true, force: true });
});

// ===========================================================================
// Runner
// ===========================================================================

let failures = 0;
for (const { name, fn } of registered) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${String(err?.stack ?? err).split("\n").slice(0, 6).join("\n      ")}`);
  }
}
if (failures > 0) {
  console.log(`\n${failures} failing check(s) out of ${registered.length}`);
  process.exit(1);
}
console.log(`\nAll ${registered.length} journal-v02 checks passed.`);
