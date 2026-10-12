#!/usr/bin/env node
/**
 * Journal extract worker lane regression suite (scripts/test-v02-extract-journal.mjs).
 *
 * Lane: src/extract-journal-v02.ts (MIGRATION-PHASE-B-EXTRACT.md), over REAL
 * native contracts — every functional test uses a genuine MemoryStore (real
 * SQLite STRICT tables on disk in a unique tmpdir), a genuine
 * MemoryJournalV02, the genuine typed seam (claimWork / readChunkEvidence /
 * commitChunkResult / releaseClaim / recoverStartup / revokeSessions /
 * bumpPolicyGeneration) and real AbortSignals for lane cancellation. ONLY the
 * provider is fake (controlled in-process deltas). NO external provider, no
 * production store, no live profile, no network, no port 3082.
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
const { MemoryJournalV02 } = await import(join(repo, "lib/memory-journal-v02.js"));
const { createJournalExtractSeam } = await import(join(repo, "lib/capture.js"));
const {
  createJournalExtractWorker,
  createJournalExtractCall,
} = await import(join(repo, "lib/extract-journal-v02.js"));
const { EXTRACT_SYSTEM_PROMPT } = await import(join(repo, "lib/extract.js"));
const { combineAbortSignals } = await import(join(repo, "lib/shutdown-v02.js"));

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const registered = [];
const check = (name, fn) => registered.push({ name, fn });
const uniqueTmpTree = (prefix) => mkdtempSync(join(tmpdir(), prefix));

function makeProvider() {
  const calls = [];
  const branch = [];
  let fallback = () => ({ status: "completed", text: '{"memories":[]}', finishKind: "stop", hasFinish: true });
  const call = async (input) => {
    calls.push({ system: input.system, prompt: input.user, signal: input.signal });
    assert.equal(input.system, EXTRACT_SYSTEM_PROMPT, "worker must use the exact extraction system prompt");
    const handler = branch.length > 0 ? branch.shift() : fallback;
    // Queue entries may be outcome objects or (input)=>outcome handlers.
    return typeof handler === "function" ? handler(input) : handler;
  };
  return {
    call,
    calls,
    /** Queue the next handler(s); each receives ({system, prompt, signal}). */
    queue: (...handlers) => branch.push(...handlers),
    setFallback(fn) { fallback = fn; },
    memories: (...items) => ({
      status: "completed",
      text: JSON.stringify({ memories: items }),
      finishKind: "stop",
      hasFinish: true,
    }),
    stop: () => ({ status: "completed", text: '{"memories":[]}', finishKind: "stop", hasFinish: true }),
    finished: (kind, text = '{"memories":[]}') => ({
      status: "completed",
      text,
      finishKind: kind,
      hasFinish: true,
    }),
  };
}

const mem = (content, evidence, extra = {}) => ({
  kind: extra.kind ?? "fact",
  content,
  importance: extra.importance ?? 8,
  confidence: extra.confidence ?? 0.9,
  source_role: "user",
  evidence,
  scope: extra.scope ?? "global",
  // Rogue trust fields the provider can never use (ignored by the parse contract):
  provenance: extra.provenance,
  confirmed: true,
  permissions: ["inject"],
});

const singleMemory = (content, evidence, extra = {}) => ({
  status: "completed",
  text: JSON.stringify({ memories: [mem(content, evidence, extra)] }),
  finishKind: "stop",
  hasFinish: true,
});

const userEvent = (seq, text) => ({ seq, ts: 1000 + seq, kind: "user", text });

const appendEvents = (lane, sessionId, events, extra = {}) =>
  lane.journal.appendSession({
    sessionId,
    projectId: extra.projectId ?? "proj-test",
    producer: extra.producer ?? { delegated: false, inheritedEventCount: 0 },
    sourceMaxChars: extra.sourceMaxChars ?? 400,
    events,
    ...(extra.maxAttempts ? { maxAttempts: extra.maxAttempts } : {}),
    ...(extra.oversizePolicy ? { oversizePolicy: extra.oversizePolicy } : {}),
  });

/**
 * One lane test environment: a REAL SQLite store, a REAL journal over it, the
 * REAL typed seam, a controlled fake provider, an owned deadline AbortController,
 * and an injected clock shared by journal retries and the worker throttle.
 */
function freshLane(opts = {}) {
  const dir = uniqueTmpTree("extract-journal-v02-");
  let clock = opts.clockStart ?? Date.now();
  const now = () => clock;
  const store = new MemoryStore(dir);
  const journal = new MemoryJournalV02(store, {
    nowMs: now,
    chunkMaxChars: opts.chunkMaxChars ?? 6000,
  });
  const seam = createJournalExtractSeam(journal);
  const provider = makeProvider();
  const deadlineGate = new AbortController();
  let lastLeaseMs = null;
  const worker = createJournalExtractWorker({
    seam: {
      claimWork: (filter, leaseMs) => {
        if (leaseMs !== undefined) lastLeaseMs = leaseMs;
        return seam.claimWork(filter, leaseMs);
      },
      readChunkEvidence: (claim) => seam.readChunkEvidence(claim),
      commitChunkResult: (claim, idx, verdict) => seam.commitChunkResult(claim, idx, verdict),
      releaseClaim: (claim, reason) => seam.releaseClaim(claim, reason),
    },
    store,
    callLlm: provider.call,
    deadlineSignal: opts.deadline === false ? undefined : deadlineGate.signal,
    settings: {
      get enabled() { return opts.enabled === undefined ? true : opts.enabled(); },
      get timeoutMs() { return opts.timeoutMs ?? 5000; },
      get minImportance() { return opts.minImportance ?? 6; },
      ...(opts.dedup !== undefined ? { get dedup() { return opts.dedup(); } } : {}),
    },
    nowMs: now,
  });
  return {
    dir,
    store,
    journal,
    seam,
    worker,
    provider,
    deadlineGate,
    now: () => clock,
    advance(ms) { clock += ms; return clock; },
    leaseMs: () => lastLeaseMs,
  };
}

