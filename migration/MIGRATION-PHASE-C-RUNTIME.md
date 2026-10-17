# Phase C increment3 — policy-owned main runtime registration

## Implemented scope

[Main plugin](../src/index.ts) now optionally injects the native sessionProjections capability. The awaited [schema loader/controller](../src/continuity-registry-v02.ts) validates the exact declared Zod4 version against fixed OWN package/dependency metadata before importing it; no fetch/install/SDK guessing, profile/session/body read occurs. Missing capability/dependency leaves this optional registration unavailable rather than breaking accepted memory lanes.

The child owns a disposal marker before async import. After import, both disposed and shutdown flags are checked before any registration. The controller owns at most one native disposer, starts inert under master/capture-off, drops registration/cells on pause, reconstructs only from canonical native history on resume and cannot rearm after disposal. Volatile commit re-syncs registration before other hot-setting work; shutdown explicitly sets stop flag and drops the registration before store close. Late child cleanup clears the current sync callback only if it still owns that callback.

This mounts ONLY the host-only structural projection—no wire payload, handoff/body/provider job, Continue/re-arm/wake operation or frontend change. Native structural history from the paused interval can be re-derived after explicit resume; this is not retroactive erasure. Per-session exclusion/consent/body admission and cache session/fork/cut ownership checks remain mandatory BEFORE any future persisted summary/action. With another independently active registration owner, native shared-key refcounts may retain global capability; paused consumers must still gate their own action/read policy.

## Isolated actual SDK/Loader proof

[scripts/test-v02-continuity-runtime.mjs](../scripts/test-v02-continuity-runtime.mjs) copies current emitted lib + manifest to a PRIVATE workspace package, links already installed declared SDK/dependency copies into that PRIVATE package and mounts it with actual native Loader/Config validation, Context, SessionProjectionRegistry, Session and awaited Entry.update. All store data is synthetic in a retained private fixture; no real profile/dependency tree is patched.

Final9PASS/0FAIL: master-off startup absent; actual volatile resume reconstructs human seq0; master pause removes capability/cells; paused committed native event cannot recreate it; explicit resume refolds without task-success inference or worker wake; capture-module independent disable/enable; actual main unload leaves no ghost; changing ONLY the PRIVATE manifest to a mismatched declared schema version is refused before SDK fallback. Provider call count remains zero.

[Native registry tests](../scripts/test-v02-continuity-registry.mjs) now10PASS: former7 native checkpoint/restore/ownership gates plus inert controller/repeated-enable one-owned-handle, canonical resume and permanent disposed-controller late-enable refusal. Pure-fold12 and original user peer preservation also PASS.

Genuine failures retained: round70 bash-2473 timed out because the fixture tried to observe owner-filtered loader/volatile-update at the root. Exact installed Loader source shows owner-scoped emission; corrected fixture awaits the real Entry.update Promise. Next run reached all8 lifecycle assertions but genuinely failed duplicate loader.remove in finally (the native remove is not idempotent); tracked actual removal and now cleanup exits0. No production hook/event contract was weakened. The SDK metadata version refusal check subsequently raised the final lifecycle count to9.

## Regression evidence

Guarded strict exactly-pinned rc.2 compile/emit bash-2472 PASS. Main emitted index SHA256 `98f220f3d8665a25e19336ad8d6592687f16aadb97c0e15dedc96f0b09867144`.

bash-2476 exit0 initially proved accepted memory regressions, but one summarized case2 output contained a continuity-unavailable warning: the legacy PRIVATE native shadow wrote a minimal manifest without dependency declarations. That regression run alone did NOT prove C registration active. Updated ONLY the private fixture to preserve declared dependencies and stage tested Zod/SDK projection links; no actual dependency tree/profile change. Final bash-2479 exit0 on stable native suite fingerprint `7e9d9b4edc8064a1…` (distinct from the single-index-file SHA above): [full native217](../.tmp-import-lane/coordinator-c-registration-native-complete-shadow.log) and [oversized40](../.tmp-import-lane/coordinator-c-registration-oversized-complete-shadow.log) strictPASS/0FAIL/0XFAIL/0XPASS with no continuity-unavailable warning. Main source/build stayed unchanged.

Earlier bash-2476 regression details, same main source/build:
- [Full native runtime](../.tmp-import-lane/coordinator-c-registration-native-full.log):217strictPASS/0FAIL/0XFAIL/0XPASS;
- [Oversized native runtime](../.tmp-import-lane/coordinator-c-registration-native-oversized.log):40strictPASS/0FAIL/0XFAIL/0XPASS;
- [Capture](../.tmp-import-lane/coordinator-c-registration-capture.log):28PASS;
- [Worker](../.tmp-import-lane/coordinator-c-registration-worker.log):23PASS/ALL PASS, including one-drain long job, malformed/noack, cancellation, delegated release and transport privacy;
- original user peers/attribution and whitespace PASS.

bash-2477 exit0: registry/controller10PASS and [package lifecycle](../.tmp-import-lane/coordinator-c-registration-package.log)59strictPASS/0FAIL, offline compile/pack/prepare and clean runtime payload. Only the test suite changed after that package run (extra PRIVATE metadata refusal assertion); main/library source is unchanged. Final runtime9/pure12/userpeer/diff command exit0.

Independent scoped read-only main-wiring review PASS: no material async-owner/optional-dependency/pause-resurrection blocker in this structural increment; independently confirms lifetime checks, latest live policy, permanent controller disposal and no source/profile-body reads. Review explicitly requires future per-session admission and persisted cache recovery/source ownership—not Phase C acceptance.

## Remaining Phase C gates

Registration/helper tests do NOT prove native backing-store/process-restart recovery or bounded durable handoff jobs. Next implement source/cut/project/policy admission, session/fork/format-bound cache recovery and independent durable turn-boundary/Pause/Finish continuity jobs outside the pure fold. Then explicit selected same-project Continue with current native human-goal authority and uncertain external-action safeguards. Complete Overview/Memories/Sessions/evidence/privacy/Advanced UI and mounted keyboard/layout/theme/unsaved/CAS/destructive gates before accepting C.

A/B accepted archives unchanged. C OPEN, D/E pending. No live production cutover, profile installation, replacement GUI server, active settings change or skill activation occurred. No improvement/continuity UX success claim is made.
