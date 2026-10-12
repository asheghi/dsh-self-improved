#!/usr/bin/env node
/**
 * Pending-drain suite for the journal extract worker lane
 * (scripts/test-v02-extract-pending-drain.mjs).
 *
 * Focused repair evidence for MIGRATION-PHASE-B-PENDING-DRAIN.md (the
 * runtime-review MIN_PUMP_INTERVAL_MS defect in src/extract-journal-v02.ts:
 * the silent 30s-window drop and the silent reentrant empty return lost
 * durably accepted ranges until another external driver).
 *
 * Same honesty boundary as the extract-lane regression suite: every
 * functional check uses a genuine MemoryStore (real SQLite STRICT tables on
 * disk in a unique tmpdir), a genuine MemoryJournalV02, the genuine typed
 * seam, real AbortSignals, a controlled fake LLM provider, a controlled
 * injected clock (`nowMs`) and a CONTROLLED injected one-shot timer (the
 * worker's own pending-drain kicker surface — no sleeps, no busy polls, no
 * adhoc events, no network, no production store/profile, no port 3082).
 *
 * Exit 0 = every check passed; any failure exits 1.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const debug = process.env.PENDING_DRAIN_DEBUG === "1";

const { MemoryStore } = await import(join(repo, "lib/storage.js"));
const { MemoryJournalV02 } = await import(join(repo, "lib/memory-journal-v02.js"));
const { createJournalExtractSeam } = await import(join(repo, "lib/capture.js"));
const {
  createJournalExtractWorker,
} = await import(join(repo, "lib/extract-journal-v02.js"));
const { EXTRACT_SYSTEM_PROMPT } = await import(join(repo, "lib/extract.js"));

/**
 * The worker logs a result JSON object inside parentesis: extract the
 * balanced braces span (first "{" .. last "}") before parsing.
 */
const drainJson = (line) => {
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  assert.ok(start >= 0 && end > start, `drain log line carries a result object: ${line}`);
  return line.slice(start, end + 1);
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const registered = [];
const check = (name, fn) => registered.push({ name, fn });
const uniqueTmpTree = (prefix) => mkdtempSync(join(tmpdir(), prefix));

/** Deterministic microtask drain (event-loop yields, never wall-clock sleeps). */
const settle = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
};

function makeProvider() {
  const calls = [];
  const branch = [];
  let fallback = () => ({ status: "completed", text: '{"memories":[]}', finishKind: "stop", hasFinish: true });
  const call = async (input) => {
    calls.push({ system: input.system, prompt: input.user });
    assert.equal(input.system, EXTRACT_SYSTEM_PROMPT, "worker must use the exact extraction system prompt");
    const handler = branch.length > 0 ? branch.shift() : fallback;
    return typeof handler === "function" ? handler(input) : handler;
  };
  return {
    call,
    calls,
    queue: (...handlers) => branch.push(...handlers),
    setFallback(fn) { fallback = fn; },
    memories: (...items) => ({
      status: "completed",
      text: JSON.stringify({ memories: items }),
      finishKind: "stop",
      hasFinish: true,
    }),
    stop: () => ({ status: "completed", text: '{"memories":[]}', finishKind: "stop", hasFinish: true }),
    malformed: () => ({ status: "completed", text: "not json at all", finishKind: "stop", hasFinish: true }),
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
});

const userEvent = (seq, text) => ({ seq, ts: 1000 + seq, kind: "user", text });

/**
 * Controlled one-shot timer: `set` records (cb, delay) handles, `clear`
 * marks them cleared, fire() executes one handle deterministically. No
 * wall-clock waiting anywhere.
 */
function makeTimer() {
  const scheduled = [];
  return {
    scheduled,
    set: (cb, delay) => {
      const rec = { cb, delay, cleared: false };
      scheduled.push(rec);
      return rec;
    },
    clear: (handle) => {
      handle.cleared = true;
    },
    fire(handle) {
      assert.ok(handle && !handle.cleared, "fired handle must be live");
      handle.cleared = true;
      handle.cb();
    },
    handles: () => scheduled,
    live: () => scheduled.filter((r) => !r.cleared),
  };
}

