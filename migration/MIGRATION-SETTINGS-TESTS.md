# MIGRATION-SETTINGS-TESTS — Phase A settings/business boundary increment

Done by the Phase A implementation agent continuing workflow-3 (provider lane: user-directed), after reviewer commit `6297deb`. This file is the only deliverable added beyond source/tests listed below. It supersedes nothing and commits nothing: all changes are left as reviewable uncommitted work.

## Scope

Implements the Phase A remaining source/client boundaries that MIGRATION-PROGRESS.md and MIGRATION-COORDINATOR-REVIEW.md documented as open ("volatile Config", "typed authorized/cancellable business Remote", "current Client ConfigForms", "visible stale settings rejection"). No Phase C UX redesign; a maintainable module seam and mounting compatibility are what shipped.

## Source changes (all uncommitted, selectable per hunk)

### NEW `src/runtime-config.ts` — host config policy module

- Single site for FIELD classification: `FIELD_CLASSIFICATION` (everyday / advanced / init-only / secret / retired classes per dotted path), `INIT_ONLY_PATHS`.
- Typed helpers `isVolatileRef` (via shared `cosmokit.isVolatile`), `readValue`, `volatileSnapshot`.
- Documents the storage-root/nonvolatile trade-off: `storageRoot` is INIT-ONLY (a change must run the full restart lifecycle; never a live text-field write).

### `src/index.ts` — volatile Config + hot-apply lifecycle

- **Config schema explicitly volatile**: `enabled`, `debug`, `searchLimit`, `modules`, `extract`, `recall`, `consolidate`, `evolve`, `housekeeping`, `review`, `episodeLearning` are marked `.volatile()` (subtree granularity so every leaf under them is live-editable). `storageRoot` deliberately stays NONVOLATILE (restart, effect-owned drain). This replaces the previous "nonvolatile everywhere" decision record (MIGRATION-PROGRESS.md volatile decision).
- **`RuntimeConfig` typed input**: apply() now receives rc.2 `Volatile<T>` refs for volatile fields; `unwrapRuntimeConfig` builds a stable live view; `commitVolatileUpdate` commits edits INTO the same nested live objects (no identity churn).
- **`ctx.on("loader/volatile-update")` hook**: after every hot settings edit, re-derives
  - the consent/review cancel gate (`EpisodeReviewAbortGate.setEnabled` — disabling review ABORTS pending review work),
  - scheduler re-arming (maintenance/nightly/startup cadence),
  - tools + commands registration sync,
  all without restarting the plugin fiber.
- Live getter views replace captured config snapshots for `extractSettings`, `episodeState`, `consolidateSettings`, recall settings, and injection controls, so a volatile edit reaches the running pipeline per call.
- Wires the shared business module (below): business API created once per apply, passed to BOTH the command lane and the registered remote; disposer is `ctx.effect`-owned.

### NEW `src/business.ts` — typed business service (`selfImproved` remote namespace)

- `MemoryBusinessService extends TypertRemoteService` (service key `selfImprovedMemoryUi`), all methods carrying `@Remote` SRC markers + the trailing `signal: AbortSignal` Gateway cancellation parameter:
  - reads: `snapshot`, `memoryDetail`, `episodeDetail` (bounded, JSON-safe, no legacy namespace-published tokens/chips in the payload),
  - mutations: `forget`, `correct`, `confirmCorrect`, `deleteSkillRemoval`, `purgeEpisodes`, `dryReview`.
