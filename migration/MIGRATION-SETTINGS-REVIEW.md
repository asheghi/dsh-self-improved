# MIGRATION-SETTINGS-REVIEW.md — independent review/fix of the Phase A settings/Remote increment and the lifecycle boundary

Author: delegated review agent over the workflow-7/settings deliverables
(`src/runtime-config.ts`, `src/business.ts`, `src/index.ts`, `src/commands.ts`,
`client.js`, own tests `scripts/test-v02-settings.mjs`,
`scripts/test-v02-client-smoke.mjs`, `scripts/test-settings-ui.mjs`).
Scope honored: no importer/manifest/coordinator-owned files, no
workflow-9 fixture files, no baseline/Git-history writes, no staging or
commits, no active-profile installation or settings writes, no production
data, no external model requests, no dependency patches or exemptions, no
generated skill activation, no replacement GUI (never touched port 3082).

## Verdict

The Phase A settings increment was structurally sound but shipped six verified defect groups, including one that made the plugin's own hot-update hook
dead code, and the lifecycle race that MIGRATION-RUNTIME-REVIEW.md reported
was still open in source. All are fixed and verified below. No Phase B gate
(durability/import/cache/privacy) is claimed anywhere.

## Contract verifications (exact installed rc.2 evidence)

- **`loader/volatile-update` emission is REAL.** Installed
  `cordis-plugin-loader/lib/index.js` (`Entry._commitVolatile()`): a
  volatile-only config change validates the candidate through the runtime
  schema, `updateVolatile(ref, source)` commits into the running refs, then
  `fiber.ctx.emit(self, "loader/volatile-update", paths)` — emitted only to
  the owning fiber (`self[Context.filter] = owner.fiber === fiber`). The event
  is declared in `lib/types/index.d.ts`
  (`'loader/volatile-update'(paths): void`, "dispatched to the owning fiber
  only"). The earlier "no catalogued event" inspection gap (coordinator round
  53) is resolved: the event exists and fires; an OUTSIDE context does not
  observe it (its own `ctx.on` indeed saw nothing — correct under the owning-fiber-only filter).
- **Hot Config commits end-to-end with the GENUINE Loader** (new evidence,
  in-process, no profile): real `Loader` service over this plugin's built
  `lib/index.js` → `entry.update({config})` with a volatile-only diff → same
  fiber survives (`entry.fiber` same object, uid unchanged), the changed
  value is live in the running fiber (`searchLimit.get() === 9`), and the
  plugin's `loader/volatile-update` hook re-derived consent gate +
  schedulers + tools/commands without a restart. This exceeded the old
  "ctx.on registered" claim: registration alone had hidden a real defect
  (below). Promoted as durable checks: `scripts/test-v02-settings.mjs`
  "loader volatile-update: *" (4 checks).
- **Typert Remote authorization/caller/cancellation contract**:
  installed `dsh-typert-protocol/lib/types/types.d.ts` — `this.ctx.invocation`
  is the receiver's Remote-call context with `peer: PeerScope {id, ctx}` and
  `signal: AbortSignal` ("Carrier cancellation: Client cancel, socket close").
  `remoteMethods(service)` reads the `@Remote` SRC markers off the class
  prototype; the Gateway reads the `typertRemote` binding (serviceKey +
  namespace). The business service derives its caller from `this.ctx.invocation`
  on the Host (never from a client-supplied peer) — coordinator round 51's
  direction confirmed against the exact declarations.
- **Client ConfigForms ownership** (installed
  `dsh-client-ui-settings/lib/types/client/config-form.d.ts` +
  `config-form-types.d.ts` + `settings-mirror.d.ts` + dsh-settings
  `SettingsNamespaceView`/`SettingsSecretView`): shared entry-addressed form
  is provider-owned (`get()`/`subscribe` returns consumer unsubscribe;
  consumers must not dispose); snapshot keys `status/value/base/user/revision/writable/mode`;
  `mutate(ops, expectedRevision) → boolean` (false = refusal, transport failures
  reject); secrets are presence-only `{path, set}` sidecars on the describe view.
  `client.js` complies.
