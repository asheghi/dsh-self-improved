/**
 * Phase A lifecycle boundary: bounded SAFE shutdown policy for accepted work.
 *
 * Coordinator round 59 reproduced the previous `src/index.ts`
 * `registerShutdownDrain` implementation racing
 * `Promise.allSettled(acceptedJobs)` against a 5 s budget timer: when the timer
 * won, the old helper emitted a warning, CLEARED the tracking set, and closed
 * the SQLite store while accepted jobs were still running
 * (`closedWhileAcceptedJobRunning: true`). A warning is not cancellation and
 * not quiescence. This module replaces that contract:
 *
 *   ① `onShutdownStart` — every plugin lane refuses to ACCEPT new work
 *      (readModule()/pump wrappers/consent delegates in src/index.ts);
 *   ② `dropIngress` — the capture (`session/flush`) listener is unregistered;
 *      ingress closes before the drain starts (cordis re-disposes it
 *      idempotently later if it was already registered elsewhere);
 *   ③ `preClose` — consent-gated review and inactive-draft work are aborted
 *      through their owned gates, all process-local timers are locked out and
 *      tool/command/channel registrations are dropped;
 *   ④ the drain JOINS every ACCEPTED tracked job (the live set — see
 *      `trackAcceptedJob` in src/index.ts — never a stale snapshot):
 *        a. while the drain budget is left, it waits for settlement;
 *        b. AT THE DEADLINE it calls `cancel()` — the plugin aborts its OWNED
 *           cancellation signals for all accepted auxiliary lanes (combineAbortSignals
 *           ⊕ per-call timeout signals; review/draft consent gates) — and keeps
 *           waiting. Ownership of the pending jobs is RETAINED: the tracking
 *           set is never cleared and nothing is re-labelled "canceled";
 *        c. close is ALWAYS deferred until every accepted job in the live set
 *           has actually settled — including jobs tracked after the deadline.
 *          No run ever closes the store handle underneath running accepted
 *          work; a late commit therefore cannot be lost to an early close.
 *   ⑤ only then `close()` runs, exactly once.
 *
 * Honest bounded-vs-quiescence guarantee
 * ──────────────────────────────────────
 * - BOUNDED: if every accepted job settles (or cooperatively terminates via the
 *   owned abort signals) the fiber disposal completes within the drain budget
 *   (one extra short wait when the deadline had already elapsed). Every LLM
 *   lane this plugin owns also carries its own `AbortSignal.timeout(...)`
 *   (extract.timeoutMs for extraction, 180 s for consolidation/skills), so a
 *   healthy lane finishes or aborts inside those deadlines; `combineAbortSignals`
 *   unions them with the shutdown deadline. That path is the normal unload and
 *   it is bounded in practice.
 * - QUIESCENCE, NOT FORCE: this module cannot forcibly terminate third-party
 *   or noncooperative accepted work (an ignored `AbortSignal` with no internal
 *   timeout). For that residual case the storage close is explicitly DEFERRED
 *   (the fiber stays alive waiting for settlement) and the wait is announced
 *   with a repeated visible warning naming the count — there is no silent data
 *   loss, but there is also NO promise that unload terminates without such
 *   uncooperative work. Warning is the notification; deferral (never an early
 *   unsafe close) is the safety property.
 *
 * - The raced race/round timer is cleared on every exit path; when the drain
 *   finishes early it does not leave a pending 5 s `setTimeout` keeping the
 *   Node process alive after the boundary has completed.
 *
 * Exported so focused suites bind the SAME disposer apply() registers (real
 * cordis reverse disposal, a real store, real accepted pumps — not a
 * reimplementation).
 */
import type { Context } from "@deepseek-ai/cordis";

/** Bounded drain budget for accepted jobs before owned cancellation (5 s: under the host's own short shutdown window; extraction calls carry their own timeoutMs aborts, so a cooperative job always finishes well inside it). */
export const SHUTDOWN_DRAIN_BUDGET_MS = 5_000;

export interface ShutdownDrainTarget {
  /** ① ingress gate: every lane refuses NEW work once this runs. */
  onShutdownStart: () => void;
  /** ② drop the capture/flush ingress listener (idempotent dispose). */
  dropIngress: () => void;
  /** ③ cancel consent-gated review work, lock out timers, drop registrations. */
  preClose: () => void;
  /**
   * LIVE set of accepted jobs (`trackAcceptedJob` maintains it). Ownership is
   * retained by the drain until settlement: never cleared early, never
   * re-labelled. Jobs added after shutdown starts are still joined.
   */
  jobs: Set<Promise<unknown>>;
  /**
   * Optional deadline cancellation hook, invoked EXACTLY ONCE when the drain
   * budget first elapses with work still running. It must abort the plugin's
   * OWN cancellation signals for accepted auxiliary lanes (not just warn).
   * Omitted by binding suites without owned cancellable lanes.
   */
  cancel?: () => void;
  /** Close the (already quiesced) storage boundary; must be idempotent-safe. */
  close: () => void;
  /** Visible warning sink; warnings notify, they never replace cancellation. */
  warn: (message: string) => void;
}

/**
 * Effect-owned shutdown ordering (Phase A lifecycle boundary). Registered by
 * apply() LAST so cordis's reverse disposal order runs this disposer FIRST on
 * unload/restart/disable — the plugin's other effect-owned disposers run
 * after the store close has already happened (the "no running accepted work"
 * invariant above removes the old close-vs-pump race at its root).
 */
