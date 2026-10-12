# MIGRATION-PHASE-B-EXTRACT.md — journal extract worker lane (implemented + tested)

Status: **implemented and locally regression-tested. NO git commits (working
tree changes only), no production store/profile usage, no external provider,
no network, no live profile, no port 3082, no plugin-manager/exemption/skill
activation.** The durable store contract this lane consumes was verified
against the current working tree (not projected).

Reading basis (verified, current working tree, 2026-10-08):
[MIGRATION-PHASE-B-EXTRACT-DESIGN.md](<MIGRATION-PHASE-B-EXTRACT-DESIGN.md>)
(read-only design; all anchors found except as corrected below §6),
[MIGRATION-PHASE-B-STORAGE.md](<MIGRATION-PHASE-B-STORAGE.md>) §4.1–4.4,
[src/capture.ts](<src/capture.ts>) (seam contract, lines 63–93),
[src/memory-journal-v02.ts](<src/memory-journal-v02.ts>) (claim/read/commit/
release/recovery/revocation and the Workflow26 oversize pre-pass,
appendSession lines ≈888–918), [src/extract.ts](<src/extract.ts>) (system
prompt + gates), [src/compat-v02.ts](<src/compat-v02.ts>) (finish matrix),
[src/dedupe.ts](<src/dedupe.ts>) (classify/findNeighbors), src/shutdown-v02.ts
(signal union semantics).

## 1. What was implemented

### 1.1 NEW `src/extract-journal-v02.ts` (sha256 5d619194…7275c2)
One module, no new journal APIs, no new verdict values, no new events:

- `createJournalExtractWorker(deps)` — re-entrancy flag + `MIN_PUMP_INTERVAL_MS`
  = 30s throttle (parity with legacy `extract.ts`), loop `claim until null`,
  per-job inner loop bounded by `chunksTotal + 8`, per-chunk deadline check
  (`releaseClaim "shutdown-budget-reached"` + round end), stale/unavailable
  handling, and `JournalContractError("closed")` → pump stops without starting
  any further work (no active work after the owned handle closed).