- **Node-scope facts**: `ctx.on` returns a listener-unregistering disposer;
  fiber disposal runs disposers in REVERSE registration order, chained
  sequentially, and awaits async disposers (`cordis/lib/index.js`
  `dispose()` → `disposables.splice(0).reverse()`). This reverse order is the
  root of defect 4 below.

## Fixed defects (each with reproduction evidence)

1. **The hot-apply hook could never succeed (dead console path). Real Loader
   probe:** the genuine `entry.update()` DID emit to the plugin, but
   `commitVolatileUpdate()` crashed with `TypeError: Cannot assign to read
   only property 'baseUrl'`: `unwrapRuntimeConfig()` leaked the recursively
   FROZEN nested volatile snapshots (`recall.embedding`, `evolve.*`) into the
   "live" view, so a hot edit installed read-only objects and every hot apply
   silently degraded to a warn-and-stale pipeline (running fiber kept the OLD
   values). Fix: `unwrapRuntimeConfig()` deep-owns nested leaf groups, and
   commits go through the new `assignPlainTree()` (recursive in-place copy)
   instead of shallow `Object.assign`. Verified: same probe now logs
   "volatile settings applied (no restart)" and the committed value is live.
2. **Paused/off setting hid stored data (CRITICAL plan violation).**
   `business.ts assertReadable()` rejected `memoryDetail` and
   `prepareMutation` whenever `enabled() === false` — remember-off made
   corrections/inspection/administration unreachable. MIGRATION-V0.2.md
   ("Off keeps saved data", "pause must not make stored data inaccessible")
   and coordinator round 51 require the opposite. Fix: the gate is removed;
   reads/detail/staged mutations are available while remembering is off; only
   NEW capture/model work stays consent-gated (`episodeLearning.*`,
   `dryReview`). Suite now asserts paused inspection + a forget executing
   while `enabled: false`.
3. **Command lane hid stored data too**: `installMemoryCommands` refused
   EVERY `/memory` subcommand while the master was off ("the /memory command
   is unavailable"), hiding `/memory forget/correct/search/list/browser`.
   Fix: only the work-driving paths (`evolve`, `episode-review` LLM lanes)
   refuse when disabled; reads/corrections/forgetting/retention stay available.
4. **Accepted-work shutdown race (runtime report D1) fixed at the boundary.**
   Root cause measured against cordis's real disposal order: the old teardown
   effect ran `store.close()` while (a) the `session/flush` listener was still
   registered and (b) accepted pump promises were untracked — an accepted
   extraction insert lost to the early close. Fix: NEW exported
   `registerShutdownDrain(ctx, target)` in `src/index.ts` (registered LAST,
   so reverse disposal runs it FIRST) plus `trackAcceptedJob` for every
   accepted pump/review/evolution (flush lane, maintenance timer, nightly,
   startup, manual evolve, episode dry-review), plus `shuttingDown` ingress
   gating in `readModule`/pump wrapper/review delegates; `installCapture` now
   returns the `session/flush` disposer so ingress closes explicitly. Ordering:
   ingress gate → drop ingress → consent abort + timers → registrations →
   bounded drain join (5s budget, visible warn on timeout, no silent loss) →
   `store.close()`.
   Regression (durable, in `test-v02-settings.mjs`):
   - NEGATIVE: the pre-fix close-first ordering on the same primitives
     genuinely reproduced the loss — event trace `close →
     insert:LOST(database is not open)`;
   - POSITIVE: `registerShutdownDrain` + a 40 ms accepted insert → commit
     lands BEFORE close, no dispose error, job set settles, and a late flush
     does not re-enter (ingress stays down); the closed store is not touched.
5. **Policy classes / filesystem-root safety** (coordinator round 48):
   classification vocabulary extended (`migration-only`, `retired`):
   `extract.provenanceFilter` = `migration-only` (no 'off' bypass in ordinary
   Advanced), `extract.fallbackOnBadJson` = `retired` (unsafe default —
   malformed output must stay failed/retryable; matches
   `src/migration-v02.ts` action mapping). `evolve.skillSynthesis.skillsRoot`
   = init-only: the plugin resolves it ONCE at start, every consumer reads the
   startup value, a live edit only warns ("…needs a restart") and never
   retargets the running root — verified with the genuine Loader (no fiber
   restart, visible warning, hot edit stays in the running fiber).
   `INIT_ONLY_PATHS` now lists both filesystem roots; the client renders both
   with the restart badge and skips both in saves/resets. The plain-JS client
   FIELDS block also mirrors all of this (render/save/reset skip
   migration-only/retired).
6. **Client defect batch**:
   - The FIELDS enrichment block was a merge botch (`FIELDS.forEach` nested
     inside `isPathLikeNumber`, duplicate `isPathLikeCheckbox` declaration,
     dead `TEXT_KEYS`, no return): labels/number typing never ran. Restored:
     `isPathLikeNumber` returns a real predicate; enrichment runs at module scope.
   - The external-change conflict banner recorded `ours: state.snapshot.revision`
     AFTER already replacing it with `next` — both sides showed the new
     revision. Fixed to the captured `state.baselineRevision`.
   - `purgeEpisodes` client descriptor was missing SRC `cancellation`; added
     (parity with the host signal parameter).
   - Dialog a11y: added a self-contained dialog focus lifecycle — focus lands
     inside the opened dialog (callback ref + tabindex -1), Tab cycles within
     it (trap), and closing restores focus to the opener (memory detail and
     episode detail modals).
   - `saveDirty`'s current-value lookup had a dead duplicated condition (both
     ternary branches returned the same snapshot value) — simplified; the
     comparison correctly stays against the live snapshot value.

