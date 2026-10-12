# MIGRATION-REMOTE-CANCELLATION — Phase A: the review-lane Remote cancellation gate

Author: the Phase A remote-cancellation worker. Scope honored: edits ONLY the
review-lane signal half (src/business.ts, src/index.ts, src/commands.ts dep
type, one new suite, this file). NO UI/client/manifest/importer/runtime-fixture
or parent mounted-runner edits; NO Git commits/staging; NO profile install
settings writes; NO production data; NO external model requests; NO
compatibility exemptions; NO skills activation. The GUI (`127.0.0.1:3082`) and
the parent's mounted-runner fixture server (port 37771) were never referenced.
No background server was left running by this pass (none was started).

Closes the mounted-UI report's remaining gate **D2** ("Mid-flight cancellation
of a long-running business call … remains unit-verified only · there is no slow
endpoint in the fixture to abort in mid-run"): there is now a genuine
Gateway-dispatched LONG-call mid-flight cancel fixture, and the source gap that
prevented a carrier cancel from stopping the aux work is fixed in the real
wiring, not only asserted at the wire.

## 1. Contracts actually verified in the installed rc.2 runtime (read-only)

Runtime: `/home/bahman/github/dsh-v0.2` = rc.2 (gateway installed as
`0.2.0-rc.2`; plugin manifest peers pin `^0.2.0-rc.2`).

1. **The trailing `signal` parameter is NOT luck — it is a declared SRC
   contract.** `dsh-typert-protocol` `InvocationDescriptor.cancellation` wires
   "Transport cancellation injected after business parameters instead of
   entering wire args" onto "Reserved final Host method parameter: 'signal'".
   The Gateway's SRC descriptor derivation (`resolveSrcDescriptor` →
   `srcDescriptor`) literally requires a parameter named `signal` to be final
   (`signalIndex … !== names.length - 1` → `gateway/signature-invalid`) and
   declares `cancellation` when present.
2. **Dispatch actually pushes the carrier signal.** `prepareInvocation`
   (dsh-api-gateway `lib/types/index.js`): builds `const signal =
   methodSignal(request, control)`, constructs `GatewayInvocation`(peer, …,
   signal) and — for `descriptor.cancellation !== undefined` — executes
   `args.push(signal)` as the method's final argument. `invokePrepared` runs
   the method and maps ANY settle failure of a settled-aborted invocation to
   `RemoteError('gateway/cancelled', …)`.
