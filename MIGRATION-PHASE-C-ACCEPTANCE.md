# Phase C isolated/mounted acceptance

## Decision

**ACCEPTED for the isolated and mounted implementation boundary, including the scoped rendered browser battery below. Host-authenticated unary ingress is now accepted for the private copied-core candidate only, under the scoped decision below; installed-runtime and live-cutover acceptance remain OPEN.** Phase A, B and D remain accepted in isolation; Phase E is built end to end but its measurement gate is unmet (see [Phase D acceptance](MIGRATION-PHASE-D-ACCEPTANCE.md) for that pattern and [MIGRATION-V0.2.md](MIGRATION-V0.2.md) for the governing status).

What this accepts: native structural continuity, durable references, the bounded source-backed handoff worker, the operator-door Continue path, project isolation, restart durability, and inherited-fork non-inflation — each measured on a real host over the real gateway, not inferred from unit fixtures.

This explicitly does NOT accept a live-profile cutover or any claim that the installed loopback API is an authenticated boundary (see the boundary section). The scoped rendered-page battery is now separately evidenced below.

## Finalization decision: scoped unary Host ingress

Parent accepts the private candidate's named unary authenticated ingress/capture/Continue/restart boundary based on genuine signed-cookie HTTP, actual main-plugin native capture, separate-process restart, direct-Gateway authority spoof refusal, finalized receipt replay/copy refusal, actual-offer cross-target/cross-job and concurrent-spend/replay tests, plus independent scoped code review. Exact commands, fixture identities and evidence mapping are in [the Host receipt audit](<MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md#L66-L101>). The fresh Chromium battery matches current Host/client artifacts.

This accepts authenticated operator intent through a reviewed request and one-use confirmation, not proof of physical presence. Streaming authority is denied. Focused tests, not whole-Host writable-settings fixtures, supply policy ABA/held-delivery cancellation evidence; that integration limitation is retained explicitly. Public declaration contracts pass with the existing source-strict/dependency-skip policy. No live package, profile, store or consent was changed. Real Phase E evaluation and approved reversible deployment remain separate unmet gates.

## Gate item → evidence

Gate items are quoted from the plan's Phase C gate list. Every number below comes from a run recorded in this repository or from a committed suite that can be re-run; the mounted suites need an isolated host (`DSI_E2E_CONTINUITY=1 node scripts/test-v02-mounted-ui.mjs up --fresh`) and take `--base`/`--token`.

**1. "Ending a session does not discard its useful work: an unfinished task can be continued."**
Historical `test-v02-continuity-e2e-mounted.mjs` drives the whole lane: `session/create{cwd}` → `session/prompt` (a synthetic operator-shaped request, not authenticated-human provenance) → the plugin captures the turn, claims the durable human boundary and runs its **real** handoff worker against the loopback provider stub → a second session in the same project is offered the first one's handoff → `prepareContinue`/`continueSession` return the bounded notes through the operator door → the reviewed notes are accepted into the target session. **21/21 PASS**, reproduced on independent runs. The provider log shows the worker's own calls, so this is the real path.

**2. "A new same-project session offers appropriate unfinished work."**
Same suite: `the session just prompted is offered to the new session`, `the offer names the session that actually has the unfinished work`. Consent is required for the lane to run at all: with the lane off, the inventory answers `disabled` and offers nothing (covered by `test-v02-continuity-inventory-ui.mjs`, 8/8).

**3. "Unrelated projects see nothing."**
Same suite, both directions: a second source/target pair in an unrelated project directory is offered **its own** work while neither project ever sees the other's (`an unrelated project's session is never offered across projects`), and the second project's notes quote only its own session (`the unrelated project's notes quote only its own session`).

**4. "Inherited forks do not inflate evidence."**
Same suite: `an inherited fork is never offered as unfinished work of its own` while `the parent session is still offered after the fork`; provider traffic across the fork measured 0 calls in an 8s window (reported, not gated).

**5. "Close/reopen the same session and restart the host without losing committed progress."**
`test-v02-continuity-restart-mounted.mjs`, two phases against one isolated home: phase 1 produces a real handoff and records the durable anchors (**5/5**), the server is killed and a new one started on the same home with a new pid/origin (**8/8**): the handoff row, policy generation and consent survived, the same work is still offered, the door still returns the same notes, and the restarted host still accepts the reviewed handoff.

