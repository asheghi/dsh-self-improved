# Takeover learning lane

## Delivered

`src/episode-evaluation.ts` provides a default-off **static fixture review** for inactive SQLite skill drafts. It performs bounded textual coverage checks only; it is not sandbox execution, does not invoke tools/providers/Host/native skills, and does not measure behavioral improvement. Reports are explicitly `mode: static-fixture-review`, `syntheticOnly: true`, and `eligibleForHumanReview: false`.

Before review, every cited source episode is re-read by exact durable ID and must remain reviewed, direct, same-project/same-fingerprint, with present non-error returned steps. This is not proof of verified external/task success. Invalidated, missing, delegated, cross-project, or rejected source evidence fails closed. Empty assertions, malformed/default-off input, oversized IDs/text/case counts, and accessor/serialization-hook data are rejected.

Persistence is bounded and fail-closed. `recordSkillDraftEvaluation` accepts only `draft` rows and preserves that status: static token coverage is not behavioral evaluation. A strict detached parser rejects getters/serialization hooks and digest/scope/version forgery. Under one immediate transaction, the recorder rechecks the exact project/fingerprint/source set, reviewed direct same-scope source rows and present non-error steps, then updates only review metadata. The caller honors a rejected write. Nothing approves, activates, publishes, or asserts verified task success.

## Exact gaps

- This review is not held-out measurement and must not be used to claim task improvement.
- Activation and rollback remain intentionally absent and require authenticated human action, project isolation, immutable backup, and atomic active-path recording.
- Native discovery/publication is not wired; project drafts must not be copied into the native skill catalog without a scoped publication contract.
- No provider, tool, Host route, skill execution, or production profile/data is touched.

## Verification intent

Coordinator strict build/emit and actual assembled-episode fixture tests passed: 15 gates covering default-off, empty/malformed/oversize/duplicate cases, scope, source rejection, approved/invalidated/activated refusal, digest/version binding, no getter/toJSON invocation, and recorder failure. An independent Luna source/test review found no material defect within this static-coverage scope; reviewer did not establish behavioral evaluation.
