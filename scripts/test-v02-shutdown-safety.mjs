#!/usr/bin/env node
/**
 * Focused shutdown-deadline safety suite (workflow-14, MIGRATION-SHUTDOWN-TESTS.md).
 *
 * Coordinator round 59 reproduced the previous drain helper closing the store
 * WHILE accepted jobs still ran after the 5 s budget (`registerShutdownDrain`
 * warned, wiped the tracking set and closed). These checks bind the SAME
 * exported helper the plugin registers (`lib/index.js` re-exports
 * `src/shutdown-v02.ts`), a GENUINE rc.2 cordis Context, and a REAL temporary
 * MemoryStore — no profile, no live settings, no provider, no production data,
 * no external model. All temporary directories are unique `os.tmpdir()`
 * mkdtemp trees and removed in guarded `finally` cleanup.
 *
 * Exit 0 = every check passed; any failure exits 1.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RD = process.env.DSH_RUNTIME_RC2 ?? "/home/bahman/github/dsh-v0.2.1";
/** Genuine rc.2 runtime classes (same access pattern as scripts/test-v02-settings.mjs). */
const runtime = (pkg, file = "lib/index.js") => import(`${RD}/node_modules/@deepseek-ai/${pkg}/${file}`);
const manifestOf = (pkg) => JSON.parse(readFileSync(`${RD}/node_modules/@deepseek-ai/${pkg}/package.json`, "utf8"));

const cordis = await runtime("cordis");
assert.equal(manifestOf("cordis").version, "4.0.5", "genuine rc.2 runtime cordis version pinned");
const { MemoryStore } = await import(join(repo, "lib/storage.js"));
const { registerShutdownDrain, combineAbortSignals, SHUTDOWN_DRAIN_BUDGET_MS } = await import(join(repo, "lib/index.js"));
const shutdownModule = await import(join(repo, "lib/shutdown-v02.js"));
assert.ok(shutdownModule.registerShutdownDrain === registerShutdownDrain, "lib/index.js re-exports the single real implementation (no reimplementation)");

const checks = [];
const check = (name, fn) => checks.push({ name, fn });
const timeoutResources = () => process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
const BUDGET = SHUTDOWN_DRAIN_BUDGET_MS;
assert.equal(BUDGET, 5_000, "drain budget stays the documented 5s");

let unhandledRejections = [];
const rejectionSink = (reason) => { unhandledRejections.push(String(reason)); };
process.on("unhandledRejection", rejectionSink);

/** Unique owned temp dir with guarded cleanup — no shared fixture paths. */
const ownTempDirs = [];
const ownTemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownTempDirs.push(dir);
  return dir;
};
const cleanupTemps = () => {
  for (const dir of ownTempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort under tmpdir */ }
  }
};
process.on("exit", cleanupTemps);

// ── 1. Fast drain: the settle race must clear its own timeout ──────────────
check("fast drain: close on early settle, zero warnings, no leaked drain timer keeping the process alive", async () => {
  const base = timeoutResources();
  const jobs = new Set([new Promise((r) => setTimeout(() => r("done"), 20))]);
  const warnings = [];
  let closes = 0;
  const ctx = new cordis.Context();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    jobs, close() { closes++; }, warn(m) { warnings.push(m); },
  });
  const started = performance.now();
  await ctx.fiber.dispose();
  const elapsed = performance.now() - started;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(closes, 1, "exactly one close, at the settle boundary");
  assert.deepEqual(warnings, [], "no budget warning when every job settled inside the drain budget");
  assert.ok(elapsed < 2_000, `disposal completed promptly on early settle (elapsed ${elapsed.toFixed(0)}ms)`);
  assert.equal(timeoutResources(), base, "no pending drain timer remains after early completion (getActiveResourcesInfo)");
});

