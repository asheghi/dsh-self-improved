# MIGRATION-SHUTDOWN-TESTS.md — workflow-14 shutdown-deadline safety (bounded safe close of accepted work)

Author: delegated lifecycle worker (workflow-14). Scope honored: targeted
lifecycle/LLM-cancellation/deferred-close snippets only — no whole-`index`
rewrite, no UI/business/importer/manifest/coordinator-doc/runtime-fixture
changes, no staging or commits, no active profile (3082/production DB/install
/dependency patch/exemption/generated-skill settings untouched), no external
model calls. All temporary stores are unique `os.tmpdir()` `mkdtempSync` trees
with guarded `finally`/`exit` cleanup.

## Confirmed defect being fixed (coordinator round 59)

`registerShutdownDrain` (previous `src/index.ts` 1135–1157) raced
`Promise.allSettled(acceptedJobs)` against a 5 s `setTimeout`: when the timer
won it WARNED, CLEARED the tracking set (`target.jobs.clear()`) and CLOSED the
store — while accepted jobs were still running. Independent coordinator probe
on a genuine Cordis Context with a job completing at `budget+100ms`:
`closedWhileAcceptedJobRunning:true, budgetWarningObserved:true` (exit 1).
A warning is not cancellation and not quiescence. The same helper also left the
raced 5 s timer alive after an early settle (keeps the Node process alive after
the boundary is done).

## Exact contracts verified before code (installed rc.2 evidence)

- `GenerateOptions.signal?` — "implementations must honor `options.signal`"
  (installed `dsh-llm` `lib/types/types.d.ts` `GenerateOptions`, adapter
  `stream(options)` doc). The genuine runtime
  (`dsh-v0.2/node_modules/@deepseek-ai/dsh-llm/lib/index.js`,
  `adapterStream`/`adapterFailureChunk`) converts an aborted request into a
  terminal `finish` chunk with `reason` `aborted` when `options.signal.aborted`
  — i.e. the wrapper's `evaluateTerminalFinish("aborted")` then refuses the
  output. Deadline cancellation therefore goes through the REAL transport, not
  a plugin-internal no-op.
- cordis 4.0.4 disposal (`cordis/lib/index.js` `fiber._unload`): disposables
  run per-effect and each returned promise (async teardown) IS awaited
  (`runDisposable(dispose)` → in-flight/returned task awaited inside
  `Promise.all(...)`), so the async drain disposer gates `fiber.dispose()`.
- `MemoryStore.close()` (`src/storage.ts:1181`): synchronous; `node:sqlite`
  handle closes under the caller. Closing while an accepted write is pending is
  exactly the "database is not open" loss mode reproduced by the negative
  lifecycle check in `scripts/test-v02-settings.mjs`.

## The fix (source regions changed)

### NEW `src/shutdown-v02.ts` (single implementation; sha256
`e00b900ec9f4fc2ddbb0dc113b31d76a455ba1ea7f762cf90a5bc1fb2c934d42`)

- `registerShutdownDrain(ctx, target, label)` — same export shape the suites
  bind; disposer registered LAST so cordis reverse-disposal runs it FIRST.
- `drainAcceptedJobsThenClose(target)` — the policy:
  1. ingress refuses new work (`onShutdownStart`), ingress listener dropped
     (`dropIngress`), consent abort + timer lockout + registration drops
     (`preClose`);
  2. live-set drain rounds: while the 5 s budget is left it joins settlements;
     the raced round timer is ALWAYS cleared (`raceSettlement` single
     finisher + `clearTimeout` — including the early-settle path);
  3. AT the deadline it warns and calls `target.cancel()` EXACTLY ONCE —
     the plugin aborts its OWNED signals (below);
  4. ownership RETAINED: the tracking set is never cleared and nothing is
     re-labelled; every subsequent round re-snapshots the LIVE set (jobs
     tracked after the deadline are joined), re-checked confirmed-settled jobs
     are remembered in a `WeakSet` so a bare binding cannot spin re-waiting
     settled-but-unremoved promises;
  5. `close()` runs exactly once, only after every accepted job in the live
     set has actually settled. An empty set never creates a timer at all.
- `combineAbortSignals(...signals)` — unites lane-local cancellation
  (e.g. `AbortSignal.timeout(extract.timeoutMs)`) with a plugin-owned shutdown
  signal; an already-aborted input is passed through unchanged (reason
  preserved); any live input's abort aborts the union with its reason.
- `SHUTDOWN_DRAIN_BUDGET_MS = 5_000` (unchanged bound).

