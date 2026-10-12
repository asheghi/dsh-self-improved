# MIGRATION-PHASE-B-STORAGE.md — journal metadata minimization fix + Phase B storage API contract

Status: **journal metadata minimization fix implemented and adversarially
regression-verified (23/23 journal checks PASS, strict build PASSED).**
This increment owns exactly two files: [src/memory-journal-v02.ts](<src/memory-journal-v02.ts>)
(producer-header minimization + projectId redaction at the persistence choke
point) and [scripts/test-v02-journal.mjs](<scripts/test-v02-journal.mjs>) (two new
adversarial real-SQLite checks). `storage.ts`, `redact.ts`, `inject.ts`,
`redact.ts` call sites, `capture.ts`, `extract.ts`, `index.ts`, client code,
manifests and Git state were NOT touched. No production store, live profile,
provider or network call was used. Scope is deliberately narrower than all of
Phase B: this documents the storage/journal contract for the next
capture/extract integration instead of implementing that integration.

## 1. The defect (found by adversarial review of the header lane)

`MemoryJournalV02.appendSession` minimizes every **event text** before
persistence (`minimizeEventText` → `redact.ts`), but the producer **header
metadata lane** persisted verbatim:

- `producer.origin` and every `producer.extra` entry went into
  `journal_sessions.producer_header_json` and (copied by
  `planCoverageForSession` via `boundedJsonHeader`) into
  `journal_jobs.producer_header_json` with **zero redaction**;
- `projectId` went into the `project_id` column verbatim.

Because `extra` and `origin` are opaque producer facts, a coordinator/plugin
`APPEND` with `extra.apiKey: "sk-…"` would persist a credential canary
unredacted, child job rows included, and re-serve it later through
`JournalClaim.producerHeader` / `JournalJobView.producerHeader` to every worker.

## 2. The fix (single choke point)

New pure `minimizeProducerHeader()` (src/memory-journal-v02.ts), applied to
`input.producer` inside the enqueue transaction, before the session upsert;
job rows then inherit the already-minimized JSON. Layers, in order:

1. **Keyed redaction** (`redactObject`, existing, unchanged): any extra key
   whose normalized name is credential-shaped (exact hints, contains-hints,
   ends-with words — `apiKey`, `CLIENT_SECRET`, `deployToken`, …) has its
   value replaced with `[REDACTED]`.
2. **Free-text redaction** (`redactFreeText`): `origin` and every extra string
   value pass the labeled-assignment / well-known-token formats / private-key
   / URI-userinfo patterns.
3. **Structural containment** — this is why "text redaction alone is
   insufficient"; patterns are best effort, structure is not:
   - `origin` and every retained header field hard-bounded to 256 chars;
   - each retained extra string value hard-bounded to 256 chars
     (`HEADER_EXTRA_INDIVIDUAL_CHAR_BOUND`);
   - at most 32 extra entries (`HEADER_EXTRA_MAX_ENTRIES`); only scalar
     entries survive — nested objects/arrays/anything non-scalar is dropped
     whole;
   - a regex-invisible oversized value (no pattern match) is still cut by the
     per-value bound; proven by the `hugeOpaque` canary test, which matches no
     redaction pattern yet never persists past its bound;
   - extra eviction drops whole entries (last key first) while the full
     header JSON exceeds `HEADER_EXTRA_JSON_CHAR_BOUND` (2048) — the JSON is
     never sliced through credential text; the pre-existing `boundedJson`
     4096 fail-close ("{}") remains as the final gate;
   - non-finite numbers and empty keys are dropped; `delegated` and scalar
     benign facts (`plain`, numbers, `null`) survive so the header stays
     functional for workers.

`project_id` is now `boundText(redactFreeText(projectId), 256)` before
persistence. **Consequence (documented trade-off, fail-safe direction):** a
projectId that *looked* like a credential is stored redacted; a caller that
then filters `claimWork({ projectId })` or `revokeSessions({ projectIds })`
with the RAW value will not match the redacted row. Project identifiers must
not embed credential-shaped text.

## 3. New adversarial tests (real SQLite, no mocks)

Added to `scripts/test-v02-journal.mjs` (suite now 23 checks):

1. **`producer header minimization: extra/origin/project canaries …`** —
   appends a canary-laden header (`sk-`-shaped key, JWT, basic-auth carrier,
   labeled free-text, sensitive keys, frozen nested object, pathological
   number, `null`, a regex-invisible 600+40-char oversized value, and a
   projectId carrying `secret=` canary). Asserts by reading the REAL SQLite
   file that:
   the credential canaries + over-bound tail markers appear in NEITHER
   `journal_sessions.producer_header_json` NOR any
   `journal_jobs.producer_header_json` NOR the worker-visible
   `JournalClaim.producerHeader`;
   the persisted header remains valid JSON every time (a truncated
   credential fragment can never hide there);
   the `project_id` column is redacted;
   `delegated` and benign scalars survive so the claim/worker path still works.
