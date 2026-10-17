# Phase A import increment — report-privacy defect fix (reproduced, verified)

Status: **fix implemented and regression-verified; inventory/dry-run scope
unchanged.** This increments the Phase A import toolchain (the same file
ownership as the earlier privacy review round: [src/migration-v02.ts](<../src/migration-v02.ts>),
[scripts/migrate-v02.mjs](<../scripts/migrate-v02.mjs>), [scripts/test-migration-v02.mjs](<../scripts/test-migration-v02.mjs>),
[fixtures/v02-migration/](<../fixtures/v02-migration/README.md>) — the CLI needed no
change). No Phase B import writer, no phase advance, no shared file,
coordinator document, runtime fixture, other workflow's file, commit or stage
was touched, and no production data, live profile, network/model call,
settings change, dependency patch or exemption was used.

## P7 — CRITICAL (reproduced): inventory reports raw `schema_state` values

### Reproduction (performed exactly as specified, before the fix)

On a synthetic store built by `buildSyntheticHome(uniqueTemp)` in a uniquely
owned temp directory:

1. `DatabaseSync` opened `memory.db`,
   `INSERT INTO schema_state(key,value,applied_at) VALUES ("legacy-private-note","SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT",1700000000000)`, closed.
2. `node scripts/migrate-v02.mjs inventory --source <fixture.memoryRoot> --json`
   → **exit 0 and stdout contained the synthetic secret verbatim**, plus the
   raw unknown marker key `legacy-private-note`.

Root cause: [src/migration-v02.ts](<../src/migration-v02.ts>) `classifySchema` read
**every** `schema_state` row (key, value) and copied the raw values into the
returned `SchemaFinding.schemaState` map, which is part of the report JSON
(line-group: the SELECT/copy block, previously around lines 611–643). The
main-memory/setting canaries of the 39-assertion suite only covered memory
content, slice text, persona prose, skill bodies and settings leaves — SQLite
*metadata* was never canarized, so the leak was invisible to the suite; the
known-marker assertions actively asserted the raw descriptive prose.

### Fix (privacy bounding of source-derived free strings)

Inside `classifySchema` the raw marker map is now **internal only** and
continues to drive the exact previously-required support checks
(`schema_state 'v1'` + `'v2'` presence, and the
`PRAGMA user_version` vs v1+v2 agreement — unchanged semantics; the pre-existing
unsupported/pre-migration classifications are asserted unchanged). The report
instead carries a bounded, deterministic shape:

- `schema.schemaMarkers.known` — one entry per contract marker (`"v1"`, `"v2"`):
  `present: boolean`, `valueDigest` (sha256 hex of the raw stored value — the
  value itself is NEVER reported), and `appliedAt` (allowed preservation
  timestamp, verbatim). Marker keys are contract wire names, not content.
- `schema.schemaMarkers.unknown` / `unknownCount` — arbitrary non-contract
  marker rows are reported only as opaque digested identifiers
  (`opaque:<sha256-12>`) plus the allowed `applied_at` timestamp; the raw key
  text never appears.
- Applied the same principle to the rest of the free-string inventory (checked
  systematically field by field):
  - `counts.memories.byStatus/byKind/byProvenance/bySource`: verbatim only for
    values inside the legacy contract vocabulary (closed enums); anything else
    becomes a `opaque:<digest12>` bucket with its count.
  - `counts.episodes.byStatus`: same bounding.
  - `schema.unknownTables` and `extraColumns.columns`: identifiers are
    attacker- or drift-controllable free text → opaque digests; the
    unsupported-reason text states the count instead of listing names.
  - `schema.integrity`: quick_check failure detail is free-form database text
    → structured status only (`not-ok (detail withheld)`); success stays `ok`.
  - settings parse errors (newly bounded): the unparseable-line error used to
    echo up to 80 chars of the raw settings line; it now names the 1-based
    line ordinal and states the content is withheld.
- Explicitly **preserved verbatim** (allowed identity/preservation metadata, as
  required): memory/skill/setting ids, `sampleIds`, scopes (`byScope`), all
  timestamps (created/updated/applied_at), the source store path, file/dir
  names of the operator-named trees, and source bytes (checksums).

`validateSourceDestination`, the snapshot path, the report-destination
validation, the CLI argument handling, and determinism are untouched; the
re-commit of `finding` via `JSON.stringify` comparison still re-checks the
(source-side) re-run classification against the same sanitized shape.