const search = (lane, needle, injectableOnly) =>
  lane.store.searchMemories(needle, { injectableOnly });

const chunkPlannerLen = (text, budget = 6000) => text.length;

// ===========================================================================
// 1. Chunk discipline: one typed verdict per chunk, explicit terminal stop
// ===========================================================================

check("acks each chunk exactly once with a validated verdict; stops at the exhausted read; consumed range exact", async () => {
  const lane = freshLane();
  appendEvents(lane, "s1", [
    userEvent(0, "x".repeat(5500)),
    userEvent(1, "User keeps the ORCHID workspace in ~/lab and prefers plain notes there. ".repeat(12)),
  ], { sourceMaxChars: 10_000 });
  lane.provider.queue(
    lane.provider.stop(),
    lane.provider.memories(mem("User keeps the ORCHID workspace in ~/lab", "User keeps the ORCHID workspace in ~/lab")),
  );
  const result = await lane.worker.pump();
  assert.equal(result.claimed, 1);
  assert.equal(result.chunksAcked, 2);
  assert.equal(result.nothingToLearn, 1);
  assert.equal(result.memories, 1);
  assert.equal(result.released, 0);
  assert.equal(lane.provider.calls.length, 2);
  const jobView = lane.journal.listJobs({ sessionId: "s1" })[0];
  assert.equal(lane.journal.getJob(jobView.id).state, "done");
  assert.deepEqual(lane.journal.getConsumedRanges("s1"), [{ fromSeq: 0, toSeq: 1 }]);
  const stored = search(lane, "ORCHID", false)[0];
  assert.ok(stored, "memory stored");
  const record = lane.store.getMemory(stored.id);
  assert.equal(record.meta.provenance, "derived");
  assert.equal(record.meta.source, "llm-extract");
  assert.ok(
    record.meta.evidence.some((e) => e.sessionId === "s1" && e.seq === 1 && String(e.snippet).includes("ORCHID")),
  );
  // nothing runnable after done (no-fabrication round)
  lane.advance(30_001);
  const again = await lane.worker.pump();
  assert.equal(again.claimed, 0);
  lane.store.close();
});

check(">batch long direct-human input is consumed segment-by-segment — the MIDDLE is extracted, never omitted", async () => {
  const lane = freshLane();
  const MIDDLE = "The operator keeps the QUALIA workspace in ~/lab and reviews notes every Friday morning. ";
  const middleText = MIDDLE.repeat(48); // ≈4.3k: one bounded segment under the 6000 budget
  const long = `A${"a".repeat(5898)}\n\n${middleText}\n\n${"b".repeat(6400)}`;
  appendEvents(lane, "long-s", [userEvent(0, long)], { sourceMaxChars: 200_000 });
  lane.provider.queue(
    lane.provider.stop(), // A-run segment
    lane.provider.memories(mem("The operator keeps the QUALIA workspace in ~/lab", "The operator keeps the QUALIA workspace in ~/lab", { scope: "project" })),
    lane.provider.stop(), // B-run head
    lane.provider.stop(), // B-run tail
  );
  const result = await lane.worker.pump();
  const prompts = lane.provider.calls.map((c) => c.prompt);
  assert.equal(lane.provider.calls.length, 4, "all four segments processed exactly once");
  const middleSeen = prompts.findIndex((p) => p.includes("The operator keeps the QUALIA"));
  assert.ok(middleSeen >= 0, "middle segment reached the model");
  assert.notEqual(middleSeen, 0, "the middle is not the head chunk");
  for (const prompt of prompts) assert.ok(prompt.length <= 7000, `prompt too long: ${prompt.length}`);
  assert.equal(result.chunksAcked, 4);
  assert.equal(result.memories, 1);
  assert.equal(lane.journal.listJobs({ sessionId: "long-s" })[0].state, "done");
  assert.deepEqual(lane.journal.getConsumedRanges("long-s"), [{ fromSeq: 0, toSeq: 0 }]);
  const stored = search(lane, "QUALIA", false)[0];
  assert.ok(stored, "middle-derived memory stored");
  const record = lane.store.getMemory(stored.id);
  assert.ok(
    record.meta.evidence.some((e) => e.seq === 0 && String(e.snippet).startsWith("The operator keeps the QUALIA")),
    `evidence=${JSON.stringify(record.meta.evidence)}`,
  );
  lane.store.close();
});

