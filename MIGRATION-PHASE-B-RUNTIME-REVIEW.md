# MIGRATION-PHASE-B-RUNTIME-REVIEW.md — runtime suite owner report (Phase B journal lane)

Status: **delivered by the runtime-fixture owner lane; independent runtime
migration round completed on the stable current checkpoint. NO src/manifest/Git
edits, no production store/profile usage, no port 3082, no external network, no
plugin-manager action, no dependency, exemption, or skill change.**

- Files changed by this delegation (only these): `scripts/test-v02-runtime.mjs`
  (assertion migration + case5 rewrite) and this review. The durable evidence
  log of the final run is written by the suite itself to
  `fixtures/v02-runtime/runtime-migration-phase-b.log` and the machine-readable
  gate ledger to `fixtures/v02-runtime/last-suite-pin.json`.

## 1. Result and build pin (honest ledger)

Final run (this round, stable in-suite pin):

```
STRICT 215 PASS / 0 FAIL ; 2 XFAIL (gated down) / 0 XPASS
--- per case: case1 36 PASS | case2 53 PASS | case3-row 24 PASS |
              case3-config 24 PASS | case4 72 PASS + 1 XFAIL | case5 6 PASS + 1 XFAIL
build pin: suite-start c2795cbcce7df1a8… / suite-end c2795cbcce7df1a8… (stable across suite)
```

Baseline comparison — the coordinator's independently reproduced run
([coordinator-phase-b-extractor.log](<fixtures/v02-runtime/coordinator-phase-b-extractor.log>))
was: **STRICT 199 PASS / 8 FAIL / 4 XFAIL / 0 XPASS at build 82f0f5e091a26e9e…**.

**Build-pin drift disclosure (no fake continuity):** between the coordinator's
run and this round, ONE lib file changed content:
`lib/memory-journal-v02.js` went `d525769d8ba99282…` → `8900960528c274de…`
(verified per-file sha256 against the coordinator's full 22-file hash map;
21/22 file hashes are byte-identical — 20 verified full-hash, 2 prefix-verified:
`evolve.js 8df2a1b768884d8a…`, `migration-v02.js cfbf39ddfe7e538e…`).
The pin composite moved 82f0f5e0… → c2795cbcce7df1a8… consistently with
exactly that one-file change. `src/memory-journal-v02.ts` is byte-equal to HEAD
(git: unmodified), and the strict peer set:

- `node scripts/typecheck-v02.mjs` (strict, whole tree INCLUDING
  `src/index.ts`/importer) **PASSED at this source checkpoint** (exit 0). No
  `--emit-lib` was run by this lane (no lib writes; lanes own emission).
- Identifier-level drift check between `src/memory-journal-v02.ts` and the
  built `lib/memory-journal-v02.js`: every significant identifier in the lib
  exists in the src (zero lib-only tokens; the src-side deltas are comment/prose
  vocabulary only). This is lineage coherence evidence, NOT a byte-exact
  emitted-claim — the exact 82f0f5e0… bytes cannot be re-materialized on disk
  anymore (the older working-tree emission is gone), so NO claim in this report
  attributes behavior to 82f0f5e0… itself beyond what the coordinator's log
  already established on it.

All runtime behavior in this round is therefore attributed to
**c2795cbcce7df1a8…**; the suite pin rule (per-case `CASE_BUILD_PIN` +
`last-suite-pin.json`) enforced it in-suite (stable start→end).

## 2. Precise mappings: old assertions → new invariants

Every migrated gate keeps or STRENGTHENS the checked property; nothing was
deleted outright. "Same-tx journal consumed coordinates" = `journal_sources.consumed`
recomputed from exact chunk coverage inside the commit transaction;
"support links" = `journal_derived(job_id, chunk_idx, memory_id, provenance)` +
`memories_meta.evidence` explicit `{sessionId, seq, snippet}` coordinates.

### 2.1 case1 (mount + capture/extract lane) — all PASS after migration