- `createJournalExtractCall(deps)` — typed aux LLM call: per-request route from
  the LIVE `resolveAuxModelRoute(config)` view (explicit, fail-loud, no
  fallback guessing), per-request `maxTokens` getter, `AbortSignal.timeout
  (timeoutMs) ⊕ deadline` combined, thrown only when pre-aborted (never opens a
  stream), and blocked terminal finishes RETURNED as typed outcomes (not
  thrown) so the verdict mapping can distinguish `max-tokens` / `tool-calls` /
  `aborted` / `error` / unknown. Additionally, OWNED CANCELLATION STRICTLY
  PRECEDES COMMIT: if the deadline signal was already aborted when the
  provider outcome arrives, a consumed verdict is downgraded to
  `retryable/aborted` — no validated row commit and no late ack after shutdown
  cancellation (cancellation-generation trips are store-guarded by the journal;
  shutdown is the lane's own boundary).
- Verdict mapping (§3 matrix of the design): definitive `{"memories":[]}` on a
  `stop` finish and no-eligible-events chunks are the ONLY candidate-free acks;
  ≥1 gate-passing candidate → `consumed`; everything else
  (`malformed-model-output`, `provider-truncated`, `toolcall-finish`,
  `aborted`, `unknown-terminal-finish`, `transient`, `evidence-shortfall`) is
  `retryable` no-ack; `missing-source-row`/`revoked-source` relays verbatim as
  the typed `source-unavailable` terminal. No fabricated acks; a no-ack
  commit ends the job's run (the journal owns retry_after/backoff).
- Candidate gates = exact legacy semantics re-implemented over the durable
  chunk (extract.ts unmodified): `EXTRACTABLE_KINDS`, 2–500 content bound,
  `SENSITIVE_RE`, `looksTaskLocal`, `looksLikeInstruction`, verbatim quote ⇒
  `JournalEvidenceEvent.text` match, `minImportance` floor,
  `isPasteSuspiciousSlice` demotion (importance ≤7, confidence ≤0.6, scope
  forced project), `durableScopeForDraft` scope owner, read-only
  `findNeighbors`/`classify` pre-commit filter (duplicates DROPPED, conflicts
  kept with `conflict-of:` evidence). Strict is ALWAYS on for the lane
  (provenanceFilter "off" is a migration-only affordance and is not honored).
- Fail-close provenance: every commit candidate is `provenance:"derived"`,
  `source:"llm-extract"` / `"llm-extract-pasted"`; the provider JSON contract
  has no provenance/confirmed/permissions field and any provider-attested
  trust claim is structurally ignored; evidence coordinates are EXPLICIT
  `{sessionId, seq, snippet}` per matched event. No `pinBaseline` is called
  anywhere in the lane (store's `INJECTABLE_PROVENANCES` = user/persona keeps
  derived rows uninjectable; test-verified).
- Commit discipline: every ack goes through `seam.commitChunkResult` only
  (candidates + `journal_derived` dedup + chunk ack + consumed-range recompute
  + last-chunk job-done are the journal's single tx). The pump joins no caller
  transaction; the LLM await never spans a held tx. `processedSeq`/
  `advanceProcessed` is not touched anywhere on this lane.

### 1.2 Targeted `src/index.ts` snippets (sha256 0deef989…92ffe)
- `resolveAuxModelRoute` exported (single-line, design anchor §5.4) — shared
  route resolution for the worker's typed aux call.
- Legacy extraction drivers REPLACED at all four pre-existing drive points
  (`journalExtract.pump()` instead of `extractor.pump()`):
  1) flush callback inside `installCapture` (tracked, honours flushDrain);
  2) the 15-minute maintenance round promise chain;
  3) `fullReview` drain (covers nightly + manual `/memory evolve`);
  4) startup 60s backfill (routes through `fullReview`).
- Seam + worker construction sits above `installCapture` (worker closure alive
  before the flush listener registers); the old "worker lane not implemented"
  debug block is gone. The legacy `Extractor`/`extractLlm` construction was
  removed from the runtime; the legacy class itself is untouched in
  src/extract.ts (migration tooling / tests keep importing it).

### 1.3 NEW `scripts/test-v02-extract-journal.mjs` (sha256 c98a9a7c…ac1e7e)
20 real-contract test scenarios (below §4), all on genuine `MemoryStore`
SQLite files in unique tmpdirs + genuine `MemoryJournalV02` + the genuine typed
seam + genuine AbortSignal cancellation; the provider is a controlled fake per
the delegation ("fake provider controlled deltas"); the clock is injected
(shared by the journal's backoff and the worker's throttle — no wall-clock
flakes). An owned cleanup-free design: each test closes its store.

## 2. Confirmed store commit policy (explicitly checked, not assumed)

`commitChunkResult` runs `insertMemoryInTx` inside the journal's own
`store.runInImmediateTransaction` (memory-journal-v02.ts `withTxInternal`);
`insertMemoryInTx` itself asserts an open transaction and the store bumps the
memory revision in the same tx (storage.ts). Candidate inserts, candidate_key
dedup, chunk ack, consumed-flag recompute, and the last-chunk `state='done'`
transition are therefore ONE transaction on the ONE connection. Conclusion:
**the verified store commit policy supports the lane's same-tx commit/ack
contract.** The lane adds nothing that could leak a row outside a verdict.

## 3. Verified behavior proven by the new suite (all PASS, 20/20)

