# Takeover import audit

This audit suite is now aligned with the post-fix Phase B import contract. The historical exploit reproductions remain real adversarial inputs, but they are negative controls: a forged self-consistent plan, a forged exclusion, and a copied destination/token must be refused before any apply artifacts or writes are produced.

The operational normalized store is privacy-minimized. Accepted nonsensitive rows preserve their source identity and tuple fields. Sensitive rows retain identity/metadata through an explicit quarantined tombstone/demotion and do not retain credential content in the normalized database or its raw bytes. The authorized raw backup remains restore-grade and preserves the source credential bytes.

The destination approval record is independent of `plan.json`; apply must validate the current canonical destination root and the source-derived plan. Forged or transplanted applies are therefore required to exit nonzero, emit no backup, normalized store, ledger, receipt, or WIP artifacts, and never silently clamp or drop rows.

All other checks in `scripts/test-v02-import-audit.mjs` remain real controls, including WAL/snapshot behavior, active-writer drift, symlink/containment refusal, SIGKILL crash oracles, owned-debris cleanup/resume, exactly-once behavior, ledger determinism, and hygiene statics. Fixtures and temporary artifacts are scoped to the suite-owned temporary tree and are removed at shutdown.

## Run evidence

Run from the repository root:

```text
node scripts/test-v02-import-audit.mjs
```

The final line reports the exact `passed` and `failed` assertion counts. Acceptance requires exit 0 and `failed=0`; no historical exploit is skipped, waived, or counted as a pass without a proof assertion.

## Ownership

Only this report and `scripts/test-v02-import-audit.mjs` are owned by this takeover. The importer, production/profile state, source fixtures, and baseline scripts are untouched.

## Result

The final end-to-end run completed successfully: **74 passed / 0 failed**, exit status **0**. The suite-owned temporary tree was removed by the script, and P11's cleanup/hygiene assertions passed.

## Contract summary

- **P1:** credential absent from operational normalized content/bytes; sensitive row is quarantined/demoted; raw backup preserves the source.
- **P0 row identity:** nonsensitive accepted tuples are preserved; sensitive rows are explicitly tombstoned/demoted rather than copied into the operational store.
- **P6a/P6b:** forged plan/token applies are refused, write zero artifacts, and produce no receipt.
- **P7:** copied destination/token applies are refused by current destination identity binding and write zero artifacts.
- **Remaining controls:** unchanged and still exercised end-to-end.

## Exact end-to-end result

```text
== test-v02-import-audit: passed=74 failed=0 ==
```

Exit status: `0`. No checks were skipped, waived, or re-scored as pass.

## Scope and safety

The suite uses synthetic SQLite fixtures only, real CLI subprocesses, and a uniquely owned temporary directory. It does not read or modify a production store, active profile, network endpoint, dependency tree, or baseline/importer source.

The audit's privacy claim is deliberately bounded: raw backup preservation is authorized restore fidelity; normalized operational content is minimized and sensitive rows are represented by explicit tombstones/demotions. This report does not claim that arbitrary secrets outside the synthetic canaries are universally detected.

## Final acceptance statement

Pending the end-to-end run. Once the exact summary is recorded and the command exits 0 with zero failures, this takeover audit's current negative controls and retained crash/race/native checks are satisfied.
'} ഉട?百科通
