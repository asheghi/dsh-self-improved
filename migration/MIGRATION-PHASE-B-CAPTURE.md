# MIGRATION-PHASE-B-CAPTURE.md — narrow capture→journal producer-lane integration

Status: **implemented and verified this increment on an isolated synthetic
persistence** (real `node:sqlite` stores in unique `Os.tmpdir()` trees; no
production store, live profile, port 3082 listener, provider, or network
call). Strict rc.2 typecheck PASSED and `node scripts/typecheck-v02.mjs
--emit-lib` regenerated the committed lib from current sources.

## 1. Ownership and non-ownership

Owned by this increment:

- [src/capture.ts](<../src/capture.ts>) — producer lane: the raw JSONL slice
  copy is REPLACED by an atomic journal enqueue of only eligible
  direct-human evidence; allowlist producer header; opaque projectId;
  journal extraction seam types; enqueue-cursor lifecycle.
- [src/index.ts](<../src/index.ts>) — targeted lifecycle snippets only: ONE
  `MemoryJournalV02` instantiation + `recoverStartup()` at plugin start;
  the ingress-close signal inside `dropIngress`; sink wiring into
  `installCapture`; the documented (unimplemented) extractor seam
  reference.
- [scripts/test-v02-capture-journal.mjs](<../scripts/test-v02-capture-journal.mjs>) —
  NEW focused capture→journal suite (28 checks, real SQLite).
- [scripts/test-v02-safety.mjs](<../scripts/test-v02-safety.mjs>) — one hunk:
  positive control C now observes "captured exactly once (incl. seq 0)"
  through the REAL journal lane instead of the removed raw slice lane
  (behavior tracked, nothing weakened; every other check unchanged).
- [MIGRATION-PHASE-B-CAPTURE.md](<MIGRATION-PHASE-B-CAPTURE.md>) — this report.

NOT touched: `extract.ts`, `storage.ts`, `memory-journal-v02.ts`,
`inject.ts`, `redact.ts`, episode/business/client code, manifests, Git
history. The legacy extractor still drains pre-existing backlog from
`readSlices` unchanged; process-local JSONL files that already exist in
old stores are NOT migrated or deleted by this increment (no production
store writes of any kind).

## 2. What actually changed in the producer lane