## New dependency exposure (REPORTED to coordinator; manifest is coordinator-owned)

The built lib binds/permits these runtime modules (`node_modules` test
symlinks re-pointed by the settings worker — same env items, restated for integration):
- `@deepseek-ai/dsh-typert-protocol` 0.2.0-rc.2 — NEW before this increment; the business Remote surface depends on it.
- `@deepseek-ai/cordis-plugin-loader` 1.0.5 — NEW; needed for the rc.2 volatile-update augmentation/context type.
- `@deepseek-ai/cosmokit` 1.8.5 (legacy 1.8.2 → `cosmokit.legacy`) — `isVolatile`/`createVolatile` + loader internals.
- `@deepseek-ai/schemastery` 3.18.4 (legacy 3.18.2 → `schemastery.legacy-3.18.2`) — `.volatile()`/`role()` schema meta.
These must appear in the package manifest peer set for rc.2. TEST-SYMLINK ROLLBACK (manual, reversible, no source/manifest impact):
delete the re-pointed entries in `node_modules/@deepseek-ai/{dsh-typert-
protocol,cosmokit,schemastery}` and restore `dsh-typert-protocol.legacy-rc6
→ dsh-typert-protocol`, `cosmokit.legacy → cosmokit`,
`schemastery.legacy-3.18.2 → schemastery`; for `cordis-plugin-loader` (added
symlink) delete it entirely. `package.json` was NOT edited by this increment.

## Measured results this review

Build: `node scripts/typecheck-v02.mjs --emit-lib` — PASSED (strict, pinned
rc.2 peers; dependency declarations skipped via skipLibCheck).

Built-module sha256 (current):
```
index.js          757a924d652768f0a29accb17bad6d1218f1c674477ee02868408c3d3bc32077
business.js       0d51140e1689cc35fe9e6bf478847b85c763761c9533244004e4fd1792f9d157
runtime-config.js 11b7d591d124b975fb1627d83c96e5b527fb5f590e140564f4da81593ec7aa83
commands.js       f2335854bc822d29e23203e82493227861579f5292c4e5ea76f1ba9f635bd120
capture.js        53d61ebe69cc2c60c31b5e7406d42e6787fd0225c28e68c161765b8ffcf7c4c8
tools.js          4532815acc4a99e41d798175cecfb114966f0f04174357867c0524953d2f2360
```