| # | Gate | Asserts |
| --- | --- | --- |
| 1 | Chunk discipline | one typed verdict per chunk, `exhausted`/done-report terminal stop, idempotent second round, consumed range `[0..1]`, derived provenance + explicit evidence |
| 2 | >batch long input | 4 bounded segment chunks of a 16k direct-human event; the MIDDLE segment reached the model, its verbatim quote became a memory; every prompt ≤ 7k chars (no head+tail omission) |
| 3 | Restart recovery | durable release after an acked prefix + real close/reopen of the same SQLite file + recoverStartup; resumed exactly at the first unacked chunk; `memories` never duplicated |
| 4 | Crash zombie lease | `recoverStartup` requeues an expired zombie claim; the worker drains it; done work never resurrects |
| 5 | Retry budget | malformed output stays retryable (no ack) with the journal's deterministic backoff honored (≤60s first-delta), then `failed` terminally after the attempt budget inserts nothing |
| 6 | Definitive empty ack | `{"memories":[]}` on stop acks; deterministically-rejected candidates are a validated empty with counter note (not a retry) |
| 7 | Retryable matrix | provider-truncated / toolcall-finish / error / unknown-finish / empty-text-on-stop / evidence-shortfall each keep `no ack`, surface their reason in `last_error`, insert nothing |
| 8 | Policy race | `bumpPolicyGeneration` while claimed + a LATE validated outcome ⇒ commit rejected `stale-policy-generation`, no late rows, no consumed range |
| 9 | Cancellation race | `revokeSessions` while claimed + LATE candidate ⇒ `stale-cancellation-generation`, job terminally cancelled, no late rows |
| 10 | Abort + transport | normalized `aborted` finish keeps even a carried candidate text uncommitted; thrown provider transport → `transient`, no rows |
| 11 | Owned close | store closed ⇒ pump returns claimed=0 quietly, no later work starts |
| 12 | Provenance fail-close | provider-attested `provenance:"user"`/`confirmed`/`permissions` ignored; commit stays derived/llm-extract; `injectableOnly` recall misses it; `baselines` table untouched (no pin) |
| 13 | Dedupe filter | duplicate against a trusted user row is DROPPED (no mergeDuplicate from a derived lane), no duplicate row |
| 14 | Fork control | delegated-header job released unprocessed (no LLM call, no extraction, no widening) |
| 15 | No-source control | empty journal ⇒ zero claims/calls |
| 16 | Throttle/re-entrancy | concurrent pump is an empty no-op; 30s window blocks |
| 17 | Lease | up-front lease ≥ 60s floor (no renew-lease API exists) |
| 18 | Oversize (Workflow26 fence) | oversize raw input rejects atomically with typed `source-too-large`: no source row, no coverage, nothing acked |
| 19 | Typed aux call | unresolved route fails closed with NO stream; pre-aborted signal throws before a stream; exact finish kinds surface (`max-tokens`), mid-stream lane abort → typed `signal-aborted` |
| 20 | (subset of above) | provider-failure mapping of an uncooperative shim keeps no-ack |

Relevant regressions re-run (real libs): scripts/test-v02-journal.mjs — **26/26
PASS** (unchanged journal contract incl. Workflow26 oversize header
minimization); scripts/test-extract.mjs — **ALL PASS** (legacy extractor
unaffected); scripts/test-v02-minimization.mjs — **PASS**; the full
real-launch runtime e2e (scripts/test-v02-runtime.mjs, isolated homes, stub
provider, egress guard, 5 cases) — **STRICT 199 PASS / 8 FAIL** — see J5 for
the classification of every failure (all 8 assert legacy-lane artifacts; the
case1 journal-lane behavior gates themselves PASS: "extraction aux call
happened on flush drain", "aux prompt carries the captured user slice", "aux
route matches the configured model", and case4's "accepted pending job is
drained by the first enabled flush after the disable window" all PASS through
this lane).

## 4. Test reality / honesty boundary

- The suite exercises claim/read/commit/release/revoke/recover **for real**;
  only the model call is fake (outcome-programmable, honoring the finish
  matrix). True-provider behavior is out of scope by delegation.
- The run used the emitted `lib/` — see §6 (build state) for how the lib was
  produced this round.

## 5. Divergences and maintained-open items

