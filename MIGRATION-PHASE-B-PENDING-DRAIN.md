# MIGRATION-PHASE-B-PENDING-DRAIN.md — MIN_PUMP_INTERVAL_MS defect repaired (owner lane: extract-journal-v02)

Status: **implemented and locally regression-tested. NO git commits (working
tree only), no production store/profile, no external provider, no network, no
live profile, no port 3082, no plugin-manager/skill activation.** This is a
small provable bug repair, NOT a redesign: verdicts, leases, acks, the
journal's deterministic `retry_after_at`/backoff/attempt budget and the 30s
immediate-round gate are untouched; only the two historical silent drops are
gone.

Source pin (current working tree, this repair):

- `src/extract-journal-v02.ts` — sha256 `029a28e5ab58c6394e6f784292fa9fe1acb1826b383e7675e12bf3a8acf67d92`
  (contract block lines 56–64; `JournalExtractPumpResult.deferred` line 337;
  `MIN_PUMP_INTERVAL_MS` line 460; `createJournalExtractWorker` line 483;
  `scheduleKick` 510 / `drainKick` 531 / `startRound` 564 /
  `dispose` 645 / `runRound` 665 — anchors of the final file).
- `lib/extract-journal-v02.js` — sha256 `ce27732d9954d93e546bc2aa6f5bb52d98f7a176a48cf00c90522b53f450cb00`;
  `lib/extract-journal-v02.d.ts` — sha256
  `700a9a0ac0ff5613edd9b0cf7e96458b141d0fde33b0c654e816070e4554ad18` (see §6
  build pin).
- Focused suite: `scripts/test-v02-extract-pending-drain.mjs` (sha256 `799dc764…`).

Basis: [MIGRATION-PHASE-B-RUNTIME-REVIEW.md](<MIGRATION-PHASE-B-RUNTIME-REVIEW.md>)
§4 table + §5 finding (case4/case5 throttle XFAILs), confirmed by direct read
of the review log; the runtime runner
([scripts/test-v02-runtime.mjs](<scripts/test-v02-runtime.mjs>))
`EXTRACT_GAP_MS = 31_000` note and the `xfail → XPASS` machinery are runtime32's
surface: this document pins what the runner should find so the reclassification
is mechanical (§7).

## 1. The defect (verified against the current checkpoint)

`createJournalExtractWorker.pump()` had two SILENT drop paths for a pump
request that could not start a round:

1. **In-window drop** (`now - lastPumpAt < MIN_PUMP_INTERVAL_MS`): the request
   returned an empty result and vanished. DSH drives `pump()` at multiple
   flush checkpoints and the maintenance/review/backfill timers (src/index.ts
   drive points ≈724, 838, 909); a range accepted during a run whose next
   in-process drive falls inside the 30s window stayed `queued` (source
   unconsumed) until ANOTHER external driver fired after the window — the
   durable-work quiescence reviewed as case4 "THROTTLE-EXCLUSION" and case5
   gate #5, both honest XFAILs.
2. **Reentrant drop** (`pumping === true`): a pump request overlapping the
   in-flight round returned an empty result immediately; that request was
   lost (trailing drain existed conceptually in the reviewer's slam but NEVER
   ran).

Neither path warned or counted; the suite caught them only from journal
state.

## 2. The repair — bounded owned coalesced pending kick / trailing drain

One-worker, no new journal APIs, no new verdict kinds, no events, no polling
loops, no sleeps. The worker now owns:

- `pendingKickCount` — coalesced pump requests parked for a drain.
- `scheduleKick()` / at most ONE `kickTimer` (one-shot, `unref`'d, delay =
  remaining throttle window; ≥1s floor so a long in-flight round can never
  drive a sub-second recheck chain).
- `startRound()` — single-flight chain: ONE immediate claim round
  (`runRound()`, loop semantics byte-for-byte the pre-fix claim loop) plus AT
  MOST ONE trailing round when requests parked while it ran; leftover
  requests re-arm the (only) timer for the next window.
- `drainKick()` — timer fire: consumes the latch exactly once, or drops it
  loudly when the module is disabled or the owned lane is closing.
- `dispose()` — REQUIRED close hook (§5): clears the timer, drops parked
  requests, and makes every later pump a no-op. Idempotent. An already
  aborted `deadlineSignal` behaves like close at pump entry (no claims, no
  timer, honest empty result).

### 2.1 Request disposition matrix

