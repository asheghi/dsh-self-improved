# Phase C increment6 — restart-preserving trusted owner primitive (OPEN integration)

[Owner](../src/continuity-owner-v02.ts) composes canonical checkpoint recovery with [durable storage](../src/continuity-store-v02.ts), default-denied trusted current admission, native immutable-header opaque project identity, delegated/nonhuman suppression and permanent disposal latch. Recovered canonical native row replaces an unchecked live cached cell before enqueue. No body/provider/permission/resume/wake is introduced.

New readPolicy/ensurePolicy preserves unchanged admission generation/checkpoint/jobs across owner reconstruction and SQLite reopen. Actual project/privacy changes still use the atomic generation/cancel/drop fence. Missing native cwd does NOT guess process cwd: any prior known ownership is denied, cancelling its references/dropping checkpoint; no prior ownership means no write.

## Verified results and genuine corrections

Final2493 exit0 strict compile + [native owner7PASS](../scripts/test-v02-continuity-owner.mjs) + previous store9PASS + whitespace clean. Owner test uses real rc.2 Context/Session/Registry and real SQLite, with retained PRIVATE dependency staging. Gates: default denial; native human seq0/interrupted structural reference without canary body; identical owner/SQLite reconstruction retains generation/id/dedup; current deny cancels/drops and reenable creates new work only; disposed late capture refuses; nonhuman session no candidate; missing cwd after prior admission revokes old visibility.

Initial2490 strict compilation refused optional cwd passed as string; fixed fail-closed.2491 strictPASS but fixture genuinely failed native partial header without version4; supplied complete immutable SDK header. Next fixture failed seq0 assertion because explicitly passing empty replay seed makes native constructor append session/end-seed; used undefined seed for fresh native session, rather than weaken projection expectations.

Independent read-only review found missing-cwd early-return denial hole: no new work was created but old allowed references remained visible. Repaired explicit prior-ownership deny fence; regression verifies old work disappears. Focused source review confirmed closure, other canonical row replacement/idempotent generation/final transactional policy checks sound. This is scoped primitive evidence, not ready-runtime acceptance.

Final2494 exit0 [package59strictPASS/0FAIL](../.tmp-import-lane/coordinator-c-owner-package.log), original user peers/attribution and whitespace PASS. All relevant jobs collected.

## Mandatory source API correction BEFORE integration

While verifying actual installed SDK constructor semantics, current SDK source/declarations revealed snapshotEvents and ownEvents are deprecated with NEW calls prohibited. The earlier cold checkpoint helper calls snapshotEvents. Although its canonical validation tests pass, this unwired source path is NOT ready/fully compliant with current SDK policy; do not mount it or claim Phase C accepted.

Current inspected sessionQuery supports observeSession(sessionId,{signal,projectionMode}) returning an owned disposable observation with immutable header/events/inherited floor/cursor, and readSession returning complete replay-validated cloned logical history. Next migrate new checkpoint/owner access to that authoritative async observation input with exact identity/header/floor/cut ownership, lease disposal and post-await disposal/current policy/generation fences. Do not add more synchronous history reads. Existing already-accepted legacy reads are a separate migration inventory, not permission for these new calls.

No main runtime observer/Pause/Finish action wiring yet. Then complete bounded admitted handoff workers, explicit selected same-project Continue/current native-human goal authority and UX/browser/restart-host gates. C OPEN,D/E pending; live profile/GUI and A/B accepted archives untouched; no SDK patch/dependency install/production cutover/improvement claim.
