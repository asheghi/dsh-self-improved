# Finalize v0.2 branch: commit, consolidate docs, draft PR, prune scratch

**Status:** in progress
**Model:** haiku
**Created:** 2026-10-17

## Goal
Make the `migration/deepseek-harness-v0.2` branch reviewable: commit the in-flight host-auth work as one coherent commit, fix three known inconsistencies in `MIGRATION-FINALIZATION.md`, move the ~68 root `MIGRATION-*`/`TAKEOVER-*` files into a tracked `migration/` folder with one short status page, refresh `ROADMAP.md`, open a **draft** PR to `master`, and delete large local ignored scratch directories.

## Acceptance criteria
- [ ] `git status --short` is clean except for intentionally ignored files (and this plan file, which gets committed too).
- [ ] Host-auth work is in ONE commit; typecheck + `test:all` pass on that commit.
- [ ] `MIGRATION-FINALIZATION.md` no longer says "seven" for the run chain (it lists nine runs v1–v9), the "R. 2025-06" date is fixed, and "carter calls" is fixed.
- [ ] Repo root contains no `MIGRATION-*` / `TAKEOVER-*` files; they live in `migration/` (NOT `docs/` — `docs/` is gitignored).
- [ ] `migration/README.md` exists: a short (≤60 lines) status page linking the key docs.
- [ ] All links in `README.md` and inside the moved docs still resolve; scripts that write/read `MIGRATION-BROWSER-*.json` use the new path.
- [ ] `ROADMAP.md` reflects actual state.
- [ ] Draft PR open against `master`; URL recorded in the log.
- [ ] Scratch dirs listed in step 4 are deleted; `fixtures/` untouched except intentional commits.

## Environment (required for every test command)
```
cd /home/bahman/github/dsh-self-improved
export DSH_RUNTIME_RC2=/home/bahman/github/dsh-v0.2
```
- Typecheck: `node scripts/typecheck-v02.mjs` (must print `PASSED`).
- Core tests: run each of these and require exit 0:
  `test-phase-a test-storage test-redact test-episodes test-episode-review test-episode-rollout test-extract test-recall test-evolve test-commands test-hermes test-audit-skills test-settings-ui test-v02-continuity-worker test-v02-continuity-owner test-v02-continuity-runtime-v03`
  e.g. `for s in ...; do node scripts/$s.mjs >/dev/null 2>&1; echo "$s $?"; done`
- Do NOT run `scripts/test-migration-acceptance.mjs` (full sweep; project rule says not to).

## Git rules (from the user's CLAUDE.md — mandatory)
- Author is the configured identity (Bahman Asheghi). **Do NOT add `Co-Authored-By` or any AI attribution** to commits or the PR body.
- Never `git add -A` blindly before checking `git status`; never commit anything under ignored paths (`.tmp-*`, `.bt-*`, `.diag*`, `docs/`, `fixtures/skill-measurement/real-host/`).
- No force-push, no rebase, no amending existing commits.

## Steps

### Part 1 — commit host-auth work + fix finalization doc
- [x] 1.1 Run `git status --short` and record the counts in the log.
- [x] 1.2 Edit `MIGRATION-FINALIZATION.md` (still at root at this point):
  - line ~10: "seven attempted amendments" → "nine attempted runs (v1–v9)" (keep the rest of the sentence).
  - line ~36: "R. 2025-06 explicit directive from the user" → "Recorded 2026-10-15 by explicit user directive" ; and "the seven-attempt chain above" → "the nine-run chain above".
  - line ~10: "carter calls/usage" → "provider calls/usage".
  - `grep -n "seven" MIGRATION-FINALIZATION.md` afterwards; only the unrelated "all seven variants" (main-worker variants) may remain.
