# MIGRATION-PHASE-B-IMPORT.md — Phase B import lane: implementation, adversarial evidence, exact counts and honest limits

Status: **implemented and adversarially verified on synthetic fixtures only.**
This increment owns the Phase B import WRITER of
[MIGRATION-PHASE-B-IMPORT-DESIGN.md](<MIGRATION-PHASE-B-IMPORT-DESIGN.md>) §3–§12
(the two artifact lanes, verdict-count identity, crash/resume/rollback, plan- and
source-bound CAS) on top of the storage seam
[MIGRATION-PHASE-B-IMPORT-SEAM.md](<MIGRATION-PHASE-B-IMPORT-SEAM.md>) and the
existing Phase A readonly validator contracts. Zero production, live-profile or
real-user data was read; every run below used synthetic fixture stores.

## 1. Exact file ownership (new files only; no existing source file edited)

| file | contents |
|---|---|
| [src/import-v02.ts](<src/import-v02.ts>) | engine: `buildImportPlan(options)`, `applyImportPlan(planDoc, options)`, `computeSourceTreeDigest(root)`, `writeJsonExclusive`, plan/ledger/receipt types, bounded audits, backup builder, crash-point helper. Strict-compiles clean. |
| [scripts/import-v02.mjs](<scripts/import-v02.mjs>) | CLI: `plan` / `import` subcommands with doc-destination validation (never on any input), exclusive wx+fsync lane-doc writes, guarded strict type-gate + lib emit, exit-code mapping. |
| [fixtures/v02-import/build-import-fixture.mjs](<fixtures/v02-import/build-import-fixture.mjs>) | adversarial synthetic legacy store (WAL-mode memory.db, canaries, un-importable rows, fake inactive dsi-* skills, cursors, persona, vectors, settings). |
| [fixtures/v02-import/worker-apply.mjs](<fixtures/v02-import/worker-apply.mjs>) | cross-process SIGKILL crash worker for the resume oracles. |
| [scripts/test-v02-import-lane.mjs](<scripts/test-v02-import-lane.mjs>) | focused suite, 93 PASS / 0 FAIL (real SQLite, real CLI subprocesses, real SIGKILL). |
| [MIGRATION-PHASE-B-IMPORT.md](<MIGRATION-PHASE-B-IMPORT.md>) | this report. |

`lib/` was refreshed from source by the repo's own strict build
(`typecheck-v02.mjs --emit-lib`): `lib/import-v02.js` is new build output; the
refreshed `lib/storage.js`/`lib/migration-v02.js` are byte-equivalent rebuilds of
their sources that also re-prove `test-storage`, `test-recall`,
`test-migration-v02`, `test-v02-import-seam` and `test-v02-journal` below. No
manifest, Git state, storage/index/extractor/capture/journal/business/client
file, profile path or live skill root was touched. The Phase A CLI
[scripts/migrate-v02.mjs](<scripts/migrate-v02.mjs>) is untouched and remains
the compatible readonly inventory; this lane is an ADDITIONAL `plan`/`import`
CLI, not a replacement.

## 2. Usage and exit codes

```
node scripts/import-v02.mjs plan   --source <storeDir> --dest <FRESH isolationDir> [--settings <file>] [--skills-root <dir>] [--report <file>] [--json]
node scripts/import-v02.mjs import --dest <isolationDir> --approve <token> [--resume] [--report <file>] [--json]
```

- The `plan` stage reads the source strictly read-only (`node:sqlite`
  readOnly + one transactionally consistent WAL-inclusive `VACUUM INTO`
  snapshot) and writes ONLY the destination owner marker + `plan.json`
  (exclusive, max one run per root). It prints the approval token bound to
  `sha256(planDigest :: memory.db sha :: stable-tree digest :: destRoot)`.
- The `import` stage refuses with **exit 2 and zero writes** on a
  missing/stale/mismatched token, foreign plan digest, missing/foreign owner
  marker, pre-existing target rows, a foreign watermark, source drift, or a
  completed receipt. Mid-apply source drift refuses completion and denies the
  receipt. Reconciliation failures finish with **exit 3** (`unsupported`
  finish), everything else refused is exit 2; success is 0.
