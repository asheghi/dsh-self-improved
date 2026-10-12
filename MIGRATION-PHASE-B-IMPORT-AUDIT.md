# MIGRATION-PHASE-B-IMPORT-AUDIT.md — independent import-lane security/correctness audit (Worker-31)

Status: **audit executed on real runs; two owned files only (this report + [scripts/test-v02-import-audit.mjs](<scripts/test-v02-import-audit.mjs>)). No src/CLI/storage/index/journal/client/manifest, Git, profile, network, dependency, exemption or skill activation of any kind; no other lane's file touched, no other lane's claimed result waived.**

Audit target: the Phase B import lane ([src/import-v02.ts](<src/import-v02.ts>), [scripts/import-v02.mjs](<scripts/import-v02.mjs>), [MIGRATION-PHASE-B-IMPORT.md](<MIGRATION-PHASE-B-IMPORT.md>)) against its requirements ([MIGRATION-PHASE-B-IMPORT-DESIGN.md](<MIGRATION-PHASE-B-IMPORT-DESIGN.md>), [MIGRATION-PHASE-B-IMPORT-SEAM.md](<MIGRATION-PHASE-B-IMPORT-SEAM.md>), [MIGRATION-IMPORT-PRIVACY.md](<MIGRATION-IMPORT-PRIVACY.md>)). Every check below is an actual run (real `node:sqlite`, real CLI subprocesses with the strict tsc type-gate, real SIGKILL workers, one real race harness), all on newly synthetic fixtures built exclusively under a uniquely owned `/tmp/dsi-w31-import-audit-*` tree. Nothing was read from any profile (`.diag/**` untouched), no port/3082 interaction (static scan only), production store never named.

## 1. Independent verification of the claimed suite

`node scripts/test-v02-import-lane.mjs` was re-run in this session before any of my own tests: **93 passed, 0 failed** — reproduced exactly, on synthetic fixtures under the repo's own `.tmp-import-lane` scratch. I do not waive or re-score it; the numbers below are additive.

## 2. My own adversarial suite — exact result

`node scripts/test-v02-import-audit.mjs` → **74 passed, 0 failed** (exit 0; self-cleaning temp tree; two entries intentionally record *observed gaps* as characterized behavior — see F-2, F-5). Coverage: golden plan→apply chain; raw-SQLite canary probe of the operational target; manifest re-verification + restore fidelity without and **with a live WAL writer holding an open connection with WAL-only rows** (restored copied backup opens standalone with the full row set); a *mid-apply drift race* (writer commits between chunk commits → completion refused, receipt denied, watermark retained, later resume refused); plan under an uncommitted writer transaction + commit-after-plan refusal pre-write; symlink/containment refusals; **forged self-consistent plan + self-derived approval token accepted end-to-end**; transplanted destination re-apply; SIGKILL at `backup:before-manifest` / `backup:before-rename` + owned-debris sweep + resume; zero-coverage crash + explicit `--resume`; exactly-once + byte-identical ledger determinism across two destinations; hygiene statics.

## 3. Prioritized findings

### F-1 — PRIVACY CLAIM BLOCKER (must be resolved before any guarantee is emitted): quarantined credential rows survive VERBATIM in the operational `normalized/` target — quarantine is not absence

Independently confirmed by raw read-only SQLite plus a raw byte scan of `normalized/memory.db` (my suite P1): the credential-shaped row exists exactly as source content (`id/type/status='quarantined'`, content byte-identical) **in the operational target**, not only in `backup/`. The fail-closed mechanics themselves verified: quarantined rows are excluded from `memories_fts` and never injectable (P1), and the seam only reactivates explicitly via `setMemoryStatus` ([MIGRATION-PHASE-B-IMPORT-SEAM.md](<MIGRATION-PHASE-B-IMPORT-SEAM.md>) §3).

The defect is the **claim layer, and it is contradicting both the design and itself**:

