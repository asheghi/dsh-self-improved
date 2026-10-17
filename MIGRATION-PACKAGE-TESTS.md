# MIGRATION-PACKAGE-TESTS.md — Phase A package-artifact / build-portability gate

> **Post-hardening addendum (Workflow-15).** The wrapper's no-toolchain behavior
> described below was hardened afterwards: `build`/`typecheck:v02`/no-flags now
> fail closed without a compiler (a shipped prebuilt lib is never strict
> evidence), artifact verification requires the explicit `--allow-prebuilt`
> opt-in (kept on the manifest `prepare` only), and even the opted-in path
> refuses an explicitly invalid `DSH_RUNTIME_RC2`, an empty or
> non-exactly-pinable `@deepseek-ai` peer set, and an incomplete artifact. C8
> was rewritten accordingly (direct explicit verification + genuine npm-run
> prepare, honest labels) and a standalone staged-artifact suite was added
> (`scripts/test-v02-typecheck-modes.mjs`). Latest counts: package suite
> **59 PASS / 0 FAIL**, modes suite **21 PASS / 0 FAIL**. Full details and
> attribution: `MIGRATION-PACKAGE-REVIEW.md`.

Status: executed. Package-worker lane. Owned files this lane wrote: NEW
`scripts/test-v02-package.mjs`, NEW `fixtures/v02-package/README.md`, NEW
`fixtures/v02-package/{last-suite-pin.json,last-suite-run.log}`,
REWRITTEN `scripts/typecheck-v02.mjs`, narrow README build/install paragraph.
No `package.json` edit (coordinator-owned manifest): recommendations only. No
registry install, no active-profile change, no dependency patch, no
compatibility exemption, no Git writes, no host-source changes.

## Confirmed pre-fix portability gap (now closed)

`npm pack`/`install` run the manifest `prepare` script, which (pre-fix)
unconditionally defaulted to the coordinator's machine-local test site
`/home/bahman/github/dsh-v0.2` and exited 2 when its
`node_modules/@deepseek-ai` was absent — so a fresh git/package build on any
other machine failed even with the correct rc.2 peers installed. Additional
pre-fix defects found and fixed here:

1. **mkdtemp parent leak**: the old cleanup removed only `<tmp>/dsi-typecheck-v02-X/check`,
   leaving behind the unique parent every single run (verified: a leftover
   `/tmp/dsi-typecheck-v02-*` root existed after a passing run).
2. **`--emit-lib` could not purge stale build output** (post-fix: guarded full
   replacement of `<repoRoot>/lib`, realpath-verified to be the repo's build
   directory; rejects symlinks).
3. **Consumer-install prepare crash**: packed tarballs ship prebuilt `lib`
   because devDependencies (typescript) are NOT installed for consumers. The
   old wrapper crashed there (no toolchain, no rc.2 tree) and would have broken
   `npm install` of the artifact.

## What the new wrapper contract is (scripts/typecheck-v02.mjs)

Peer source resolution (read-only against every source; never modifies any):

1. `DSH_RUNTIME_RC2` explicit override — must contain a
   `node_modules/@deepseek-ai` set matching `package.json` peerDependencies
   **exactly** (coordinator pins cordis@4.0.4, cordis-plugin-loader@1.0.5,
   cosmokit@1.8.5, schemastery@3.18.4, dsh-typert-protocol@0.2.0-rc.2 plus all
   dsh-* contracts at exactly 0.2.0-rc.2). Explicitly set but invalid → **fail
   closed (exit 2)**, never falls back.
2. Local declared peers `<repoRoot>/node_modules/@deepseek-ai` with the same
   exact validation — the machine-portable path; a checkout with correct peers
   builds anywhere. Legacy rc.6/rc.8/cordis-4.0.2 trees are rejected
   (never silently used), then:
3. The documented coordinator test site `/home/bahman/github/dsh-v0.2` — used
   deliberately (its every use is told in the output) only when no override is
   set, the local tree does not have a valid exact set, and
   `DSH_V02_NO_TEST_SITE=1` is not set. That switch exists for
   self-sufficient/offline builds (CI-style), making the missing-site failure
   explicit and actionable.