- [x] 1.3 Run typecheck. Must pass.
- [x] 1.4 Run the core test list. All must exit 0. If any fails: STOP, set status `blocked`, log the failing suite and last 20 lines of output.
- [x] 1.5 `git add` all modified tracked files, all untracked `scripts/*.mjs`/`scripts/*.json`, `src/continuity-host-auth-v02.ts`, the untracked `MIGRATION-*.md`/`.json` files, and `fixtures/migration-acceptance/run-*/`. Check `git status --short` shows nothing untracked left except `plans/` (add `plans/finalize-v02-cleanup.md` too).
- [x] 1.6 Commit: `feat(continuity): require Host-authenticated admission for capture and Continue` with a short body (3–6 lines): fails closed without the Host receipt verifier; adds auth/browser/learned-procedure harness scripts; preserves acceptance run fixtures; fixes finalization doc run count and date. No attribution trailer.

### Part 3 — consolidate docs, roadmap, draft PR
- [ ] 3.1 `mkdir migration` and `git mv` every root `MIGRATION-*` file (both `.md` and `.json`) and every `TAKEOVER-*.md` into `migration/`. Verify `ls MIGRATION-* TAKEOVER-* 2>/dev/null` prints nothing.
- [ ] 3.2 Fix links: `grep -n "MIGRATION-\|TAKEOVER-" README.md ROADMAP.md TROUBLESHOOTING.md` and rewrite relative links to `migration/<file>`. Inside `migration/*.md`, links between migration docs keep working (same folder) — but links to root files (e.g. `README.md`, `src/...`, `scripts/...`, `fixtures/...`) need a `../` prefix. Grep for `](` and `](<` link targets that point to non-migration paths and fix them. Don't rewrite prose mentions that aren't links.
- [ ] 3.3 Update paths in scripts that write/read the browser report files:
  - `scripts/run-v02-browser.mjs`: `MIGRATION-BROWSER-ENVIRONMENT.json` → `migration/MIGRATION-BROWSER-ENVIRONMENT.json` (and any other `MIGRATION-BROWSER-*` it writes; grep the file).
  - `scripts/test-v02-browser.mjs` line ~12: default `'MIGRATION-BROWSER-REPORT.json'` → `'migration/MIGRATION-BROWSER-REPORT.json'`.
  - `grep -rn "MIGRATION-BROWSER\|join(root, *'MIGRATION\|resolve('MIGRATION" scripts` for any other file-path usage and update it. Plain-string mentions in log messages/comments (e.g. in `test-v02-package.mjs`, `src/*.ts`) may stay as-is.
- [ ] 3.4 Write `migration/README.md` (≤60 lines): what the v0.2 migration is; a status table (Phases A–D accepted in isolation; Phase C auth boundary passes only on a privately staged Host-auth runtime — stock rc.2 runs with continuity disabled/fail-closed; Phase E real-learning gate recorded UNMET by user decision after nine OpenCode Go runs; live deployment not executed); "start here" links to `MIGRATION-V0.2.md`, `MIGRATION-FINALIZATION.md`, `MIGRATION-LIVE-ENABLEMENT.md`, `MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md`, `MIGRATION-PHASE-E-REAL-EVALUATION.md`, `MIGRATION-PROGRESS.md` (note it is a long historical log); one line saying the other files are per-phase evidence records. Plain, factual tone — no hedging walls.
- [ ] 3.5 Add a link to `migration/README.md` from the root `README.md` (one line, in a sensible spot near the end, e.g. a "v0.2 migration status" line).
- [ ] 3.6 Rewrite `ROADMAP.md`:
  - Shipped: keep existing list; add episode Phase 6 controls (`/memory episodes …` dry-review/purge/forget, `/memory skill-drafts` — README documents them as present) and the v0.2 port (rc.2 typecheck, journal/import, continuity lane fail-closed behind Host auth, durable skill activation, manual only).
  - Next: (a) decide how continuity ships — upstream Host-authenticated admission to DSH vs. release memory-only with continuity disabled; (b) approved live-enablement cutover per `migration/MIGRATION-LIVE-ENABLEMENT.md`; (c) Phase E: training-evidence redesign only if revisited (gate recorded unmet).
  - Keep it short (≤30 lines).
