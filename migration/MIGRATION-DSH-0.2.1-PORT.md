# Port to DSH 0.2.1 (stock runtime, no Host patch)

Branch `port/dsh-0.2.1`, from `migration/deepseek-harness-v0.2`. Target runtime:
`@deepseek-ai/dsh@0.2.1-rc.2` (npm `next` tag, published 2026-10-17; `latest`
is still `0.2.0-rc.2`). Test site: `~/github/dsh-v0.2.1` (stock install,
nothing patched).

## Why

On rc.2 the continuity lane required a Host-issued prompt receipt and
per-invocation admission proof that only a privately patched Connection,
Gateway and Session controller provided (23 exact-text edits to their compiled
builds). Stock runtimes failed closed, so continuity could not ship.

Two findings changed that:

1. **The rc.2 "loopback `/api` without a cookie" gap was local, not upstream.**
   Published `dsh-client-connection@0.2.0-rc.2` already rejects `/api` without a
   signed cookie. The local `dsh-v0.2` test install carried a hand-applied
   `LOCAL PATCH (dsh-v0.2 test instance): browser authentication disabled`.
2. **0.2.1 ships the Peer model the patch approximated.** The Gateway no longer
   falls back to `request.peer ?? this.operatorPeer()`: every invocation needs
   a live Peer (`assertPeerLive`), each Peer has a `principal` fixed by
   in-process Host code, non-owner principals go through `remoteAccess.decide`,
   and HTTP callers get a Peer only via a signed cookie (`authenticateApi`).
   The Session controller stamps each admitted prompt
   `{kind:'user', rpcId[, clientTimeZone][, principal]}`, writing `principal`
   only for a non-owner caller. Upstream's own `dsh-experimental-auto-review`
   identifies human prompts the same way.

## What changed

- `src/continuity-host-auth-v02.ts` rewritten on supported APIs:
  - Continue/status Remote calls require `ctx.invocation.peer.principal.kind === "owner"`
    on a live Peer (typed `RemoteInvocation`; no casts to private APIs).
  - Capture authority comes from the live `user/message` append whose source is
    the exact owner shape `{kind:'user', rpcId[, clientTimeZone]}`. Any
    `principal` key (non-owner caller) or other source is rejected by the
    existing structural check. Delegated/forked headers stay refused.
  - Authority is process-local and bound to the consent/scope epoch, as before:
    restart or any consent/exclusion change needs a fresh owner prompt.
  - `continuityHostAuthAvailable` checks for the 0.2.1 Connection (`createPeer`);
    pre-0.2.1 runtimes still fail closed.
- Peer pins moved to 0.2.1-rc.2 (`cordis` 4.0.5, `cordis-plugin-loader` 1.0.6,
  `cosmokit` 1.8.6, `schemastery` 3.18.5). `zod` aligned to the Host's exact
  4.4.3, because continuity hands zod schemas to native projections.
- Removed the patched-runtime tooling: `stage-v02-auth-*-candidate`,
  `apply-v02-auth-core-candidate`, `test-v02-auth-{contract,restoration,receipt-core}-candidate`,
  `test-v02-auth-core-cutover-safety`, `auth-receipt-loader-candidate-fixture`.
  `run-v02-auth-runtime-candidate.mjs` became `run-v02-auth-host.mjs` (stock runtime).
- Tests: version pins bumped; fixtures provide a Peer-model `connection` stub
  and owner-prompt sources instead of receipt events; Gateway fixtures pass a
  live owner Peer; `dsh-session-persistence-jsonl` is now a plugin module
  (`apply`), not a default export.

## Trust boundary (accepted)

In-process plugins are trusted, as everywhere in DSH: they can already read
session files and mint an owner Peer. The rc.2 design tried to prove per-message
human intent against in-process callers; that guarantee is dropped. What is
enforced: signed-cookie HTTP admission (Host), no peerless invocation (Host),
owner principal for Continue (plugin), owner-sourced prompt for capture
(plugin), explicit `continuity.enabled` and separate `summaryEnabled` consent.

## Evidence (2026-10-17, `DSH_RUNTIME_RC2=~/github/dsh-v0.2.1`)

- Strict typecheck: PASSED.
- Whole stock Host battery `test-v02-auth-host-mounted`: PASS. Signed-cookie
  dispatch and no-cookie/forged/tampered/wrong-authority/cross-Origin/bearer
  negatives; restart phase 1 (5) and 2 (8) with a new process and origin;
  in-process probe (owner prompt carries no principal, peerless invoke refused,
  non-owner principal refused, disposed Peer refused, live owner Peer admitted);
  actual-offer replay/cross-binding/one-winner spend; operator door 11 gates.
- Continuity: main-worker 11, main-process-restart 9, host-restart 5+12,
  runtime 14, worker 16, owner, runtime-v03 9 and the remaining continuity suites pass.
- Policy lane 35, remote cancellation 3, package gate 59, import gates/audit pass.
- Final regression on the rebuilt `lib/`: all 76 fast suites (memory/core,
  auth lifecycle, every `test-v02-*` except the host-argument fixtures and the
  slow import/policy suites above) exit 0.
- Not run: Chromium browser battery, full acceptance sweep, real provider.

## Remaining before release

- Wait for 0.2.1 to reach `latest`, then re-pin from rc to the release.
- Browser battery against the stock 0.2.1 Host.
- Live enablement per the runbook (no runtime cutover step needed any more).