- **Oversize (Workflow26 fence): append-side `source-too-large` atomic reject
  is confirmed by test.** No canonical native reread/oversize solution exists
  yet; the extract lane keeps treating the retained minimized text as
  authoritative and keeps the long-input ceiling gate OPEN (a long event is
  segmented losslessly under the `chunkMaxChars`/`JOURNAL_SOURCE_MAX_CHARS`
  bounds; the ceiling itself and the missing `truncated` report counter stay
  the producer lane's open item — not solved, not re-acked here).
- **No cross-chunk/boundary quote acceptance:** a quote spanning a segment or
  chunk boundary cannot match and surfaces as bounded `evidence-shortfall`
  retrying, then terminal failure with `last_error` — maintained open per the
  design (a chunk-API change would be a journal contract change, not this lane's).
- **Legacy `Extractor` retirement is partial:** drivers replaced; the class
  stays in src/extract.ts. Cross-lane cutover cleanup and any baseline
  pinning ("user"-grade promotion) are later Phase B/C decisions — none here.

## 6. Build state and hash ledger (verification-unfriendly env facts)

- The repo-wide strict gate (`node scripts/typecheck-v02.mjs`) PASSED for the
  full tree **with this lane's sources** and emitted lib earlier this round
  (twice). Its final re-run is currently blocked — NOT by this lane: a
  concurrent writer added `src/import-v02.ts` (importer lane, untouched by
  this delegation) whose current working tree carries TS errors
  (`import-v02.ts(772,773,1218,1402,1417,1701,2039)`). Because emit-lib
  recompiles the whole src tree, the strict gate + emit became red mid-round.
- Per the file-ownership boundary, `src/import-v02.ts` was neither read into
  the diff nor fixed. This lane's strict verification and lib emission were
  instead completed with a guarded scratch compile of the extract-lane import
  closure (extract-journal-v02.ts + capture.ts compat-v02.ts dedupe.ts
  episodes.ts episode-review.ts evolve.ts extract.ts memory-journal-v02.ts
  recall.ts redact.ts storage.ts shutdown-v02.ts) against the EXACT validated
  rc.2 peer set (coordinator test site /home/bahman/github/dsh-v0.2,
  `@deepseek-ai/*` versions identical to the manifest pins; plugin-owned deps
  sqlite-vec/@node-rs/jieba symlinked from repo node_modules): **tsc -p …
  exit 0, strict:true**. Only the outputs of that closure were copied into
  repo `lib/` (build artifacts only; repo lib/index.js already contains this
  lane's index.ts rewiring from the earlier full emit). The repo-wide gate is
  expected to go green again as soon as the importer lane compiles cleanly.
- Source hashes at report time (sha256):
  - `src/extract-journal-v02.ts` 8f7f9b5bfa580bb1cf5660dc0f15ef59ccd2b3616366c76c1cb84d4df697c387
  - `src/index.ts` (rewired) 0deef98999c6385f206e8aeec98542a63a74b5684d4425412418ed79efd92ffe
  - `scripts/test-v02-extract-journal.mjs` c98a9a7c7d3a61884797f6bce1b085955972f8b7b918454ce1746253cfac1e7e
  - (untouched-contract sources verified while reading) `src/extract.ts`
    cab1bf5a…, `src/capture.ts` c1e049c5…, `src/memory-journal-v02.ts`
    e0b39d8f…

## 7. Interface issues found while implementing (explicit, not smoothed over)

- **J1 — no renew-lease API + pre-claim chunk-count unknown.** `claimWork`
  takes the lease at claim time, but `chunksTotal` becomes observable only
  inside the claim. With `timeoutMs` default 60s the design's formula
  `max(60s, (chunksTotal+1)*(timeout+5s))` cannot be evaluated before the
  claim, so the lane takes a single up-front lease sized
  `max(60s, LEASE_CHUNK_CEILING(32) × (perCall+5s))` (~35min at default
  timeout). A job whose chunk work outlives that lease gets a typed
  `lease-expired` at one commit, is durably requeued with the acked prefix
  intact, and resumes at the first unacked chunk. Recommend (journal owner):
  either a renew-lease call or a `peekChunks(jobId)` read so the lease can be
  sized without double-claim cost.
- **J2 — attempt semantics:** every successful claim increments
  `attempt_count`; the retryable budget `max_attempts` (default 5) is therefore
  a claim budget, and `releaseClaim` does not refund it. The lane claims once
  per job per round; every claim tool's follow-up design should treat
  attemptsMade as claim-attempts, not LLM-output attempts, if more precise
  accounting is wanted. Confirming behavior, not requesting a change.
- **J3 — `releaseClaim` on a done job resurrects it.** Verified in
  memory-journal-v02.ts: the commit path clears neither `claim_token` nor the
  lease when the last chunk ack transitions the job to `state='done'`, and
  `releaseClaimInternal` only token-checks — releasing such a claim would put
  a fully-acked DONE job back into `'queued'` (recovery re-marks fully-acked
  claimed jobs done at next startup, so it is not data loss, but it burns a
  claim cycle with pointless churn). The lane avoids it by treating a commit
  report of `jobState:"done"` as the terminal stop and by never releasing on a
  stale-claim read. Recommend (journal owner): clear `claim_token` on the
  done-transition and/or state-guard `releaseClaimInternal`.
- **J4 — convergence of the design's "canonical exhausted stop".** The
  journal marks the job `done` in the SAME transaction as the last chunk ack,
  so after a final ack the claim is no longer `claimed` and `readChunkEvidence`
  cannot return `exhausted`. The lane therefore honors BOTH terminal stops:
  the `exhausted` read (unreachable for just-finalized jobs; reachable for
  resumed/fully-acked-queued claims) and the authoritative `jobState:"done"`
  commit report (the design's sanctioned early exit). Semantics are identical;
  the report records this because the design's "canonical" wording assumed a
  different journal state transition order.
- **J5 — runtime e2e expectations (owner follow-up):** the full runtime suite
  (scripts/test-v02-runtime.mjs, run with the built lib this round) shows
  STRICT 199 PASS / 8 FAIL / 4 XFAIL (pre-existing DEFECT gates, 0 XPASS).
  Every one of the 8 strict failures asserts LEGACY-lane durable artifacts and
  none exercises this lane's own behavior:
  - 3 failures read the raw JSONL slice store (`case1/ordinary capture
    persisted one direct-human slice`, `case5`-adjacent `case2/fork child
    captured its own assistant output`, `case4/run A captured at least one
    slice`): the capture producer lane REMOVED the JSONL slice copies before
    this round (capture.ts's old `appendConversationSlice`+`markPending` lane
    is gone), so these were already stale before this extract lane ran;
  - 4 failures read the legacy `extract_state` cursor
    (`case1/… acknowledges the observed range`, `case1/extraction cursor
    …`, `case1/… attributed metadata … cursor`, `case4/… accepted pending
    job … cursor` and `case4/re-enable acknowledges …`): the cursor lane is a
    direct consequence of THIS lane's driver replacement (by design; the
    durable artifacts are now `journal_jobs` state + consumed ranges);
  - this lane's OWN e2e gates all PASS in the same run (case1 aux call on
    flush drain with the configured route + captured prompt; case4 quiescence
    and the accepted-job drain on re-enable).
  The runtime suite owner must re-pin those assertions to the journal lane's
  artifacts; this delegation did not modify that file.

## 8. Non-goals kept (explicit)

No capture.ts / memory-journal-v02.ts / storage.ts / inject.ts / redact.ts /
business.ts / client.js / importer / manifest edits; no git commits; no new
journal API; no new JournalVerdict values; no new config keys; no new timers;
no host events. Baseline pinning and provenance upgrades ("user") remain
out-of-lane Phase C decisions.
