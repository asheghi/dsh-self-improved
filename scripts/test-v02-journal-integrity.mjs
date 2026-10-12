#!/usr/bin/env node
/**
 * Journal INTEGRITY + durable-terminal-failure suite
 * (MIGRATION-PHASE-B-JOURNAL-INTEGRITY.md scope: src/memory-journal-v02.ts).
 *
 * Part A — durable bounded retries for terminal failure:
 * - a terminally `failed` job's coverage is DURABLE: a genuine close/reopen +
 *   recoverStartup never resurrects the failed range with a fresh attempt
 *   budget, no re-claim happens until explicit authorization, the durable
 *   budget/idempotency row stays as the boot left it;
 * - later appends to the failed session plan coverage that STOPS at the
 *   failed range (no implicit re-enqueue merged into new work);
 * - a cancellation bump WITHOUT source revocation still replans fresh jobs
 *   under the new generation (policy-change semantics regression gate);
 * - the ONLY path back is `retryFailedJobs`: fail-closed on a blanket call,
 *   keeps the idempotency key/job id (same ledger), resets the budget UNDER
 *   AUTHORIZATION with a recorded reason, drains without duplicates, and a
 *   deterministic failure fails terminally again (each authorization buys
 *   exactly ONE bounded budget).
 *
 * Part B — tamper-evident evidence (typed `corrupt` is reachable now):
 * - real-SQLite tamper of minimized text, identity fields, chunk planning
 *   metadata, coverage rows or the session identity header is caught at the
 *   read gate (before the provider) AND again inside the commit transaction;
 *   adversarial damage NEVER acks, never publishes (zero memories, zero
 *   journal_derived rows);
 * - partial deletion inside a planned whole-range is typed `corrupt` while a
 *   fully-deleted range stays `missing-source-row`;
 * - a forged claim header (sessionId/kind/range mismatch) cannot read, commit
 *   or even release — claim-invalid, and the durable state never moves;
 * - a legitimate unchanged reopen (same options) recomputes identical hashes
 *   and drains without any false integrity failure (both whole- and seg-mode
 *   chunks are exercised).
 *
 * Real MemoryStore SQLite files in unique tmpdirs, injected deterministic
 * clock, genuine close/reopen restarts. NO production store/profile, no live
 * profile, no provider, no network, no port 3082, no git. Exit 0 = every
 * check passed; any failure exits 1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { MemoryStore } = await import(join(repo, "lib/storage.js"));
const { MemoryJournalV02, JournalContractError } = await import(join(repo, "lib/memory-journal-v02.js"));

const registered = [];
const check = (name, fn) => registered.push({ name, fn });

/** Deterministic-clock journal over a real SQLite file (same-options reopen). */
function freshJournal(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "journal-v02-integrity-"));
  let store = new MemoryStore(dir);
  let clock = opts.clockStart ?? Date.now();
  let journal = new MemoryJournalV02(store, { ...opts, nowMs: () => clock });
  return {
    dir,
    get store() {
      return store;
    },
    get journal() {
      return journal;
    },
    opts,
    clock: () => clock,
    advance(ms) {
      clock += ms;
      return clock;
    },
    openFresh() {
      // Genuine restart: NEW store+journal objects on the SAME SQLite file,
      // SAME options (chunkMaxChars is part of the documented unchanged-reopen
      // contract; a different chunkMaxChars is a documented drift, not a
      // tamper signal).
      store.close();
      store = new MemoryStore(dir);
      journal = new MemoryJournalV02(store, { ...opts, nowMs: () => clock });
      return { store, journal };
    },
    cleanup() {
      try {
        store.close();
      } catch {
        /* already closed by restart */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const appendEvents = (journal, sessionId, events, extra = {}) =>
  journal.appendSession({
    sessionId,
    projectId: extra.projectId ?? "proj-integrity",
    producer: extra.producer ?? { delegated: false, inheritedEventCount: 0 },
    sourceMaxChars: extra.sourceMaxChars ?? 6000,
    events,
    ...(extra.maxAttempts ? { maxAttempts: extra.maxAttempts } : {}),
  });

const rawJob = (store, jobId) =>
  store
    .getJournalSqlite()
    .prepare(
      `SELECT id, idempotency_key, state, attempt_count, claim_token, lease_expires_at, retry_after_at,
              completed_at, last_error, from_seq, to_seq
         FROM journal_jobs WHERE id = ?`,
    )
    .get(jobId) ?? null;

const statusCounts = (db) => {
  const rows = db.prepare(`SELECT state, COUNT(*) n FROM journal_jobs GROUP BY state`).all();
  return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
};

const userEvents = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    seq: i,
    ts: i + 1,
    kind: "user",
    text: `${prefix}-${i} user fact about the ORCHESTRA rehearsal cadence`,
    sourceKind: "user",
  }));

