# Phase A import increment — independent safety review and hardening record

Status: **review complete; dry-run/increment only.** This is the
post-implementation, adversarial re-review of the Phase A import toolchain
([src/migration-v02.ts](<../src/migration-v02.ts>),
[scripts/migrate-v02.mjs](<../scripts/migrate-v02.mjs>),
[scripts/test-migration-v02.mjs](<../scripts/test-migration-v02.mjs>,
[fixtures/v02-migration/](<../fixtures/v02-migration/README.md>)) requested
against MIGRATION-V0.2.md § "Actual migration of existing data" and
[MIGRATION-IMPORT-TESTS.md](<MIGRATION-IMPORT-TESTS.md>). It does NOT
implement a Phase B import writer and does not advance the phase. All fixes
live only in the importer files and fixture doc owned by this workflow; no
shared file, runtime fixture, coordinator doc or other workflow's file was
modified, and no commit/stage was made.

## Method

Full read of MIGRATION-V0.2.md and MIGRATION-IMPORT-TESTS.md; line-by-line read
of the engine, CLI, test suite and fixture builder; coordinator finding
reproduction on a reviewer-built synthetic SQLite store; then hardening +
regression suite extension (27 → 39 assertions), all synthetic, no production
path, no live profile, no provider call, no settings change, no dependency
patch or exemption.

## Findings

### F1 — CRITICAL (confirmed by coordinator round-41; reproduced before fix): `--report` could destroy any input

`scripts/migrate-v02.mjs` took the optional `--report` path directly to
`mkdirSync` + `writeFileSync` **after** the engine had finished (and after its
unchanged-checks), with no collision, containment or symlink guard. Reproduced
on a synthetic store built by the reviewer:

- `migrate-v02.mjs inventory --source /tmp/dsi-probe-safety/dsh-home/memory
  --report /tmp/dsi-probe-safety/dsh-home/memory/memory.db`
- result: the source `memory.db` was overwritten with the report JSON (sha256
  `a0ff99d454a51f52…` → `ad541952d50966c66…`) and the tool still printed its
  normal output. Driving `--report` at the settings file, `--skills-root`
  contents, or the `--dest` candidate, or through a symlink, was equally
  unprotected.

Fix (`scripts/migrate-v02.mjs`, all validated BEFORE engine compilation and
BEFORE any source read):

1. `validateReportDestination(reportPath, inputs)` — structural `lstat` walk of
   every path component: an existing symlink component anywhere is refused
   ("never write through links"); every existing parent must be a real
   directory; the final component must not exist at all.
2. Containment: the resolved report target must not be equal to or inside any
   named role — source store tree (contains memory.db, conversations/,
   persona/, vectors.db), `--dest` candidate, `--settings` file, `--skills-root`
   tree. Checks are lexical over already-symlink-free paths, so containment
   cannot be escaped by redirecting a component.
3. Exclusive creation only: the report is opened with `openSync(target,
   "wx")` through an owned fd — the authoritative race-safe guard — then the
   content is written and `fsync`-ed. A previous report is never replaced; the
   operator must remove it explicitly. On a mid-write failure the partially
   created file is unlinked (we provably created it; nothing pre-existing was
   ever opened).
4. Argument parsing now refuses value-less / `--`-confused option values
   (previously `--report --json` silently consumed the next flag as a path).
5. `parseArgs` value handling plus a `--report ""` guard avoids being
   silently treated as "stdout only".

Verification: the same destructive invocation now exits 2 with
`refusing report destination …: it names the source store or a path inside it
(…); report files never land on any input` and the sha256 of memory.db is
identical before/after; a legitimate fresh report succeeds (exit 0); a second
identical run refuses instead of replacing the first report (bytes unchanged);
`node --check` passes. The refusal also precedes `missing-source` on a source
with no memory.db, proving ordering (report validation → compilation → source
read). All of this is asserted by real CLI subprocess runs with checksums
before/after in the suite (not helper-only asserts).

Residual caveat: validation at start + scarce-TOCTOU between start and write is
closed by the `wx` open itself; a path that *becomes* a symlink-dir between
validation and open could redirect the write, but `wx` still refuses on any
existing final component, so overwriting remains impossible — creation into a
transplanted directory is the residual risk, inherent to per-second re-checking
and acceptable for an operator tool (documented here).

### F2 — HIGH: input-tree symlinks inside the source/skills roots were silently followed

`assertNoSymlinkComponents` covered the named path and its ancestors only. A
symlink *inside* the source tree (e.g. `conversations-link → external`) was
followed by the audit readers (`existsSync`/`readdirSync`/`statSync`) while
`digestDirectory` skipped symlinks — counts/report could be influenced by
content the operator never named, and the byte-digest check still reported
"unchanged". Fix: new `refuseSymlinkedContent(root, role)` deep-walk in the
engine refuses any symlink entry under the source store tree and the skills
root before any read. Proven by new suite tests (dir symlink into the source
and into the skills root must throw with the specific refusal).

### F3 — MEDIUM: transient `*-shm` maintenance falsely flagged `sourceUnchanged=false` on live WAL stores

While adding the WAL-completeness regression test, the suite caught that the
analysis readers maintain the SQLite `*-shm` wal-index file of a live WAL-mode
store (sha256 `d1fd9d623a…` → `0a028f53b1…` during one analysis), making
`sourceUnchanged` false even though `memory.db` and `memory.db-wal` (both
data-bearing) never changed. Since SQLite defines `*-shm` as a non-durable,
rebuildable-from-WAL file (it is never part of real backups), digesting it
caused false "source changed during analysis → unsupported" refusals for any
concurrently-live real store. Fix: `digestDirectory` excludes files ending in
`-shm` only; `*.db`, `*-wal`, and every other file remain digested. Documented
in the engine header and MIGRATION-IMPORT-TESTS.md safety contract.

### F4 — LOW: stat races in the conversation/persona audits could crash the whole run

`auditConversations` and `auditPersona` called `statSync` unguarded on
readdir entries; a file vanishing mid-walk (or any ENOENT) would abort the
inventory with a raw stack instead of conservative accounting. Now guarded:
raced slice files count as `malformedLines` (never silently dropped from the
audit), raced persona files are simply not counted.

### F5 — LOW: confusing swapped aliases in the task-scoped candidate query

`conflictAudit` joined `memories AS mm` / `memories_meta AS m` — aliases were
semantically correct but crossed, which invites future edits to invert
status/scope ownership. Renamed to `mem`/`meta` with a comment; identical
result (asserted unchanged by the golden counts, `taskScopedCandidates: 1`).

### F6 — INFO: documentation/count drift

The increment report claimed a 27-assertion suite while the hardened suite has
39; MIGRATION-IMPORT-TESTS.md wording and counts were updated accordingly.

## Re-audits that came back clean

- **Report metadata/ids/scope**: the report carries ids, scopes, timestamps,
  provenance/key counts and digests only; `sampleIds` are ids by design. No
  memory content, slice text, persona prose, skill body, or settings value
  beyond mapped non-secret carry leaves (providers/models/booleans) enters any
  output; canary assertions cover every content lane plus the settings API key
  and unknown leaves (`sk-canary-apikey-never-leak-0000` et al.).
- **Unsupported/error cases**: unknown tables, missing `schema_state 'v1/v2'`,
  user_version disagreement, `quick_check` failures, non-SQLite memory.db
  (random bytes → refused as unsupported-source, CLI exit 2), unreadable
  settings, YAML-sequence refusal.
- **Temp cleanup**: snapshot dirs carry an ownership marker and are removed on
  both success and failure; the suite now asserts no
  `dsi-v02-migration-snap-*` leftovers in tmpdir after every engine run (plus
  the compile-tree probe run).
- **Determinism**: byte-identical report JSON across repeated runs on the same
  store (assert by the unchanged re-run test; the identical digests of two
  independent CLI reports in the reproduction session corroborate).

## Commands actually run (all synthetic)

| command | result |
|---|---|
| `node --check scripts/migrate-v02.mjs` / `node --check scripts/test-migration-v02.mjs` | syntax OK |
| destructive reproduction (synthetic store, before fix) | sha256 `a0ff99d4…` → `ad541952…` (memory.db destroyed) |
| same invocation after fix | exit 2, refusal message, sha256 `a0ff99d4…` unchanged |
| `--report <source>/conversations/new-report.json` after fix | exit 2, containment refusal, no file created |
| `--report <legit fresh path>` after fix | exit 0, report written (deterministic digest) |
| second identical `--report` run | exit 2, existing report bytes unchanged |
| `node scripts/test-migration-v02.mjs` | **39 passed, 0 failed** (~6 s) |
| `node scripts/typecheck-v02.mjs` | PASSED, all peers pinned `0.2.0-rc.2`, new module included |
| `git diff --check` | exit 0 |
| snapshot/compile temp probes | no `dsi-migrate-v02-build-*` / `dsi-v02-migration-snap-*` / `dsi-migration-v02-*` leftovers |

## Environment observation (not a code finding)

An external temp janitor removed reviewer files from `/tmp` **between tool
calls** (a probe directory and a probe script vanished without any local
process touching them; harmless to the suite, which guards its own
`mkdtempSync` worktrees with ownership markers, but anyone re-running the
manual reproduction commands above should build the fixture and run the CLI
within the same shell session).

## Remaining gates (superset of MIGRATION-IMPORT-TESTS.md "Remaining gates")

1. Phase B: real import writer (seq-zero-safe cursors, transactional
   acknowledgment of consumed ranges, source dedup by identity, crash-boundary
   recovery) — not started, not claimed.
2. Residual Phase A gates owned by other workflows/files: isolated-profile
   mount/unmount, visible stale-settings rejection, first provider-request
   recall timing, volatile-Config review.
3. Cutover: one-writer switch, checksummed WAL-inclusive backup manifest,
   v0.2 one-time settings-import outcome inspection, then bounded recall
   enablement (learning/skills stay gated).
4. Held-out shadow validation and browser checks (Phase B/C).
5. For this increment specifically: only the exclusive-report
   creation-race-into-transplanted-directory caveat (above) remains, accepted
   as inherent for an operator tool.

## Rollback of the hardening

Revert the untracked edits to
[src/migration-v02.ts](<../src/migration-v02.ts>),
[scripts/migrate-v02.mjs](<../scripts/migrate-v02.mjs>),
[scripts/test-migration-v02.mjs](<../scripts/test-migration-v02.mjs>) and
[MIGRATION-IMPORT-TESTS.md](<MIGRATION-IMPORT-TESTS.md>) only — they contain
exclusively this workflow's changes; nothing of any other workflow is inside
these four files, and no commit was made.
