# Phase C increment7 — authoritative async native observation source

[Cold source helper](src/continuity-checkpoint-v02.ts) no longer calls prohibited new synchronous Session history methods. It accepts exact native SessionObservation header/events/inherited floor/cursor and validates full contiguous source against that exclusive cut before recovery. Bind uses only the canonical restored row at the observation watermark; no unchecked live-cache cell or second current-history read can be mixed into the envelope.

[Owner](src/continuity-owner-v02.ts) now awaits actual sessionQuery.observeSession(id,{signal,projectionMode:'none'}). Source ownership must match original immutable native header and inherited floor. It checks permanent disposal, current admission and original durable policy generation AFTER the await. Every acquired lease is released in finally; owner disposal aborts acquisition. No provider prompt/body persistence/action/wake is introduced.

## Native verification

2495 exit0 strict compile + [checkpoint7PASS](scripts/test-v02-continuity-checkpoint.mjs) + [owner7PASS](scripts/test-v02-continuity-owner.mjs), now with actual SessionStore, SessionQueryEngine and SessionProjectionRegistry rather than new synchronous test history reads. Complete-cut/cache mismatch/schema-valid forgery/full-prefix refusal/native fresh-registry restore gates still pass. SDK imports/types use actual SessionQueryEngine, not invented service class names.

Final race test expansion in2496: owner10PASS/store9PASS/user-peer preservation. Real native observation leases are wrapped only to deterministically delay delivery or simulate wrong identity: late uncooperative completion after owner disposal does not rearm and releases exactly once; current consent changes during async acquisition cancel old work/drop checkpoint and release; foreign observed header fails closed and releases. These are deterministic promise barriers, no timers/sleeps. Final2496 exit0 [package59strictPASS/0FAIL](.tmp-import-lane/coordinator-c-observation-package.log), whitespace clean. Independent scoped API/lease/race source review PASS: no material new blocker; confirms lease disposal paths, post-await+transaction policy-generation checks and absence of prohibited new synchronous C reads. No Phase C acceptance.

Native Inspect confirmed session/event is committed fire-and-forget owner-scoped, and sessionQuery observation is caller-owned with exact immutable source/header/cursor. No runtime event subscription added in this increment. Current new C source/helper/test paths no longer use snapshotEvents/ownEvents. Existing accepted legacy read inventory is not silently rewritten or treated as new-call permission.

## Remaining gates

Runtime current master/capture/exclusion/consent ownership still must be wired to the admission callback and durable generation invalidation. An enabled plugin capability alone is not consent. Native prepared/persisted observation, cancellation before lease acquisition, generation-change-during-await, automatic turn-end/Pause/Finish, actual host-restart backing-owner and summary-worker gates remain pending. Callback false checked on invocation is not itself an automatic privacy subscription.

Cold verification remains O(full canonical history) transient processing, not model context or raw-body retention. No canonical owner is installed in the live profile and no C acceptance or improvement claim is made. Continue and main UX/browser gates remain; D/E unstarted. A/B accepted archives untouched.
