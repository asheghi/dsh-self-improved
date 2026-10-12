# Phase C increment2 — native host-only registration/cache contract

## Implemented boundary

[src/continuity-registry-v02.ts](src/continuity-registry-v02.ts) constructs the actual typed native host-only ProjectionDefinition and registers it through the calling Cordis context. No wire view is declared. State is versioned and strictly schema-validated: bounded pending/recent arrays, hashed identities, owned source-coordinate ranges, duplicate-id refusal, ordered result coordinates, delegated human-intent refusal, verified:false executions, and no unknown body/permission/task-success fields.

The schema factory takes the Zod namespace explicitly; pure fold and native registration remain separately testable. [Manifest](package.json) declares the installed tested dsh-session-projection0.2.0-rc.2 peer and Zod4.6.5 dependency. Original eleven user DSH peer values are preserved. [Guarded build](scripts/typecheck-v02.mjs) now resolves the declared schema dependency only at its exact tested version from the local or validated test-site dependency trees; an unrelated local Zod version is not silently substituted. No dependency install/patch or live-profile mutation occurred.

This registration helper is NOT yet invoked by the main plugin. The genuine native Registry/child-fiber tests mount it only in an in-memory isolated Cordis Context. Runtime policy-controlled mounting, persistent native cache integration, handoff jobs/source-cut worker, Continue and UI remain future increments.

## Native proof and genuine failures

[scripts/test-v02-continuity-registry.mjs](scripts/test-v02-continuity-registry.mjs) uses actual installed Context, SessionProjectionRegistry, Session and message factories.7PASS:
- lazy native materialization retains interrupted uncertainty and pending call despite an assistant claiming task completion;
- native checkpoint watermark4 covers an ignored assistant event while last relevant owned seq remains3; checkpoints are detached, and host-only state is absent from client wire snapshot;
- strict schema rejects body smuggling, fabricated verification/task completion, invalid call/human coordinates, delegated intent and duplicate ids;
- valid cold restore preserves the exact prefix, without duplicated observations;
- mismatched cache VERSION refolds complete canonical history; malformed MATCHING-version cache throws/fails closed, and explicit removal of that rejected row plus full canonical reread recovers it;
- native committed-event drive advances the unit without a plugin session/event subscription;
- disposing the owner fiber removes key/state/capability registration.

Initial strict build bash-2465 genuinely failed the package-root declaration merge; switched to the documented `/types` outlet, which shares the underlying type table and compiled without casts. bash-2466 compiled then fixture failed native assistant/message missing required surfaceOp; added the real append marker. The next fixture run failed because it assumed malformed matching-version cached state automatically refolded: actual native restore parses/throws. The revised test requires that error and explicitly recovers from a complete canonical cut; no validation was disabled or native SDK patched.

Final bash-2468 exit0: native-registry7, pure-fold12, original-user-peer preservation PASS, and strict/artifact mode guards21PASS. The fixture uses native checkpoints in memory; it is NOT a process crash/restart backing-store proof.

Package lifecycle initial bash-2469 failed4gates because the private offline harness staged only the former plugin dependencies and omitted newly declared Zod. [Package fixture](scripts/test-v02-package.mjs) now stages the already installed, tested Zod copy into its PRIVATE harness/consumer trees, like its existing dependency links. This does not change repository/runtime dependency trees or contact a registry. First correction bash-2470 reached58PASS/1FAIL: old arbitrary `<=5` hardcoded-site inventory was stale even for six existing documented runtime fixtures, and the two new tests added defaults. Removed the new tests' machine-specific defaults: they now require explicit DSH_RUNTIME_RC2/DSH_RUNTIME_DIR. Replaced the stale count allowance with the exact existing documented inventory (unknown default files fail; none added), and updated [package evidence](MIGRATION-PACKAGE-TESTS.md). Final bash-2471 exit0: registry7/pure12 PASS with explicit validated runtime; [package final log](.tmp-import-lane/coordinator-c-projection-package-final.log)59strictPASS/0FAIL, offline local declared-peer build and staged npm pack/prepare PASS, runtime payload free of absolute development paths, unknown machine defaults zero, whitespace clean.

Independent scoped read-only review PASS: no material registration/schema/exact-version guard blocker. Review independently confirms malformed matching-version cache throws, version/watermark drift requires full canonical read, and schema checks INTERNAL consistency only—not ownership against the supplied session/header/cut. Future persistent cache owner must bind owning session+format+fork boundary+source cut and reject inconsistent anchors; cannot reuse parent cache for child or equate parse success with human authority. Focused independent follow-up confirmed PRIVATE declared-dependency staging and exact unknown-default inventory repair are not a waiver; new test names are not allowlisted. Existing six documented fixture defaults and legacy validate-episode-rollout finding remain visible, so no universal shipped-script portability claim is made. Final package2471 condition is satisfied.

## Next gates and limitations

Main runtime needs effect-owned, capability-/policy-gated registration with pause/unload cleanup; do not unconditionally register while privacy/master controls say disabled. Add canonical-cut bounded continuity jobs outside init/apply/view. Use framework asOfSeq/checkpoint watermark, not lastOwnSeq, for source coverage. Preserve unknown inherited-parent action state when explicitly continuing a fork; empty owned pending list cannot prove parent safety.

Cache schema checks are structural, not an external cryptographic golden root for a consistently rewritten same-OS checkpoint. Consumer handoff admission still needs source-cut identity/integrity/project checks. Native malformed cache restoration is fail-closed; any recovery fallback must reject the bad row and reread the COMPLETE exact canonical cut, not trust a tail or silently grant success.

C remains OPEN: no durable summary/handoff, host restart continuity, explicit project-scoped Continue, Overview/Memories/Sessions or mounted browser acceptance yet. A/B accepted archives remain unchanged; no production data or live GUI/profile changes occurred.
