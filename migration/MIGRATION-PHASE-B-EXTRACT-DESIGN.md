# MIGRATION-PHASE-B-EXTRACT-DESIGN.md — read-only design for the journal extract worker lane

Status: **design + report only. NO source edited, NO Git touched, NO tests run, NO
network/profile/production use.** Workflow23 owns `capture.ts`/`index.ts` and was
actively editing them during this round — nothing in this document re-touches or
re-reads their working state beyond the verified sections below. This document
scopes ONE future lane (the extract worker over `MemoryJournalV02`); it does not
claim to complete Phase B.

Verified reading basis (all line numbers from the pre-design read, 2026 tree):
[MIGRATION-PHASE-B-STORAGE.md](<MIGRATION-PHASE-B-STORAGE.md>) §4.1–4.4,
[src/extract.ts](<../src/extract.ts>), [src/capture.ts](<../src/capture.ts>)
:45–120, :164–188, :236–268, [src/index.ts](<../src/index.ts>)
:219–311, :596–721, :780–863, :878–955, :1199–1229,
[src/memory-journal-v02.ts](<../src/memory-journal-v02.ts>)
:14–49, :85–306, :337–427, :603–632, :845–965, :995+, :1157–1690, :1802–1852,
[src/compat-v02.ts](<../src/compat-v02.ts>) :132–164, [src/storage.ts](<../src/storage.ts>)
:34–46, :584, :630–638, [src/migration-v02.ts](<../src/migration-v02.ts>) :784–801.

## 1. What exists today (verified, not projected)

- **Producer lane (Workflow23 / producer23 ownership, untouched here).**
  `installCapture` enqueues only the DIRECT-HUMAN gate via
  `toJournalSourceEvent` (capture.ts:164–188): `delegated:false` capture context,
  `user/message` with `source.kind === "user"`, never injected context
  (`isInjectedContextUserSource`), RAW text in, journal minimizes before
  persistence, `sourceMaxChars: JOURNAL_SOURCE_MAX_CHARS` (capture.ts:53).
  Assistant/tool/coordinator events are NOT enqueued by this lane.
- **One durable journal runtime.** index.ts:601 creates the single
  `MemoryJournalV02(store)`, `recoverStartup()` right after (index.ts:602–609),
  ingress-close flag for the append sink (index.ts:615–619, 1201–1207).
- **Seam exists, worker does not.** `createJournalExtractSeam(journal)`
  (capture.ts:82–93) is constructed at index.ts:718 but nobody drives
  `claimWork` — the debug log literally says "worker lane not implemented"
  (index.ts:720). There is **no** journal worker loop anywhere today.
- **Legacy full-range extractor loop still owns the old lane.** `Extractor.pump`
  (extract.ts:174–209) fans over `store.pendingSessions()` →
  `extractForSession` (extract.ts:214–329) → one LLM call per session → gates →
  `store.insertMemory` (provenance "user", extract.ts:273!) →
  `store.advanceProcessed(sessionId, toSeq)` (extract.ts:220–221 empty case,
  232 blank case, 327 terminal). This legacy shortcut hazard is §7.

## 2. Integration plan: the journal extract worker round

**Future module: `src/extract-journal-v02.ts`** (new file; naming follows
`storage-v02`/`shutdown-v02`/`compat-v02`). It consumes the existing seam and
**requires zero new journal APIs**.

### 2.1 Round algorithm (one claim at a time, all bounded chunks, explicit terminal stop)