| Old gate (status at 82f0f5e0) | Old pinned artifact (removed lane) | New strict gate (status on c2795cbc) |
| --- | --- | --- |
| `successful extraction persists one row and acknowledges the observed range` — FAIL (memories=1, cursor=null) | `extract_state.processed_seq === pending_seq > 0` | `successful extraction persists one row and the journal consumed coordinates acknowledge it` — memories=1 AND every session `journal_sources` consumed=1 AND every extract job `state='done'` (detail: `sources=1 pending=0 jobs=done`) |
| `extraction drain persists the provider-validated insert with attributed metadata` — FAIL (cursor=null) | meta `provenance === "user"` + cursor | `with fail-close derived provenance + same-tx journal support link` — `memories_meta.provenance === 'derived'`, `source === 'llm-extract'`, `session_id` matches, ≥1 `journal_derived` row with `provenance='derived'` referencing that memory id |
| `ordinary capture persisted one direct-human slice` — FAIL (no JSONL slice) | `memory/conversations/<sid>.jsonl` row | `capture persisted the direct-human turn in the journal personal lane (eligible human only)` — exactly the direct-human turn as a `journal_sources` row (`kind='user'`, `injected=0`, `source_kind='user'`, text carries the token) |
| (old implicit JSONL hygiene) | JSONL slice shape checks | `only eligible direct-human rows persisted (no assistant/injected personal-lane text; minimized text self-consistent)` — EVERY row is `kind='user'`, `injected=0`, and `text_chars === text.length` (STRONGER: whole-lane eligibility, not one row's shape) |
| `extraction cursor consumes the observed range after the provider call` — FAIL (no row) | `extract_state` row | `journal consumed coordinates exact after the provider call (per-source, not a legacy cursor)` — pending sources 0 + jobs drained |

New guards added on the same surfaces (presence-based, never absence):

- `aux call wire shape = one identity-free user message (UserMessage guard)` —
  the aux request body carries exactly ONE user-role message (no session
  history continuation, no title-writer system slot).
- `plugin code really executed through the mounted native loader` — the
  plugin-emitted loaded banner is asserted (the banner can only be printed by
  plugin construction), in ADDITION to the durable artifacts above, so mount
  evidence is presence-based.
- `derived memory carries explicit evidence coordinates resolvable to the
  journal source row` — every `memories_meta.evidence` coordinate resolves to a
  real `(session_id, seq)` source row.

Kept intact (unaffected by the migration, all still PASS): first-request
precedence/recall absence, single-user-turn wire shape, aux system-prompt
marker + route (`deepseek-flash`), task-event user provenance, egress guard
full layer set, env-scrubbing allowlist, drain-without-stderr-error lifecycle.

### 2.2 case2 (recall + native resume + native fork)

| Old gate (status at 82f0f5e0) | Old pinned artifact | New gate (status) |
| --- | --- | --- |
| `fork child captured its own assistant output` — FAIL (no JSONL slices) | child session assistant JSONL slice | **Replaced by the reviewed lane's actual policy, two strict gates:** `delegated fork child persisted NO personal-lane journal evidence` (child task-A / FORK-OUT-MANTIS text absent) and `delegated fork child persisted ZERO journal sources by design (isDelegatedHeader gate)`. Positive-proof anchor kept: the child's provider request was observed (`child-observed.json` + wire gates), so exclusion is measured against an executed path, not absence. This is a privacy STRENGTHENING (the child's own assistant text must NOT land in the personal lane; it never did in the reviewed producer policy). |
| XF `resume should not recapture already-captured run-A events` — XFAIL at 82f0f5e0 | JSONL duplicate slice rows | **XPASS-proven on this stable build → PROMOTED STRICT:** `resume did not re-capture run-A evidence and both direct-human turns persist exactly once (journal lineage)` — human rows = distinct seqs = 2, both task texts present exactly once (the journal's immutable `(session_id, seq, event_hash)` lineage dedup makes re-flush idempotent; promotion proof in §4). |
| XF `recall snapshots should not duplicate in the slice store on resume` — XFAIL at 82f0f5e0 | injected JSONL recall rows counted | **XPASS-proven → PROMOTED STRICT (form corrected):** `plugin-injected recall snapshots never persisted into the journal personal lane` — zero `injected=1` rows and zero recall-text rows ANYWHERE in the durable lane. Occurrence equality across all provider requests was deliberately NOT kept as an equality (the recall block legitimately persists in restored NATIVE history and may appear in later requests); the provider-presence half is carried by the presence anchors ("recall block inside the first request", "recalled seed verbatim", "recall injected on the resumed turn too"). |

All 50 previously-passing case2 gates kept and still PASS (wire recall shape,
snapshot attribution, access_count, resume ordering, dedup of the turn's
message, fork child wire inheritance).

### 2.3 case3-row / case3-config (disabled mounts) — all PASS, 1 migrated gate each

| Old gate (PASS at 82f0f5e0 but stale) | Old artifact | New gate |
| --- | --- | --- |
| `no capture slice files at all` / `capture disabled: no slice files written` | `memory/conversations` dir emptiness | `no journal sinks or sources exist at all for the not-mounted plugin (plugin owns capture; no other writer may create them)` — `journal_sessions/sources/jobs` counts are 0 (STRONGER: covers the plugin-owned durable lane, not a directory). |
| `no pending extraction state marked while disabled` (stale `extract_state` read) | cursor table | `no pending extraction work marked while disabled (journal sources empty or all zero-ack)` — zero `journal_sources` rows while disabled. |

### 2.4 case4 (accepted-job quiescence across process-boundary unmount)

| Old gate (status at 82f0f5e0) | Old artifact | New gate (status) |
| --- | --- | --- |
| `run A accepted a pending extraction job` — FAIL (cursor=null) | `extract_state.pending>0, processed=0` | `run A accepted a pending extraction job (capture enqueued an unconsumed range + the journal holds the queued job)` — ≥1 unconsumed source AND ≥1 `queued` extract job (`sources=1 pending=1 jobs=queued`) |
| `run A captured at least one slice` — FAIL (no JSONL file) | slice file | `run A captured the accepted range in the journal personal lane (the accepted work exists durably)` — ≥1 journal source row |
| run-B/C `job state untouched (cursor serialization)` / `slice files untouched` | cursor JSON + JSONL hash | `accepted extraction job journal artifacts byte-identical (job row, sources, chunks untouched)` + `journal personal-lane rows untouched (privacy intact)` — full session-scoped snapshot (`sections+sources+jobs+chunks`) byte-identical across both disabled runs (STRONGER than a cursor: covers job rows, attempt state, chunk rows, source rows) |
| `re-enable acknowledges the original accepted range before the disable window` — FAIL (processed_seq undefined) | `extract_state.processed ≥ pending` | `re-enable acknowledges every accepted range from before the disable window (same-tx journal job + consumed coordinates)` — every job accepted pre-disable `state='done'`, 100% of its chunks `acked=1`, 100% of its accepted-range sources `consumed=1` (`accepted jobs before=done chunks acked=1/1 accepted-range sources consumed=1/1`) — while `aux call observed on re-enable` proves the drain actually ran. |
| XF `subsequent ranges accepted during the resumed run remain pending under the in-process pump throttle` — XFAIL at 82f0f5e0 | legacy cursor | **Remained honestly failing in journal form:** `case4/THROTTLE-EXCLUSION ... (journal form of the MIN_PUMP_INTERVAL_MS defect)` — after run D: 1 accepted range still `queued` + its source unconsumed while the pre-disable jobs are `done` (`sources=4 pending=1 jobs=done|done|done|queued open=1`). XPASS will force reclassification when the owner fixes it. |

Note on the migrated strictness: the old case4 acknowledgment gate shared ONE
session-wide cursor with the throttle defect, so it was UNDISTINGUISHABLY
failed by the pre-disable range OR the new ranges. The journal form decouples
them: pre-disable ranges (strict) vs during-run ranges (xfail) — the
continuity-is-broken-defect dimension is now measured exactly where it lives.

### 2.5 case5 — REWRITTEN to the genuine worker (legacy path retired)

The old case5 constructed `new extractMod.Extractor(store, …)` (legacy
`src/extract.ts` class) and called `markPending`/`appendConversationSlice` on
lane artifacts the runtime no longer writes. Any pass there proved NOTHING
about the runtime: the runtime now drives `journalExtract.pump()` at all four
drive points (MIGRATION-PHASE-B-EXTRACT.md §1.2). New case5 constructs the REAL
runtime objects from the built lib and probes them:

1. `case5/real capture gate: assistant, injected, and delegated turns are
   ineligible` — exercises the REAL `toJournalSourceEvent` gate (the runtime
   e2e cannot observe per-event eligibility): assistant and injected
   `user/message` sources and delegated contexts are all ineligible nulls.
2. `case5/probe first pump of a fresh process claims the accepted queued job
   and reaches the extractor` — genuine `MemoryStore` → `MemoryJournalV02` →
   `createJournalExtractSeam` → `createJournalExtractWorker` chain (real
   SQLite; only the LLM call is a controlled fake, the same honesty boundary as
   the extract-lane suite): fresh process → claim=1, one call, errors=0.
3. `case5/probe first pump committed its chunk in the same transaction (job
   done + source consumed + derived support link)` — mirrors old
   "cursor advanced" with the actual same-tx artifacts: memory row committed,
   source consumed, job `done`, `journal_derived` link present.
4. `case5/probe derived row carries fail-close provenance + the explicit
   coordinate` — `provenance='derived'`, `source='llm-extract'`, evidence
   coordinate `(sessionId, seq=0)` with a snippet that matches the retained
   source text under the lane's own evidence normalizer.
5. `case5/THROTTLE-EXCLUSION ... 30 s in-process gate` — **remained honestly
   failing:** second pump returns `claimed=0` with no LLM call while the second
   range is durably queued+unconsumed (`XFAIL`, direct evidence, not absence).
6. `case5/control after the throttle window the accepted pending range IS
   drained by the same worker pump` — injected per-worker clock (`nowMs`), no
   sleeps: after the 31 s window the SAME worker drains the SAME accepted range
   (job `done`, pending 0). This is the control the legacy scenario used to
   satisfy without executing production code: the throttle drop is bounded and
   loses NOTHING — the defect is the in-process window, not data loss.
7. `case5/probe the marked second range is durable accepted work while the
   throttle holds it` — the drop is directly observable journal state (queued
   job + unconsumed source at calls=1). (If the worker is fixed, this gate's
   formulation flips to "second pump drained immediately" via the same
   condition so an XPASS on the defect gate stays diagnosable.)

## 3. The mandate's guard surfaces (genuine means, never absence)

| Guard surface | Where it is proved | Means |
| --- | --- | --- |
| NativeLoader | case1 `plugin code really executed through the mounted native loader` + composition-dump row/`disabled` dialect checks (case1/case3-row); auxiliary: plugin-produced durable artifacts (journal rows) exist | POSITIVE presence: the banner is emitted by the constructed plugin itself; the dump proves the composed row the loader resolves |
| UserMessage | case1 `aux call wire shape = one identity-free user message` | POSITIVE wire shape at the recorded stub: exactly one user-role message, no title slot, captured slice inline |
| first provider | case1 `main model request seen at the stub` + `first request is one direct user turn` + `first request precedes any recall`; case2 recall-block position gates | POSITIVE earliest-request ordering against the recorded request log |
| flush | case1 `extraction aux call happened on flush drain`; case4 run-D `continuity ... drained by the first enabled flush` | drain measured at the flush barrier against durable artifacts |
| shutdown | case1 `unmount drain completes without plugin extraction errors on stderr` + exit-code-0 with journal commit evidence; case4 ingress-closed/ingress-closed-equivalent (disabled mounts); suite-level `flushDrain` barrier return | process exit is only corroborating; the drain outcome is the store state |
| restart | case2 native `--session-id` resume; case4 process-boundary unmount/re-enable lifecycle (runs B/C/D over one home); case1/4 startup-recovery-adjacent journal continuity (accepted job survives processes) | POSITIVE cross-process adoption + unchanged/draining accepted jobs |
| no external network | every run: egress guard boot/selftest/armed checks, zero non-loopback attempts, all loopback connects → run's stub port | the guard fails closed; negative evidence is guarded, positive routing is pinned to the loopback stub |

---

## 4. The 4 tracked XFAILs — verdicts on the current stable checkpoint

| Tracked defect | Verdict on c2795cbc | Gate now |
| --- | --- | --- |
| resume recapture dedup (case2 XF) | **TRULY FIXED at the durable layer** — journal lineage dedup; XPASS proven, then promoted strict and re-proven on a strict re-run (case2: 53/53 PASS) | strict |
| injected recall snapshot exclusion (case2 XF) | **FIXED-at-the-durable-layer, promoted strict** after XPASS proof (zero injected/recall rows; provider presence proven by anchors) | strict |
| second pending ranges throttle (case4 XF) | **NOT FIXED** — honest XFAIL with direct journal evidence (1 queued job + 1 unconsumed source after the resumed run; 3 pre-disable jobs done) | xfail |
| second flush throttle (case5 XF) | **NOT FIXED** — honest XFAIL against the genuine worker (`claimed=0`, zero extra LLM call, range stays queued+unconsumed), plus the bounded-loss control PASS | xfail |

The two promoted gates were promoted ONLY after an actual XPASS proof against
the running stable build (never by reinterpreting the source); the two
remaining ones are attached to a concrete source-owner finding below — no
blanket waiving.

## 5. Finding reported to the source owner (NOT a scope edit)

**Throttle defect persists on the current stable checkpoint — owner location:**
`src/extract-journal-v02.ts` `MIN_PUMP_INTERVAL_MS = 30_000` (lines 387–388) and
the pump drop `if (now - lastPumpAt < MIN_PUMP_INTERVAL_MS) return result;`
(line 424 inside `createJournalExtractWorker.pump`). Observable end-to-end in
`fixtures/v02-runtime/runtime-migration-phase-b.log`:

- fast-path runs (case4 run D) leave ranges accepted during the SAME process
  queued/unconsumed (`sources=4 pending=1 jobs=done|done|done|queued open=1`);
- the genuine worker drops a second in-window pump (`claimed=0`, no call) while
  the after-window control drains the identical accepted range
  (`case5/control ... bounded and loses nothing`).

Suggested owner directions (not implemented here, outside this delegation):
pause-aware pump (only skip RE-claim when the previous round actually ran a
claim), or a journal-level `claimWork(unboundedSecondFlush)` marker near the
session's turn-end flush. Recommend the owner also record the `released`
counter semantics when the drop happens (currently the drop is silent
`claimed=0` with no warn — the suite catches it only from journal state).

Also kept on the record (pre-existing, unchanged by this round): the
`extract_state` schema table still exists in `src/storage.ts` for compat and is
written by NOTHING in the runtime (mirrored by the migrated gates now reading
only the journal lane); and the legacy `Extractor` class remains in
`src/extract.ts` untouched (documented partial retirement). No new defects
beyond the tracked throttle were disproven or discovered: every other
observable matched the reviewed lanes' semantics.

## 6. Counts, limitations, honesty boundaries

1. **Suite counts.** Old strict = 199 PASS / 8 FAIL (207 strict checks) → new
   215 PASS / 0 FAIL. Reconciliation per case: case1 33→36 (+3: whole-lane
   eligibility gate, UserMessage wire guard, NativeLoader presence guard),
   case2 51→53 (+2: two fork-child whole-session gates replacing the single
   assistant-slice gate; the two promoted gates re-type from xfail to strict
   with no count change for xfail records), case3-row 24→24, case3-config
   24→24 (both migrated 1:1), case4 72→72 (all four migrated 1:1, the mixed
   cursor/throttle gate split into strict+xfail), case5 3→6 (+3: real capture
   gate, same-tx commit probe, support-link probe; plus the after-window
   control replacing nothing — it is a new honest positive control).
   XFAIL records 4 → 2 (both throttle tracks). No XPASS.
2. **The coordinator's exact build is not re-runnable.** One lib file changed
   content after the coordinator's reproduction (§1); ceiling attribution is
   therefore `c2795cbc…`, with per-file proof of exactly WHICH lib file differs
   vs the coordinator's pin. The suite's own in-suite pin (start==end,
   per-case) enforced stability across every run of this round (exact run
   ledger this round: case1 ×3, case2 ×4, case3-row ×2, case3-config ×2,
   case4 ×3, case5 ×4 — including 2 full-suite passes; every run's reported
   composite is `c2795cbcce7df1a8…`, zero in-suite drift).
3. **Full strict compile claim (bounded and explicit):** `node
   scripts/typecheck-v02.mjs` PASSED on the whole current tree at this source
   checkpoint (including the importer). No `--emit-lib` was run by this lane,
   no lib writes, no src/manifest edit; the only lib-touching operations in
   this round were reads and hashes. The remaining caveat (src↔lib identity of
   the pre-existing emission) is bounded by the identifier-level drift check in
   §1, not by a re-emission claim.
4. **The aux extractor's provider is a controlled fake in case5 only**
   (outcome-programmable per the extract-lane suite's same boundary); case1 and
   case4 aux calls hit the REAL mounted runtime against the loopback stub — the
   `{"memories":[]}` nothing-to-learn ack path in case4 run D is exercised for
   real; the `"memories":[{…}]` consumed path is exercised for real in case1
   (actual memory + journal support link + evidence).
5. **Crash atomicity is still NOT proven by this suite** (same honesty boundary
   as the old case1 wording): the consumed/committed invariants are proven for
   the normal-run lifecycle only. The genuine crash/replay gates live in the
   journal suites (reported passing by their owning lanes' docs, see
   MIGRATION-PHASE-B-EXTRACT.md §3 and MIGRATION-PHASE-B-CAPTURE.md §4; NOT
   re-run by this lane).
6. **Native exit-0 is NOT treated as drain evidence** (phase-A lesson kept):
   the drain outcome is asserted from durable stores (case1 journal artifacts,
   case4 queued→done transitions), stderr extraction errors are separately
   asserted to be zero, and the case4 quiescence gates compare byte-level
   journal snapshots rather than process behavior.
7. **Egress guard limitation unchanged from the Phase A review**: it is a
   Node-API-layer fail-closed guard (not an OS network namespace). All 9 runtime-child runs
   per suite show guard.ready + armed self-tests + zero non-loopback attempts
   and all outbound loopback connects pinned to the run's stub port.
8. **No fabricated XPASS**: the two remaining XFAILs are honest and
   re-checked on the pinned build; the two promoted gates went through an
   XPASS→strict promotion, not a waiver.