// ===========================================================================
// 2. Restart / recovery across chunks (real close/reopen of the SQLite file)
// ===========================================================================

check("oversized retained human prose reaches the real worker provider in bounded chunks, including middle and tail", async () => {
  const lane = freshLane();
  try {
    const middle = "The operator keeps the QUARTZ workspace in ~/lab.";
    const tail = "The operator reviews QUARTZ notes each Friday.";
    const text = "ordinary prose. ".repeat(7000) + "\n\n" + middle + "\npassword=OversizeWorkerCanary\n" + "more ordinary prose. ".repeat(6000) + "\n\n" + tail;
    assert.ok(text.length > 200000);
    const append = appendEvents(lane, "oversized-worker", [userEvent(0, text)], { sourceMaxChars: 200000, oversizePolicy: "segment" });
    assert.ok(append.chunksPlanned > 32);
    lane.provider.setFallback(input => input.user.includes(middle)
      ? singleMemory("The operator keeps the QUARTZ workspace in ~/lab", middle, { scope: "project" })
      : input.user.includes(tail)
        ? singleMemory("The operator reviews QUARTZ notes each Friday", tail, { scope: "project" })
        : lane.provider.stop());
    const result = await lane.worker.drain();
    assert.equal(result.errors, 0);
    assert.equal(result.chunksAcked, append.chunksPlanned);
    assert.equal(lane.provider.calls.length, append.chunksPlanned);
    for (const call of lane.provider.calls) {
      assert.ok(call.prompt.length <= 7000);
      assert.ok(!call.prompt.includes("OversizeWorkerCanary"));
    }
    assert.ok(lane.provider.calls.findIndex(call => call.prompt.includes(middle)) > 0);
    assert.ok(lane.provider.calls.at(-1).prompt.includes(tail));
    assert.equal(result.memories, 2);
    assert.equal(search(lane, "QUARTZ", false).length, 2);
    assert.equal(search(lane, "QUARTZ", true).length, 0, "unreviewed derived facts never become recall eligible");
    assert.deepEqual(lane.journal.getConsumedRanges("oversized-worker"), [{ fromSeq: 0, toSeq: 0 }]);
    assert.equal(lane.journal.listJobs({ sessionId: "oversized-worker" })[0].state, "done");
  } finally { lane.worker.dispose(); lane.store.close(); }
});

check("one explicit drain completes >100 slow chunks with one atomically sized lease and one attempt", async () => {
  const lane = freshLane();
  try {
    const text = "ordinary prose. ".repeat(40000);
    const append = appendEvents(lane, "slow-full-drain", [userEvent(0, text)], { sourceMaxChars: 200000, oversizePolicy: "segment" });
    assert.ok(append.chunksPlanned > 100);
    lane.provider.setFallback(() => { lane.advance(4000); return lane.provider.stop(); });
    const result = await lane.worker.drain();
    assert.equal(result.errors, 0);
    assert.equal(result.claimed, 1);
    assert.equal(result.chunksAcked, append.chunksPlanned);
    assert.equal(lane.provider.calls.length, append.chunksPlanned);
    const job = lane.journal.listJobs({ sessionId: "slow-full-drain" })[0];
    assert.equal(job.state, "done");
    const attempts = lane.store.getJournalSqlite().prepare("SELECT attempt_count FROM journal_jobs WHERE id = ?").get(job.id).attempt_count;
    assert.equal(attempts, 1, "healthy chunks do not burn additional retry attempts");
    assert.deepEqual(lane.journal.getConsumedRanges("slow-full-drain"), [{ fromSeq: 0, toSeq: 0 }]);
  } finally { lane.worker.dispose(); lane.store.close(); }
});

check("exceptional clock stall beyond the actual sized lease retains its acked prefix and a later drain resumes", async () => {
  const lane = freshLane();
  try {
    const text = "bounded slow prose. ".repeat(13000);
    const append = appendEvents(lane, "slow-oversized", [userEvent(0, text)], { sourceMaxChars: 200000, oversizePolicy: "segment" });
    assert.ok(append.chunksPlanned > 32);
    let calls = 0;
    lane.provider.setFallback(() => {
      if (++calls === 3) {
        const expiry = lane.store.getJournalSqlite().prepare("SELECT lease_expires_at FROM journal_jobs WHERE state = 'claimed'").get().lease_expires_at;
        lane.advance(expiry - lane.now() + 1); // deliberate exceptional suspension, not healthy per-call latency
      }
      return lane.provider.stop();
    });
    const first = await lane.worker.drain();
    assert.equal(first.errors, 1, "actual journal lease gate rejects the over-deadline commit");
    assert.ok(first.chunksAcked > 0 && first.chunksAcked < append.chunksPlanned);
    assert.deepEqual(lane.journal.getConsumedRanges("slow-oversized"), []);
    const job = lane.journal.listJobs({ sessionId: "slow-oversized" })[0];
    assert.equal(job.state, "queued", "expiry durably releases ownership instead of losing the job");
    const acked = lane.store.getJournalSqlite().prepare("SELECT COUNT(*) n FROM journal_chunks WHERE job_id = ? AND acked = 1").get(job.id).n;
    assert.equal(acked, first.chunksAcked);
    lane.provider.setFallback(() => lane.provider.stop());
    const second = await lane.worker.drain();
    assert.equal(second.errors, 0);
    assert.equal(second.chunksAcked, append.chunksPlanned - first.chunksAcked);
    assert.equal(lane.provider.calls.length, append.chunksPlanned + 1, "only the rejected in-flight chunk is reprocessed");
    assert.deepEqual(lane.journal.getConsumedRanges("slow-oversized"), [{ fromSeq: 0, toSeq: 0 }]);
    assert.equal(lane.journal.getJob(job.id).state, "done");
  } finally { lane.worker.dispose(); lane.store.close(); }
});