// ── 2. Deadline: an accepted job beyond the budget is NEVER closed under ───
check("deadline: noncooperative accepted job > budget keeps ownership; close deferred until it actually settles", async () => {
  const base = timeoutResources();
  let settled = false;
  const job = new Promise((resolve) => setTimeout(() => { settled = true; resolve("late"); }, BUDGET + 120))
    .then((v) => v);
  const jobs = new Set([job]);
  // Real tracking semantics (src/index.ts trackAcceptedJob): the set entry is
  // removed when the job settles, so a finished boundary leaves no residue.
  void Promise.resolve(job).finally(() => { jobs.delete(job); return undefined; }).catch(() => {});
  const warnings = [];
  let closeWhileRunning = false;
  let closeTime = 0;
  const ctx = new cordis.Context();
  const started = performance.now();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    cancel() { /* not wired in this binding; the DEFERRED close is the guarantee under test */ },
    jobs,
    close() { closeWhileRunning = !settled; closeTime = performance.now() - started; },
    warn(m) { warnings.push(m); },
  });
  await ctx.fiber.dispose();
  await job;
  assert.equal(closeWhileRunning, false, "storage did not close while the accepted job was still running");
  assert.equal(jobs.size, 0, "tracking set settled: ownership retained until settlement, then no residue");
  assert.ok(warnings.length >= 1, "the deadline was announced, not silent");
  assert.match(warnings[0] ?? "", /aborting owned cancellable auxiliary work/i, "deadline warning names owned-signal cancellation, not a silent close");
  assert.match(warnings[0] ?? "", /DEFERRING the store close/i, "deadline warning states the deferred (safe) close, replacing the old warn-then-close contract");
  assert.ok(closeTime >= BUDGET, `close waited past the budget until actual settlement (close at ${closeTime.toFixed(0)}ms)`);
  assert.ok(closeTime < BUDGET + 3_500, `deferred close stayed bounded by the job itself (close at ${closeTime.toFixed(0)}ms)`);
  assert.equal(timeoutResources(), base, "no pending drain timer survives a timeout round either");
});

// ── 3. Owned cooperative cancellation: deadline abort settles work fast ───
check("deadline: owned cooperative abort settles the accepted job promptly; close follows the settlement (not the deadline+job-lifetime)", async () => {
  const gate = new AbortController();
  let settled = false;
  // Natural completion would be at budget+1900ms; the cooperative abort path
  // settles ~30ms after the drain calls cancel() at the deadline.
  const job = new Promise((resolve, reject) => {
    const natural = setTimeout(() => { settled = true; resolve("natural"); }, BUDGET + 1_900);
    gate.signal.addEventListener("abort", () => {
      clearTimeout(natural);
      setTimeout(() => { settled = true; resolve("aborted-cooperatively"); }, 30);
    }, { once: true });
  });
  const jobs = new Set([job]);
  const warnings = [];
  let cancelCalls = 0;
  let closeWhileRunning = false;
  let closeTime = 0;
  const ctx = new cordis.Context();
  const started = performance.now();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    cancel() { cancelCalls++; gate.abort(new Error("owned deadline abort")); },
    jobs,
    close() { closeWhileRunning = !settled; closeTime = performance.now() - started; },
    warn(m) { warnings.push(m); },
  });
  await ctx.fiber.dispose();
  await job;
  assert.equal(cancelCalls, 1, "the drain cancels owned work exactly once, at the deadline");
  assert.equal(gate.signal.aborted, true, "the owned cancellation signal was really aborted (not a warning-only path)");
  assert.equal(closeWhileRunning, false, "close never reran underneath the still-settling job");
  assert.ok(closeTime < BUDGET + 900, `cooperative cancellation beat the job's natural completion (close at ${closeTime.toFixed(0)}ms)`);
  assert.ok(closeTime >= BUDGET, "cancellation happens at the deadline, not before it");
  assert.equal(warnings.length, 1, "cooperative path announces the deadline once (no residual-wait round warnings)");
  assert.ok(!warnings.join(" ").includes("still deferring storage close"), "no residual-wait warning when the owned abort actually settles the work");
});

// ── 4. Rejected accepted work must not crash the drain or delay close ──────
check("rejected accepted work (before and after deadline) settles, closes once, no unhandled rejection", async () => {
  const gate = new AbortController();
  const earlyReject = new Promise((_, reject) => setTimeout(() => reject(new Error("synthetic early lane failure")), 60));
  const lateReject = new Promise((_, reject) => {
    const natural = setTimeout(() => reject(new Error("synthetic late lane failure")), BUDGET + 1_800);
    gate.signal.addEventListener("abort", () => { clearTimeout(natural); reject(gate.signal.reason); }, { once: true });
  });
  const jobs = new Set([earlyReject, lateReject]);
  const warnings = [];
  let closes = 0;
  const ctx = new cordis.Context();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    cancel() { gate.abort(new Error("owned deadline abort")); },
    jobs,
    close() { closes++; },
    warn(m) { warnings.push(m); },
  });
  await ctx.fiber.dispose();
  await Promise.allSettled([earlyReject, lateReject]);
  assert.equal(closes, 1, "close ran exactly once after every rejected job settled");
  assert.ok(unhandledRejections.length === 0, `no unhandledRejection leaks from settled rejections (got: ${unhandledRejections.join("; ")})`);
});