/**
 * One lane environment: real SQLite store, real journal, real seam, fake
 * provider, injected shared clock (journal retries + worker window), owned
 * deadline AbortController AND the injected one-shot kick timer.
 */
function freshLane(opts = {}) {
  const dir = uniqueTmpTree("extract-pending-drain-");
  let clock = opts.clockStart ?? Date.now();
  const now = () => clock;
  const store = new MemoryStore(dir);
  const journal = new MemoryJournalV02(store, { nowMs: now });
  const seam = createJournalExtractSeam(journal);
  const provider = makeProvider();
  const deadlineGate = new AbortController();
  const kickTimer = makeTimer();
  const lines = [];
  const worker = createJournalExtractWorker({
    seam,
    store,
    callLlm: provider.call,
    deadlineSignal: opts.deadline === false ? undefined : deadlineGate.signal,
    settings: {
      get enabled() { return opts.enabled === undefined ? true : opts.enabled(); },
      get timeoutMs() { return opts.timeoutMs ?? 5000; },
      get minImportance() { return opts.minImportance ?? 6; },
    },
    nowMs: now,
    timer: kickTimer,
    onDeferredJob: opts.onDeferredJob,
    log: (message) => {
      lines.push(message);
      if (debug) console.log(message);
    },
  });
  const appendRange = (sessionId, events) =>
    journal.appendSession({
      sessionId,
      projectId: "proj-test",
      producer: { delegated: false, inheritedEventCount: 0 },
      sourceMaxChars: 10_000,
      events,
    });
  return {
    dir, store, journal, seam, worker, provider, deadlineGate, kickTimer, lines,
    advance(ms) { clock += ms; return clock; },
    appendRange,
    dispose: () => {
      try { store.close(); } catch { /* first close wins */ }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Ends a check with a sealed lane (closed store, tmpdir removed). */
const endLane = (lane) => {
  lane.dispose();
};

check("explicit awaited flush drain bypasses only the background throttle and clears parked timers", async () => {
  const lane = freshLane();
  try {
    lane.appendRange("explicit-drain", [userEvent(0, "User keeps a synthetic blue notebook.")]);
    await lane.worker.pump();
    lane.appendRange("explicit-drain", [userEvent(1, "User keeps a separate green notebook.")]);
    assert.equal((await lane.worker.pump()).deferred, 1);
    const result = await lane.worker.drain();
    assert.equal(result.claimed, 1);
    assert.equal(lane.provider.calls.length, 2);
    assert.equal(lane.kickTimer.live().length, 0);
    assert.equal(lane.store.getJournalSqlite().prepare("SELECT COUNT(*) n FROM journal_sources WHERE consumed = 0").get().n, 0);
  } finally { endLane(lane); }
});

check("concurrent explicit flush drains join the active chain without double provider calls", async () => {
  const lane = freshLane();
  let release;
  try {
    lane.provider.queue(() => new Promise(resolve => { release = () => resolve(lane.provider.stop()); }));
    lane.appendRange("joined-drain", [userEvent(0, "User keeps an owned synthetic notebook.")]);
    const first = lane.worker.drain();
    await settle();
    const joined = lane.worker.drain();
    assert.equal(lane.provider.calls.length, 1);
    release();
    await Promise.all([first, joined]);
    assert.equal(lane.provider.calls.length, 1);
    assert.equal(lane.kickTimer.live().length, 0);
    lane.worker.dispose();
    assert.equal((await lane.worker.drain()).claimed, 0);
  } finally { endLane(lane); }
});

check("timer-started work is synchronously registered with the owner and remains owned until its provider settles", async () => {
  const accepted = new Set();
  const lane = freshLane({ onDeferredJob: job => {
    accepted.add(job);
    void job.finally(() => accepted.delete(job)).catch(() => {});
  } });
  let release;
  try {
    await lane.worker.pump();
    lane.appendRange("owned-timer", [userEvent(0, "User owns a blue synthetic notebook.")]);
    lane.provider.queue(() => new Promise(resolve => { release = () => resolve(lane.provider.stop()); }));
    await lane.worker.pump();
    lane.advance(30_000);
    lane.kickTimer.fire(lane.kickTimer.live()[0]);
    assert.equal(accepted.size, 1, "the pending round is registered before the timer yields");
    await settle();
    assert.equal(typeof release, "function", "actual provider call is held");
    lane.worker.dispose();
    assert.equal(accepted.size, 1, "dispose must not erase ownership of the in-flight round");
    release();
    await Promise.allSettled([...accepted]);
    await settle();
    assert.equal(accepted.size, 0);
    assert.equal(lane.kickTimer.live().length, 0);
  } finally { endLane(lane); }
});

// ===========================================================================
// 1. In-window requests are coalesced, never dropped: one owned kick drains
//    the durably accepted range without another external flush.
// ===========================================================================

check("in-window second flush coalesces (deferred=1, claimed=0); ONE owned timer drains the new range at window end", async () => {
  const lane = freshLane();
  // Range A: drained by the routine first flush.
  lane.appendRange("s1", [userEvent(0, "User shelves the VELLUM scrolls beside the morning ledger stand".repeat(6))]);
  lane.provider.queue(lane.provider.stop());
  await lane.worker.pump();
  assert.equal(lane.journal.listJobs({ sessionId: "s1" })[0].state, "done");
  const callsAfterFirst = lane.provider.calls.length;

  // Range B accepted INSIDE the 30s window: the previously-defective silent drop.
  lane.appendRange("s2", [userEvent(0, "User rewires the HEARTHGLOW valve before each cold season walk".repeat(6))]);
  lane.provider.queue(lane.provider.memories(mem("User rewires the HEARTHGLOW valve before each cold season walk", "User rewires the HEARTHGLOW valve before each cold season walk")));
  lane.advance(10_000);
  const second = await lane.worker.pump();
  assert.equal(second.claimed, 0, "in-window call claims nothing immediately");
  assert.equal(second.deferred, 1, "the request is parked, not dropped");
  assert.deepEqual(lane.journal.getConsumedRanges("s2"), [], "range B still unconsumed before the window ends");
  assert.equal(lane.journal.listJobs({ sessionId: "s2" })[0].state, "queued", "accepted work stays durable");
  assert.equal(lane.provider.calls.length, callsAfterFirst, "no LLM call between the two flushes");

  // Exactly ONE owned one-shot timer, armed for the remaining window.
  const live = lane.kickTimer.live();
  assert.equal(live.length, 1, "exactly one kick timer armed (storm-safe)");
  assert.equal(live[0].delay, 20_000, "armed delay == remaining throttle window (30s - 10s)");

  // No external flush: the owned kick fires at window end and drains range B.
  lane.advance(20_000);
  lane.kickTimer.fire(live[0]);
  await settle();
  assert.equal(lane.journal.listJobs({ sessionId: "s2" })[0].state, "done");
  assert.deepEqual(lane.journal.getConsumedRanges("s2"), [{ fromSeq: 0, toSeq: 0 }]);
  assert.equal(lane.provider.calls.length, callsAfterFirst + 1, "exactly one LLM call for the drained range");
  assert.equal(lane.kickTimer.live().length, 0, "kick timer consumed; nothing re-arms with no pending requests");
  const stored = lane.store.searchMemories("HEARTHGLOW", { injectableOnly: false })[0];
  assert.ok(stored, "kicked range committed the memory");
  assert.equal(lane.store.getMemory(stored.id).meta.provenance, "derived");
  endLane(lane);
});

// ===========================================================================
// 2. Reentrant/overlapping requests: the previously-silent empty return now
//    coalesces; the bounded trailing round drains work accepted mid-flight.
// ===========================================================================

check("overlapping pump mid-flight coalesces; the bounded trailing round drains the range accepted during the flight, no double-claim", async () => {
  const lane = freshLane();
  lane.appendRange("s1", [userEvent(0, "User tunes the ALDERWAY loom each solstice in the old workshop".repeat(6))]);
  let releaseMidFlight;
  const gate = new Promise((resolve) => { releaseMidFlight = resolve; });
  lane.provider.queue(() => gate.then(() => lane.provider.memories(mem("User tunes the ALDERWAY loom each solstice", "User tunes the ALDERWAY loom each solstice"))));
  const first = lane.worker.pump();
  // The flight is live (claim ran synchronously; the provider gate holds it).
  const overlapping = await lane.worker.pump();
  assert.equal(overlapping.claimed, 0, "overlapping pump never double-claims");
  assert.equal(overlapping.deferred, 1, "overlapping request parked (was: silent empty return)");

  // A new range is accepted while the first round is still in flight.
  lane.appendRange("s2", [userEvent(0, "User meters the BRYNGATE track lighting every second Tuesday".repeat(6))]);
  releaseMidFlight();
  const summary = await first;
  const doneStates = ["s1", "s2"].map((s) => lane.journal.listJobs({ sessionId: s })[0].state);
  assert.deepEqual(doneStates, ["done", "done"], "trailing round drained the mid-flight acceptance: " + JSON.stringify(summary));
  assert.deepEqual(lane.journal.getConsumedRanges("s1"), [{ fromSeq: 0, toSeq: 0 }]);
  assert.deepEqual(lane.journal.getConsumedRanges("s2"), [{ fromSeq: 0, toSeq: 0 }]);
  assert.equal(summary.deferred, 1, "the drain chain reports the parked overlapping request");
  assert.equal(lane.provider.calls.length, 2, "exactly one LLM call per drained chunk (no storm)");
  assert.equal(lane.kickTimer.live().length, 0, "no owned timer needed: the trailing covered the request");
  endLane(lane);
});

// ===========================================================================
// 3. Coalescing bounds: N requests → ONE timer + ONE round; the drain result
//    reports the served requests; no busy poll chain.
// ===========================================================================

check("six in-window bursts coalesce into ONE timer and ONE kick round; the drain reports the served requests", async () => {
  const lane = freshLane();
  lane.appendRange("s1", [userEvent(0, "User bookmarks the GREYFORD ledgers before the quarterly audit".repeat(6))]);
  lane.provider.queue(lane.provider.stop());
  await lane.worker.pump();

  lane.appendRange("s2", [userEvent(0, "User prices the LAMEWOOD beams each Friday at the timber yard".repeat(6))]);
  lane.advance(10_000);
  const snapshots = [];
  for (let i = 0; i < 6; i++) snapshots.push(await lane.worker.pump());
  for (const snap of snapshots) {
    assert.equal(snap.claimed, 0);
    assert.equal(snap.deferred, 1, "each parked call reports its own single request");
  }
  assert.equal(lane.kickTimer.live().length, 1, "six bursts still coalesce into ONE armed timer");

  lane.advance(20_000);
  lane.kickTimer.fire(lane.kickTimer.live()[0]);
  await settle();
  assert.equal(lane.journal.listJobs({ sessionId: "s2" })[0].state, "done");
  assert.equal(lane.kickTimer.live().length, 0, "nothing re-arms without pending requests");
  const lines = lane.lines.filter((l) => l.startsWith("journal extract: coalesced pending drain"));
  assert.equal(lines.length, 1, "exactly ONE drain executed");
  const drainResult = JSON.parse(drainJson(lines[0]));
  assert.equal(drainResult.claimed, 1);
  assert.equal(drainResult.deferred, 6, "the drain result reports the requests it served");
  assert.equal(drainResult.chunksAcked, 1);
  endLane(lane);
});

check("overlapping bursts during a flight coalesce once; the chain runs at most one trailing round (no unbounded calls)", async () => {
  const lane = freshLane();
  lane.appendRange("s1", [userEvent(0, "User seals the OAKENFOLD hatch records after each tide chart review".repeat(6))]);
  let releaseFlight;
  const gate = new Promise((resolve) => { releaseFlight = resolve; });
  lane.provider.queue(() => gate.then(() => lane.provider.memories(mem("User seals the OAKENFOLD hatch records after each tide chart review", "User seals the OAKENFOLD hatch records"))));
  const first = lane.worker.pump();
  for (let i = 0; i < 10; i++) {
    const snap = await lane.worker.pump();
    assert.equal(snap.claimed, 0, "overlapping storm never spawns concurrent rounds");
    assert.equal(snap.deferred, 1);
  }
  releaseFlight();
  const summary = await first;
  assert.equal(lane.provider.calls.length, 1, "one LLM call total for the whole storm (single flight + bundle)");
  assert.equal(summary.deferred, 10, "the drain chain reports all parked requests");
  assert.deepEqual(lane.journal.getConsumedRanges("s1"), [{ fromSeq: 0, toSeq: 0 }]);
  endLane(lane);
});

// ===========================================================================
// 4. Close/pause boundaries: explicit timer/abort/dispose stop ALL late work.
// ===========================================================================

check("dispose() stops late work: kick timer cleared, parked requests dropped, later fires and pumps are no-ops; durable work stays queued for recoverStartup", async () => {
  const lane = freshLane();
  lane.appendRange("s1", [userEvent(0, "User notes the BRAMBLEGATE gate pulley needs oiling each dry spell".repeat(6))]);
  lane.provider.queue(lane.provider.stop());
  await lane.worker.pump();

  lane.appendRange("s2", [userEvent(0, "User checks the HARLANPOINT fog bell before night watch".repeat(6))]);
  lane.advance(10_000);
  await lane.worker.pump(); // parked + timer armed
  assert.equal(lane.kickTimer.live().length, 1);

  lane.worker.dispose();
  assert.equal(lane.kickTimer.live().length, 0, "dispose cleared the owned kick timer");
  const dropLines = lane.lines.filter((l) => l.includes("dispose stopped 1 coalesced pending request"));
  assert.equal(dropLines.length, 1);
  const after = await lane.worker.pump();
  assert.ok(after.claimed === 0 && after.deferred === 0, "post-dispose pumps are empty no-ops");
  // The earlier parked timer (already cleared) firing afterwards is inert:
  const clearedHandle = lane.kickTimer.handles().find((h) => h.cleared);
  assert.ok(clearedHandle, "the parked timer was cleared, not merely consumed");
  clearedHandle.cb(); // post-close fire must be inert (no round may start)
  await settle();
  assert.equal(lane.journal.listJobs({ sessionId: "s2" }).length, 1);
  assert.equal(lane.journal.listJobs({ sessionId: "s2" })[0].state, "queued", "accepted work stays durable for recoverStartup");
  assert.equal(lane.provider.calls.length, 1, "no provider call after close");
  lane.worker.dispose(); // idempotent
  assert.equal(lane.lines.filter((l) => l.includes("dispose stopped 1 coalesced")).length, 1, "dispose is idempotent");
  endLane(lane);
});

check("already-aborted deadline lane: pump is a bounded no-op even with the window elapsed — no late claim, no late provider call", async () => {
  const lane = freshLane();
  lane.appendRange("s1", [userEvent(0, "User keeps the WICKFORD candles under the stair rail".repeat(6))]);
  lane.advance(60_000); // window long elapsed
  lane.deadlineGate.abort("shutdown deadline reached");
  const result = await lane.worker.pump();
  assert.equal(result.claimed, 0);
  assert.equal(result.deferred, 0, "no request parked: the lane is closed, not pending");
  assert.ok(!lane.kickTimer.handles().some((h) => !h.cleared), "no timer armed by a closed lane");
  assert.equal(lane.provider.calls.length, 0, "no provider call after pause");
  assert.equal(lane.journal.listJobs({ sessionId: "s1" })[0].state, "queued", "durable accepted work is recoverStartup's");
  endLane(lane);
});

check("dispose while a round is in flight: the in-flight commits stand, but no trailing round and no kick timer afterwards", async () => {
  const lane = freshLane();
  lane.appendRange("s1", [userEvent(0, "User rinses the PERMESTAD ale casks every brew day in the stone annex".repeat(6))]);
  let releaseFlight;
  const gate = new Promise((resolve) => { releaseFlight = resolve; });
  lane.provider.queue(() => gate.then(() => lane.provider.memories(mem("User rinses the PERMESTAD ale casks every brew day", "User rinses the PERMESTAD ale casks"))));
  const first = lane.worker.pump();
  await lane.worker.pump(); // coalesced overlapping request parked while in flight
  lane.worker.dispose(); // owner34 close hook lands DURING the drained round
  releaseFlight();
  const dropLine = lane.lines.find((l) => l.includes("dispose stopped 1 coalesced pending request"));
  assert.ok(dropLine, "dispose dropped the request parked during its round");
  const summary = await first;
  assert.equal(lane.journal.listJobs({ sessionId: "s1" })[0].state, "done", "in-flight commits are not killed by dispose");
  assert.deepEqual(lane.journal.getConsumedRanges("s1"), [{ fromSeq: 0, toSeq: 0 }]);
  assert.equal(summary.chunksAcked, 1);
  assert.equal(summary.deferred, 0, "dispose-dropped requests are not reported as served");
  assert.equal(lane.kickTimer.live().length, 0, "no kick timer after close");
  const later = await lane.worker.pump();
  assert.ok(later.claimed === 0 && later.deferred === 0 && !later.retryable, "no work starts after close");
  endLane(lane);
});

check("disabled module gate: nothing parked, nothing armed, empty honest results", async () => {
  let enabled = false;
  const lane = freshLane({ enabled: () => enabled });
  lane.appendRange("s1", [userEvent(0, "User charts the SEAMOOR tides for the river ferry each morning".repeat(6))]);
  lane.provider.queue(lane.provider.memories(mem("User charts the SEAMOOR tides for the river ferry each morning", "User charts the SEAMOOR tides")));
  lane.advance(60_000);
  await lane.worker.pump();
  lane.advance(10_000);
  const parked = await lane.worker.pump();
  assert.equal(parked.claimed, 0);
  assert.equal(parked.deferred, 0, "disabled lane parks nothing");
  assert.equal(lane.kickTimer.handles().length, 0, "no timer for a disabled lane");
  enabled = true;
  lane.advance(60_000); // window elapsed
  const resumed = await lane.worker.pump();
  assert.equal(resumed.memories, 1, "first enabled pump drains the accepted range");
  assert.equal(lane.journal.listJobs({ sessionId: "s1" })[0].state, "done");
  endLane(lane);
});

// ===========================================================================
// 5. Journal ownership preserved under the pending drain: malformed retry
//    backoff unchanged, storm windows honored, no fabricated verdicts.
// ===========================================================================

check("malformed retry backoff unchanged: the pending drain still claims only after retry_after_at, no extra attempts, attempt budget accounting holds", async () => {
  const lane = freshLane();
  lane.provider.setFallback(lane.provider.malformed);
  lane.appendRange("m1", [userEvent(0, "User logs the NETTLEHANG mold spray cycle every third morning".repeat(6))],);
  // Round 1 (immediate): attempt 1 — malformed ⇒ retryable no-ack.
  lane.provider.queue(lane.provider.malformed());
  const r1 = await lane.worker.pump();
  assert.equal(r1.retryable, 1);
  assert.equal(lane.journal.listJobs({ sessionId: "m1" })[0].state, "queued");

  // Parked request inside the window; the kick fires at window end.
  lane.advance(10_000);
  const parked = await lane.worker.pump();
  assert.equal(parked.deferred, 1);
  lane.advance(20_000);
  lane.kickTimer.fire(lane.kickTimer.live()[0]);
  await settle();
  // Backoff (≥60s for a first no-ack) STILL owns claimability: the drained
  // window does not bypass the journal budget.
  const kickLine = lane.lines.find((l) => l.startsWith("journal extract: coalesced pending drain"));
  assert.ok(kickLine, "the kick ran its bounded round");
  const kickResult = JSON.parse(drainJson(kickLine));
  assert.equal(kickResult.claimed, 0, "retry_after_at holds inside the window kick");
  assert.equal(lane.provider.calls.length, 1, "no additional LLM attempt");
  assert.equal(lane.journal.listJobs({ sessionId: "m1" })[0].state, "queued");

  // After the backoff elapses the next window kick claims and re-attempts.
  lane.advance(60_000);
  const again = await lane.worker.pump(); // window elapsed since the kick round ⇒ immediate
  assert.equal(again.claimed, 1);
  assert.equal(again.retryable, 1);
  const job = lane.journal.listJobs({ sessionId: "m1" })[0];
  assert.equal(job.state, "queued");
  assert.equal(job.attemptsMade, 2, "exactly the committed attempt budget consumed (no hidden extra attempts under the drain)");
  assert.equal(lane.provider.calls.length, 2, "one LLM call per real attempt, none for parked requests");
  // Nothing may EVER be fabricated as a memory; the range stays unacknowledged.
  assert.equal(lane.store.searchMemories("NETTLEHANG", { injectableOnly: false }).length, 0);
  assert.deepEqual(lane.journal.getConsumedRanges("m1"), []);
  endLane(lane);
});

check("throttle storm prevention intact: immediate rounds stay ≥30s apart and every accepted range still drains exactly once", async () => {
  const lane = freshLane();
  const sessions = ["w1", "w2", "w3"];
  // Three ranges, three windows: each drained exactly once, at most one
  // immediate round per window (plus one coalesced kick per armed timer).
  lane.appendRange(sessions[0], [userEvent(0, "User acends for the THORNBAY ferry at first light each summer".repeat(6))]);
  lane.provider.queue(lane.provider.stop());
  await lane.worker.pump();
  assert.equal(lane.journal.listJobs({ sessionId: sessions[0] })[0].state, "done");

  lane.appendRange(sessions[1], [userEvent(0, "User trims the GRIMHOLLOW hedge on alternating market days".repeat(6))]);
  lane.advance(10_000);
  await lane.worker.pump(); // parked
  lane.appendRange(sessions[2], [userEvent(0, "User audits the SILVERBRIDGE toll ledger before each equinox".repeat(6))]);
  const secondParked = await lane.worker.pump(); // coalesces with the same latch, NO new timer
  assert.equal(secondParked.deferred, 1);
  assert.equal(lane.kickTimer.live().length, 1, "still ONE armed timer across the burst");
  lane.advance(20_000);
  lane.kickTimer.fire(lane.kickTimer.live()[0]);
  await settle();
  const states = sessions.map((s) => lane.journal.listJobs({ sessionId: s })[0].state);
  assert.deepEqual(states, ["done", "done", "done"], "every durably accepted range drained exactly once");
  const calls = lane.provider.calls.length;
  assert.equal(calls, 3, "one LLM call per drained chunk: w1 (first window) + w2 + w3 (the single kick round)");
  assert.deepEqual(lane.journal.getConsumedRanges("w2"), [{ fromSeq: 0, toSeq: 0 }]);
  assert.deepEqual(lane.journal.getConsumedRanges("w3"), [{ fromSeq: 0, toSeq: 0 }]);
  const consumed = sessions.flatMap((s) => lane.journal.getConsumedRanges(s));
  assert.ok(consumed.every((r) => r.fromSeq === r.toSeq), "each consumed range covers exactly its own chunk");
  endLane(lane);
});

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

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
console.log(failed === 0 ? "\nALL PASS" : `\nFAILURES: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
