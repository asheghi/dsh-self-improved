# MIGRATION-MOUNTED-UI-TESTS — Phase A mounted browser gates (settings/business boundary)

Author: the Phase A mounted-UI worker. Scope honored: no importer/manifest/
fixtures-under-other-workers files, no history or coordinator docs/baseline
writes, no commits/staging, no active-profile installation or settings edits,
no production data, no external model requests, no compatibility exemptions,
no generated skill activation, and **the existing `127.0.0.1:3082` GUI page and
profile were never opened, navigated, or touched** — every browser call ran in
new pages of the isolated browser context `dsh-self-improved-mounted-ui-test`
against this fixture's own ephemeral loopback servers.

## Deliverables in this increment

- NEW [scripts/test-v02-mounted-ui.mjs](<scripts/test-v02-mounted-ui.mjs>) —
  runner for the deterministic halves (`up` / `verify --run <dir> [--cookie …]
  [--fresh]` / `down --run <dir>`), with unique owned homes + owner markers and
  guarded cleanup.
- NEW `fixtures/v02-ui/temp/<runid>/` run dirs — the two verified runs are
  [fixtures/v02-ui/temp/mounted-ui-1791419034379-963b14](<fixtures/v02-ui/temp/mounted-ui-1791419034379-963b14/facts.json>)
  (fully self-contained runner cycle, **12/12 verify PASS**) and
  [fixtures/v02-ui/temp/probe-c](<fixtures/v02-ui/temp/probe-c/facts.json>)
  (the full interactive ledger run, **14/14 verify PASS**). Superseded dead
  probe dirs were removed.
- NEW this file — the interactive ledger below.
- SCOPED FIXES (each authorized by an actual mounted defect, see Section B):
  `client.js` (inject deadlock + governed namespace reads + empty-op save +
  dialog focus restore), `src/index.ts` (secret schema no-default), and their
  own tests updated only where the old text encoded the defect behavior
  (`scripts/test-v02-client-smoke.mjs`). NO other source/tests touched.

## Runtime and pinned facts

- Installed rc.2 runtime (read-only): `/home/bahman/github/dsh-v0.2`, verified
  `dsh@0.2.0-rc.2`; test GUI booted as `dsh --profile mounted-ui --no-open
  --port 0` from a fixture-owned profile dir whose own `cordis.patch.yml`
  mounts the shadow package WITHOUT a config block (see A5 for why).
- Build pinned for every measurement:
  - `lib/index.js` sha256 `289013683e08653bc662fe834c0d4e2d2dfdb873910e30c3ed17f0ddb39cd524`
    (rebuild via `node scripts/typecheck-v02.mjs --emit-lib`; this build
    includes the Section B fixes; the workflow-9 runtime suite runs green on
    it: `STRICT 207 PASS / 0 FAIL; 4 XFAIL / 0 XPASS`, build pin
    `7dfda9c70da992df…` re-established by their own rerun — their suite owns
    reclassification, mine does not touch their files).
  - `client.js` sha256 `64ed3265ed33d22c7d6d976d559e4a89ec372c767f8b9ef860365e3c34b71ba8`
    (runner-verified served bytes are the current file + one server-appended
    `//# sourceMappingURL` trailer; `verify` gates the no-stale illusion).
- Isolation: HOME/DSH_HOME in the unique run dir; provider route
  `DEEPSEEK_BASE_URL=http://127.0.0.1:<ephemeral>` with a synthetic key and a
  request-logging stub; `DSH_TELEMETRY_DISABLED=1` + composed
  `session-telemetry-otel` disabled; `DSH_PERMISSION_MODE=workspace-write`.

## A. Interactive ledger (browser over the real Gateway, isolated context)

Every line below was measured on the live mounted GUI; the durable
consequences were re-verified from disk by `node
scripts/test-v02-mounted-ui.mjs verify …` (result counts in the run names
above).

1. **Plugin client bundle mounts through the real web app.** First boot showed
   `Failed to load plugins — web boot: 1 entry did not activate: dsh-self-improved:
   pending (waiting for service: remote.selfImproved)` (defect B1). With the
   fix, the composed boot graph carries the `dsh-self-improved` row, the
   served combo bundle is byte-identical to the repo `client.js` (modulo the
   server trailer), and the `settings.section` slot panel renders under
   Settings → "Evolving Memory" (`role=tablist` Config/Memory tabs).
