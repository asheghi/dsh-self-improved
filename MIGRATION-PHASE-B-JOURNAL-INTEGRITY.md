# MIGRATION-PHASE-B-JOURNAL-INTEGRITY.md — journal-lane integrity + durable terminal-failure round

Status: **implemented (journal-lane fixes only) and locally regression-tested.**
NO git commits; no production store/profile usage; no live profile; no port
3082; no network; no provider; no plugin-manager / exemption / skill
activation; no deps changed; no new event kinds; no raw-transcript archive
(nor any other uncapped payload persistence) was added anywhere.

Owned edit surface (this round): `src/memory-journal-v02.ts`
(sha256 `25259ba3…c1ce82dc`) lifecycle/integrity changes, NEW
`scripts/test-v02-journal-integrity.mjs` (sha256 `8dcb7735…f56321d2`),
this report, and the repo `lib/` re-emission via the documented strict rc.2
gate (`scripts/typecheck-v02.mjs --emit-lib`; strict typecheck PASSED;
emitted `lib/` build artifacts only — `lib/memory-journal-v02.js`
sha256 `922ba98c…9f0426`). The runtime fixture, `src/index.ts`,
`src/extract-journal-v02.ts`, extractor/importer seams, storage, capture,
redact, inject, business, commands, manifest and Git were NOT edited. Policy
generation / cancellation runtime ownership stays with the separate policy
lane (workflow34); no root-config or global-policy key was introduced here.

Reading basis: demonstrated-remaining items from
[MIGRATION-PHASE-B-WORKER-REVIEW.md](<MIGRATION-PHASE-B-WORKER-REVIEW.md>)
§5 **F2** (terminal-`failed` was only restart-scoped: `recoverStartup`
re-planned failed ranges with a fresh attempt budget on EVERY boot) and
**F3** (the typed `source-unavailable` reason `"corrupt"` was unreachable,
with no storage-integrity validation), plus the adversarial-tamper and
authorized-retry contract language in this round's assignment.

## 1. F2 — durable bounded retries for terminal failure

**Demonstrated bug.** `recoverStartup` step 3 re-ran
`planJobsCoverPending()`, whose planner excluded only ACTIVE
(`queued`/`claimed`) coverage — so every boot re-enqueued a TERMINAL-`failed`
job's exact same Source range as a brand-new job with a fresh attempt budget
(`attempt_count = 0`) and re-ran real LLM cost for a deterministically
failing range. Bounded per process, unbounded across restarts.

**Fix (behavior change, contract now).**
- `planCoverageForSession` treats `failed` coverage like active coverage
  (`state IN ('queued','claimed','failed')`), so:
  - boot recovery (`recoverStartup` → `planJobsCoverPending`) no longer
    re-enqueues failed ranges;
  - later appends to the same session plan coverage that STOPS at the failed
    range (new work is never merged across a failed coordinate);
  - the failed durable row keeps its exhausted `attempt_count`,
    `max_attempts`, `last_error`, idempotency_key and exact coverage
    coordinates.
- A `cancelled` row's unrevoked sources STILL legitimately re-plan as FRESH
  jobs under the new generation (existing asserted CONTRACT NOTE of the
  worker-review suite — policy-change semantics, not failure-resurrection;
  regression-gated in the new suite A3).
- **Explicit authorized retry stays the ONLY path back to queued work:**
  NEW typed API `retryFailedJobs({ sessionIds? | projectId? | jobId?,
  reason })`:
  - fail-closed: no selection / empty selection ⇒ typed no-op report — a
    journal-wide blanket retry is impossible through this API;
  - keeps the idempotency key and requeues the SAME job id (the
    `journal_derived` candidate_key ledger keeps deduping replays to one
    memory row; a job whose key is already held by an active queued/claimed
    row is skipped, never double-planned);
  - resets the attempt budget to fresh **under authorization**: `reason` is
    recorded first-class in the job's `last_error` trail
    (`authorized-retry(<reason>): prior error …`); `retry_after_at`,
    `completed_at` cleared; policy/cancellation snapshots refreshed to the
    current durable values so the next claim re-checks honestly;
  - the acked chunk prefix stays acked; the claim resumes at the first
    unacked chunk; a still-deterministic failure fails terminally again —
    each authorization buys exactly ONE bounded budget.

