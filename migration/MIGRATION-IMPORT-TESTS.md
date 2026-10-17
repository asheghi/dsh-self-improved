# Phase A migration increment — v0.2 import toolchain: safe inventory + synthetic dry-run

Status: **inventory and dry-run only. No import writer exists.** This increment
implements MIGRATION-V0.2.md § "Actual migration of existing data" steps 1 and
3 in read-only form; steps 4–9 (mapped import, shadow validation, cutover) are
Phase B/C work and are claimed nowhere. Coordinated with the other active
workflows (3: Phase A implementation/review; 5: runtime fixtures) — no shared
or foreign file was modified by this increment.

Independently reviewed and hardened after the coordinator's round-41 report
safety review; the review findings, reproduction evidence and fix list are in
[MIGRATION-IMPORT-REVIEW.md](<MIGRATION-IMPORT-REVIEW.md>). The hardening
changes are asserted by this same suite (39 assertions) and are all still
synthetic-fixture-only.

## Deliverables (all new, none shared)

| file | role |
|---|---|
| [src/migration-v02.ts](<../src/migration-v02.ts>) | standalone engine: read-only source inventory, isolated synthetic dry-run projection, schema support classification, settings mapping proposal, path-safety validators. Imports only node builtins; never constructs the legacy `MemoryStore`. |
| [scripts/migrate-v02.mjs](<../scripts/migrate-v02.mjs>) | operator CLI (see commands below): refuses to run without explicit `--source`; validates any `--report` destination BEFORE engine compilation and BEFORE any source read; compiles the engine into a uniquely owned guarded temp tree. |
| [scripts/test-migration-v02.mjs](<../scripts/test-migration-v02.mjs>) | 39-assertion regression suite over synthetic fixtures only (incl. adversarial `--report` CLI runs with checksum before/after). |
| [fixtures/v02-migration/](<../fixtures/v02-migration/README.md>) | synthetic legacy-store fixture builder, settings patch fixture, golden expectations, dataset documentation. |
| MIGRATION-IMPORT-TESTS.md | this durable report. |

## Commands and results

All run on branch `migration/deepseek-harness-v0.2` against a **synthetic**
fixture store built in a uniquely owned temp tree; no production path, live
legacy profile, or installed-runtime write was touched.

1. `node scripts/test-migration-v02.mjs`
   → exit 0; **39 passed, 0 failed** (~6 s). The suite re-runs the isolated
   strict compile (`node_modules/typescript/bin/tsc` into a guarded temp dir)
   and thirteen CLI subprocess runs (adversarial `--report` refusals) as part of
   every run. One earlier version of the hardening suite failed a
   newly-added WAL-convergence assertion (transient `*-shm` maintenance by the
   analysis readers falsely flagged as a source mutation); this exposed a real
   digest-contract defect (see MIGRATION-IMPORT-REVIEW.md finding F3), which is
   fixed in src/migration-v02.ts and now passes.
2. `node scripts/typecheck-v02.mjs` (no emit; reads installed rc.2 declarations via
   symlinked scratch tree, whole `src/` including the new module)
   → exit 0; all dsh peers pinned `0.2.0-rc.2`; "strict typecheck against
   rc.2 contracts PASSED (source strict; dependency declarations skipped via
   skipLibCheck)". Prior gate result preserved; the module is included and
   green.
3. `node scripts/migrate-v02.mjs inventory --source /nonexistent-dsi-probe`
   → exit 2, `migration-v02: no memory.db under source root (missing-source)`.
4. `node scripts/migrate-v02.mjs inventory` (no `--source`)
   → exit 2, "refusing to run without an explicit --source directory (no
   production defaults)".
5. Coordinator-confirmed destructive vector, reproduced and re-verified after
   the fix on a synthetic SQLite store built by the reviewer (never a
   production path):
   - before the fix, `inventory --source <store> --report <store>/memory.db`
     **overwrote the source memory.db with report JSON** (sha256
     `a0ff99d4…` → `ad541952…`) while still printing its normal playlist.
   - after the fix the same invocation exits 2 with
     `refusing report destination … it names the source store or a path inside
     it (…); report files never land on any input`, and the sha256 of
     memory.db is identical before/after; fresh-name reports inside the source
     tree, inside the skills root, on the settings file, on/inside the
     destination candidate, on existing unrelated files, on existing symlinks
     and through symlinked parent directories are refused the same way; a
     legitimate fresh report succeeds (exit 0) and a second identical run
     refuses instead of replacing the first report (byte digest unchanged).
6. `git diff --check`
   → exit 0 (no whitespace errors in any touched file).

## Safety contract and how each requirement is proven (suite assertions)
- **Read-only source access; SQLite only; no mutating legacy store**
  (asserts "engine imports…" + "dry-run leaves source bytes…"): the engine opens `node:sqlite` `readOnly` and analyzes a
  `VACUUM INTO` snapshot created from that read-only connection; the emitted
  module contains no `MemoryStore` reference and imports only `node:*`
  modules. Byte digests + the full source file-set are identical before/after
  every run.
