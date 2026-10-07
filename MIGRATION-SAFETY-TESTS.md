# v0.2 migration — safety regression suite report (workflow-4)

Deliverable pair: this report and `scripts/test-v02-safety.mjs`. The suite is
independent of the Phase A worker: it only reads the current built artifact in
`lib/` and writes nothing but one uniquely created temporary store directory
for the enabled-run positive control (removed after the run, ownership verified
by this process's `mkdtempSync` prefix `dsi-v02-safety-`).

## Scope

Covers the coordinator-review safety items that the Phase A acceptance matrix
was missing or tested weakly:

1. **Disabled capture during flush** (review round 13 scenario, committed as a
   reusable regression): `installCapture` from the built `lib/capture.js` with
   a throwing storage Proxy, a throwing session/source Proxy, a pump counter,
   and an *enabled* episode controller — the master switch must dominate all
   consent lanes and the flush barrier must stay completely inert while off.
2. **Auxiliary terminal tool-calls rejection** (review rounds 5–10, coordinator
   item list): `evaluateTerminalFinish` from the built `lib/compat-v02.js` must
   reject every terminal finish except a text-only `stop`.
3. **Unknown/coordinator/missing provenance must not drive automatic recall**
   (coordinator item list, round 14): `installRecallInjection` from the built
   `lib/inject.js` must only let the direct-human `user` producer (the only
   direct-human kind in the rc.2 `MessageSourceMap`; `UserMessage.source` is
   required by `dsh-llm`'s `MessageBase`) trigger a search or an injection.

The suite tests real behavior of the built artifact; it contains no source
patterns, no `src/` imports, no dependency patch or version exemption, no
production data, no profile setting, and no provider call.

## How to run

```
node scripts/test-v02-safety.mjs
```

Caveat: it exercises the artifact present in `lib/` at run time. The Phase A
worker rebuilds `lib/` concurrently, so results describe the build present at
the run's time and must be re-read after every rebuild. Two complete runs are
documented below: against the build from 2026-10-07 22:41:00 (built before the
worker's 22:47 `src/inject.ts` provenance edit) and against the rebuilt
artifact from 2026-10-07 22:48:31 (after that edit).

## Run 1 — build of 2026-10-07 22:41:00 (exit code 1)

`test-v02-safety: 57/60 checks passed — 3 FAILING`

### Passing in run 1 (all scenarios committed above)

- Disabled capture at flush time with pending rc.2-shaped evidence: the flush
  resolves, performs **zero source reads, zero storage accesses, zero pump
  invocations**, and the episode consent lane is never even consulted while
  the master switch is off (episode controller enabled during the probe).
- Positive controls prove the disabled assertions are not vacuous: with the
  master on, the same flush trips the source probe (and never reaches the
  pump if source reading fails), trips the storage probe with readable
  evidence, and actually captures pending evidence — including exact seq 0 —
  through a real synthetic `MemoryStore` in the temporary directory, while a
  master-off flush on an identical session persists zero slices.
- Terminal finish matrix on the built artifact: `tool-calls` is rejected
  (`{kind:"tool-calls", complete:false, blocked:true}`); `stop` completes;
  `max-tokens`/`aborted`/`error`, a missing finish chunk, and unknown
  extensible reasons are all refused. This confirms the round-10 defect was
  fixed in the 22:41 rebuild.
- Provenance quarantine: unknown merge-extensible kinds, coordinator,
  model/tool/system-prompt kinds fabricated on user-role messages, own
  `dsh-self-improved` / legacy `plugin` / `agent-instructions` /
  `skill-catalog` injected kinds, and an empty `{}` source all trigger
  **zero searches** and no appended recall message (round 14's earlier gaps
  for that built artifact are closed in the 22:41 build).
- Genuine `{kind:"user"}` producer: exactly one search, one injected recall
  message carrying the declared source kind and the `snapshot` supersede form.

### Failures in run 1 — real behavior of the 22:41 build (not weakened)

| # | Failing check | Actual behavior | Expected |
|---|---|---|---|
| 1 | `absent source (provenance entirely missing)` drives recall | 1 search fired and returned | 0 searches — the absence of provenance is not direct-human authority, and only fabricated (test-double) user messages can carry no source in rc.2 |
| 2 | `null source` crashes the pre-step waterfall | `TypeError: Cannot read properties of null (reading 'kind')` propagates out of the built `lastUserText` (`lib/inject.js:17`) | malformed provenance must fail soft, never crash the agent pre-step |
| 3 | untrusted **last** producer still triggers recall | 1 search fired, taking the query from an earlier verified `user` message while the step's last user message is `coordinator`-kind | automatic recall may fire only when the step's last user message is verified direct-human; a coordinator relay turn must not borrow authority from earlier user text |

Checks #1 reproduces the coordinator's round-14 finding against the 22:41
build. Checks #2 and #3 are new findings of this suite, confirmed against
built runtime behavior. Nothing in the suite was relaxed to accommodate them;
every failing assertion stayed exactly as authored through both runs.

## Run 2 — rebuilt artifact of 2026-10-07 22:48:31 (exit code 0, concurrent worker rebuild)

The Phase A worker (workflow-3) edited `src/inject.ts` provenance handling at
22:47:54 and rebuilt `lib/` at 22:48:31. Re-running the unchanged suite against
that build:

`test-v02-safety: 60/60 checks passed — ALL PASS` (exit 0)

All three run-1 failures are fixed in the rebuilt artifact and none regressed:

| Run-1 failure | Run-2 behavior | Evidence |
|---|---|---|
| absent source drove 1 search | 0 searches, no injection appended | built `lastUserText` now requires verified `user` provenance per message |
| `null` source crashed the waterfall | fails soft, no throw, no search | the guard no longer reads properties off a `null` source |
| untrusted last producer still triggered recall | 0 searches, decision untouched | the step's last user message must be verified direct-human |

Both failure families and every fixed one remain asserted in the committed
suite, so the next rebuild is automatically re-verified. The built code also
must stay fail-soft: the crash check (`malformed provenance never crashes the
pre-step waterfall`) is an independent regression line, not a byproduct of the
search check.

## Implementation status summary for the Phase A gate

- Disabled-flush inertness: **regression-covered, passing** in both builds.
- Terminal tool-calls rejection: **passing**; was failing in the round-10
  artifact, fixed by the 22:41 rebuild, still passing in the 22:48:31 build.
- Recall provenance authority: failed in the 22:41 build (missing provenance
  searched, `null` source crashed, untrusted-last producer searched) and
  passes in the 22:48:31 rebuild with the same suite. Re-run after each
  rebuild; the coordinator should re-verify build freshness before claiming
  the Phase A gate.
- Still NOT covered by any run (out of workflow-4 scope, must remain open gate
  items): real provider first-request verification, native history/fork
  integration, mounted profile checks, client settings/Remote surface.

## Constraint compliance

- Reads only exported built APIs (`lib/compat-v02.js`, `lib/capture.js`,
  `lib/inject.js`, `lib/storage.js`); no source imports or patterns.
- No plugin source, manifest, existing tests, `scratch/`, or
  MIGRATION-PROGRESS.md was modified. Only `scripts/test-v02-safety.mjs` and
  this report were written.
- Synthetic data only; the single temporary store is uniquely prefixed by
  `mkdtempSync`, its ownership check asserts the `dsi-v02-safety-` basename
  prefix before `rmSync` removal, and no production store/profile is touched.