```
runJournalExtractRound(seam, callLlm, gates):
  guarded by: re-entrancy flag + MIN 30s throttle (parity with extract.ts:174–183, 395)
  gates: readModule("extract") enabled; NOT while stale-claim storm
  loop outer:
    claim = seam.claimWork({ kind: "extract" }[, leaseMs])                   // sync, one tx
    if claim === null: return roundSummary (no runnable job / retry_after pending)
    if claim.producerHeader.delegated === true:        // defense-in-depth:
      seam.releaseClaim(claim, "delegated-header-outside-personal-lane")     // producer23 owns eligibility; worker never widens it
      error log (visible drift, never silent); END round
    leaseMs = max(60_000, (claim.chunksTotal + 1) * (perCallTimeoutMs + 5_000))  // no renew-lease API exists; lease must cover the whole job up front (§6 note)
    loop inner (max iterations = claim.chunksTotal + 8 safety cap):
      pre-guard: deadlineGate/pre-round signal.throwIfAborted() →
                 seam.releaseClaim(claim, "shutdown-budget-reached"); END outer loop
      ev = seam.readChunkEvidence(claim)                                     // sync, one tx; returns the NEXT pending chunk (idx-ordered, journal-side)
      exhausted        → break inner                                        // EXPLICIT TERMINAL STOP: acked full job; journal already marked done on last commit
      unavailable:
        chunkIdx === -1 (stale claim) → seam.releaseClaim(claim,"stale-claim-on-read"); break outer
        reason "missing-source-row|revoked-source" → relay verbatim as
          verdict {kind:"source-unavailable", reason:"missing"|"revoked"} via commitChunkResult  // journal terminal-fails the job (existing §4.2 semantics; NOT changed here); break inner
      ok → build prompt from ev.events (render as "User: <text>" lines; only kind==="user" && !injected events):
           zero eligible events → commitChunkResult(nothing-to-learn, note) → break/continue inner
           else one aux LLM call (signal = AbortSignal.timeout(settings.timeoutMs) ⊕ shutdownDeadlineGate.signal,
                mirroring extract.ts:232 + index.ts:659–664) → verdict per §3 → seam.commitChunkResult(...)
                on JournalContractError (claim-invalid/lease-expired/stale-*) → break inner;
                recovery owns the durable state; the worker never retries the commit itself
      rationale caps: iterations cap prevents any unavailable/corrupt corner from hanging the flush
```

- **"All bounded chunks"** = the inner loop runs until the journal's own
  `readChunkEvidence` reports `exhausted` (or a non-retryable terminal). The
  worker MAY early-exit when a commit report shows `jobState:"done"`, but the
  canonical stop is the `exhausted` read; never before.
- **Never inside a caller transaction.** The pump joins no transaction: every
  journal call opens/commits its own tx on the ONE store connection; the LLM
  await never spans a held tx (this is the §4.2 seam contract).
- **Flush/timer/review drive, no new events.** The worker is invoked from the
  same three lanes that already invoke `extractor.pump()` (§5 wiring). No
  `loader/*` or host event subscriptions; log-only status.

### 2.2 Commit discipline (same-tx ack — the journal's job, worker's rule)

- Acceptance path is EXACTLY one typed call:
  `seam.commitChunkResult(claim, chunkIdx, verdict)`. Candidate inserts
  (`insertMemoryInTx`), `journal_derived` dedup keys, chunk ack, consumed-range
  recompute and last-chunk job-done are ONE journal transaction
  (memory-journal-v02.ts:1375–1533, 1514–1521). The worker must never write
  candidates, `journal_sources.consumed`, or chunk acks by any other path (no
  raw sqlite, no `store.advanceProcessed` on this lane).
- **No fabricated acks.** A worker that cannot produce a validated terminal
  verdict issues `retryable` (§3) — malformed/aborted never advance any chunk.
  There is no API to ack a range without a verdict, and this design forbids
  looping `commitChunkResult` with a fabricated `nothing-to-learn` over other
  chunk indices.

## 3. Exact verdict mapping (finiteness: every outcome lands in ONE typed verdict)

Inputs: `evaluateTerminalFinish` matrix (compat-v02.ts:132–164 — only a `stop`
finish makes text complete), signal state, `extractJson`/`parseMemories`
validation (extract.ts:353–391, 412–431), candidate gates. All reasons below are
ALREADY enum members of `JournalRetryableReason` (journal:207–214) — zero new
verdict values, zero new events.