check("durable release after an acked prefix resumes at the first unacked chunk without duplicate memories (same SQLite file re-opened)", async () => {
  const dir = uniqueTmpTree("extract-journal-resume-");
  try {
    let clock = Date.now();
    const now = () => clock;
    let store = new MemoryStore(dir);
    let journal = new MemoryJournalV02(store, { nowMs: now });
    let seam = createJournalExtractSeam(journal);
    const provider = makeProvider();
    const gate = new AbortController();
    const worker = createJournalExtractWorker({
      seam, store, callLlm: provider.call, deadlineSignal: gate.signal,
      settings: { enabled: true, timeoutMs: 5000, minImportance: 6 }, nowMs: now,
    });
    journal.appendSession({
      sessionId: "r1",
      projectId: "proj-r",
      producer: { delegated: false, inheritedEventCount: 0 },
      sourceMaxChars: 200_000,
      events: [userEvent(0, `A${"a".repeat(5898)}\n\nkeeps the ORACLE token in a vault, son ${"and files receipts. ".repeat(90)}\n\n${"b".repeat(6400)}`)],
    });
    // chunk0 completes; the provider then aborts the owned lane gate and
    // returns a normalized signal-aborted outcome for the next chunk ⇒ the
    // commit is a retryable no-ack and the round releases the remaining
    // budget durably (acked prefix stays intact).
    provider.queue(
      provider.stop(),
      () => {
        gate.abort("budget");
        return { status: "signal-aborted", message: "lane aborted mid-chunk" };
      },
      provider.stop(),
    );
    const result1 = await worker.pump();
    assert.equal(result1.chunksAcked, 1, `acked prefix only (${result1.chunksAcked})`);
    assert.equal(result1.memories, 0);
    const jobId = journal.listJobs({ sessionId: "r1" })[0].id;
    assert.equal(journal.getJob(jobId).state, "queued", "no-ack commit durably requeues the job");
    // REAL restart: close everything, reopen the same SQLite file; note the
    // retryable backoff (60s for a first no-ack) must elapse before re-claim.
    store.close();
    clock += 65_001;
    store = new MemoryStore(dir);
    journal = new MemoryJournalV02(store, { nowMs: now });
    seam = createJournalExtractSeam(journal);
    const recovery = journal.recoverStartup();
    void recovery;
    const provider2 = makeProvider();
    const worker2 = createJournalExtractWorker({
      seam, store, callLlm: provider2.call,
      settings: { enabled: true, timeoutMs: 5000, minImportance: 6 }, nowMs: now,
    });
    provider2.setFallback((input) =>
      input.user.includes("ORACLE token")
        ? singleMemory("The operator keeps the ORACLE token in a secured vault", "keeps the ORACLE token in a vault, son", { scope: "project" })
        : provider2.stop());
    const result2 = await worker2.pump();
    assert.equal(result2.memories, 1);
    assert.equal(journal.listJobs({ sessionId: "r1" })[0].state, "done");
    assert.deepEqual(journal.getConsumedRanges("r1"), [{ fromSeq: 0, toSeq: 0 }]);
    // the middle chunk must have been seen exactly once across both runs
    const oracleSeens = provider2.calls.filter((c) => c.prompt.includes("ORACLE token"));
    assert.equal(oracleSeens.length, 1, "resumed run reads each unacked chunk exactly once");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

check("recoverStartup requeues a zombie lease claim; the worker then drains it without duplicates", async () => {
  const lane = freshLane();
  appendEvents(lane, "z1", [userEvent(0, "User signs releases with the FENCHURCH key every Monday and archives monthly.".repeat(10).slice(0, 3000))], { sourceMaxChars: 10_000 });
  const zombie = lane.journal.claimWork({ kind: "extract" }, 1000);
  assert.ok(zombie, "zombie claim obtained");
  assert.equal(search(lane, "FENCHURCH", false).length, 0);
  lane.advance(10_000);
  const recovery = lane.journal.recoverStartup();
  assert.equal(recovery.leasesRecovered, 1);
  assert.equal(recovery.jobsRequeued, 1);
  lane.provider.queue(singleMemory("User signs releases with the FENCHURCH key every Monday", "signs releases with the FENCHURCH key every Monday"));
  const result = await lane.worker.pump();
  assert.equal(result.memories, 1);
  assert.equal(lane.journal.listJobs({ sessionId: "z1" })[0].state, "done");
  lane.advance(10_000);
  const recovery2 = lane.journal.recoverStartup();
  assert.equal(recovery2.jobsRequeued, 0, "done work never resurrects");
  lane.store.close();
});

// ===========================================================================
// 3. Failure / no-ack discipline with the journal deterministic budget
// ===========================================================================

check("malformed output stays retryable (no ack) with the journal retry budget, then fails terminally inserting nothing", async () => {
  const lane = freshLane();
  appendEvents(lane, "m1", [userEvent(0, "User prefers the POMMERN pnpm workspace layout over default npm trees.".repeat(20))], { sourceMaxChars: 10_000, maxAttempts: 2 });
  lane.provider.setFallback(() => ({ status: "completed", text: "this is not json at all", finishKind: "stop", hasFinish: true }));
  const r1 = await lane.worker.pump();
  assert.equal(r1.retryable, 1);
  assert.equal(r1.chunksAcked, 0);
  let job = lane.journal.listJobs({ sessionId: "m1" })[0];
  assert.equal(job.state, "queued");
  assert.ok(String(job.lastError).includes("malformed-model-output"), job.lastError);
  assert.equal(search(lane, "POMMERN", false).length, 0);
  assert.deepEqual(lane.journal.getConsumedRanges("m1"), []);
  // deterministic backoff honored: before retry_after (30s·2^attempt ⇒ ≥60s for
  // the first no-ack) even the 30s-throttle window elapsing stays idle.
  lane.advance(31_000);
  const rEarly = await lane.worker.pump();
  assert.equal(rEarly.claimed, 0);
  lane.advance(35_000);
  const r2 = await lane.worker.pump();
  assert.equal(r2.claimed, 1);
  assert.equal(r2.retryable, 1);
  job = lane.journal.listJobs({ sessionId: "m1" })[0];
  assert.equal(job.state, "failed", "attempt budget exhausted ⇒ terminal failure");
  assert.ok(String(job.lastError).includes("malformed-model-output"));
  assert.equal(search(lane, "POMMERN", false).length, 0);
  lane.store.close();
});

check("definitive {\"memories\":[]} on a stop finish acks; deterministically-rejected candidates are a validated empty, not a retry", async () => {
  const lane = freshLane({ minImportance: 6 });
  appendEvents(lane, "g1", [userEvent(0, "User wants the ALDERGATE branch merged and notes the build badge is flaky today".repeat(6))], { sourceMaxChars: 10_000 });
  lane.provider.queue(lane.provider.memories(mem("User wants the ALDERGATE branch merged", "User wants the ALDERGATE branch merged", { importance: 2 })));
  const result = await lane.worker.pump();
  assert.equal(result.nothingToLearn, 1);
  assert.equal(result.chunksAcked, 1);
  assert.equal(result.retryable, 0);
  assert.equal(lane.journal.listJobs({ sessionId: "g1" })[0].state, "done");
  assert.equal(search(lane, "ALDERGATE", false).length, 0, "rejected candidate never stored");
  lane.store.close();
});

check("retryable matrix: provider-truncated / toolcall-finish / unknown-terminal-finish / malformed-empty; evidence-shortfall", async () => {
  const cases = [
    ["trunc", () => ({ status: "completed", text: '{"memories":[]}', finishKind: "max-tokens", hasFinish: true }), "provider-truncated"],
    ["toolcall", () => ({ status: "completed", text: '{"memories":[]}', finishKind: "tool-calls", hasFinish: true }), "toolcall-finish"],
    ["errfin", () => ({ status: "completed", text: '{"memories":[]}', finishKind: "error", hasFinish: true }), "unknown-terminal-finish"],
    ["unknownfin", () => ({ status: "completed", text: '{"memories":[]}', finishKind: "weird-provider-reason", hasFinish: true }), "unknown-terminal-finish"],
    ["emptytext", () => ({ status: "completed", text: "   ", finishKind: "stop", hasFinish: true }), "malformed-model-output"],
    ["shortfall", () => ({ status: "completed", text: JSON.stringify({ memories: [mem("User reviews the LAMBINGTON ledgers by hand", "not a real quote from this session")] }), finishKind: "stop", hasFinish: true }), "evidence-shortfall"],
  ];
  for (const [label, outcome, expectedReason] of cases) {
    const lane = freshLane();
    const sessionId = `fin-${label}`;
    appendEvents(lane, sessionId, [userEvent(0, "User records that the TALLOWMARK mirror syncs nightly at 02:10 in this house.".repeat(4))], { sourceMaxChars: 10_000, maxAttempts: 1 });
    lane.provider.setFallback(outcome);
    const result = await lane.worker.pump();
    const job = lane.journal.listJobs({ sessionId })[0];
    assert.equal(job.state, "failed", `${label}: single-attempt retryable ⇒ terminal failure`);
    assert.ok(String(job.lastError).includes(expectedReason), `${label}: lastError=${job.lastError}`);
    assert.equal(result.chunksAcked, 0, `${label}: no chunk acked`);
    assert.equal(search(lane, "TALLOWMARK", false).length, 0, `${label}: no memory row`);
    lane.store.close();
  }
});

// ===========================================================================
// 4. Races: policy bump / consent revoke / abort — no late rows, no late commit
// ===========================================================================

check("policy generation bump while claimed: the late validated outcome is REJECTED — no late candidate rows", async () => {
  const lane = freshLane();
  appendEvents(lane, "pol-1", [userEvent(0, "User stores the KESTRELWORD secret phrase in the winter drawer only".repeat(9))], { sourceMaxChars: 10_000 });
  let resolveProvider;
  const deferred = new Promise((resolve) => { resolveProvider = resolve; });
  lane.provider.queue(() => deferred);
  const pumpPromise = lane.worker.pump();
  // The claim is live synchronously (claim → read → call are sync up to the await).
  lane.journal.bumpPolicyGeneration("extract-rules-changed");
  resolveProvider(singleMemory("User stores the KESTRELWORD secret phrase in the winter drawer", "User stores the KESTRELWORD secret phrase"));
  await pumpPromise;
  const job = lane.journal.listJobs({ sessionId: "pol-1" })[0];
  assert.ok(String(job.lastError).includes("stale-policy-generation"), `job=${JSON.stringify(job.lastError)}`);
  assert.equal(search(lane, "KESTRELWORD", false).length, 0, "no late candidate row survives a policy change");
  assert.deepEqual(lane.journal.getConsumedRanges("pol-1"), []);
  lane.store.close();
});

check("consent revoke (cancellation generation) while claimed: late candidate response cannot resurrect rows; job terminally cancelled", async () => {
  const lane = freshLane();
  appendEvents(lane, "cxl-1", [userEvent(0, "User says the LANTERNLOCK gate code changes on the first Monday each month".repeat(9))], { sourceMaxChars: 10_000 });
  let resolveProvider;
  const deferred = new Promise((resolve) => { resolveProvider = resolve; });
  lane.provider.queue(() => deferred);
  const pumpPromise = lane.worker.pump();
  const revocation = lane.journal.revokeSessions({ sessionIds: ["cxl-1"], reason: "consent-revoked-test" });
  assert.equal(revocation.sessionsRevoked, 1);
  resolveProvider(singleMemory("User says the LANTERNLOCK gate code changes on the first Monday each month", "User says the LANTERNLOCK gate code"));
  await pumpPromise;
  const job = lane.journal.listJobs({ sessionId: "cxl-1" })[0];
  assert.equal(job.state, "cancelled", `got ${job.state}: ${JSON.stringify(job.lastError)}`);
  assert.equal(search(lane, "LANTERNLOCK", false).length, 0);
  assert.deepEqual(lane.journal.getConsumedRanges("cxl-1"), []);
  lane.store.close();
});

check("aborted lane signal (normalized aborted finish): the carried candidate text is never committed — retryable aborted, job state stays failure-bounded", async () => {
  const lane = freshLane();
  appendEvents(lane, "abort-1", [userEvent(0, "User keeps the WINDLASS rope coil by the north dock each spring".repeat(9))], { sourceMaxChars: 10_000, maxAttempts: 1 });
  lane.provider.queue(async (input) => {
    // Real contract emulation: dsh-llm normalizes an aborted stream to a
    // terminal aborted finish. The (late) text is ignored by the mapping.
    return { status: "completed", text: JSON.stringify({ memories: [mem("User keeps the WINDLASS rope coil by the north dock", "User keeps the WINDLASS rope coil")] }), finishKind: "aborted", hasFinish: true };
  });
  const r = await lane.worker.pump();
  assert.equal(r.retryable, 1);
  assert.equal(r.chunksAcked, 0);
  const job = lane.journal.listJobs({ sessionId: "abort-1" })[0];
  assert.equal(job.state, "failed");
  assert.ok(String(job.lastError).includes("aborted"), job.lastError);
  assert.equal(search(lane, "WINDLASS", false).length, 0);
  lane.store.close();
});

check("failed provider transport: retryable transient, no ack, no rows", async () => {
  const lane = freshLane();
  appendEvents(lane, "trans-1", [userEvent(0, "User checks the GULLANEIN ferry schedule before dawn trips weekly".repeat(9))], { sourceMaxChars: 10_000, maxAttempts: 1 });
  lane.provider.queue(async () => { throw new Error("connection reset by peer"); });
  const r = await lane.worker.pump();
  assert.equal(r.retryable, 1);
  assert.equal(r.chunksAcked, 0);
  const job = lane.journal.listJobs({ sessionId: "trans-1" })[0];
  assert.ok(String(job.lastError).includes("transient"), job.lastError);
  assert.equal(search(lane, "GULLANEIN", false).length, 0);
  lane.store.close();
});

check("owned resource closed (store closed): pump stops without starting work and without throwing", async () => {
  const lane = freshLane();
  appendEvents(lane, "closed-1", [userEvent(0, "User notes the HARBOURLIGHT lantern recharges on Tuesdays at the shipyard".repeat(6))], { sourceMaxChars: 10_000 });
  lane.store.close();
  const result = await lane.worker.pump();
  assert.equal(result.claimed, 0);
  assert.equal(lane.provider.calls.length, 0);
});

// ===========================================================================
// 5. Provenance / eligibility fail-close (provider output cannot widen trust)
// ===========================================================================

check("provider-attested provenance/confirmed/permissions ignored: commits stay derived/llm-extract/review-required, never injected, never baseline-pinned", async () => {
  const lane = freshLane();
  appendEvents(lane, "prov-1", [userEvent(0, "User harvests the SEQUOIAWAYS beans on the first dry Friday of October".repeat(9))], { sourceMaxChars: 10_000 });
  lane.provider.queue(lane.provider.memories(
    mem("User harvests the SEQUOIAWAYS beans on the first dry Friday of October", "User harvests the SEQUOIAWAYS beans", { provenance: "user" }),
  ));
  const result = await lane.worker.pump();
  assert.equal(result.memories, 1);
  const hit = search(lane, "SEQUOIAWAYS", false)[0];
  assert.ok(hit);
  const record = lane.store.getMemory(hit.id);
  assert.equal(record.meta.provenance, "derived", "provider cannot self-declare provenance");
  assert.equal(record.meta.source, "llm-extract");
  // INJECTABLE recall never sees it (INJECTABLE_PROVENANCES = user/persona)
  assert.equal(search(lane, "SEQUOIAWAYS", true).length, 0);
  // no baseline row references it (no pinBaseline from this lane)
  const db = lane.store.getJournalSqlite();
  let baselineRows = [];
  try {
    baselineRows = db.prepare("SELECT * FROM baselines").all();
  } catch {
    baselineRows = [];
  }
  assert.deepEqual(baselineRows, []);
  lane.store.close();
});

check("dedupe pre-commit filter: duplicate against a trusted row is DROPPED (no mergeDuplicate from a derived lane), nothing duplicated", async () => {
  const lane = freshLane();
  lane.store.insertMemory(
    { kind: "fact", content: "User prefers pnpm installs for this workshop", importance: 8 },
    { provenance: "user", source: "user-direct", scope: "global", projectId: null, confidence: 0.9, evidence: [] },
  );
  appendEvents(lane, "dup-1", [userEvent(0, "User prefers pnpm installs for this workshop and keeps the node_modules folder pruned weekly".repeat(8))], { sourceMaxChars: 10_000 });
  lane.provider.queue(lane.provider.memories(
    mem("User prefers pnpm installs for this workshop", "User prefers pnpm installs for this workshop"),
  ));
  const result = await lane.worker.pump();
  assert.equal(result.chunksAcked, 1, "validated empty: the duplicate was deterministically dropped");
  assert.ok(result.gateCounters.duplicatesDropped === 1, JSON.stringify(result.gateCounters));
  const all = lane.store.searchMemories("pnpm", { injectableOnly: false });
  for (const h of all) assert.equal(lane.store.getMemory(h.id).meta.provenance, "user");
  assert.equal(all.filter((h) => lane.store.getMemory(h.id).meta.provenance === "derived").length, 0);
  lane.store.close();
});

// ===========================================================================
// 6. Fork / no-source positive controls, throttling
// ===========================================================================

check("fork positive control: a delegated-header job is RELEASED unprocessed — no LLM call, no extraction, no widening", async () => {
  const lane = freshLane();
  appendEvents(lane, "fork-1", [userEvent(0, "Coordinator task brief: audit the sandbox and report back".repeat(10))], { sourceMaxChars: 10_000, producer: { delegated: true, inheritedEventCount: 5, origin: "subagent" } });
  const result = await lane.worker.pump();
  assert.equal(result.released, 1, JSON.stringify(result));
  assert.equal(result.claimed, 1);
  assert.equal(lane.provider.calls.length, 0);
  assert.equal(search(lane, "sandbox", false).length, 0);
  const job = lane.journal.listJobs({ sessionId: "fork-1" })[0];
  assert.equal(job.state, "queued");
  assert.ok(String(job.lastError).includes("delegated-header-outside-personal-lane"), job.lastError);
  lane.store.close();
});

check("no-source control: an empty journal ends the round with zero claims, zero calls, zero counters", async () => {
  const lane = freshLane();
  const result = await lane.worker.pump();
  assert.equal(result.claimed, 0);
  assert.equal(result.chunksAcked, 0);
  assert.equal(result.memories, 0);
  assert.equal(result.errors, 0);
  assert.equal(lane.provider.calls.length, 0);
});

check("re-entrancy + 30s throttle: a concurrent pump is an empty no-op and never double-claims", async () => {
  const lane = freshLane();
  appendEvents(lane, "thr-1", [userEvent(0, "User reshelves the MAGPIEGRAM index cards after each session in the loft".repeat(6))], { sourceMaxChars: 10_000 });
  const first = lane.worker.pump();
  const second = await lane.worker.pump();
  assert.equal(second.claimed, 0, "re-entrant pump must not double-claim");
  await first;
  const callsAfterFirst = lane.provider.calls.length;
  assert.ok(callsAfterFirst >= 0);
  // within the 30s window: no-op
  const third = await lane.worker.pump();
  assert.equal(third.claimed, 0, "throttled pump must not run inside 30s");
  lane.advance(30_001);
  const fourth = await lane.worker.pump();
  assert.equal(fourth.claimed, 0, "post-window round has nothing left to claim");
  lane.store.close();
});

// ===========================================================================
// 7. Leases, oversize fence, typed aux call on real signal contracts
// ===========================================================================

check("up-front lease covers the claimed job's bounded chunk work (no renew API; lease ≥ 60s floor)", async () => {
  const lane = freshLane();
  appendEvents(lane, "lease-1", [userEvent(0, "User refills the TIDEMONITOR gauge chart every spring tide in the boathouse".repeat(9))], { sourceMaxChars: 10_000 });
  lane.provider.queue(lane.provider.stop());
  await lane.worker.pump();
  const lease = lane.leaseMs();
  assert.ok(lease !== null && lease >= 60_000, `lease=${lease}`);
  const db = lane.store.getJournalSqlite();
  const row = db.prepare("SELECT state FROM journal_jobs WHERE session_id = 'lease-1' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(row.state, "done");
  lane.store.close();
});

check("Workflow26 oversize fence: oversize raw source input rejects ATOMICALLY — nothing stored, nothing planned, nothing acked", async () => {
  const lane = freshLane();
  const long = "y".repeat(5000);
  let thrown = null;
  try {
    lane.journal.appendSession({
      sessionId: "over-1",
      projectId: "proj-test",
      producer: { delegated: false, inheritedEventCount: 0 },
      sourceMaxChars: 400,
      events: [userEvent(0, "keeps it short"), userEvent(1, long)],
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "oversize append must reject");
  assert.equal(thrown.name, "JournalContractError");
  assert.equal(thrown.code, "source-too-large");
  const db = lane.store.getJournalSqlite();
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM journal_sources WHERE session_id = 'over-1'").get().n), 0, "no source row persisted");
  assert.equal(Number(db.prepare("SELECT COUNT(*) n FROM journal_jobs WHERE session_id = 'over-1'").get().n), 0, "no coverage planned");
  const result = await lane.worker.pump();
  assert.equal(result.claimed, 0);
  lane.store.close();
});

check("typed aux call: unresolved route fails closed with no stream; pre-aborted lane never opens a stream; exact finish kinds surface", async () => {
  // (a) unresolved route → provider-failure, stream never opened
  const opened = [];
  const unroutable = createJournalExtractCall({
    streamChunks: async function* () { opened.push(1); yield { type: "finish", reason: { kind: "stop" } }; },
    route: () => { throw new Error("no model provider configured"); },
    maxOutputTokens: () => 2000,
  });
  const a = await unroutable({ system: "s", user: "u", signal: new AbortController().signal });
  assert.equal(a.status, "provider-failure");
  assert.ok(a.message.includes("route-unresolved"));
  assert.equal(opened.length, 0);

  // (b) pre-aborted signal throws the abort reason before a stream opens
  const preAborted = new AbortController();
  preAborted.abort("shutdown first");
  const withStream = createJournalExtractCall({
    streamChunks: async function* () { opened.push(2); yield { type: "finish", reason: { kind: "stop" } }; },
    route: () => ({ provider: "p", model: "m" }),
    maxOutputTokens: () => 2000,
  });
  let rejected = null;
  try { await withStream({ system: "s", user: "u", signal: preAborted.signal }); } catch (e) { rejected = e; }
  assert.ok(rejected !== null, "pre-aborted call must throw");
  assert.equal(opened.length, 0);

  // (c) genuine stream chunks assemble text and surface the exact finish kind
  const withChunks = createJournalExtractCall({
    streamChunks: async function* (options) {
      assert.equal(Object.hasOwn(options, "sessionId"), false, "auxiliary evidence identity must not enable raw native session upload");
      yield { type: "block-start", index: 0, blockType: "text" };
      yield { type: "text-delta", index: 0, text: '{"memories":[]}' };
      yield { type: "finish", reason: { kind: "max-tokens" } };
    },
    route: () => ({ provider: "p", model: "m" }),
    maxOutputTokens: () => 2000,
  });
  const c = await withChunks({ system: "s", user: "u", sessionId: "private-evidence-session", signal: new AbortController().signal });
  assert.equal(c.status, "completed");
  assert.equal(c.finishKind, "max-tokens");
  assert.equal(c.hasFinish, true);
  assert.deepEqual(JSON.parse(c.text).memories, []);

  // (d) mid-stream lane abort: throwIfAborted fires before the finish chunk is
  //     consumed → typed signal-aborted outcome (the worker maps it to
  //     retryable/aborted, never a committed text).
  const gate = new AbortController();
  const withAbort = createJournalExtractCall({
    streamChunks: async function* () {
      yield { type: "text-delta", index: 0, text: '{"memories":[]}' };
      gate.abort("deadline");
      yield { type: "finish", reason: { kind: "aborted", failure: {} } };
    },
    route: () => ({ provider: "p", model: "m" }),
    maxOutputTokens: () => 2000,
  });
  const d = await withAbort({
    system: EXTRACT_SYSTEM_PROMPT,
    user: "u",
    signal: combineAbortSignals(AbortSignal.timeout(60_000), gate.signal),
  });
  assert.equal(d.status, "signal-aborted");
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const cleanups = [];
let failed = 0;
for (const { name, fn } of registered) {
  try {
    await fn();
    console.log(`PASS - ${name}`);
  } catch (error) {
    failed++;
    console.error(`FAIL - ${name}\n    ${error instanceof Error ? error.stack : String(error)}`);
  }
}
for (const tree of cleanups) rmSync(tree, { recursive: true, force: true });
console.log(failed === 0 ? "\nALL PASS" : `\nFAILURES: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
void chunkPlannerLen;
void cleanups;