Owned suites (all synthetic/isolated; real MemoryStore in tmpdir, real Loader
in-process, no profile/provider/network):
- `scripts/test-v02-settings.mjs` — **14/14 PASS** (8 prior + harnessed
  sequential execution, + policy-class check, + 4 Loader volatile-update
  checks incl. the hot-commit/no-restart/init-only/restart split).
- `scripts/test-v02-client-smoke.mjs` — PASS; `scripts/test-settings-ui.mjs`
  — PASS (now also asserts dialog focus lifecycle + hidden-policy classes;
  two prior assertions updated to the fixed semantics only where the old text
  encoded a defect behavior).

Regression matrix (all exit 0): `test-phase-a` (37 PASS),
`test-v02-safety`, `test-commands`, `test-recall`, `test-hermes`,
`test-storage`, `test-redact`, `test-episodes`, `test-episode-review`,
`test-evolve`, `test-extract`, `test-audit-skills`, `test-episode-rollout`,
`test-user-edit-preservation`. `git diff --check` clean.

Workflow-9 runtime suite (their files, run read-only): case1 D1a/D1b/D1c
turned **XPASS** exactly as their gate contract predicts — the mounted run
now drains accepted extraction without a `database is not open` error, the
provider-validated insert persists, and the cursor consumes the captured
range (`processed_seq=17 = pending_seq=17`). Their suite reports
`STRICT 202 PASS / 1 FAIL; 4 XFAIL / 3 XPASS` — suite exit 1 with XPASS is
their OWNED reclassification step (this agent did not touch their files).
Still XFAIL there (Phase B-owned defects, unchanged): durable capture cursor
re-capture (D2), recall snapshot re-rows on resume (D3), 30 s pump throttle
dropping accepted ranges (D4), and the disable-window cursor consumption
(case4 D1′ `processed_seq=40/pending_seq=53`) — the drain now JOINS the
accepted job, but consumed-range acknowledgment across a disable window
remains Phase B transactional work.

## Honestly missing (NOT claimed)

1. **Genuine browser conflict gate is still missing**: the conflict banner,
   rebase/discard, secret presence, and init-only badge are implemented and
   statically/unit-verified, but no mounted isolated-browser pass exercised
   them (no isolated browser profile session was started; the 3082 GUI was
   never touched). Suggested next: isolated `DSH_HOME` + owned profile +
   managed cleanup boot per coordinator round 24's documented path.
2. **Gateway-dispatched Remote calls**: the service registers with a source-
   marker + binding; actual calls crossing the Gateway (peer id from a real
   connection, transport-level cancellation) were verified by contract only,
   not by a mounted browser client lane.
3. **Phase B lanes remain open and are NOT solved by this increment**:
   recall revalidation/cache invalidation (`test-v02-revocation.mjs` still
   fails with the documented correction/late-admission defects), ordinary-
   capture privacy minimization (`test-v02-capture-privacy.mjs` still fails),
   durable capture cursor/transactional acknowledgment (D2/D3/D4 above),
   mid-flight consent revocation generations, human-intent receipts. The
   one-shot challenge is a rebind/replay guard plus the mounted settings write
   itself — no authority/exactly-once durability is claimed by it (corrected
   in `src/business.ts` header).
4. The plugin's host autoGenerate page (when our custom section cannot
   register) can still surface the raw schema — migration-only field hiding
   is enforced in OUR page; the autoGenerate fallback is coordinator-phased
   UX work (noted, not silently dropped).
5. The `/memory` command hot-unregistration timing window and the plugin
   `inject` list are unchanged; the tools' `memory_correct` (untrusted
   staging) and `conversation_search` lanes keep their earlier verified
   provenance behavior; `memory_forget` now shares the business lane with a
   legacy direct-store fallback path retained for pre-installed-lane use.
