# Coordinator review checkpoint

Phase A worker (workflow-3, go-opencode / glm-5.3-flash) is active. This is an intermediate review, not an acceptance result.

Observed working-tree changes: src/index.ts, src/capture.ts, new src/compat-v02.ts. Existing package.json user changes remain present.

## Items for implementation/review agent
- compat-v02.ts evaluateTerminalFinish documentation says only stop is accepted, but tool-calls currently returns complete:true/blocked:false. Auxiliary extraction/review should reject tool-calls unless a complete tool round-trip is explicitly supported and verified. Add a regression test.
- isDirectHumanUserSource currently checks only source.kind === user. Verify callers additionally exclude quoted/pasted/context forms and unknown producers; kind alone must not promote context into direct-human authority.
- Adapter comments mention pre-step admission; ensure actual provider FIRST request receives recall at a supported earlier assembly/admission point. Registration alone is not evidence.

## Coordinator verification (goal round 2)
Ran `./node_modules/.bin/tsc -p tsconfig.json --noEmit` (no build writes). Exit code 2: missing inheritedEventCount/ownEvents, readonly content mismatch in createRecallContextMessage, duplicate BlockAssembler/createUserMessage imports, missing Context.agentDefaultModel and SettingsProvider.configure.

Important qualification: repository node_modules/@deepseek-ai/dsh-session/package.json is version 0.1.0-rc.8, so this command is NOT a typecheck against rc.2. The worker must create an isolated rc.2 dependency/test environment or a verified rc.2 resolution setup. Duplicate imports and readonly mismatch still require attention. tsconfig currently has strict:true but skipLibCheck:true. No gate is asserted; source is being edited concurrently and these findings are a transient checkpoint, not final results.

## Recall adapter intermediate review (goal round 3)
Read current src/inject.ts (274 lines). Concrete issues to resolve before gate:
- The admission return reconstructs {kind,messages,startsRequestSeries} instead of spreading decision, contrary to its own documentation; unknown/other plugin decision fields are dropped. Test with sentinel extra fields.
- Context is referenced in installRecallInjection without an import in this current snapshot; function return is declared void but returns pluginDispose. Verify typed ctx.effect ownership/disposal contract.
- lastUserText skips undefined and a blacklist of injection source kinds but does not require direct-human user source; an unknown producer can drive retrieval. Require verified human intent, and test unknown/coordinator forms.
- Cached trusted rendered recall has no store revision or final eligibility recheck in this snapshot. This is a Phase B blocker: correction/forget/expiry/consent changes must affect the next identical query. Do not call Phase B done without tests.
- Recall-only source changes are not first-provider-request integration evidence; inspect actual admitted/logged messages, restored history and forks.

## rc.2 resolution configuration checkpoint (goal round 4)
Ran `./node_modules/.bin/tsc -p tsconfig.v02.json --pretty false`; exit code 2. Same errors as legacy check plus missing Context import in inject.ts. New config maps package directories through paths, but output still exposes legacy Session/Settings types. Verify compiler resolution (traceResolution or explicit exported .d.ts targets); presence of a paths config is not proof rc.2 is selected. No successful rc.2 strict typecheck yet.

Manifest diff preserves initial user peer edits and currently only adds dsh-agent-default-model alongside them. Avoid committing those user-authored peer replacements as migration-authored edits.

## Replacement typecheck script checkpoint (goal round 5)
Worker removed tsconfig.v02.json while coordinator attempted resolution tracing; both trace attempts exited 1 with TS5058 (config missing). This is a concurrent-file-change result, not a fresh source typecheck failure. New scripts/typecheck-v02.mjs uses a copied source tree and runtime peer symlinks, which addresses package resolution more directly. It has not been executed by coordinator to avoid deleting/recreating worker-owned scratch/v02check concurrently.

Review script safety/reproducibility: fixed scratch/v02check is recursively deleted without checking an existing directory belongs to this tool; prefer uniquely created temporary directory and guarded cleanup. Reported peer versions are printed but not validated against required rc.2; add an explicit supported-target check. skipLibCheck is true, so report accurately that source is strict-checked while dependency declarations are skipped. Absolute default runtime location should remain configurable.

## Synthetic baseline verification (goal round 6)
Ran `node scripts/test-redact.mjs`; exit code 0, all assertions passed. The suite uses synthetic strings/objects and no production data. It imports existing lib/redact.js, not a freshly rebuilt migration artifact, so this establishes only the existing redaction-helper baseline. It does not prove all capture/provider/export lanes are redacted or that privacy/revocation gates pass. The suite intentionally leaves some short credential-like values unchanged; disclose this limitation in consent and do not infer comprehensive sensitive-data filtering.