// ── 5. Late arrival: a job tracked after the deadline is still joined ──────
check("late arrival: ownership is retained across deadline rounds; a job added after cancel is joined before close", async () => {
  let settled1 = false;
  let settled2 = false;
  const job1 = new Promise((resolve) => setTimeout(() => { settled1 = true; resolve("first"); }, BUDGET + 60));
  const job2 = new Promise((resolve) => setTimeout(() => { settled2 = true; resolve("late-arrival"); }, 90));
  const jobs = new Set([job1]);
  const warnings = [];
  let closeWhileRunning = false;
  const ctx = new cordis.Context();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    cancel() {
      // A tracked pump slipping in after the deadline (already-scheduled
      // callback race): it must be JOINED, never wiped as if canceled.
      setTimeout(() => jobs.add(job2), 10);
    },
    jobs,
    close() { closeWhileRunning = !(settled1 && settled2); },
    warn(m) { warnings.push(m); },
  });
  await ctx.fiber.dispose();
  await Promise.allSettled([job1, job2]);
  assert.equal(closeWhileRunning, false, "close waited for BOTH the deadline runner and the late arrival");
  assert.match(warnings[0] ?? "", /DEFERRING the store close/i, "the deadline warning announces the safe deferred close (rounds are quiet when work settles in time)");
});

// ── 5b. Residual noncooperative work: the deferred close is ANNOUNCED repeatedly ──
check("residual work beyond the abort's second round keeps the close deferred and announced (never closed mid-run, never silent)", async () => {
  let settled = false;
  // Ignores cancellation signals entirely and outlasts TWO deadline rounds
  // (settles only in a third round): honest guarantee under test = repeated
  // announcement + deferred close, not force termination.
  const job = new Promise((resolve) => setTimeout(() => { settled = true; resolve("stubborn"); }, BUDGET * 2 + 200));
  const jobs = new Set([job]);
  const warnings = [];
  let closeWhileRunning = false;
  let closeTime = 0;
  const ctx = new cordis.Context();
  const started = performance.now();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    cancel() {},
    jobs,
    close() { closeWhileRunning = !settled; closeTime = performance.now() - started; },
    warn(m) { warnings.push(m); },
  });
  await ctx.fiber.dispose();
  await job;
  assert.equal(closeWhileRunning, false, "the store stayed open underneath the stubborn job until it settled");
  assert.ok(warnings.length >= 2, `the remaining wait is announced every deadline round (got ${warnings.length} warning(s))`);
  assert.match(warnings[1] ?? "", /still deferring storage close/i, "the residual round names the deferral explicitly instead of implying progress");
  assert.ok(closeTime >= BUDGET * 2, `close waited all announced rounds until real settlement (close at ${closeTime.toFixed(0)}ms)`);
});

// ── 6. Real temporary MemoryStore: an accepted write beyond the deadline is not lost ──
check("real store: accepted insert committing after the budget lands BEFORE close; no write can follow the close", async () => {
  const dir = join(ownTemp("dsi-shutdown-store-"), "store");
  const store = new MemoryStore(dir);
  let settled = false;
  const job = new Promise((resolve) => {
    setTimeout(() => {
      try {
        const record = store.insertMemory(
          { kind: "fact", content: "accepted-after-deadline insert must not be lost", importance: 6 },
          { provenance: "extraction", source: "shutdown-safety-test", scope: "global" },
        );
        settled = true;
        resolve(record.id);
      } catch (error) {
        settled = true;
        resolve("LOST:" + String(error.message ?? error));
      }
    }, BUDGET + 100);
  });
  const jobs = new Set([job]);
  const warnings = [];
  let closeWhileRunning = false;
  let rowsAtClose = [];
  const origClose = store.close.bind(store);
  store.close = () => {
    closeWhileRunning = !settled;
    // Read the accepted rows BEFORE the handle closes (no post-close reads).
    rowsAtClose = store.listMemories({ limit: 10 }).map((r) => r.content);
    origClose();
  };
  const ctx = new cordis.Context();
  registerShutdownDrain(ctx, {
    onShutdownStart() {}, dropIngress() {}, preClose() {},
    cancel() {},
    jobs,
    close() { store.close(); },
    warn(m) { warnings.push(m); },
  });
  await ctx.fiber.dispose();
  const inserted = await job;
  assert.equal(closeWhileRunning, false, "the store handle stayed open underneath the accepted write until it settled");
  assert.match(String(inserted), /./, "the insert path returned a value, not a loss marker");
  assert.ok(!String(inserted).startsWith("LOST"), `the accepted commit was not lost to an early close (got: ${inserted})`);
  assert.deepEqual(rowsAtClose, ["accepted-after-deadline insert must not be lost"], "the accepted row is durable data at the close boundary, not a race loser");
  // No late write after close: nothing accepted is still running, and a late
  // attempt against the closed handle fails loudly (no silent post-close write).
  let lateWriteError = null;
  try {
    store.insertMemory({ kind: "fact", content: "late write attempt", importance: 1 }, {});
  } catch (error) {
    lateWriteError = error;
  }
  assert.ok(lateWriteError, "writing after the quiesced close fails loudly (handle owner closed once, after settlement)");
});