## Tests (suite extended 39 → 44 assertions; all synthetic, all actual runs)

New in [scripts/test-migration-v02.mjs](<../scripts/test-migration-v02.mjs>): 1 marker-value
and unknown-marker-key digest + raw-absence assertions on the full report JSON
(planting `legacy-private-note` → `SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT` now
inside the shared fixture builder); 2 actual CLI `inventory --json` subprocess
run on a supported store with the unknown/private marker → exit 0 and
stdout free of both canaries, digests asserted; 3 adversarial category
metadata: four memory rows with canary strings in status/kind/provenance/source
→ store stays supported, tallies yield exactly the expected opaque buckets
(count 1 each, digest equality asserted), no canary raw anywhere, source tree
byte-identical before/after; 4 adversarial identifiers: a canary-named unknown
table and a canary-named extra column on `memories` → highlighted unsupported
with `unknown tables` reason carrying no raw name, digested entries asserted,
source bytes unchanged; 5 hostile settings file whose unparseable line
contains a private string → engine `parseError` gives the line ordinal with
content withheld, and the real CLI run echoes nothing.

Existing coverage unchanged in kind: marker support checks are re-asserted on
the new digest/presence shape (standard store supported; `unsupported` and
`pre-migration` variants still classified unsupported with the same
`'v1'`/`'v2'` reason mentions), the golden counts are unchanged (the fixture's
schema_state addition affects no tally), and all `--report`/source-invariance
tests still pass.

## Results

| command | result |
|---|---|
| reproduction BEFORE fix (unique temp fixture + manual marker INSERT) | exit 0; stdout contained `SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT` (1 hit) and `legacy-private-note` (1 hit) |
| same scenario AFTER fix (fixture plants the marker; manual INSERT now redundant) | exit 0; 0 secret hits, 0 raw-key hits; `schemaMarkers.unknown[0].keyDigest = opaque:ee7c9fd301e7` matches the independently computed digest |
| `node scripts/test-migration-v02.mjs` | **44 passed, 0 failed** (~7 s; includes the isolated strict compile of the engine and 20+ real CLI subprocess runs) |
| `node scripts/typecheck-v02.mjs` | *not gate-green in this session through no importer fault*: the whole-`src/` strict pass currently fails ONLY in `src/index.ts:829,952,1052` (syntax errors in another workflow's in-flight file, present before this change began; that file was not touched). `src/migration-v02.ts` itself compiles cleanly under the same strict flags — the suite's isolated `tsc` compile (each run) and every engine result depend on it and pass. The whole-`src/` green gate must be re-run once `src/index.ts` resolves. |
| `git diff --check` | exit 0 |
| temp hygiene | no `dsi-v02-migration-snap-*`, `dsi-migrate-v02-build-*`, `dsi-migration-v02-*` leftovers in tmpdir; reproduction and verify dirs removed after each check |
| source checksum invariance | asserted by the suite on every inventory/dry-run/adversarial run (full-tree digests + `memory.db` + `*-wal` before/after, `sourceUnchanged`/`sourceSchemaUnchanged` true) |

## Bounded-field inventory (what the report may carry verbatim)

id strings and `sampleIds` · scopes · all timestamps · status/kind/provenance/
source/episode-status values **inside the legacy contract vocabularies** ·
table names inside the known-schema set · file/directory names under the
operator-named roots · the operator-supplied source/dest paths · digests and
counts · provider/model/boolean carry leaves after the credential guard.
Everything else — content, marker values, unknown marker keys, unknown
category values, unknown table/column names, quick_check details, settings
error lines — is withheld or reduced to opaque digests.

## Remaining gates

Unchanged from [MIGRATION-IMPORT-REVIEW.md](<MIGRATION-IMPORT-REVIEW.md>) and
[MIGRATION-IMPORT-TESTS.md](<MIGRATION-IMPORT-TESTS.md>) (Phase B import writer;
crash-boundary proof; cutover/one-writer; shadow validation; residual
exclusive-report creation race into a transplanted directory), plus: re-run
`scripts/typecheck-v02.mjs` whole-`src/` after `src/index.ts` (other workflows)
returns to a parseable state. No import writer was implemented and no
activation broadened by this fix.

## Rollback

Revert the untracked edits to `src/migration-v02.ts`,
`scripts/test-migration-v02.mjs`, `fixtures/v02-migration/README.md` and delete
this file; `scripts/migrate-v02.mjs` and
`fixtures/golden/expected-standard.json` are byte-unchanged by this round.
