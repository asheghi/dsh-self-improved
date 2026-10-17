# Phase B isolated acceptance review — round67

## Decision

ACCEPTED for isolated Phase B implementation on build4163229b9089019f…, after the final mounted policy/import sequence exited0 and independent complete gate review found no additional material blocker. No production cutover, live installation, live data import, profile change, dependency patch, or generated skill activation is authorized. Phase A remains accepted. Phase C may now begin in dependency order; continuity/main UX and D–E remain unimplemented/unaccepted.

## Tested implementation boundary

Build4163229b9089019f… supports pinned installed0.2.0-rc.2 contracts. Direct-human-only minimized capture feeds durable SQLite source/jobs. Enqueue and candidate/ack/consumption/revision commits are atomic. Original native coordinates, seq0 and fork authority boundaries are preserved. Typed verdicts distinguish valid empty output from malformed/error/truncation/toolcall/unknown terminal output. Failed budgets remain durable and explicit retries retain audit/idempotency.

Complete oversized human prose is minimized before bounded source/overflow persistence and provider chunking. Full hashes/lengths plus complete segment acknowledgment prevent false head-only consumption. Atomic pending-job-sized claim leases avoid healthy long jobs burning retry attempts. Background requests coalesce into owned timers; explicit drains join accepted work. Shutdown/pause/cancellation retain their admission/final-commit fences. Both auxiliary LLM helpers omit native session transport binding so the core session-log upload extension cannot bypass the minimized source cut.

Human mutations spend authoritative supporting coordinates in the same SQLite transaction, not whole sessions. Unrelated pending/future same-session evidence survives. Human corrections outrank old rows; forgot/corrected rows are ineligible on the next identical recall. Revision invalidation and final admission checks cover cache/search races. Late same-body candidates over other coordinates are fenced at commit.

Import/export remains isolated: restore-grade private backup preserves source bytes/unknown families; normalized operational rows are privacy-minimized and unsafe/unreviewed families stay quarantined/count-reconciled. Approved plans bind source/destination/digests and are freshly re-derived from readonly source before writing; forged verdicts, collisions, stale source/WAL, symlinks/hardlinks and destination transplantation refuse. Tokens are not a human-intent proof or defense against the same-OS writer. No production store is read/changed.

## Gate evidence

Native final round66 bash-2455 exit0: guarded strict compile, standard mounted runtime217strict and oversized mounted runtime40strict, both0FAIL/0XFAIL/0XPASS, same stable4163229b9089019f…. The oversized stdin event is238147chars, retained complete minimized238128chars in bounded root/overflow rows;41aux provider calls/chunks/all acknowledgments, one claim/attempt, no raw-session-log field or canary anywhere in auxiliary wire envelope. Native main conversational history remains intentionally user-owned, not a plugin privacy guarantee. [Normal log](../.tmp-import-lane/coordinator-runtime-aux-private-full.log) · [Oversized log](../.tmp-import-lane/coordinator-runtime-aux-private-oversized.log).

Round67 same-build final bash-2457 exit0:
- journal26: real child SIGKILL enqueue/claim/commit boundaries, zero-based/fork dedup, typed refusal, generation/recovery and header privacy;
- source-parts5, lease-budget4: true reopen, complete bounded retention/reconstruction/privacy, corruption/late tamper/transaction rollback, numeric compatibility and invalid budget rollback;
- worker23, pending13, integrity16, lifecycle14: every chunk, middle/tail memories, >100slow chunks one drain/claim/attempt, exceptional expiry recovery, terminal verdicts, cancellation, no false ack, retries and shutdown/timer ownership;
- fact-policy8: ledger-scoped mutation, atomic rollback for forget/correct/confirm, missing lane fail-closed and late forgotten-body fence;
- recall23: identical query after real forget/correction, project isolation, revision and search/cache races;
- capture28, ordinary privacy3, minimization canaries and original user-peer preservation: authority/fork bounds, native-shaped >200000 source equality and no plugin raw transcript copy.

Final mounted policy/import sequence bash-2458 COMPLETED exit0: nativepolicy35, import-gates36, import-lane105 PASS, on unchanged accepted build. [Policy log](../.tmp-import-lane/coordinator-b-final-policy.log) · [Import-gates log](../.tmp-import-lane/coordinator-b-final-import-gates.log) · [Import-lane log](../.tmp-import-lane/coordinator-b-final-import-lane.log). Original user peer values/attribution PASS in [preservation log](../.tmp-import-lane/coordinator-b-final-preservation.log). Independent complete Phase B review finished: NO additional material blocker against the authoritative phase gate, recommended scoped acceptance conditional on this final sequence; that condition is now satisfied. Reviewer verified real crash controls, all source/consumption/authority/mutation gates, missing-lane fail-closed production ownership, and restore-private versus sanitized-operational import contract. No tests duplicated or runtime/profile edits. Suite counts are separate named gates, not unique aggregate assertions.

## Known non-waived boundaries

Privacy redaction is best effort, not arbitrary-secret detection. Complete source retention and transient reconstruction have no global input-size cap; per-row/provider budgets do not imply globally bounded storage. Consistently rewritten text PLUS matching digest lacks an external golden root. Exceptional process suspension/real lease expiry preserves accepted progress for later recovery; it is not force-termination or guaranteed work completion after host shutdown. Human tombstone late-candidate fencing matches same scope/kind and case/outer-whitespace-normalized body, not semantic paraphrases. Logical future-use revocation does not assert immediate physical erasure of historical/backup bytes. Derived rows remain review-required and ineligible for injection; no retrieval or operational improvement is inferred from row counts.

Prior genuine failures, timeout and fixes are retained in [source-part report](MIGRATION-PHASE-B-SOURCE-PARTS.md), [native oversized/privacy report](MIGRATION-PHASE-B-NATIVE-OVERSIZE.md), [pending runtime report](MIGRATION-PHASE-B-PENDING-RUNTIME-COORDINATOR.md), and [fact-policy report](MIGRATION-PHASE-B-FACT-POLICY.md). No XFAIL waiver or sweeping history/reset/staging was used.

## Rollback

Accepted source snapshot target: [phase-b-accepted-4163229b9089.tar.gz](../migration-baseline/phase-b-accepted-4163229b9089.tar.gz), [verified SHA256 record](../migration-baseline/phase-b-accepted-4163229b9089.sha256): `fe75e5a0bf20512ef475170f3b34d76aa0070f75c3480ce9b5113d18ec0a099a`; checksum and gzip integrity checks passed. The archive includes the acceptance document before this external checksum annotation, not a self-referential digest. Archive includes repository source/scripts/client/manifest/plan/current evidence documents and API baseline, not dependency trees, runtime builds, synthetic temporary stores, or production data. Never run an older pre-part plugin against the new schema or blindly restore an archive over later/user edits. Rollback must be reviewed migration-authored hunks plus compatible store restore from a separately approved backup. Phase A snapshot remains unchanged. C–E remain pending and the overall goal remains active.
