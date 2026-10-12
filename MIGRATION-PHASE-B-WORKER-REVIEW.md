# MIGRATION-PHASE-B-WORKER-REVIEW.md — independent narrow-scope lifecycle review of the Phase B journal worker lane

Status: **implemented (targeted journal-lifecycle fixes only) and locally
regression-tested.** NO git commits; no production store/profile usage; no
live profile; no port 3082; no network; no provider; no plugin-manager /
exemption / skill activation; no deps changed.

Owned edit surface (this round): `src/memory-journal-v02.ts` lifecycle fixes,
NEW `scripts/test-v02-journal-worker-review.mjs`, this report, and the repo
`lib/` re-emission (build artifacts only, via the documented strict rc.2 gate).
The runtime fixture assertion file, index, extractor/importer seams, storage,
capture, redact, inject, business, client, manifest and Git were NOT edited.

Reading basis (actual current tree, verified):
- [MIGRATION-PHASE-B-EXTRACT.md](<MIGRATION-PHASE-B-EXTRACT.md>) interface items
  J1–J5 (their hashes matched the working tree at review start — confirmed:
  `src/extract-journal-v02.ts` 8f7f9b5b…7c387, `src/index.ts`
  0deef989…92ffe, `src/memory-journal-v02.ts` e0b39d8f…8c1c8).
- `src/memory-journal-v02.ts` appendSession/planCoverageForSession (≈1072–1166),
  claimWork (≈1240–1315), readChunkEvidence (≈1319–1424), commitChunkResult
  (≈1455–1670), revokeSessions (≈1785–1878), recoverStartup (≈1876–1938),
  releaseClaim / releaseClaimInternal (≈1440–1455, ≈2026–2046),
  verifyChunkAvailability (≈1674–1718), bumpPolicyGeneration /
  bumpCancellationGeneration (≈829–873), schema (≈659–789).
- `src/extract-journal-v02.ts` pump loop (≈408–466), runClaimedJob (≈475–624),
  verdict mapping (≈666–870), lease sizing (≈393–406).
- `src/index.ts` worker construction and all four drive points (≈664–717,
  ≈838–855, ≈908–911); `src/capture.ts` seam contract (≈63–92).
- Runtime `forget` path (`src/commands.ts` ≈80–89, `src/business.ts`
  ≈337–343) to ground the true-cancel finding.

## 1. Verdict on the extract report's J1–J5 (all verified against code)

| Item | Verdict | Published fix / disposition |
| --- | --- | --- |
| J1 lease sizing | **Confirmed as written.** No renew-lease API; lease is sized up-front (`extract-journal-v02.ts:404`, `MAX(60s, 32×(perCall+5s))`) because `chunksTotal` is observable only after `claimWork`. A job outliving the lease hits typed `lease-expired` at one commit; requeue keeps the acked prefix; resume is candidate_key-idempotent. **Kept open (journal owner):** still recommend `renewLease(claim, leaseMs)` or `peekChunks(jobId)`. This lane deliberately did NOT add an unused API — the worker seam cannot call it without an extract-lane edit that was out of scope. | open, journal owner |
| J2 attempt semantics | Confirmed ("claim budget", not LLM-output budget). No change needed; behavior documented and test-covered. | closed |
| J3 done resurrection | **Confirmed real and reproduced live**: final-chunk commit left `claim_token`/`lease` on the `done` row and `releaseClaimInternal` had no state guard — a release carrying the stale token flipped a fully-acked DONE job back to `queued` and it was re-claimable. **FIXED** (§2.1). The worker's own avoidance (never releasing on a `done` report) was and remains correct. | **fixed** |
| J4 dual terminal stop | Confirmed correct; both stop senses (`exhausted` read + `jobState:"done"` report) are exercised in the new suite's multi-chunk paths. | closed |
| J5 runtime e2e 199/8 | **The claim is STALE, not accepted.** Re-ran `scripts/test-v02-runtime.mjs` after re-emitting lib: it now reports **STRICT 209 PASS / 1 FAIL; 3 XFAIL (gated) / 1 XPASS (surprise)** — the suite file has been re-pinned since the extract report (1 XFAIL was promoted; a defense gate now newly PASSES). See §4 for the one strict FAIL (pre-existing, evidence below) and the XPASS. | re-pinned facts below |

## 2. Lifecycle fixes implemented in `src/memory-journal-v02.ts` (sha256 b47de035…48aa)