2. **entry-cap / whole-entry eviction** — 64 oversized entries; asserts ≤ 32
   retained entries, every value ≤ 256 chars with the regex-invisible tail
   cut, and the whole persisted header ≤ 4096 chars, still valid JSON.

Result: **23/23 PASS** (`node scripts/test-v02-journal.mjs`),
**strict build PASS** (`npm run typecheck:v02`).

## 4. Documented Phase B storage/journal contract (for the next capture/extract integration)

### 4.1 Types (src/memory-journal-v02.ts, all exported)

- `JournalProducerHeader` — `{ delegated: boolean, origin?, parentSessionId?,
  rootSessionId?, inheritedEventCount?, extra?: Readonly<Record<string, string |
  number | boolean | null>> }`. `extra` is opaque provider facts; from this
  increment it is REDACTED + structurally bounded BEFORE persistence (§2).
- `JournalSourceEventInput` — `{ seq: number (int ≥ 0; 0 is legitimate),
  ts: number, kind: "user"|"assistant"|"tool", text: string (RAW in, minimized
  before persistence), sourceKind?: string, injected?: boolean }`.
- `JournalAppendInput` — `{ sessionId, projectId, producer, events,
  sourceMaxChars, jobKinds? (default ["extract"]), maxAttempts? (default 5) }`.
- `JournalAppendReport` — `{ sessionId, stored, deduped, conflictDeduped,
  jobsCreated, chunksPlanned, pendingSeqs }`.
- `JournalClaim` — `{ jobId, claimToken, kind, sessionId, projectId, fromSeq,
  toSeq, policyGeneration, cancellationGeneration, attemptsMade, maxAttempts,
  producerHeader, chunksTotal, chunksPending }` (producerHeader = minimized view).
- `JournalEvidenceEvent` — `{ seq, ts, kind, text (exactly the persisted
  minimized text), sourceKind, injected, segIndex, segCount, isPartial }`.
- `JournalChunkEvidence` — `{ status: "ok", chunkIdx, fromSeq, toSeq, events }
  | { status: "exhausted", message } | { status: "unavailable", chunkIdx,
  reasonCode: "missing-source-row"|"revoked-source"|"range-not-stored", message }`.
- `JournalVerdict` — `{ kind:"consumed", candidates } | { kind:
  "nothing-to-learn", note? } | { kind:"retryable", reason: "malformed-model-output"
  |"aborted"|"provider-truncated"|"unknown-terminal-finish"|"toolcall-finish"
  |"evidence-shortfall"|"transient", message } | { kind:"source-unavailable",
  reason:"missing"|"corrupt"|"revoked", message }`.
- `JournalCandidateInput` — `{ text, provenance (typed, NOT trusted by
  default), source?, scope?, kind?, importance?, confidence?, expiresAt?,
  evidence?: {sessionId, seq, snippet}[] }`.
- Reports/views: `JournalChunkCommitReport`, `JournalRecoveryReport`,
  `JournalRevocationReport`, `JournalStatusView`, `JournalRange`,
  `JournalJobView`; pure helpers `journalEventHash`, `minimizeEventText`,
  `journalTextSegments`, `planSourceChunks`/`PlannedChunk`; typed failure
  `JournalContractError` with codes
  `stale-policy-generation|stale-cancellation-generation|claim-invalid|lease-expired|chunk-state-invalid|revoked-session|closed|invalid-input`.

### 4.2 Exact API semantics (all on ONE SQLite connection)