2. **Gateway-dispatched business reads.** The Memory tab renders the seeded
   rows ("3 active memories…") via `remote.selfImproved.snapshot()` crossing
   the real HTTP gateway with the page's auth cookie; the typed namespace is
   present client-side with all methods (`snapshot`, `memoryDetail`,
   `episodeDetail`, `prepareMutation`, `forget`, `correct`, `confirmCorrect`,
   `deleteSkillRemoval`, `purgeEpisodes`, `dryReview`).
3. **Dirty-only save + hot apply.** Editing `searchLimit` 5→7 then Save sent
   exactly ONE op (`{op:"set",path:["searchLimit"],value:7}`, fence revision 0)
   over `settings/mutate`; host accepted (revision 0→1), value live ("Saved —
   applied without restart"), dirty badge cleared; the override landed in the
   profile patch file (durable, re-verified by `verify`).
4. **Visible stale-conflict + rebase across two real peers.** Page A captured
   a dirty edit (`searchLimit` 9, baseline revision 2). Page B (second browser
   connection) wrote `recall.maxResults` 5→3 (rev 2→3) and
   `extract.intervalMinutes` 15→16 (rev 3→4). A surfaced a live
   `role=alert aria-live=assertive` banner: "These settings changed elsewhere
   since you started editing…" with "Keep my edits (rebase)" and confirmed
   "Discard my edits"; A's dirty value stayed rendered ("unnamed" badge, value
   9; B's fields showed "overridden"). Rebase → Save sent `{set searchLimit 9}`
   with fence revision 3 (accepted, store rev 4, live value 9, dirty clear).
   A first-save with a stale fence was refused by the host with
   `settings/rejected` (observed on an overlay-owned config in the early
   fixture attempt — see A5) and lifted the same banner — failure is visible,
   not silently accepted.
5. **Settings-write authorization shape on rc.2 (harness finding, not a plugin
   bug).** Mounting the entry via a `--patch` overlay WITH a `config:` block
   makes `settings.mutate` refuse with
   `settings/rejected: Configuration for "dsh-self-improved" is overridden by a
   home patch or command-line overlay` while `describe` still says
   `writable:true` (host inconsistency, coordinator-owned). The supported
   settings UX requires the profile-patch face the dsh config editor owns;
   the fixture therefore mounts through `profiles/mounted-ui/cordis.patch.yml`
   and every save/lifecycle gate above uses that real path.
6. **Draft persistence across navigation.** A dirty value survived Config↔
   Memory tab switches (draft + "N field(s) with unsaved edits" status intact;
   created once in `apply()`, unsubscribe-only on unmount). A draft restored
   to the host value then Save initially left a stale "unsaved" badge (defect
   B4) — fixed; commit the same flow on the fixed bundle by rerunning this
   exact replay when convenient (suite-verified; compact runner flow uses a
   straight save so it does not cover the restored draft case live).
7. **Authorized memory mutations through the UI.**
   - **Correct** on a row opened an in-place editor; Save ran the two-call
     handshake (`prepareMutation` → echo token) over the gateway; the durable
     store gained a superseding row with `provenance:"user".
     source:"user-direct"` and the original row became `corrected` 1(mnesia
     re-verified by `verify`).
   - **Forget** showed the destructive `window.confirm` dialog (handled via
     the test harness), then ran the handshake; the seed row turned
     `forgotten` in the durable store and disappeared from the list view.
8. **Pause keeps stored data inspectable and mutable, with zero new work.**
   Toggling the master switch OFF + Save hot-applied volatile `enabled:false`;
   the Memory tab kept rendering rows and a live **correct executed while
   paused** (second new `user-direct` row); afterwards: `extract_state`
   EMPTY, provider-requests.log contains ZERO real requests for the whole
   session, and no conversation slices were written. Master re-enabled
   afterwards in the ledger run (final runner cycle intentionally ends paused,
   `enabled:false` persisted in its patch file as recorded).
9. **One-shot, args-bound authorization over the wire.** Raw remote calls
   (same page as a distinct gateway peer):
   - staging a challenge mints a token (TTL 120 s reported to the client);
   - executing with the token + EXACT args → ok (`affected` truthy);
   - executing with the token + DIFFERENT args → rejected
     (`self-improved/rejected`) — exact-args binding enforced;
   - replaying a consumed token → rejected (one-shot);
   - a pre-aborted call → rejected `gateway/cancelled` and the token stays
     usable afterwards (cancellation does not burn the credential).
10. **Peer-binding limit on this deployment (harness finding).** Two browser
    connections are admitted as the SAME operator peer (`dsh-client-connection`
    `HostConnectionService` builds ONE `OperatorPeer` per server and
    `admit()` returns it for every request), so a token minted by page A was
    ACCEPTED from page B — cross-browser rebind is not discriminated on an
    rc.2 loopback web deployment. The plugin's peer binding still holds across
    distinct peers (process/remote-app callers); this needs a coordinator
    decision if per-connection browser peers matter (host design change, not
    fixable in client.js/plugin scope).
11. **Dialog accessibility.** The memory Detail modal renders
    `role=dialog aria-modal=true aria-label`, focus lands INSIDE on open, a
    real Escape key closes it, and focus returns to the opener — measurable
    only after defect B5's fix (before: opener focus lost to React remount).
    Tab-trap cannot be exercised with one tabbable control (tabCount=1) —
    recorded, not claimed.
12. **Keyboard focus.** A real Tab press reached a plugin switch input and
    `:focus-visible` matched (browser `outline: auto` painted on the input).
    Finding: the custom switch-track CSS (`.__dsi_switch … focus-visible`)
    is dead code — zero `.__dsi_switch` elements render; switches are native
    checkboxes today, so the visible-focus gate holds via the native ring.
    Optional cleanup (dead CSS block) left to the coordinator's UX pass.
13. **Theme tokens light/dark.** Plugin section colors derive from theme
    tokens only: Light `intro` color `rgb(97,102,107)` on white; Dark
    `rgb(207,211,214)` on `rgb(21,21,23)`. Appearance restored to System.
14. **Init-only + policy-hidden fields.** `Memory dir`/`Skills root` render
    with "restart required" badges and disabled inputs; `extract.
    provenanceFilter` (migration-only) and `extract.fallbackOnBadJson`
    (retired) appear nowhere in the form; Save/Reset skip secret + init-only
    paths. The remaining dialogs' destructive buttons are danger-styled.

## B. Defects found BY the mounted gate and fixed in this increment

1. **`client.js` inject deadlock killed the whole client activation**
   (observed literally: "pending (waiting for service: remote.selfImproved)").
   The entry's inject list contained `remote.selfImproved`, a service only the
   same entry's `apply()` creates via `remote.$mount` — the Loader waits
   forever and the section never registers. Fix: removed that key from
   `exports.inject`; the mount-then-consume ordering now follows the documented
   rc.2 pattern (`dsh-experimental-client-ui-voice-input`): `await
   remoteMount.settled`, then register the section inside a
   `ctx.inject(["remote.selfImproved", …], …)` child.
2. **Business-remote reads are governmessed** (cordis `ReflectService` proxy:
   "cannot get property … without inject"). `businessApi()` previously read
   `remote[NS]` / `ctx.get("remote."+NS)` on the plugin context — both gated,
   so the Memory tab rendered "the typed business remote is not reachable"
   while the namespace was fully mounted. Fix: the section (and its render
   closure) now lives inside the injecting child context only (B1's child),
   and `businessApi` reads the declared service key.
3. **Phantom secret presence**: the describe mirror reported
   `recall.embedding.apiKey … set:true` ("key stored") with NO key stored,
   because the plugin defaulted the secret field to `""` and the host presence
   walker counts any value (`dsh-settings` redact `set: value !== void 0`).
   Fix: `src/index.ts` declares the secret WITHOUT a default (typed
   `apiKey?: string`); the mounted mirror now reports `set:false` and the
   field reads "(no key)". Suites: typecheck + all settings suites PASS.
4. **Empty-op save left a stale "unsaved" badge** (draft restored to the host
   value then Save sent zero ops and kept `state.dirty`). Fix in
   `saveDirty()`: zero-op path clears dirty/baseline/draft before resolving
   true.
5. **Dialog focus restore lost to React remount**: Escape returned focus to
   the opener node that the closing re-render had replaced (measured
   `returnedToOpener:false` on the first pass). Fix:
   `dialogFocus.restore()` defers by one animation frame and re-checks the
   node is still in its document. Verified live after reboot:
   `returnedToOpener:true`, `dialogClosed:true`, focus landing inside on open.

All five fixes are covered by the owned suites:
`node scripts/test-v02-client-smoke.mjs` PASS (updated where the old text
encoded defect behavior), `node scripts/test-settings-ui.mjs` PASS,
`node scripts/test-v02-settings.mjs` 14/14 PASS, `node
scripts/typecheck-v02.mjs` strict PASS + `--emit-lib` rebuild, and the full
regression battery: test-phase-a, test-v02-safety, test-commands, test-recall,
test-hermes, test-storage, test-redact, test-episodes,
test-episode-review, test-evolve, test-extract, test-audit-skills,
test-episode-rollout, test-user-edit-preservation — all exit 0 — plus
`node scripts/test-v02-runtime.mjs` (workflow-9's owned suite) STRICT 207/0.

## C. Exact commands and reproduction

```
# build (fixes included)
node scripts/typecheck-v02.mjs --emit-lib

# boot a fresh isolated mounted run (prints facts.json: url/token/hashes)
node scripts/test-v02-mounted-ui.mjs up        # run as a lasting background job

# interactive browser pass (isolated context, NOT the 3082 page/profile):
#   open <url> → Settings → Evolving Memory
#   (1) edit + Save            (2) Memory: Detail/Correct/Forget
#   (3) pause: master off + Save; browse/correct while paused
#   (4) conflict: dirty edit, second peer writes, banner + rebase + save
#   (5) keyboard Tab, dialog open/Escape, Light/Dark
# durable consequences:
node scripts/test-v02-mounted-ui.mjs verify --run <runDir> --cookie "dsh-auth-…=<v1…>"
node scripts/test-v02-mounted-ui.mjs down   --run <runDir>
```

Final self-contained evidence run: `fixtures/v02-ui/temp/mounted-ui-1791419034379-963b14/`
— `verify` exit 0 at 12/12 (boot graph rev `8cf59fa5a52b`; patch carries
`searchLimit: 9` + `enabled: false` from the paused close; 1 forgotten row;
1 user-direct supersession; provider log zero real requests).

## D. Remaining Phase A gates this pass does NOT claim

1. **Cross-peer token discrimination between two browser connections on one
   loopback host** — impossible to verify (both admitted as one operator peer,
   ledger A10). Needs a harness-design decision; NOT a plugin fix.
2. **Mid-flight cancellation of a long-running business call.** Pre-aborted
   calls are refused at the wire (`gateway/cancelled`, ledger A9) and the
   token survives; there is no slow endpoint in the fixture to abort in
   mid-run, so "abort during execution" remains unit-verified only.
3. **Volatile hot-apply observability in the live page**: hot commits were
   verified via the genuine-Loader suite (`test-v02-settings`) and the
   settings persistence evidence; the mounted page's own re-render on
   `loader/volatile-update` was not separately induced while visible
   (debug logging of the hot woodwork only shows with `debug:true`).
4. **Screenshots** for the light/dark and conflict-banner evidence: the
   DevTools screenshot/resize calls timed out repeatedly in this session;
   the ledger records a11y-tree + computed-style measurements instead.
   No real data was ever rendered — the page state contains only the
   synthetic `LUNA/BASIN/FORGE` tokens.
5. **Test-package artifact lifecycle** remains separate, as instructed;
   no install/registration claim is made beyond this fixture.

## E. Cleanup state

- Two evidence run dirs are KEPT (probe-c + the final runner cycle); owner
  markers present; `down --run <dir>` removes either one safely.
- Superseded probe-a/probe-b and the aborted first runner dir were deleted;
  stray ad-hoc seed/verify scripts under
  `fixtures/v02-ui/temp/` were removed. Nothing outside
  `fixtures/v02-ui/**`, the runner script, this doc, `client.js`,
  `src/index.ts`, and the one smoke test was touched.