### 2.1 J3 seal — done rows can never be resurrected
- **Commit path (memory-journal-v02.ts:1569–1583):** the final-chunk done
  transition now clears `claim_token = NULL, lease_expires_at = NULL` **in the
  SAME transaction** as the last ack (consumed and nothing-to-learn paths both
  funnel through it).
- **`releaseClaimInternal` state guard (2030–2046):** the requeue UPDATE now
  carries `AND state = 'claimed'`. A release request against a done / failed /
  cancelled row (stale token, or even a forged still-live legacy token) is a
  typed no-op — done work stays done; cancelled work is never requeued for a
  pointless churn cycle before the next claim's generation gate.
- **Recovery paths get the same seal:** `recoverStartup`'s zombie
  terminal-cancel (1899–1905) and its fully-acked done transition (1911–1929)
  now clear token/lease too. Before this fix a cancelled zombie row kept a
  live token and `releaseClaim` could requeue revoked-generation work.

### 2.2 Whole-range revocation reads as `revoked-source`, not `missing`
`verifyChunkAvailability` (1680–1710): in whole-range (segTo<0) mode, a range
whose rows ALL exist but are revoked was reported `missing-source-row`; the
worker relays that verbatim as the typed verdict reason **"missing"**, so a
consent-revoked range surfaced to operators as a data-integrity "missing"
failure. The zero-availability branch now checks whether in-range rows exist
without the `revoked = 0` filter and reports `revoked-source` ("range … is
revoked") only in that case; genuinely absent rows still report
`missing-source-row`. Loseless for both worker paths (each maps to the typed
`source-unavailable` terminal no-ack verdict; publication behavior unchanged).
No existing suite pinned the old reason code (checked).

### 2.3 Behavior verified unchanged (guarded against regressions)
`releaseClaim` of a CLAIMED row still requeues (delegated-header fork-control
path, workflow cap release) and the retryable backoff path still
schedules/re-claims with the attempt budget carried across retries.

## 3. NEW targeted suite `scripts/test-v02-journal-worker-review.mjs` (sha256 4917e5a7…c3a8) — 12/12 PASS

Real `MemoryStore` SQLite files in unique tmpdirs, injected deterministic
clock, genuine close/reopen restarts (new store+journal objects on the SAME
file). Gates:

1. **J3 commit seal** — mid-job claim keeps its live token and blocks
   double-claim; the FINAL ack clears token/lease same-tx; `releaseClaim` over
   done is a no-op; `claimWork` cannot re-claim the done jobId; status stays
   `{done:1}`.
2. **J3 release guard** — a legacy-shape done row with a forged live token
   cannot be released or re-claimed.
3. **J3 recovery seal** — recoverStartup's terminal-cancel zombie clears the
   token; release + 3 repeated claim attempts (60 s apart) cannot resurrect;
   `revokeSessions` source revocation makes the lineage non-replanable.
4. **Real restart** — acked prefix survives genuine close/reopen; resume
   claims only the remaining chunk; durable candidate_key ledger; a REPLAYED
   commit maps to the same candidate_key row; exactly one memory per
   candidate across the restart.
5. **Lease-expired mid-job on long input** (5 events, 3 chunks, worker-style
   up-front lease `max(60s, 32×(timeout+5s))`): a commit past the lease throws
   typed `lease-expired`; the late candidate publishes NOTHING; the acked
   prefix stays intact (`consumed [0..1]`); resume reaches only unacked
   chunks; the SAME re-committed candidate dedupes to ONE memory row —
   **long-input lease cost is at-least-once and the suite asserts it is not
   silently pretending exactly-once** (J1 honesty gate).
6. **Stale claim object** after recovery cannot read (unavailable,
   `range-not-stored`) or commit (`claim-invalid`); zero consumed coordinates.
7. **Policy race publishes NOTHING** — consumed commit after
   `bumpPolicyGeneration` throws `stale-policy-generation` with zero memory /
   `journal_derived` rows, job requeued (not cancelled); only a re-claim that
   refreshes the snapshot to the new generation publishes (verified end-to-end).
8. **True cancel is terminal** — `revokeSessions` (generation bump + source
   revocation + same-tx derivative quarantine): a late claimed commit throws
   `stale-cancellation-generation` and terminally cancels the row; the
   terminal cancel survives a genuine restart + recovery; nothing ever
   re-claims; done-before-revoke rows settle with their derivatives
   quarantined.
9. **CONTRACT NOTE (asserted)** — a cancellation bump WITHOUT source
   revocation kills the claimed row terminally, but the unrevoked pending
   sources are legitimately RE-PLANNED by `recoverStartup` as FRESH jobs under
   the new generation (job re-creation, never the cancelled row resurrected).
   Consent-revocation trips must use `revokeSessions` (one call does both).
10. **Missing source drill** — in-tx availability gate refuses a consumed
    commit with typed `chunk-state-invalid` (requeue, zero rows, no ack);
    read reports `missing-source-row`; the typed terminal relay fails the job.
11. **Revoked session while claimed** — read reports `revoked-source` (post
    §2.2 fix), no re-claim, no acks, and the cancel-gen drift terminally
    cancels any late verdict.
12. **Legitimate release paths still work** — delegated-header release
    requeues; retryable backoff schedules and re-claims with the attempt
    budget carried.

## 4. Runtime e2e independently re-run — the extract report's "199/8" claim is STALE; do not waive as-is

Current truth (`node scripts/test-v02-runtime.mjs`, build = this round's
re-emitted lib, suite-start/end pin stable):

- **STRICT 209 PASS / 1 FAIL; 3 XFAIL (gated) / 1 XPASS (surprise); the SUITE
  reports FAILED by its own XPASS-promotion rule.** The file was re-pinned by
  other lanes after the extract report was written (≈+10 gates, 1 XFAIL
  promoted to pass), so "199 PASS / 8 FAIL" from
  [MIGRATION-PHASE-B-EXTRACT.md](<MIGRATION-PHASE-B-EXTRACT.md>) §3/§J5 is not
  the current failure set and must NOT be waived as "pre-existing 8".
- **The 1 strict FAIL — `case4/re-enable acknowledges every accepted range
  from before the disable window` (scripts/test-v02-runtime.mjs:1592–1619) —
  is PRE-EXISTING, not caused by this round.** Kept diagnosis trees from two
  earlier runs of other lanes (fixtures/v02-runtime/temp/case4-1791431883862-eef11c
  and case4-1791432166107-b61d0e) show the identical durable pattern before
  this round's lib existed: sources `8:1 25:1 37:1 51:0`, jobs
  `[8-8]done [25-25]done [37-37]done [51-51]queued`-unacked. My run's tree
  (temp/case4-1791433102776-086fad) shows the same pattern.
- **Journal-side integrity of that artifact is CLEAN** (direct SQLite audit):
  every consumed flag matches an acked chunk exactly (3/4), there is no
  ack-without-consumed and no done-with-pending-chunk, and no settled row
  carries a live claim token (post-J3 shape). The failure is a sequencing
  expectation: run D's re-enable made **one** aux call and never re-claimed
  the remaining queued job `04f64778` inside the observed window, while the
  gate wants the whole accepted set drained. The journal API cannot alone
  produce a one-job-only round (`claimWork` has no per-round self-limit; the
  outer pump loop claims until null unless a seam error stops it —
  extract-journal-v02.ts:419–466, 482–624; flush callback src/index.ts:717–738).
  **Owner for scope:** runtime-fixture / extract-lane seam wiring — NOT this
  journal lane, NOT fixable by editing the fixture assertion alone.
- **The XPASS** — `case2/RESUME-DEDUP resume did not re-capture run-A evidence
  … (journal lineage)` — is a previously tracked defect gate that now PASSES
  (evidently fixed by the capture-lane re-pin). It needs reclassification by
  the runtime-fixture owner; until then the suite keeps self-reporting FAILED.

## 5. Findings reported back (locations, no edits made by this lane)

- **F1 — the journal's true-cancel machinery is UNWIRED at runtime.** The
  consent/forget surfaces never reach the journal: `bumpCancellationGeneration`
  and `revokeSessions` have ZERO call sites in `src/index.ts` (grep-verified);
  `/memory forget` (`src/commands.ts:80–89`) and the business forget lane
  (`src/business.ts:337–343`) call only `store.forgetMemory`/`forgetMemory`.
  The seam exposes them (`src/capture.ts:68,88–89`) but no production path
  invokes them, so a consent trip does not cancel pending journal work and a
  torn-down source lineage is not revoked in the journal. The 26-check suite
  probes both APIs directly (they work), but nothing in production calls
  them. **Owner:** index/business wiring lane.
- **F2 — terminal-`failed` is only restart-scoped.** "Terminal failure"
  protects one process lifetime only: `recoverStartup` step 3
  (memory-journal-v02.ts:1949–1967) replans coverage for every unconsumed,
  unrevoked source, and `planCoverageForSession` (1087–1094) excludes only
  ACTIVE (`queued`/`claimed`) coverage — so a FAILED job's ranges re-enqueue
  with a fresh attempt budget on the next boot. Bounded per process,
  unbounded across restarts, and it re-runs real LLM cost for a range whose
  failure is deterministic. For `cancelled` rows this re-creation under a new
  generation is correct policy-change semantics (asserted in the new suite's
  CONTRACT NOTE); for `failed` rows it is an owner decision (track failed
  coverage, or cap replan churn). Owners: journal lane + settings lane.
- **F3 — `source-unavailable` reason `"corrupt"` is typed but unreachable.**
  The journal never issues it (`readChunkEvidence` can only report
  missing/revoked/range-not-stored; schema STRICT types cannot become corrupt
  in-process), and SQLite-level corruption surfaces as a raw sqlite error,
  which the worker correctly maps to "recovery owns the durable state, no
  worker-side retry" with no ack (extract-journal-v02.ts:652–664). The value
  is dead vocabulary — keep or cut at the compat boundary; no behavior impact.
- **F4 — J1 stands** (no renew-lease / peek API; lease ceiling 32×(perCall+5s)
  sized up-front in extract-journal-v02.ts:401–406). Verified in this round's
  suite that the at-least-once consequences are honest (late candidate
  rejected; idempotent resume). Recommend the journal owner add
  `renewLease(claim, leaseMs)` (state-guarded, same-tx) so the worker lane can
  size leases honestly instead of ceiling-guessing.
- **F5 — runtime fixture asset truth** per §4: the "199/8" story is stale;
  today's gate is 209/1 + 1 XPASS with the ONE strict fail pre-existing since
  at least two earlier runs (kept-tree evidence). Coordinator must re-pin this
  in place of the extract report's §3 tail before promoting any runtime gate.
- **F6 — dequeue-order note.** `claimWork` orders by `created_at, id`
  (1260–1264), where a released/failed job and an appended burst interleave
  by enqueue time, not by retry pressure. Harmless for correctness
  (retry_after_at is honored as a WHERE filter) but worth a note for the
  settings lane: heavy appends can delay a backoff-eligible retry by one
  batch of younger jobs. Owner decision only.

## 6. Test results ledger (all this round, real libs after two strict
typecheck-gated emits)