| API | Semantics |
| --- | --- |
| `appendSession(input)` → report | One tx: session/producer header + minimized sources + job/chunk coverage commit together. Idempotent re-flush: same (session_id, seq) + same content hash ⇒ deduped; differing hash ⇒ conflictDeduped, NEVER overwritten (immutable lineage). Refused with `revoked-session` on revoked sessions; duplicated seqs in one batch ⇒ `invalid-input`. Failpoint: `append-source-tx-committed`. |
| `planJobsCoverPending(sessionIds?)` → counts | One tx: replan missing coverage over unconsumed/non-revoked sources, skip ranges covered by a live queued/claimed job, contiguous seq runs ⇒ one job, chunks per `planSourceChunks` with `chunkMaxChars` (default 6000). |
| `claimWork(filter?, leaseMs?)` → claim or null | One tx: oldest runnable queued job (kind/project filter honoured, retry_after respected) gets a fresh lease + claim token, attempt_count++. Policy snapshot RE-baselined to the current durable value when drifted; a job with a drifted cancellation snapshot is terminally cancelled instead. Failpoint: `claim-tx-committed`. |
| `readChunkEvidence(claim)` → evidence | Stale claim ⇒ `unavailable`/`range-not-stored`; all chunks acked ⇒ `exhausted`; missing/revoked coordinates ⇒ `unavailable` (never skipped silently); otherwise returns the exact persisted minimized text (per-segment when segmented). |
| `commitChunkResult(claim, chunkIdx, verdict)` → report | One tx: lease check (expired lease ⇒ durable release + `lease-expired` throw), idempotent re-commit of an acked chunk, generation gates, then consumed/nothing-to-learn: candidate inserts (`insertMemoryInTx`, dedup by `candidate_key` for retries) + chunk ack + consumed recompute + (last chunk) job done — all in the SAME tx. Retryable ⇒ state queued with deterministic backoff (30s·2^attempt, cap 15 min) or terminal failure at `max_attempts`. source-unavailable ⇒ terminal fail. Failpoints: `commit-chunk-pre-commit`, `commit-chunk-tx-committed`. |
| `releaseClaim(claim, reason)` | Durable return to queued, attempt budget preserved (stale rounds do not consume the failure count). |
| `bumpPolicyGeneration(reason)` / `bumpCancellationGeneration(reason)` | Durable monotonic counters in `journal_state`. Policy bump cancels every queued job created under an older generation. Cancellation bump cancels queued jobs immediately; a CLAIMED job keeps its lease but its commit is rejected and the job becomes terminally cancelled (late commits can never recreate revoked material). |
| `revokeSessions({sessionIds?: string[], projectIds?: string[], reason, invalidateMemories?})` → report | One tx: cancellation generation FIRST, affected queued jobs cancelled, sessions + sources flagged revoked (lineage immutable), and every derivative memory journal-derived from affected jobs quarantined via `MemoryStore.setMemoryStatus` in the same tx. Explicit empty selection or no selection = no-op (never a blanket revoke). |
| `recoverStartup()` → report | One tx: zombie claims (expired lease) requeued with budget preserved or terminally cancelled on stale cancellation snapshot; fully-acked open jobs marked done; missing coverage replanned. Idempotent. |
| Status reads | `getJob`, `listJobs`, `getConsumedRanges`, `pendingSessions`, `status`, `getPolicyGeneration`, `getCancellationGeneration`. |

### 4.3 Real `getMemoryRevision()` semantics (storage.ts, verified)

`MemoryStore.getMemoryRevision()` is a monotonic SQLite-backed counter
persisted in `store_state` (`memoryRevision`, only incremented inside a
committed transaction; durable across restarts — covered by check
`getMemoryRevision is monotonic …`:

- bumped, in the SAME transaction as the recall-affecting mutation, by:
  memory insert (`insertMemory`/`insertMemoryInTx`), explicit correction
  (meta update), forget, status transition (e.g. journal quarantine),
  memory-row deletion, journal source revocation, external import writes
  (`bumpMemoryRevisionForExternalWriter` — importer opens or rides its own tx);
- NOT bumped by popularity reads (`recordAccess`/read counts), FTS rebuilds,
  or structural repairs;
- journal producers/workers never call it directly: the bump rides inside the
  same `runInImmediateTransaction` as the journal mutation (the journal's
  `withTx`/`withTxInternal` own the transaction; `insertMemoryInTx` and
  tx-aware `setMemoryStatus` run within it).

`runInImmediateTransaction` is the ONLY sanctioned transaction seam (nested,
one connection, one writer); `getJournalSqlite()` is the narrowed raw handle
the journal uses under that seam — never standalone BEGIN/COMMIT on it.

### 4.4 Integration notes for the next capture/extract lanes

- **capture/producer lane**: enqueue per flush with raw `text` (the journal
  minimizes); keep `sourceKind` verbatim; `seq` = zero-based native index,
  line up `inheritedEventCount` for forks; put only non-credential, scalar
  disposition facts in `producer.extra` (values > 256 chars / non-scalars are
  dropped, and credential-shaped values fail closed to `[REDACTED]`).
- **extract/worker lane**: `claimWork` → `readChunkEvidence` → single typed
  `JournalVerdict` → `commitChunkResult`; treat `exhausted`/`unavailable`
  faithfully; malformed/aborted/truncated ⇒ `retryable` reasons, never
  fabricate acks; candidates must carry an honest `provenance` (omitted =
  fail-closed "unknown"), no implicit trusted tier.
- Boundary hooks (`MemoryJournalOptions.boundaryHook`) exist as durable-test
  instrumentation ONLY; production wiring must remain a no-op.
