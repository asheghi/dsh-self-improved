# Phase C increment8 — effect-owned native boundary bridge

[Runtime bridge](../src/continuity-runtime-v02.ts) subscribes to exact native post-commit session/event feed only for own turn/end. This is a domain job trigger OUTSIDE the pure projection, not a fabricated event or a second structural-state drive. It starts inert, requires explicit enable and trusted current per-session admission (default deny), invokes the asynchronous canonical owner, tracks pending captures, and exposes only sanitized failure count. Observer failure cannot change native committed append success.

Privacy pause disposes/aborts the old owner BEFORE [atomic batch denial](../src/continuity-store-v02.ts): all allowed policy generations advance to denied, pending references cancel and checkpoints drop in the SAME MemoryStore transaction. Repeated denied sync does not advance already denied generations. Resume constructs a new owner but creates work only at a later native boundary. Effect unload permanently removes the observer/aborts late owner work while retaining committed durable progress for reconstruction; unload is intentionally different from privacy denial.

## Verified scope

Strict2497PASS. [Actual SDK fixture](../scripts/test-v02-continuity-boundary.mjs)5PASS: real SessionStore committed boundaries inert at boot; enabled boundary automatically checkpoint/enqueues (no manual owner capture or ad-hoc emits); privacy pause removes old visibility and paused boundary has no ghost; explicit resume creates fresh cut only at next boundary; actual Cordis effect disposal preserves existing committed reference, stops observer and refuses late sync. Source canary not in saved structural envelope; no provider/action calls exist.

Final2499 exit0 owner10/store9 + [package59strictPASS/0FAIL](../.tmp-import-lane/coordinator-c-boundary-package.log), original user peers/attribution and whitespace PASS. Independent scoped bridge review PASS no material event/lifetime/batch-policy race blocker; confirms stop ingress/old owner abort before atomic denial and permanently disposed old owners cannot rearm after rapid resume. Main shutdown must quiesce/join before store close; scoped pass is not Phase C acceptance.

## Integration limits

This bridge is NOT yet invoked from main plugin injection/config/shutdown. Main must atomically supply current master/capture/exclusion/consent authority and call denied sync before store close for privacy pause; capability presence alone grants nothing. Per-session changed controls need their own generation fence even without a new boundary. flush awaits tasks captured in its current snapshot, not a universal future-event drain; quiesce admission/observer first for unload/shutdown.

Queued references are not consumed/claimed/leased summary jobs yet, no bounded summary/handoff exists, and pause/finish trigger strings are not verified user actions. Cold canonical verification remains O(full observation history), separate from model context. Real host restart/SDK prepared source and held observation spanning bridge disable/re-enable acceptance remain pending. No full C acceptance, live profile change, production cutover or improvement claim. Continue/main UX/browser and D/E remain pending; A/B archives unchanged.
