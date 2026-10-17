# MIGRATION-RUNTIME-TESTS.md — isolated Phase A runtime acceptance fixtures

Status: executed against the installed **0.2.0-rc.2** runtime at
`/home/bahman/github/dsh-v0.2` (DSH_RUNTIME_DIR overridable). Author: migration
runtime-fixture worker (workflow-5), revised by the runtime-review pass. No
active-profile installation, no live provider calls, no live DB, no GUI server,
no dependency patching, no compatibility exemption, no Git history writes. The
concurrent Phase A worker (workflow-3) remains the owner of `src/`,
`package.json`, existing tests, and the shared MIGRATION docs.

Review-pass note: the first edition of this document had three claims that did
not hold, verified by direct contract inspection and by dump evidence; they are
corrected in place and marked **[corrected]**. The durable review report is
`MIGRATION-RUNTIME-REVIEW.md`.

## What ran

```sh
# from the repository root, against the built lib (pnpm build artifacts):
node scripts/test-v02-runtime.mjs              # all five cases (~40 s)
node scripts/test-v02-runtime.mjs --case case1        # mount + extraction lane (~32 s)
node scripts/test-v02-runtime.mjs --case case2        # recall + resume + fork (~3 s)
node scripts/test-v02-runtime.mjs --case case3-row    # row-disabled mount (~1 s)
node scripts/test-v02-runtime.mjs --case case3-config # config-disabled mount (~1 s)
node scripts/test-v02-runtime.mjs --case case4        # accepted-job quiescence across unmount (~4 s)
node scripts/test-v02-runtime.mjs --case case5        # in-process defect probes on the built lib (<1 s)
node scripts/test-v02-runtime.mjs --keep        # keep temp dirs for diagnosis
```

Preconditions fail fast otherwise:

- runtime `@deepseek-ai/dsh`, `dsh-session`, `dsh-settings`, `dsh-agent-loop`,
  `dsh-llm-deepseek-api-key` all pinned `0.2.0-rc.2`, node v24.13.1 (host).
- the repo build is pinned per run: the fixture shadow package is rebuilt and
  **hash-verified** (`sha256` of every `lib/*.js`) at suite start, so results
  always name the build they mounted, and a concurrent src/ rebuild cannot
  invalidate attribution. Per-run pin file: `fixtures/v02-runtime/last-suite-pin.json`.

## Final result (this report's baseline run)

```
=== runtime fixture summary: STRICT 203 PASS / 0 FAIL; expected-failing defects: 7 XFAIL (gated down) / 0 XPASS (surprise) ===
=== build pin: suite-start 4c2d5ad62de0d968… ; stable across that suite ===
case1        OK  30 strict + 3 XFAIL defect gates   (~32 s)
case2        OK  51 strict + 2 XFAIL defect gates   (~3 s)
case3-row    OK  24 strict                          (~1 s)
case3-config OK  24 strict                          (~1 s)
case4        OK  71 strict + 1 XFAIL defect gate    (~4 s)
case5        OK   3 strict + 1 XFAIL defect gate    (<1 s)
```