- **Authorized** (replaces Config-as-RPC): mutations run a TWO-CALL handshake — `prepareMutation` mints a short-TTL one-shot challenge bound to the exact args AND the Gateway peer id; the follow-up remote call must echo it; the pending challenge is consumed before execution. Peer-bound tokens cannot be relayed across connections (`ActionChallengeLedger` gained an optional peer binding — commands.ts edit).
- **Caller lanes**: `{ peerId, source: "remote" }` (Gateway) vs `{ peerId: null, source: "command" }` (the /memory command registry / in-process lane, which owns its own `command/run` provenance and tool-permission authorization).
- Consent boundaries: episode ROW reveals stay gated on `episodeLearning.enabled` (counts always serve); a disabled plugin surfaces explicit business rejections instead of crashes; data inspection remains available while learning is paused (`snapshot` reads don't require the master switch).
- `registerMemoryBusinessRemote(ctx, deps, shared?)`: fiber-owned registration (child plugin fiber + outer `ctx.effect`), so unload/restart removes the namespace.

### `src/commands.ts` — shared lane + peer-bound ledger

- `ActionChallengeLedger.prepare/consume` accept an optional peer binding.
- `handleMemoryCommand` gains an optional `business` dependency: `browser --json`, `forget`, and `correct` subcommands run through the shared business lane when installed (fallback keeps the legacy store path for rollback evidence). `installMemoryCommands` passes the option through.

### `client.js` — full rc.2 client boundary rewrite (module seam inside one bundle)

- `[settings-form]` module — the ONLY owner of entry form state:
  - binds `ctx.configForms.get("dsh-self-improved")` as a CONSUMER: `subscribe`/`unsubscribe` only; never disposes the provider-owned form (rc.2 ConfigForms contract);
  - dirty dotted-path set + edit-baseline revision captured at first edit;
  - `saveDirty()` mutates ONLY dirty paths with the baseline revision fence (`form.mutate(ops, expectedRevision)`);
  - refuses silently-accepted conflicts: a false/refused or remotely-bumped revision lifts a VISIBLE conflict banner (`role="alert"`) with explicit "Keep my edits (rebase)" / confirmed "Discard my edits" actions — dirty values survive both;
  - scoped "Restore inherited defaults" per group (confirmed; excludes secrets and init-only fields).
- **Draft persistence across navigation**: the binding (draft/dirty/baseline) is created ONCE inside `apply()`; components subscribe/unsubscribe on mount/unmount; tab switching no longer resets draft state (the legacy tab-switch unmount disposal is gone).
- **Secrets presence-only**: `recall.embedding.apiKey` renders write-only with presence from the describe mirror's `secrets` sidecar (`key stored`/`no key`), placeholder only, never an echoed value; blank keeps the stored key.
- **Init-only flagging**: `storageRoot` renders a "restart required" badge with disabled inputs and is skipped by live resets/saves.
- `[business-remote]` module: hand-authored client descriptors mirroring the host `@Remote` SRC markers (`$mount({ package: "dsh-self-improved", descriptors })`), strict JSON codecs, cancellation parameters, and the mutating stage+echo handshake — `ctx.remote.selfImproved.*` replaces ALL `settings.mutate` action traffic (the legacy `dsh-self-improved-browser` namespace channel is not referenced).
- Accessibility carried in source: switch track `:focus-visible`, `aria-expanded` button collapse headers, `role="tab"`+`aria-selected`, semantic `role="dialog" aria-modal`, Escape handling, `role="alert"`/`status` live regions, label`htmlFor`/`ariaLabel` pairs, destructive buttons styled distinctly.
- Routing: the Memory tab reads rows via the typed remote; dry-review returns its summary directly (no namespace publish).

## New focused tests (all synthetic/isolated; no shared worker files touched)

1. `scripts/test-v02-settings.mjs` — **8 PASS** against genuine installed rc.2 runtime classes:
   - volatile classification + schema-to-UI inventory parity (every Config leaf classified on BOTH halves; hidden ≠ forgotten),
   - `role('secret')` redaction: value never rides the redacted view; presence-only sidecar served,
   - business semantics on a real MemoryStore in `os.tmpdir()`: reads, no `actionToken/confirm` remnants, full one-shot handshake matrix (cross-peer thrown, args-mismatch thrown, exact-args executes once, replay thrown, untouched rows intact),
   - wire cancellation (pre-aborted call refuses before execution; token still required), disabled-plugin explicit rejection,
   - rc.2 surface: service registration (resolvable + `reflect.props` service type), explicit `typertRemote` binding (serviceKey/namespace), `remoteMethods` SRC marker parity with client descriptors, trailing-signal parameter matrix, disposal (unresolvable after the disposer).
2. `scripts/test-v02-client-smoke.mjs` — **PASS**: evaluates the client bundle in a sandbox (`react` shim, stubbed `configForms`/`remote`/`locale`/`slots`), and asserts `apply()` registers the section through `whileServed`, subscribes the shared form, mounts exactly one typed business contribution with strict-codec descriptors, and that navigation/unmount unsubscribes the provider-owned form without disposing it.
3. `scripts/test-settings-ui.mjs` — rewritten for the new boundary (previous version asserted removed legacy strings): static invariants for the eight acceptance behaviors above plus select-fallback replay and bilingual dictionary/consent disclosure checks.

Test commands: `node scripts/test-v02-settings.mjs`, `node scripts/test-v02-client-smoke.mjs`, `node scripts/test-settings-ui.mjs`.

## Regression evidence (measured after `typecheck-v02 --emit-lib` rebuild)

- `node scripts/typecheck-v02.mjs` — **PASSED** (strict, pinned rc.2 peers, dsh-typert-protocol/cordis-plugin-loader/cosmokit added to the check-tree peer symlink list).
- `node scripts/test-phase-a.mjs` — PASS. `node scripts/test-v02-safety.mjs` — PASS (60 checks incl. strengthened disabled instrumentation). Post-review suites: hermes/storage/redact/episodes/episode-review/episode-rollout/extract/recall/evolve/commands/audit-skills/user-edit-preservation — all PASS.
- `scripts/test-v02-revocation.mjs` and `scripts/test-v02-capture-privacy.mjs` (other workers' persisted failures) still FAIL with the SAME documented Phase B defects (corrected-fact/late-admission at the recall boundary; ordinary-lane persistence privacy) — unchanged by this increment, honestly kept open.
- `git diff --check` clean.

## Environment changes (reversible; node_modules only, no manifest/source impact)

The plugin's built lib now transitively requires three packages whose repo `node_modules` copies were pre-rc.2. They were re-pointed at the installed rc.2 runtime copies (originals preserved by `.legacy` suffixes inside `node_modules/@deepseek-ai/`):

```
node_modules/@deepseek-ai/dsh-typert-protocol -> rc.2 copy   (legacy: dsh-typert-protocol.legacy-rc6, 0.1.0-rc.6)
node_modules/@deepseek-ai/cosmokit            -> rc.2 copy   (legacy: cosmokit.legacy, 1.8.2)
node_modules/@deepseek-ai/schemastery         -> rc.2 copy   (legacy: schemastery.legacy-3.18.2, 3.18.2)
node_modules/@deepseek-ai/cordis-plugin-loader -> rc.2 copy  (new symlink; needed for 'loader/volatile-update' typing)
node_modules/@deepseek-ai/dsh-typert-protocol  (same symlink as above)
```

These are NOT git-managed; reverting = deleting the symlink and restoring the `.legacy*` names. `package.json` was NOT edited by this increment (a `dsh-typert-protocol: 0.2.0-rc.2` peer line appeared in the working tree from concurrent work and is preserved as-is).

## Remaining Phase A gates (honest state)

1. **Mount/unmount in an isolated v0.2 profile** (gate 1) — still open. This session did not start any host, did not touch plugin_manager (active-profile limitation), and did not run workflow-5's fixtures. The typed-remote registration path above is unit-verified only; a mounted host must confirm the app boots with the namespace claimed by the Gateway.
2. **Visible stale-conflict in the mounted browser** (gate 6) — implemented at the client boundary (banner + rebase/discard) and statically asserted; a mounted, isolated-profile browser pass (keyboard, light/dark, save-conflict flows) is the actual gate and was NOT exercised (no replacement GUI server; the current browser channel stays scaffolding-only for legacy hosts).
3. **Live provider-first-request + native resume/fork** verification inside a mounted profile — open (workflow-5 owns the runtime fixture files).
4. Remote mutation authorization remains one-shot/args/peer-bound at the wire; human-intent recording and mid-flight revocation generations are Phase B/D work (documented in the business module header, not silently claimed).
