# fixtures/v02-package — Phase A package-artifact / build-portability evidence

Durable evidence directory for the packaging gate. Generated and owned by the
package-worker lane (scripts/test-v02-package.mjs + scripts/typecheck-v02.mjs).
Nothing here is a registry-install proof: the harness uses read-only symlink
links to the exactly-rc.2 peer tree and real `npm pack` runs with real prepare
scripts — explicitly NOT install-script evidence.

- `last-suite-run.log` — full PASS/FAIL line list of the latest suite run.
- `last-suite-pin.json` — structured pins (suite id, node, peer mode/root,
  harness statement, strict pass/fail counts).
- `temp/` — unique per-suite staging roots (`suite-*`); removed at suite exit.
  Stale roots older than 12 h are swept by the next run's start (crash safety).

Cases covered (C1–C9) are documented in `MIGRATION-PACKAGE-TESTS.md` at the
repository root.

The coordinator test site `/home/bahman/github/dsh-v0.2` appears only as the
documented deliberate default peer source (read-only, validated exact rc.2);
`DSH_RUNTIME_RC2` overrides it (fail closed when explicitly invalid),
`DSH_V02_NO_TEST_SITE=1` disables the fallback for self-sufficient machines.