**Result-class honesty contract** (replaces the old "OBS-FAIL does not fail the
suite" wording, which made a failing suite print `64 PASS … SUITE PASSED`):

- `ok()` strict gates must hold; failure ⇒ `SUITE FAILED`, exit 1.
- `xfail()` gates encode the fixed behavior of a *tracked defect* (Phase B
  owned); FAILING there is recorded `XFAIL` and is expected (the defect exists
  today); SUCCEEDING there is `XPASS` ⇒ suite failure, exit 1, until the gate
  is reclassified. Fake-green suites are impossible.
- The three "defects observed" checks from the first edition ran under
  `OBS-FAIL`, which was recorded as `ok: true` in the results array — that is
  why the suite printed green over four failed observations. Fixed.

## Isolation design (each claim now either verified or explicitly scoped)

- **Plugin shadow package** `fixtures/v02-runtime/plugin/`: byte-verified copy of
  the built `lib/*.js` with `node_modules` symlinks resolving every bare import
  observed in the build (`@deepseek-ai/cordis`, `cordis-plugin-loader`,
  `cosmokit`, `schemastery`, `dsh-agent`/`-llm`/`-schedule`/`-session(-query)`/
  `-settings`/`-system-prompt`/`-tools`/`-home-paths`/`-typert-protocol`) plus
  `@node-rs/jieba`, `sqlite-vec*` from the repo; symlinks point at the rc.2
  runtime for every `@deepseek-ai` peer. Hash-verified against the pinned
  snapshot at suite start; nothing stale can be mounted.
- **Mount without plugin_manager**: the runtime boots
  `dsh --profile headless --patch <overlay>` with `DSH_HOME` pointing at the
  run's own unique temp home. The composed tree is verified read-only with
  `--dump-config` per case (plugin row present; disabled variants carry
  `disabled: true` on the composed row; no "not found" patch warnings).
- **Environment scrubbing** is an explicit allowlist (`PATH`, optional
  `LANG`/`LC_ALL`, `HOME`, `DSH_HOME`, `TMPDIR`, plus the four verified rc.2
  switches). Every credential path is dropped. **[corrected]** The allowlist
  scrubs *variables*, it never guarantees "no other network destination is
  reachable" by itself — see egress below.
- **Verified provider routing (synthetic, not "loopback by env allowlist")**:
  - `DEEPSEEK_BASE_URL` is the rc.2 internal-endpoint switch of
    `@deepseek-ai/dsh-llm-deepseek` (`BASE_URL_ENV`, honored from the trusted
    launch environment) — the LLM route is *configured* to this case's stub;
    `DEEPSEEK_API_KEY` is the verified `apiKeyEnv` of the
    `dsh-llm-deepseek-api-key` adapter: the child can offer only the synthetic
    per-run key, asserted over every recorded request, not just the main turn.
  - `DEEPSEEK_SEARCH_BASE_URL` is deliberately not set: if the model ever calls
    the web_search tool, that requests the public DeepSeek search endpoint —
    now block-and-record instead of reaching it (egress guard below).
- **Telemetry opt-out is real and composition-verified.** **[corrected]** The
  first edition listed `DSH_TELEMETRY_DISABLED=1` as an environment promise.
  It is actually the verified rc.2 launcher switch:
  `@deepseek-ai/dsh-app-boot`'s `resolveTelemetryPatch()` turns ANY non-empty
  value into a boot patch setting `disabled: true` on the
  `session-telemetry-otel` row (the row whose default exporter URL is an
  external collector). Two evidence layers now assert this: (a) each fixture
  overlay ALSO carries the row disable directly through the verified patch
  dialect, and the per-case `--dump-config` output shows
  `- id: session-telemetry-otel / … / disabled: true` in the composed tree;
  (b) the egress guard would record + deny any export attempt.
- **`DSH_PERMISSION_MODE=workspace-write`** is verified rc.2 (read by the
  `sandbox-policy`/`permission`/`approval` rows of dsh-base); `DSH_TOOLS_MODE`
  is deliberately unset (the headless bundle binds it verbatim into the `tools`
  row; an empty string is not a valid tools mode).
- **Egress deny guard (fixture-only, added this pass)**
  `fixtures/v02-runtime/egress-guard.mjs`, loaded in the child through
  `NODE_OPTIONS="--import …"`. Fails closed without its log path; on boot it
  self-tests its own layers and records everything to
  `egress-run-<n>.jsonl` inside the case dir. Layers: `node:dns` (non-loopback
  hostnames never resolve or query a nameserver), `node:net`
  (`Socket.prototype.connect` + connect/createConnection surface; IP literals
  die before an FD exists), `node:dgram`, `node:http`/`node:https` request
  surface, and `globalThis.fetch` — which is the documented DeepSeek Messages
  transport of the rc.2 LLM adapter. Per-run strict assertions: guard booted,
  selftest all-layers-armed, zero blocked attempts, zero failed patches, and
  every allowed outbound connect targeted exactly this run's stub port.
- **Temp ownership/cleanup**: unique per-case dir with owner marker; deletion
  happens only when every strict gate in the case passed (xpass or failure keep
  the dir), is restricted to the realpath of `fixtures/v02-runtime/temp/`, and
  requires the marker. No cleanup outside that rooted path.

## Gate coverage and results

### case1 — mount + extraction lane (fresh home, no seeded memory)
30 strict gates pass, plus 3 explicit defect gates (expected-failing). Strict
highlights:
- composed tree (dump-config) contains the plugin row AND the disabled
  telemetry row; the mount survives a full profile boot.
- the first main model request is a single direct user turn **without any
  recall block** (nothing silently invented from an empty store).
- an extraction aux call occurred on flush drain (system prompt
  `"long-term memory extractor"`, one `User: …` prompt, route
  `deepseek-official/deepseek-flash`).
- the task is logged in the canonical session log (`session.v4.jsonl.zstd`
  decoded with node zlib) as `user/message` with `source.kind === "user"`.
- egress: guard selftest armed, `0 blocked`, every outbound connect → stub.
- every provider request carried the synthetic key only.
Defect gates (XFAIL, Phase B tracked):
- D1a durable insert lost to the plugin store close race on dispose
  (`extract failed … database is not open` on stderr of an exit-0 run).
- D1b cursor must consume the captured range after a paid provider call
  (currently `processed_seq=0, pending_seq=17`).
- D1c the plugin's unmount drain must complete without a stderr drain error
  (replaces the first edition's "exit 0 through effect-owned disposers" →
  "safe unmount" reading; exit 0 is NOT accepted as unmount evidence anymore).

### case2 — first-request recall, native resume, native fork (51 strict + 2 XFAIL)
Strict:
- run A's first provider request contains the seed recall verbatim, as the last
  user message, no mid-history recall block; store logged exactly one
  attributed `dsh-self-improved` snapshot event with a `long-term-memory-recall`
  section carrying the seed, logged after the task event; `access_count` bumps.
- native resume restores run-A history with the run-A recall in the prefix and
  no duplicate recall block inside the new turn; fork child makes its own
  provider request under its own session id, inherits parent history,
  captures no inherited parent evidence and captures its own output; the store
  ends with exactly the one memory.
- per-run child env + egress: env keys are allowlist-only, the only credential variable is the synthetic per-run key, the provider route is the loopback stub, the launcher values for telemetry/permission are the verified rc.2 keys; guard selftest armed, zero blocked attempts, every outbound connect → stub.
XFAIL defect gates (tracked, Phase B):
- D2 resumed run must not re-append already-captured run-A events
  (currently `direct-human slice rows=3` for 2 unique turns).
- D3 recall snapshots must not duplicate in the slice store on resume
  (currently 3 injected rows for 2 turns).

### case3-row / case3-config — disabled mounts stay inert (24 strict each)
- **[corrected]** The first edition's row-disabled overlay targeted the row by
  id with no `insert` layer of its own. On rc.2 a patch that targets an id not
  in the composition is skipped with an `entry … not found` warning
  (verified: such a dump prints the warning, and the plugin row is absent) —
  that first fixture therefore exercised "no plugin mounted at all", not the
  disable semantics. The reworked `case3-row` INSERTS the row with
  `disabled: true` in the same overlay (verified dialect): the dump-config
  output shows the composed row itself carrying `disabled: true`, and the run
  still mounts nothing (zero plugin log lines, one main request, no recall, no
  extractor call, no slice files, `access_count` untouched).
- Config-disabled (`enabled: false`) gate is unchanged in behavior: mounts, is
  inert (no pre-step, no capture, no state rows), seed untouched; now with
  additionally asserted composition (plugin row present, telemetry row
  disabled in the fixture composition).

### case4 — accepted-job quiescence across an unmount (71 strict + 1 XFAIL)
New gate, motivated by "accepted extraction insert fails at shutdown":
- run A mounts the plugin with capture on and **extraction module disabled
  by config** — the flush accepts (persists) a pending extraction range with
  `pending_seq > 0, processed_seq = 0` and no aux call.
- run B: the row is UNMOUNTED (inserted-with-disabled row) over the same home
  and the same session is resumed: exit 0, no aux call, no recall wire traffic,
  cursor untouched, slice files byte-identical, memory rows and
  `access_count` untouched.
- run C: same over a config-disabled (mounted but inert) mount — identical
  quiescence assertions.
- run D: a re-enabled mount drains the previously accepted job on its first
  flush (strict, positive continuity direction) — and the cursor-consumed
  assertion after that drain is the tracked XFAIL (same commit-ordering race
  as case1; also visible as the recapture-defect inflating `pending_seq`).
- In-process mount→disable is **not possible through supported rc.2 headless
  APIs**, recorded as a scoped limitation (see below), not silently dropped:
  `dsh-hmr` needs `loader.internal` ("--expose-internals is required for HMR
  service") — the headless CLI never wires that, and the headless bundle
  disables the hmr row; the profile-HMR branch additionally requires
  `profileContext` + `appReady`, neither of which exists in a headless boot;
  `plugin-manager` and `config-editor` rows are disabled without
  `profileContext`. The supported lifecycle boundary is what case4 asserts:
  unmount happens across runs, and the accepted job is neither executed nor
  disturbed by the unmounted/inert process.

### case5 — in-process defect probes on the built lib (3 strict + 1 XFAIL)
Direct, deterministic probe of the tracked 30 s pump gap (D4) against
`lib/extract.js` + `lib/storage.js` in-process (no runtime process, no stub):
- strict: first pump of a fresh process reaches the extractor and consumes the
  marked range (cursor 2→2).
- XFAIL: a second flush within `MIN_PUMP_INTERVAL_MS` (30 s) that marks a new
  pending range must still drain — currently the pump returns early
  (`sessions: 0`) and the accepted range stays unconsumed
  (`processed_seq=2, pending_seq=4`). In the runtime this is why case1 needs
  the artificial 31 s first-turn delay to prove the drain path at all.

## Defects observed (tracked for the runtime source owners — workflow-3 after its current build)

All reproduce with `--keep`; the gates above encode each fixed behavior and go
XPASS (suite failure, reclassification required) the moment the defect is
fixed, so the tracking cannot silently rot:

1. **D1 — extraction drain loses the provider-validated insert to the plugin
   store close race.** `store.close()` from the "shutdown drain + store close"
   disposer runs concurrently with the awaited flush pump in rc.2's
   run-final flush; insertion then throws `database is not open`. Gated in
   case1 (3 gates) and case4 (1 gate). Belongs to the MIGRATION-V0.2.md Phase B
   "consumed-range jobs + transactional acknowledgment / commit ordering" work.
2. **D2 — native resume recaptures already-captured events**:
   `installCapture`'s floor is process-local (`lastWritten`) and there is no
   store-backed capture cursor; observed as duplicate slice rows over resume
   (case2). "Durable capture floor / source dedup" gate stays.
3. **D3 — recall snapshot rows duplicate on resume** as a consequence of D2
   (case2). Injection on the resumed turn itself is correct and asserted.
4. **D4 — extraction pump's 30 s in-process gap** (`MIN_PUMP_INTERVAL_MS`)
   drops the accepted range of a second same-process flush inside the window;
   long/first-turn ~0 s runs skip the run-final drain entirely (probe in
   case5; the case1 fixture currently must delay the first response by 31 s to
   exercise drain at all). Revisit `flushDrain` semantics in Phase B.

## Explicit limitations (honest scope)

- **The egress guard is a Node-API-layer guard, not an OS network namespace.**
  Hostname and IP-literal outbound attempts, fetch URLs, and unconnected-code
  transports through `node:dns/net/dgram/http/https/globalThis.fetch` are
  blocked and recorded (self-tested in every run); native!!, raw-FD, worker
  threads that reset `NODE_OPTIONS`, and any subprocess launched without it
  are beyond its surface. Nothing in the fixture or the plugin's observed
  runtime path uses such a facility. The honest claim is: *the runtime child
  attempted only the case's loopback stub port through all observable Node
  transports within its coverage, and every non-loopback attempt would have
  been denied and recorded* — plus the composition-level disable of the one
  auto-initiating external row (telemetry) and the verified synthetic routing
  of `DEEPSEEK_BASE_URL`/`DEEPSEEK_API_KEY`. No external provider request and
  no real credential is ever placed in a child environment (asserted by
  parsing each run's `invocation.json` env allowlist values).
- **`DSH_TELEMETRY_DISABLED` is verified as a launcher-level switch** exported
  by `@deepseek-ai/dsh-app-boot` (`resolveTelemetryPatch`), but rc.2 does not
  render launcher patches in `--dump-config` output; the composition-level
  disable is therefore verified through our own overlay (dump shows the row
  disabled), with the launcher switch identical in spirit (same patch shape).
- **Fiber-level unmount telemetry** is not observable from outside a process
  on rc.2's headless surface, and no supported in-process mount→disable API
  exists (see case4 limitation notes). Unmount evidence here is behavioral:
  the disabled-row composition does not mount (dump-config + banner/route
  absence), accepted jobs are neither executed nor disturbed by unmounted or
  inert processes, and drain health is asserted against the actual store and
  stderr, not against exit 0.
- **Recall relevance gating is not measured.** Queries share ≥ 2 topical
  tokens with the seed (jieba topical-token gate). A divergent query
  legitimately yields nothing (verified once: "Recall check again…" injected
  no recall block).
- The typed business Remote / stale-settings gate remains the Phase A UI
  worker's scaffolding; the plugin's browser channel is inert/fail-closed on
  rc.2 ("no plugin-owned namespace" observed), which is *not* counted as a
  passed gate here.
- No compatibility exemption was created or needed; peers resolve to exact
  rc.2 via the shadow symlinks, checked at every run start.
- HTML/GUI, volatile-Config on-change behavior, and multi-run overlap during
  the src owner's edits: the suite mounts the hash-pinned shadow built once
  per invocation; if the worker rebuilds, rerun to re-pin (the suite reports
  `CHANGED during suite` when it detects it).
- Observed at every mount: node SQLite experimental warning (host toolchain)
  and the plugin's self-reported inert browser channel. No new ad-hoc session
  event types were required by the runtime path: capture/recall reuse
  canonical `user/message` and derived snapshot sources only (verified in the
  decoded session logs).

## Mining note for the Phase A source worker (workflow-3)

The runs mounted your current built lib and every strict gate passed. The
concrete fix list remains unchanged from the first edition, now with exact
reproducing gates: D1 = case1 D1a/D1b/D1c + case4 cursor gate (flushDrain
commit ordering vs Store close on dispose), D2/D3 = case2 gates (durable
capture floor + source dedup), D4 = case5 probe (pump throttle vs accepted
range). The suite's XFAIL gates turning XPASS is the signal that the fix
landed; rerun this suite and the gate semantics will force reclassification.