- **Replacement of the raw transcript copies**: `installCapture` no longer
  calls `store.appendConversationSlice(...)` / `store.markPending(...)` for
  new evidence. Every `session/flush` enqueues through the ONE journal
  sink inside the journal's own append transaction, with RAW text passed
  in and minimized-before-persist as the journal's single choke point
  (privacy before any owned write; the capture layer keeps no copy in heap,
  logs, or files). Leak-shaped consequence: the previous defect ("unredacted
  user/assistant text through the JSONL writer") is eliminated at the
  writer, not patched at a reader.
- **Eligibility gate (`toJournalSourceEvent`)**: only
  `source.kind === "user"` messages that (a) are not injected-context
  sources (`isInjectedContextUserSource`: plugin/agent-instructions/
  skill-*/snapshot/recall forms), (b) live in a NON-delegated session, and
  (c) carry text are enqueued (`kind: "user"`, `injected: false`,
  `sourceKind` verbatim, 128-char bound). ordinary assistant/tool
  producers, coordinator briefs and relays (delegated sessions,
  `isDelegatedHeader` authority), scheduled/injected/unknown/private and
  excluded producers therefore persist NO personal-lane text through
  capture. The canonical NATIVE session history (`Session.ownEvents()`)
  is untouched and remains the full record; `toSlice` is kept exported for
  the legacy unit surfaces (test-hermes provenance checks).
- **Fork boundary + seq 0**: the same rc.2 floor
  (`inheritedEventCount - 1`, -1 when unset) applies to the journal window
  via `readOwnSessionEvents`, so an inherited fork prefix is never
  enqueued and a legitimate exact seq-0 own event is. Beyond the cursor,
  the journal's immutable (session_id, seq, event_hash) lineage dedup
  makes every re-flush idempotent (`deduped`) and differing content is
  `conflictDeduped`, never overwritten (inherited-fork dedup honesty: the
  cursor map is an in-process optimization only, durability belongs to the
  journal).
- **Producer-header structural allowlist (`journalProducerHeader`)**: ONLY
  categorical facts are copied — `delegated`,
  `inheritedEventCount` (floor 0), and the parent/root ids when they are
  plain strings (256-char bound) — plus the subagent-service
  `origin: "subagent"` sentinel. NO arbitrary `session.header` payload is
  spread; `producer.extra` is NEVER constructed from capture (stays
  `{}` after the journal's minimizer). Verified: header-injected
  credential canaries persist nowhere (session header JSON, job rows,
  worker-visible `producerHeader`, or projects).
- **Stable opaque projectId (`opaqueProjectIdFromKey`)**:
  `pj-<sha256[:32]>` of the normalized full project key. It is stable
  across restarts and sessions of the same project, is NOT a clipped or
  basename path, and contains no path text. The legacy path-derived key
  still flows to `session_projects` exactly as before (legacy consumers
  unchanged); the journal's project column is opaque identity only.
- **Crash-safe enqueue**: cursor advance happens only after
  `journalSink.append(...) returns`. A crash/throw before the journal
  commit leaves the floor untouched, commits nothing (including job
  coverage), and the retry re-enqueues the same window which the journal
  dedups. A failed enqueue is warned with an error string only — never
  event text.
- **Ingress/lifetime**: `dropIngress` in the shutdown drain now (1)
  unregisters the flush listener and (2) sets the journal ingress-closed
  flag, after which `closed()` rejects any further enqueue BEFORE any
  owned write. Enqueued work remains durable and is recovered by
  `recoverStartup()` on the next boot; the drain then only settles
  accepted work before `store.close()`. ONE journal instance exists for
  the plugin lifetime; its connection is the store's narrowed raw handle
  under `runInImmediateTransaction`, so no journal-side close call is
  needed and none is attempted.

## 3. Published producer→worker contracts (narrow seam; extraction NOT implemented)

`src/capture.ts` types the seam once, `src/index.ts` instantiates it over
the single journal:

- `JournalCaptureSink` — `{ append(JournalAppendInput) → JournalAppendReport,
  closed(): boolean }`. This is ALL the ingest surface. Non-goals of the
  producer lane: no claim/commit/verdict calls, no coverage planning beyond
  the append's own job coverage, no boundary hooks in production.
- `JournalExtractorSeam` (built by `createJournalExtractSeam(journal)`) —
  `claimWork(filter?/leaseMs?)`, `readChunkEvidence(claim)`,
  `commitChunkResult(claim, chunkIdx, verdict)`, `releaseClaim(claim,
  reason)`, `revokeSessions(input)`, `bumpPolicyGeneration(reason)`,
  `listJobs(filter?)`, `status()`. Each field is a direct delegation to the
  documented journal API in §4.2 of
  [MIGRATION-PHASE-B-STORAGE.md](<MIGRATION-PHASE-B-STORAGE.md>); no
  behavior is added and NO worker loop, verdict policy, or candidate
  construction is implemented in this increment (the debug log surfaces it
  for contract checks only).
- **Worker obligations these tests pin** (for the NEXT Phase B lane): treat
  `exhausted` AND the settled end state (job `done` after the last ack ⇒
  later reads report `unavailable`/stale-claim) as faithful terminals —
  never re-read or fabricate acks; drain EVERY segment through
  `readChunkEvidence`'s per-event `segIndex/segCount/isPartial` fields; a
  lease-expired or stale-generation claim is released, never committed.
- **Source coverage contract (long input)**: `sourceMaxChars` is passed by
  capture as `JOURNAL_SOURCE_MAX_CHARS = 200_000` — a GENEROUS ceiling,
  not the pipeline budget. Persisted minimized text is segmented
  losslessly (`planSourceChunks`/`journalTextSegments`, 6000-char chunks):
  verified that head, middle and tail markers of a >6000-char direct-human
  turn ALL survive chunked evidence, so no silent middle/tail drop occurs
  inside the ceiling. Above the ceiling the minimizer honestly head-truncates
  (the tail of that one event is not persisted; `minimizeEventText` is the
  deterministic reread function and native history remains the record);
  an extractor lane that needs byte-complete coverage beyond the documented
  ceiling must use native reread (`Session.ownEvents()`), not the journal.
  Candidate memories built from a truncated event must state that
  provenance. NOTE the exact branch ownership: **segmenting the long tail
  is a JOURNAL worker property (`readChunkEvidence` chunk/segment
  evidence)** — capture neither re-segments nor acknowledges anything.
- **Memory-store secret writes are NOT covered here**: candidate
  redaction/`insertMemoryInTx` behavior belongs to the NEXT worker lane
  (verified read path shows minimized text only; no memory-row assertions
  made, so no whole-Phase-B claim).

## 4. Actual results (this session, isolated synthetic persistence)

- `node scripts/typecheck-v02.mjs` — PASSED (strict, pinned rc.2 dts);
  `--emit-lib` regenerated `lib/` (map-free) from current sources.
- `node scripts/test-v02-journal.mjs` — **23/23 PASS** (unchanged journal
  core, including the real-SIGKILL durability checks).
- `node scripts/test-v02-capture-journal.mjs` (NEW) — **28/28 PASS**:
  direct-human canary minimization in REAL persisted rows (`[REDACTED]`
  markers present, canary values absent, ordinary prose retained);
  `pj-<hex>` opaque project identity equality; NO raw JSONL transcript
  file written; allowlist-only producer header (closed key set,
  `extra: {}`, header-injected canaries persist nowhere); fork prefix
  never enqueued + exact floor seq enqueued; assistant/tool/injected/
  unknown/turn-end → exactly ONE enqueued source (the direct-human turn) /
  delegated coordinator brief enqueues NOTHING; crash-at-enqueue commits
  nothing (incl. zero job rows) and the retry is seq0-safe exactly-once
  with a content-hash deduped re-flush; closed ingress performs zero
  appends; long-input coverage lossless through the read/commit contract
  to a terminal evidence state; seam claim/read/release contract with
  minimized worker-visible `producerHeader` and durable requeue without
  attempt-budget consumption.
- `node scripts/test-v02-capture-privacy.mjs` — **PASS** (3/3): the raw
  credential can no longer reach plugin persistence because the raw
  slice writer is gone from the flush path and the only remaining
  persistence is the journal's minimized enqueue (honesty evidence
  carried by the new suite's real-DB canary checks, not by test weakening).
- `node scripts/test-v02-safety.mjs` — **60/60 PASS** (control C
  re-targeted to the journal lane exactly once incl. seq 0; raw slice
  count asserted ZERO on the enabled run).
- `node scripts/test-phase-a.mjs` — **38/38 PASS** (fork cut/seq0/disabled
  gate unaffected; fork-prefix assertion now holds vacuously at the slice
  layer because the slice lane is replaced — the real fork boundary is
  asserted against the journal lane in the new suite).
- `node scripts/test-hermes.mjs`, `test-extract.mjs`,
  `test-recall.mjs`, `test-commands.mjs`, `test-settings-ui.mjs` — **ALL
  PASS**.
- Legacy limitation preserved (NOT regressed, NOT claimed fixed here):
  note that per-event minimization uses `redactFreeText` patterns; a
  pattern-invisible secret inside direct-human text still passes the
  structural bound (documented in MIGRATION-PROGRESS.md) — consent UX
  disclosure remains a requirement; ordinary extraction producer text now
  never persists through capture at all, which RETIRES the biggest
  ordinary-capture secret surface.

No live DB, profile, or external model was used; no dependency, exemption,
or skill change occurred; no Git operations were performed.
