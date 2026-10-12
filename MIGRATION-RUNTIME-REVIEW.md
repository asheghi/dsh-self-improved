# MIGRATION-RUNTIME-REVIEW.md — independent review/hardening of the v0.2 runtime fixtures

Status: review pass, complete. Author: runtime-review pass over the
workflow-5 deliverables (`scripts/test-v02-runtime.mjs`,
`fixtures/v02-runtime/**`, `MIGRATION-RUNTIME-TESTS.md`). Scope honored: no
changes to host source (`/home/bahman/github/dsh-v0.2/**`, read-only), no
changes to `src/`/`package.json` (workflow-3 owns them), no importer source
(workflow-8), no coordinator docs/tests, no Git history writes, no staging,
no plugin/manifest changes, no compatibility exemptions, no active-profile
installation, no production data touched.

## Verdict

The original fixture suite's *checks* were real (all 64 reproduced here as
strict gates), but its *reporting* was not honest in four specific ways, all
now fixed and verified by running the reworked suite end-to-end:

1. **The suite said "all pass" over failing observations.** The old `obs()`
   helper recorded every observation as `ok: true` in the results array
   regardless of outcome, so four failing defect observations (OBS-FAIL) did
   not count toward the summary — the suite printed
   `64 PASS, 0 FAIL … SUITE PASSED` over four genuine defects.