- Design §4 says the demoted row is "still present, fail-closed"; design §8 says the minimization means the credential "does not survive as active authority … **verbatim copy remaining only in the backup**". These are not the same contract; the implementation followed §4, so §8's "only in the backup" is factually false.
- The implementation asserts the false wording about itself: [src/import-v02.ts](<src/import-v02.ts>)‹47–56› ("row preserved … verbatim copy only in the backup") and [MIGRATION-PHASE-B-IMPORT.md](<MIGRATION-PHASE-B-IMPORT.md>) §3 ("verbatim copy in the backup only"). A row preserved *with content* in `normalized/` **is** a verbatim copy in an operational artifact.
- Operational consequences, honestly bounded: `normalized/` is the artifact meant for future cutover. With the credentials still inside, cutover would carry the raw secrets into the operational store (dormant, FTS-excluded, but present). The lane's report correctly forbids treating artifacts as "importable/reviewable instead of restore-grade", and the code consistently relies on status-gating — but downstream readers who take "quarantined" as "removed" will materially over-trust the operational target.

Correct statement (no unsupported privacy guarantee may be emitted): **"credential-shaped memory content remains byte-verbatim in the operational `normalized/` target, demoted to `status='quarantined'`, excluded from FTS/inject, not acknowledged; a second verbatim copy also exists in `backup/`."** Either the doc/comments (incl. receipt strings if any assert the contrary) must be corrected, or the coordinator must decide whether the extra minimization (content redaction in `normalized/`, breaking the verbatim-rows contract at exactly the credential rows) is wanted. Code locations: demotion at src/import-v02.ts‹1166–1168› and apply-time status override ‹1945›; the contradictory comment ‹47–56›; the lane test that asserts the observed behavior scripts/test-v02-import-lane.mjs‹361–363›.

### F-2 — Approval binding does not bind anything (demonstrated end-to-end): design §10's token file was never implemented and the deviation is undocumented

`applyImportPlan` Gate 1 compares `--approve` only against `plan.approvalToken` **stored inside the very plan.json being approved** (src/import-v02.ts‹1754›), and Gate 2 re-computes the plan digest over that same document minus the two token fields (‹1767–1769›). The token is derived from `sha256(planDigest :: memoryDbSha :: treeDigest :: destRoot)` (‹1413›) — all values readable from plan.json itself. I forged a *self-consistent* plan (mutated verdicts, recomputed `planDigest`, self-derived `approvalToken`) through the real CLI:

1. An originally **unsupported-evidenced** row (`importance=42` → excluded by the honest plan) was pulled back into `accepted`; the apply **succeeded (exit 0)** and the row landed in the operational target with importance **silently clamped to 10** by the seam ([src/storage.ts](<src/storage.ts>)‹759›) — an accounting row the plan's own receipt vocabulary says can never survive the seam, imported anyway with every post-gate green.
2. Symmetrically, a forged plan **silently excluded** a previously accepted row; reconciliation "passed" and the receipt stayed all-green — a silent loss.

Root cause: design §10 requires the fresh token file to *name sourceDigest + planDigest + target root* as an independent artifact verified at apply; the implementation instead prints the token and clips it into the single plan.json (scripts/import-v02.mjs‹349, 374–381›). The honest threat statement: **approval is only as strong as plan.json's integrity; anyone who can rewrite the destination's plan.json can also forge an approval for whatever verdict set they choose, and the token provides no independent binding to human intent.** With plan.json treated as trusted input the gates that remain valuable (source CAS, token-vs-doc equality, exactly-once) all held. Remedy: a wx-created token file in the destination written at plan time (contents + location independent of plan.json), verified at apply; or drop the "proof of human approval" phrasing and document plan.json as the trust anchor. Also note the silent importance clamp (storage.ts‹759›): the receipt's limits say importance out-of-range rows "cannot be written through the seam" — that is only true because the plan excludes them; the seam itself clamps.

### F-3 — MEDIUM: token is destination-bound at mint time only; transplanted destinations re-apply at a new path

The token embeds `destRoot` at **plan** time (src/import-v02.ts‹1413›), but apply never re-derives it against the **current** destination. I copied a planned destination to a new path and ran `import` with the mint-time token: the apply **fully materialized backup/normalized/receipt at the new path** (my suite P7). No privilege escalation (identical content, same source binding), but MIGRATION-PHASE-B-IMPORT.md §4.3's claim "the approval token is destination-bound" is mint-time-only. Fix or amend the claim.

### F-4 — MEDIUM: `plan` does not refuse a symlink inside the SOURCE tree (Phase A's source-side walk was not inherited; reads follow the link), refusals land late but fail-closed