- Artifact layout inside the isolation dest: `OWNER.dsh-self-improved-import`,
  `plan.json`, `backup/` (restore-grade byte-faithful, mode 0700),
  `normalized/` (OWNER-marked synthetic v0.2 target, mode 0700),
  `ledger.json`, `receipt.json`.

## 3. Verified counts on the adversarial fixture (golden fixture, all real runs)

Source synthetic store: 145 memory rows (+meta+seq side rows), 3 baseline pins, 3
episodes / 4 steps / 2 events, 2 session_projects, 3 persona versions + 2 files,
2 generated `dsi-*` dirs (+1 non-generated), 2 conversation JSONL files with 1
duplicate-seq + 2 malformed lines, 3 legacy cursors (1 backlog, 1 ghost), 1
scene, 7 vector embeddings, 1 unknown schema_state marker (secret value), 1
unknown table, a settings patch (12 leaves incl. one api-key secret).

| family | total | accepted-verbatim | retained-quarantined | unsupported-evidenced |
|---|---|---|---|---|
| memories | 145 | 139 (3 with planned conservative demotions) | 0 | 6 |
| baseline pins | 3 | 1 | 0 | 2 (dangling target, ineligible provenance) |
| episodes (+steps+events) | 9 | 9 verbatim | 0 | 0 |
| session_projects | 2 | 2 | 0 | 0 |
| persona | 5 | 0 (inactive lane) | 5 in backup only | 0 |
| generated skills | 2 | 0 (never activated, never copied to any live root) | 2 in backup only | 0 |
| conversations | 23 | 0 (backlog NOT enqueued to the v0.2 journal) | 20 in backup only | 3 (1 dup + 2 malformed, exact counts) |
| cursors | 3 | 0 (nothing acked; orientation only) | 3 | 0 |
| scenes | 1 | 0 (derived aggregates; explicit non-import) | 1 in backup only | 0 |
| vectors | 7 | 0 (rebuildable disposable index) | 0 | 7, never acked |
| unknown schema objects | 2 | 0 | 0 | 2 (opaque digests only) |

Every family identity sums exactly (`accepted + retained + unsupported ==
total`) and the apply measured the same numbers back out of the target
(receipt `_reconciliation.allReconciled: true`); `quick_check` ok on the
target; revision advanced 0→139 exactly = one bump per imported row.