2. **"Safe unmount/drain" was claimed from exit 0.** The documented unmount
   evidence ("every mounted run exits 0 through the plugin's effect-owned
   disposers … store close succeeded at the observable boundary") is not
   evidence: in the same fixture the accepted extraction insert was lost with
   `extract failed … database is not open` on stderr of an exit-0 run.
3. **"No other network destination is reachable from the child" was wrong as
   stated.** The environment allowlist scrubs variables; it never enforced a
   network boundary (see hardening below). All isolation claims are now
   verified against actual rc.2 contracts and/or asserted per run.
4. **case3-row did not exercise the disable dialect.** The overlay targeted a
   nonexistent row (no `insert` layer in the same boot); rc.2 composes that to
   an `entry … not found` skip — the plugin never mounted, but that is
   "absence", not "disabled". Dump-config evidence confirmed the warning
   variant, and the fixture now inserts the row already-disabled (verified
   dialect), with dump-config asserting the composed row carries
   `disabled: true`.

## Contract checks (exact rc.2 evidence)

Read-only inspection against `/home/bahman/github/dsh-v0.2` (rc.2, read-only
reference installation — no patches, exemptions, profiles, GUI, or skills
activated there):

| Claim in the old doc | Verified status | Evidence |
|---|---|---|
| `DSH_TELEMETRY_DISABLED=1` is the telemetry opt-out | **verified** (env → boot patch) | `dsh-app-boot/lib` `resolveTelemetryPatch()`: any non-empty value ⇒ patch `{id:"session-telemetry-otel", disabled:true}`; wired by the launcher (`profile-boot` passes `telemetryDisabledEnv`); the disabled row's *default* exporter URL is external (`dsh-otel-collector.deepseeksvc.com/v1/logs`), and rc.2 `FEEDBACK_ONLY` only exports after explicit user feedback |
| Composition can disable optional network rows through the verified patch dialect | **verified and now used** | Fixture overlays carry `- id: session-telemetry-otel / disabled: true` after the insert patch (target by id: supplied fields replace the row, last write wins); per-case `--dump-config` output shows the composed row with `disabled: true` |
| `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY` route the provider to the loopback stub with a synthetic key | **verified** | `dsh-llm-deepseek` (`BASE_URL_ENV`, trusted launch environment), `dsh-llm-deepseek-api-key` (`apiKeyEnv: "DEEPSEEK_API_KEY"`); the suite asserts the synthetic key over EVERY recorded request |
| `DSH_PERMISSION_MODE=workspace-write` | **verified** | dsh-base `sandbox-policy`/`permission` rows read it |
| `DSH_TOOLS_MODE` unset is deliberate | **verified** | headless bundle binds `mode: !!js process.env.DSH_TOOLS_MODE` verbatim; empty string is invalid |
| In-process mount→disable on headless rc.2 | **not supported — honestly scoped, not invented** | `dsh-hmr` constructor throws without `--expose-internals` (`loader.internal` absent in headless boot), and the headless bundle disables the hmr row outright; the profile-HMR branch additionally requires `profileContext` + `appReady`; `plugin-manager`/`config-editor` rows are disabled without `profileContext`. Supported lifecycle boundary implemented instead: case4 (accepted-job quiescence across process-level unmounts) |
| Stale row-targeting (`- id: … disabled: true` with no insert) is a disable mechanism | **incorrect — corrected** | patch targeting an absent id composes to a warning + skip (`dump-config`: `patch: entry "…" not found`); confirmed empirically against rc.2 |

## What the reworked suite now gates

- **Strict checks** (203): everything from the original suite plus
  composition-dump assertions, per-run egress assertions, and case4 quiescence
  gates. Any strict failure fails the suite.
- **Expected-failing defect gates** (7 — `xfail()`): each encodes the FIXED
  behavior of one tracked defect; FAILING = XFAIL (expected, defect recorded),
  SUCCEEDING = XPASS (suite failure until the gate is reclassified). This
  replaces `obs()` and the misleading unconditional green summary.

| Gate | Encoded desired behavior | Current baseline evidence |
|---|---|---|
| case1 D1a (stderr) | no drain error during an exit-0 mounted run | `extract failed for session-… database is not open` |
| case1 D1b (insert) | provider-validated memory row durably persists | `memories=0` |
| case1 D1c (cursor) | the captured range is consumed after the aux call | `processed_seq=0, pending_seq=17` |
| case2 D2 | resume must not re-append already-captured events | 3 direct-human rows for 2 unique turns |
| case2 D3 | recall snapshots must not duplicate in the slice store | 3 injected rows for 2 turns |
| case4 D1′ | a drained accepted job consumes its captured range across the disable window | `processed_seq=40, pending_seq=53` (also abused by D2 recapture) |
| case5 D4 (in-process probe) | a second pump inside `MIN_PUMP_INTERVAL_MS` (30 s) still drains its accepted range | second pump returns `sessions: 0`, accepted range stays unconsumed |

Positive results that remain legitimately claimable (kept as strict gates):
first-provider recall with durable attribution, native resume/fork history
boundaries, disabled-mount inertness, first-pump drain proof (in-process), and
accepted-job preservation + quiescence across unmount. Positive results that
are NOT claimed anymore: safe unmount/drain (defect-gated instead).

## New fixtures

- **case4 — accepted-job quiescence across an unmount** (new): a mount with
  capture on/extraction disabled accepts a pending range; the same home is
  then opened by an unmounted row and by a config-disabled inert mount; the
  job, slices, memory rows, access counts, and provider traffic are asserted
  byte-identical across the disable window, and a re-enabled mount finally
  drains the previously accepted job (continuity direction). Deterministic.
- **case5 — in-process defect probes** (new): deterministic direct probe
  against the built `lib/extract.js`/`lib/storage.js` demonstrating and
  gating the 30 s pump-throttle defect without a runtime boot.
- **Egress guard** `fixtures/v02-runtime/egress-guard.mjs` (fixture-only):
  fail-closed Node-layer deny + record layer for the runtime child via
  `NODE_OPTIONS --import`; dns/net/dgram/http/https/fetch layers; measured
  self-test of all five denial probes on every run (verified against node
  v24.13.1 that the CJS-surface patch route is what live ESM imports observe);
  per-run strict assertions over `egress-run-<n>.jsonl`.
- **Build pinning**: `sha256` of every `lib/*.js` pinned per suite
  (`fixtures/v02-runtime/last-suite-pin.json`), verified against the shadow
  copy; each case records `build-snapshot.json` and prints its build prefix;
  the summary flags `CHANGED during suite` when a concurrent worker rebuild is
  detected (one such detection occurred during hardening: intermediate runs
  were attributed to the suite-start build they actually mounted —
  `edfa8e57694a…` for the pre-rebuild cases; the final baseline run was stable
  on composite `4c2d5ad62de0d968…`, exact per-file hashes in the pin file).
- **Unique owned temp dirs with guarded cleanup**: per-case unique dir +
  owner marker; cleanup only under the realpath of
  `fixtures/v02-runtime/temp/`, marker-checked, never the root itself;
  passing cases clean up automatically, failures/xpass keep dirs.

## Executed evidence (final baseline)

Full suite, `build pin 4c2d5ad62de0d968…`, exit 0:

```
STRICT 203 PASS / 0 FAIL; expected-failing defects: 7 XFAIL (gated down) / 0 XPASS (surprise)
case1 OK (30 strict + 3 xfail), case2 OK (51+2), case3-row OK (24),
case3-config OK (24), case4 OK (71+1), case5 OK (3+1)
```

Artifacts kept durably:
[fixtures/v02-runtime/last-suite-run.log](<fixtures/v02-runtime/last-suite-run.log>),
[fixtures/v02-runtime/last-suite-pin.json](<fixtures/v02-runtime/last-suite-pin.json>),
[fixtures/v02-runtime/egress-guard.mjs](<fixtures/v02-runtime/egress-guard.mjs>).
Passing case temp dirs are auto-cleaned; failing diagnosis dirs are kept
inside the guarded temp root.

## Runtime source fixes to remain tracked (for after the src owner finishes)

Owner: workflow-3 (continues after its current build series). All four defect
classes are encoded as suite XFAIL gates, so a fix that lands WITHOUT touching
this fixture produces XPASS suite failures and a fixture reclassification —
the tracking cannot silently rot when the gate contract is followed.

1. D1 — extraction drain commit ordering vs `store.close()` on dispose
   (`flushDrain`/run-final flush). Gates: case1 D1(a,b,c), case4 D1′.
   Related plan work: Phase B "consumed-range jobs, transactional
   acknowledgment, policy/cancellation generations".
2. D2 — durable capture cursor (store-backed floor; resumed runs re-append).
   Gate: case2 D2. Plan: "durable capture floor / source dedup".
3. D3 — recall snapshot rows duplicating on resume (consequence of D2).
   Gate: case2 D3.
4. D4 — `MIN_PUMP_INTERVAL_MS` (30 s) in-process throttle dropping accepted
   ranges on a second same-process flush within the window.
   Gate: case5 D4. Plan revisit: `flushDrain` semantics.

Also tracked for later phases (observed, not gated as defects here): the
plugin's browser channel is inert/fail-closed on rc.2 (expected Phase A UI
worker scaffolding), and housekeeping/consolidate/evolve lanes were disabled
in the fixture overlay (`evolve: false`) because they are out of the exercised
scope — the config schema was respected in composition.

## Remaining gates (honest list)

- The 7 XFAIL defect gates above (waiting on the src owner's fixes; each fix
  will surface as XPASS until reclassified).
- In-process mount→disable/unmount quiescence: not expressible on rc.2
  headless with supported APIs (documented contract evidence above). If the
  src worker ships a fiber-level unmount/drain surface or a later rc adds
  profile-HMR exposure to headless, re-introduce an in-process quiescence
  case; do not approximate it with process-exit code.
- OS-enforced network namespace isolation (beyond the Node-layer guard) is
  not available in this session's permission scope; the fixture only claims
  Node-layer coverage + composition-level denial + verified synthetic routing.
- Browser-mounted settings/UX gates and typed business Remote surface belong
  to the separate Phase A UI deliverable; not measured here.