**6. "No task resumes without human intent."**
The door is the ONLY way to read notes or continue: `test-v02-continuity-continue-door.mjs` (**4/4**) refuses the command lane, peer-less callers, missing/replayed/relayed confirms and cross-offer spends before any body is read; `test-v02-continuity-door-mounted.mjs` (**11 gates, 0 FAIL**) proves the same over the real gateway, plus that the served client bundle is the current `client.js` and that the Overview lane status is served without session or project identity.

**7. "Uncertain external actions remain uncertain."**
Handoff notes are rendered as `Partial unverified excerpt [seq N]: …`, the UI labels them untrusted quotes, the device never asserts success, and the send step wraps them in a frame that says they are not instructions and not proof. Covered by the e2e suite's `the notes are labelled as unverified partial excerpts, not success or permission`.

**8. "Explain why code or memory appeared."**
`/memory used` (`src/recall-ledger.ts`, `test-v02-recall-ledger.mjs` 5/5) reports the ids actually rendered into THIS session, the query that produced them and when, bounded to 20 deliveries per session and 50 sessions, with the output itself stating that this is runtime state and not evidence that any memory helped.

**Browser-interaction battery — PASS for the tested isolated rendered boundary.** [Actual Chromium runner](<scripts/test-v02-browser.mjs>) and [owned fixture launcher](<scripts/run-v02-browser.mjs>) bypass the unavailable Chrome MCP without using the live GUI. [Fresh receipt](<MIGRATION-BROWSER-REPORT.json>) records eight passing checks: rendered mount, keyboard focus-visible and tab-arrow navigation, unsaved draft across tabs, two-page stale conflict/rebase/save, narrow viewport overflow, light/dark token rendering, native destructive cancel/accept, and durable settings/forget with no provider requests. The narrow test first exposed real overflow; scoped responsive CSS fixes were verified on a fresh fixture. Parent independently verified the receipt hash matches current client bytes and runner safety guards reject live/external/foreign fixtures. This is not a comprehensive accessibility audit, every control's keyboard test, live-profile acceptance, or authenticated ingress acceptance. The older VM checks remain only component evidence.

## Supporting suites (same run as this document)

| Suite | Result |
| --- | --- |
| `test-v02-continuity-inventory-ui` | 8 gates PASS |
| `test-v02-continuity-continue-door` | 4 gates PASS |
| `test-v02-client-navigation` | 13 gates PASS (VM harness) |
| `test-v02-settings` | 14/14 PASS |
| `test-v02-provider-stub` | 5 gates PASS |
| `test-v02-recall-ledger` | 5 gates PASS |
| `test-v02-continuity-main-worker` | 11/11 PASS (real Loader) |
| `test-v02-safety` | 60/60 PASS |
| `test-phase-a` | PASS |

## Measured boundary (not a claim this plugin can fix)

The installed rc.2 runtime admits **every** loopback `/api` request as the same OperatorPeer: its browser-authentication call is patched off for loopback in this installation, and the mounted probe asserts the running host's actual behaviour (a request with no operator cookie is served identically to one with it). Consequences, stated plainly:

- The historical door separates ordinary tool calls and message-driven plugin paths from a gateway-dispatched operator-shaped request. That is a transport/confirmation distinction only: it does **not** establish "no task resumes without human intent," because a shell-capable caller can use loopback HTTP. Current source adds default-deny Host-verifier admission; its new whole-Host evidence is tracked separately in [the receipt audit](<MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md>).
- The door is **not** an authentication boundary against a process that can open a loopback connection, which on a single-user machine with a shell-capable agent includes the agent itself.
- Closing that needs a Host-issued authenticated receipt, which cannot be built inside this plugin.

## Limits (limits, not waivers)

- **No live-profile cutover.** Nothing was installed, enabled or migrated in a real profile; every fixture home is synthetic and temporary.
- **Browser acceptance is scoped** to the recorded isolated battery above, not comprehensive accessibility or live-profile testing.
- **Notes are best-effort excerpts**, not summaries of verified effects; retention has no global input-size cap beyond the per-row and per-provider budgets.
- **Redaction is best-effort**, not arbitrary-secret detection.
- **Logical revocation is not physical erasure** of historical bytes.
- **No measurement claim** anywhere in this document: counts of offers, handoffs or deliveries are not task success and not improvement.
- **Phase E** is out of scope here; its activation path is built and mounted-verified, its measurement gate is not met.