- [ ] 3.7 Re-run typecheck + core test list + `node scripts/test-v02-package.mjs` (report its summary line; if it fails only because of a path you moved, fix the path; otherwise log and continue).
- [ ] 3.8 Commit: `docs: move migration records into migration/ with a status page; refresh roadmap`. No attribution.
- [ ] 3.9 `git push -u origin migration/deepseek-harness-v0.2`.
- [ ] 3.10 `gh pr create --draft --base master --head migration/deepseek-harness-v0.2 --title "DSH v0.2 port: rc.2 runtime, journal import, continuity (Host-auth gated), skill activation"` with a body of ≤25 lines: summary bullets; status (link `migration/README.md`); blockers: continuity requires Host-authenticated admission not present in stock rc.2, Phase E unmet, live cutover not executed; testing: typecheck + listed suites pass. No "Generated with" line, no attribution. Record the PR URL in the log.

### Part 4 — prune local ignored scratch
- [ ] 4.1 Confirm each target is gitignored or untracked: `git check-ignore -v <path>` for dirs; `git ls-files <path>` must print nothing for each.
- [ ] 4.2 Record `du -sh` of each target in the log, then delete:
  `.tmp-import-lane .tmp-gatefix-backup .diag .diag-list-1.json .diag-list-2.json .diag-list-3.json .bt-3582f6 .bt-bc8056 scratch-review boot.log`
  — only those whose `git ls-files` output was empty. If `scratch-review` or `boot.log` turn out to be tracked, skip them and log it.
- [ ] 4.3 Do NOT delete: `docs/`, `fixtures/` (including `fixtures/skill-measurement/real-host/`), `migration-baseline/`, `node_modules/`, `lib/`, `tools/`.
- [ ] 4.4 Final `git status --short` must be clean. Log total disk reclaimed.

## Notes / decisions
- Folder is `migration/`, not `docs/migration/`, because `docs/` is gitignored (private local notes).
- `fixtures/migration-acceptance/run-*` are small (≤100 KB each) evidence records referenced by the finalization doc — commit them.
- Doc-reference strings inside source comments/log messages (e.g. `src/index.ts`, `src/commands.ts`) are left as-is; they're names, not paths.
- Docs inside `migration/` may cite `.tmp-import-lane/...` fixture paths that step 4 deletes; that's accepted — those were scratch and the run receipts live in `fixtures/migration-acceptance/`.

## Progress log
- 2026-10-17 — plan created
- 2026-10-17 12:17 — execution started
- 2026-10-17 12:18 — 1.1 status: 23 tracked modified, 55 untracked (plus plans/), 0 staged before start
- 2026-10-17 12:18 — 1.2 finalization doc fixed (seven→nine runs v1–v9, date 2026-10-15, carter→provider)
- 2026-10-17 12:18 — 1.3 typecheck PASSED; 1.4 core suites all exit 0 (test:all not run here; core list per plan)
- 2026-10-17 12:18 — 1.5/1.6 committed 035b979 feat(continuity): require Host-authenticated admission for capture and Continue (78 files; no forbidden paths; secret-pattern scan clean)
- 2026-10-17 12:20 — 3.1 moved 74 MIGRATION-*/TAKEOVER-* files to migration/ with git mv; 3.2 rewrote 384 root-relative links in 45 moved docs to ../ (link checker: 0 broken); fixed README links and Docs list
- 2026-10-17 12:20 — 3.3 updated run-v02-browser.mjs (env json) and test-v02-browser.mjs (default report) to migration/ paths
- 2026-10-17 12:20 — 3.4/3.5 wrote migration/README.md; added link line in README Docs section
- 2026-10-17 12:20 — 3.6 rewrote ROADMAP.md (18 lines)
- 2026-10-17 12:20 — 3.7 typecheck PASSED; 16 core suites exit 0. test-v02-package.mjs: STRICT 58 PASS / 1 FAIL. The failing check is C6 (undocumented machine-default site reference): new scripts test-learned-procedure-executor.mjs and test-learned-procedure-go.mjs contain /home/bahman/github/dsh-v0.2 and are not in the documented list. Not a moved-path issue; per plan logged and continued. Not fixed here (would require script/doc edit outside plan scope). Its regenerated fixtures/v02-package/last-suite-pin.json was reverted (not committed).