## 2. F3 — tamper-evident evidence: the typed `corrupt` reason is reachable

**Demonstrated bug.** `JournalVerdict`'s typed source-unavailable reason
`"corrupt"` and its `readChunkEvidence` vocabulary were dead: the journal
could only ever report `missing`/`revoked`/`range-not-stored`, and nothing
validated stored bytes against the immutable enqueue metadata. Two real
adversarial tamper shapes were therefore publishable before this fix:
(a) a minimization text row rewritten in place, and (b) rows deleted
out of a planned whole-range (the availability gate only counted SOME
unsafely — a partially-deleted range could ack with a hole). A claim object
whose header was re-bound to a different session/range also slipped through
(genuine jobId + token, forged header).

**Fix.** Two tamper-boundary types are now real:

### 2.1 Exact integrity checks (both gates; never ack, never publish)

Checked **before the provider** (`readChunkEvidence`) and **again inside the
commit transaction** right before any ack / candidate insert
(`commitChunkResult`; refusal throws typed `chunk-state-invalid`, requeues
with `blocked-integrity:` last_error, zero derived rows, zero memories,
nothing consumed). The full check list in call order:

1. `verifyChunkAvailability` — semantic availability, hardened:
   - seg-mode: the single event row exists (`missing-source-row`) and is not
     revoked (`revoked-source`);
   - whole-mode with **zero** surviving rows: `missing-source-row`
     (unchanged planning-state meaning);
   - whole-mode with **some rows missing while others survive** (partial
     deletion inside the planned exact coverage): NEW `corrupt` — a planned
     range can never lose rows without a tamper trail, and the surviving
     subset must never ack as "fully covered";
   - whole-mode all-rows-revoked: `revoked-source` (unchanged §2.2 of the
     worker-review report).
2. `verifyChunkIntegrity` — revalidation against the immutable enqueue
   metadata, in order:
   - the session identity header row still exists for the job's session (the
     durable anchor of every evidence coordinate) else `corrupt`;
   - the chunk row's coordinates are the immutable enqueue-time planning
     shape: inside the job's coverage range, and the exact valid seg shape
     (`(0, -1)` whole mode, `(k, k)` k≥0 segment mode) else `corrupt`;
   - every surviving source row in range recomputes
     `journalEventHash({sessionId, seq, kind, sourceKind, injected,
     minimizedText})` and must equal the stored `event_hash` else
     `corrupt` — this is the text-tamper AND identity-field-tamper gate
     (kind / source_kind / injected are inside the hash tuple);
   - stored `text_chars` equals the actual persisted text length else
     `corrupt`;
   - the chunk's immutable planning metadata matches the surviving rows:
     whole-mode `event_count` == surviving row count and `chars` == Σ
     persisted text lengths; seg-mode `event_count == 1`, the planned
     segment index is inside the recomputed segmentation, and `chars` ==
     that segment's recomputed length. Forged metadata is `corrupt` in all
     shapes.
3. Claim-header identity gates (`claimIdentityMismatch`) — the claim
   object's `sessionId` / `kind` / `fromSeq` / `toSeq` must be an exact
   mirror of the durable job coordinates: a mismatching claim cannot READ
   (`readChunkEvidence` ⇒ unavailable `range-not-stored` with the identity
   message), cannot COMMIT (typed `JournalContractError("claim-invalid")`
   raised inside the commit transaction before any durable state moves), and
   cannot even RELEASE (typed `claim-invalid`). The read/commit/release trio
   are the tamper boundary the assignment names: a header mismatched on
   identity never acks or publishes.