## Business surface checkpoint (goal round 8)
Reviewed commands.ts diff. Legacy browser channel now capability-checks settings.register and returns inert methods on rc.2. This is fail-closed compatibility scaffolding, not the typed business Remote surface required by Phase A. Gate must remain open until mounted authorized/cancellable data operations replace Config-as-RPC and current client binds to them. If retaining legacy fallback, preserve method receiver (`register.call(settingsApi, ...)` rather than invoking detached) and effect-own watch disposal. No live UI/action functionality was verified.

## New Phase A regressions (goal round 9)
Ran `node scripts/test-phase-a.mjs`; exit code 1. Flat rc.2 tool-result normalization/pairing assertion failed: episodes=0, steps=0. Other suite checks reported PASS, including decision sentinel preservation (this earlier concern appears fixed in the currently built artifact). Do not treat this suite as passing. Verify episode controller consent/enable fixture setup and current event shapes rather than weakening expected pairing behavior.

Test quality gaps: disabled gate tested at installation, not by flushing synthetic evidence while disabled; slices.every checks pass vacuously if no slices, so require nonempty exact source coordinates. Seq-zero adapter test is not full persisted-capture integration. Recall fake request lacks source and genuine current provider test remains absent. Static no-append scan does not prove harness native resume/fork. Add tool-calls finish rejection to matrix. Temporary synthetic store was created only; no production data involved.

## Targeted terminal-finish regression (goal round 10)
Executed built evaluateTerminalFinish("tool-calls", true) and asserted rejection for text-only auxiliary review. Exit code 1: actual {kind:"tool-calls",complete:true,blocked:false}. This confirms the earlier terminal-finish concern is present in the built artifact. Auxiliary tool-calls cannot be a completed review without an implemented/verified tool round-trip. Existing matrix omits this case; add it and fix behavior. git diff --check still fails on inject.ts trailing blank line (now line 289).

## Isolated typecheck verification (goal round 11)
Ran `./node_modules/.bin/tsc -p scratch/v02check/tsconfig.json --noEmit --pretty false`; exit code 0. Verified scratch/v02check/node_modules/@deepseek-ai/dsh-session/package.json version is 0.2.0-rc.2. This establishes a successful strict source typecheck of the worker's copied snapshot against the isolated rc.2 resolution tree (dependency declaration checking remains skipped). It does not establish latest-tree equality, mount/unmount, real provider-first-request, native history/fork, client settings conflict, Remote authorization, or migration dry-run gates.

Current source lastUserText now allows absent-source plain messages, apparently to satisfy mocks. Add real typed provenance tests and reject unknown/coordinator inputs rather than expanding authority to make synthetic fixtures pass.

## Episode fixture root cause (goal round 12)
Read current capture.ts: episode capture is correctly gated by optional episodeCtl.enabled(). New test-phase-a.mjs passes undefined as the fifth installCapture argument, then expects a paired episode. Supply an explicit enabled synthetic episode controller with bounded maxChars in that test; separately assert undefined/off consent yields no episode persistence. Do not remove the production consent gate to fix the test.

Capture still uses process-local lastWritten and separate appendConversationSlice/markPending/setSessionProject writes; those remain Phase B durability work, not dedup guaranteed merely by event seq. Session cursor picks records[last].seq rather than max; rely on native ordering or assert/sort/compute max for the adapter contract.

## Disabled-flush regression (goal round 13)
Executed built installCapture with a synthetic session, disabled master controller, storage Proxy that throws on any access, source-reader that throws on any read, and pump counter; invoked the registered session/flush listener. Exit code 0: no source reads, no storage accesses, no pump invocation. Episode controller was enabled to ensure the master switch dominates it. This validates disabled capture at flush time for the current built artifact, not whole-plugin mount/startup/recall/model inertness. Preserve this scenario in the committed Phase A regression suite.

## Recall provenance behavior (goal round 14)
Executed built installRecallInjection with synthetic user-role producer messages and a counting search stub. Coordinator source triggered 0 searches (PASS); unknown-producer triggered 0 searches (PASS); absent source triggered 1 search (FAIL for unknown-origin quarantine). No provider calls/storage writes. The new built guard improves prior source snapshot but still trusts missing provenance.

Started workflow-4 (go-opencode/glm-5.3-flash) to persist independent safety regressions only in scripts/test-v02-safety.mjs and MIGRATION-SAFETY-TESTS.md; explicitly prohibited source/manifest/shared-test/scratch/progress edits to avoid collision with workflow-3. Collect both jobs before final scope claims.

## Config acceptance scope (goal round 15)
Current index.ts explicitly defers volatile configuration and uses restart-on-change for all fields. Phase A scope requires editable Config fields explicitly volatile while initialization/storage-root fields remain nonvolatile; restart-only scaffolding is not that acceptance scope. Confirm everyday consent/off changes cancel/recheck pending work and settings stale revisions reject visibly. Also do not swallow configure failures as a mounted healthy settings feature. Auto-generated technical Config page is only scaffolding, not the final Overview/Advanced UX.