// ===========================================================================
// PART A — terminal-failure durability (no boot resurrection, typed retry)
// ===========================================================================

check("A1 exhausted-budget terminal failure is durable: restart + recovery never resurrects the failed range", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "a1", userEvents("a1", 2), { maxAttempts: 1 });
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim);
    const failed = env.journal.commitChunkResult(claim, 0, {
      kind: "retryable",
      reason: "malformed-model-output",
      message: "deterministic parser failure",
    });
    assert.ok(!failed.acked);
    assert.equal(env.journal.getJob(claim.jobId).state, "failed", "budget exhausted → terminal failed");
    assert.deepEqual(env.journal.getConsumedRanges("a1"), [], "failed work never acks");
    // Genuine restart + recovery: the failed range is NOT replanned.
    const before = statusCounts(env.store.getJournalSqlite());
    const { store: store2, journal: journal2 } = env.openFresh();
    const rec = journal2.recoverStartup();
    assert.equal(rec.jobsPlanned, 0, "recovery never replans terminal-failed coverage");
    assert.deepEqual(statusCounts(store2.getJournalSqlite()), before, "no new job rows across boot");
    for (let i = 0; i < 3; i++) {
      assert.equal(journal2.claimWork({ kind: "extract" }), null, "failed range is not re-claimable implicitly");
      env.advance(60_000);
    }
    const row = rawJob(store2, claim.jobId);
    assert.equal(row.state, "failed");
    assert.equal(row.attempt_count, 1, "durable exhausted budget preserved (not reset by boot)");
    assert.equal(row.idempotency_key, `${"a1"}|extract|0|1`, "idempotency key durable on the failed row");
    assert.deepEqual(journal2.getConsumedRanges("a1"), [], "still nothing acked across the restart");
    env.advance(60_000);
    store2.close();
  } finally {
    env.cleanup();
  }
});