- **WAL snapshot completeness of the dry-run snapshot** (assert "VACUUM INTO
  snapshot sees uncheckpointed WAL content…"): a synthetic store is switched to
  `journal_mode=WAL`, a row and its metadata are committed while the writer
  connection stays open (so memory.db alone and a plain file copy would miss
  the row), then the inventory is run concurrently: the WAL-only row is
  included in counts (total 25), `sourceUnchanged`/`sourceSchemaUnchanged`
  stay true, and the data-bearing `memory.db`/`memory.db-wal` bytes are
  untouched. This proves the dry-run snapshot is WAL-inclusive rather than
  trusting the claim.
- **Report destination is never an input, existing path or symlink** (CLI
  inventory requires…asserts "CLI validates --report before compilation or
  any source read", "CLI refuses a --report pointing at the source memory.db",
  "CLI refuses fresh-name --report paths inside every input tree", "CLI
  refuses a --report on the settings input and on/inside the destination
  candidate", "CLI refuses a --report on any existing unrelated path or an
  existing symlink", "CLI refuses a --report through a symlinked parent
  directory", "CLI writes a fresh report exclusively…", "CLI guarded
  open-failure leaves no partial report behind"): report-path validation runs
  in the CLI before the engine is compiled and before anything reads the
  source; every refusal is proven with actual `spawnSync` CLI subprocess runs
  and sha256/tree digests taken before and after (not helper-only asserts),
  the destination candidate and all inputs stay byte-identical, refused runs
  leave no partial file, the exclusive `wx` creation makes a second identical
  run refuse rather than replace, and an unwritable parent exercises the
  guarded open-failure path with cleanup-on-write-error semantics.
- **Source bytes/schema unchanged around the dry-run** (asserts "dry-run leaves source bytes…" + "explicit no-mutation…"): digests of
  the complete source tree before analysis are re-digested after; the schema
  is additionally re-classified straight from a second read-only connection on
  the *source* (not the snapshot) after analysis; any divergence flips
  `supported=false` and is listed in `unsupportedReason`.
- **Dry-run modifies neither source nor active destination** (asserts "dry-run validates the destination…" + "dry-run leaves source bytes…"): with a
  destination candidate supplied (pre-existing file present), the report
  records `destinationTouched=false`, `destinationValidated=true`, and the
  destination file set is asserted byte-identical (digests) before/after.
- **No secrets or private content in reports** (asserts "secrets are presence-only…" + "report contains no raw memory…"): canary markers are
  planted in every content lane (memory text, slice text, persona prose, skill
  bodies, the settings `apiKey`, an unknown settings leaf) and asserted absent
  from the full report JSON; secret-shaped leaves report `present: true` only;
  unknown/unmapped settings leaves are presence-only; carry leaves carry only
  innocuous values (providers/models/booleans) and even those are withheld
  when a string matches credential-in-query/userinfo patterns.
- **Conservative provenance quarantine** (assert "conservative provenance…"): unknown/system/tool/
  skill/coordinator provenance and any leaked `instruction` row are classified
  `quarantine-proposed` (6 in fixture), never personal authority;
  assistant/derived → `review-required`; forgotten/migrated/quarantined/
  decayed rows are preserved as status; missing-meta rows (drifted v1
  contract) are distrusted, not normalized.
- **Scope/id/timestamp preservation** (assert "preservation bookkeeping…"): the preservation ledger records
  id/scope/supersedes/created_at/updated_at carried verbatim per row (24/24
  ids, 13/13 proposed rows), supersession chains (2, one intentionally broken
  → `brokenSupersedes=1`), evidence linkage (2 entries; the one referencing a
  missing episode is `evidenceUnverifiable` — never invented).
- **Conflicting duplicate source audit** (assert "conflicting duplicate audit…"): duplicate content groups and
  same-scope conflicting preference groups are only proposed during Phase B
  through the dry-run projection with conflicting content hashes.
- **Persona/skills inactive; consent not expanded** (asserts "persona prose and generated skills…" + "episode consent…"): old personas and
  generated `dsi-*` skills are inventoried with `migrationActivation:
  "inactive"`; `episodeLearning.*` consent values are read as recorded and
  carried under `sameOrNarrower: true, notExpanded: true,
  reconfirmAtCutover: true`.
- **Settings mapping proposal** (assert "settings mapping…"): per-leaf classification
  carry/retire/secret/migrationOnly/defer/unmapped with deterministic defaults
  (`equalsDefault`), explicit retirement of module on/off switches, unsafe
  provenance bypass and fallbackOnBadJson paths, and presence-only handling
  for `storageRoot`/`skillsRoot` (workflow-only paths) and the API key.
- **Unsupported/missing schema detection** (asserts "schema drift…", "pre-migration store…", "missing memory.db…", "a non-SQLite memory.db…", "snapshot temp trees…"): an unknown side
  table or a missing `schema_state 'v2'` marker classifies the source
  unsupported (no proposal); a pre-migration store without markers is
  unsupported; a missing/unreadable memory.db surfaces `missing-source` — also
  via CLI exit 2 and exit 3 respectively for refused/unsupported; a non-SQLite
  memory.db (random bytes with the right name) is refused as unsupported-source
  (engine message + CLI exit 2, never improvised); analysis-only snapshot temp
  dirs (`dsi-v02-migration-snap-*`) are asserted absent from tmpdir after
  every engine run. The realtime `*-wal` sidecar is and stays part of the
  digested file set (data-bearing); only the transient non-durable `*-shm`
  wal-index is excluded from digests on principled grounds — see
  MIGRATION-IMPORT-REVIEW.md finding F3.
- **Dangerous source/destination paths rejected** (asserts "validateSourceDestination rejects…", "symlink-bound roles…", "refuses source==destination…", "a symlink inside the source tree or skills root…"):
  `validateSourceDestination` refuses same path, nesting in either direction,
  and any symlink component in either role, before any read; the CLI returns
  exit 2 for overlap; additionally a symlink anywhere *inside* the source
  tree or skills root (not just the named roots) is refused before any audit
  read, so external content can no longer be silently folded into counts
  while digests see "unchanged".
- **Isolated compilation with guarded cleanup** (asserts "engine imports…" + "CLI removed only its own unique compile tree…"): both the suite and
  the CLI compile the owned module into a uniquely created temp tree and
  remove only the tree whose ownership marker still matches; after the full
  run there are no `dsi-migration-v02-*` / `dsi-migrate-v02-build-` /
  `dsi-v02-migration-snap-` leftovers in tmpdir.
- **Tiny YAML reader is deliberately conservative** (parse failure refuses
  instead of guessing — covered indirectly via the settings-leaf tests; the
  settings file is only read when the operator names it).

## Backup contract (offered dry-run snapshot vs cutover backup)

The dry-run snapshot is analysis-only (`VACUUM INTO` from a read-only
connection into an owned temp tree; WAL-inclusive and transactionally
consistent). This is NOT the cutover backup: the report's
`safety.onlineBackupContract` states the requirement that the real migration
backup must come from a consistent snapshot over a quiesced/checkpointed
writer set (VACUUM INTO or a real SQLite online backup) plus companion
metadata, old settings/patch layers and skill revisions in a checksummed
manifest; copying a live database file alone is explicitly rejected.

## What this increment does NOT claim

- No Phase B import writer exists; nothing imports rows into a v0.2 store.
- No crash-boundary guarantee (enqueue/commit boundaries) is proven here.
- No production/live data was read; `--source` must be operator-supplied.
- No dependency patch, version exemption, active-profile change, skill
  activation, or generated learnings.
- The settings target-area names are a proposal surface, not an implemented
  v0.2 Settings UI (Phase A UI work remains with other files).
- v0.2's one-time legacy settings import outcome must still be inspected at
  cutover; the report says so in `settings.note`.

## Remaining gates (in order)

1. Phase B: real import writer — seq-zero-safe cursors, transactional
   acknowledgment of only consumed ranges, source dedup by identity, crash
   recovery without duplicate evidence (MIGRATION-V0.2.md Phase B gate).
2. Residual Phase A gates owned by other files: isolated-profile
   mount/unmount (#1), visible stale-settings rejection (assert "preservation bookkeeping…"), first
   provider-request recall timing, volatile-Config review.
3. Cutover: one-writer switch, checksummed backup manifest run, settings
   import outcome inspection, then bounded recall enable (learning/skills stay
   gated).
4. Held-out shadow validation and browser checks (Phase B/C).
5. Only residual caveat of the report-destination hardening: the exclusive `wx`
   creation makes overwriting impossible at write time, but a directory
   transplanted between validation and open could receive (never replace) a
   created file — inherent re-check race for an operator tool, recorded in
   [MIGRATION-IMPORT-REVIEW.md](<MIGRATION-IMPORT-REVIEW.md>).

## Rollback

Nothing shared was changed and no commit was made by this increment
(untracked files only). Rollback = delete
`src/migration-v02.ts`, `scripts/migrate-v02.mjs`,
`scripts/test-migration-v02.mjs`, `fixtures/v02-migration/`, and
`MIGRATION-IMPORT-TESTS.md`; then re-run `node scripts/typecheck-v02.mjs`
(last sanctioned result before this increment: the rc.2 strict typecheck PASS
recorded in MIGRATION-PROGRESS.md) and `node scripts/test-phase-a.mjs` to
confirm the tree is exactly the pre-increment Phase A state. Do NOT revert
commits or shared files: the preexisting user peer edits and other workflows'
files live in the same working tree.
