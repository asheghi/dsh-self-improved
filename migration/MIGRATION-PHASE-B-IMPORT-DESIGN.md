# MIGRATION-PHASE-B-IMPORT-DESIGN.md — read-only design for the lossless Phase B import (backup artifact + OWNER-marked normalized target)

Status: **design + one report only. NO source file, manifest, Git state, profile,
fixture, test or report-file other than this one was created or modified. No
implementation exists and none is claimed.** Workflow27 is ACTIVE on
`src/extract-journal-v02.ts` + index drivers; Workflow23 owns capture/index;
nothing here touches them. This file scopes ONE future increment: the Phase B
import writer (MIGRATION-V0.2.md § "Actual migration of existing data" steps 2
and 4, plus the Phase B lossless dry-run/import/export gate). Phase A's
`buildMigrationReport` (inventory/dry-run projection) is **not** an importer and
remains untouched.

## 1. Verified basis (all anchors read this session)

- [src/migration-v02.ts](<../src/migration-v02.ts>): report shapes :53–270, path
  safety :338–409, snapshot lifecycle :483–561, privacy bounding
  (`reportKey`/`opaqueIdent`, contract vocabularies) :618–639, lane
  classification :786–801, remaining gates :803–809, settings map :851–910,
  orchestrator with pre/post digests + `recheckSourceSchema` :1544–1698.
- [scripts/migrate-v02.mjs](<../scripts/migrate-v02.mjs>): CLI main :244–317,
  report-destination validation :103–143, exclusive-`wx` + fsync report write
  :152–181, guarded compile tree :184–223.
- [MIGRATION-PHASE-B-STORAGE.md](<MIGRATION-PHASE-B-STORAGE.md>) §4.1–4.4
  (journal API contract) — consumed-range/ack semantics the importer must NOT
  bypass or imitate.
- [src/storage.ts](<../src/storage.ts>): `insertMemory` :568–575,
  `insertMemoryInTx` (tx-only seam) :584–589, schema markers v1/v2 + `markMigration`
  :403–501, `runInImmediateTransaction` :1269, `getMemoryRevision` :1301–1321,
  `bumpMemoryRevisionForExternalWriter` :1323, `getJournalSqlite` :1331.
- [MIGRATION-PHASE-B-OVERSIZE.md](<MIGRATION-PHASE-B-OVERSIZE.md>): journal
  26/26; typed `source-too-large` atomic rejection; legacy pre-fix truncation
  unverifiable from stored rows; >200k needs canonical reread.
- [MIGRATION-IMPORT-REVIEW.md](<MIGRATION-IMPORT-REVIEW.md>) /
  [MIGRATION-IMPORT-PRIVACY.md](<MIGRATION-IMPORT-PRIVACY.md>) /
  [MIGRATION-IMPORT-TESTS.md](<MIGRATION-IMPORT-TESTS.md>): 44-assertion safety
  contract, bounded-field inventory, backup contract wording.

## 2. What exists / does not exist today (no projection)

- Importer: **absent.** Phase A produces counts/ids/digests only; nothing has
  ever written a target store; `safety.destinationTouched: false` is asserted
  by the suite. Gate text says so verbatim (migration-v02.ts:803–809).
- Snapshot machinery (read-only open, `VACUUM INTO` WAL-inclusive, owner-marked
  temp tree, `-shm` digest exclusion, pre/post tree digests, second
  source-side schema recheck) exists and is reused as-is — no new reader paths.
- Journal oversize fence exists (26/26); it changes the honesty baseline for
  any older data: **truncated legacy rows cannot be proven complete post-hoc**,
  so anything involving raw conversation history must not be silently re-acked.

## 3. Artifact set and target construction (one isolation destination, two guarantees)

One operator-named `--dest` isolation directory, validated by the existing
`validateSourceDestination` (refuses equal/nested/symlink-bound roles) plus the
deep-walk `refuseSymlinkedContent` on every role. No artifact may sit inside
any input (extend `validateReportDestination` to plan/ledger/receipt paths).
Inside it, three OWNER-marked artifacts — never a live store, never mounted,
never cutover-connected:

1. **`backup/` — lossless private backup (restore-grade).** A
   `VACUUM INTO` of the read-only source connection (existing `takeSnapshot`)
   copied into dest with sha256 digests, plus companion files (persona/ dir,
   conversations/ dir, skills root, settings file, vectors.db) and a checksummed
   manifest (`MANIFEST.sha256`, exclusive-created, `fsync`ed). Byte-faithful
   including quarantined and secret-bearing content. Same guarantee class as
   MIGRATION-IMPORT-TESTS.md "Backup contract": restore fidelity.