Modes: developer build (toolchain present) compiles a throwaway guarded
scratch tree against the exactly validated set and, with `--emit-lib`,
replaces the repo's gitignored `lib/` (map-free output — stale maps of older
builds are therefore purged). Consumer/artifact prepare (no toolchain) is the
packed-artifact install path: verified shipped lib + manifest entry points +
`dsh.bundle.patch`, exit 0 with an explicit NOTICE that the strict rc.2
compile was **not** run there (its evidence is the source build and this
suite); no toolchain plus no lib is an actionable exit 2 (no fake pass).
Temp hygiene: on exit (and SIGINT/SIGTERM/crash hooks) BOTH the check tree and
the unique mkdtemp parent are removed, realpath-ownership-verified.
`--print-resolution` emits the resolution decision as JSON for other tooling.

## Test suite: scripts/test-v02-package.mjs

Run: `node scripts/test-v02-package.mjs` (~30 s). Durable evidence:
`fixtures/v02-package/last-suite-run.log`, `last-suite-pin.json`. Latest
result: **STRICT 54 PASS / 0 FAIL** (node v24.13.1, npm 11.8.0).

- **C1 manifest ↔ imports** — every `@deepseek-ai/*` imported by `src`
  (15 packages + the client/patch surfaces) is a declared peer; all 17 peers
  resolve at exact manifest versions on this machine (test-site default mode,
  named as deliberate); 15 = 17 − {@dsh-skill, @dsh-storage-domain} noted
  below.
- **C2 portable local-peer build (offline symlink harness)** — a tree whose
  `node_modules/@deepseek-ai` holds rc.2 links and whose `.bin/tsc` is a real
  package-manager-shaped shim builds with `DSH_V02_NO_TEST_SITE=1`, mode
  `local-declared-peers`, emits a map-free `lib` untouched by the test site;
  **this is the fresh-machine path and it requires no coordinator site**.
- **C3 fail-closed legacy** — a tree containing only the legacy repo peers
  (cordis@4.0.2, dsh-*@0.1.0-rc.6/rc.8) exits 2 with the exact
  "does not match the manifest-required" mismatch lines and emits no lib.
- **C4 explicit override** — invalid `DSH_RUNTIME_RC2` fails closed even from
  an otherwise-valid tree; a valid override wins and passes strictly.
- **C5 repo `npm pack` (real scripts run, real prepare)** — succeeds; its
  prepare build runs in the documented test-site default mode on this machine
  and rebuilds the gitignored `lib/`; the tarball lands in the owned temp dir
  (repo root clean).
- **C6 staged pristine `npm pack` (NO network install; offline dev harness)** —
  prepare runs the full strict rc.2 build in the stage; packed file list (94
  files) stays inside the manifest `files` surface; requires all ship
  (including `lib/index.js`, `lib/index.d.ts`, `client.js`, `cordis.patch.yml`,
  `tsconfig.json`, docs, `scripts/typecheck-v02.mjs`); **no
  node_modules/fixtures/scratch-review/.diag/\*.map/junk**; every emitted
  `lib` relative import resolves inside `lib/` (19-module chain, no dangling);
  **no external absolute paths** embedded in `lib`/`src`/`client.js`/
  `cordis.patch.yml`/`package.json`/`tsconfig.json`; manifest exports/`main`/
  `types`/`dsh.bundle.patch` targets all exist; packaged manifest is
  byte-identical to the repo manifest.
- **C7 extracted-artifact runtime harness (SYMBOLIC, NOT install evidence)** —
  extracted tarball mounted by symlinked rc.2 peers + plugin runtime deps
  (`sqlite-vec`, `@node-rs/jieba`); `import("dsh-self-improved")` loads and
  keeps the exported Cordis plugin surface (`name="self-improved"` — matches
  `src/index.ts`; the bundle row id `dsh-self-improved` in `cordis.patch.yml`
  is the loader entry, unchanged); `…/client` subpath export resolves to the
  shipped `client.js`. This proves packaged-runtime integrity under an offline
  peer harness; it is deliberately **not** claimed as an installer/registry
  test.
- **C8 consumer/artifact prepare lifecycle** — in the extracted artifact with
  no toolchain: shipped lib verified, exit 0, NOTICE lines present, no PASSED
  claim; second run idempotent (lib hash unchanged); with `lib/index.js`
  removed: actionable exit 2 naming the missing prerequisites.
- **C9 temp hygiene** — no `dsi-typecheck-v02-*` root left under `os.tmpdir()`
  after each wrapper run (parent-leak fix proven), repo root gains no stray
  tarball, and the suite's own unique temp root is fully removed (fs at exit).

## Finalization harness machine-site references

The C6 inventory additionally includes `scripts/run-v02-auth-runtime-candidate.mjs` and `scripts/start-learned-procedure-host.mjs`:

- The auth candidate runner contains the existing mounted fixture's exact installed-runtime declaration as a **checked source-replacement anchor**. It does not launch that installation: `DSH_AUTH_CANDIDATE_RUNTIME` must resolve to an ownership-marked workspace copy, and that explicit candidate replaces the anchor before execution.
- The real-learning bootstrap retains the coordinator installation as its explicit read-only package source default. `DSI_EVALUATION_RUNTIME` selects an ownership-scoped workspace candidate instead; current evaluation uses that candidate. This is isolated migration tooling, not a portable consumer runtime default or a claim that the local site exists on other machines.

These references are inventoried intentionally; no absolute coordinator path is permitted in the plugin's runtime/source/client/manifest/patch payload by C6. New script references still require individual documentation and review. The first finalization packaging run reported these missing inventory entries as a failure; it is not retroactively relabelled a pass.

## Honest limitations

- No `npm install … @registry` was performed (offline mandate). Downstream
  `npm install` behavior was simulated by manifest-level verification (prepare
  + peer auto-install semantics come from npm's documented behavior) plus the
  C6–C8 harnesses; the coordinator can optionally do ONE trial install in a
  disposable design environment when network installation is authorized.
- C5/C6 rely on a writable `npm_config_cache` — inside this sandbox `$HOME`
  was read-only, so the suite gives pack children a workspace-local cache
  (`<suite>/npm-cache`). On normal machines no special env is needed.
- The "missing coordinator site" failure path (local invalid + site absent)
  is exercisable here only through the documented `DSH_V02_NO_TEST_SITE=1`
  switch (C3); the same code path covers a site-absent machine naturally.
- Suite strictness assumes the current manifest peer set; if the coordinator
  edits pins, C1 re-derives everything from `package.json` (no second copy
  of the list in the wrapper).

## Manifest recommendations (coordinator-owned package.json — NOT edited)

1. **Peer hygiene — dsh-skill, dsh-storage-domain are declared but never
   imported by src (C1).** Both then install for every consumer (npm ≥7
   auto-installs peerDependencies) without being contract-used. Either drop
   them from `peerDependencies`, or import their rc.2 type augmentations if a
   Phase B contract needs them. (Deliberately kept while unused: harness-safe,
   merely an install surface.)
2. **Keep `build`/`prepare`/`typecheck:v02` exactly as they are** — they now
   cover three real contexts (dev strict build, portable local-peer build,
   consumer artifact prepare) without script changes. Adding
   `scripts/test-v02-package.mjs` to a `test` entry (e.g. `test:package`) is
   optional and coordinator's call; nothing depends on it.
3. **files list is currently truthful** (C6 file-list surface assertion): lib,
   src, scripts, tsconfig.json, client.js, cordis.patch.yml, LICENSE, README,
   ROADMAP, TROUBLESHOOTING — keep as is. If a future build re-emits maps from
   the repo tsconfig (it has `sourceMap`/`declarationMap` on), excluding
   `"lib/**/*.map"` would keep the artifact site-path-free.
4. **Shipped ops scripts with machine defaults (surface finding, script owner
   decides)**: `scripts/validate-episode-rollout.mjs` ships in the artifact
   with undocumented legacy default `/home/bahman/github/dsh/node_modules`
   (line 58) — not the rc.2 site. Recommendation: default to error-when-absent
   or reuse the documented `DSH_RUNTIME_RC2` convention. Also ring scripts
   `test-v02-runtime.mjs`, `test-v02-settings.mjs`,
   `test-v02-shutdown-safety.mjs`, `test-v02-mounted-ui.mjs`,
   `test-v02-policy-lane.mjs`, and `test-v02-remote-cancellation.mjs`
   document the site default (aligned
   convention, fine to ship). The strict no-abs-path gate covers runtime
   payload only (lib/src/manifest/patch — all clean, proven).
5. **engines.node >=22.16.0** matches the `node:sqlite` + sqlite-vec runtime
   floor; keep. Node 24.13.1 used for the full suite here.

## Rollback/ownership note

Only `scripts/typecheck-v02.mjs` was rewritten and `scripts/test-v02-package.mjs` /
`fixtures/v02-package/*` created by this lane; repo `lib/` was refreshed by
the suite's C5/C6 prepare runs (gitignored build output, map-free). No other
source/test/doc/Git edits. Pre-existing unrelated tree finding (not this
lane's file): `src/index.ts:1157` blank line at EOF (git diff --check).
