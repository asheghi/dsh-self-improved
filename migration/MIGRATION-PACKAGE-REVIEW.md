# MIGRATION-PACKAGE-REVIEW.md — Workflow-15 post-hardening review of package-wrapper mode semantics

Status: executed and green. Scope: harden the strict-vs-artifact mode semantics
of `scripts/typecheck-v02.mjs` (Worker13's newly completed lane) after the
coordinator confirmed three source gaps, fix the evidence honestly, and add a
standalone staged-artifact regression suite. Everything here ran offline: no
registry install, no provider call, no live profile touched, no dependency
patch, no compatibility exemption, no Git writes/staging, no `package.json`
edit (root manifest is coordinator-owned).

## 1. Confirmed source gaps — verified, then fixed

1. **`PEERS.size === 0` guard could never fire.** `PEERS`
   (scripts/typecheck-v02.mjs) was built with `Object.fromEntries`, so it is a
   plain object: `.size` is `undefined` and the empty-peer-set guard never
   triggered. Fixed to `Object.keys(PEERS).length === 0` (proven by the new T4
   regression, where a staged manifest with `peerDependencies: {}` must exit 2).
2. **Absent-compiler branch exited 0 before strict validation.** The no-toolchain
   branch ran before explicit `DSH_RUNTIME_RC2` validation and ignored which
   mode was requested: `typecheck:v02`/`build`/no-flags with a shipped `lib/`
   exited 0 as "artifact verification" without compiling anything, and an
   explicitly invalid runtime override was accepted in that branch despite the
   advertised fail-closed policy. Both verified by reproducing them before the
   fix in a real staged artifact.
3. **Strict gate conflated with consumer `prepare`.** The old suite's C8 invoked
   the wrapper directly in no-flags mode and expected exit 0 as artifact
   "prepare" evidence. Rewritten (section 3).

## 2. New mode contract in scripts/typecheck-v02.mjs (guard changes)

- **`build` / `typecheck:v02` / default / no-flags are only ever the strict
  gate.** Without a TypeScript toolchain they fail closed (exit 2) for BOTH
  shapes — with and without a shipped prebuilt `lib` — and the refusal names
  the `--allow-prebuilt` opt-in and its consumer-install meaning honestly. A
  prebuilt artifact is never strict rc.2 evidence.
- **`--allow-prebuilt` is the only no-compiler path** (artifact verification).
  Even that opted-in path refuses (exit 2, no artifact verdict, no fallback):
  - an explicitly set but invalid `DSH_RUNTIME_RC2` (validated exactly against
    the artifact's own manifest peers, never falling through);
  - an empty `@deepseek-ai` peer set;
  - a peer range that cannot be pinned exactly (`*`, `>=4`, `1.x`, `a || b` —
    anything `requiredExact` cannot reduce to one exact version), because an
    exactly-equality verdict against such a range is meaningless. The current
    manifest is fully exact-shaped, so nothing changes for it;
  - a peer outside the validated `@deepseek-ai` scope (guard moved to the
    manifest header so it holds in every mode, including artifact verify);
  - an incomplete artifact (`lib/index.js`, `lib/index.d.ts`, `client.js`,
    `cordis.patch.yml`, main/types/exports/dsh.bundle.patch targets).
  On success it prints an explicit multi-line NOTICE — "NO strict rc.2 compile
  ran here and none is claimed", nothing emitted, strict evidence lives in the
  source build — and exits 0.
- **`--print-resolution` also fails closed** in a no-toolchain context without
  the opt-in (a peer-source resolution there would misreport the context).
- **`--emit-lib` is honest in the artifact context**: passes verification but
  prints that no build output was emitted because there was no compile.
- **`--allow-prebuilt` with a toolchain present is still a strict compile**
  (e.g. the staged-source `npm pack` in C6), and says so in one line.
- `--print-resolution` JSON gained `strictCompile` for tooling honesty; the
  artifact-context mode is now named `explicit-artifact-verification`.
- Developer normal compile behavior is unchanged (same scratch-tree build,
  same guarded `--emit-lib` replacement, same temp hygiene/cleanup hooks).

## 3. Evidence adjustments (honest labeling)

- **C8 rewritten** in `scripts/test-v02-package.mjs` — the strict/prepare
  conflation is gone. New split:
  1. *direct explicit artifact verification* (`node
     scripts/typecheck-v02.mjs --allow-prebuilt` in the real extracted
     tarball) — labeled everywhere as artifact evidence, **NOT** installer
     evidence;
  2. *genuine npm-script lifecycle prepare* (`npm run prepare` — npm's own
     runner executing the manifest's coordinator-pinned prepare command
     `--emit-lib --allow-prebuilt` inside the artifact; still no registry
     install; devDependencies absent by construction — exactly the consumer
     context).
  Plus: both print the no-strict-compile NOTICE and never claim PASSED; lib
  byte-identical after both (no emission without a compile); idempotent
  re-verification; **default/no-flags mode with a shipped lib now fails
  closed** (the former exit-0 conflation is asserted closed); opted-in
  verification with `lib/index.js` removed still exits 2 naming it.
- **NEW `scripts/test-v02-typecheck-modes.mjs`** — 21 standalone regressions
  (T1–T8 + hygiene) over REAL staged trees (`lib/`, metadata, and the wrapper
  itself real-copied, never symlinked). Three of the staged manifests are
  deliberately positive-broken T4/T5 fixtures owned by this suite inside its
  unique temp root (never the root manifest). Every assertion executes the
  real script as a subprocess — no helper-only assertions. Needs no toolchain,
  no coordinator test site, no peers, no network.

## 4. Results

- `node scripts/test-v02-package.mjs` → **STRICT 59 PASS / 0 FAIL** (node
  v24.13.1, npm 11.8.0; run twice, second run after the attribution fix).
  Durable: `fixtures/v02-package/last-suite-run.log` (61 lines),
  `last-suite-pin.json`.
- `node scripts/test-v02-typecheck-modes.mjs` → **STRICT 21 PASS / 0 FAIL**.
  Durable: `fixtures/v02-typecheck-modes/last-modes-run.log`,
  `last-modes-pin.json` (records the wrapper sha256, so engine changes are
  traceable).
- Hygiene verified after both: suite temp roots under each owned
  `fixtures/*/temp` fully removed, no `dsi-typecheck-v02-*` leftovers under
  `os.tmpdir()`, repo root gained no stray tarball.
- Original user peer values untouched: this lane neither reads nor writes any
  user-peer/runtime fixture (`migration-baseline/user-peer-values.json` and
  every runtime store are untouched; no live profiles).

### Pinned-build attribution (concurrent workers)

Other lanes were editing `src/` during this run (workflow14 lifecycle and
and12UI UI work: `src/migration-v02.ts`, `src/runtime-config.ts`,
`src/shutdown-v02.ts` appeared mid-session). The suite therefore records
`srcStateAtRun` durably in `last-suite-pin.json`; at the final run it was
`dirty: src/business.ts, src/capture.ts, src/commands.ts, src/index.ts,
src/migration-v02.ts, src/runtime-config.ts, src/shutdown-v02.ts,
src/tools.ts`. The strict build behind C5/C6 compiled exactly that state (and
strictly PASSED, so the in-flight tree type-checks) — build attribution is
that shared src state, not a single lane. Repo `lib/` was refreshed by those
prepare runs in that state (gitignored build output; map-free).

## 5. Manifest prepare change recommendation (root `package.json` — coordinator-owned, NOT edited by this lane)

1. **The coordinator's prepare edit is correct and is confirmed sufficient:**
   `"prepare": "node scripts/typecheck-v02.mjs --emit-lib --allow-prebuilt"`.
   In a packed artifact (no devDependencies → no toolchain) it performs the
   explicit, opt-in artifact verification; in a dev checkout (toolchain
   present) it still performs the real strict build — the wrapper prints
   `--allow-prebuilt noted: … this run performs a real strict rc.2 compile`.
   Keep it.
2. **Never copy `--allow-prebuilt` into `build` / `typecheck:v02`.** Those two
   must stay toolchain-only strict commands; this is now enforced and
   regression-tested in both suites.
3. **Do not** adopt the T4/T5 staged `peerDependencies: {}` / `"*"` fixtures on
   the root manifest — they exist only inside the modes suite's owned temp
   root to prove the refusal paths.
4. Carried findings from Worker13's doc remain valid and are not re-tested
   here: declared-but-unimported peers `@deepseek-ai/dsh-skill`,
   `@dsh-storage-domain` (C1 note, harmless install surface);
   `scripts/validate-episode-rollout.mjs` ships with an undocumented legacy
   `/home/bahman/github/dsh/node_modules` default (rename/rebase to the
   `DSH_RUNTIME_RC2` convention when its owner touches it); ring test scripts'
   documented site default is fine. `files` stays truthful (C6: 99 files
   inside the declared surface, packaged manifest byte-identical to root).

## 6. Limitations (honest)

- No `npm install`/registry/network operation was performed; "genuine npm
  prepare" means npm's script runner executing the manifest prepare command
  inside a real extracted artifact — not a downstream `pnpm install ‎--frozen`
  lifecycle in a consumer host, and not installer resolution evidence.
- The artifact verifications are labeled by their real nature: direct evidence
  (wrapper invoked with the explicit opt-in) or npm-run prepare evidence.
- The "missing coordinator site" failure path is exercised via
  `DSH_V02_NO_TEST_SITE=1` (C3), not by physically detaching the site.
- The strict no-compiler refusal message cannot enumerate *why* the toolchain
  is absent (partial install vs artifact context); it names both remedies.
- T4/T5 prove the guards for empty/nonexactly-pinable manifests in the staged
  artifact context (and the strict path for empty); a coordinator-side
  manifest lint could catch such shapes pre-pack, but that is a root-manifest
  tooling decision, not this lane's.

## 7. Ownership/rollback

Files owned/written by this lane: `scripts/typecheck-v02.mjs` (mode hardening),
`scripts/test-v02-package.mjs` (C8 rewrite + pin attribution), NEW
`scripts/test-v02-typecheck-modes.mjs`, NEW `fixtures/v02-typecheck-modes/*`,
refreshed `fixtures/v02-package/{last-suite-run.log,last-suite-pin.json}`,
narrowed README "Build and install portability contract" paragraph, this file,
and a short addendum in `MIGRATION-PACKAGE-TESTS.md`. No source file, no
client/importer/runtime fixture, no root-manifest change, no Git operation.
Nothing to roll back beyond restoring the pre-edit versions of the two scripts
and reverting the README paragraph.