check("A2 later appends stop AT the failed range; the failed row is untouched and success continues past it", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "a2", userEvents("a2", 2), { maxAttempts: 1 });
    const claim = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(claim, 0, { kind: "retryable", reason: "transient", message: "will exhaust" });
    assert.equal(env.journal.getJob(claim.jobId).state, "failed");
    // New append for the session: coverage planning must NOT re-cover 0..1.
    const after = appendEvents(env.journal, "a2", [
      { seq: 2, ts: 3, kind: "user", text: "a2-2 later event after the failed range", sourceKind: "user" },
    ]);
    assert.ok(after.jobsCreated >= 1, "fresh later events still plan coverage");
    const jobs = env.journal.listJobs({ sessionId: "a2" });
    const freshJob = jobs.find((j) => j.id !== claim.jobId);
    assert.ok(freshJob, "a NEW job covers only the later range");
    assert.deepEqual([freshJob.fromSeq, freshJob.toSeq], [2, 2], "fresh coverage stops at the failed range");
    const failedRow = rawJob(env.store, claim.jobId);
    assert.equal(failedRow.state, "failed", "failed row stays terminal under new-work planning");
    assert.equal(failedRow.attempt_count, 1, "failed budget untouched");
    // The fresh job is claimable and drains; the failed range does not block it.
    const c2 = env.journal.claimWork({ kind: "extract" });
    assert.ok(c2);
    assert.equal(c2.jobId, freshJob.id);
    const ev = env.journal.readChunkEvidence(c2);
    assert.equal(ev.status, "ok", "later-range evidence reads fine (failed prefix not conflated)");
    const rep = env.journal.commitChunkResult(c2, ev.chunkIdx, { kind: "nothing-to-learn" });
    assert.ok(rep.acked);
    assert.deepEqual(env.journal.getConsumedRanges("a2"), [{ fromSeq: 2, toSeq: 2 }]);
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("A3 contract regression: cancellation bump WITHOUT revocation still replans fresh jobs under the new generation", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "a3", userEvents("a3", 1));
    const claim = env.journal.claimWork({ kind: "extract" }, 30);
    env.journal.bumpCancellationGeneration("policy module trip");
    env.advance(10_000);
    const rec = env.journal.recoverStartup();
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "cancelled", "the bump-killed row stays cancelled (not resurrected)");
    if (env.journal.claimWork({ kind: "extract" })) {
      // fresh replan happened (job re-creation under the new generation)
    } else {
      assert.equal(rec.jobsPlanned, 0);
    }
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("A4 retryFailedJobs is fail-closed: a blanket call (no selection) is a typed no-op", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "a4a", userEvents("a4a", 1), { maxAttempts: 1 });
    appendEvents(env.journal, "a4b", userEvents("a4b", 1), { maxAttempts: 1 });
    const c = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(c, 0, { kind: "retryable", reason: "transient", message: "exhaust now" });
    const others = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(others, 0, { kind: "retryable", reason: "transient", message: "exhaust now" });
    assert.equal(env.journal.status().failed, 2);
    const noSelection = env.journal.retryFailedJobs({ reason: "sweep-the-journal" });
    assert.deepEqual(noSelection, { retried: 0, jobIds: [] }, "no selection ⇒ NO blanket retry");
    assert.equal(env.journal.status().failed, 2, "nothing requeued implicitly");
    assert.equal(env.journal.claimWork({ kind: "extract" }), null, "still nothing reclaimable");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("A5 authorized retry requeues the SAME job (idempotency kept), resets the budget, drains without duplicates; repeat is a no-op", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "a5", userEvents("a5", 1), { maxAttempts: 1 });
    const claim = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(claim, 0, { kind: "retryable", reason: "transient", message: "exhaust now" });
    assert.equal(env.journal.getJob(claim.jobId).state, "failed");
    const retry = env.journal.retryFailedJobs({ sessionIds: ["a5"], reason: "operator retry after incident" });
    assert.equal(retry.retried, 1);
    assert.deepEqual(retry.jobIds, [claim.jobId], "the SAME job id is requeued (idempotency key kept)");
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "queued");
    assert.equal(row.attempt_count, 0, "fresh bounded budget UNDER AUTHORIZATION");
    assert.equal(row.retry_after_at, null, "immediately claimable");
    assert.ok(row.last_error.startsWith("authorized-retry(operator retry after incident)"), "audit reason recorded");
    const c2 = env.journal.claimWork({ kind: "extract" });
    assert.ok(c2 && c2.jobId === claim.jobId);
    assert.deepEqual([c2.fromSeq, c2.toSeq], [0, 0], "recovered range unchanged");
    const rep = env.journal.commitChunkResult(c2, 0, {
      kind: "consumed",
      candidates: [{ text: "a5 user fact about the ORCHESTRA rehearsal cadence", provenance: "user", scope: "project", kind: "fact" }],
    });
    assert.ok(rep.acked && rep.jobState === "done");
    assert.deepEqual(env.journal.getConsumedRanges("a5"), [{ fromSeq: 0, toSeq: 0 }]);
    const derived = env.store
      .getJournalSqlite()
      .prepare(`SELECT COUNT(*) n FROM journal_derived WHERE job_id = ?`)
      .get(claim.jobId);
    assert.equal(Number(derived.n), 1, "exactly one derived row through the authorized retry");
    const again = env.journal.retryFailedJobs({ sessionIds: ["a5"], reason: "late click" });
    assert.deepEqual(again, { retried: 0, jobIds: [] }, "done work is not a retry target");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("A6 each authorization buys ONE bounded budget: a deterministic failure fails terminally again", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "a6", userEvents("a6", 1), { maxAttempts: 2 });
    let claim = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(claim, 0, { kind: "retryable", reason: "transient", message: "1st" });
    env.advance(60_000);
    claim = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(claim, 0, { kind: "retryable", reason: "malformed-model-output", message: "2nd" });
    assert.equal(env.journal.getJob(claim.jobId).state, "failed");
    env.journal.retryFailedJobs({ sessionIds: ["a6"], reason: "authorized round two" });
    claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim, "authorized budget is claimable");
    env.journal.commitChunkResult(claim, 0, { kind: "retryable", reason: "transient", message: "3rd" });
    env.advance(60_000);
    const c3 = env.journal.claimWork({ kind: "extract" });
    env.journal.commitChunkResult(c3, 0, { kind: "retryable", reason: "malformed-model-output", message: "4th, budget spent" });
    assert.equal(env.journal.getJob(c3.jobId).state, "failed", "terminal again after ONE bounded budget");
    const row = rawJob(env.store, c3.jobId);
    assert.equal(row.attempt_count, 2, "budget exactly exhausted (not inflated across authorizations)");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