| Outcome | Verdict | Ack? |
| --- | --- | --- |
| JSON valid (`{"memories":[]}`) on a `stop` finish | `nothing-to-learn` (note = gate counters) | ack |
| ≥1 candidate survives all gates | `consumed` (validated candidates only) | ack |
| candidates exist but ALL fail verbatim-evidence match | `retryable`, reason `evidence-shortfall` | no |
| parse failed (no JSON), finish was `stop` | `retryable`, reason `malformed-model-output` | no |
| finish `max-tokens` | `retryable`, reason `provider-truncated` | no |
| finish `tool-calls` | `retryable`, reason `toolcall-finish` | no |
| caller signal aborted (timeout ⊕ deadline) | `retryable`, reason `aborted` | no |
| finish `error`/`absent`/unknown kind | `retryable`, reason `unknown-terminal-finish` | no |
| provider/network exception not caused by our signal | `retryable`, reason `transient` | no |
| chunk `unavailable` with `missing-source-row`/`revoked-source` | `source-unavailable` relay (`missing`/`revoked`) | terminal per journal |
| evidence list has no eligible direct-human events | `nothing-to-learn`, note `"no direct-human events"` | ack |

Retry semantics are entirely journal-side: retryable ⇒ queued with deterministic
backoff 30s·2^attempt (cap 15 min, journal:442–445), terminal failure at
`max_attempts` (default 5, journal:1375→1546–1575). `claimWork` honors
`retry_after_at` (journal:1165) — the worker simply ends the round when no job is
runnable. No worker-owned backoff, no worker-owned re-queue.

### 3.1 Candidate gates (parity with the legacy structural gate, no new classifiers)

Each parsed candidate is validated with the EXISTING exported pure helpers
from extract.ts (imports only; `Extractor` itself is NOT reused):