export function registerShutdownDrain(
  ctx: Context,
  target: ShutdownDrainTarget,
  label = "shutdown drain + store close",
): void {
  ctx.effect(() => () => {
    target.onShutdownStart();
    try {
      target.dropIngress();
    } catch (error) {
      target.warn("capture listener disposal error (continuing): " + String(error));
    }
    target.preClose();
    return (async () => {
      await drainAcceptedJobsThenClose(target);
    })();
  }, label);
}

/** Wait for a settlement snapshot within `budgetMs`; resolves `true` when all
 *  snapshot jobs settled first, `false` on deadline. The raced timer is ALWAYS
 *  cleared — the timeout must never survive the round to keep the process alive
 *  after the boundary finished (the old helper leaked that exact timer). */
function raceSettlement(snapshot: Promise<unknown>[], budgetMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let finished = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (settledFirst: boolean): void => {
      if (finished) return; // first outcome wins; the loser's timer/callback is cleaned up either way
      finished = true;
      clearTimeout(timer);
      resolve(settledFirst);
    };
    timer = setTimeout(() => finish(false), budgetMs);
    // allSettled never rejects; defensive clarity only.
    Promise.allSettled(snapshot).then(() => finish(true)).catch(() => finish(true));
  });
}

/**
 * The real guarantee: storage NEVER closes until every accepted job in the
 * LIVE tracking set has settled. Phases:
 *   - cooperative settle within the 5 s budget (normal case);
 *   - at the deadline: own-signal cancellation via `target.cancel()` exactly
 *     once, then further bounded settle rounds (ownership retained, count
 *     announced each round — deferred close, never close-under-running-work);
 *   - after the live set empties: exactly one `close()`.
 *
 * Settled jobs are remembered in a WeakSet bookkeeping: the set is CALLER-owned
 * (src/index.ts `trackAcceptedJob` removes entries on settle), but a bare
 * binding (direct suite usage) may keep settled promises in the set forever.
 * Re-checking such entries would spin the drain in a tight microtask loop, so
 * confirmed-settled entries are counted as settled and no longer waited on —
 * a genuinely unsettled job (in or out of bookkeeping) is always joined before
 * the close. `settledAll` is only ever true when every entry of the LIVE set
 * belongs to the confirmed-settled bookkeeping.
 */
async function drainAcceptedJobsThenClose(target: ShutdownDrainTarget): Promise<void> {
  let cancelled = false;
  let cancelError: unknown = null;
  const settledBookkeeping = new WeakSet<Promise<unknown>>();
  // Skip the timer entirely when nothing was ever accepted: a drain round with
  // an empty set must not create (or leak) any setTimeout at all.
  while (target.jobs.size > 0) {
    const unconfirmed: Promise<unknown>[] = [];
    for (const job of target.jobs) {
      if (!settledBookkeeping.has(job)) unconfirmed.push(job);
    }
    // Every entry in the live set has already confirmed settling (possibly a
    // caller that never removes settled entries): the boundary is quiesced.
    if (unconfirmed.length === 0) break;
    const settledBeforeDeadline = await raceSettlement(unconfirmed, SHUTDOWN_DRAIN_BUDGET_MS);
    if (settledBeforeDeadline) {
      for (const job of unconfirmed) settledBookkeeping.add(job);
      continue; // re-snapshot live additions/joined jobs
    }
    if (!cancelled) {
      cancelled = true;
      target.warn(
        `shutdown drain budget (${SHUTDOWN_DRAIN_BUDGET_MS}ms) elapsed with ${unconfirmed.length} accepted job(s) still running:` +
          " aborting owned cancellable auxiliary work through the plugin's own signals" +
          " and DEFERRING the store close until every accepted job actually settles" +
          " (close-under-running-work is disabled; ownership of pending jobs is retained, not wiped)",
      );
      try {
        target.cancel?.();
      } catch (error) {
        cancelError = error;
      }
      if (cancelError) {
        target.warn("shutdown deadline cancellation failed (continuing to defer close): " + String(cancelError));
      }
      continue;
    }
    target.warn(
      `still deferring storage close: ${unconfirmed.length} accepted job(s) have not settled since the shutdown deadline` +
        " (abort was delivered through owned signals; noncooperative work keeps the close deferred and announced" +
        " — the store stays open underneath it, nothing is closed mid-write)",
    );
  }
  target.close();
}

/**
 * Unite lane-local cancellation (e.g. `AbortSignal.timeout(this.settings.timeoutMs)`)
 * with a plugin-owned shutdown signal, so deadline cancellation reaches the
 * REAL owned transport path (`GenerateOptions.signal` → adapter must honor
 * options.signal; rc.2 dsh-llm contract) instead of only warning. The returned
 * signal aborts as soon as ANY input signal aborts (with the first abort's
 * reason). An already-aborted input is passed through unchanged so its reason
 * and settled state are preserved exactly.
 */
export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal {
  let aborted: AbortSignal | undefined;
  const live: AbortSignal[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) { aborted = signal; break; }
    live.push(signal);
  }
  if (aborted) return aborted;
  const controller = new AbortController();
  for (const signal of live) {
    signal.addEventListener(
      "abort",
      () => { controller.abort(signal.reason); },
      { once: true },
    );
  }
  return controller.signal;
}
