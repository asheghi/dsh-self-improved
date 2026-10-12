# Live enablement runbook (reversible)

**Status: a reviewed procedure, not a record of a run.** Nothing in this document has been executed against a live profile. Every step therefore carries its own verification, and every step is reversible. If a verification fails, stop at that step — do not proceed and do not improvise.

Runtime prerequisites: this plugin is pinned to the rc.2 contracts it was built and tested against (`node scripts/typecheck-v02.mjs`). Do not enable it against a different runtime without re-running that check.

## Step 0 — Decide, because two of these are consents, not settings

| Lane | What it does | What leaves the machine |
| --- | --- | --- |
| `continuity.enabled` | native structural continuity: durable references, handoff rows, the operator door | nothing |
| `continuity.summaryEnabled` | the bounded handoff worker | bounded excerpts of your own session text → your configured provider |
| `episodeLearning.enabled` | episode capture, skill drafts | nothing by itself; skill **activation** is manual only |

Both continuity flags and `episodeLearning.enabled` default to **false**, and the summary consent is independent of the structural one: turning continuity on does not turn provider transfer on. Agree to `summaryEnabled` only if you accept the transfer in the middle column.

Standing risk you are also accepting: the rc.2 runtime admits **every** loopback `/api` request as the same operator peer in this installation, so the operator door stops the agent's ordinary paths but not a process that can open a loopback connection. The measured detail is in [MIGRATION-PHASE-C-ACCEPTANCE.md](MIGRATION-PHASE-C-ACCEPTANCE.md).

## Step 1 — Inventory (read-only; write nothing yet)

1. `plugin_manager` → `list_bundles` and `list_plugins`. Record the **profile name**, whether `dsh-self-improved` is already present, and its `enabled` / `fiberPhase`.
2. Confirm the runtime is the pinned one (`dsh --version`) and record it.
3. Record the **profile patch file path** shown for this profile. That file is the only configuration file this procedure will touch, and it is the thing to back up.
4. Record the current values of the three flags above (all are expected to be default/false). If any is already true, this profile has been configured before — stop and reconcile before continuing.
5. Record where the plugin will start writing: `<DSH_HOME>/memory` (memory DB and journal) and `<DSH_HOME>/skills`. Note that **skill activation writes no files at all** — learned skills are runtime registrations, so there is nothing on disk to clean up later.

## Step 2 — Back up before any write

1. Copy the profile patch file to a timestamped backup directory; record its size and hash.
2. If `<DSH_HOME>/memory` exists, copy the whole directory (not only `memory.db`; the journal is part of the store) and record its size.
3. Keep the backup path in your notes. Step "Rollback / full revert" below restores exactly these two things.

## Step 3 — Install with EVERYTHING still off

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), which inserts one loader row (`id: dsh-self-improved`, `name: dsh-self-improved`). So this is a normal bundle install — no hand-edited YAML:

- Preferred: `dsh plugin --profile <profile> add dsh-self-improved` from this checkout (or `plugin_manager` `install_bundle` with the local package spec).
- Do **not** hand-edit the profile patch file unless the install command is unavailable; if you must, insert the same row the shipped patch declares.

**Verify before enabling anything:** `plugin_manager list_plugins` shows the row enabled and its fiber active, and the plugin's own surface reports the lanes as **disabled** (Overview tab, or `/memory status`). No offers, no episodes, no provider calls, no new files under `<DSH_HOME>/memory` beyond an opened store.

If the plugin does not mount, stop here and restore from Step 2. A row that exists but does not mount is not a partial success.

## Step 4 — Enable structural continuity only

1. Set `continuity.enabled = true` and leave `summaryEnabled = false`. This key is volatile, so it hot-applies without a restart; a key that is initialisation-only will say so in the settings UI — believe it rather than restarting to see.
2. Verify: the Overview tab (or `/memory status`) shows the continuity lane enabled with **no provider activity**; `/memory used` starts explaining what recall rendered into a session; the Sessions tab shows no offers until a session actually closes.
3. Let a real session end, then confirm an offer appears for a **same-project** session and that a different project shows nothing.

## Step 5 — Enable provider transfer, only if you decided yes

1. Set `continuity.summaryEnabled = true`.
2. Verify: after a session ends, a handoff appears whose notes are labelled as unverified partial excerpts; the provider call is visible in your provider's own accounting.
3. Verify the stop path, not just the start path: turn it back off and confirm new provider calls stop immediately and no late output is committed. Later re-enabling requires a **fresh** human boundary — the worker will not re-run on an old one.

## Step 6 — Enable episode learning and skills, only if you want them

1. Set `episodeLearning.enabled = true`. Episodes are captured; skill drafts appear bounded (inspect with `/memory skill-drafts`).
2. The flow is deliberate and manual, one draft at a time: `/memory skill-evaluate <draft-id>` → `/memory skill-approve <draft-id>` → `/memory skill-activate <draft-id>`.
3. Verify: `/memory skill-active` lists it with its evaluation state; the Overview tab lists it too. Activation is **user-invocable only** — the model's own catalog never sees it, and a learned skill cannot invoke itself.
4. `/memory skill-rollback <name>` reverses it and records `rolled-back`. If the supporting evidence is later invalidated, the live skill is deactivated and the row keeps the stronger `invalidated` status.

## Rollback

- **Per lane (seconds):** set the flag back to `false`. Structural continuity, the summary lane and episode learning all stop on apply; the summary lane cancels in-flight provider work synchronously and cannot commit late output.
- **Uninstall:** `dsh plugin --profile <profile> remove dsh-self-improved` (or `plugin_manager` `remove_bundle`). Verify the row is gone and that no learned skill remains registered — activation is owned by the plugin fiber, so unloading disposes it automatically.
- **Full revert:** restore the Step 2 backup of the profile patch file, and the `<DSH_HOME>/memory` directory if you want the pre-enablement store back.
- **What persists after any rollback:** memory rows, episodes, event rows and skill drafts stay on disk until you purge them (`/memory forget`, `/memory episode-purge`). Nothing is deleted by disabling a lane, by uninstalling, or by this runbook. Logical revocation is not physical erasure of historical bytes.

## Limits to keep in mind while using it

- **No measurement claim.** Nothing in this plugin proves it helped. Counts of offers, handoffs, injections or activations are not task success; the measurement gate is unmet by design (the harness exists, the run has not been done).
- **Unverified pages.** The rendered-page battery was never run (the browser tooling in this environment answers `Target closed`), so keyboard-only operation, narrow layouts, light/dark, save-conflict and destructive-confirmation behaviour are unverified for the very pages you will use.
- **Best-effort redaction, not secret detection.** Do not rely on the plugin to keep credentials out of captured text.
- **Project scope derives from the session's working directory.** Verify per project rather than assuming.