`digestDirectory` silently skips symlinks ([src/migration-v02.ts](<src/migration-v02.ts>)‹461›), and the Phase B planner never re-invokes the Phase A source-side `refuseSymlinkedContent` walk (migration-v02.ts‹1554› is Phase A's orchestrator; the import lane covers only dest/skills/input roles, src/import-v02.ts‹273–314›). Observed end-to-end (my suite P5): `plan` **exits 0** over a source whose `conversations/evil.jsonl` is a symlink to a foreign file — the conversation auditor **follows** the link (`readFileSync`) and counts the linked file into plan counts (files=2). The overall lane still fails closed: the apply later refuses in the backup copier (`collectCopyFiles` lstat refusal, src/import-v02.ts‹1722–1724›), writing **zero memory rows and no receipt**. Net: safety preserved, honesty/lateness defect — the plan stage reads outside-tree content by counting it, and a plan's blessed counts can't all survive the apply. Remedy: call `refuseSymlinkedContent(sourceRoot)` in `buildImportPlan` (and at apply re-check).

### F-5 — LOW: crash at the backup-lane boundary leaves more debris than the code comment admits (all inert, all swept on resume)

SIGKILL at `backup:before-manifest`/`backup:before-rename` (real workers) leaves: the owner-marked `wip-backup-*` temp, an **initialized but row-empty normalized store** (MemoryStore already opened and schema-created before the backup lane), and potentially an orphaned `dsi-v02-import-snap-*` tmpdir (guardedRmSnapshot cannot run on SIGKILL). All verified inert; the explicit `--resume` sweeps exactly the owned debris (marker-checked) and completes with full reconciliation. The comment at src/import-v02.ts‹1677› ("leaves an inert owner-marked temp dir only") should mention the row-empty normalized store and possible tmp snapshot leftover for honesty.

### F-6 — INFO (validated, no defect): WAL/snapshot consistency claims held under every probe

- Plan succeeds over an uncommitted writer transaction with the invisible row excluded (consistent-snapshot semantics, my P4); committing that row after plan → apply refuses **pre-write** on the digest/WAL gate with zero artifacts.
- Mid-apply writer commit → caught at the post-write boundary (completion refused, receipt denied, same-tx watermark retained). Reproduced on the first attempt with a widened race window.
- WAL-only row (main-file bytes unchanged, writer connected): plan's VACUUM INTO snapshot saw it; backup captured it; copied restore opens standalone with the complete source row set; MANIFEST verified.
- Source stable-file set unchanged by plan+apply; only documented `-shm`/`-wal` companions may appear.

## 4. Independently verified as good (highlights, all actual runs)

Read-only source contract + pre/post digests; bounded JSON (zero canaries in plan/ledger/receipt and both stages' stdout/stderr in my suite, on top of the lane suite's assertions); manifest re-verification and restore fidelity; exactly-once receipt lifecycle + byte-identical ledger determinism; SIGKILL oracles (mid-chunk, final-tx, post-ledger, backup-lane) and the zero-coverage resume contract; unsupported-never-ack (`extract_state` empty, unsupported rows absent, coordinates+reasons only); quarantined rows FTS-excluded; preserved verbatim identity (row-by-row source-vs-target tuple equality); owner-marker/foreign-watermark/collision refusals before any write; no network/3082/profile references in engine+CLI; every CLI invocation passes the isolated strict type-gate (exit != 0 would have failed the suite).

## 5. Tested limits (not claimed beyond these)

- **No privacy conclusion beyond F-1's wording.** This audit makes no "secrets are gone" claim anywhere; the backup is by design secret-bearing and the credential content is also in `normalized/`.
- F-2's forge requires write access to the destination tree (same capability as directly running the tool); I did not attack plan.json in transit elsewhere.
- The race harness exercised a single-commit writer between chunk boundaries (first-attempt success with a 400-row window); sustained/interleaved multi-writer races, and contention during `VACUUM INTO` with *checkpointing* writers, were not explored.
- Symlink probing covered dest components, source content (conversations sidecar), --report paths, dest==source; symlinked `memory.db` itself ( bytesRead via statSync-based flows) was not separately probed.
- The 50k-row scale cap, encrypted/permissioned backup handling beyond the 0700 chmod attempt (not asserted in my suite), and any multi-host concurrency were **not** tested (~6-row probe stores).
- Static hygiene scan only for network/3082/profile references; no runtime socket observation.
- All data synthetic under an owned `/tmp` audit tree, removed afterwards; the repo-relative `.tmp-import-lane/*/dest` scratch left by the lane's own suite (marker+plan.json of deleted synthetic fixtures) is lane-owned scratch and was left as found.