2. **`normalized/` — operational OWNER-marked synthetic target).** A freshly
   constructed `MemoryStore` on this tree's own v0.2-compatible storage code
   (same schema, same v1/v2 marker writer — the plan keeps the existing SQLite
   memory data, so no schema conversion). Root marker `OWNER.dsh-self-improved-import`
   containing the plan digest; absence/mismatch ⇒ refusal before any open.
   Receives only `accepted-verbatim` rows (§4) through the storage contract.
3. **`ledger.json` + `receipt.json` + `plan.json`** — exclusive-created, wx+fsync,
   bounded to the report-privacy contract (ids, scopes, timestamps, contract
   vocabulary, opaque digests; **never** raw content/skill bodies/persona prose/
   secrets — same bounded-field inventory as MIGRATION-IMPORT-PRIVACY.md).

"Copied" applies only to artifact 1; "synthetic" to artifact 2. Both carry the
owner marker and a refusal rule: a target whose marker is missing, pre-seeded
with non-import rows, or whose `store_state` already holds another plan digest
is refused (collision), never overwritten.

## 4. Verdict classes — exact-count identity, no silent losses

Every source unit of every artifact family lands in **exactly one** verdict;
per family: `accepted-verbatim + retained-quarantined + unsupported-evidenced
== exact total`. The importer refuses to finish (exit 3) if any family does not
reconcile; there is no "skipped silently" path anywhere.

