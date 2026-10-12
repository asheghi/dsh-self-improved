# Optional v3 extractive provider callback

The coordinator implemented `ContinuityProviderV03` in `src/continuity-worker-v03.ts` after rejecting a Luna attempt that invented an exported proof function and left invalid markers. No runtime/work/main/storage/production authority was altered for this seam: the class instantiates the existing `ContinuityWorkV03` and uses its instance proof method; fresh readers come from genuine native observations with detached clones before disposal.

## Accepted narrow behavior

- Explicit live consent and durable summary epoch are deny-by-default; source/provider access also requires a current exact claimed job, lease/token/policy/anchors.
- The exact observation lease used for extraction is proved against the native lineage and source binding before egress. Input is own direct-user text at the claim cut only, with inherited/assistant/tool/paste-suspicious/quoted material omitted. Full text is best-effort redacted before clipping.
- Input budgets: eight excerpts, 1,500 characters per excerpt and 6,000 total, 12,000 system/body characters. The constructed GenerateOptions forwards no native session binding, project/source IDs, history, tools, metadata, unknown route/caller properties or task purpose. Output: 768 tokens requested, 3,000 characters, 2,048 chunks, stop required; only text controls are accepted.
- Strict JSON permits up to three nonblank <=200-character seq/quote pairs. Each must be a unique exact substring of the actual minimized excerpt at that seq. Returned notes are labeled partial/unverified; nothing invents success, permission, resume instructions or behavioral evaluation.
- Policy, live consent, summary epoch and owned signal are checked through streaming. A fresh native source proof and live gate repeat before returning. The runtime separately owns final DB handoff settlement; this callback does not claim work, perform DDL, persist notes or mint receipts.
- Single-flight capacity; timeout and cancel abort owned work. Disposal denies new work and drains a noncooperative in-flight query/stream before releasing its source lease. Exceptions are standardized and never log/persist raw source/provider payloads.

## Evidence and limits

Fresh strict pinned `0.2.0-rc.2` build/emit passed. `scripts/test-v02-continuity-provider-worker-v03.mjs`, backed by `scripts/continuity-v03-provider-fixture.mjs`, passed ten actual native Session/SQLite gates using a fake LlmRuntime.stream. Assertions cover minimized source-backed happy output, source mutation before egress, default-off/preabort/expired lease, disabled durable consent, policy/epoch/live revocation, forged/duplicate/extra-key quotes, malformed/unsupported/post-finish output, chunk/character/finish limits, and disposal draining a held noncooperative stream while retaining its genuine observation lease. The provider never writes a handoff. A Luna read-only source/test review independently found no material defect within this scope.

This is not a real provider run or mounted Host/browser integration. Authenticated ingress, main/client wiring, complete task handoff semantics, executable sandbox/held-out learning, activation/rollback and live browser/restart acceptance remain open. No production memory/profile/plugin activation was performed.
