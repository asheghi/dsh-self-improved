# v0.2 migration — synthetic import fixtures (Phase A increment)

All data in this directory is **synthetic**: fixed strings, fixed timestamps
(`T0 = 1_700_000_000_000`), deterministic ids (`dsi-fixture-*`). Fixtures are
built into uniquely owned temporary trees at test time by
[build-synthetic-fixture.mjs](<build-synthetic-fixture.mjs>); **nothing here is
production data, and the migration tooling never reads production or live
legacy profiles** (the CLI refuses to run without an explicit `--source`
directory, see [scripts/migrate-v02.mjs](<../../scripts/migrate-v02.mjs>)).

## fixtures

- [build-synthetic-fixture.mjs](<build-synthetic-fixture.mjs>) — creates a
  legacy v0.1 `self-improved` store (schema_state v1+v2, STRICT tables,
  conversations JSONL, persona/, vectors.db, dsi-* skills repo) plus a settings
  patch file. Variants:
  - `standard` — complete supported store; golden expectations in
    [golden/expected-standard.json](<golden/expected-standard.json>).
  - `unsupported` — schema drift (`mystery_side_table`, missing `schema_state`
    'v2' marker); the inventory must refuse to propose anything instead of
    guessing.
  - `pre-migration` — no migration markers at all (pre-Hermes legacy store).
  - `missing` — no memory.db.
- [golden/expected-standard.json](<golden/expected-standard.json>) —
  hand-written expectations. The suite asserts the exact subset; deltas must be
  justified in the fixture data or fixed in
  [src/migration-v02.ts](<../../src/migration-v02.ts>), never masked.

## synthetic dataset

| id | kind/status/provenance | lane classification expected |
|---|---|---|
| dsi-fixture-01 | fact/active/user | personal-eligible |
| dsi-fixture-02 | preference/active/user | personal-eligible |
| dsi-fixture-03 | preference/corrected/user (supersedes 03-old) | personal-eligible |
| dsi-fixture-04 | fact/active/user (duplicate content of 01) | personal-eligible |
| dsi-fixture-05 | fact/active/assistant (source llm-extract-pasted) | review-required |
| dsi-fixture-06 | fact/active/derived | review-required |
| dsi-fixture-07 | fact/active/unknown (evidence → missing episode) | quarantine-proposed |
| dsi-fixture-08..11 | fact/active/system\|tool\|coordinator\|skill | quarantine-proposed |
| dsi-fixture-12 | instruction/active/user (v1 leakage probe) | quarantine-proposed |
| dsi-fixture-13/14 | persona kind | persona-lane-inactive |
| dsi-fixture-15/16 | event (project/session scope) | task-handoff-candidate |
| dsi-fixture-17 | fact/active/user, source llm-extract-pasted | personal-eligible (pasted demotion audited) |
| dsi-fixture-18..21 | statuses forgotten/migrated/quarantined/decayed | preserved-* |
| dsi-fixture-22 | fact/active/user, broken supersedes | personal-eligible, brokenSupersedes audit |
| dsi-fixture-23 | fact/active, no meta row | missing-meta (never trusts drifted provenance) |
| dsi-fixture-03-old | preference/corrected/user | personal-eligible |

Episodes: 1 succeeded/reviewed + 3 paired steps, 1 pending (delegated) with one
unpaired step, 1 failed with unpaired step, 1 rejected/reviewed. Conversations:
s1 (12 valid slices, seq 0..11; cursor 0→12 backlog), s2 (8 valid + 1
duplicate-seq line + 2 malformed), s5 (3 valid slices, no cursor), plus cursor
s4 without a file. Canary markers (`MEMORY-CANARY…`, `SLICE-TEXT-CANARY…`,
`PERSONA-PROSE-CANARY…`, `SKILL-BODY-CANARY…`, `sk-canary-apikey-never-leak-0000`,
`UNKNOWN-SETTINGS-VALUE-never-carry`, plus the schema_state privacy pair
key `legacy-private-note` → value `SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT` and the
adversarial category-metadata strings `SYNTHETIC-{STATUS,KIND,PROVENANCE,SOURCE}-METACANARY-never-report`)
are planted in every content lane and in SQLite free-string metadata; the suite
asserts none of them appear raw in any report — see
[MIGRATION-IMPORT-PRIVACY.md](<../../MIGRATION-IMPORT-PRIVACY.md>).

Owned by the Phase A import-increment workflow; coordinated through
MIGRATION-PROGRESS.md (parallel workflows 3 and 5 own other files).