| Suite | Result |
| --- | --- |
| `scripts/test-v02-journal-worker-review.mjs` (NEW) | 12/12 PASS |
| `scripts/test-v02-journal.mjs` | 26/26 PASS (unchanged) |
| `scripts/test-v02-extract-journal.mjs` | 20/20 ALL PASS (unchanged) |
| `scripts/test-v02-capture-journal.mjs` | 28 PASS / 0 FAIL |
| `scripts/test-v02-recall-races.mjs` | 23/0 (0 XFAIL, 0 XPASS) |
| `scripts/test-v02-revocation.mjs` | PASS |
| `scripts/test-v02-safety.mjs` | 60/60 PASS |
| `scripts/test-v02-minimization.mjs` | PASS |
| `scripts/typecheck-v02.mjs --emit-lib` | strict rc.2 gate PASSED (×2 emits) |
| `scripts/test-v02-runtime.mjs` | STRICT 209/1 + 3 XFAIL + 1 XPASS (suite self-reports FAILED on the XPASS rule; the 1 FAIL is pre-existing per §4) |

Runtime suite claims about "8 legacy-lane artifact failures" and the J5
classification are **not accepted as current fact**: the suite file no longer
exhibits that failure set (see §4/F5). Nothing was waived; the coordinator
owns the re-pin of §4 before any gate promotion.

## 7. Non-goals kept (explicit)

No edits to src/index.ts, extract.ts, extract-journal-v02.ts, import-v02.ts,
storage.ts, capture.ts, redact.ts, inject.ts, business.ts, commands.ts,
client.js, runtime fixtures, manifest; no new journal API (J1 stays open for
its owner); no new verdict values; no git commits; no config keys; no timers;
no live profile / 3082 / network / deps / skills. Baseline pinning and
"corrupt"-related productization remain Phase C decisions.