| family | accepted-verbatim (into `normalized/`) | retained-quarantined (backup ledger lineage only) | unsupported-evidenced (counted, never acked) |
|---|---|---|---|
| memories + memories_meta + memories_seq | every row, id/timestamps/status/supersedes/meta/scope/evidence verbatim via the store contract; non-active statuses preserved; credential-shaped content rows demoted `status='quarantined'` + ledger reason (row still present, fail-closed) | credential-shaped content in the backup is byte-verbatim | rows missing meta or evidence JSON not parseable by v0.2's contract |
| baseline pins | `pinBaseline` with preserved memory ids (all pin targets are preserved ids; dangling pin id ⇒ unsupported) | — | — |
| episodes / episode_steps / episode_events | verbatim (already minimized at legacy persistence); learning stays Phase-D gated | verdicts referencing lost steps ledger-flagged | evidence refs to missing episodes (already `evidenceUnverifiable` semantics) |
| persona_versions + persona/ files | — | **all of it** (inactive by lane contract; recorded `migrationActivation:"inactive"`) | — |
| generated `dsi-*` skills | — | **all**; never installed, never activated | — |
| conversations/*.jsonl | — | valid lines (extraction backlog material; NOT enqueued to the v0.2 journal — see §11 deps) | malformed lines, duplicate seq lines, seq-0 anomalies — exact counts, never "absorbed" |
| extract_state cursors | — | recorded for orientation | backlog is re-plannable only by a future explicit lane; not imported here |
| vectors.db embeddings | — | — | **all** — disposable, rebuildable index; no recall-fidelity loss, stated as rebuildable |
| schema_state unknown markers / unknown tables / extras | — | — | counted; digested identifiers only (existing `opaqueIdent` rule) |
| settings leaves | mapped non-secret `carry` values land ONLY in the report as proposal — no config write exists in this increment | secrets: presence-only | unmapped/retired leaves presence-only |

`unsupported-evidenced` is an accounting verdict, **not** an acknowledgment:
nothing is marked consumed, nothing is deleted, every item names its source
coordinates and a reason in the ledger receipt.

## 5. Stable identity, lineage, dedup ledger

- Memory ids, timestamps, scopes, statuses, supersedes and evidence are carried
  verbatim; the ledger records `legacySeq → targetSeq` per row (seq is rebuilt
  by the store in created_at order; the mapping is written, not inferred).
- Lineage triple per imported unit: `sourceDigest` (sha256 of source
  memory.db + tree digest), `planDigest`, `sourceRowRef` (id/coordinates).
  Target `store_state` gains a single import row (key `import-v0.2-phase-b`)
  in the SAME final transaction — never a free-floating config write.
- **No dedup at import.** The Phase A duplicate/conflict groups are carried
  verbatim as rows and ledgered as `duplicateGroup` membership (hash8 + ids).
  Merging is a policy decision reserved to later review; mechanics never merge.
- Journal-style `candidate_key` idempotence is out of scope: this lane imports
  rows, not extraction verdicts; re-running a plan against a receipt-present
  target is refused (§7), so duplicates cannot arise from double execution.

## 6. Transactional target writes; crash / resume / rollback

- L2 writes are chunked `runInImmediateTransaction` blocks (one connection, one
  writer) through the storage seam; a crash rolls back the open chunk only —
  no partial row, no FTS/meta/seq orphans (the store's atomic row-set property
  at storage.ts:614–616 applies).
- Backup tree is built in an owned temp dir, digested, then atomically renamed
  into dest — a crashed copy leaves an inert owner-marked temp dir only
  (reuse the `guardedRmSnapshot` pattern).
- Boundary inventory (each must be exercised adversarially before any green
  claim): after plan write / mid-chunk / after chunk before ledger tx / after
  last chunk before receipt / during receipt write. Because ledger rows commit
  in the SAME transaction as their data rows (mirroring the journal §4.2
  same-tx-ack rule), there is no boundary where data exists without its verdict.
- Resume: re-validate sourceDigest + planDigest against `plan.json` and the
  target's store_state record; skip reconciled families/counters recorded in
  the ledger; rewrite a missing receipt only after full re-verification.
  Rollback = delete the isolation directory (owner-marker-guarded rm of the
  importer's OWN artifacts only) — no production file exists at risk.

## 7. Collisions, sourceDigest, plan-bound CAS

- Path-role refusals reuse the hardened Phase A validators; plan/ledger/
  receipt paths extend the "never inside any input" containment set.
- **sourceDigest CAS:** the plan records source memory.db sha256 + tree
  digest; apply re-digests before the first write and re-verifies after the
  last (today's `sourceUnchanged`/`sourceSchemaUnchanged` contract). A live
  mutating legacy host ⇒ delta ⇒ refusal, nothing written.
- **plan-bound CAS:** target `store_state.import-v0.2-phase-b` holds
  {planDigest, reconciled watermark}; a chunk commit under a different plan
  digest is refused; a fresh plan requires a fresh destination (or an explicit
  operator-declared resume). No revision-free overwrite path exists.
- **Collisions:** any pre-existing unowned row/ledger entry in the target is a
  refusal (synthetic target ⇒ empty by construction; resume targets accept
  only rows whose lineage matches the plan). Existing-file rules everywhere
  mirror the exclusive-`wx` report discipline; the singleton report file for
  this design carries the same caveat as the Phase A residual (transplanted
  directory between validation and open).

## 8. Redaction/minimization vs losslessness — the stated tension

Two guarantees, deliberately not the same one:

- **Lossless (backup/):** byte-faithful; therefore it necessarily contains
  secrets, quarantined and unsupported raw material. It is restore-grade
  evidence, not an operational export: never rendered to a model, never browsed,
  never injected; restore is its only sanctioned use.
- **Operational (normalized/):** lossless for every accepted row's contract
  fields (ids/timestamps/scope/status/supersedes/evidence/meta verbatim);
  minimized in exactly one way — credential-shaped content/style metadata
  (SECRET_KEY_PATTERN-adjacent scan, same spirit as `safeCarryValue`) does not
  survive as active authority: the row demotes to `status='quarantined'`
  with a ledger reason, verbatim copy remaining only in the backup.
- A byte cannot be simultaneously lossless and secret-free when the secret IS
  the content; that resolution is the design, not a limitation to hide.
- **Encrypted/private ≠ operational export:** `backup/` (and any encrypted
  variant of it) proves restore fidelity and nothing else; assumptions like
  "backed up ⇒ importable/reviewable" are exactly the conflation this split
  forbids. The suite language already distinguishes the analysis snapshot from
  the cutover backup; this design adds the third, distinct operational artifact.

## 9. Canonical schema marker validation

- Pre-apply: `normalized/` must present schema_state v1+v2 written by this
  tree's own storage code, `schemaVersion()==2`, `PRAGMA user_version`
  consistent, zero pre-existing data rows (synthetic), authority = the
  `schema_state` rows, not `user_version` (storage.ts:404).
- Post-apply (part of the receipt, all measured not assumed): `quick_check` ok,
  FTS rebuilt if the store exposes a rebuild entry point, count reconciliation
  (§4 identity), `getMemoryRevision()` monotonic with
  `bumpMemoryRevisionForExternalWriter` used by no lane other than the
  importer's final commit, import row present.

## 10. Proof-required human approval; no silent paths

- Two-phase CLI: `plan` (reads source, writes nothing but plan.json) then
  `import --approve <token>` where the fresh token file must name
  sourceDigest + planDigest + target root; mismatch/absence ⇒ exit 2 with
  zero writes (fail before the first tx, not during).
- Persona prose, generated skills and operational-learning activation are
  inactive in every artifact and stay out of every activation decision here;
  consent is carried unchanged (`sameOrNarrower`/`reconfirmAtCutover` as Phase A
  already records). v0.2's one-time settings import outcome remains a cutover
  inspection, not an assumption.
- No live cutover, no production read beyond the operator-named read-only
  snapshot contract, no active-profile change, no manifest/profile write is in
  scope; steps 8–9 of the plan (cutover/rollback) remain separate gated work.

## 11. Precise APIs, file ownership, dependent requirements

**Future files owned by this increment** (no edits made yet):
- `src/migration-v02.ts` — additions only, alongside existing exports:
  `buildImportPlan(options: ImportOptions): ImportPlan` (read/source-only),
  `applyImportPlan(planDoc, importOptions, approval): ImportResult`
  (writes target + ledger only, inside validated roles),
  `ImportPlan/ImportResult/ImportLedger` types; reuses `takeSnapshot`,
  `digestDirectory`, `refuseSymlinkedContent`, `reportKey`/`opaqueIdent`,
  `validateSourceDestination` unchanged.
- `scripts/migrate-v02.mjs` — add `plan` / `import` subcommands reusing
  `validateReportDestination` (extended), guarded compile, wx+fsync outputs.
- `scripts/test-migration-v02.mjs` + `fixtures/v02-migration/` — suite/fixture
  extension ONLY when implemented; no test was run for this design.
- `MIGRATION-PHASE-B-IMPORT-IMPL.md` (future) — implementation acceptance
  report naming real runs; this file must never be cited as evidence.

**Blocked dependency (must be resolved with the storage owner first):**
preserved ids/timestamps cannot be minted through `insertMemory` (it derives
`randomUUID`+`Date.now`, storage.ts:602–613), so L2 needs one tx-only seam
added next to `insertMemoryInTx`:
`importMemoryInTx(input & { id, createdAt, updatedAt }, meta & { seqNote? })`
— identical row-set/FTS/seq/revision behavior, refuses to run outside
`runInImmediateTransaction`, no default provenance widening (omitted provenance
stays fail-closed `unknown`). Without that seam the design halts; the only
alternative (raw SQL against the target) is rejected because it bypasses
FTS/seq/revision invariants.

**Coordination constraints:** Workflow27/23 files (extract-journal-v02.ts,
capture.ts, index.ts, memory-journal-v02.ts) untouched; conversation backlog is
NOT enqueued into the v0.2 journal here (seq-zero + >200k canonical-reread + ·
pre-fix truncation honesty must be re-solved by their owners first; importing
raw slices would re-create exactly the silent-loss hazards those reports
document). Coordinator docs/MIGRATION-PROGRESS.md not edited by this lane.

## 12. Adversarial acceptance cases (to be PROVEN by future real runs, never asserted from this document)

1. SIGKILL at each §6 boundary → resume yields the exact count identity per
   family; zero duplicate evidence; zero partially imported rows (real SQLite,
   real kill, not simulated exceptions — the existing journal-suite standard).
2. Source byte-flip between plan and apply → refusal with sourceDigest delta,
   target untouched; source changed DURING apply → post digest mismatch ⇒
   refused completion, receipt denied.
3. Target tampering: marker removed, pre-existing row, foreign planDigest →
   collision refusals before first write.
4. Secret canaries across every lane (credential-shaped memory content, unknown
   schema_state marker, hidden settings leaf) → byte-verbatim in backup only;
   demoted/quarantined or presence-only in L2/report; exact counts; zero
   canary in ledger/receipt/report JSON.
5. Malformed/duplicate conversation lines, broken supersedes, unverifiable
   evidence, dangling pin ids → unsupported-evidenced with coordinates;
   never skipped, never normalized into trust.
6. quick_check not-ok snapshot, non-SQLite memory.db, missing-source → refusals
   (exit 2), no dest artifact created.
7. Approval token missing/stale/digest-mismatched → exit 2 with zero writes.
8. Restore check (backup/): restored copy's sha tree digest equals the source's
   — proving losslessness where it is claimed; `normalized/` is explicitly NOT
   digest-equal and makes no such claim.
9. Determinism: identical inputs ⇒ byte-identical plan+ledger (no wall-clock
   entropy; timestamps come only from preserved source data).

## 13. Not claimed here

No implementation, no test run, no suite extension, no staged/committed
change, no typecheck rerun claim, no Phase-C/D/E work, no cutover design
beyond refusing it, no live or production data access, no skill/persona
activation, no settings/consumer changes, no journal or extraction edits.

## 14. Bounded scope for the next agent

Implement exactly §3–§12: the two Artifact lanes, ledger/verdict identity, the
import seam request to the storage owner, CLI subcommands, boundary and
adversarial suites on synthetic fixtures, one implementation report. Do not
touch Workflow23/27 files, journal semantics, cutover, or production paths;
advance `unsupported-evidenced` accounting never into silent acks.