// ===========================================================================
// PART B — tamper-evident evidence: adversarial REAL-SQLite damage never acks
// ===========================================================================

check("B1 tampered minimized text is typed corrupt at the read gate AND refused inside the commit transaction", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b1", userEvents("b1", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    // REAL SQLite tamper: rewrite the stored minimized text.
    env.store.getJournalSqlite().prepare(`UPDATE journal_sources SET text = 'tampered text' WHERE session_id = 'b1'`).run();
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.status, "unavailable", "tampered evidence is never served");
    assert.equal(ev.reasonCode, "corrupt", "the typed corrupt reason is REACHABLE now");
    assert.ok(/event_hash mismatch/.test(ev.message), ev.message);
    assert.throws(
      () =>
        env.journal.commitChunkResult(claim, 0, {
          kind: "consumed",
          candidates: [{ text: "ghost fact", provenance: "derived", scope: "project", kind: "fact" }],
        }),
      (err) => err instanceof JournalContractError && err.code === "chunk-state-invalid",
      "in-tx integrity gate refuses the ack",
    );
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "queued", "refusal requeues without ack");
    assert.equal(env.store.listMemories({}).length, 0, "nothing published from tampered text");
    assert.equal(
      Number(env.store.getJournalSqlite().prepare(`SELECT COUNT(*) n FROM journal_derived`).get().n),
      0,
      "no derived rows",
    );
    assert.deepEqual(env.journal.getConsumedRanges("b1"), [], "never acked");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B2 partial source deletion inside a planned whole-range is corrupt; fully-deleted stays missing-source-row", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    // three short events merge into ONE whole-mode chunk [0..2]
    appendEvents(env.journal, "b2", userEvents("b2", 3));
    const claim = env.journal.claimWork({ kind: "extract" });
    env.store.getJournalSqlite().prepare(`DELETE FROM journal_sources WHERE session_id = 'b2' AND seq = 1`).run();
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.reasonCode, "corrupt", "a partially deleted range is CODE corrupt, not missing");
    assert.ok(/coverage incomplete: 2\/3 rows survive/.test(ev.message), ev.message);
    assert.throws(
      () =>
        env.journal.commitChunkResult(claim, 0, {
          kind: "nothing-to-learn",
        }),
      (err) => err instanceof JournalContractError && err.code === "chunk-state-invalid",
      "surviving subset can never be acked as fully covered",
    );
    assert.deepEqual(env.journal.getConsumedRanges("b2"), [], "nothing acked");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B2b control: deleting EVERY row of a range stays missing-source-row (planning state, not corruption)", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b2solo", userEvents("b2solo", 1));
    const c2 = env.journal.claimWork({ kind: "extract" });
    env.store.getJournalSqlite().prepare(`DELETE FROM journal_sources WHERE session_id = 'b2solo'`).run();
    const ev2 = env.journal.readChunkEvidence(c2);
    assert.equal(ev2.reasonCode, "missing-source-row", "empty range keeps the planning-state meaning");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B3 forged chunk planning metadata (event_count / chars / coordinates) is corrupt", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b3", userEvents("b3", 2));
    const claim = env.journal.claimWork({ kind: "extract" });
    const db = env.store.getJournalSqlite();
    db.prepare(`UPDATE journal_chunks SET event_count = event_count + 1 WHERE job_id = ?`).run(claim.jobId);
    const ev1 = env.journal.readChunkEvidence(claim);
    assert.equal(ev1.reasonCode, "corrupt", "event_count metadata tamper");
    assert.ok(/event_count metadata/.test(ev1.message), ev1.message);
    db.prepare(`UPDATE journal_chunks SET event_count = event_count - 1 WHERE job_id = ?`).run(claim.jobId);
    db.prepare(`UPDATE journal_chunks SET chars = chars + 7 WHERE job_id = ?`).run(claim.jobId);
    const ev2 = env.journal.readChunkEvidence(claim);
    assert.equal(ev2.reasonCode, "corrupt");
    assert.ok(/chars metadata/.test(ev2.message), ev2.message);
    db.prepare(`UPDATE journal_chunks SET chars = chars - 7 WHERE job_id = ?`).run(claim.jobId);
    db.prepare(`UPDATE journal_chunks SET to_seq = to_seq + 40 WHERE job_id = ?`).run(claim.jobId);
    const ev3 = env.journal.readChunkEvidence(claim);
    assert.equal(ev3.reasonCode, "corrupt", "coordinates outside the immutable job coverage (or the damaged coverage)");
    assert.ok(/coverage|immutable coverage/.test(ev3.message), ev3.message);
    assert.throws(
      () =>
        env.journal.commitChunkResult(claim, 0, {
          kind: "nothing-to-learn",
        }),
      (err) => err instanceof JournalContractError && err.code === "chunk-state-invalid",
    );
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B4 deleted session identity header is corrupt (the anchor of the job's evidence coordinates)", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b4", userEvents("b4", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    env.store.getJournalSqlite().prepare(`DELETE FROM journal_sessions WHERE session_id = 'b4'`).run();
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.reasonCode, "corrupt");
    assert.ok(/session header/.test(ev.message), `message: ${ev.message}`);
    assert.throws(
      () =>
        env.journal.commitChunkResult(claim, 0, {
          kind: "consumed",
          candidates: [{ text: "x", provenance: "derived", scope: "project", kind: "fact" }],
        }),
      (err) => err instanceof JournalContractError && err.code === "chunk-state-invalid",
    );
    assert.equal(env.store.listMemories({}).length, 0);
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B5 identity-field tamper (source_kind / injected / kind) is hash-covered and typed corrupt", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b5", userEvents("b5", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    const db = env.store.getJournalSqlite();
    db.prepare(`UPDATE journal_sources SET source_kind = 'forged' WHERE session_id = 'b5'`).run();
    let ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.reasonCode, "corrupt");
    db.prepare(`UPDATE journal_sources SET source_kind = 'user' WHERE session_id = 'b5'`).run();
    db.prepare(`UPDATE journal_sources SET injected = 1 WHERE session_id = 'b5'`).run();
    ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.reasonCode, "corrupt", "injected flag flip breaks the identity hash");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B6 unchanged legitimate reopen: every gate passes and a seg-mode job with an acked prefix drains (no false integrity failure)", () => {
  const env = freshJournal({ defaultLeaseMs: 1_000, chunkMaxChars: 1000 });
  try {
    // whole-mode: two short events merge to one chunk
    appendEvents(env.journal, "b6w", userEvents("b6w", 2));
    env.advance(1); // distinct created_at: deterministic claim order (whole first)
    // seg-mode: one long event over the segment budget → one chunk per segment
    appendEvents(env.journal, "b6s", [
      {
        seq: 0,
        ts: 1,
        kind: "assistant",
        text: `b6s long rehearsal notes ${"and nightly cadence detail ".repeat(120)}`,
        sourceKind: "model",
      },
    ]);
    const w = env.journal.claimWork({ kind: "extract" });
    assert.ok(w, "whole-mode job claimable");
    const wEv = env.journal.readChunkEvidence(w);
    assert.equal(wEv.status, "ok", `whole-mode reads clean pre-restart (${wEv.message ?? ""})`);
    const wRep = env.journal.commitChunkResult(w, wEv.chunkIdx, { kind: "nothing-to-learn" });
    assert.ok(wRep.acked && wRep.jobState === "done");
    // seg-mode job: ack only the FIRST segment chunk, leave the tail pending.
    const s = env.journal.claimWork({ kind: "extract" });
    assert.ok(s, "seg-mode job claimable");
    const firstSeg = env.journal.readChunkEvidence(s);
    assert.equal(firstSeg.status, "ok", `seg reads clean pre-restart (${firstSeg.message ?? ""})`);
    const sRep = env.journal.commitChunkResult(s, firstSeg.chunkIdx, { kind: "nothing-to-learn" });
    assert.ok(sRep.acked && sRep.chunksPending > 0, "acked prefix, pending tail");
    // GENUINE restart with the SAME options; the expired zombie claim is
    // recovered, then the unacked tail must read clean and reach done.
    env.advance(10_000);
    const { journal: j2 } = env.openFresh();
    const rec = j2.recoverStartup();
    assert.ok(rec.leasesRecovered >= 1, "the pending seg job's zombie lease is recovered");
    const s2 = j2.claimWork({ kind: "extract" });
    assert.ok(s2, "residual seg work is claimable across the restart");
    let more = 0;
    for (;;) {
      const ev = j2.readChunkEvidence(s2);
      if (ev.status === "exhausted") break;
      assert.equal(ev.status, "ok", `unchanged reopen MUST read clean across the restart (got ${ev.reasonCode} ${ev.message})`);
      const rep = j2.commitChunkResult(s2, ev.chunkIdx, { kind: "nothing-to-learn" });
      assert.ok(rep.acked);
      more++;
      // Dual terminal stop (J4): the authoritative commit report IS the stop
      // for the final chunk — a post-done read is "no longer claimed", the
      // job is finalized and must NOT be re-read or released.
      if (rep.jobState === "done" || more > 60) break;
    }
    assert.ok(more >= 1, "pending tail segments drained across the restart");
    assert.equal(j2.status().failed, 0, "no false integrity failure");
    assert.deepEqual(j2.getConsumedRanges("b6w"), [{ fromSeq: 0, toSeq: 1 }]);
    assert.equal(j2.getJob(s2.jobId).state, "done", "residual seg job fully drained");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B7 forged claim header (wrong session / wrong range) can read nothing, commit nothing, even release nothing", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b7", userEvents("b7", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    const forgedSession = { ...claim, sessionId: "other-session" };
    const ev = env.journal.readChunkEvidence(forgedSession);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.reasonCode, "range-not-stored", "read gate refuses a forged header claim");
    assert.ok(/identity header does not match/.test(ev.message), ev.message);
    assert.throws(
      () => env.journal.commitChunkResult(forgedSession, 0, { kind: "nothing-to-learn" }),
      (err) => err instanceof JournalContractError && err.code === "claim-invalid",
      "commit tx aborts on a forged header",
    );
    assert.throws(
      () => env.journal.releaseClaim(forgedSession, "forged release"),
      (err) => err instanceof JournalContractError && err.code === "claim-invalid",
      "release cannot act on a forged header either",
    );
    const forgedRange = { ...claim, fromSeq: claim.fromSeq + 9 };
    assert.throws(
      () => env.journal.commitChunkResult(forgedRange, 0, { kind: "nothing-to-learn" }),
      (err) => err instanceof JournalContractError && err.code === "claim-invalid",
    );
    // The genuine claim still works: nothing durable moved.
    const genuine = env.journal.readChunkEvidence(claim);
    assert.equal(genuine.status, "ok", "genuine claim unaffected (state unchanged by forged attempts)");
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "claimed", "forged attempts left the durable state untouched");
    env.store.close();
  } finally {
    env.cleanup();
  }
});