### Targeted `src/index.ts` snippets (sha256 current
`b186a944deb9ef7189f25e618c3349eb2fe202e4b5e594b3dfdd7a4d643be0e7`;
the 456±142 git hunk-stat also contains earlier workers' uncommitted edits —
the hunks below are THIS worker's only index edits)

- `src/index.ts:40-41` — import `combineAbortSignals`, `registerShutdownDrain`
  from `./shutdown-v02.js`.
- `src/index.ts:519-524` — plugin-owned
  `shutdownDeadlineGate = new AbortController()` (the actual owned signal).
- `src/index.ts:252-257` — `makeLlmCall` LLM-wrapper snippet: abort a
  cancelled-before-start signal instead of opening a doomed provider stream;
  the existing per-chunk `throwIfAborted()` checks now see the united signal.
- `src/index.ts:633` — extraction pump lane: per-call timeout signal ⊕ owned
  shutdown signal → `GenerateOptions.signal`.
- `src/index.ts:684` — consolidation lane; `src/index.ts:713` — skill
  synthesis lane: same union.
  Episode-review lanes keep their pre-existing owned cancellation
  (`EpisodeReviewAbortGate` aborted in `preClose` BEFORE the drain) plus the
  shared gate abort again at deadline — no new wrapping needed there.
  (Pump/review/model lanes covered: flush pump, maintenance/nightly/startup
  pumps, manual evolve, dry-review, consolidation, skills, episode skills.)
- `src/index.ts:1113-1140` — drain target now carries
  `cancel: () => { episodeReviewGate.abort();
  shutdownDeadlineGate.abort(new Error("shutdown deadline reached: ...")); }`
  — deadline cancellation through actual owned signals.
- `src/index.ts:1140-1156` — the old raced helper/`ShutdownDrainTarget`
  implementation replaced by re-exports (single implementation; no
  reimplementation anywhere).
- Accepted-work tracking itself (`trackAcceptedJob`, `readModule` shutdown
  gate, flush-barrier returning the tracked pump) was already correct from the
  workflow-10 short-job race fix and is intentionally unchanged.

## The guarantee, precisely (and honestly)

- **Bounded (normal case):** if accepted work settles, or cooperatively
  terminates through the OWNED abort signals, fiber disposal completes within
  the drain budget (plus one short settlement wait if the deadline already
  elapsed). Every owned LLM lane carries its own `AbortSignal.timeout(...)`
  (extract `timeoutMs` default 60 s; consolidation/skills 180 s) united with
  the shutdown signal via `combineAbortSignals`, and the rc.2 adapter contract
  ("implementations must honor `options.signal`") makes that abort real.
- **Quiescence, not force (residual case):** an accepted job that IGNORES its
  abort signal and has no internal timeout cannot be force-terminated by
  plugin code. For that case the storage close is explicitly DEFERRED and the
  wait is announced with a deadline-shaped warning every budget round naming
  the count; the store handle stays OPEN underneath the running work — there
  is NO close-under-running-work, NO silent data loss, and NO unexplained
  unload hang (each round names what is pending and why). There is also NO
  promise that unload terminates without such genuinely noncooperative work.
- **Ownership invariant:** deadline cancellation never wipes pending
  ownership (`jobs.clear()` is gone); never closes the SQLite handle under a
  running accepted job; nothing accepted is re-labelled as "canceled". What a
  deadline-canceled lane loses is its IN-FLIGHT model output (an explicitly
  aborted extraction/review/consolidation), which is exactly the pre-existing
  consent/abort semantics of this plugin, never an acknowledgment of source
  evidence.
- **Timer hygiene:** no drain `setTimeout` survives any exit path —
  early settle clears the race timer (`getActiveResourcesInfo` has zero
  remaining `Timeout` entries); timeout rounds clear their own timer before
  the next round.

## Focused regression suite (NEW `scripts/test-v02-shutdown-safety.mjs`,
sha256 `a68586b2d6dee76d88b29c22f3974a81aaea75636e4f5273b60b0719bad1e471`)

Genuine rc.2 runtime classes (`DSH_RUNTIME_RC2` pinned — cordis 4.0.4, all
dsh peers 0.2.0-rc.2 asserted through the launcher script), the real exported
helper (asserted same module object as `lib/index.js` re-export), real memory
lane where demanded. 9/9 PASS, exit 0 (about 21 s wall: three checks cross the
5 s deadline by design):

1. fast drain: close on early settle, zero warnings, no leaked drain timer
   (`process.getActiveResourcesInfo()` — no remaining `Timeout`), dispose
   prompt (< 2 s);
2. deadline: accepted job settling at `budget+120ms` is NEVER closed under;
   ownership retained (no set wipe); first warning names owned-signal
   cancellation AND the DEFERRED close; close waited past the budget to actual
   settlement; no pending timer after a timeout round either;
