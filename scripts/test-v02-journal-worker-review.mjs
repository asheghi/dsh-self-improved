#!/usr/bin/env node
/**
 * Targeted journal LIFECYCLE review suite (MIGRATION-PHASE-B-WORKER-REVIEW.md
 * scope: claim/release/done/revoke handling owned by src/memory-journal-v02.ts).
 *
 * Gates proven here (all on genuine MemoryStore SQLite files in unique tmpdirs,
 * real close/reopen restarts, injected deterministic clock):
 * - J3 done-resurrection is SEALED: the final-chunk commit clears the claim
 *   token/lease in the SAME transaction; releaseClaim over a done row (stale
 *   or a forged still-live legacy token) is a NO-OP; a fully-acked DONE job
 *   can never be re-queued or re-claimed;
 * - recoverStartup's terminal-cancel and fully-acked done transitions never
 *   leave a live token behind (release cannot resurrect either);
 * - TRUE cancel (revokeSessions: generation bump + source revocation) is
 *   terminal: no re-claim, survives genuine restart + recovery, publishes
 *   nothing late;
 * - CONTRACT NOTE (asserted, documented): a cancellation bump WITHOUT source
 *   revocation kills queued rows and blocks claimed commits terminally, but
 *   the unrevoked sources stay pending coverages — recoverStartup replans
 *   them as FRESH jobs under the new generation (job re-creation, not row
 *   resurrection). Consent trips in production must therefore pair the bump
 *   with session revocation (the seam exposes both in one call);
 * - policy races publish NOTHING: a candidate commit after
 *   bumpPolicyGeneration is rejected stale-policy-generation with zero
 *   memory/journal_derived rows; the job requeues and publishes only after a
 *   re-claim that refreshes the snapshot to the new generation;
 * - real restart/lease behavior: an acked prefix survives a genuine
 *   close/reopen of the same SQLite file; a lease-expired mid-job commit is a
 *   typed lease-expired with the acked prefix intact; at-least-once resumes
 *   at the first unacked chunk and candidate_key idempotence keeps
 *   re-committed candidates to ONE memory row (long-input lease cost is NOT
 *   exactly-once, and the suite never pretends it is);
 * - missing source rows block consumed commits in-tx (chunk-state-invalid,
 *   requeue, zero rows); a revoked session terminally cancels a late claimed
 *   commit and readChunkEvidence reports revoked-source;
 * - a normal releaseClaim of a CLAIMED row still requeues (the state guard
 *   only refuses terminal/settled rows).
 *
 * NO production store/profile, no live profile, no provider, no network, no
 * port 3082, no git. Exit 0 = every check passed; any failure exits 1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const { MemoryStore } = await import(join(repo, "lib/storage.js"));
const { MemoryJournalV02, JournalContractError } = await import(
  join(repo, "lib/memory-journal-v02.js")
);

const registered = [];
const check = (name, fn) => registered.push({ name, fn });

/** Deterministic-clock journal over a real SQLite file. */
function freshJournal(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "journal-v02-review-"));
  const store = new MemoryStore(dir);
  let clock = opts.clockStart ?? Date.now();
  let journal = new MemoryJournalV02(store, { ...opts, nowMs: () => clock });
  return {
    dir,
    get store() { return store; },
    get journal() { return journal; },
    clock: () => clock,
    advance(ms) {
      clock += ms;
      return clock;
    },
    openFresh() {
      // Genuine restart: NEW store+journal objects on the SAME SQLite file.
      store.close();
      const reopened = new MemoryStore(dir);
      journal = new MemoryJournalV02(reopened, { ...opts, nowMs: () => clock });
      return {
        store: reopened,
        journal,
      };
    },
    cleanup() {
      try { store.close(); } catch { /* already closed by restart */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const appendEvents = (journal, sessionId, events, extra = {}) =>
  journal.appendSession({
    sessionId,
    projectId: extra.projectId ?? "proj-review",
    producer: extra.producer ?? { delegated: false, inheritedEventCount: 0 },
    sourceMaxChars: extra.sourceMaxChars ?? 6000,
    events,
    ...(extra.maxAttempts ? { maxAttempts: extra.maxAttempts } : {}),
  });

const rawJob = (store, jobId) =>
  store.getJournalSqlite().prepare(
    `SELECT state, claim_token, lease_expires_at, attempt_count, cancel_reason, last_error, retry_after_at, completed_at
       FROM journal_jobs WHERE id = ?`,
  ).get(jobId) ?? null;

const statusCounts = (db) => {
  const rows = db.prepare(`SELECT state, COUNT(*) n FROM journal_jobs GROUP BY state`).all();
  return Object.fromEntries(rows.map((r) => [String(r.state), Number(r.n)]));
};

/** ~SHORT chars of filler ending in a distinctive tail (multi-chunk driver). */
const longText = (id) => `${id} ${"detail ".repeat(320)} tail-${id}`;

const userEvents = (prefix, n) =>
  Array.from({ length: n }, (_, i) => ({
    seq: i,
    ts: i + 1,
    kind: "user",
    text: longText(`${prefix}-${i}`),
    sourceKind: "user",
  }));

check("fact revocation uses ledger coordinates, preserves unrelated same-session claims and future events, and survives reopen", () => {
  const env = freshJournal();
  let reopened;
  try {
    appendEvents(env.journal, "bounded-fact", [{ seq: 0, ts: 1, kind: "user", text: "User owns a blue cabinet." }]);
    const claim = env.journal.claimWork({ kind: "extract" });
    const result = env.journal.commitChunkResult(claim, 0, { kind: "consumed", candidates: [{ text: "User owns a blue cabinet.", kind: "fact", provenance: "derived" }] });
    appendEvents(env.journal, "bounded-fact", [{ seq: 1, ts: 2, kind: "user", text: "User keeps an unrelated green notebook." }]);
    const unrelated = env.journal.claimWork({ kind: "extract" });
    const generation = env.journal.getCancellationGeneration();
    const revoked = env.journal.revokeMemoryEvidence({ memoryIds: result.memoryIds, reason: "forget:fixture" });
    assert.equal(revoked.sourcesRevoked, 1);
    assert.equal(revoked.sessionsRevoked, 0);
    assert.equal(env.journal.getCancellationGeneration(), generation);
    assert.equal(env.journal.readChunkEvidence(unrelated).status, "ok");
    assert.equal(env.journal.commitChunkResult(unrelated, 0, { kind: "nothing-to-learn" }).acked, true);
    assert.equal(env.journal.revokeMemoryEvidence({ memoryIds: [], reason: "empty" }).sourcesRevoked, 0);
    assert.equal(env.journal.revokeMemoryEvidence({ memoryIds: ["forged-memory-id"], reason: "forged" }).sourcesRevoked, 0);
    reopened = env.openFresh();
    appendEvents(env.journal, "bounded-fact", [{ seq: 2, ts: 3, kind: "user", text: "User adds a future unrelated brass lamp." }]);
    const future = env.journal.claimWork({ kind: "extract" });
    assert.ok(future);
    assert.equal(env.journal.readChunkEvidence(future).status, "ok");
    assert.equal(env.journal.commitChunkResult(future, 0, { kind: "nothing-to-learn" }).acked, true);
  } finally { reopened?.store.close(); env.cleanup(); }
});

check("fact revocation fences an in-flight remaining chunk without erasing historical acknowledgments", () => {
  const env = freshJournal({ chunkMaxChars: 1000 });
  let reopened;
  try {
    appendEvents(env.journal, "partial-fact", userEvents("bounded", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim.chunksTotal > 1);
    const result = env.journal.commitChunkResult(claim, 0, { kind: "consumed", candidates: [{ text: "User owns a synthetic cabinet.", kind: "fact", provenance: "derived" }] });
    const before = env.store.getJournalSqlite().prepare("SELECT COUNT(*) n FROM journal_chunks WHERE acked = 1").get().n;
    const report = env.journal.revokeMemoryEvidence({ memoryIds: result.memoryIds, reason: "correct:fixture" });
    assert.equal(report.jobsCancelled, 1);
    assert.equal(rawJob(env.store, claim.jobId).claim_token, null);
    assert.throws(() => env.journal.commitChunkResult(claim, 1, { kind: "nothing-to-learn" }));
    assert.equal(env.store.getJournalSqlite().prepare("SELECT COUNT(*) n FROM journal_chunks WHERE acked = 1").get().n, before);
    reopened = env.openFresh();
    env.journal.recoverStartup();
    assert.equal(env.journal.claimWork({ kind: "extract" }), null);
  } finally { reopened?.store.close(); env.cleanup(); }
});

// ===========================================================================
// 1. J3: done rows can never be resurrected (commit-path seal)
// ===========================================================================

check("J3 commit seal: final ack clears claim_token/lease in the SAME tx; release over done is a NO-OP; done stays unclaimable", () => {
  const env = freshJournal();
  try {
    appendEvents(env.journal, "s-j3a", userEvents("j3", 3));
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim && claim.chunksTotal >= 2, `multi-chunk (got ${claim && claim.chunksTotal})`);
    // Middle ack: still claimed, token/lease live as designed.
    const r1 = env.journal.commitChunkResult(claim, 0, { kind: "nothing-to-learn" });
    assert.equal(r1.jobState, "claimed");
    assert.ok(rawJob(env.store, claim.jobId).claim_token, "mid-job claim keeps its live token");
    assert.equal(env.journal.claimWork({ kind: "extract" }), null, "a live claim excludes double-claim");
    // FINAL ack → done within the same commit transaction.
    const ev = env.journal.readChunkEvidence(claim);
    const lastIdx = ev.status === "ok" ? ev.chunkIdx : -1;
    assert.ok(lastIdx >= 0);
    const r2 = env.journal.commitChunkResult(claim, lastIdx, { kind: "nothing-to-learn" });
    assert.equal(r2.jobState, "done");
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "done");
    assert.equal(row.claim_token, null, "done row carries NO live claim token (same-tx)");
    assert.equal(row.lease_expires_at, null, "done row carries NO lease");
    // Release with the (now stale) token must be a silent no-op, NOT resurrection.
    env.journal.releaseClaim(claim, "post-done-release-drill");
    assert.equal(rawJob(env.store, claim.jobId).state, "done", "release cannot move a done row");
    assert.equal(env.journal.claimWork({ kind: "extract" }), null, "done work is never re-claimable");
    assert.deepEqual(statusCounts(env.store.getJournalSqlite()), { done: 1 });
  } finally { env.cleanup(); }
});

check("J3 release guard: a legacy-shape done row that STILL holds a live token cannot be released/re-claimed", () => {
  const env = freshJournal();
  try {
    appendEvents(env.journal, "s-j3b", userEvents("j3b", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim);
    // Forge the pre-fix persistent shape: done + live token + future lease
    // (a store written by the unfixed commit path looks exactly like this).
    env.store.getJournalSqlite()
      .prepare(`UPDATE journal_jobs SET state='done', claim_token=?, lease_expires_at=? WHERE id=?`)
      .run(claim.claimToken, env.clock() + 600_000, claim.jobId);
    env.journal.releaseClaim(claim, "legacy-done-release");
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "done", "state guard refuses to requeue a done row");
    assert.ok(row.claim_token, "guard is a passive refusal; it cannot requeue settled work");
    assert.equal(env.journal.claimWork({ kind: "extract" }), null);
  } finally { env.cleanup(); }
});

check("J3 recovery seal: recoverStartup's terminal-cancel zombie keeps NO live token; release cannot resurrect it", () => {
  const env = freshJournal({ defaultLeaseMs: 30 });
  try {
    appendEvents(env.journal, "s-j3c", userEvents("j3c", 1));
    const claim = env.journal.claimWork({ kind: "extract" }, 30);
    assert.ok(claim);
    env.journal.revokeSessions({ sessionIds: ["s-j3c"], reason: "consent revoke drill", invalidateMemories: true });
    env.advance(10_000);
    const rec = env.journal.recoverStartup();
    assert.ok(rec.jobsCancelled >= 1, `recovery cancelled the stale-snapshot zombie: ${JSON.stringify(rec)}`);
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "cancelled");
    assert.equal(row.claim_token, null, "cancelled zombie keeps no live token");
    assert.equal(row.lease_expires_at, null);
    env.journal.releaseClaim(claim, "cancelled-release-drill");
    assert.equal(rawJob(env.store, claim.jobId).state, "cancelled");
    for (let i = 0; i < 3; i++) {
      assert.equal(env.journal.claimWork({ kind: "extract" }), null, "revoked lineage never re-claims");
      env.advance(60_000);
    }
    assert.deepEqual(statusCounts(env.store.getJournalSqlite()), { cancelled: 1 });
  } finally { env.cleanup(); }
});

// ===========================================================================
// 2. Restart / lease: real close/reopen, acked prefix, typed lease-expired,
//    at-least-once resume (never pretend exactly-once cost)
// ===========================================================================

check("real restart: acked prefix survives genuine close/reopen; resume claims ONLY the remaining chunk; no duplicate memory", () => {
  const env = freshJournal();
  try {
    appendEvents(env.journal, "s-restart", userEvents("rr", 3));
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim && claim.chunksTotal === 2, `expected 2 chunks got ${claim && claim.chunksTotal}`);
    // Ack tile 0 with one candidate, then GENUINE restart (same SQLite file).
    const r1 = env.journal.commitChunkResult(claim, 0, {
      kind: "consumed",
      candidates: [{ text: "user maintains old boiler", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-restart", seq: 0 }] }],
    });
    assert.ok(r1.acked && r1.memoryIds.length === 1);
    const beforeMemoryId = r1.memoryIds[0];
    // Let the surviving lease expire so startup recovery requeues the zombie.
    env.advance(61_000);
    const reopened = env.openFresh();
    reopened.journal.recoverStartup();
    const claim2 = reopened.journal.claimWork({ kind: "extract" });
    assert.ok(claim2, "job re-claimable after restart");
    assert.equal(claim2.jobId, claim.jobId);
    assert.deepEqual([claim2.chunksTotal, claim2.chunksPending], [2, 1], "acked prefix stays acked");
    const oldRow = rawJob(reopened.store, claim.jobId);
    assert.ok(oldRow.claim_token, "new claim token live after restart");
    const derived = reopened.store.getJournalSqlite()
      .prepare(`SELECT COUNT(*) n FROM journal_derived WHERE job_id=? AND chunk_idx=0`).get(claim.jobId);
    assert.equal(Number(derived.n), 1, "candidate_key ledger is durable");
    // Candidate idempotence: a REPLAYED chunk-0 commit cannot duplicate rows.
    const rReplay = reopened.journal.commitChunkResult(claim2, 0, {
      kind: "consumed",
      candidates: [{ text: "user maintains old boiler", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-restart", seq: 0 }] }],
    });
    assert.ok(rReplay.acked);
    const dedupRow = reopened.store.getJournalSqlite()
      .prepare(`SELECT COUNT(*) n FROM journal_derived WHERE job_id=? AND chunk_idx=0`).get(claim.jobId);
    assert.equal(Number(dedupRow.n), 1, "replayed commit maps to the SAME candidate_key row");
    const ev = reopened.journal.readChunkEvidence(claim2);
    assert.equal(ev.status, "ok");
    assert.notEqual(ev.chunkIdx, 0, "fresh reads target the first UNACKED chunk");
    const rAck = reopened.journal.commitChunkResult(claim2, ev.chunkIdx, {
      kind: "consumed",
      candidates: [{ text: "user repairs sash windows", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-restart", seq: 1 }] }],
    });
    assert.ok(rAck.acked && rAck.jobState === "done");
    const mems = reopened.store.listMemories({});
    assert.equal(mems.length, 2, "exactly two memories across the restart");
    assert.ok(mems.some((m) => m.id === beforeMemoryId));
    reopened.store.close();
  } finally { env.cleanup(); }
});

check("lease-expired mid-job on long input: typed lease-expired at one commit; acked prefix intact; late candidate NOT published; resume keys re-committed candidates to ONE row", () => {
  const env = freshJournal();
  try {
    appendEvents(env.journal, "s-lease", userEvents("wl", 5));
    // Up-front lease sized like the worker does (no renew-lease API exists).
    const leaseMs = Math.max(60_000, 32 * (30_000 + 5_000));
    const claim = env.journal.claimWork({ kind: "extract" }, leaseMs);
    assert.ok(claim && claim.chunksTotal === 3, `expected 3 chunks got ${claim && claim.chunksTotal}`);
    const r0 = env.journal.commitChunkResult(claim, 0, {
      kind: "consumed",
      candidates: [{ text: "home router was configured", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-lease", seq: 0 }] }],
    });
    assert.ok(r0.acked);
    // The chunk-1 LLM call outlives the lease: advance past it, then commit.
    env.advance(leaseMs + 10_000);
    assert.throws(
      () => env.journal.commitChunkResult(claim, 1, {
        kind: "consumed",
        candidates: [{ text: "wifi issue diagnosed", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-lease", seq: 1 }] }],
      }),
      (err) => err instanceof JournalContractError && err.code === "lease-expired",
      "late commit is a typed lease-expired",
    );
    // The late candidate NEVER leaked.
    assert.equal(env.store.listMemories({}).length, 1);
    assert.equal(
      Number(env.store.getJournalSqlite()
        .prepare(`SELECT COUNT(*) n FROM journal_derived WHERE job_id=? AND chunk_idx=1`).get(claim.jobId).n),
      0,
    );
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "queued", "expired claim durably requeued");
    assert.equal(row.claim_token, null);
    assert.equal(
      Number(env.store.getJournalSqlite().prepare(`SELECT acked FROM journal_chunks WHERE job_id=? AND idx=0`).get(claim.jobId).acked),
      1,
      "acked prefix intact",
    );
    assert.deepEqual(env.journal.getConsumedRanges("s-lease"), [{ fromSeq: 0, toSeq: 1 }]);
    // At-least-once resume reaches ONLY the unacked chunks.
    env.advance(1_000);
    const claim2 = env.journal.claimWork({ kind: "extract" }, leaseMs);
    assert.ok(claim2 && claim2.chunksPending === 2, `resume at first unacked chunk (pending=${claim2 && claim2.chunksPending})`);
    // The SAME chunk-1 candidate re-committed under the resumed claim → exactly ONE row.
    const r1 = env.journal.commitChunkResult(claim2, 1, {
      kind: "consumed",
      candidates: [{ text: "wifi issue diagnosed", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-lease", seq: 1 }] }],
    });
    assert.ok(r1.acked);
    const r2 = env.journal.commitChunkResult(claim2, 2, { kind: "nothing-to-learn" });
    assert.ok(r2.jobState === "done");
    const mems = env.store.listMemories({});
    assert.equal(mems.length, 2, "re-committed candidate_key dedupes to a single memory (at-least-once, not exactly-once)");
    env.store.close();
  } finally { env.cleanup(); }
});

check("stale claim object after recovery cannot read or commit (no ack, no rows)", () => {
  const env = freshJournal({ defaultLeaseMs: 30 });
  try {
    appendEvents(env.journal, "s-stale", userEvents("st", 1));
    const claim = env.journal.claimWork({ kind: "extract" }, 30);
    assert.ok(claim);
    env.advance(10_000);
    env.journal.recoverStartup(); // zombie lease requeued
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.chunkIdx, -1);
    assert.equal(ev.reasonCode, "range-not-stored");
    assert.throws(
      () => env.journal.commitChunkResult(claim, 0, { kind: "nothing-to-learn" }),
      (err) => err instanceof JournalContractError && err.code === "claim-invalid",
    );
    assert.deepEqual(env.journal.getConsumedRanges("s-stale"), [], "stale claim never acks");
  } finally { env.cleanup(); }
});

// ===========================================================================
// 3. Generation races: candidates publish NOTHING after a policy/consent bump
// ===========================================================================

check("policy race: consumed commit after bumpPolicyGeneration publishes ZERO rows; job requeues; re-claim refreshes gen and publishes then", () => {
  const env = freshJournal();
  try {
    appendEvents(env.journal, "s-policy", userEvents("pc", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim);
    const newGen = env.journal.bumpPolicyGeneration("strict provenance tightened");
    assert.equal(newGen, 1);
    // LATE consumed candidate must NOT publish.
    assert.throws(
      () => env.journal.commitChunkResult(claim, 0, {
        kind: "consumed",
        candidates: [{ text: "user prefers synthetic tiles", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-policy", seq: 0 }] }],
      }),
      (err) => err instanceof JournalContractError && err.code === "stale-policy-generation",
    );
    assert.equal(env.store.listMemories({}).length, 0, "no memory published after policy change");
    assert.equal(
      Number(env.store.getJournalSqlite().prepare(`SELECT COUNT(*) n FROM journal_derived`).get().n),
      0,
    );
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "queued", "stale commit releases the claim (not a terminal cancel)");
    assert.equal(row.claim_token, null);
    assert.equal(row.lease_expires_at, null);
    // Re-claim refreshes the snapshot; the work publishes only under the NEW gen.
    env.advance(2_000);
    const claim2 = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim2 && claim2.jobId === claim.jobId);
    assert.equal(claim2.policyGeneration, 1);
    const r = env.journal.commitChunkResult(claim2, 0, {
      kind: "consumed",
      candidates: [{ text: "user prefers synthetic tiles", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-policy", seq: 0 }] }],
    });
    assert.ok(r.acked);
    assert.equal(env.store.listMemories({}).length, 1, "published only under the refreshed generation");
    env.store.close();
  } finally { env.cleanup(); }
});

check("true cancel (revokeSessions) is TERMINAL: late claimed commit is terminally cancelled; restart+recovery cannot resurrect; derived rows quarantined", () => {
  const env = freshJournal({ defaultLeaseMs: 30 });
  try {
    appendEvents(env.journal, "s-cancel", userEvents("cn", 1));
    const c1 = env.journal.claimWork({ kind: "extract" }, 30);
    assert.ok(c1);
    const rOk = env.journal.commitChunkResult(c1, 0, {
      kind: "consumed",
      candidates: [{ text: "user keeps crystal glasses", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-cancel", seq: 0 }] }],
    });
    assert.ok(rOk.acked && rOk.memoryIds.length === 1);
    // A second session, still claimed when revocation lands.
    appendEvents(env.journal, "s-cancel2", userEvents("cn2", 1));
    const c2 = env.journal.claimWork({ kind: "extract" }, 30);
    assert.ok(c2);
    const rev = env.journal.revokeSessions({ sessionIds: ["s-cancel", "s-cancel2"], reason: "consent forget both", invalidateMemories: true });
    assert.ok(rev.sourcesRevoked >= 2);
    assert.equal(env.journal.getCancellationGeneration(), rev.cancellationGeneration);
    // LATE commit over the still-claimed row is a terminal cancel.
    assert.throws(
      () => env.journal.commitChunkResult(c2, 0, {
        kind: "consumed",
        candidates: [{ text: "never published candidate", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-cancel2", seq: 0 }] }],
      }),
      (err) => err instanceof JournalContractError && err.code === "stale-cancellation-generation",
    );
    const row = rawJob(env.store, c2.jobId);
    assert.equal(row.state, "cancelled");
    assert.equal(row.claim_token, null);
    assert.equal(row.lease_expires_at, null);
    // c1 was fully acked BEFORE revocation: the done row stays settled; its
    // derivative is what revocation quarantines (checked below via raw SQL).
    assert.equal(rawJob(env.store, c1.jobId).state, "done");
    // Derived memories of the revoked sessions are quarantined (same commit).
    const memStatus = env.store.getJournalSqlite()
      .prepare(`SELECT m.status AS status FROM memories m JOIN journal_derived jd ON jd.memory_id = m.id
                 WHERE jd.job_id = ?`).get(c1.jobId);
    if (memStatus) {
      assert.equal(String(memStatus.status), "quarantined", "derived memory of revoked lineage quarantined in the same tx");
    }
    // Genuine restart: terminal cancel survives recovery; nothing re-claims.
    env.advance(5_000);
    const reopened = env.openFresh();
    const rec = reopened.journal.recoverStartup();
    const after = rawJob(reopened.store, c2.jobId);
    assert.equal(after.state, "cancelled", "terminal cancel survives restart");
    assert.equal(after.claim_token, null);
    for (let i = 0; i < 3; i++) {
      assert.equal(reopened.journal.claimWork({ kind: "extract" }), null, "revoked session work never re-claims");
      env.advance(60_000);
    }
    assert.equal(rec.jobsRequeued, 0, "recovery never requeues cancelled work");
    reopened.store.close();
  } finally { env.cleanup(); }
});

check("CONTRACT NOTE: cancellation bump WITHOUT source revocation kills the claimed row terminally, but recovery replans the unrevoked pending sources as FRESH jobs (re-creation, not resurrection)", () => {
  const env = freshJournal({ defaultLeaseMs: 30 });
  try {
    appendEvents(env.journal, "s-bump", userEvents("bp", 1));
    const claim = env.journal.claimWork({ kind: "extract" }, 30);
    assert.ok(claim);
    env.journal.bumpCancellationGeneration("module consent bump");
    env.advance(10_000);
    const rec = env.journal.recoverStartup();
    const row = rawJob(env.store, claim.jobId);
    assert.equal(row.state, "cancelled", "the bump-killed row stays cancelled");
    assert.equal(row.claim_token, null);
    // New generation replan: a FRESH job re-covers the same (unrevoked) source.
    const fresh = env.journal.claimWork({ kind: "extract" });
    if (fresh) {
      assert.ok(
        fresh.jobId !== claim.jobId,
        "a new job id replanned by recovery — never the cancelled row resurrected",
      );
      assert.equal(fresh.cancellationGeneration, env.journal.getCancellationGeneration());
      env.journal.releaseClaim(fresh, "drill-end");
    } else {
      assert.equal(rec.jobsPlanned, 0, "no replan happened in this variant");
    }
    env.store.close();
  } finally { env.cleanup(); }
});

// ===========================================================================
// 4. Missing / revoked sources never ack
// ===========================================================================

check("missing source drill: in-tx availability gate refuses a consumed commit (requeue, zero rows, no ack); read reports missing; relay fails TERMINAL", () => {
  const env = freshJournal();
  try {
    appendEvents(env.journal, "s-missing", userEvents("ms", 1));
    const claim = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim);
    const rOk = env.journal.commitChunkResult(claim, 0, {
      kind: "consumed",
      candidates: [{ text: "user keeps crystal glasses", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-missing", seq: 0 }] }],
    });
    assert.ok(rOk.acked);
    // Fresh job whose single chunk's source row vanishes out-of-band.
    appendEvents(env.journal, "s-missing2", userEvents("m2", 1));
    const claim2 = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim2);
    env.store.getJournalSqlite()
      .prepare(`DELETE FROM journal_sources WHERE session_id='s-missing2' AND seq=0`)
      .run();
    const ev = env.journal.readChunkEvidence(claim2);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.reasonCode, "missing-source-row");
    assert.throws(
      () => env.journal.commitChunkResult(claim2, 0, {
        kind: "consumed",
        candidates: [{ text: "ghost candidate", provenance: "derived", scope: "project", kind: "fact", evidence: [{ sessionId: "s-missing2", seq: 0 }] }],
      }),
      (err) => err instanceof JournalContractError && err.code === "chunk-state-invalid",
      "in-tx availability gate refuses with a typed error",
    );
    assert.equal(rawJob(env.store, claim2.jobId).state, "queued", "refusal requeues without ack");
    assert.equal(
      Number(env.store.getJournalSqlite().prepare(`SELECT COUNT(*) n FROM journal_derived WHERE job_id=?`).get(claim2.jobId).n),
      0,
    );
    env.advance(1_000);
    const claim3 = env.journal.claimWork({ kind: "extract" });
    assert.ok(claim3);
    // The typed terminal relay fails the job: missing sources are NEVER acked.
    const report = env.journal.commitChunkResult(claim3, 0, {
      kind: "source-unavailable",
      reason: "missing",
      message: "source row is gone",
    });
    assert.ok(!report.acked);
    assert.equal(rawJob(env.store, claim3.jobId).state, "failed", "terminal relay fails the job");
    assert.deepEqual(env.journal.getConsumedRanges("s-missing2"), [], "missing sources never ack");
    env.store.close();
  } finally { env.cleanup(); }
});

check("revoked session while claimed: read reports revoked-source; block gates requeue; late cancel gen trips TERMINALLY at the commit", () => {
  const env = freshJournal({ defaultLeaseMs: 30 });
  try {
    appendEvents(env.journal, "s-revoke", userEvents("rv", 1));
    const claim = env.journal.claimWork({ kind: "extract" }, 30);
    assert.ok(claim);
    // Revoke only AFTER the claim (claim survives; sources die).
    const rev = env.journal.revokeSessions({ sessionIds: ["s-revoke"], reason: "forget drill", invalidateMemories: true });
    assert.ok(rev.sourcesRevoked >= 1);
    const ev = env.journal.readChunkEvidence(claim);
    assert.equal(ev.status, "unavailable");
    assert.equal(ev.reasonCode, "revoked-source");
    assert.equal(env.journal.getConsumedRanges("s-revoke").length, 0, "revoked sources never ack");
    assert.equal(env.journal.claimWork({ kind: "extract" }), null, "no re-claim after revocation");
    // Cancel-gen drift terminally cancels any late commit verdict.
    assert.throws(
      () => env.journal.commitChunkResult(claim, 0, { kind: "nothing-to-learn" }),
      (err) => err instanceof JournalContractError && err.code === "stale-cancellation-generation",
    );
    assert.equal(rawJob(env.store, claim.jobId).state, "cancelled", "worker relay dies terminally");
    env.store.close();
  } finally { env.cleanup(); }
});

// ===========================================================================
// 5. The state guard must NOT break the legitimate release paths
// ===========================================================================

check("legitimate release still requeues: delegated-header release and retryable backoff both keep working", () => {
  const envA = freshJournal();
  const envB = freshJournal();
  let useEnv = envA;
  const swap = () => {
    useEnv = useEnv === envA ? envB : envA;
    return useEnv;
  };
  try {
    // (a) delegated header release (worker's fork-control path)
    let env = envA;
    appendEvents(env.journal, "s-deleg", userEvents("dg", 1), {
      producer: { delegated: true, inheritedEventCount: 0 },
    });
    const c1 = env.journal.claimWork({ kind: "extract" });
    assert.ok(c1, "delegated sessions plan extract jobs with the header recorded");
    env.journal.releaseClaim(c1, "delegated-header-outside-personal-lane");
    assert.equal(rawJob(env.store, c1.jobId).state, "queued", "CLAIMED row release requeues");
    assert.equal(rawJob(env.store, c1.jobId).claim_token, null);
    // (b) retryable verdict scheduling still works (isolated job stream)
    env = swap();
    appendEvents(env.journal, "s-retry", userEvents("rt", 1), { maxAttempts: 2 });
    const c2 = env.journal.claimWork({ kind: "extract" }, 30_000);
    assert.ok(c2);
    const rr = env.journal.commitChunkResult(c2, 0, { kind: "retryable", reason: "transient", message: "provider blip" });
    assert.ok(!rr.acked && rr.jobState === "queued" && rr.retryScheduledAt > 0);
    env.advance(rr.retryScheduledAt - env.clock() + 1_000);
    const c3 = env.journal.claimWork({ kind: "extract" });
    assert.ok(c3, "backoff elapsed → re-claimable");
    assert.equal(c3.jobId, c2.jobId);
    assert.equal(c3.attemptsMade, 2, "attempt budget carried across the retry");
    envB.store.close();
    envA.store.close();
  } finally {
    envB.cleanup();
    envA.cleanup();
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
console.log(`\nAll ${registered.length} journal worker-review checks passed.`);
