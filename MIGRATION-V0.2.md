# DeepSeek Harness v0.2 migration: continuity, memory, and useful learning

Status: review and implementation proposal only. No feature implementation, profile installation, live data migration, or configuration changes have been performed.

## Executive decision

Migrate the useful behavior, not the old wiring or the entire feature inventory.

The product promise is: **ending a session does not discard its useful work.** Resuming the same session restores its history; starting another session can recover relevant project context; verified experience can become reusable knowledge. This is durable memory and evaluated procedural learning—not model-weight training, unrestricted autonomous execution, or permission to rewrite the harness.

The first release should deliver reliable cross-session memory, resumable work summaries, transparent recall, safe import, and approachable controls. Automatic persona regeneration, scene clustering, embeddings, and skill activation are not prerequisites.

## Baseline and scope

- Planning branch: `migration/deepseek-harness-v0.2`, created in the self-improved plugin repository from commit `3a3b1e1`.
- The pre-existing uncommitted [package manifest](<package.json#L38-L51>) already changes DSH peers from `^0.1.0-rc.6` to `^0.2.0-rc.2`. Those edits were preserved, not authored or committed by this review. They are not evidence of API compatibility.
- The target is the installed **0.2.0-rc.2** runtime. Its [test harness manifest](</home/bahman/github/dsh-v0.2/package.json#L1-L9>) declares that dependency. That directory is not a Git source checkout; no upstream commit identity was available there.
- Review used plugin source, installed package declarations/documentation, and live Cordis inspection. The existing GUI at `http://127.0.0.1:3082` was opened read-only, its Settings panel inspected, then closed. No setting was changed. The legacy memory page is not mounted there, so old-page findings below are source findings, not a claimed live reproduction.
- Semantic indexes were absent in both locations. Exact file/search fallback was used; no index was created.
- The existing static settings fixture passed (`node scripts/test-settings-ui.mjs`). It checks source patterns and replayed helper logic, not actual v0.2 mounting, browser interaction, or accessibility. No full compatibility/build result is claimed.
- This document is at the repository root because [the ignore rules](<.gitignore#L10-L12>) exclude the existing documentation directory.

## What is actually useful to bring

### Keep and strengthen

1. **Human-backed memory.** Preserve direct-human provenance, evidence quotes, project/global scopes, unknown-source quarantine, corrections, supersession, and explicit forgetting. [Extraction gates](<src/extract.ts#L225-L309>) and [storage metadata](<src/storage.ts#L25-L98>) already contain substantial useful policy.
2. **Small relevant recall.** Preserve keyword-first search, optional hybrid retrieval, bounded context, current-instruction precedence, and distinct personal/project/operational lanes. Keep retrieval fail-soft without making ingestion failures disappear. [Recall integration](<src/inject.ts#L118-L281>) is a useful behavior specification, not a drop-in adapter.
3. **Reviewed operational learning.** Preserve redaction-before-episode-persistence, exact call pairing, ambiguous/interrupted rejection, citations, expiry, consent, preview, and purge. Enable only after the core migration is proven; this lane must never infer personality or personal preferences.
4. **A user-editable profile.** Keep a small explicit collection of confirmed preferences. Prefer deterministic rendering from structured facts over recurring LLM-generated persona prose.
5. **Reusable skills with provenance.** Preserve inspection, source references, deactivation, and rollback. Change synthesis into draft → evaluation → user activation, rather than writing immediately discoverable instructions.
6. **Governance.** Preserve caps, retirement, export, visibility, and bounded work. Do not make popularity/read count a substitute for evidence or allow time-based decay to retire protected confirmed preferences silently.

### Reuse v0.2 rather than duplicate

- Harness-owned persistence, history, fork lineage, crash repair, and resume. The [persistence contract](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-session-persistence/README.md#L28-L65>) already supplies single-writer handles, durability barriers, and interrupted-turn repair.
- Native session read/search/trace functionality. The [query contract](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-session-query/README.md#L28-L49>) already exposes history and exact inherited-event cuts. Retain a compatibility alias for old conversation-search workflows only if it adds an explicit memory-specific value.
- Session projections and cache for pure log-derived state. The [projection contract](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-session-projection/README.md#L34-L69>) supplies incremental folds, versioned checkpoints, and small client views.
- Config-derived, revisioned settings and profile patch persistence. The [settings contract](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-settings/README.md#L26-L49>) replaces the old registered namespaces.
- Slots, theme tokens, locale, and host layout. Add a Memory & Learning feature, not a replacement settings shell or an iframe application.

### Defer or remove from the first release

- L2 scene grouping: optional experiment, not essential continuity.
- Free-form evolving persona: generated drift, recurring cost, and opaque authority are poor defaults.
- Mandatory embeddings/vector dependencies: keyword recall must work without them; vectors are disposable indexes.
- Automatic skill activation, self-modification, synthetic reward based on tool exit codes, and background continuation of abandoned tasks.
- A second raw full-transcript archive and polling browser snapshots through synthetic settings fields.
- Exposing every pipeline toggle and numeric threshold in the main settings view.

## Confirmed migration blockers and reliability findings

### Host/API compatibility

- [Plugin initialization:314–316](<src/index.ts#L314-L316>): calls `settingsNamespace()` and `settings.register()`. The installed [Settings declarations](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts#L61-L110>) expose `configure`, `describe`, `update`, `replace`, and `mutate`; the old register/watch scope is not the current contract. Editable Config fields must be explicitly volatile; keep initialization-only fields nonvolatile.
- [Capture:46–77](<src/capture.ts#L46-L77>): iterates `session.events`. Live inspection reports `snapshotEvents`, `ownEvents`, `isOwnSeq`, `inheritedEventCount`, and zero-based offsets instead. Adapt through current typed contracts; use the exact fork boundary rather than rediscovering inherited evidence.
- [Episode result capture:276–292](<src/capture.ts#L276-L292>): expects nested `tool-result` blocks. Current ToolResultMessage carries `toolCallId` at message level with ordinary content blocks. This adapter would discard current results and break learning.
- [LLM wrapper:166–207](<src/index.ts#L166-L207>): uses `any`, arbitrary `purpose` strings, and legacy plugin-sourced message construction. Live `GenerateOptions.purpose` is currently `compaction | session-title`; auxiliary calls should use typed request input, valid route selection, and a separate plugin audit label. Validate terminal error/aborted/max-token finishes explicitly before treating output as a completed review.
- **First-request recall is currently mistimed.** The installed [agent loop:902–918](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js#L902-L918>) assembles the system prompt and projects dynamic context **before** running `agent/pre-step`. [Legacy recall:87–97](<src/inject.ts#L87-L97>) registers its context inside that later listener, so it misses the current first request; [clearing the previous context:125–133](<src/inject.ts#L125-L133>) is also too late for the already-assembled snapshot. Choose a supported logged admission path with correct timing; do not simply retain this listener or claim registration proves recall. Assert the actual provider's first request and its restored/forked history.
- [Recall fallback:100–115](<src/inject.ts#L100-L115>): reconstructs the pre-step decision without preserving other fields such as `startsRequestSeries`. Spread the decision if rewriting is necessary. Native dynamic context is retained by the harness; the defect is timing, not that context is inherently unlogged. The new adapter must preserve attribution, replay, and other plugins' contributions.
- Confirm exact remaining tools, commands, skills, Remote authorization, and Config declaration contracts during the compatibility phase. Do not paper over failures using version exemptions or broad peer ranges.

### End-of-session durability is not solved by the current timers

- [Capture cursor:41–65](<src/capture.ts#L41-L65>) exists only in memory and starts at `0`, excluding a legitimate event at sequence zero. On restart, old slices are recaptured.
- [Raw slice writer:1188–1195](<src/storage.ts#L1188-L1195>) appends JSONL without durable event deduplication. File append, pending watermark, and project assignment are separate writes. A crash can duplicate or strand input.
- [Slice reader:1243–1264](<src/storage.ts#L1243-L1264>) returns an empty list on read failure and ignores malformed lines; [extraction:220–223](<src/extract.ts#L220-L223>) then advances the watermark. Missing data can be acknowledged as processed.
- [Prompt truncation:398–408](<src/extract.ts#L398-L408>) omits middle input, but [completion:327](<src/extract.ts#L327>) acknowledges the entire range. This permanently loses learning opportunities from unseen input. Chunk on event/text boundaries and acknowledge only consumed evidence.
- [Schedulers:543–614](<src/index.ts#L543-L614>) use process-local intervals/timeouts. Nightly catch-up has no durable occurrence ledger, and startup review requires existing memories, so a new store with queued capture but no extracted memories misses startup backfill.
- [Shutdown:624–630](<src/index.ts#L624-L630>) closes the store after clearing timers; clearing a timer does not await already-running extraction/consolidation/skill work. Drain or cancel owned jobs before closing storage.
- [Episode skill grouping:517–535](<src/evolve.ts#L517-L535>) groups by fingerprint without project identity. Separate projects can jointly satisfy a support quorum or block each other. Project/task/environment must be part of the grouping key.
- [Trusted recall cache:152–180](<src/inject.ts#L152-L180>) stores rendered text keyed by query/session, not memory revision. Add mutation-driven invalidation and a final eligibility check so correction/forget/pause cannot replay stale content on an identical query.

### Learning, privacy, and revocation defects requiring explicit fixes

- [Episode delegation:1634–1651](<src/storage.ts#L1634-L1651>) is only an in-process map and defaults to false after restart. Startup pending-episode assembly can lose coordinator provenance. Persist producer/header lineage with captured evidence.
- [Episode review commit:707–713](<src/storage.ts#L707-L713>) replaces observed succeeded/failed status with reviewed/rejected. [Skill candidate selection:517–535](<src/evolve.ts#L517-L535>) then accepts rows with a review timestamp, including rejected or originally mixed-failed examples. Keep immutable observed outcome separate from review state; only accepted, verified successes support positive skills.
- [Skill citations:602–605](<src/evolve.ts#L602-L605>) permit one valid citation or manufacture support from the entire group when citations are invalid. Require the independent support quorum in validated citations. [The upfront cap:506–509](<src/evolve.ts#L506-L509>) must also be checked transactionally at every activation/write, not once before processing many groups.
- Episode purge currently removes source rows without automatically revoking learned memories: [purge contract:1992–1994](<src/storage.ts#L1992-L1994>). Late/contradictory evidence must also invalidate prior learning. Revocation is a graph operation across memory, profile, indexes, handoffs, and skills—not just a row status.
- [Ordinary L0 capture:152–175](<src/capture.ts#L152-L175>) persists unredacted user/assistant text through [the JSONL writer](<src/storage.ts#L1188-L1195>); [extraction:225–233](<src/extract.ts#L225-L233>) sends user text to the configured provider. Episode redaction does not cover this lane. Consent and data minimization must cover all persistent copies, LLM/embedding requests, reviewer metadata, generated descriptions, debug logs, and export/backup policies.
- [Embedding credential Config:254–259](<src/index.ts#L254-L259>) is a plain string field; a password-looking client input is not server-side redaction. Use supported credential references or server secret roles and presence-only display; never copy served credentials into UI drafts.
- Forgetting and erasure are distinct: [logical forget:1109–1111](<src/storage.ts#L1109-L1111>) and [row deletion:1152–1157](<src/storage.ts#L1152-L1157>) do not alone erase derived files, embeddings, WAL, or backups. [Persona regeneration:165–168](<src/consolidate.ts#L165-L168>) keys off new insertions and can leave corrected/forgotten claims in old persona text. Define a future-use revocation guarantee separately from physical erasure and retained historical request logs.

These are reasons to rework the boundary and processing lifecycle—not reasons to throw away the conservative learning policies.

## Target design: session continuity and durable learning are different lanes

### Authority boundaries

- **Harness session log:** canonical event evidence and the history the model saw. Do not modify its stored vocabulary or append ad-hoc plugin event types.
- **Plugin durable journal/store:** authoritative human review decisions, explicit corrections, consent, exclusions, job acknowledgments, and skill activation records. Those decisions cannot all be reconstructed from a conversation log, so preserve them separately.
- **Derived material:** extraction candidates, handoff summaries, operational lessons, profile rendering, FTS/vector indexes, and generated skill drafts. Every item carries source coordinates, generator/schema version, scope, revision, and validity status. Derived does not mean disposable without an export/retention policy.
- **Model-visible context:** a bounded snapshot of eligible material, attributed and logged by the harness. A later memory edit affects future context, not historical request reconstruction.

Keep the existing SQLite memory data initially to avoid an unnecessary full backend conversion. Put queue records, acknowledgments, corrections, and store revisions in the same transaction boundary where atomicity is required. Use storage-domain for optional small independent metadata only if its mounted backend meets the needed contract; its [public KV contract](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-storage-domain/README.md#L28-L73>) does not by itself prove atomic transactions across multiple tables or across a session log. Resolve this seam before implementation; do not assume two services form one transaction.

### Continuity lane: unfinished work must not be filtered out as a bad memory

The current personal-memory extractor correctly rejects task-local content. That content belongs in a separate **session handoff**, not in user persona.

A versioned handoff records objective, completed work, decisions, relevant artifacts, open questions, next actions, blockers, and uncertain side effects. Store exact session/event references and a source watermark. Structured existing goals/todos are stronger evidence than a guessed prose task state. Assistant claims remain claims unless verified by evidence; a proposed next action is not permission to run it.

- Checkpoint incrementally at durable turn boundaries and explicit Pause/Finish, not only at final shutdown. A browser tab closing is not a reliable finalizer.
- A cheap pure projection tracks applicable source coordinates and structural state; an asynchronous worker generates a bounded summary. Never call an LLM or write external storage inside a projection fold.
- Same-session resume uses native history. A handoff helps orientation but never replaces the canonical log or tells the model an uncertain tool succeeded.
- A new session offers “Continue previous work” with project-matched source sessions. Explicit selection may load its handoff even for a generic “continue”; generic prompts must not trigger broad unrelated personal recall.
- Permit related parent-session context when explicitly continuing a fork, while deduplicating inherited evidence so forks do not multiply observations or count as independent successes.
- Goals resume only under native human-authorization rules. Do not wake abandoned sessions, restore old access approvals, or repeat possibly completed external actions automatically.

### Personal/project memory lane

Capture only eligible human assertions for memory extraction; apply sensitive-data filtering before any plugin-owned persistent copy or provider call. Exclude private sessions/projects and injected, assistant, tool, coordinator, scheduled, and unknown producers by default. Preserve paste/quotation demotion; confidence is not proof of authorship.

Extract into candidates with exact evidence references. Explicit “remember this” and confirmed corrections can take an immediate deterministic path. Stable ordinary facts can use conservative automatic acceptance, with a review mode for users wanting stricter control. Preference conflicts use explicit correction/latest confirmed decision, not highest retrieval score.

Render confirmed preferences as a small structured profile. Project decisions remain project-scoped. Search more deeply on demand; do not prepend an ever-growing autobiography.

### Operational learning lane

With separate consent, normalize redacted call/results using current event types. A successful command is evidence of execution, not proof that the user's task succeeded. Distinguish structural completion, verification result, human feedback, and reviewer confidence. Unknown outcomes, interrupted/forked tails, incomplete evidence, and mixed failures must not become confident lessons.

Store project/task/environment-scoped “what worked”, “what failed”, and “how verified” candidates. Negative experience should teach a verified failure mode and prevention, not globally blacklist a tool-name fingerprint. Require independent source episodes for repeated-success claims. Apply expiry and revalidation when environment assumptions change.

### Skill lane

Generate a draft from corroborated accepted lessons. Record full source lineage, project applicability, assumptions, trigger description, evaluation version, and rollback pointer. Evaluate in a safe test fixture; show the user a diff and evidence before activation. Deactivate descendants when supporting evidence is purged or invalidated unless independently re-confirmed. Integrate with the native skill provider/catalog; do not let a learned skill grant permission or overwrite user-authored skills.

### Durable worker lifecycle

Persist jobs with kind, source range, project/session identity, policy version, idempotency key, state, retry count, due time/time zone, lease/expiry, and last error. Use at-least-once execution with idempotent commits, not an exactly-once claim for provider calls.

1. Read a bounded committed source cut through native APIs.
2. Create/deduplicate the eligible job and persist its source range. Start cursors at `-1` for an empty zero-based log.
3. Claim a lease; obtain model output with cancellation and a strict size/token budget.
4. Validate output and referenced evidence. Empty valid “nothing to learn” differs from malformed/error output.
5. Atomically commit derived results and acknowledgment of only the consumed range. Crash recovery can retry without inflating support counts.
6. Invalidate affected recall/profile caches and publish bounded status. Expired jobs/leases recover on startup even if there are no memories.

Timers only wake this durable ledger. Heavy jobs run once per due occurrence or new evidence, coalesced after downtime. The native [Schedule service](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-schedule/README.md#L24-L26>) is optional and delivers Session-bound model followups, not arbitrary callback jobs; it must not be blindly substituted for plugin maintenance. Learning requires a running host; show paused/offline/backlog status, and catch up after restart within budget.

Disable or revoke consent cancels model work, blocks new eligibility, and rechecks policy immediately before commit; purge adds a durable revocation generation so an in-flight job cannot recreate forgotten material. Unload releases registrations and waits for accepted storage work/cancellation before closing the store.

## Settings UX: useful controls first, machinery out of the way

### Placement and navigation

One **Memory & Learning** entry through `settings.section`, preserving the existing shell. Main entry opens **Overview**; local destinations are **Memories**, **Sessions**, **Learned Skills**, and **Advanced**. Keep Advanced visually secondary. Reuse the same feature page for a plugin-detail configuration entry if needed; do not maintain divergent copies.

Settings chooses behavior. Browsers manage data. Do not put an entire memory/episode inspector underneath a giant configuration form.

### Overview: only everyday decisions

- Remember useful facts: master switch, with clear “Off keeps saved data” explanation.
- Use saved context: separate recall control, allowing capture without injection or injection without new extraction when explicitly chosen.
- Learn from tool experience: opt-in consent showing capture, storage, redaction limitations, and what the configured provider receives. Keep raw evidence inspection behind a link.
- Background review: Off / When idle / Scheduled. Hide time/time-zone controls until Scheduled is selected; heavy processing always obeys a visible budget policy.
- Scope and privacy shortcut: current project, excluded/private projects, and link to retention/export controls.
- Small factual status: last checkpoint, queued/failed work, last successful review, and “What was used in this session?” link. Show real failures with an actionable fix, not a green “enabled” badge implying health.

Do not expose six internal module switches, provenance-off mode, vector dimensions, thresholds, batch limits, or filesystem roots on this view. Keep skill activation in Learned Skills; do not imply turning on tool learning publishes skills.

### Data destinations

- **Memories:** search/filter by project/kind/status; detail drawer with origin/evidence/scope; Correct, Forget, Pin, and conflict review. Keep operator inspection available when learning is paused/off; pause must not make stored data inaccessible.
- **Sessions:** handoffs, checkpoint freshness, unfinished-work list, and explicit Continue action. Distinguish “history preserved” from “handoff generated”.
- **Learned Skills:** Draft / Active / Disabled / Invalidated filters; evidence, evaluation results, before/after diff, Activate, Disable, and Roll back. Empty state explains how a draft qualifies without implying automatic improvement.
- Evidence inspector lives beside its owning memory/session/skill. Episode review and purge are secondary actions, not the first thing a casual user sees.

### Advanced: grouped accordions, collapsed initially

- Retrieval: keyword/hybrid, optional embedding connection/reference, ranking thresholds, per-lane budgets, timeouts.
- Extraction & model: follow current model or explicit route, batch/token/cost limits, cadence, evidence rules. Unsafe provenance bypass is migration-only, not an ordinary advanced toggle.
- Operational learning: redacted excerpt caps, confidence/expiry, review policy, minimum independent support.
- Retention & privacy: raw excerpt/derived-memory lifetimes, project exclusions, export, lineage-aware forgetting, consent receipts.
- Storage & diagnostics: storage location/size, index rebuild, retry queue, logs, migration status. Storage-root change is an explicit migration workflow, not a live text-field write.
- Experimental: scene grouping and advanced consolidation, distinctly labeled and off by default.

Always show effective/default/overridden values and a per-group reset. Hidden controls must remain discoverable via search/help; unavailable dependencies get an explanation rather than a dead switch. There is no “reset everything” button next to routine Save.

### Current UI findings and replacement requirements

- [Client setup:16–23](<client.js#L16-L23>) is a handwritten module-loader bundle. Keep compatible loading if retained, but split view/state/field definitions into typed maintainable modules in the implementation phase.
- [Custom switch styling:64–70](<client.js#L64-L70>) hides its native input without a corresponding visible keyboard-focus rule. Add a track focus-visible treatment and a named control.
- [Modal styling:81–89](<client.js#L81-L89>) is only styling, not a modal lifecycle. Verify and implement focus trap, inert background, Escape, focus return, semantic dialog name, and contained scrolling.
- Existing [static UI tests](<scripts/test-settings-ui.mjs#L1-L8>) deliberately check source strings; add mounted browser tests and accessibility checks instead of treating these as UX validation.
- [Settings binding:1250–1255](<client.js#L1250-L1255>) uses removed private `settingsScope` binding/disposal. Current [ConfigForms:138–156](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/config-form.d.ts#L138-L156>) owns shared entry-addressed forms. Consumers unsubscribe; they do not dispose provider-owned form models. Use revisioned field mutations and preserve redacted secrets. Current shared-form writes return a success boolean and can reject transport errors; do not retain the old `response.result.ok` assumption or invent a per-write error field in the snapshot.
- [Main-section locale:1233–1268](<client.js#L1233-L1268>) reads `props.t` without passing the bound translator; current settings-section ownership does not supply it. Bind/pass locale explicitly.
- [Draft synchronization:599–602](<client.js#L599-L602>) reacts only to readiness; [Save:644–700](<client.js#L644-L700>) compares the entire stale draft against the newest snapshot and sends its newest revision. That can overwrite another client's untouched field changes without triggering a revision conflict. Capture the edit-baseline revision, mutate only dirty paths, and provide explicit conflict/rebase UX.
- [Tab switching:1242](<client.js#L1242>) unmounts the form and loses draft state. Preserve the shared draft across navigation and warn before discard. [Reset:711–716](<client.js#L711-L716>) unsets all listed fields, including unrelated groups/credentials; replace it with confirmed scoped resets labeled “Restore inherited defaults”.
- [Field inventory:504–568](<client.js#L504-L568>) omits `extract.minImportance` and `recall.maxInjectChars` despite their [Config definitions:238–250](<src/index.ts#L238-L250>). Maintain a schema-to-UI inventory test that classifies every field as everyday, advanced, initialization-only, secret, retired, or migration-only. Hidden must not mean forgotten by the new UI.
- Memory browse/review actions need a typed business service plus authorized/cancellable Remote methods, shared with commands/tools. Do not model action requests and reply rows as volatile Config values.
- Locale comes from the owning client context, not assumed slot props. Match current theme tokens; do not import private Harness UI packages into an external plain-JS plugin.

Apply the [Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) as an audit checklist: semantic controls, clickable labels, keyboard tabs/accordions, visible focus, reduced motion, inline validation, live announcements, destructive confirmation/undo, long-text handling, pagination, and unsaved-change protection. Theme switching, narrow layouts, and keyboard-only interaction are release gates, not polish after launch.

## Actual migration of existing data and configuration

1. **Inventory, never auto-install.** Detect source plugin/store version, schema, settings entry, profile, paths, memory counts/statuses, slices, episode evidence, existing generated skills, and vector metadata. Report unsupported/missing sources. Never dump credentials or private raw content into the report.
2. **Back up consistently.** Use SQLite online backup or quiesce/checkpoint all writers; copying only a live database file can miss WAL data. Include companion metadata, old settings/patch layers, and skill revisions in a checksummed manifest. Existing fixed-name pre-Hermes backup is not a fresh migration backup.
3. **Dry-run import into an isolated destination.** No schema changes by constructing the old store against production. Produce counts, conflicts, unmapped settings, quarantined records, and projected disk/cost changes. Never silently drop or trust unknown-origin rows.
4. **Map conservatively.** Preserve IDs, timestamps, scope, provenance, review status, supersession, evidence, expiry, and consent history. Deduplicate slices by source identity; preserve an audit reference for conflicting duplicates. Unverifiable evidence becomes unavailable/quarantined, not invented.
5. **Separate streams.** Personal memory stays personal; operational memory stays operational; task-local source becomes a handoff only with a clear source. Existing persona prose and generated skills remain reviewable but inactive until their evidence and scope are checked. Old episode consent does not silently enable a broader new capture policy.
6. **Map settings by active entry id.** Produce a profile-patch proposal with current volatile fields, overrides, changed defaults, and retired fields. v0.2's one-time legacy settings import may reject sections; inspect its outcome rather than assuming all settings transferred. Secrets use redacted presence/credential references, never form snapshots.
7. **Shadow validation.** Read new data without recall, capture, synthesis, or automatic jobs. Compare selection and evidence against legacy fixtures. Run current-shape integration tests and browser checks in an isolated profile.
8. **Cut over one writer.** Stop the old plugin, flush/back up, apply the reviewed bundle/profile proposal, activate the new writer, then enable bounded recall. Keep episodic learning and skills gated. No dual capture against the same store.
9. **Rollback.** Disable the new plugin; keep its destination for inspection; restore the old profile/config and consistent backup. Do not run an old plugin against a new incompatible schema. Reconcile explicit user corrections made during the pilot before choosing a rollback; retain an export of those decisions.

## Implementation sequence and acceptance gates

### Phase A — Compatibility and isolation

Scope: pin and test the rc.2 boundary, typed host/client adapters, correct manifest/build artifacts, volatile Config, optional settings UI, typed business Remote surface, effect-owned registrations, and a migration dry-run.

Gate: package mounts and unmounts in an isolated v0.2 profile; strict typecheck against current packages; disabled plugin performs no capture/recall/model work; no new ad-hoc session event types; native resume/fork still works; stale settings writes fail visibly. No compatibility exemption.

### Phase B — Reliable memory and import

Scope: preserve useful memory policies; introduce consumed-range jobs, transactional acknowledgment, source dedup, policy/cancellation generations, recall revision invalidation, proper zero-based/fork handling, and lossless dry-run/import/export.

Gate: seq zero captured; crash at every enqueue/commit boundary causes neither data loss nor duplicate evidence; long input consumes every chunk; malformed output remains failed/retryable; missing/corrupt source is not acknowledged; explicit correction/forget changes the next identical query; exclusion/pause/consent races cannot recreate data. Existing production store untouched until a reviewed cutover.

### Phase C — Session continuity and main UX

Scope: incremental handoffs, bounded source-backed summaries, Continue previous work, Overview/Memories/Sessions, contextual recall inspector, and privacy/Advanced controls. Native goals/history remain the authority.

Gate: close/reopen same session and restart host without losing committed progress; new same-project session offers appropriate unfinished work; unrelated projects see nothing; inherited forks do not inflate evidence; uncertain external actions remain uncertain; no task resumes without human intent. Keyboard-only, narrow-layout, light/dark, save-conflict, unsaved-draft, and destructive-action browser tests pass.

### Phase D — Reviewed operational learning

Scope: current flat tool-result normalization, opt-in redaction, exact call pairing, verification-aware outcome labels, project/environment grouping, evidence review, expiry, purge propagation, and bounded idle/scheduled worker execution.

Gate: fabricated output cannot become a user preference; interrupted/forked/unknown outcomes never become successes; provider text cannot grant permissions; independent episode quorum cannot be satisfied by fork/replay duplicates or unrelated projects; consent cancellation/purge blocks late commits; source/lesson lineage remains inspectable.

### Phase E — Skills and measured improvement

Scope: skill drafts, sandboxed evaluation fixtures, activation/rollback, native skill discovery, bounded experiment report, and optional retrieval improvements.

Gate: repeated verified procedures beat the no-learning baseline on held-out tasks; no unauthorized skill activation or overwrite; invalidating support disables affected skills; evidence and evaluation version are visible. Enable wider automation only if measured benefits exceed error, privacy, context, and provider-cost regressions.

No calendar estimates are asserted before Phase A measures the actual integration work. Each phase should be a reviewable change set with a rollback point; “all features migrated” is not the release criterion.

## How we prove that more usage improves the harness

Maintain a fixed, consented or synthetic replay/evaluation set plus held-out project scenarios. Compare no memory, confirmed memory, and reviewed operational learning under the same model/tool configuration. Log prompt tokens, provider calls/cost, added latency, retrieval/evidence correctness, repeated mistakes, task completion, stale/conflicting suggestions, and privacy violations. Do not equate growing memory/skill counts with improvement.

Required hard gates: no cross-project leakage, no coordinator/tool/pasted evidence promoted into personal authority, no duplicate independent support from replay/forks, and no recalled forgotten/expired material in future requests. Any violation blocks rollout.

Proposed initial budgets—not measured results: a small confirmed profile comparable to the old 2,400-character cap, contextual recall comparable to 800 characters, and operational recall subordinate within the total context budget. Replace character heuristics with token accounting once the adapter is implemented; measure first-turn prompt cost before/after new tool descriptions and defer detailed catalogs until requested.

Quality gates use paired held-out tasks and documented examples: fewer repeated mistakes and repeated user explanations, correct continuation of unfinished work, and no regression in unrelated/no-recall tasks. Publish confidence and failure examples, not a magical improvement percentage. Shadow mode can evaluate new retrieval without modifying the user's live answers.

## Decisions still needed before implementation

- Confirm rc.2 is the initial supported target; test any later v0.2 prerelease separately rather than promising broad compatibility.
- Approve whether ordinary evidence-backed facts auto-accept conservatively or all new inferred memories require review; explicit user corrections always outrank generated content.
- Set acceptable model/provider budgets and allowed sensitive-data classes. “Fully local storage” does not mean model review stays local.
- Choose project identity policy for moved repositories/subdirectories. Prefer stable workspace identity with explicit alias mapping; legacy absolute-cwd keys must be migrated deliberately, not normalized into accidental cross-project sharing.
- Identify the live legacy store/profile to pilot and approve the separate dry-run before reading private content or changing it.
- Decide whether skill activation always requires human review initially. Recommendation: yes.

Until the implementation plan is approved, remain on this branch with only the planning deliverable and the user's existing manifest edits. Do not install the plugin, mutate live databases, activate learned skills, or change the GUI.