3. deadline: owned cooperative abort — `cancel()` called exactly once at the
   deadline, own `AbortController` really aborted, job settles ≈30 ms after
   the deadline (beats its natural `budget+1.9s` path), close follows the
   settlement exactly once, single warning (no residual-round warning);
4. rejected accepted work — one job rejecting BEFORE the deadline and one
   rejecting ON the owned abort: close exactly once after settlement, no
   `unhandledRejection` (a recorded sink stays empty);
5. late arrival — a job tracked AFTER the deadline (`cancel()` schedules a new
   tracked job) is JOINED: close waited for both; no early close;
6. residual noncooperative work — a job ignoring cancellation beyond TWO
   deadline rounds keeps the close DEFERRED AND ANNOUNCED (≥2 warnings, second
   round names "still deferring storage close"), close only after the real
   settlement, store never closed mid-run;
7. real temporary MemoryStore — the accepted insert committing at
   `budget+100ms` lands BEFORE close (row present at the close boundary via
   pre-close read; not a "LOST" marker); a post-close write attempt fails
   loudly (no silent post-close write path exists);
8. `combineAbortSignals` semantics — already-aborted pass-through with reason,
   live-union abort with first reason, unfired timeouts stay live;
9. the REAL aux-LLM wrapper — genuine exported `makeLlmCall` + the exact
   `apply()` wiring shape: the UNITED signal is forwarded into
   `GenerateOptions.signal` (asserted identity) and the request rejects
   promptly on the owned deadline abort (< 5 s, not the 60 s unconformable
   failsafe).

## Existing regressions (unchanged files, run post-fix, all exit 0)

- `scripts/test-v02-shutdown-timeout.mjs` (coordinator's durable probe):
  **PASS** — "storage must not close while an accepted job still runs". It now
  passes for the SAFE reason: the accepted job is joined and the close is
  deferred until its actual settlement (not because the set was cleared).
- `scripts/test-v02-settings.mjs` 14/14 PASS — including the D1 negative
  (pre-fix close-first ordering loses the accepted insert) and the positive
  `registerShutdownDrain` joined-commit lifecycle regression on a REAL store;
- `scripts/test-phase-a.mjs` PASS; `scripts/test-v02-safety.mjs` 60/60 PASS;
- `scripts/test-hermes.mjs` ALL PASS; `test-storage`, `test-extract`,
  `test-episode-review`, `test-evolve`, `test-commands` all exit 0.
- Strict rc.2 typecheck + `--emit-lib` re-run with the explicit
  `DSH_RUNTIME_RC2=/home/bahman/github/dsh-v0.2`: PASSED (cordis 4.0.4, all
  dsh peers exactly 0.2.0-rc.2, schemastery 3.18.4; source strict, dependency
  declarations skipped via skipLibCheck as configured).

## Built artifact hashes (post-fix rc.2 build emitted to `lib/`)

```
lib/index.js          289013683e08653bc662fe834c0d4e2d2dfdb873910e30c3ed17f0ddb39cd524
lib/shutdown-v02.js   53f64b08848d1c5df970656f25275bc523ffe77d0ad3458bee934af6c2b0c8ec
```
(`lib/` is a generated directory also written by other workers' rebuilds; the
hashes pin THIS verification's exact bytes.)

## Honestly not solved / not claimed

1. **Phase B durability remains Phase B:** no claim of atomic crash-recovery,
   consumed-range acknowledgment, or exactly-once execution here. The
   deadline path abandons in-flight model output on purpose; source evidence
   is never acknowledged by this work.
2. **Force-termination is impossible in-process:** for work that ignores its
   abort signals AND has no internal timeout, safe unload waits (announced
   every round). A hard "abandon and close" policy would be the original
   defect; it is intentionally NOT restored.
3. **Post-deadline pump iteration is fast-fail, not instant halt:** the
   extractor's pending-session loop continues after the deadline and each
   remaining session's model call fails immediately on the united signal
   (counted as `errors`). Instant loop-interruption inside `Extractor.pump`
   would require an owned boolean through `src/extract.ts` — not this worker's
   file; the bounded budget already gates this with loop cost ≈ per-run
   constant work per pending session. Recorded here for a future targeted
   improvement, not silently dropped.
4. **Lane-level deadline cancellation was verified at the exact wrapper
   boundary** (genuine `makeLlmCall` + a contract-conforming adapter stub), not
   against a mounted host with a live provider route; the mounted round-trip
   belongs to the runtime-fixture owners (workflows 5/9/13).
5. Nothing was staged or committed; `package.json`/manifests, UI/business
   files, importer, runtime fixture test/report and coordinator documents were
   not modified by this work.