4. Unchanged pre-existing commits-path gates stay exactly where they were:
   lease-expiry, stale-policy-generation (release + requeue), stale-
   cancellation-generation (terminal cancel). The integrity gate sits
   AFTER availability and BEFORE any insert/ack, so the at-least-once
   cascade (tampered read racing between gates) still cannot double-publish:
   the second gate re-refuses in the same transaction.

### 2.2 Behavior guarantees for legitimate use

- A legitimately unchanged reopen (same DB file, same options) recomputes
  identical hashes over identical bytes and passes every gate — suite B6
  drains whole-mode and seg-mode chunks with acked prefix across a genuine
  close/reopen with zero integrity refusals (existing suites independently
  confirm: full runtime battery unchanged).
- The `source-unavailable` typed verdict with `reason: "corrupt"` is now a
  REAL path (B8): the worker relays it, the journal terminally fails the job,
  and thanks to §1 the damaged range stays failed across boots — never
  implicitly re-pumped, only `retryFailedJobs` can touch it again.

### 2.3 Exact limitations (honest boundary of these checks)

- **Consistent-rewrite tamper is undetectable here**: an attacker who
  rewrites text AND recomputes `event_hash` (and `text_chars`/metadata)
  consistently leaves every stored invariant true — there is no external
  golden root / Merkle anchor in the v02 schema. Detecting that class needs a
  durable hash root outside the tamper surface (schema/content decision — a
  Phase C / storage-lane decision, NOT done in this lane).
- **Worker-lane relabel limit**: the worker seam
  (`src/extract-journal-v02.ts`, NOT edited here) maps the evidence
  `reasonCode` to the verdict reason as `revoked-source ⇒ "revoked"` and
  EVERYTHING else (including the new `corrupt`) ⇒ `"missing"`. The
  corrupted-evidence relay therefore still terminal-fails the job and never
  acks/publishes (behavior verified by the whole battery), but its verdict
  reason label will read `missing` in logs until the extract-lane owner adds
  the one-line `corrupt` mapping. The typed `corrupt` reason itself is fully
  reachable on the journal seam and exercised by the new suite (B1/B2/B3/B4/
  B5/B8), including via directly committed `source-unavailable/corrupt`
  verdicts.
- **Unchanged-reopen means same options**: `chunkMaxChars` is a constructor
  option; reopening a DB that was planned with a different `chunkMaxChars`
  legitimately re-segments long texts and would legitimately flag seg-mode
  `chars`/segment-bound checks as `corrupt`. That configuration drift is a
  documented limitation (integrity of the persisted plan is tied to the
  options that produced it), not part of the unchanged-reopen contract.
- **Revocation semantics untouched**: revoked rows never trip
  coverage/hash gates into `missing`/`corrupt` (they are legitimate consent
  events, reported `revoked-source` exactly as before).

## 3. Remaining lease / chunk-cap limitation (unchanged, still open)

- **J1 stands**: there is still NO `renewLease(claim, leaseMs)` or
  `peekChunks(jobId)` on the seam. The worker sizes its lease up-front as
  `max(60s, 32 × (perCallTimeout + 5s))` against the FIXED
  `LEASE_CHUNK_CEILING = 32` coverage units
  (`src/extract-journal-v02.ts:401–406`), because `chunksTotal` is only
  observable after `claimWork`. Input longer than the 32-chunk ceiling can
  outlive the lease and hit ONE typed `lease-expired` mid-job; the journal
  then requeues with the acked prefix intact and resume is candidate_key-
  idempotent, so the cost is **at-least-once, honestly** (never pretended
  exactly-once; asserted in the worker-review suite gate 5). This remains an
  extract-lane + journal-owner joint decision (`renewLease` recommendation
  stands).
