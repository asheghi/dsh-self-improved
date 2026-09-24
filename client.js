/**
 * dsh-self-improved — browser half.
 *
 * An "Evolving Memory" section inside the Web UI settings page: edits the
 * `dsh-self-improved` settings namespace (master switch, module switches,
 * storage, extraction LLM, recall/embedding, consolidate, evolve) through the
 * settings scope transport plus nested `settings.mutate` ops. Changes are
 * hot-applied server-side (settings/updated watch) — no restart needed.
 *
 * Style aligned with the DSH settings UI (14px base, 34px controls, 12px
 * radius, theme tokens); a "?" help toggle provides a detailed plugin guide.
 *
 * Hand-written ModuleLoader bundle — no build step required.
 * Pattern reference: dsh-tdai-memory client.js (MIT).
 */
window.__ModuleLoader__.load({
  id: "dsh-self-improved",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ── CSS (DSH theme tokens + system sizes) ─────────────────────────────
    var CSS =
      ".__dsi_root{max-width:720px;display:flex;flex-direction:column;gap:10px}" +
      ".__dsi_header{display:flex;align-items:center;gap:8px;margin-bottom:2px}" +
      ".__dsi_intro{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}" +
      ".__dsi_helpBtn{flex:none;width:24px;height:24px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}" +
      ".__dsi_helpBtn:hover{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_help{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_help h4{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_help p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}" +
      ".__dsi_group{font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px;margin:10px 0 4px}" +
      ".__dsi_field{display:flex;flex-direction:column;gap:4px}" +
      ".__dsi_label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__dsi_override{font-size:11px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__dsi_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_input{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:12px;padding:6px 12px;font-family:inherit;font-size:14px;line-height:22px}" +
      ".__dsi_input:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_row{display:flex;align-items:center;gap:8px}" +
      ".__dsi_check{accent-color:var(--dsw-alias-state-business-primary);width:16px;height:16px}" +
      ".__dsi_actions{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}" +
      ".__dsi_btn{height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:12px;padding:6px 14px;font:inherit;font-size:14px;line-height:22px;cursor:pointer}" +
      ".__dsi_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_btn:disabled{opacity:.5;cursor:default}" +
      ".__dsi_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent)}" +
      ".__dsi_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}" +
      ".__dsi_error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}" +
      ".__dsi_unavailable{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_browserRow{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__dsi_browserMain{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".__dsi_browserKind{font-size:11px;font-weight:600;color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_browserContent{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);word-break:break-all}" +
      ".__dsi_browserMeta{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_browserOps{flex:none;display:flex;gap:6px}" +
      ".__dsi_tabs{display:flex;flex-direction:column;gap:10px}" +
      ".__dsi_tabBar{display:flex;gap:4px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:8px}" +
      ".__dsi_tab{height:32px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:0 14px;font:inherit;font-size:14px;line-height:32px;cursor:pointer}" +
      ".__dsi_tab:hover{color:var(--dsw-alias-label-primary)}" +
      ".__dsi_tabActive{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-3);border-color:var(--dsw-alias-border-l2)}" +
      // Slide switch
      ".__dsi_switch{position:relative;display:inline-block;width:36px;height:20px;flex:none}" +
      ".__dsi_switch input{opacity:0;width:0;height:0;position:absolute}" +
      ".__dsi_switchTrack{position:absolute;inset:0;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;transition:background .15s,border-color .15s}" +
      ".__dsi_switch input:checked + .__dsi_switchTrack{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_switchThumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .15s,background .15s}" +
      ".__dsi_switch input:checked ~ .__dsi_switchThumb{transform:translateX(16px);background:var(--dsw-alias-label-on-accent)}" +
      // Collapsible panel
      ".__dsi_collapse{display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_collapseHeader{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__dsi_collapseHeader:hover{border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_collapseTitle{flex:1;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_collapseCount{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_collapseChevron{font-size:12px;color:var(--dsw-alias-label-tertiary);transition:transform .15s}" +
      ".__dsi_collapseOpen .__dsi_collapseChevron{transform:rotate(90deg)}" +
      ".__dsi_collapseBody{padding:2px 4px;display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_persona{white-space:pre-wrap;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}" +
      // Detail modal
      ".__dsi_modalBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}" +
      ".__dsi_modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.25)}" +
      ".__dsi_modalHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__dsi_modalTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_modalBody{padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}" +
      ".__dsi_modalContent{white-space:pre-wrap;word-break:break-all;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__dsi_modalMeta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__dsi_modalMeta b{font-weight:600;color:var(--dsw-alias-label-primary)}";
    var tagId = "dsh-self-improved/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-self-improved";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ── locale ────────────────────────────────────────────────────────────
    var NS = "selfImproved";
    var inject = ["slots", "locale", "settingsScope", "connection"];
    var zh = {
      nav: "Evolving Memory",
      tabConfig: "Config",
      tabMemories: "Memory",
      intro: "Long-term memory & self-evolution: captures conversations, extracts memories, injects recall before turns, and consolidates/forgets/evolves over time.",
      helpTitle: "About this plugin",
      help: [
        "dsh-self-improved adds cross-session long-term memory and self-evolution to DSH. All data is stored locally by default ($DSH_HOME/memory) — nothing is uploaded.",
        "",
        "[Pipeline]",
        "L0 capture: each session's conversation is saved locally for the extraction pipeline.",
        "L1 extraction: a background LLM distills atomic memories (fact / preference / event / instruction) with JSON validation, dedup and sensitive-info filtering.",
        "L2 scenes / L3 persona: memories are grouped into scene blocks; a versioned user persona is synthesized incrementally.",
        "Auto recall injection: before each turn, relevant memories are retrieved by the current question and injected to the model as a memory block.",
        "Self-evolution: memories decay by importance × recency × access; users can correct memories; successful patterns can become reusable skills in dsh-skill.",
        "Schedule: every 15 min only extraction + free maintenance (decay/cleanup) runs — no LLM cost; a full review (drain extraction + scenes/persona + skills + governance) runs daily at a fixed time (default 22:00, configurable) and ~60s after startup; trigger manually via /memory evolve.",
        "",
        "[Module switches]",
        "• Capture (L0): records conversations (off = no new memory material)",
        "• Extract (L1): distillation (off = recall still uses old memories)",
        "• Consolidate (L2/L3): scenes/persona (off = persona not updated)",
        "• Evolve: decay & skill synthesis (off = memory only grows)",
        "• Recall injection: pre-turn injection (off = tools still allow manual search)",
        "• Tools: memory_search / memory_correct / memory_forget model-visible tools",
        "",
        "[Conservative policy (hermes defaults)]",
        "• Extraction provenanceFilter=strict + requireEvidence=true: only human-confirmed memories with evidence enter the store",
        "• Recall is gated by relevance margin (0.5), importance floor, and a 4-memories-per-turn injection cap",
        "• Scene grouping (L2) is off by default — recall uses the curated baseline + contextual search",
        "• Skill synthesis is off by default; enable it under Self-evolution if wanted",
        "",
        "[Usage]",
        "• Type \"/\" in the chat input to open the command menu: /memory status, /memory list, /memory search <q>, /memory forget <id>, /memory correct <id> <text>",
        "• The model auto-uses memory tools (memory_search etc.) — no manual action needed",
        "• Changes here apply immediately after saving — no restart",
        "",
        "[Models & privacy]",
        "• Extraction/persona/skills use DSH's default model; you can set a dedicated one under Extraction",
        "• Secrets (API keys / passwords) are filtered out of memories",
        "• Fully local; vector recall needs an embedding endpoint, otherwise keyword-only",
        "",
        "[Notes]",
        "• Extraction needs a working, stable model; long sessions are drained in batches (one LLM call per batch, 30s throttle)",
        "• Persona and skills appear once memories accumulate",
        "• Disabling the master switch stops all background timers (extraction/maintenance/nightly review); stored memories are kept and everything resumes when re-enabled",
        "• Uninstalling the plugin does not delete local memory data"
      ].join("\n"),
      groupMaster: "Master",
      groupModules: "Modules",
      groupStorage: "Storage",
      groupExtract: "Extraction (L1)",
      groupRecall: "Recall / Embedding",
      groupConsolidate: "Consolidation (L2/L3)",
      groupEvolve: "Self-evolution",
      groupHousekeeping: "Growth governance",
      groupReview: "Nightly review (daily full evolution)",
      save: "Save",
      reset: "Reset to defaults",
      saved: "Saved — applied immediately",
      saving: "Saving…",
      error: "Save failed",
      conflict: "Config changed elsewhere (revision conflict): refreshed to latest, your edits are kept — please save again",
      unavailable: "Settings namespace unavailable (dsh-self-improved not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…",
      fEnabled: "Enable plugin (master switch)",
      fDebug: "Debug logs",
      fCapture: "Capture conversations (L0)",
      fExtract: "Extract memories (L1)",
      fConsolidate: "Consolidate scenes/persona (L2/L3)",
      fEvolve: "Self-evolve (decay/skills)",
      fRecall: "Auto recall injection",
      fTools: "Memory tools (memory_search etc.)",
      fStorageRoot: "Memory dir (blank = $DSH_HOME/memory)",
      fSearchLimit: "Default tool result limit",
      fProvider: "Extraction provider (blank = default model)",
      fModel: "Extraction model (blank = default model)",
      fInterval: "Poll interval (minutes)",
      fBatchChars: "Max input chars per batch",
      fMaxTokens: "Max output tokens",
      fTimeoutMs: "Extraction timeout (ms)",
      fDedup: "Dedup (token overlap)",
      fFallback: "Fallback to summary on bad JSON",
      fFlushDrain: "Drain extraction before headless exit",
      fProvenance: "Extraction provenance filter",
      fProvenanceHint: "strict (recommended) = only memories confirmed as human-authored/curated enter the long-term store; assistant-generated or unverified content stays out. off disables the filter (not recommended).",
      fRequireEvidence: "Require extraction evidence",
      fRequireEvidenceHint: "When on, memories the extraction model produced without quoting evidence from the conversation are rejected — the conservative default.",
      fStrategy: "Recall strategy",
      fStrategyHint: "keyword = pure keyword (default, no embedding calls); hybrid = keyword + vector fusion (requires an Embedding endpoint below; auto-falls back to keyword if unset).",
      fMaxResults: "Max recall results",
      fScoreThreshold: "Score threshold (0 = off)",
      fRelevanceMargin: "Relevance margin (0–1)",
      fRelevanceMarginHint: "How strict the injection gate is: 0.5 (default) injects only clearly relevant memories; lower values inject more noise — keep it high for conservative behavior.",
      fRecallMinImportance: "Min importance to inject (0 = off)",
      fRecallMinImportanceHint: "Memories below this importance are never injected; 0 = no filter.",
      fMaxInjectPerTurn: "Max memories injected per turn",
      fMaxInjectPerTurnHint: "Hard cap on injected memory blocks per turn (default 4) to keep prompts clean; 0 = unlimited (not recommended).",
      fRecallTimeout: "Recall timeout (ms)",
      fEmbBase: "Embedding Base URL (blank = keyword only)",
      fEmbKey: "Embedding API Key (write-only)",
      fEmbModel: "Embedding model",
      fEmbDims: "Vector dimensions",
      fEmbTimeout: "Embedding timeout (ms)",
      fSceneMax: "Memories for scene grouping",
      fScenesEnabled: "Scene grouping (L2 scenes)",
      fScenesEnabledHint: "Default off: recall uses the curated baseline + contextual search; enabling generates scene blocks at the nightly review.",
      fPersonaMax: "Memories for persona",
      fSceneBatch: "Max memories per scene",
      fDecay: "Forgetting decay",
      fDecayAge: "Min age (days)",
      fDecayThreshold: "Decay score threshold",
      fDecayRetention: "Forgotten retention (days, 0=keep)",
      fDecayMaxActive: "Max active memories (0=unlimited; overflow auto-decays lowest)",
      fSkill: "Skill synthesis (→ dsh-skill)",
      fSkillMin: "Skill min importance",
      fSkillRoot: "Skills root (blank = $DSH_HOME/skills)",
      fSkillPrefix: "Synthesized skill name prefix (e.g. dsi-; blank = none)",
      fSkillMax: "Max synthesized skills (0=unlimited)",
      fHkPersona: "Persona versions to keep",
      fHkScenes: "Max scenes",
      fHkSceneRatio: "Scene GC: source-memory active ratio threshold (0-1)",
      fHkConvDays: "Conversation slice retention days (0=keep all)",
      fRecallInjectChars: "Max injected block chars",
      fReviewEnabled: "Enable nightly review (one full evolution per day)",
      fReviewTime: "Review time (HH:MM, 24h)",
      secretHint: "Leave blank to keep the current key.",
      browserNav: "Memory",
      browserNoSession: "The memory browser needs a session context: open/enter a session first (you can also type \"/\" in chat to open the command menu).",
      browserHint: "Loading… (data from /memory browser --json)",
      browserSearch: "Filter",
      browserRefresh: "Refresh",
      browserSummary: "{n} active memories · {p} pending · {s} scenes · persona v{v} · {k} skills",
      browserEmpty: "(no active memories)",
      browserPersona: "Persona",
      browserPersonaEmpty: "(no persona yet — self-evolution synthesizes it as memories accumulate)",
      browserMemories: "Memories",
      browserScenes: "Scenes",
      browserScenesEmpty: "(no scenes yet)",
      browserSkills: "Learned skills",
      browserSkillsEmpty: "(no skills yet — keep accumulating memories, self-evolution will distill SOPs)",
      browserSynth: "synthesized",
      browserSkillDelete: "Delete",
      browserSkillDeleteConfirm: "Delete this synthesized skill? (system skills are protected)",
      browserSkillDeleted: "Deleted",
      browserDetail: "Detail",
      browserDetailClose: "Close",
      browserMetaKind: "Kind",
      browserMetaImportance: "Importance",
      browserMetaAccess: "Access count",
      browserMetaStatus: "Status",
      browserMetaCreated: "Created",
      browserMetaUpdated: "Updated",
      browserMetaId: "ID",
      browserMetaSupersedes: "Supersedes",
      browserCorrect: "Correct",
      browserForget: "Forget",
      browserCorrectPrompt: "Correct to:",
      browserCorrectCancel: "Cancel",
      browserCorrected: "Corrected",
      browserForgetConfirm: "Forget this memory?",
      browserForgotten: "Forgotten"
    };
    var en = {
      nav: "Evolving Memory",
      tabConfig: "Config",
      tabMemories: "Memory",
      intro: "Long-term memory & self-evolution: captures conversations, extracts memories, injects recall before turns, and consolidates/forgets/evolves over time.",
      helpTitle: "About this plugin",
      help: [
        "dsh-self-improved adds cross-session long-term memory and self-evolution to DSH. All data is stored locally by default ($DSH_HOME/memory) — nothing is uploaded.",
        "",
        "[Pipeline]",
        "L0 capture: each session's conversation is saved locally for the extraction pipeline.",
        "L1 extraction: a background LLM distills atomic memories (fact / preference / event / instruction) with JSON validation, dedup and sensitive-info filtering.",
        "L2 scenes / L3 persona: memories are grouped into scene blocks; a versioned user persona is synthesized incrementally.",
        "Auto recall injection: before each turn, relevant memories are retrieved by the current question and injected to the model as a memory block.",
        "Self-evolution: memories decay by importance × recency × access; users can correct memories; successful patterns can become reusable skills in dsh-skill.",
        "Schedule: every 15 min only extraction + free maintenance (decay/cleanup) runs — no LLM cost; a full review (drain extraction + scenes/persona + skills + governance) runs daily at a fixed time (default 22:00, configurable) and ~60s after startup; trigger manually via /memory evolve.",
        "",
        "[Module switches]",
        "• Capture (L0): records conversations (off = no new memory material)",
        "• Extract (L1): distillation (off = recall still uses old memories)",
        "• Consolidate (L2/L3): scenes/persona (off = persona not updated)",
        "• Evolve: decay & skill synthesis (off = memory only grows)",
        "• Recall injection: pre-turn injection (off = tools still allow manual search)",
        "• Tools: memory_search / memory_correct / memory_forget model-visible tools",
        "",
        "[Conservative policy (hermes defaults)]",
        "• Extraction provenanceFilter=strict + requireEvidence=true: only human-confirmed memories with evidence enter the store",
        "• Recall is gated by relevance margin (0.5), importance floor, and a 4-memories-per-turn injection cap",
        "• Scene grouping (L2) is off by default — recall uses the curated baseline + contextual search",
        "• Skill synthesis is off by default; enable it under Self-evolution if wanted",
        "",
        "[Usage]",
        "• Type \"/\" in the chat input to open the command menu: /memory status, /memory list, /memory search <q>, /memory forget <id>, /memory correct <id> <text>",
        "• The model auto-uses memory tools (memory_search etc.) — no manual action needed",
        "• Changes here apply immediately after saving — no restart",
        "",
        "[Models & privacy]",
        "• Extraction/persona/skills use DSH's default model; you can set a dedicated one under Extraction",
        "• Secrets (API keys / passwords) are filtered out of memories",
        "• Fully local; vector recall needs an embedding endpoint, otherwise keyword-only",
        "",
        "[Notes]",
        "• Extraction needs a working, stable model; long sessions are drained in batches (one LLM call per batch, 30s throttle)",
        "• Persona and skills appear once memories accumulate",
        "• Disabling the master switch stops all background timers (extraction/maintenance/nightly review); stored memories are kept and everything resumes when re-enabled",
        "• Uninstalling the plugin does not delete local memory data"
      ].join("\n"),
      groupMaster: "Master",
      groupModules: "Modules",
      groupStorage: "Storage",
      groupExtract: "Extraction (L1)",
      groupRecall: "Recall / Embedding",
      groupConsolidate: "Consolidation (L2/L3)",
      groupEvolve: "Self-evolution",
      groupHousekeeping: "Growth governance",
      groupReview: "Nightly review (daily full evolution)",
      save: "Save",
      reset: "Reset to defaults",
      saved: "Saved — applied immediately",
      saving: "Saving…",
      error: "Save failed",
      conflict: "Config changed elsewhere (revision conflict): refreshed to latest, your edits are kept — please save again",
      unavailable: "Settings namespace unavailable (dsh-self-improved not registered server-side?)",
      overridden: "overridden",
      loading: "Loading…",
      fEnabled: "Enable plugin (master switch)",
      fDebug: "Debug logs",
      fCapture: "Capture conversations (L0)",
      fExtract: "Extract memories (L1)",
      fConsolidate: "Consolidate scenes/persona (L2/L3)",
      fEvolve: "Self-evolve (decay/skills)",
      fRecall: "Auto recall injection",
      fTools: "Memory tools (memory_search etc.)",
      fStorageRoot: "Memory dir (blank = $DSH_HOME/memory)",
      fSearchLimit: "Default tool result limit",
      fProvider: "Extraction provider (blank = default model)",
      fModel: "Extraction model (blank = default model)",
      fInterval: "Poll interval (minutes)",
      fBatchChars: "Max input chars per batch",
      fMaxTokens: "Max output tokens",
      fTimeoutMs: "Extraction timeout (ms)",
      fDedup: "Dedup (token overlap)",
      fFallback: "Fallback to summary on bad JSON",
      fFlushDrain: "Drain extraction before headless exit",
      fProvenance: "Extraction provenance filter",
      fProvenanceHint: "strict (recommended) = only memories confirmed as human-authored/curated enter the long-term store; assistant-generated or unverified content stays out. off disables the filter (not recommended).",
      fRequireEvidence: "Require extraction evidence",
      fRequireEvidenceHint: "When on, memories the extraction model produced without quoting evidence from the conversation are rejected — the conservative default.",
      fStrategy: "Recall strategy",
      fStrategyHint: "keyword = pure keyword (default, no embedding calls); hybrid = keyword + vector fusion (requires an Embedding endpoint below; auto-falls back to keyword if unset).",
      fMaxResults: "Max recall results",
      fScoreThreshold: "Score threshold (0 = off)",
      fRelevanceMargin: "Relevance margin (0–1)",
      fRelevanceMarginHint: "How strict the injection gate is: 0.5 (default) injects only clearly relevant memories; lower values inject more noise — keep it high for conservative behavior.",
      fRecallMinImportance: "Min importance to inject (0 = off)",
      fRecallMinImportanceHint: "Memories below this importance are never injected; 0 = no filter.",
      fMaxInjectPerTurn: "Max memories injected per turn",
      fMaxInjectPerTurnHint: "Hard cap on injected memory blocks per turn (default 4) to keep prompts clean; 0 = unlimited (not recommended).",
      fRecallTimeout: "Recall timeout (ms)",
      fEmbBase: "Embedding Base URL (blank = keyword only)",
      fEmbKey: "Embedding API Key (write-only)",
      fEmbModel: "Embedding model",
      fEmbDims: "Vector dimensions",
      fEmbTimeout: "Embedding timeout (ms)",
      fSceneMax: "Memories for scene grouping",
      fScenesEnabled: "Scene grouping (L2 scenes)",
      fScenesEnabledHint: "Default off: recall uses the curated baseline + contextual search; enabling generates scene blocks at the nightly review.",
      fPersonaMax: "Memories for persona",
      fSceneBatch: "Max memories per scene",
      fDecay: "Forgetting decay",
      fDecayAge: "Min age (days)",
      fDecayThreshold: "Decay score threshold",
      fDecayRetention: "Forgotten retention (days, 0=keep)",
      fDecayMaxActive: "Max active memories (0=unlimited; overflow auto-decays lowest)",
      fSkill: "Skill synthesis (→ dsh-skill)",
      fSkillMin: "Skill min importance",
      fSkillRoot: "Skills root (blank = $DSH_HOME/skills)",
      fSkillPrefix: "Synthesized skill name prefix (e.g. dsi-; blank = none)",
      fSkillMax: "Max synthesized skills (0=unlimited)",
      fHkPersona: "Persona versions to keep",
      fHkScenes: "Max scenes",
      fHkSceneRatio: "Scene GC: source-memory active ratio threshold (0-1)",
      fHkConvDays: "Conversation slice retention days (0=keep all)",
      fRecallInjectChars: "Max injected block chars",
      fReviewEnabled: "Enable nightly review (one full evolution per day)",
      fReviewTime: "Review time (HH:MM, 24h)",
      secretHint: "Leave blank to keep the current key.",
      browserNav: "Memory",
      browserNoSession: "The memory browser needs a session context: open/enter a session first (you can also type \"/\" in chat to open the command menu).",
      browserHint: "Loading… (data from /memory browser --json)",
      browserSearch: "Filter",
      browserRefresh: "Refresh",
      browserSummary: "{n} active memories · {p} pending · {s} scenes · persona v{v} · {k} skills",
      browserEmpty: "(no active memories)",
      browserPersona: "Persona",
      browserPersonaEmpty: "(no persona yet — self-evolution synthesizes it as memories accumulate)",
      browserMemories: "Memories",
      browserScenes: "Scenes",
      browserScenesEmpty: "(no scenes yet)",
      browserSkills: "Learned skills",
      browserSkillsEmpty: "(no skills yet — keep accumulating memories, self-evolution will distill SOPs)",
      browserSynth: "synthesized",
      browserSkillDelete: "Delete",
      browserSkillDeleteConfirm: "Delete this synthesized skill? (system skills are protected)",
      browserSkillDeleted: "Deleted",
      browserDetail: "Detail",
      browserDetailClose: "Close",
      browserMetaKind: "Kind",
      browserMetaImportance: "Importance",
      browserMetaAccess: "Access count",
      browserMetaStatus: "Status",
      browserMetaCreated: "Created",
      browserMetaUpdated: "Updated",
      browserMetaId: "ID",
      browserMetaSupersedes: "Supersedes",
      browserCorrect: "Correct",
      browserForget: "Forget",
      browserCorrectPrompt: "Correct to:",
      browserCorrectCancel: "Cancel",
      browserCorrected: "Corrected",
      browserForgetConfirm: "Forget this memory?",
      browserForgotten: "Forgotten"
    };

    // ── field spec: dotted path + type + group ─────────────────────────────
    var FIELDS = [
      { path: ["enabled"], label: "fEnabled", type: "checkbox", group: "groupMaster" },
      { path: ["debug"], label: "fDebug", type: "checkbox", group: "groupMaster" },
      { path: ["modules", "capture"], label: "fCapture", type: "checkbox", group: "groupModules" },
      { path: ["modules", "extract"], label: "fExtract", type: "checkbox", group: "groupModules" },
      { path: ["modules", "consolidate"], label: "fConsolidate", type: "checkbox", group: "groupModules" },
      { path: ["modules", "evolve"], label: "fEvolve", type: "checkbox", group: "groupModules" },
      { path: ["modules", "recall"], label: "fRecall", type: "checkbox", group: "groupModules" },
      { path: ["modules", "tools"], label: "fTools", type: "checkbox", group: "groupModules" },
      { path: ["storageRoot"], label: "fStorageRoot", type: "text", group: "groupStorage" },
      { path: ["searchLimit"], label: "fSearchLimit", type: "number", group: "groupStorage" },
      { path: ["extract", "provider"], label: "fProvider", type: "text", group: "groupExtract" },
      { path: ["extract", "model"], label: "fModel", type: "text", group: "groupExtract" },
      { path: ["extract", "intervalMinutes"], label: "fInterval", type: "number", group: "groupExtract" },
      { path: ["extract", "batchMaxChars"], label: "fBatchChars", type: "number", group: "groupExtract" },
      { path: ["extract", "maxOutputTokens"], label: "fMaxTokens", type: "number", group: "groupExtract" },
      { path: ["extract", "timeoutMs"], label: "fTimeoutMs", type: "number", group: "groupExtract" },
      { path: ["extract", "dedup"], label: "fDedup", type: "checkbox", group: "groupExtract" },
      { path: ["extract", "fallbackOnBadJson"], label: "fFallback", type: "checkbox", group: "groupExtract" },
      { path: ["extract", "flushDrain"], label: "fFlushDrain", type: "checkbox", group: "groupExtract" },
      { path: ["extract", "provenanceFilter"], label: "fProvenance", type: "select", options: ["strict", "off"], includeBlank: false, fallback: "strict", hint: "fProvenanceHint", group: "groupExtract" },
      { path: ["extract", "requireEvidence"], label: "fRequireEvidence", type: "checkbox", group: "groupExtract" },
      { path: ["recall", "strategy"], label: "fStrategy", type: "select", options: ["keyword", "hybrid"], hint: "fStrategyHint", group: "groupRecall" },
      { path: ["recall", "maxResults"], label: "fMaxResults", type: "number", group: "groupRecall" },
      { path: ["recall", "scoreThreshold"], label: "fScoreThreshold", type: "number", group: "groupRecall" },
      { path: ["recall", "relevanceMargin"], label: "fRelevanceMargin", type: "number", hint: "fRelevanceMarginHint", group: "groupRecall" },
      { path: ["recall", "minImportance"], label: "fRecallMinImportance", type: "number", hint: "fRecallMinImportanceHint", group: "groupRecall" },
      { path: ["recall", "maxInjectPerTurn"], label: "fMaxInjectPerTurn", type: "number", hint: "fMaxInjectPerTurnHint", group: "groupRecall" },
      { path: ["recall", "timeoutMs"], label: "fRecallTimeout", type: "number", group: "groupRecall" },
      { path: ["recall", "embedding", "baseUrl"], label: "fEmbBase", type: "text", group: "groupRecall" },
      { path: ["recall", "embedding", "apiKey"], label: "fEmbKey", type: "password", secret: true, group: "groupRecall" },
      { path: ["recall", "embedding", "model"], label: "fEmbModel", type: "text", group: "groupRecall" },
      { path: ["recall", "embedding", "dimensions"], label: "fEmbDims", type: "number", group: "groupRecall" },
      { path: ["recall", "embedding", "timeoutMs"], label: "fEmbTimeout", type: "number", group: "groupRecall" },
      { path: ["consolidate", "scenesEnabled"], label: "fScenesEnabled", type: "checkbox", group: "groupConsolidate" },
      { path: ["consolidate", "sceneMaxMemories"], label: "fSceneMax", type: "number", group: "groupConsolidate" },
      { path: ["consolidate", "personaMaxMemories"], label: "fPersonaMax", type: "number", group: "groupConsolidate" },
      { path: ["consolidate", "sceneBatchSize"], label: "fSceneBatch", type: "number", group: "groupConsolidate" },
      { path: ["evolve", "decay", "enabled"], label: "fDecay", type: "checkbox", group: "groupEvolve" },
      { path: ["evolve", "decay", "minAgeDays"], label: "fDecayAge", type: "number", group: "groupEvolve" },
      { path: ["evolve", "decay", "threshold"], label: "fDecayThreshold", type: "number", group: "groupEvolve" },
      { path: ["evolve", "decay", "retentionDays"], label: "fDecayRetention", type: "number", group: "groupEvolve" },
      { path: ["evolve", "decay", "maxActiveMemories"], label: "fDecayMaxActive", type: "number", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "enabled"], label: "fSkill", type: "checkbox", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "minImportance"], label: "fSkillMin", type: "number", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "skillsRoot"], label: "fSkillRoot", type: "text", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "prefix"], label: "fSkillPrefix", type: "text", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "maxSkills"], label: "fSkillMax", type: "number", group: "groupEvolve" },
      { path: ["housekeeping", "personaVersions"], label: "fHkPersona", type: "number", group: "groupHousekeeping" },
      { path: ["housekeeping", "maxScenes"], label: "fHkScenes", type: "number", group: "groupHousekeeping" },
      { path: ["housekeeping", "sceneActiveRatio"], label: "fHkSceneRatio", type: "number", group: "groupHousekeeping" },
      { path: ["housekeeping", "conversationRetentionDays"], label: "fHkConvDays", type: "number", group: "groupHousekeeping" },
      { path: ["review", "enabled"], label: "fReviewEnabled", type: "checkbox", group: "groupReview" },
      { path: ["review", "time"], label: "fReviewTime", type: "text", group: "groupReview" }
    ];
    FIELDS.forEach(function (f) { f.key = f.path.join("."); });

    function getPath(obj, path) {
      var cur = obj;
      for (var i = 0; i < path.length; i += 1) {
        if (cur === null || cur === void 0 || typeof cur !== "object") return void 0;
        cur = cur[path[i]];
      }
      return cur;
    }

    function MemorySection(props) {
      var t = props.t;
      var scope = props.scope;
      var api = props.api;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var ready = snapshot.status === "ready" && snapshot.value !== void 0;
      var [draft, setDraft] = react.useState({});
      var [busy, setBusy] = react.useState(false);
      var [notice, setNotice] = react.useState(null);
      var [error, setError] = react.useState(null);
      var [showHelp, setShowHelp] = react.useState(false);

      react.useEffect(function () {
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); };
      }, [scope]);
      react.useEffect(function () {
        if (ready) setDraft(Object.assign({}, valueToDraft(snapshot.value)));
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [ready]);

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__dsi_unavailable" }, t("unavailable"));
      }
      if (!ready) return h("p", { className: "__dsi_status" }, t("loading"));

      var value = snapshot.value;
      var user = snapshot.user || {};

      function fieldDraft(f) {
        if (f.type === "checkbox") return draft[f.key] !== void 0 ? draft[f.key] : Boolean(getPath(value, f.path));
        // Select fields may carry a schema-default fallback so an unset (or never-initialized
        // empty-draft) value still renders a valid option — valueToDraft writes "" for unset
        // selects, so treat both undefined and "" as unset here.
        if (f.type === "select" && (draft[f.key] === void 0 || draft[f.key] === "") && f.fallback !== void 0) {
          var cur = getPath(value, f.path);
          return cur === void 0 || cur === null || cur === "" ? String(f.fallback) : String(cur);
        }
        return draft[f.key] !== void 0 ? draft[f.key] : String(getPath(value, f.path) ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var next = Object.assign({}, prev); next[f.key] = v; return next; });
        setNotice(null);
        setError(null);
      }

      // Save-failure handling: on a revision conflict (the namespace changed after it was read),
      // refresh the latest config, keep the user's draft, and ask to save again; other errors are shown as-is
      function handleMutateFailure(response) {
        setBusy(false);
        var detail = response && response.result && response.result.error || {};
        var msg = String(detail.message || detail.code || "unknown");
        if (/changed since it was read|revision conflict/i.test(msg)) {
          // The shared settings mirror refreshes snapshots automatically.
          setError(t("conflict"));
          return;
        }
        setError(t("error") + ": " + msg);
      }

      function onSave() {
        setBusy(true); setNotice(null); setError(null);
        var ops = [];
        for (var i = 0; i < FIELDS.length; i += 1) {
          var f = FIELDS[i];
          var d = fieldDraft(f);
          var current = getPath(value, f.path);
          if (f.type === "password") {
            if (!d) continue; // blank keeps the current key
            if (d === String(current ?? "")) continue;
            ops.push({ op: "set", path: f.path, value: d });
            continue;
          }
          if (f.type === "checkbox") {
            if (Boolean(d) === Boolean(current)) continue;
            // Note: disabling must use set false — unset would let the parsed value fall back to the schema default (usually true), so the switch would never turn off
            ops.push({ op: "set", path: f.path, value: Boolean(d) });
            continue;
          }
          if (f.type === "select") {
            if (String(d) === String(current ?? "")) continue;
            // An unset field rendering its schema fallback equals the default: no write needed
            if (String(current ?? "") === "" && f.fallback !== void 0 && String(d) === String(f.fallback)) continue;
            ops.push(String(d) ? { op: "set", path: f.path, value: d } : { op: "unset", path: f.path });
            continue;
          }
          if (String(d) === String(current ?? "")) continue;
          if (String(d).trim() === "" && getPath(user, f.path) === void 0) continue;
          ops.push(String(d).trim() === "" ? { op: "unset", path: f.path } : { op: "set", path: f.path, value: f.type === "number" ? Number(d) : d });
        }
        if (ops.length === 0) { setBusy(false); setNotice(t("saved")); return; }
        api.settings.mutate({
          ns: "dsh-self-improved",
          ops: ops,
          ...snapshot.revision === void 0 ? {} : { expectedRevision: snapshot.revision }
        }).then(function (response) {
          if (!response.result.ok) { handleMutateFailure(response); return; }
          setBusy(false);
          setNotice(t("saved"));
          // The shared settings mirror folds the mutation response into the scope snapshot.
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      function onReset() {
        setBusy(true); setNotice(null); setError(null);
        api.settings.mutate({
          ns: "dsh-self-improved",
          ops: FIELDS.map(function (f) { return { op: "unset", path: f.path }; }),
          ...snapshot.revision === void 0 ? {} : { expectedRevision: snapshot.revision }
        }).then(function (response) {
          if (!response.result.ok) { handleMutateFailure(response); return; }
          setBusy(false);
          setNotice(t("saved"));
          // Refresh the draft from the authoritative (default-resolved) settings snapshot so
          // controls immediately show schema defaults instead of stale pre-reset values.
          var fresh = scope.getSnapshot();
          if (fresh.status === "ready" && fresh.value !== void 0) setDraft(Object.assign({}, valueToDraft(fresh.value)));
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      // Collapse groups in sync with module switches: a disabled module hides its config group; all groups collapse when the master switch is off
      var GROUP_SWITCH = {
        groupExtract: "modules.extract",
        groupRecall: "modules.recall",
        groupConsolidate: "modules.consolidate",
        groupEvolve: "modules.evolve",
        groupStorage: "enabled"
      };
      function switchValue(key) {
        return Boolean(draft[key] !== void 0 ? draft[key] : getPath(value, key.split(".")));
      }
      var masterOn = switchValue("enabled");
      function groupVisible(g) {
        if (g === "groupMaster" || g === "groupModules") return true;
        var sw = GROUP_SWITCH[g];
        if (!sw) return true;
        if (sw === "enabled") return masterOn;
        return masterOn && switchValue(sw);
      }

      var nodes = [];
      var lastGroup = null;
      FIELDS.forEach(function (f) {
        if (!groupVisible(f.group)) return; // hidden by collapse
        if (f.group !== lastGroup) {
          lastGroup = f.group;
          nodes.push(h("div", { key: "g" + f.group, className: "__dsi_group" }, t(f.group)));
        }
        var overridden = getPath(user, f.path) !== void 0;
        if (f.type === "checkbox") {
          // Slide switch
          nodes.push(h("label", { key: f.path.join("."), className: "__dsi_field" },
            h("span", { className: "__dsi_row" },
              h("span", { className: "__dsi_switch" },
                h("input", { type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
                h("span", { className: "__dsi_switchTrack" }),
                h("span", { className: "__dsi_switchThumb" })
              ),
              h("span", { className: "__dsi_label" }, t(f.label)),
              overridden ? h("span", { className: "__dsi_override" }, t("overridden")) : null
            )
          ));
          return;
        }
        var input;
        if (f.type === "select") {
          input = h("select", {
            className: "__dsi_input",
            value: fieldDraft(f),
            onChange: function (e) { setField(f, e.target.value); }
          }, f.options.map(function (opt) {
            return h("option", { key: opt, value: opt }, opt);
          }));
        } else {
          input = h("input", {
            className: "__dsi_input",
            type: f.type === "password" ? "password" : f.type === "number" ? "number" : "text",
            value: fieldDraft(f),
            placeholder: f.type === "password" ? (overridden ? "••••••••" : t("secretHint")) : "",
            onChange: function (e) { setField(f, e.target.value); }
          });
        }
        nodes.push(h("label", { key: f.path.join("."), className: "__dsi_field" },
          h("span", { className: "__dsi_label" },
            t(f.label),
            overridden ? h("span", { className: "__dsi_override" }, t("overridden")) : null
          ),
          input,
          f.type === "password" ? h("span", { className: "__dsi_hint" }, t("secretHint")) : null,
          f.hint ? h("span", { className: "__dsi_hint" }, t(f.hint)) : null
        ));
      });

      return h("div", { className: "__dsi_root" },
        h("div", { className: "__dsi_header" },
          h("p", { className: "__dsi_intro" }, t("intro")),
          h("button", {
            type: "button",
            className: "__dsi_helpBtn",
            title: t("helpTitle"),
            onClick: function () { setShowHelp(!showHelp); }
          }, "?")
        ),
        showHelp ? h("div", { className: "__dsi_help" },
          h("h4", null, t("helpTitle")),
          h("p", null, t("help"))
        ) : null,
        nodes,
        h("div", { className: "__dsi_actions" },
          h("button", { type: "button", className: "__dsi_btn __dsi_btnPrimary", onClick: onSave, disabled: busy || !snapshot.writable }, t("save")),
          h("button", { type: "button", className: "__dsi_btn", onClick: onReset, disabled: busy || !snapshot.writable }, t("reset")),
          notice ? h("span", { className: "__dsi_ok" }, notice) : null,
          busy ? h("span", { className: "__dsi_status" }, t("saving")) : null,
          error ? h("span", { className: "__dsi_error" }, error) : null
        )
      );
    }

    function valueToDraft(value) {
      var out = {};
      for (var i = 0; i < FIELDS.length; i += 1) {
        var f = FIELDS[i];
        out[f.key] = f.type === "checkbox" ? Boolean(getPath(value, f.path)) : String(getPath(value, f.path) ?? "");
      }
      return out;
    }

    // ── Memory browser (second settings tab; data channel via the dsh-self-improved-browser namespace, no session needed) ─────
    var KIND_LABEL = { fact: "📖 Fact", preference: "📌 Preference", event: "🧭 Event", instruction: "📋 Instruction", persona: "👤 Persona" };

    function BrowserSection(props) {
      var t = props.t;
      var api = props.api;
      var scope = props.browserScope;
      var [snapshot, setSnapshot] = react.useState(function () { return scope.getSnapshot(); });
      var [busy, setBusy] = react.useState(false);
      var [error, setError] = react.useState(null);
      var [query, setQuery] = react.useState("");
      var [notice, setNotice] = react.useState(null);
      var [closedDetailId, setClosedDetailId] = react.useState(null);
      // Inline correction editor (replaces window.prompt, which the host page may suppress)
      var [editingId, setEditingId] = react.useState(null);
      var [editDraft, setEditDraft] = react.useState("");
      var [open, setOpen] = react.useState({ persona: false, memories: true, scenes: false, skills: false });

      react.useEffect(function () {
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        // Trigger one server-side snapshot rebuild on open (noop action) so the view starts with fresh data
        try {
          api.settings.mutate({
            ns: "dsh-self-improved-browser",
            ops: [{ op: "set", path: ["action"], value: JSON.stringify({ op: "noop" }) }]
          });
        } catch (e) { /* noop */ }
        return function () { alive = false; if (un) un(); };
      }, [scope]);

      var data = null;
      if (snapshot.status === "ready" && snapshot.value && typeof snapshot.value.snapshot === "string") {
        try { data = JSON.parse(snapshot.value.snapshot); } catch (e) { data = null; }
      }
      // Detail modal data (the server returns the full memory on demand)
      var detailObj = null;
      if (snapshot.status === "ready" && snapshot.value && typeof snapshot.value.detail === "string" && snapshot.value.detail) {
        try { detailObj = JSON.parse(snapshot.value.detail); } catch (e) { detailObj = null; }
      }
      var showDetail = detailObj && detailObj.id !== closedDetailId;

      if (snapshot.status === "unavailable") {
        return h("p", { className: "__dsi_unavailable" }, t("unavailable"));
      }
      if (!data) {
        return h("div", { className: "__dsi_root" },
          h("p", { className: "__dsi_status" }, t("browserHint")),
          error ? h("p", { className: "__dsi_error" }, error) : null);
      }

      var memories = (data.memories || []).filter(function (m) { return m.status === "active"; });
      var q = query.trim().toLowerCase();
      var filtered = q ? memories.filter(function (m) { return m.content.toLowerCase().indexOf(q) >= 0 || m.kind.indexOf(q) >= 0; }) : memories;

      function sendAction(action) {
        return api.settings.mutate({
          ns: "dsh-self-improved-browser",
          ops: [{ op: "set", path: ["action"], value: JSON.stringify(action) }]
        });
      }
      function viewDetail(m) {
        setBusy(true); setNotice(null); setError(null);
        setClosedDetailId(null);
        sendAction({ op: "detail", id: m.id }).then(function () { setBusy(false); }).catch(function (e) { setBusy(false); setError(String(e && e.message || e)); });
      }
      function refresh() {
        setBusy(true); setNotice(null); setError(null);
        sendAction({ op: "noop" }).catch(function (e) {
          setError(String(e && e.message || e));
        }).finally(function () { setBusy(false); });
      }
      function forget(m) {
        if (!window.confirm(t("browserForgetConfirm") + "\n" + m.content.slice(0, 60))) return;
        setBusy(true); setNotice(null); setError(null);
        sendAction({ op: "forget", id: m.id }).then(function () { setNotice(t("browserForgotten")); }).catch(function (e) { setError(String(e && e.message || e)); }).finally(function () { setBusy(false); });
      }
      function correct(m) {
        // Open the inline editor for this row (no window.prompt: it can be suppressed and return null silently)
        setNotice(null); setError(null);
        setEditingId(m.id);
        setEditDraft(m.content);
      }
      function cancelCorrect() {
        setEditingId(null);
        setEditDraft("");
      }
      function saveCorrect(m) {
        var next = editDraft.trim();
        if (!next || next === m.content) { cancelCorrect(); return; }
        setBusy(true); setNotice(null); setError(null);
        sendAction({ op: "correct", id: m.id, content: next }).then(function () {
          setNotice(t("browserCorrected"));
          cancelCorrect();
        }).catch(function (e) { setError(String(e && e.message || e)); }).finally(function () { setBusy(false); });
      }

      var listNodes = filtered.slice(0, 200).map(function (m) {
        if (editingId === m.id) {
          return h("div", { key: m.id, className: "__dsi_browserRow" },
            h("div", { className: "__dsi_browserMain" },
              h("span", { className: "__dsi_browserKind" }, (KIND_LABEL[m.kind] || m.kind) + " · " + t("browserCorrectPrompt")),
              h("textarea", {
                className: "__dsi_input",
                style: { height: "auto", minHeight: 60, resize: "vertical" },
                autoFocus: true,
                value: editDraft,
                disabled: busy,
                onChange: function (e) { setEditDraft(e.target.value); },
                onKeyDown: function (e) {
                  if (e.key === "Escape") { e.preventDefault(); cancelCorrect(); }
                  else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCorrect(m); }
                }
              })
            ),
            h("span", { className: "__dsi_browserOps" },
              h("button", { type: "button", className: "__dsi_btn", onClick: function () { saveCorrect(m); }, disabled: busy || !editDraft.trim() }, t("save")),
              h("button", { type: "button", className: "__dsi_btn", onClick: cancelCorrect, disabled: busy }, t("browserCorrectCancel"))
            )
          );
        }
        return h("div", { key: m.id, className: "__dsi_browserRow" },
          h("div", { className: "__dsi_browserMain" },
            h("span", { className: "__dsi_browserKind" }, KIND_LABEL[m.kind] || m.kind),
            h("span", { className: "__dsi_browserContent" }, m.content),
            h("span", { className: "__dsi_browserMeta" }, "★" + m.importance + " · hits " + m.accessCount + " · " + m.id.slice(0, 8))
          ),
          h("span", { className: "__dsi_browserOps" },
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { viewDetail(m); }, disabled: busy }, t("browserDetail")),
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { correct(m); }, disabled: busy }, t("browserCorrect")),
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { forget(m); }, disabled: busy }, t("browserForget"))
          )
        );
      });

      var scenesNodes = (data.scenes || []).slice(0, 20).map(function (s) {
        return h("div", { key: s.id, className: "__dsi_browserRow" },
          h("div", { className: "__dsi_browserMain" },
            h("span", { className: "__dsi_browserKind" }, "🗂️" + s.title)));
      });

      var skills = data.skills || [];
      function deleteSkill(sk) {
        if (!window.confirm(t("browserSkillDeleteConfirm") + "\n" + sk.name)) return;
        setBusy(true); setNotice(null); setError(null);
        sendAction({ op: "deleteSkill", name: sk.name }).then(function () { setNotice(t("browserSkillDeleted")); }).catch(function (e) { setError(String(e && e.message || e)); }).finally(function () { setBusy(false); });
      }
      var skillsNodes = skills.map(function (sk) {
        return h("div", { key: sk.name, className: "__dsi_browserRow" },
          h("div", { className: "__dsi_browserMain" },
            h("span", { className: "__dsi_browserKind" }, "📘 " + sk.name + (sk.synthesized ? " (" + t("browserSynth") + ")" : "")),
            sk.description ? h("span", { className: "__dsi_browserContent" }, sk.description) : null,
            sk.whenToUse ? h("span", { className: "__dsi_browserMeta" }, sk.whenToUse) : null,
            sk.excerpt ? h("span", { className: "__dsi_browserMeta" }, sk.excerpt) : null
          ),
          sk.synthesized ? h("span", { className: "__dsi_browserOps" },
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { deleteSkill(sk); }, disabled: busy }, t("browserSkillDelete"))
          ) : null);
      });

      // Collapsible panels (persona/memories/scenes/skills); hook state declared above early returns
      function toggle(k) {
        setOpen(function (p) { var n = Object.assign({}, p); n[k] = !n[k]; return n; });
      }
      function collapse(key, title, count, body) {
        var isOpen = open[key];
        return h("div", { className: "__dsi_collapse" + (isOpen ? " __dsi_collapseOpen" : "") },
          h("div", { className: "__dsi_collapseHeader", onClick: function () { toggle(key); } },
            h("span", { className: "__dsi_collapseChevron" }, "▶"),
            h("span", { className: "__dsi_collapseTitle" }, title),
            h("span", { className: "__dsi_collapseCount" }, count)
          ),
          isOpen ? h("div", { className: "__dsi_collapseBody" }, body) : null
        );
      }

      var persona = data.persona;
      var scenesArr = data.scenes || [];
      var personaBody = persona
        ? h("div", { className: "__dsi_persona" }, persona.content)
        : h("p", { className: "__dsi_status" }, t("browserPersonaEmpty"));

      var memoryBody = h("div", { className: "__dsi_collapse" },
        h("div", { className: "__dsi_row" },
          h("input", { className: "__dsi_input", style: { maxWidth: 260 }, placeholder: t("browserSearch"), value: query, onChange: function (e) { setQuery(e.target.value); } }),
          h("button", { type: "button", className: "__dsi_btn", onClick: refresh, disabled: busy }, t("browserRefresh"))
        ),
        listNodes.length ? listNodes : h("p", { className: "__dsi_status" }, t("browserEmpty"))
      );

      var scenesBody = scenesArr.length
        ? h("div", { className: "__dsi_collapse" }, scenesNodes)
        : h("p", { className: "__dsi_status" }, t("browserScenesEmpty"));

      var skillsBody = skills.length
        ? (skillsNodes.length ? h("div", { className: "__dsi_collapse" }, skillsNodes) : h("p", { className: "__dsi_status" }, t("browserSkillsEmpty")))
        : h("p", { className: "__dsi_status" }, t("browserSkillsEmpty"));

      var STATUS_LABEL = { active: "Active", decayed: "Decayed", forgotten: "Forgotten", corrected: "Corrected" };
      function fmtTime(ts) {
        try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
      }
      var modal = showDetail ? h("div", { className: "__dsi_modalBackdrop", onClick: function () { setClosedDetailId(detailObj.id); } },
        h("div", { className: "__dsi_modal", onClick: function (e) { e.stopPropagation(); } },
          h("div", { className: "__dsi_modalHeader" },
            h("span", { className: "__dsi_modalTitle" }, (KIND_LABEL[detailObj.kind] || detailObj.kind) + " · " + t("browserDetail")),
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { setClosedDetailId(detailObj.id); } }, t("browserDetailClose"))
          ),
          h("div", { className: "__dsi_modalBody" },
            h("div", { className: "__dsi_modalContent" }, detailObj.content),
            h("div", { className: "__dsi_modalMeta" },
              h("b", null, t("browserMetaKind")), h("span", null, detailObj.kind),
              h("b", null, t("browserMetaImportance")), h("span", null, "★ " + detailObj.importance + " / 10"),
              h("b", null, t("browserMetaAccess")), h("span", null, String(detailObj.accessCount)),
              h("b", null, t("browserMetaStatus")), h("span", null, STATUS_LABEL[detailObj.status] || detailObj.status),
              h("b", null, t("browserMetaCreated")), h("span", null, fmtTime(detailObj.createdAt)),
              h("b", null, t("browserMetaUpdated")), h("span", null, fmtTime(detailObj.updatedAt)),
              h("b", null, t("browserMetaId")), h("span", null, detailObj.id),
              detailObj.supersedes ? h("b", null, t("browserMetaSupersedes")) : null,
              detailObj.supersedes ? h("span", null, detailObj.supersedes) : null
            )
          )
        )
      ) : null;

      return h("div", { className: "__dsi_root" },
        h("p", { className: "__dsi_status" },
          t("browserSummary").replace("{n}", String(memories.length)).replace("{p}", String(data.pending || 0)).replace("{s}", String(scenesArr.length)).replace("{v}", String(persona ? persona.ver : "-")).replace("{k}", String(skills.length))
        ),
        notice ? h("p", { className: "__dsi_ok" }, notice) : null,
        error ? h("p", { className: "__dsi_error" }, error) : null,
        collapse("persona", t("browserPersona") + (persona ? " v" + persona.ver : ""), persona ? "" : "", personaBody),
        collapse("memories", t("browserMemories"), String(memories.length), memoryBody),
        collapse("scenes", t("browserScenes"), String(scenesArr.length), scenesBody),
        collapse("skills", t("browserSkills"), String(skills.length), skillsBody),
        modal
      );
    }

    // ── Main settings section: one section with "Config / Memory" tabs ──────────────────
    function MainSection(props) {
      var t = props.t;
      var [tab, setTab] = react.useState("config");
      return h("div", { className: "__dsi_tabs" },
        h("div", { className: "__dsi_tabBar" },
          h("button", { type: "button", className: "__dsi_tab" + (tab === "config" ? " __dsi_tabActive" : ""), onClick: function () { setTab("config"); } }, t("tabConfig")),
          h("button", { type: "button", className: "__dsi_tab" + (tab === "memories" ? " __dsi_tabActive" : ""), onClick: function () { setTab("memories"); } }, t("tabMemories"))
        ),
        tab === "config" ? h(MemorySection, props) : h(BrowserSection, props)
      );
    }

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-self-improved: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "dsh-self-improved" });
      var browserScope = ctx.settingsScope.bind({ namespace: "dsh-self-improved-browser" });
      ctx.effect(function () {
        return function () {
          scope.dispose();
          browserScope.dispose();
        };
      }, "dsh-self-improved: settings scopes");
      var api = ctx.connection.api;
      // Single settings section with two tabs: Config / Memory
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-self-improved",
          order: 27,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(MainSection, Object.assign({}, props, { scope: scope, api: api, browserScope: browserScope }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