3. **`this.ctx.invocation.signal` is the SAME signal** (`receiverContext.extend
   ({ invocation })`; `RemoteInvocation.signal` = "Carrier cancellation: Client
   cancel, socket close, or an uplink failure"). For unary HTTP RPC the carrier
   is the connection's Fetch `request.signal` passed verbatim:
   `rpcFetchHandler → dispatchRpc(endpoint, payload, signal, peer)` — so a
   client cancel/disconnect aborts the streaming request mid-flight. (The
   mounted-UI ledger A9 pre-aborted case only ever proved the BEFORE side.)
4. **Aux transport contract.** `dsh-llm` `LlmRuntime.stream(options)`:
   "implementations must honor `options.signal`"
   (`GenerateOptions.signal?: AbortSignal`) — the abort is a REAL transport
   instruction, not a warning lane.
5. **Auth scope (label).** All loopback connections on this deployment are
   admitted as ONE logical `OperatorPeer` (`HostConnectionService.admit`
   returns the server-wide operator peer; mounted-UI ledger A10), so the
   fixture's in-process `dispatchRpc` peer (`this.inProcessOperator`) is the
   same logical operator authority as a mounted browser call. The
   args+peer-bound one-shot handshake verification below therefore proves the
   TOKEN semantics against the logical operator, not per-connection peer
   binding (that host design question remains open, coordinator-owned).

## 2. The confirmed source gap (before this pass)

- `MemoryBusinessDeps.episodeDryReview` was `() => Promise<unknown> | null`
  and `business.dryReview` called it WITHOUT the per-call signal; the only
  observance was `assertNotAborted` before/after the whole awaited run
  (business.ts pe-fix lines 390–401). A Gateway-dispatched mid-flight cancel
  therefore could not stop the runner or the provider transport: the call
  failed AFTER the aux work was paid for — until then the review lane only
  carried `episodeReviewGate.getSignal()` (consent/shutdown), with NO per-call
  timeout union on this lane either.
- The command lane (`/memory episode-review`) and the scheduled lane borrowed
  their behavior from the same runner; a no-carrier path was (and remains) the
  safe baseline that must not regress.

## 3. The fix (owned files only)

1. **src/business.ts** — `episodeDryReview?: ((signal: AbortSignal | undefined)
   => Promise<unknown> | null) | null`; `dryReview` FORWARDS the call's signal
   (`deps.episodeDryReview?.(signal)`). Pre/post `assertNotAborted` checks are
   retained: refusal before start, and a post-cancel race can never RETURN a
   settle (a completed-while-cancelled summary is discarded, so no postcancel
   result commit). Header documents the verified dispatch facts above.
2. **src/index.ts** — `episodeReviewRun(dry, callSignal?)`:
   `laneSignal = combineAbortSignals(callSignal, episodeReviewGate.getSignal())`
   — the carrier is UNIONED with the plugin-owned consent gate (never a
   replacement): a per-call cancel stops ONLY its own pass (the shared gate is
   not tripped), while disabling consent still cancels every queued/in-flight
   pass. The aux LLM call closure is factored into `episodeReviewAuxCall`,
   which unions lane ⊕ `shutdownDeadlineGate.signal` ⊕ ONE per-call
   `AbortSignal.timeout(180_000)` created PER CALL and reaches the genuine
   `GenerateOptions.signal` (mapped to the pre-existing 180 s bound of the
   consolidation/skills lanes). `fullReview` (scheduled/manual) reuses the same
   per-call transport while keeping its no-carrier gate-only lane signal — the
   shared command/no-carrier path gains only the pre-existing-style bounded
   timeout, nothing else changed. Both business-dep wiring sites now pass the
   signal through (`episodeDryReview: (callSignal) => … episodeReviewRun(true,
   callSignal)`).
3. **src/commands.ts** — legacy browser channel dep type updated to the
   signed `(signal?: AbortSignal)` gate runner; the legacy channel passes
   `undefined` (it has no carrier cancellation), so its review action remains
   bounded exactly like the command lane. The legacy channel is fail-closed
   inert on rc.2; no behavioral change there.

## 4. New focused suite: `scripts/test-v02-remote-cancellation.mjs`

Owner-marked temp dirs (real SQLite stores, guarded cleanup refuses any path
without the owner marker); process-exit cleanup kept two prior evidence-free
probe dirs from ever leaking (verified: no `/tmp/dsi-v02-remote-cancellation-*`
survives). **3/3 PASS** on the current build pin below.

- **A1 business-level forwarding.** The genuine `createMemoryBusiness` hands
  the runner the caller's EXACT signal (Object.is identity — not a copy, not a
  stand-in). A native cancellable delegate that obeys the signal: a mid-flight
  carrier cancel rejects the call with the SAME reason object; the aux
  delegate stopped mid-flight; no settle was produced. Token semantics: the
  cancelled call burned its one-shot token EXACTLY once (replay refused).
- **A2 no-carrier safety.** Command lane (`source: "command"`, no signal)
  still resolves a summary; the runner observes `undefined` as the signal
  (consent/shutdown continue to bind runner-side). Shared command/no-carrier
  path unchanged and safe.
- **B (the gate): genuine mid-flight Gateway cancel, full production wiring.**
  Seeds a real succeeded episode; boots the GENUINE plugin through the genuine
  rc.2 Loader (business remote registration log asserted); mounts the genuine
  `TypertRegistry` + `TypertGatewayService` over the same tree; dispatches
  `selfImproved/prepareMutation` → `selfImproved/dryReview` with an abortable
  carrier (the exact face of a real POST `/api/selfImproved/dryReview`,
  operator-peer scope), and cancels WHILE the delayed synthetic provider is
  mid-stream (a deterministic latch aborts after two streamed deltas — one
  fully emitted, the next pending — no timer-race flakiness). Asserts:
  - **invocation abort**: dispatch settles `{ok:false,
    error.code:"gateway/cancelled"}`;
  - **aux transport quiescence**: the provider request observed the abort
    through the real signal chain with the SAME caller-cancel reason string
    (carrier → business → runner union → `GenerateOptions.signal`, one
    combined signal per call), at least one delta streamed before the cancel
    (genuinely mid-flight), zero deltas recorded at any millisecond strictly
    after the abort, the delta count frozen after settle, NO finish chunk on
    the aborted request, stream iterator unwound — and the cancel spawned NO
    replacement stream (exactly one provider request; no retry storm);
  - **no postcancel result commit**: the dry-run invariant holds — episode
    stays `succeeded` with `reviewed_at` NULL, evidence rows untouched, no
    derived `must never commit` memory — and this also holds AFTER the later
    valid pass (validateOnly never persists);
  - **token semantics**: (a) the cancelled token replays → `self-improved/`
    `rejected` (consumed exactly once), (b) a pre-aborted dispatch →
    `gateway/cancelled` at the wire WITHOUT a provider request and its token
    stays usable (mounted-UI ledger A9 parity, now gateway-level), (c) the
    same "refused-to-burn" token authorizes a live retry which returns a
    genuine dry-run summary envelope;
  - **unrelated survival**: a concurrent `snapshot` completes WHILE the long
    review streams; after the cancel an authorized `forget` mutation commits;
    and the fast retry pass ran with its own full minimized-review semantics —
    the per-call cancel never tripped the shared consent gate (`getSignal()`
    would have refused; the pass would have aborted — instead it processed
    the seeded candidate);
  - genuine-Loader unmount at the end (owned shutdown drain joins the
    accepted review jobs before close; no store close under running work).