- **Source oversize**: the closed item is unchanged — oversize raw input
  above the `sourceMaxChars` ceiling is rejected ATOMICALLY and typed
  (`source-too-large`) BEFORE any persistence, and no truncated survivor is
  ever stored/planned/acked (MIGRATION-PHASE-B-OVERSIZE.md). Still OPEN:
  canonical native reread for oversize sources (the flush may be retried
  after canonical reread support lands). No privacy uncapped archive and no
  new ad-hoc events were introduced for it (this round touched nothing
  oversize-related beyond keeping the fail-closed gate).

## 4. Test evidence (actual counts, all this round)

| Suite | Result |
| --- | --- |
| `scripts/test-v02-journal-integrity.mjs` (NEW) | **16/16 PASS** (A1–A6, B1–B9 real SQLite tampers + restarts) |
| `scripts/test-v02-journal.mjs` | 26/26 PASS |
| `scripts/test-v02-journal-worker-review.mjs` | 12/12 PASS (incl. CONTRACT NOTE cancel-replan + missing/revoked drills) |
| `scripts/test-v02-extract-journal.mjs` | 20/20 ALL PASS |
| `scripts/test-v02-capture-journal.mjs` | 28 PASS / 0 FAIL |
| `scripts/test-v02-safety.mjs` | 60/60 PASS |
| `scripts/test-v02-recall-races.mjs` | STRICT 23 PASS / 0 FAIL (0 XFAIL, 0 XPASS) |
| `scripts/test-v02-revocation.mjs` | PASS |
| `scripts/test-v02-minimization.mjs` | PASS |
| `scripts/typecheck-v02.mjs --emit-lib` | strict rc.2 gate PASSED, lib re-emitted |
| `scripts/test-v02-runtime.mjs` | **STRICT 215 PASS / 0 FAIL; 2 XFAIL (gated) / 0 XPASS — SUITE PASSED**, suite-start/end build pin stable (`1c8f5bc0a344…`) — see §5 |

## 5. Runtime e2e checkpoint (re-pinned facts — this round's ACTUAL run)

This round re-ran the full runtime suite against this round's re-emitted lib
(`node scripts/test-v02-runtime.mjs`):

- **STRICT 215 PASS / 0 FAIL; 2 XFAIL (explicitly gated down) / 0 XPASS —
  the SUITE PASSED; suite-start/end build pin is stable
  (`1c8f5bc0a344…`, exactly this round's emitted lib).**
- This SUPERSEDES the worker-review report's §4 baseline (STRICT 209/1 +
  1 XPASS, suite self-reporting FAILED): the one strict FAIL
  (`case4/re-enable …`) and the old XPASS gate were RE-PINNED by the
  runtime-fixture/extract lanes after that report was written. In today's
  tree the case4 re-enable drain gate PASSES on this round's journal lib
  (`acknowledges every accepted range … chunks acked=1/1, consumed=1/1`),
  and the two remaining XFAILs are the explicitly labeled THROTTLE-EXCLUSION
  gates (the wired `MIN_PUMP_INTERVAL_MS` throttle defect, an
  extract-lane/runtime-lane item, journal-free) — gated down by the suite
  itself, no XPASS surprises, no waived failures.
- Journal-side durable invariants audited by that suite (consumed↔acked
  exactness, done rows without live tokens, candidate ledger dedup across
  restart) all hold on this round's lib.

## 6. Non-goals kept (explicit)

No edits to `src/index.ts`, `extract.ts`, `extract-journal-v02.ts`,
`import-v02.ts`, `storage.ts`, `capture.ts`, `redact.ts`, `inject.ts`,
`business.ts`, `commands.ts`, `client.js`, runtime fixtures, or the manifest;
no new journal verdict values (the previously dead typed `corrupt` was made
reachable, none added); no schema changes (integrity uses existing durable
columns); no git commits; no config keys / root config / global policy
guesses (runtime generation/cancellation ownership stays with workflow34);
no timers; no live profile / 3082 / network / deps / skills; no raw archive
and no new ad-hoc event kinds.