// ── 7. Deadline-cancellation helper: exact signal union semantics ──────────
check("combineAbortSignals: already-aborted pass-through preserves reason; live union aborts with the first reason; non-aborting inputs leave it live", () => {
  const preAborted = new AbortController();
  preAborted.abort(new Error("pre-aborted reason"));
  assert.ok(combineAbortSignals(undefined, preAborted.signal).reason instanceof Error, "an already-aborted input is passed through, reason preserved");
  const timeSignal = AbortSignal.timeout(10_000);
  const owned = new AbortController();
  const united = combineAbortSignals(timeSignal, owned.signal);
  assert.equal(united.aborted, false, "live inputs leave the union signal live");
  const reason = new Error("owned deadline abort");
  owned.abort(reason);
  assert.equal(united.aborted, true, "aborting any live input aborts the union");
  assert.equal(united.reason, reason, "the union aborts with the first input's reason");
  const laneTimeout = AbortSignal.timeout(10);
  const unitedTimeout = combineAbortSignals(laneTimeout, new AbortController().signal);
  assert.equal(unitedTimeout.aborted, false, "unfired per-call timeouts keep the union live before their own deadline");
});

// ── 8. The REAL aux-LLM wrapper honors the owned deadline abort ────────────
check("aux LLM lane (genuine makeLlmCall + combineAbortSignals): the owned shutdown signal aborts the REAL request transport, not a warning", async () => {
  const { makeLlmCall } = await import(join(repo, "lib/index.js"));
  /** A conforming rc.2 adapter stub: it hangs until `options.signal` aborts
   *  (the dsh-llm adapter contract: implementations must honor
   *  options.signal). If the wrapper did not forward the united signal, the
   *  call would only settle at the 60s stub failsafe. */
  let streamedOptions = null;
  const ctx = {
    llm: {
      async *stream(options) {
        streamedOptions = options;
        await new Promise((_, reject) => {
          if (options.signal.aborted) {
            // Conforming adapters honor an already-aborted request signal at
            // settle time (same discipline as the wrapper's pre-stream
            // throwIfAborted); async generators start in a later microtask.
            reject(options.signal.reason ?? new Error("aborted by owned deadline signal"));
            return;
          }
          const failsafe = setTimeout(() => reject(new Error("adapter failed safe: signal never honored")), 60_000);
          options.signal.addEventListener("abort", () => {
            clearTimeout(failsafe);
            reject(new Error("aborted by owned deadline signal"));
          }, { once: true });
        });
        yield { type: "text", text: "unreachable" };
      },
    },
  };
  const config = { extract: { provider: "go-opencode", model: "glm-5.3-flash" } };
  const auxCall = makeLlmCall(ctx, config, "memory-extract", 512);
  const owned = new AbortController();
  const laneTimeout = AbortSignal.timeout(60_000);
  const united = combineAbortSignals(laneTimeout, owned.signal); // the exact apply() wiring shape
  const started = performance.now();
  // Abort is delivered WHILE the request is in flight: the call promise is
  // created first, the owned deadline abort fires synchronously, and only then
  // do we await the settlement.
  const callPromise = auxCall({ system: "synthetic", user: "synthetic", signal: united })
    .then(() => "completed", (error) => "rejected:" + String(error?.name ?? error));
  owned.abort(new Error("owned deadline abort"));
  const outcome = await callPromise;
  const elapsed = performance.now() - started;
  assert.ok(streamedOptions && streamedOptions.signal === united, "the wrapper forwarded the UNITED signal into GenerateOptions.signal (real transport)");
  assert.match(outcome, /^rejected:Error:? ?/i, `the aux lane rejected on the deadline abort instead of hanging (outcome: ${outcome})`);
  assert.ok(elapsed < 5_000, `the abort reached the transport promptly (${elapsed.toFixed(0)}ms), not at the 60s stub failsafe`);
});

let failures = 0;
for (const { name, fn } of checks) {
  unhandledRejections = [];
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${name}`);
    console.error(error && error.stack ? error.stack : String(error));
  }
}
if (unhandledRejections.length > 0) failures++;
if (failures > 0) {
  console.error(`shutdown-safety: ${failures} failed check(s)`);
  process.exit(1);
}
console.log("shutdown-safety: all checks passed");