## Ordinary-capture privacy regression (goal round 16)
Executed built toSlice on a synthetic direct-human seq-zero message containing a clearly labelled synthetic password marker. Exit code 1: returned user slice still contains the marker. No real credential/provider/storage was used. Current capture.ts passes slices directly to unchanged appendConversationSlice, so helper baseline redaction success does not cover this ordinary lane. Phase B must redact/minimize before plugin persistence and provider calls, including assistant/tool/untrusted audit copies; keep rollout gated until this is proven.

## Seq-zero capture listener regression (goal round 17)
Executed built installCapture with a synthetic rc.2-shaped zero-based session and in-memory storage spy. Invoked actual registered flush listener. Exit code 0: exactly one user slice at seq 0 was passed to appendConversationSlice and markPending received 0. This improves evidence beyond the adapter-only zero test; durability/restart/dedup still unproven because storage is a spy. No filesystem/provider/private-data access.

## Malformed/imported provenance probe (goal round 18)
Synthetic toSlice probe with source {kind:"user",form:"recall"|"snapshot"} returns type:user/injected:false (exit 1). Qualification: installed rc.2 MessageSourceMap.user declaration is only {kind:'user'}, so these forms are NOT valid native typed user sources. Treat this as adversarial import/malformed provenance validation, not a demonstrated native event defect. Safe import should quarantine invalid combinations; do not invent valid native fixtures to assert compatibility. ContextFormed snapshot additionally requires sections. Verified installed message.d.ts lines 70–104 directly.

## Commit/rollback and package build review (goal round 19)
Worker committed an increment and appears to amend it while updating docs (observed HEAD f4fe416 then 515783c). Git show confirms commit includes the PREEXISTING user-authored peer-dependency replacements and untracked migration plan, despite coordinator instructions to commit only authored changes. Content is preserved, but do not attribute these replacements to migration and DO NOT blindly git revert that commit: it would undo user peer edits and remove their plan. No history rewrite by coordinator; flag for independent review and preserve explicit user baseline in rollback.

Package build/prepare now runs scripts/typecheck-v02.mjs which defaults to an absolute installed runtime location. Verify standalone package build/install works and scripts required by lifecycle are shipped or not required postpack: existing files allowlist does not include scripts. Installed test runtime is contract evidence, not a required consumer-local source/build dependency. Add package artifact/isolated installation gates before claiming compatibility.

## Committed regression verification (goal round 20)
Ran `node scripts/test-phase-a.mjs` and `git diff --check`; combined exit code 0. Phase A suite now reports all checks PASS, including flat tool-result pairing and tool-calls terminal rejection. Those earlier failures are resolved in the current built artifact. Suite remains synthetic/unit-level: mount/unmount, first actual provider request and restored/forked native history, typed authorized Remote, visible stale settings rejection, volatile Config, import dry-run and package artifact gates remain necessary.

## Package inventory verification (goal round 21)
Ran `npm pack --dry-run --ignore-scripts --json --cache /tmp/dsh-migration-npm-cache`; exit code 0, no installation/lifecycle scripts. Current package inventory now includes scripts/typecheck-v02.mjs, resolving the earlier missing-script concern. It does not include src/ or tsconfig.json, so packed artifact rebuild/prepare portability remains unproven; consuming prebuilt lib may be valid, but verify installation's actual lifecycle path without requiring the coordinator's runtime location. No tarball installation or mount claimed.

## Independent safety-suite review (goal round 22)
New scripts/test-v02-safety.mjs is being authored by workflow-4. Initial disabled test passes rc2Session (ordinary readable object) while sourceReads is incremented only by a separate throwingSession proxy. Therefore the zero sourceReads assertion in that run is vacuous. Invoke the disabled handler on throwingSession too (or put getters on rc2Session) before claiming zero source reads. Positive controls on a different enabled run do not repair this missing instrumentation in the disabled run. Coordinator's earlier direct disabled-flush probe had an ownEvents throwing method and passed; preserve stronger instrumentation in the reusable suite. Wait for worker output before editing its deliverable.

## Independent safety worker report (goal round 23)
Read MIGRATION-SAFETY-TESTS.md: worker reports unchanged safety suite initially failed absent/null provenance and untrusted-last-turn authority, then passed after main worker rebuilt corrected inject code. Results are worker-reported pending coordinator rerun after workflow-4 completes, not independently reverified yet. Keep disabled-source instrumentation concern in review even when suite reports all PASS. New safety files are currently untracked. Main workflow-3 remains active; no mount/settings/import acceptance claim.

These are transient observations during an active edit, not final findings. Reviewer must verify exact current contracts and actual runtime behavior.
