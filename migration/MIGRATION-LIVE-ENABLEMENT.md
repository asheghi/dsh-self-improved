# Live enablement runbook (reversible)

**Status: deployment is gated, not approved or executed.** The plugin now runs on stock DSH `0.2.1-rc.2` and its continuity auth uses the Host's own Peer model ([0.2.1 port](<MIGRATION-DSH-0.2.1-PORT.md>)); no runtime patch or runtime cutover is needed. **The governing migration plan's Phase E real-learning gate is recorded UNMET by the user's explicit finalization decision; further efficacy attempts are intentionally not authorized.** Nothing in this document has been executed against a live profile. If a verification fails, stop; do not proceed or improvise.

Runtime prerequisites: DSH `0.2.1-rc.2` or later in the 0.2.1 line, matching the exact peer pins in `package.json` (`DSH_RUNTIME_RC2=<runtime> node scripts/typecheck-v02.mjs`). Do not enable it against a different runtime without re-running that check. Pre-0.2.1 runtimes keep continuity disabled (fail closed).

## Step 0 — Decide, because two of these are consents, not settings

| Lane | What it does | What leaves the machine |
| --- | --- | --- |
| `continuity.enabled` | native structural continuity: durable references, handoff rows, the operator door | nothing |
| `continuity.summaryEnabled` | the bounded handoff worker | bounded excerpts of your own session text → your configured provider |
| `episodeLearning.enabled` | episode capture, skill drafts | nothing by itself; skill **activation** is manual only |

Both continuity flags and `episodeLearning.enabled` default to **false**, and the summary consent is independent of the structural one: turning continuity on does not turn provider transfer on. Agree to `summaryEnabled` only if you accept the transfer in the middle column.

**Runtime auth gate:** DSH 0.2.1 admits `/api` only with a signed cookie, refuses any invocation without a live Peer, and stamps owner prompts. The plugin requires an owner Peer for Continue and an owner-sourced prompt for capture, and fails closed on older runtimes. Never run a runtime with browser authentication disabled (the old local `dsh-v0.2` test instance had it disabled by a local patch). In-process plugins are trusted, as in DSH itself.

## Step 1 — Inventory (read-only; write nothing yet)

1. `plugin_manager` → `list_bundles` and `list_plugins`. Record the **profile name**, whether `dsh-self-improved` is already present, and its `enabled` / `fiberPhase`.
2. Confirm the runtime is the pinned one (`dsh --version`) and record it.
3. Record the exact profile composition and package/lock metadata paths. Supported installation can change this recoverable profile snapshot beyond the patch file alone; back up the coherent set before any write.
4. Record the current values of the three flags above (all are expected to be default/false). If any is already true, this profile has been configured before — stop and reconcile before continuing.
5. Record where the plugin will start writing: `<DSH_HOME>/memory` (memory DB and journal) and `<DSH_HOME>/skills`. Note that **skill activation writes no files at all** — learned skills are runtime registrations, so there is nothing on disk to clean up later.

## Step 2 — Back up before any write

1. Obtain the required profile/filesystem approval and record the exact resolved source and backup paths. Quiesce every Host and other store writer and verify exclusive ownership before copying or restoring any SQLite store; copying an actively written directory is not a verified consistent backup.
2. Back up the profile composition and package/lock metadata as one recoverable profile snapshot; record hashes. Preserve preexisting user edits. Package installation affects more than the patch file alone.
3. If `<DSH_HOME>/memory` exists, back up the whole quiesced directory, including SQLite sidecars and the journal; record hashes and verify the backup can reopen in an isolated restore test. Never run an older plugin against a newer schema.
4. Keep the verified backup and inventory receipt. A full restore requires its own reviewed, approved, quiesced procedure; do not overwrite live files or silently merge incompatible generations.

## Step 3 — Install with EVERYTHING still off

The package declares `dsh.bundle.patch` (`cordis.patch.yml`), which inserts one loader row (`id: dsh-self-improved`, `name: dsh-self-improved`). So this is a normal bundle install — no hand-edited YAML:

- Use `plugin_manager` `install_bundle` with the absolute local package directory after approval. Inspect its `application` and `warnings` fields and verify the mounted registration; installation can require approval for build scripts.
- Never hand-edit the profile patch or package metadata and never run a package manager in the profile directory. If supported installation is unavailable, stop and resolve that dependency.

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
- **Full revert:** obtain explicit approval, stop all store/profile writers, verify exclusive ownership and resolved restore targets, then restore the verified compatible profile snapshot and memory backup from Step 2. Validate schema/plugin compatibility and an isolated reopen before restarting the live Host. Do not blindly overwrite user edits or restore only the patch while leaving changed package metadata.
- **What persists after disable/uninstall:** memory rows, episodes, event rows and skill drafts remain unless explicitly purged (`/memory forget`, `/memory episode-purge`). A full snapshot restore can replace post-backup data: preserve the current generation separately under the approved restore procedure before replacing it. Logical revocation is not physical erasure of historical bytes.

## Limits to keep in mind while using it

- **No measurement claim.** Nothing in this plugin proves it helped. Counts of offers, handoffs, injections or activations are not task success; the measurement gate is unmet by design (the harness exists, the run has not been done).
- **Scoped browser evidence.** The actual isolated Chromium battery now passes keyboard focus/tab navigation, narrow layout, light/dark, save-conflict, unsaved-draft and destructive-confirmation checks; see [browser receipt](<MIGRATION-BROWSER-REPORT.json>). This is not full accessibility coverage or a test of your live profile.
- **Best-effort redaction, not secret detection.** Do not rely on the plugin to keep credentials out of captured text.
- **Project scope derives from the session's working directory.** Verify per project rather than assuming.