- `EXTRACTABLE_KINDS` + content bounds 2–500 chars + `SENSITIVE_RE`
  (exactly the `parseMemories` per-item validation, extract.ts:353–391 —
  re-implemented inside the new module over the durable chunk, or extracted;
- task-local / instruction: `looksTaskLocal`, `looksLikeInstruction`
  (extract.ts:107–119),
- verbatim quote: `isVerbatimUserEvidence(evidence, evidenceEvents)` semantics
  (extract.ts:121–130),NOW quoted against the chunk's `JournalEvidenceEvent.text`
  where `kind==="user" && !injected` (the same text every future reviewer sees —
  a fabricated-evidence regression is structurally impossible),
- importance floor (`minImportance`),
- paste-suspicion demotion: `isPasteSuspiciousSlice` on the matched evidence
  slice (extract.ts:143–152) → cap importance ≤7, confidence ≤0.6,
  `durableScopeForDraft` forced to project (extract.ts:157–163),
- scope owner: `durableScopeForDraft` (deterministic guards own global-vs-project;
  the model's scope field is a suggestion only).

### 3.2 Provenance / eligibility ownership (provider output cannot self-declare trust)

- Confirmed captures = direct-human producer lane ONLY (producer23's
  `toJournalSourceEvent` gate, capture.ts:164–188). This worker lane never
  re-derives or widens eligibility from model text.
- Extracted memories are INFERRED outputs → `provenance: "derived"`,
  `source: "llm-extract"` (`"llm-extract-pasted"` when paste-demoted) — the
  review-required lane (migration-v02.ts:784–801: derived is NOT injectable;
  `INJECTABLE_PROVENANCES` = user/persona only). No `pinBaseline` call lives in
  this lane; baseline pinning stays the legacy lane's behavior.
- The worker sets provenance/scope/importance caps deterministically; the model
  JSON contract has NO provenance/confirmed/permissions fields
  (EXTRACT_SYSTEM_PROMPT rule 1) and any provider-attested trust claim is
  ignored — trust only ever comes from the verbatim quote in retained journal
  text. This is the fail-close contract storage.ts:630–638 already enforces on
  write; the worker mirrors it before the write.
- The legacy lane's `provenance: "user"` at extract.ts:273 is NOT copied; it is
  a documented divergence of the pre-journal path (flag for its owner).

### 3.3 Deliberate divergences from the legacy path (required for honesty)

- **No `fallbackOnBadJson`.** The legacy `[auto summary]` low-value event
  (extract.ts:379–389) must NOT appear in the journal lane: a bad parse is a
  `malformed-model-output` retry, never a fabricated memory.
- **No `mergeDuplicate` here.** Duplicate classification reuses
  `classify`/`findNeighbors` (dedupe.ts) as a read-only pre-commit filter:
  duplicates are DROPPED at candidate validation (a retry keeps working via
  journal `candidate_key` idempotence); cross-chunk duplicate insertion is
  prevented the same way. Conflicts are stored flagged exactly as the legacy
  path does (conflict-of snippet evidence).
- **No `processedSeq` anywhere in this lane.** Consumption is
  `journal_sources.consumed` unions (`getConsumedRanges`), computed ONLY by the
  journal's `recomputeConsumption` (journal:1658–1690).

## 4. Retention, tracing and the complete-input question

- The consumer works ONLY on persisted minimized text (`JournalEvidenceEvent.text`
  is exactly the redacted+bounded persisted string, journal:172–186); redaction
  canaries can never reach a prompt this way.
- Per-event segmentation (`journalTextSegments`, journal:358–375) and chunk
  planning (`planSourceChunks`, journal:395–427) are LOSSLESS over the retained
  text: a 200k-char retained event becomes one chunk per segment (≤6000 chars
  each, `chunkMaxChars` default 6000, journal:630) and every segment is
  consumed separately — the middle of a retained event is never dropped, and
  multi-segment events get `isPartial`/`segIndex`/`segCount` so a quoting
  candidate stays inside one segment's text (accepted limitation: a quote
  spanning a segment/chunk boundary cannot match; bounded by `max_attempts`,
  then the job fails loudly — this lane does NOT change the chunk API to fix
  it; that would be a later journal contract change).
- Evidence coordinates persisted with accepted candidates use EXPLICIT
  `{sessionId, seq, snippet}` per matched event (defaulting to
  `evidenceSeqsForCoord` first-5 only when the worker omits them — claiming the
  default is NOT allowed when a specific quote exists).

## 5. Exact future edit locations (verified anchors; Workflow23 coordinates)

1. **NEW `src/extract-journal-v02.ts`** — everything above EXCEPT index.ts
   wiring: `runJournalExtractRound(...)`, typed aux LLM shim, verdict mapping,
   candidate gates. One-shot design; no journal/store changes.
2. **`src/index.ts:718` width** — after `createJournalExtractSeam`, build the
   worker (`const journalExtract = createJournalExtractWorker(extractJournalSeam,
   llmShim, {enabled:…, deadline: shutdownDeadlineGate.signal, …})`).
3. **Three drive points, all pre-existing, no new events:**
   - flush callback inside `installCapture` (index.ts:688–698): in addition to
     `extractor.pump()`, `journalExtract.pump()` — tracked by
     `trackAcceptedJob` exactly like the legacy pump job (same back-compat
     drain behavior).
   - 15-min maintenance round (index.ts:883–915): chain
     `journalExtract.pump()` into the `extractor.pump()` promise chain, still
     tracked + flushed by the same `.catch(...)`.
   - review drains (`fullReview`, index.ts:813–815; startup backfill at 60s,
     index.ts:942–955): call the journal worker BEFORE the legacy pump in the
     drain so recovery + pending backlog is bounded each round.
   This satisfies startup/release pump throttling: a big `recoverStartup`
   backlog (index.ts:602–609) drains job-by-job through the claim loop, with the
   30s-min in-flush throttle, `retry_after_at` and the deadline gate bounding
   LLM storm risk — no new timer, no new config keys, no new host events.
4. **`src/index.ts:289`** — change `function resolveAuxModelRoute` to
   `export function resolveAuxModelRoute` so the new module builds the typed
   LLM shim on the same route resolution (exact single-line change; no other
   index.ts edits needed in the LLM path).
5. **`src/extract.ts`** — no structural change REQUIRED. If desired later,
   re-export `parseMemories` internals as pure helpers; strictly OPTIONAL.
6. **`src/capture.ts` / `src/memory-journal-v02.ts`** — NO changes required by
   this lane. The truncation-report delta in §6 belongs to the storage/capture
   contract owners, not the extract lane.
7. **Shutdown** — ordering stays the existing `registerShutdownDrain` phases
   (index.ts:1199–1229): the journal worker holds no resources of its own; it is
   only tracked via `trackAcceptedJob`. The `dropIngress` journal-close at
   index.ts:1201–1207 already gates the producer side; the worker side needs no
   extra hook (deadline abort ⇒ `aborted` verdict ⇒ durably requeued).

## 6. sourceMaxChars long-input trimming hazard (identified; not fixed here)

**Hazard.** `appendSession` bounds every event with
`minimizeEventText(kind, text, sourceMax)` where for `kind:"user"` this is
`boundText(redactFreeText(text), budget)` (journal:337–348; `boundText` is a
plain head-slice, redact.ts:192–195). With `JOURNAL_SOURCE_MAX_CHARS = 200_000`
(capture.ts:53) a direct-human message longer than 200k chars is silently
head-truncated AT PERSISTENCE. **No raw archive exists** — the producer lane
removed the raw JSONL slice copies (capture.ts:161–162), journal_sources holds
only the minimized text, so the lost tail is unrecoverable. Coverage is
lossless only over the retained head; `planSourceChunks` consumes exactly the
retained text and cannot see the missing tail.

**Unrecorded detection gap.** `journal_sources` has no `truncated` column and
`JournalAppendReport` has no truncated count (journal:127–135, 893–952): the
`truncated` boolean from `minimizeEventText` is discarded in
`appendSession` (journal:917). Capture.ts's own comment ("honestly
head-truncated (report contract §source coverage)", capture.ts:47–52) promises a
report that today is nowhere implemented.

**Consequence for the extract lane (design, not fix):** the worker treats the
retained text as authoritative; a verbatim quote can only match inside it, so no
candidate can ever evidence-quote the dropped tail; a candidate whose real
support sat entirely beyond the 200k bound becomes `evidence-shortfall`/reject —
bounded, visible in `last_error`, never a fabricated ack. But the extraction is
blind to that boundary.

**Precise minimal fix (future, NOT this lane, owned by Workflow23/storage):
one counter, not a new event.** Add `truncatedEvents: number` (already-computed
`truncated` sum) to `JournalAppendReport` at the end of the per-event loop in
`appendSession` (journal:894–952, return site 962), and let the capture enqueue
lane log it when >0 (capture.ts:236–268 series). No schema migration, no new
journal method, no worker change needed to receive it. Alternatives (schema
column, raising the bound, multi-part events keyed `seq 0..n`) are documented
options only — none are required by this design and none are implemented here.

## 7. Legacy-lane shortcut hazards this design must not reproduce

- **Full-range ack after partial parse (legacy):** `extractForSession` calls
  `store.advanceProcessed(sessionId, toSeq)` unconditionally at the end of a
  run — empty slices (extract.ts:220–221), NULL-behavior "only-injected" batch
  (extract.ts:227–230), and even after parse/gate rejections (extract.ts:327).
  Combined with head+tail rendering with middle omission
  (`renderPrompt`, extract.ts:398–409), a session's whole pending range can be
  permanently validated-absorbed while its middle was never seen. The journal
  lane has no such shortcut: coverage is chunk-coordinate exact
  (`recomputeConsumption` union, journal:1651–1690) and each chunk ack requires
  a typed verdict on THAT chunk's evidence.
- **No second consumer/shortcut:** `planCoverageForSession`/recoverStartup
  replan missing coverage; the worker never pre-marks ranges, never trusts
  `chunksPending` against reads, and never acks from `commitReport.acked`
  alone.

## 8. Non-goals (explicit)

- No new journal API, no new `JournalVerdict`/evidence/finish enum members, no
  new config schema fields, no new host events, no new timers.
- No capture.ts/index.ts edits in this round (Workflow23 active); the design
  only names their anchors.
- No test files claimed. **No test was run or asserted in this document.**
- No production store/profile/writer usage: all conclusions are from source
  inspection plus the already-verified storage-contract doc.
- Baseline pinning, provenance upgrades ("user"), permission/confirmation
  synthesis and cross-lane cutover (legacy `Extractor` retirement) are later
  Phase B/C decisions — NOT this lane's deliverable.