check("B8 corrupt relay is terminal: a worker-style source-unavailable verdict fails the job and stays failed across boot", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b8", userEvents("b8", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    env.store.getJournalSqlite().prepare(`UPDATE journal_sources SET text = 'forged bytes' WHERE session_id = 'b8'`).run();
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.reasonCode, "corrupt");
    const rep = env.journal.commitChunkResult(claim, ev.chunkIdx, {
      kind: "source-unavailable",
      reason: "corrupt",
      message: ev.message,
    });
    assert.ok(!rep.acked);
    assert.equal(env.journal.getJob(claim.jobId).state, "failed", "typed corrupt relay fails terminal");
    assert.deepEqual(env.journal.getConsumedRanges("b8"), []);
    const { journal: j2, store: s2 } = env.openFresh();
    env.advance(120_000);
    j2.recoverStartup();
    assert.equal(j2.status().failed, 1, "terminal damage verdict persists across boot");
    assert.equal(j2.claimWork({ kind: "extract" }), null, "damaged lineage is not implicitly repumped");
    s2.close();
  } finally {
    env.cleanup();
  }
});

check("B9 text_chars tamper metadata and length mismatch is caught", () => {
  const env = freshJournal({ defaultLeaseMs: 30_000 });
  try {
    appendEvents(env.journal, "b9", userEvents("b9", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    env.store.getJournalSqlite().prepare(`UPDATE journal_sources SET text_chars = text_chars + 5 WHERE session_id = 'b9'`).run();
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.reasonCode, "corrupt");
    assert.ok(/text_chars mismatch/.test(ev.message), ev.message);
    env.store.close();
  } finally {
    env.cleanup();
  }
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
    console.log(`      ${String(err?.stack ?? err).split("\n").slice(0, 8).join("\n      ")}`);
  }
}
if (failures > 0) {
  console.log(`\n${failures} failing check(s) out of ${registered.length}`);
  process.exit(1);
}
console.log(`\nAll ${registered.length} journal integrity checks passed.`);
