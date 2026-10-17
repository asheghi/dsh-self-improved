# Phase B oversize fail-closed append (MIGRATION-PHASE-B-OVERSIZE.md)

Focused correction report. Files touched (all in this session's ownership):
`src/memory-journal-v02.ts`, `scripts/test-v02-journal.mjs`, and this report.
No capture/index/storage/redact/inject/business/client edits, no profile,
network or data access.

## 1. The correctness gap (found, now closed)

`MemoryJournalV02.appendSession` called `minimizeEventText(kind, event.text,
sourceMaxChars)` (earlier line 917) and used only `minimized` **text** — the
returned `truncated` flag was discarded. Consequences:

- For raw event text **above** the per-append `sourceMaxChars` retention bound,
  the retained survivor is head-truncation only: head/tail bounding can drop
  the **middle** of the raw text entirely.
- That lossy survivor was still stored as the minimized source row and
  `planSourceChunks`/coverage planned it as a fully-consumable coordinate, so
  chunk commits **acked the original seq** while the extractor could never have
  read the dropped middle/tail. Silent provenance-wrongful "full coverage".
- The capture ceiling (`JOURNAL_SOURCE_MAX_CHARS = 200_000`, passed by
  `src/capture.ts:258`; see [MIGRATION-PHASE-B-CAPTURE.md](<MIGRATION-PHASE-B-CAPTURE.md>)
  §3) is generous but does **not** make anything above it lossless — it only
  keeps the loss region rare.

## 2. The fix: atomic typed rejection BEFORE any partial enqueue

Decision honored: **small safe rejection now** — NOT long-input gate
acceptance, NOT a blanket uncapped raw archive, NOT a segmented-lossless
acceptance (that needs canonical reread; see §4).

Implementation in `appendSession` (single `runInImmediateTransaction`; the
journal's only connection is the writer):

- A **read-only pre-pass** normalizes kind, minimizes every event and flags
  `truncated === true` BEFORE the session header upsert, BEFORE any
  source/job/chunk write. Any offender →
  `throw new JournalContractError("source-too-large", …)` with detail
  `{ sessionId, sourceMaxChars (EFFECTIVE bound), seqs (first 32),
  offendingCount }` — never raw text, so the typed error cannot leak the very
  content the minimization budget refused.
- The throw aborts the whole surrounding transaction: nothing durable remains
  (no session header, no source rows, no coverage job/chunks), no consumed
  coordinate advances, and the `append-source-tx-committed` boundary hook never
  fires on the throw path.
- **Caller cursor semantics** (verified read-only in `src/capture.ts`,
  flush block): the capture native cursor `journalSeq` advances ONLY after a
  successful append. The typed rejection therefore leaves the native cursor
  unacked and the next flush replays the same floor — the documented
  retryable-stall until the producer shrinks/splits or canonical reread
  support lands. Capture warns in the debug log and does not advance.
- Idempotence intact: a re-flush of content already stored **under** the bound
  (identical minimized hash) is still plain dedup; exact-bound text
  (`length === sourceMaxChars`) is not truncation and stores normally.
- New strictness only in the gate: a non-finite `sourceMaxChars` is now
  `invalid-input`; an oversized text under a tiny bound floors at
  `MIN_BOUND_CHARS` (64) and still rejects (detail reports the effective
  floor). Chunk/evidence/commit paths are untouched.

## 3. API delta (minimal)

- `JournalContractError` union gains exactly one code: **`source-too-large`**
  (typed, retryable-by-replay contract error).
- No producer/worker method signatures, report shapes, schemas or verdict
  surface changed. `minimizeEventText`'s doc documents that `truncated:true`
  must now be treated as a rejection trigger by persistence paths.

## 4. Exact remaining gap — canonical reread requirement for the extractor

- Above-ceiling raw input is now **unavailable to the journal by contract**
  (rejection, not lossy retention). An extractor lane that needs byte-complete
  coverage of such coordinates MUST use canonical native reread —
  `Session.ownEvents()` over the untouched native history — as the capture
  report already anticipates (§3, "above the ceiling … must use native
  reread"). Lossless segmented evidence spans only the **persisted
  minimized** text under the ceiling (`planSourceChunks`/
  `journalTextSegments` are lossless over what was stored); the journal
  cannot re-derive what it was never told.
- Coordination note for the capture/extractor owner (not edited here): flushes
  containing an over-ceiling event now fail forever until that event is
  shrunk/split or native reread support is added. The typed error detail
  (`sessionId`, effective bound, offending seqs) is the coordination payload.
- **Legacy rows**: source rows persisted by builds before this fix may contain
  head-truncated text; truncation is not detectable post-hoc from a stored row
  alone (no pre-fix boundary flag was recorded), so no schema flag was added
  (minimal-change principle). Their acks remain lossy-relative-to-native until
  canonical reread interpretation supersedes them. Fresh databases can never
  create such rows (the gate is unconditional on truncation).

## 5. Verification (actual results, this session)

- `node scripts/typecheck-v02.mjs --emit-lib` — PASSED (strict, rc.2
  contracts); `lib/` regenerated from current sources.
- `node scripts/test-v02-journal.mjs` — **26/26 PASS** (was 23; +3 new
  oversize checks):
  1. oversize append rejects ATOMICALLY with typed `source-too-large` —
     no ack, no coordinate advance, no persisted session/source/job/chunk,
     detail pinpoints the seq and bound without carrying raw text, and a
     compliant re-flush on the SAME session id then claims/commits normally
     (native-cursor-retention proven end-to-end);
  2. user/assistant/tool kinds all gated; a MID-BATCH offender aborts the
     whole batch with the offender's seq pinpointed and zero half-enqueued
     state;
  3. gate exactness: exactly-at-bound text stores losslessly; oversize text
     under a tiny bound still rejects with the effective `MIN_BOUND_CHARS`
     floor in the detail.
  All pre-existing 23 checks (lossless long under-ceiling, real-SIGKILL
  crash boundaries, dedup/idempotence, generations, revocation) pass
  unchanged.
- `node scripts/test-v02-capture-journal.mjs` — **28/28 PASS** (its
  long-input contract test stays under the ceiling; re-flush dedup intact).
- `node scripts/test-v02-safety.mjs` — **60/60 PASS** (unrelated regression
  confirmation only).