Unsupported rows (never imported, never acked, coordinates + bounded reason in
the ledger): `bad-missing-meta` → `missing-meta-side-row`; `bad-evidence-json` →
`evidence-not-parseable`; `bad-kind-probe` → `category-out-of-contract-kind`;
`bad-activity-probe` → `category-out-of-contract-provenance`; `bad-scope-probe`
→ `category-out-of-contract-scope`; `bad-importance-probe` →
`importance-out-of-range`.
Planned demotions (row + identity fields preserved, `status='quarantined'`,
ledger reason): credential-shaped content/evidence/meta is REDACTED in the
operational target before any write (`credential-content-demotion`; the raw
byte-verbatim copy survives ONLY in the 0700 private restore-grade `backup/`,
never in `normalized/`); active instruction rows
(`instruction-conservative-demotion`) and persona-provenance ACTIVE rows
(`persona-policy-demotion` via the seam's policy) stay content-verbatim and
fail-closed.

## 4. Verification evidence (real runs, this session)

| suite / command | result |
|---|---|
| `node scripts/test-v02-import-lane.mjs` (new, 93 assertions) | **93 passed, 0 failed** |
| `node scripts/test-v02-import-seam.mjs` | **46 passed, 0 failed** |
| `node scripts/test-migration-v02.mjs` | **44 passed, 0 failed** |
| `node scripts/test-storage.mjs` / `test-recall.mjs` | ALL PASS |
| `node scripts/test-v02-journal.mjs` | **26 passed, 0 failed** |
| `node scripts/typecheck-v02.mjs` (repository strict gate, rc.2 peer contracts) | **PASSED** |
| `node scripts/typecheck-v02.mjs --emit-lib` (final strict emit build) | **PASSED**, repo lib refreshed |

What the 93 assertions prove (each named in the suite output):

1. **Plan contract**: CLI `plan` writes only marker + plan.json into a fresh
   destination; occupied or nonexistent-source paths refuse loudly
   (missing memory.db, non-SQLite header) with no dest artifacts.
2. **Verdict-count identity in the plan** for every family (memories,
   baseline, episodes, persona, generatedSkills, conversations, cursors,
   scenes, vectors, unknownSchemaObjects).
3. **Determinism**: byte-identical `planDigest` for the same source across
   fresh destinations; the approval token is destination-bound.
4. **Bounded JSON**: zero secret canaries in plan.json / ledger.json /
   receipt.json and in both CLI stages' stdout/stderr.
5. **Restore-grade separation**: canaries are byte-verbatim ONLY in
   `backup/` (persona prose, settings api-key, memory.db content incl. the
   credential-shaped row, skill bodies, conversation slices); the credential
   canary is byte-absent from every `normalized/` file (raw byte scan of
   memory.db/WAL/FTS/meta across the whole tree), and only the pre-demotion
   redaction of credential-shaped parts is the planned minimization.
6. **Source immutability**: the stable-file source digest is byte-identical
   before the fixture build, after `plan`, and after `import`.
7. **Approval gates**: missing + mismatched token refuse (exit 2) with zero
   artifact writes.
8. **Lifecycle**: a completed receipt refuses re-run (even `--resume`); a
   fresh plan refuses an occupied destination.
9. **Plan integrity**: a tampered plan body refuses on the recomputed
   `planDigest` before any write.
10. **Source drift CAS** (adversarial): a WAL-mode memory row committed into
    the source after `plan` is caught pre-write (tree/WAL/content-fingerprint
    delta) and zero artifacts are written.
11. **Target ownership**: marker removal refuses; a pre-seeded unowned target
    row refuses BEFORE the backup lane writes anything; a foreign watermark in
    store_state refuses as a collision.
12. **Verbatim verdicts through the seam**: id/kind/importance/created_at/
    updated_at/supersedes/status plus provenance/source/scope/project/session/
    confidence/expiresAt/evidence carried verbatim; non-active statuses
    preserved; the three planned demotions land quarantined exactly as planned;
    unsupported rows are absent from the target.
13. **Recall lanes**: FTS returns active imported rows; the demoted
    credential and persona rows are NOT searchable/injectable.
14. **No dedup/merge + minted seq**: target `memories_seq` holds exactly
    accepted-row-count unique strictly increasing values (1..139); the ledger
    writes the explicit `legacySeq → targetSeq` map; duplicate/conflict groups
    carry verbatim (mechanics never merge).
15. **No native ack**: target `extract_state` stays empty (backlog never
    consumed), cursors/persona/skills/scenes/vectors stay out of the target
    with the receipt's `limits` array naming each non-imported family
    explicitly (no pretend-lossless).
16. **Crash oracle A (real SIGKILL mid-chunk)**: worker dies at
    `memory-chunk:2:mid`; reopened target shows exactly the committed chunk
    (100 rows) with its SAME-TX watermark, zero partial rows, no FTS orphan,
    no receipt/ledger; CLI `import --resume` completes with the exact count
    identity, no duplicate seq, and the complete import marker row.
17. **Crash oracle B (SIGKILL right after ledger.json)**: resume rewrites
    NOTHING except the missing receipt (ledger bytes hash-identical), full
    reconciliation holds.
18. **Crash oracle C (SIGKILL inside the final transaction)**: baseline pin +
    import marker rollback verify absent pre-resume; resume commits exactly
    one pin, reconciliation holds.
19. **Unsupported accounting** with exact ids+reasons and baseline pin
    coordinates (dangling + ineligible provenance).
20. **Evidence accounting**: parseable-only evidence policy; the unverifiable
    episode ref appears once as an opaque `opaque:<digest>` (raw ref id never
    in the plan); the genuinely dangling supersedes is carried verbatim with a
    bounded `integrity-note` but is never normalized into trust.

## 5. Honest limits and deliberate deviations (not hidden behind claims)

- **Absent** from this increment, explicitly (design §4 rows honored as
  retained/unsupported, not as losses): persona versions and persona/ files are
  backed up byte-verbatim but NOT imported into the operational target; the
  same for generated `dsi-*` skills (never activated, never copied into any
  live skill root), valid conversation lines (extraction backlog stays in the
  backup and is NOT enqueued to the v0.2 journal — seq-zero / >200k canonical
  reread / pre-fix truncation honesty is owned by the journal lanes), legacy
  cursors (orientation only; nothing acked), scene aggregates, and
  vectors.db embeddings (counted, rebuildable). Merging duplicate groups, any
  cutover/rollback execution, settings writes (the plan carries only a bounded
  conservative proposal and never writes config), and the active profile remain
  out of scope and untouched.
- **`-wal`/`-shm` are excluded from the stable-tree CAS digest** (documented in
  `digestTree`): opening ANY read-only SQLite connection to a WAL-mode store
  legitimately creates/deletes those companion files, so their presence cannot
  honestly signal mutation. WAL data safety is instead covered by three
  mechanisms: every content read runs on a fresh transactionally consistent
  `VACUUM INTO` snapshot; the exact `memory.db-wal` BYTES are CAS-digested
  separately at plan time and re-verified pre-write and post-write; and a
  plan-bound content fingerprint (every memory row tuple + all family
  counters + the schema finding) is re-verified against the apply-time
  snapshot BEFORE the first write and again after the last. The adversarial
  WAL-commit drift case (§4.10) proves this catches changes that the main-file
  sha alone would miss.
- **Runtime stats reset**: the seam's contract resets `access_count`,
  `read_count`, `last_read_at` in the operational target; the backup preserves
  them byte-verbatim. Non-1..10 importance values and meta fields whose types
  cannot survive the STRICT target (out-of-contract kind/status/provenance/
  source/scope, drifted timestamps) are unsupported-evidenced with coordinates
  instead of being silently clamped/drifted.
- **Settings lane**: the plan's carry set is a deliberately conservative subset
  (7 leaves + the credential-safe value guard, all presence-only elsewhere);
  the full Phase A mapping stays in Phase A's report lane; the backup holds the
  byte-verbatim settings file when `--settings` is given.
- **Determinism scope**: plan/ledger/receipt JSON are byte-deterministic (no
  wall-clock entropy; all timestamps in documents come from preserved source
  data). SQLite-side bookkeeping columns (`store_state.updated_at`) use the
  clock — they never enter any durable JSON document.
- **Backup restore semantics**: `backup/memory.db` is a `VACUUM INTO`
  consistency snapshot (WAL-inclusive) of the source at apply time — verified
  row-for-row identical to the source in the suite — plus byte-verbatim
  companions (conversations/, persona/, vectors.db, skills root, settings
  file) and a sorted digest `MANIFEST.sha256` whose every line is
  re-verified before the receipt exists.
- **Bounded scale** (the same caps as Phase A): 50,000 memory rows, 200,000
  episode ids, chunked writes (100 memory rows / 1000 derived rows per
  immediate transaction). Larger stores refuse at plan time rather than exceed
  the audited boundary set.
- **Not proved here and not claimed**: live production import, cutover, any
  skill/persona activation, any settings write, multi-host concurrency, and any
  real-user-data behavior. The crash oracles use the test-only crash-point
  parameter of the engine (`testCrashPoints`), which is a no-op unless the
  caller sets it explicitly; kill points are documented in the suite and
  worker fixture.
- The repository strict gate passed at report time (the Workflow27 extract file
  was transiently strict-unstable during earlier sessions; nothing in this lane
  added an error, and no Workflow27 file was edited).

## 6. Not claimed here

No storage/index/extractor/capture/journal/redact/inject/business/client/manifest
source edits; no Git commits or staging; no production/profile access; no
provider/network/model calls; no dependency install or runtime patch; no skill
activation anywhere; no live skill root touched; no replacement of the Phase A
CLI; no settings or config write; no claim of losslessness where this report
says "retained in the backup only" or "unsupported-evidenced".