Notes on honesty: the provider face is an in-process delayed adapter that
implements the `llm.stream(GenerateOptions)` contract (signal honoring per
the rc.2 statement quoted above) rather than a network socket; the DISPATCH
face is the genuine Gateway class (`dispatchRpc`), which is precisely what the
connection's HTTP fetch adapter calls with the real `request.signal` as its
third argument. No socket was bound, so no isolated-ephemeral-port server was
needed and nothing could be left running in a child lifetime.

## 5. Build + regression battery (this pass)

Build: `node scripts/typecheck-v02.mjs --emit-lib` — strict rc.2 typecheck
PASSED (exactly-validated contract set: cordis@4.0.4, loader@1.0.5, the
rc.2 dsh-* set); lib re-emitted. Hashes:

| artifact | sha256 (prefix) |
|---|---|
| lib/index.js | `4272b673e8646109d973ba50aa90a368240e9a389e4a1ffe7126b5d6224aca56` |
| lib/business.js | `7d532778970527d260af8505105ef4d5af590a721408c6bcdbf148d922ab0af7` |
| client.js (untouched) | `64ed3265ed33d22c7d6d976d559e4a89ec372c767f8b9ef860365e3c34b71ba8` |
| src/business.ts | `9b3fc9b67f9d0a7a984f15ad666950ac95c36241195cbe8bc803400cd2b1e9ee` |
| src/index.ts | `c708ef941c5ddf7fe32b2c63effc09f4e1047434959ee41ea0aac100c820ff66` |
| src/commands.ts | `2008b611a2acaa0f2d8967d94789ca29bd72b7a6a7964db34357b41648bfc91a` |
| scripts/test-v02-remote-cancellation.mjs | `3e7e27efdbb8bd2f9b2e3ab3eef2b50dc44b6a2467309d5c517b943f617f1569` |

Battery on the fresh build — exit 0:

- test-phase-a, test-v02-safety, test-commands, test-recall, test-hermes,
  test-storage, test-redact, test-episodes, test-episode-review, test-evolve,
  test-extract, test-audit-skills, test-episode-rollout,
  test-user-edit-preservation, test-v02-shutdown-safety,
  test-v02-shutdown-timeout, test-v02-typecheck-modes (21/0 STRICT),
  test-migration-v02 (44/0), test-v02-settings (14/14), test-v02-client-smoke,
  test-settings-ui, test-v02-package (59/0 STRICT — after re-pointing my only
  source-comment mention to avoid tripping the manifest-coverage scanner, NO
  peer/manifest edits), test-v02-runtime (STRICT; build pin stable across its
  suite: `5f6313f469ad8323…`). The new suite: 3/3.

Kept-open Phase B regressions (documented earlier, NOT touched by this pass,
verified to fail with the SAME documented lists rather than changed lists):

- `scripts/test-v02-capture-privacy.mjs` — ordinary-lane persistence privacy
  (synthetic credential reaching persistence in user/assistant/tool lanes):
  still FAIL as documented (Phase B data-minimization lane).
- `scripts/test-v02-revocation.mjs` — corrected eligible evidence + pause-
  during-retrieval late admission: still FAIL as documented (Phase B recall-
  revision invalidation lane). The suppressed-stale-re-emission control passes.
- Per instructions "existingregressions required": these two remain open
  on purpose; fixing them is out of this worker's mandate.

## 6. Not claimed by this pass

1. A physical loopback HTTP provider socket / profile server — the fixture is
   socket-free by design (see §4 note); the provider face's external-but-
   HTTP semantics can be added later without changing any assertion here.
2. Per-connection browser peer discrimination on the loopback deployment
   (mounted-UI A10) — host design question, unchanged.
3. Quality-of-life cancellation UX on the browser page itself (client-side
   abort affordances) — UI/client file untouched by scope.
4. Phase B durability/privacy/cache work listed in §5 remains deliberately
   open (capture privacy, recall revocation, plus the earlier durability
   items in MIGRATION-V0.2.md).