| Request arrives | Before (defect) | After |
| --- | --- | --- |
| window elapsed, no flight | immediate round | immediate round (unchanged) |
| inside window, no flight | **silent drop** | result `{claimed:0, deferred:1}` + latch + ONE armed timer at window end |
| overlapping an in-flight round | **silent empty return** | result `{claimed:0, deferred:1}` + latch; the chain runs ONE bounded trailing round right after the current round ends — accepted work that arrived mid-flight drains WITHOUT another external flush |
| module disabled | empty result | empty result (unchanged; nothing parked, nothing armed, `deferred:0`) |
| lane closing (`deadlineSignal.aborted`) | window-gated round start | honest empty result, NO late claim/timer/stored work |
| after `dispose()` | (n/a) | honest empty no-op, forever; durable accepted work is `recoverStartup`'s on next boot |

`JournalExtractPumpResult` gains ONE additive counter `deferred`
("requests coalesced into the owned pending drain; the serving round reports
the requests it served"). `emptyJournalExtractPump()` includes `deferred: 0`;
the runtime's verbatim-shape logging in src/index.ts keeps working. No
existing field or method changed; `JournalExtractWorker` receives the
additive `dispose(): void`; `JournalExtractWorkerDeps` receives the additive
optional `timer?: JournalExtractScheduleTimer` (production default = real
`setTimeout`+`unref`; tests inject the controlled one-shot fake used by the
focused suite).

### 2.2 Why this cannot storm

- Immediate rounds remain gated by `MIN_PUMP_INTERVAL_MS = 30_000`
  (storm parity with lib/extract.js, unchanged).
- Every chain = ≤2 rounds (immediate + one trailing). No chain loops; a
  further drain requires ANOTHER real external request.
- At most ONE armed one-shot timer, re-armed only with parked requests, delay
  ≥ remaining window (or the 1s recheck floor while an in-flight chain is
  still draining — the timer may not burn CPU, it stats pause only).
- The journal owns retry_after_at/completations: a kicked round of a
  no-acked job simply finds nothing claimable (proved by the focused
  malformed-backoff test) and re-arms nothing unless new requests parked.
- Unbounded-call probe: 10 overlapping bursts during one flight ⇒ ONE chain,
  10 parked, at most one trailing round, one LLM call per real chunk (the
  focused suite asserts the exact call counts).

## 3. Semantics notes for reviewers

- `deferred` reporting is per-result: a parked call snapshot reports 1; the
  chain/or drain result reports the requests it SERVED
  (`startRound(parkedAtStart)` + the trailing round's consumed count).
  Disposed requests are reported dropped in the dispose log line and never
  appear as served.
- The in-flight round is never aborted by `dispose()` — the retry budget and
  per-chunk deadline/receipt ownership own that path (dispose mid-flight: the
  round's commits stand, the parked requests are dropped loudly, and no
  trailing/kick work follows close). The focused suite pins this exactly.
- Fast path unchanged for every existing drive point: window-elapsed flush
  pumps run the full in-barrier round as before; in-window pumps return with
  the SAME latency as the old silent drop (never stalls a flush barrier on
  the 30s window).

## 4. Runtime-review XFAIL → XPASS expectations (runtime32 machinery)

- **case5 gate #5** "second pump returns claimed=0 with no LLM call while the
  second range is durably queued+unconsumed": after the repair the same
  observation holds at the instance of the second pump (claimed=0,
  deferred=1, queued+unconsumed), and per the review's own note (§2.5 item 7)
  the formulation flips to "second pump drained by the owned kick": observe
  the journal after the window fires WITHOUT calling pump again — job `done`,
  source consumed, exactly one extra LLM call. XPASS triggers on the drained
  state.
- **case4 THROTTLE-EXCLUSION** "subsequent ranges accepted during the resumed
  run remain pending": after the repair the resumed run's in-window pumps
  park; ranges drain by `scheduleKick`/trailing without another external
  flush as long as the process stays alive ≥ the remaining window. Control
  (after the window the same worker drains the same accepted range) now
  trivially passes; the gate's strict form becomes "every accepted pre-disable
  AND during-run range ended `done` with consumed coordinates within the
  process lifetime of its pause-resume run".
- The focused suite
  ([scripts/test-v02-extract-pending-drain.mjs](<scripts/test-v02-extract-pending-drain.mjs>))
  already runs the promote-worthy journal-state formulations on the REAL
  store (real SQLite + real journal): 10/10 strict PASS, no XFAILs left.

## 5. REQUIRED close hook — owner34 wiring recipe (index.ts is owner34's)

`createJournalExtractWorker` now exposes `dispose()`. The runtime owner
should wire it in `registerShutdownDrain` `preClose` next to the timer
dismantling (before `close: () => store.close()` runs), one line:

```ts
preClose: () => {
  episodeReviewGate.abort();
  if (timer) { clearInterval(timer); timer = undefined; }
  // …existing cleanup…
  // NEW (this repair): stop ALL late extract-worker scheduled work.
  journalExtract.dispose();
  // …
}
```

Ordering guarantees that make the wiring safe (verified by the focused
suite): `dispose()` does NOT abort an in-flight round (the shutdown deadline
signal + per-chunk abort release + closed-journal stops own that path, and
the drain's accepted-job tracking still covers the round promise); it only
stops LATE work (pending kick timer + coalesced latch), after which `pump()`
is an empty no-op and the journal's `recoverStartup` on next boot owns the
durable remainder. Until wired, closing behavior degrades OPENLY: a pending
timer firing after the store close hits the existing
`JournalContractError("closed")` path (warn once, no round, no crash).

DoNOT widen: the kick round is deliberately NOT in `acceptedJobs` — the
flush/shutdown barriers must never stall on the 30s window; drain coverage
within the process is the worker's own timer, and the process-boundary
remainder is `recoverStartup`'s (documented: journal ingress close note in
src/index.ts dropIngress).

## 6. Test + build evidence

| Suite | Count | Status |
| --- | --- | --- |
| `node scripts/test-v02-extract-pending-drain.mjs` (NEW, this repair) | 10 checks | 10/10 PASS |
| `node scripts/test-v02-extract-journal.mjs` (existing extract-lane regressions, incl. the re-entrancy/30s-throttle regression which stays honest: overlap ⇒ claimed=0 + `deferred:1`) | 20 checks | 20/20 PASS |
| Scoped strict typecheck (extract-journal-v02 full import closure under the exact rc.2 peer set / coordinator-test-site default) | module + closure | PASS |
| Repo-wide `node scripts/typecheck-v02.mjs` (the strict build gate) | whole tree | **BLOCKED — pre-existing, outside this lane:** `src/index.ts(607,614,622)` `TS2304 Cannot find name 'episodeConsentOn'` + `src/business.ts(563,37)` `TS2554 Expected 1 arguments, but got 2` (other owners' in-flight edits). The failure list contains ZERO errors against `src/extract-journal-v02.ts` or this lane's closure. |

Build pin honesty: because the guarded `--emit-lib` emit runs only after the
STRICT WHOLE-TREE compile passes, the repo `lib/` could not be fully
rebuilt while `src/index.ts`/`src/business.ts` fail. The installed
`lib/extract-journal-v02.js`(.d.ts) therefore carries the bytes produced by
the SAME generator (typecheck-v02 scratch emitter, identical compilerOptions
and peer set) for this module's full import closure — every OTHER emitted
closure file verified byte-identical (cmp) against the currently-installed
lib, so the overlay changes ONLY this lane's artifact. Once owner34 fixes
their lane, `node scripts/typecheck-v02.mjs --emit-lib` will keep these two
files at the exact pinned hashes and refresh the rest.

## 7. Remaining interface issues (not fixed here, owner surfacing)

1. **Close hook not yet WIRED** in src/index.ts (`journalExtract.dispose()`
   in `preClose`) — owner34 owns that file; §5 is the exact recipe. Until
   wired, behavior degrades openly (closed-error warn) rather than wrongly.
2. **case5 probe #7 formulation flip** ("second pump drained immediately" per
   review §2.5) is runtime32's runner edit; the precise post-fix evidence is
   journaled in §4. Note the second pump's OWN result intentionally stays
   `{claimed:0, deferred:1}` (never stalls the flush barrier on the window) —
   the gate must observe the JOURNAL, not join the pump promise.
3. **`EXTRACT_GAP_MS = 31_000`** in scripts/test-v02-runtime.mjs remains safe
   (window-elapsed flushes still drain in-barrier) but is no longer REQUIRED
   for eventual draining: a parked range drains at window end via the owned
   kick even without the gap.
4. The pre-existing (pre-repair, precedence) `extract_state` compat table and
   the untouched legacy Extractor class findings in the runtime review §5
   stay as recorded; nothing in this repair reclassified them.

## 8. Scope statement

Files written/changed by this repair: `src/extract-journal-v02.ts` (the
repair), `lib/extract-journal-v02.js` + `lib/extract-journal-v02.d.ts`
(build artifacts regenerated for this module only, per §6 pin),
`scripts/test-v02-extract-pending-drain.mjs` (NEW focused suite), and this
document. NO other source, storage, importer, manifest, Git, live-profile,
production, network or dependency file was touched; the runtime runner and
src/index.ts remain runtime32's/owner34's surfaces respectively.
