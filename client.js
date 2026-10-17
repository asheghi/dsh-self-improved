/**
 * dsh-self-improved — browser half (rc.2).
 *
 * Structure (module seam; single-bundle build, typed boundaries by section):
 *
 *   [css]        theme-token styles (opaque classes are plugin prefixes only)
 *   [locale]     zh/en dictionaries through the rc.2 locale service API
 *   [settings-form]   the ONE module owning this entry's settings-form state:
 *                     binds the shared entry-addressed ConfigForms model as a
 *                     CONSUMER (subscribe/unsubscribe — never dispose — the
 *                     provider owns the form), tracks dirty paths + the edit
 *                     baseline revision, classifies fields, and issues
 *                     dirty-path-only mutations with that baseline revision.
 *   [business-remote] the typed business remote contributions (shared with
 *                     commands/tools on the host): descriptor table + access.
 *   [views]      section components: Config form / Memory browser / tabs.
 *
 * rc.2 notes embodied here (MIGRATION-V0.2.md Phase A):
 * - No legacy private settings scope binding. The form derives from
 *   `ctx.configForms` + the shared describe mirror; stale remote writes fail
 *   VISIBLY (`mutate` answers false) and surface an explicit conflict/rebase
 *   banner that keeps the user's dirty values.
 * - Secret slots (recall.embedding.apiKey) render presence-only from the
 *   mirrored `secrets` sidecar; values never cross back into drafts and a
 *   blank input keeps the stored key.
 * - `storageRoot` is init-only: editing it flags a restart (nonvolatile),
 *   which the server enforces; the form marks the field accordingly.
 * - The Memory tab reads rows through `ctx.remote.selfImproved.*` (typed
 *   business remote) with a peer-bound, one-shot-confirm mutating handshake —
 *   no operation rides volatile Config values; dry-review is cancellable.
 */
window.__ModuleLoader__.load({
  id: "dsh-self-improved",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    var react = require("react");
    var h = react.createElement;

    // ─═ [css] ══════════════════════════════════════════════════════════════
    var CSS =
      ".__dsi_root{max-width:720px;min-width:0;display:flex;flex-direction:column;gap:10px;overflow-wrap:anywhere;container-type:inline-size}" +
      ".__dsi_root *{box-sizing:border-box}" +
      ".__dsi_root input,.__dsi_root select,.__dsi_root textarea{min-width:0;max-width:100%}" +
      "@container (max-width:420px){.__dsi_header,.__dsi_label,.__dsi_row,.__dsi_tabBar,.__dsi_browserRow,.__dsi_browserOps,.__dsi_collapseHeader{flex-wrap:wrap;min-width:0}.__dsi_btn,.__dsi_tab{height:auto;min-height:34px;max-width:100%;white-space:normal;overflow-wrap:anywhere;padding:6px 8px;line-height:22px}.__dsi_collapseTitle{min-width:0}.__dsi_table{table-layout:fixed}.__dsi_table th,.__dsi_table td{padding:6px 2px}}" +
      ".__dsi_header{display:flex;align-items:center;gap:8px;margin-bottom:2px}" +
      ".__dsi_intro{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);margin:0}" +
      ".__dsi_helpBtn{flex:none;width:24px;height:24px;border-radius:50%;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-size:13px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}" +
      ".__dsi_helpBtn:hover,.__dsi_helpBtn:focus-visible{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_help{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_help h4{margin:0;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_help p{margin:0;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}" +
      ".__dsi_group{font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:4px;margin:10px 0 4px}" +
      ".__dsi_field{display:flex;flex-direction:column;gap:4px}" +
      ".__dsi_label{font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);display:flex;align-items:center;gap:6px}" +
      ".__dsi_override{font-size:11px;color:var(--dsw-alias-state-business-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__dsi_dirty{font-size:11px;color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-business-primary));border:1px dashed var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__dsi_restart{font-size:11px;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:4px;padding:0 4px}" +
      ".__dsi_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_input{box-sizing:border-box;width:100%;height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:12px;padding:6px 12px;font-family:inherit;font-size:14px;line-height:22px}" +
      ".__dsi_input:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px;border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_row{display:flex;align-items:center;gap:8px}" +
      ".__dsi_check{accent-color:var(--dsw-alias-state-business-primary);width:16px;height:16px}" +
      ".__dsi_actions{display:flex;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap}" +
      ".__dsi_btn{height:34px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:12px;padding:6px 14px;font:inherit;font-size:14px;line-height:22px;cursor:pointer;touch-action:manipulation}" +
      ".__dsi_btn:hover:not(:disabled){border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_btn:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:1px}" +
      ".__dsi_btn:disabled{opacity:.5;cursor:default}" +
      ".__dsi_btnPrimary{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-on-accent,#fff)}" +
      ".__dsi_btnDanger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}" +
      ".__dsi_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}" +
      ".__dsi_error{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}" +
      ".__dsi_conflict{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-state-error-primary);border-radius:12px;padding:10px 12px;display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_unavailable{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_browserRow{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__dsi_browserMain{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".__dsi_browserKind{font-size:11px;font-weight:600;color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_browserContent{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}" +
      ".__dsi_browserMeta{font-size:11px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_browserOps{flex:none;display:flex;gap:6px}" +
      ".__dsi_browserOps .__dsi_btn{height:28px;padding:0 10px;font-size:13px;line-height:26px;border-radius:8px}" +
      ".__dsi_tabs{display:flex;flex-direction:column;gap:10px}" +
      ".__dsi_tabBar{display:flex;gap:2px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-x:auto;scrollbar-width:none}" +
      ".__dsi_tab{position:relative;height:38px;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:0;padding:0 14px;font:inherit;font-size:14px;line-height:36px;white-space:nowrap;cursor:pointer;transition:color .15s,border-color .15s}" +
      ".__dsi_tab:hover{color:var(--dsw-alias-label-primary)}" +
      ".__dsi_tab:focus-visible{outline:2px solid transparent}" +
      ".__dsi_tab:focus-visible::after{content:'';position:absolute;inset:4px 2px 5px;border:2px solid var(--dsw-alias-state-business-primary);border-radius:8px;pointer-events:none}" +
      ".__dsi_tabActive{color:var(--dsw-alias-label-primary);font-weight:600;border-bottom-color:var(--dsw-alias-state-business-primary)}" +
      // Slide switch — native input visually hidden BUT the control keeps a
      // visible keyboard focus treatment on the track (accessibility gate).
      ".__dsi_switch{position:relative;display:inline-block;width:36px;height:20px;flex:none}" +
      ".__dsi_switch input{opacity:0;width:0;height:0;position:absolute}" +
      ".__dsi_switch input:focus-visible + .__dsi_switchTrack{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}" +
      ".__dsi_switch input:hover + .__dsi_switchTrack{cursor:pointer}" +
      ".__dsi_switchTrack{position:absolute;inset:0;background:var(--dsw-alias-bg-layer-3);border:1px solid var(--dsw-alias-border-l2);border-radius:10px;transition:background .15s,border-color .15s}" +
      ".__dsi_switch input:checked + .__dsi_switchTrack{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_switchThumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transition:transform .15s,background .15s}" +
      ".__dsi_switch input:checked ~ .__dsi_switchThumb{transform:translateX(16px);background:var(--dsw-alias-label-on-accent,#fff)}" +
      // Collapsible panel (button semantics: keyboard toggles)
      ".__dsi_collapse{display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_collapseHeader{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:8px 12px;background:var(--dsw-alias-bg-layer-2);font:inherit;text-align:left;width:100%}" +
      ".__dsi_collapseHeader:hover{border-color:var(--dsw-alias-state-business-primary)}" +
      ".__dsi_collapseHeader:focus-visible{border-color:var(--dsw-alias-state-business-primary);outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}" +
      ".__dsi_collapseTitle{flex:1;font-size:14px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_collapseCount{font-size:12px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_collapseChevron{font-size:12px;color:var(--dsw-alias-label-tertiary);transition:transform .15s}" +
      ".__dsi_collapseOpen .__dsi_collapseChevron{transform:rotate(90deg)}" +
      ".__dsi_collapseBody{padding:2px 4px;display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_persona{white-space:pre-wrap;font-size:13px;line-height:21px;color:var(--dsw-alias-label-secondary);max-height:260px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:10px 12px;background:var(--dsw-alias-bg-layer-2)}" +
      // Detail modal (semantic dialog + Escape is wired in JS)
      ".__dsi_modalBackdrop{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px}" +
      ".__dsi_modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:16px;max-width:640px;width:100%;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 8px 40px rgba(0,0,0,.25)}" +
      ".__dsi_modalHeader{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__dsi_modalTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_modalBody{padding:16px 18px;overflow:auto;display:flex;flex-direction:column;gap:12px}" +
      ".__dsi_modalContent{white-space:pre-wrap;overflow-wrap:anywhere;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:12px 14px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__dsi_modalMeta{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__dsi_modalMeta b{font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums}" +
      ".__dsi_table caption{text-align:left;padding:0 0 6px;color:var(--dsw-alias-label-secondary);font-size:12px}" +
      ".__dsi_table th,.__dsi_table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);overflow-wrap:anywhere}" +
      ".__dsi_table th{color:var(--dsw-alias-label-secondary);font-weight:600}" +
      // ── Overview / dashboard primitives
      ".__dsi_root > .__dsi_btn{align-self:flex-start}" +
      ".__dsi_toolbar{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}" +
      ".__dsi_toolbar p{margin:0}" +
      ".__dsi_btnSm{height:28px;padding:0 10px;font-size:13px;line-height:26px;border-radius:8px;white-space:nowrap}" +
      ".__dsi_btnGhost{background:transparent}" +
      ".__dsi_card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:14px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}" +
      ".__dsi_cardHead{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}" +
      ".__dsi_cardTitle{margin:0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_cardSub{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}" +
      ".__dsi_stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(118px,100%),1fr));gap:10px}" +
      ".__dsi_stat{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:12px;padding:12px 14px;display:flex;flex-direction:column;gap:2px}" +
      ".__dsi_statValue{font-size:24px;font-weight:600;line-height:30px;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}" +
      ".__dsi_statLabel{font-size:13px;line-height:18px;color:var(--dsw-alias-label-secondary)}" +
      ".__dsi_pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 10px;border-radius:11px;font-size:12px;font-weight:600;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-3)}" +
      ".__dsi_pill::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor}" +
      ".__dsi_pillOn{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}" +
      ".__dsi_pillWarn{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-state-error-primary));border-color:currentColor}" +
      ".__dsi_kv{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(180px,100%),1fr));gap:8px 16px;margin:0}" +
      ".__dsi_kv > div{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}" +
      ".__dsi_kv dt{font-size:13px;color:var(--dsw-alias-label-secondary)}" +
      ".__dsi_kv dd{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}" +
      ".__dsi_callout{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}" +
      ".__dsi_muted{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}" +
      ".__dsi_list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}" +
      ".__dsi_listItem{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px;background:var(--dsw-alias-bg-layer-3)}" +
      ".__dsi_listMain{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".__dsi_listTitle{font-size:14px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}" +
      ".__dsi_notes{margin:0;padding:10px 12px 10px 28px;border-radius:10px;background:var(--dsw-alias-bg-layer-3);font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}" +
      // ── Settings layout
      ".__dsi_section{display:flex;flex-direction:column;gap:12px}" +
      ".__dsi_sectionTitle{margin:6px 0 0;font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_switchRow{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}" +
      ".__dsi_switchText{display:flex;flex-direction:column;gap:2px;min-width:0}" +
      ".__dsi_switchRow .__dsi_switch{margin-top:2px}" +
      ".__dsi_details{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-2)}" +
      ".__dsi_details > summary{cursor:pointer;list-style:none;display:flex;align-items:center;gap:8px;padding:10px 14px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary)}" +
      ".__dsi_details > summary::-webkit-details-marker{display:none}" +
      ".__dsi_details > summary::before{content:'▸';font-size:11px;color:var(--dsw-alias-label-tertiary);transition:transform .15s}" +
      ".__dsi_details[open] > summary::before{transform:rotate(90deg)}" +
      ".__dsi_details > summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px;border-radius:12px}" +
      ".__dsi_detailsBody{padding:4px 14px 14px;display:flex;flex-direction:column;gap:12px}" +
      ".__dsi_saveBar{position:sticky;bottom:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:10px 12px;margin-top:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 -6px 18px rgba(0,0,0,.18)}" +
      ".__dsi_textarea{min-height:64px;height:auto;resize:vertical;line-height:20px;font-family:var(--dsw-font-mono,ui-monospace,monospace);font-size:12px}" +
      "@container (max-width:420px){.__dsi_btnSm{white-space:normal;height:auto;min-height:28px}.__dsi_browserRow{flex-direction:column}.__dsi_browserOps{flex:1 1 auto;flex-wrap:wrap}.__dsi_kv > div{flex-wrap:wrap}.__dsi_switchRow{gap:8px}}" +
      "@media (prefers-reduced-motion: reduce){.__dsi_tab,.__dsi_collapseChevron,.__dsi_switchTrack,.__dsi_btn{transition:none;animation:none}}";
    var tagId = "dsh-self-improved/main.css";
    if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
      var tag = document.createElement("style");
      tag.dataset.plugin = "dsh-self-improved";
      tag.dataset.pluginCss = tagId;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    // ─═ [locale] ═══════════════════════════════════════════════════════════
    var NS = "selfImproved";
    var NAMESPACE = "dsh-self-improved";
    /** Business remote namespace (both the host service and these descriptors). */
    var REMOTE_NS = "selfImproved";
    var zh = {
      sectionGeneral: "General",
      sectionContinuity: "Session continuity",
      sectionContinuitySub: "Notice when you stop partway through a task, and offer to pick it up from another session in the same project.",
      sectionEpisodes: "Learning from tool use",
      sectionAdvanced: "Advanced tuning",
      sectionAdvancedSub: "The defaults work well. Change these only if you know what you want.",
      overriddenHint: "Set in your configuration, not the default",
      allSaved: "All changes saved",
      discard: "Discard",
      nav: "进化记忆",
      tabOverview: "Overview",
      tabSessions: "Sessions",
      tabConfig: "Settings",
      tabMemories: "Memory",
      intro: "Remembers what you teach it across sessions, recalls relevant memories before each reply, and tidies itself up over time. Everything is stored on this machine.",
      helpTitle: "About this plugin",
      help: [
        "dsh-self-improved adds cross-session long-term memory and self-evolution to DSH. Data is stored locally by default ($DSH_HOME/memory); LLM-backed features send their required prompt content to the configured provider.",
        "",
        "[Changes apply live]",
        "Editable settings here are volatile: saving applies to the running plugin without a restart. Filesystem roots are initialization-only (the memory storage directory, and the synthesized-skills root): a change to either takes effect after the plugin restarts; the running fiber keeps the startup value.",
        "An embedding API key is stored as a secret: it never comes back to this form; leave the field blank to keep the current key.",
        "",
        "[Pipeline]",
        "L0 capture: each session's conversation is saved locally for the extraction pipeline.",
        "L1 extraction: a background LLM distills atomic memories (fact / preference / event / instruction) with JSON validation, dedup and sensitive-info filtering.",
        "L2 scenes / L3 persona: memories are grouped into scene blocks; a versioned user persona is synthesized incrementally.",
        "Auto recall injection: before each turn, relevant memories are retrieved by the current question and injected to the model as a memory block.",
        "Self-evolution: memories decay by importance × recency × access; users can correct memories; successful patterns can become reusable skills in dsh-skill.",
        "",
        "[Conservative policy]",
        "• Extraction provenanceFilter=strict + requireEvidence=true: only human-confirmed memories with evidence enter the store",
        "• Recall is gated by relevance margin, importance floor, and a per-turn injection cap",
        "• Skill synthesis is opt-in; learned skills stay reviewable before use",
        "",
        "[Usage]",
        "• Type \"/\" in the chat input to open the command menu: /memory status, /memory list, /memory search <q>, /memory forget <id>, /memory correct <id> <text>",
        "• The model auto-uses memory tools (memory_search etc.) — no manual action needed",
        "",
        "[Notes]",
        "• Disabling the master switch stops background work; stored memories are kept and everything resumes when re-enabled — the Memory tab stays accessible for inspection while paused",
        "• Uninstalling the plugin does not delete local memory data"
      ].join("\n"),
      groupMaster: "Diagnostics",
      fContinuityEnabled: "Track unfinished work",
      fContinuitySummary: "Write handoff summaries with the model",
      fContinuitySummaryHint: "Sends short excerpts of your own messages to the extraction model to write handoff notes. Redaction is best-effort, so sensitive text can slip through. Off by default.",
      fContinuitySessions: "Never track these sessions",
      fContinuityProjects: "Never track these projects",
      groupModules: "More features",
      groupStorage: "Storage",
      groupExtract: "Memory extraction",
      groupRecall: "Recall",
      groupConsolidate: "Persona and scenes",
      groupEvolve: "Forgetting and skills",
      groupHousekeeping: "Size limits",
      groupReview: "Nightly review",
      save: "Save",
      resetScoped: "Reset to defaults",
      resetConfirm: "Reset this group to its default values? Only this group changes.",
      saved: "Saved. Changes apply right away.",
      saving: "Saving…",
      error: "Save failed",
      conflict: "These settings changed elsewhere since you started editing. Your edits are kept below; review them and save again to rebase.",
      conflictKeep: "Keep my edits (rebase)",
      conflictDiscard: "Discard my edits",
      conflictDiscardConfirm: "Discard your unsaved edits? This restores the host section in the form.",
      dirtyBadge: "unsaved",
      dirtySummary: "{n} unsaved change(s)",
      restartNote: "restart required",
      unavailable: "Settings aren't available: the dsh-self-improved plugin isn't running on this host.",
      overridden: "custom",
      secretSet: "key stored",
      secretUnset: "no key",
      secretHint: "Leave empty to keep the stored key.",
      loading: "Loading…",
      fEnabled: "Enable Evolving Memory",
      fDebug: "Verbose debug logs",
      fCapture: "Save conversations for memory",
      fExtract: "Learn memories from conversations",
      fConsolidate: "Build persona and scenes",
      fEvolve: "Forget stale memories",
      fRecall: "Recall memories before each reply",
      fTools: "Give the agent memory search tools",
      fStorageRoot: "Memory folder (empty = $DSH_HOME/memory)",
      fSearchLimit: "Search results per tool call",
      fProvider: "Extraction provider (empty = default)",
      fModel: "Extraction model (empty = default)",
      fInterval: "Check for new conversations every (minutes)",
      fBatchChars: "Max characters per extraction batch",
      fMaxTokens: "Max output tokens",
      fTimeoutMs: "Extraction timeout (ms)",
      fDedup: "Skip near-duplicate memories",
      fMinImportance: "Ignore memories below importance",
      fFallback: "Fallback to summary on bad JSON",
      fFlushDrain: "Finish extraction before headless runs exit",
      fProvenance: "Extraction provenance filter",
      fProvenanceHint: "strict (recommended) = only memories confirmed as human-authored/curated enter the long-term store. off disables the filter (not recommended).",
      fRequireEvidence: "Require a quote from the conversation",
      fRequireEvidenceHint: "When on, memories the extraction model produced without quoting evidence from the conversation are rejected — the conservative default.",
      fStrategy: "Recall method",
      fStrategyHint: "keyword: fast, no extra calls (default). hybrid: keyword plus embeddings; needs an embedding endpoint below and falls back to keyword without one.",
      fMaxResults: "Max recall results",
      fScoreThreshold: "Minimum match score (0 = off)",
      fRelevanceMargin: "Relevance strictness (0–1)",
      fRelevanceMarginHint: "Higher is stricter. 0.5 (default) only injects clearly relevant memories.",
      fRecallMinImportance: "Minimum importance to recall (0 = any)",
      fRecallMinImportanceHint: "",
      fMaxInjectPerTurn: "Max memories per reply",
      fMaxInjectPerTurnHint: "Default 4. 0 means no limit, which can crowd the prompt.",
      fRecallTimeout: "Recall timeout (ms)",
      fEmbBase: "Embedding endpoint URL (empty = keyword only)",
      fEmbKey: "Embedding API key",
      fEmbModel: "Embedding model",
      fEmbDims: "Embedding dimensions",
      fEmbTimeout: "Embedding timeout (ms)",
      fSceneMax: "Memories considered for scenes",
      fScenesEnabled: "Group memories into scenes",
      fScenesEnabledHint: "Off by default. When on, the nightly review also builds scene summaries.",
      fPersonaMax: "Memories considered for persona",
      fSceneBatch: "Max memories per scene",
      fDecay: "Forget unused memories over time",
      fDecayAge: "Only forget memories older than (days)",
      fDecayThreshold: "Forgetting threshold",
      fDecayRetention: "Keep forgotten memories for (days, 0 = forever)",
      fDecayMaxActive: "Max active memories (0 = no limit)",
      fSkill: "Write skills from repeated procedures",
      fSkillMin: "Minimum importance for a skill",
      fSkillRoot: "Skills folder (empty = $DSH_HOME/skills)",
      fSkillPrefix: "Skill name prefix",
      fSkillMax: "Max skills (0 = no limit)",
      fHkPersona: "Persona versions to keep",
      fHkScenes: "Max scenes",
      fHkSceneRatio: "Remove scenes below active-memory ratio (0–1)",
      fHkConvDays: "Keep saved conversations for (days, 0 = forever)",
      fRecallInjectChars: "Max recalled text per reply (characters)",
      fReviewEnabled: "Run a full review every night",
      fReviewTime: "Review time (HH:MM, 24h)",
      /* episode learning */
      groupEpisodes: "Learning from tool use",
      fEpEnabled: "Record tool calls and their outcomes",
      fEpEnabledHint: "Saves each tool call and result on this machine, with arguments and output redacted. If outcome review is on, that redacted record is sent to your configured provider to learn from. You can purge it any time from the Memory tab.",
      fEpCaptureArgs: "Capture tool arguments",
      fEpExcerpt: "Result excerpt chars (max)",
      fEpRetention: "Episode record retention days",
      fEpReview: "Run LLM outcome review (manual/nightly only)",
      fEpReviewHint: "Sends redacted episode evidence to the configured LLM provider to create project-scoped, evidence-cited operational memories. Manual/nightly only; never per-flush.",
      fEpConf: "Operational memory confidence floor",
      fEpExpiry: "Operational memory expiry days",
      fEpRecall: "Inject operational recall (labeled, separate)",
      fEpRecallHint: "Off by default: injects derived, project-scoped operational knowledge as a fallible labeled block — never into persona/baseline.",
      fEpRecallMax: "Max operational recall results",
      fEpRecallChars: "Max operational recall chars",
      fEpSkillMin: "Minimum independent sessions per draft",
      fEpSkillDrafts: "Generate inactive skill drafts (opt-in)",
      fEpSkillDraftsHint: "On full review, sends reviewed redacted episode evidence to the configured LLM provider. Stores proposals locally as inactive drafts; it never loads or activates a skill.",
      episodeEnableWarning: "Episode learning stores every tool call and result (redacted and bounded) locally. If LLM outcome review is enabled, redacted episode evidence is sent to your configured LLM provider. Purge stored episodes from the Memory tab. Enable capture now?",
      /* memory browser */
      browserSearch: "Filter",
      browserRefresh: "Refresh",
      browserSummary: "{n} memories · {p} waiting to process · {s} scenes · {k} skills · {e} tool episodes",
      browserEmpty: "(no active memories)",
      browserPersona: "Persona",
      browserPersonaEmpty: "(no persona yet — self-evolution synthesizes it as memories accumulate)",
      browserMemories: "Memories",
      browserScenes: "Scenes",
      browserScenesEmpty: "(no scenes yet)",
      browserSkills: "Learned skills",
      browserSkillsEmpty: "(no skills yet)",
      browserSynth: "synthesized",
      browserSkillDelete: "Delete",
      browserSkillDeleteConfirm: "Delete this synthesized skill? (system skills are protected)",
      browserSkillDeleted: "Deleted",
      browserDetail: "Detail",
      browserDetailClose: "Close",
      browserConfirm: "Confirm",
      browserCancel: "Cancel",
      browserStaged: "Staged — confirm to run",
      browserRemoteUnavailable: "Memory actions are unavailable in this channel (the typed business remote is not reachable from this host).",
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
      browserCorrected: "Corrected",
      browserForgotten: "Forgotten",
      groupEpisodesBrowser: "Episodes (tool outcomes)",
      browserEpisodesDisabled: "(episode learning disabled — enable it in Config to inspect stored rows; counts below still show)",
      browserEpisodesEmpty: "(no episodes recorded yet)",
      browserEpisodePurge: "Purge >30d",
      browserEpisodePurgeAll: "Purge all",
      browserEpisodePurgeConfirm: "Purge episode records and linked tool evidence? This also forgets episode-derived operational memories and invalidates supported skill drafts; user-authored memories remain.",
      browserEpisodeDryReview: "Dry-review",
      browserEpisodeDryReviewRun: "Dry-review running…",
      browserEpisodeDetailTitle: "Episode detail (redacted)",
      browserEpisodeNoSteps: "(no steps recorded)",
      browserEpisodeLastReview: "Last review:",
      browserMetaSession: "Session",
      browserMetaTurn: "Turn",
      browserMetaProject: "Project",
      browserMetaSummary: "Summary",
      browserMetaConfidence: "Confidence",
      browserMetaFingerprint: "Fingerprint",
      browserMetaRejectReason: "Reject reason",
      browserMetaStarted: "Started",
      browserMetaEnded: "Ended"
    };
    var en = {
      sectionGeneral: "General",
      sectionContinuity: "Session continuity",
      sectionContinuitySub: "Notice when you stop partway through a task, and offer to pick it up from another session in the same project.",
      sectionEpisodes: "Learning from tool use",
      sectionAdvanced: "Advanced tuning",
      sectionAdvancedSub: "The defaults work well. Change these only if you know what you want.",
      overriddenHint: "Set in your configuration, not the default",
      allSaved: "All changes saved",
      discard: "Discard",
      nav: "Evolving Memory",
      tabOverview: "Overview",
      tabSessions: "Sessions",
      tabConfig: "Settings",
      tabMemories: "Memory",
      intro: "Remembers what you teach it across sessions, recalls relevant memories before each reply, and tidies itself up over time. Everything is stored on this machine.",
      helpTitle: "About this plugin",
      help: [
        "dsh-self-improved adds cross-session long-term memory and self-evolution to DSH. Data is stored locally by default ($DSH_HOME/memory); LLM-backed features send their required prompt content to the configured provider.",
        "",
        "[Changes apply live]",
        "Editable settings here are volatile: saving applies to the running plugin without a restart. Filesystem roots are initialization-only (the memory storage directory, and the synthesized-skills root): a change to either takes effect after the plugin restarts; the running fiber keeps the startup value.",
        "An embedding API key is stored as a secret: it never comes back to this form; leave the field blank to keep the current key.",
        "",
        "[Pipeline]",
        "L0 capture: each session's conversation is saved locally for the extraction pipeline.",
        "L1 extraction: a background LLM distills atomic memories (fact / preference / event / instruction) with JSON validation, dedup and sensitive-info filtering.",
        "L2 scenes / L3 persona: memories are grouped into scene blocks; a versioned user persona is synthesized incrementally.",
        "Auto recall injection: before each turn, relevant memories are retrieved by the current question and injected to the model as a memory block.",
        "Self-evolution: memories decay by importance × recency × access; users can correct memories; successful patterns can become reusable skills in dsh-skill.",
        "",
        "[Conservative policy]",
        "• Extraction provenanceFilter=strict + requireEvidence=true: only human-confirmed memories with evidence enter the store",
        "• Recall is gated by relevance margin, importance floor, and a per-turn injection cap",
        "• Skill synthesis is opt-in; learned skills stay reviewable before use",
        "",
        "[Usage]",
        "• Type \"/\" in the chat input to open the command menu: /memory status, /memory list, /memory search <q>, /memory forget <id>, /memory correct <id> <text>",
        "• The model auto-uses memory tools (memory_search etc.) — no manual action needed",
        "",
        "[Notes]",
        "• Disabling the master switch stops background work; stored memories are kept and everything resumes when re-enabled — the Memory tab stays accessible for inspection while paused",
        "• Uninstalling the plugin does not delete local memory data"
      ].join("\n"),
      groupMaster: "Diagnostics",
      fContinuityEnabled: "Track unfinished work",
      fContinuitySummary: "Write handoff summaries with the model",
      fContinuitySummaryHint: "Sends short excerpts of your own messages to the extraction model to write handoff notes. Redaction is best-effort, so sensitive text can slip through. Off by default.",
      fContinuitySessions: "Never track these sessions",
      fContinuityProjects: "Never track these projects",
      groupModules: "More features",
      groupStorage: "Storage",
      groupExtract: "Memory extraction",
      groupRecall: "Recall",
      groupConsolidate: "Persona and scenes",
      groupEvolve: "Forgetting and skills",
      groupHousekeeping: "Size limits",
      groupReview: "Nightly review",
      save: "Save",
      resetScoped: "Reset to defaults",
      resetConfirm: "Reset this group to its default values? Only this group changes.",
      saved: "Saved. Changes apply right away.",
      saving: "Saving…",
      error: "Save failed",
      conflict: "These settings changed elsewhere since you started editing. Your edits are kept below; review them and save again to rebase.",
      conflictKeep: "Keep my edits (rebase)",
      conflictDiscard: "Discard my edits",
      conflictDiscardConfirm: "Discard your unsaved edits? This restores the host section in the form.",
      dirtyBadge: "unsaved",
      dirtySummary: "{n} unsaved change(s)",
      restartNote: "restart required",
      unavailable: "Settings aren't available: the dsh-self-improved plugin isn't running on this host.",
      overridden: "custom",
      secretSet: "key stored",
      secretUnset: "no key",
      secretHint: "Leave empty to keep the stored key.",
      loading: "Loading…",
      fEnabled: "Enable Evolving Memory",
      fDebug: "Verbose debug logs",
      fCapture: "Save conversations for memory",
      fExtract: "Learn memories from conversations",
      fConsolidate: "Build persona and scenes",
      fEvolve: "Forget stale memories",
      fRecall: "Recall memories before each reply",
      fTools: "Give the agent memory search tools",
      fStorageRoot: "Memory folder (empty = $DSH_HOME/memory)",
      fSearchLimit: "Search results per tool call",
      fProvider: "Extraction provider (empty = default)",
      fModel: "Extraction model (empty = default)",
      fInterval: "Check for new conversations every (minutes)",
      fBatchChars: "Max characters per extraction batch",
      fMaxTokens: "Max output tokens",
      fTimeoutMs: "Extraction timeout (ms)",
      fDedup: "Skip near-duplicate memories",
      fMinImportance: "Ignore memories below importance",
      fFallback: "Fallback to summary on bad JSON",
      fFlushDrain: "Finish extraction before headless runs exit",
      fProvenance: "Extraction provenance filter",
      fProvenanceHint: "strict (recommended) = only memories confirmed as human-authored/curated enter the long-term store. off disables the filter (not recommended).",
      fRequireEvidence: "Require a quote from the conversation",
      fRequireEvidenceHint: "When on, memories the extraction model produced without quoting evidence from the conversation are rejected — the conservative default.",
      fStrategy: "Recall method",
      fStrategyHint: "keyword: fast, no extra calls (default). hybrid: keyword plus embeddings; needs an embedding endpoint below and falls back to keyword without one.",
      fMaxResults: "Max recall results",
      fScoreThreshold: "Minimum match score (0 = off)",
      fRelevanceMargin: "Relevance strictness (0–1)",
      fRelevanceMarginHint: "Higher is stricter. 0.5 (default) only injects clearly relevant memories.",
      fRecallMinImportance: "Minimum importance to recall (0 = any)",
      fRecallMinImportanceHint: "",
      fMaxInjectPerTurn: "Max memories per reply",
      fMaxInjectPerTurnHint: "Default 4. 0 means no limit, which can crowd the prompt.",
      fRecallTimeout: "Recall timeout (ms)",
      fEmbBase: "Embedding endpoint URL (empty = keyword only)",
      fEmbKey: "Embedding API key",
      fEmbModel: "Embedding model",
      fEmbDims: "Embedding dimensions",
      fEmbTimeout: "Embedding timeout (ms)",
      fSceneMax: "Memories considered for scenes",
      fScenesEnabled: "Group memories into scenes",
      fScenesEnabledHint: "Off by default. When on, the nightly review also builds scene summaries.",
      fPersonaMax: "Memories considered for persona",
      fSceneBatch: "Max memories per scene",
      fDecay: "Forget unused memories over time",
      fDecayAge: "Only forget memories older than (days)",
      fDecayThreshold: "Forgetting threshold",
      fDecayRetention: "Keep forgotten memories for (days, 0 = forever)",
      fDecayMaxActive: "Max active memories (0 = no limit)",
      fSkill: "Write skills from repeated procedures",
      fSkillMin: "Minimum importance for a skill",
      fSkillRoot: "Skills folder (empty = $DSH_HOME/skills)",
      fSkillPrefix: "Skill name prefix",
      fSkillMax: "Max skills (0 = no limit)",
      fHkPersona: "Persona versions to keep",
      fHkScenes: "Max scenes",
      fHkSceneRatio: "Remove scenes below active-memory ratio (0–1)",
      fHkConvDays: "Keep saved conversations for (days, 0 = forever)",
      fRecallInjectChars: "Max recalled text per reply (characters)",
      fReviewEnabled: "Run a full review every night",
      fReviewTime: "Review time (HH:MM, 24h)",
      groupEpisodes: "Learning from tool use",
      fEpEnabled: "Record tool calls and their outcomes",
      fEpEnabledHint: "Saves each tool call and result on this machine, with arguments and output redacted. If outcome review is on, that redacted record is sent to your configured provider to learn from. You can purge it any time from the Memory tab.",
      fEpCaptureArgs: "Capture tool arguments",
      fEpExcerpt: "Result excerpt chars (max)",
      fEpRetention: "Episode record retention days",
      fEpReview: "Run LLM outcome review (manual/nightly only)",
      fEpReviewHint: "Sends redacted episode evidence to the configured LLM provider to create project-scoped, evidence-cited operational memories. Manual/nightly only; never per-flush.",
      fEpConf: "Operational memory confidence floor",
      fEpExpiry: "Operational memory expiry days",
      fEpRecall: "Inject operational recall (labeled, separate)",
      fEpRecallHint: "Off by default: injects derived, project-scoped operational knowledge as a fallible labeled block — never into persona/baseline.",
      fEpRecallMax: "Max operational recall results",
      fEpRecallChars: "Max operational recall chars",
      fEpSkillMin: "Minimum independent sessions per draft",
      fEpSkillDrafts: "Generate inactive skill drafts (opt-in)",
      fEpSkillDraftsHint: "On full review, sends reviewed redacted episode evidence to the configured LLM provider. Stores proposals locally as inactive drafts; it never loads or activates a skill.",
      episodeEnableWarning: "Episode learning stores every tool call and result (redacted and bounded) locally. If LLM outcome review is enabled, redacted episode evidence is sent to your configured LLM provider. Purge stored episodes from the Memory tab. Enable capture now?",
      browserSearch: "Filter",
      browserRefresh: "Refresh",
      browserSummary: "{n} memories · {p} waiting to process · {s} scenes · {k} skills · {e} tool episodes",
      browserEmpty: "(no active memories)",
      browserPersona: "Persona",
      browserPersonaEmpty: "(no persona yet — self-evolution synthesizes it as memories accumulate)",
      browserMemories: "Memories",
      browserScenes: "Scenes",
      browserScenesEmpty: "(no scenes yet)",
      browserSkills: "Learned skills",
      browserSkillsEmpty: "(no skills yet)",
      browserSynth: "synthesized",
      browserSkillDelete: "Delete",
      browserSkillDeleteConfirm: "Delete this synthesized skill? (system skills are protected)",
      browserSkillDeleted: "Deleted",
      browserDetail: "Detail",
      browserDetailClose: "Close",
      browserConfirm: "Confirm",
      browserCancel: "Cancel",
      browserStaged: "Staged — confirm to run",
      browserRemoteUnavailable: "Memory actions are unavailable in this channel (the typed business remote is not reachable from this host).",
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
      browserCorrected: "Corrected",
      browserForgotten: "Forgotten",
      groupEpisodesBrowser: "Episodes (tool outcomes)",
      browserEpisodesDisabled: "(episode learning disabled — enable it in Config to inspect stored rows; counts below still show)",
      browserEpisodesEmpty: "(no episodes recorded yet)",
      browserEpisodePurge: "Purge >30d",
      browserEpisodePurgeAll: "Purge all",
      browserEpisodePurgeConfirm: "Purge episode records and linked tool evidence? This also forgets episode-derived operational memories and invalidates supported skill drafts; user-authored memories remain.",
      browserEpisodeDryReview: "Dry-review",
      browserEpisodeDryReviewRun: "Dry-review running…",
      browserEpisodeDetailTitle: "Episode detail (redacted)",
      browserEpisodeNoSteps: "(no steps recorded)",
      browserEpisodeLastReview: "Last review:",
      browserMetaSession: "Session",
      browserMetaTurn: "Turn",
      browserMetaProject: "Project",
      browserMetaSummary: "Summary",
      browserMetaConfidence: "Confidence",
      browserMetaFingerprint: "Fingerprint",
      browserMetaRejectReason: "Reject reason",
      browserMetaStarted: "Started",
      browserMetaEnded: "Ended"
    };

    // ─═ [settings-form] ════════════════════════════════════════════════════
    /**
     * Field inventory — the client-side mirror of src/runtime-config.ts's
     * FIELD_CLASSIFICATION (scripts/test-v02-settings.mjs asserts parity).
     * uiClass: everyday | advanced | init-only | secret
     */
    var FIELDS = [
      { path: ["enabled"], uiClass: "everyday", group: "groupMaster" },
      { path: ["continuity", "enabled"], uiClass: "everyday", group: "groupMaster", type: "checkbox" },
      { path: ["continuity", "summaryEnabled"], uiClass: "everyday", group: "groupMaster", type: "checkbox", hint: "fContinuitySummaryHint", fallback: false },
      { path: ["continuity", "excludedSessionIds"], uiClass: "everyday", group: "groupMaster", type: "string-list" },
      { path: ["continuity", "excludedProjectIds"], uiClass: "everyday", group: "groupMaster", type: "string-list" },
      { path: ["debug"], uiClass: "advanced", group: "groupMaster" },
      { path: ["modules", "capture"], uiClass: "everyday", group: "groupModules" },
      { path: ["modules", "extract"], uiClass: "everyday", group: "groupModules" },
      { path: ["modules", "consolidate"], uiClass: "advanced", group: "groupModules" },
      { path: ["modules", "evolve"], uiClass: "advanced", group: "groupModules" },
      { path: ["modules", "recall"], uiClass: "everyday", group: "groupModules" },
      { path: ["modules", "tools"], uiClass: "everyday", group: "groupModules" },
      { path: ["storageRoot"], uiClass: "init-only", group: "groupStorage" },
      { path: ["searchLimit"], uiClass: "advanced", group: "groupStorage" },
      { path: ["extract", "provider"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "model"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "intervalMinutes"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "batchMaxChars"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "maxOutputTokens"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "timeoutMs"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "minImportance"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "dedup"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "fallbackOnBadJson"], uiClass: "retired", group: "groupExtract" },
      { path: ["extract", "flushDrain"], uiClass: "advanced", group: "groupExtract" },
      { path: ["extract", "provenanceFilter"], uiClass: "migration-only", group: "groupExtract", type: "select", options: ["strict", "off"], fallback: "strict", hint: "fProvenanceHint" },
      { path: ["extract", "requireEvidence"], uiClass: "advanced", group: "groupExtract" },
      { path: ["recall", "strategy"], uiClass: "advanced", group: "groupRecall", type: "select", options: ["keyword", "hybrid"], hint: "fStrategyHint", fallback: undefined },
      { path: ["recall", "maxResults"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "scoreThreshold"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "relevanceMargin"], uiClass: "advanced", group: "groupRecall", hint: "fRelevanceMarginHint" },
      { path: ["recall", "minImportance"], uiClass: "advanced", group: "groupRecall", hint: "fRecallMinImportanceHint" },
      { path: ["recall", "maxInjectPerTurn"], uiClass: "advanced", group: "groupRecall", hint: "fMaxInjectPerTurnHint" },
      { path: ["recall", "timeoutMs"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "maxInjectChars"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "embedding", "baseUrl"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "embedding", "apiKey"], uiClass: "secret", group: "groupRecall", hint: "secretHint" },
      { path: ["recall", "embedding", "model"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "embedding", "dimensions"], uiClass: "advanced", group: "groupRecall" },
      { path: ["recall", "embedding", "timeoutMs"], uiClass: "advanced", group: "groupRecall" },
      { path: ["consolidate", "scenesEnabled"], uiClass: "advanced", group: "groupConsolidate" },
      { path: ["consolidate", "sceneMaxMemories"], uiClass: "advanced", group: "groupConsolidate" },
      { path: ["consolidate", "personaMaxMemories"], uiClass: "advanced", group: "groupConsolidate" },
      { path: ["consolidate", "sceneBatchSize"], uiClass: "advanced", group: "groupConsolidate" },
      { path: ["evolve", "decay", "enabled"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "decay", "minAgeDays"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "decay", "threshold"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "decay", "retentionDays"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "decay", "maxActiveMemories"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "enabled"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "minImportance"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "skillsRoot"], uiClass: "init-only", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "prefix"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "maxSkills"], uiClass: "advanced", group: "groupEvolve" },
      { path: ["housekeeping", "personaVersions"], uiClass: "advanced", group: "groupHousekeeping" },
      { path: ["housekeeping", "maxScenes"], uiClass: "advanced", group: "groupHousekeeping" },
      { path: ["housekeeping", "sceneActiveRatio"], uiClass: "advanced", group: "groupHousekeeping" },
      { path: ["housekeeping", "conversationRetentionDays"], uiClass: "advanced", group: "groupHousekeeping" },
      { path: ["review", "enabled"], uiClass: "advanced", group: "groupReview" },
      { path: ["review", "time"], uiClass: "advanced", group: "groupReview" },
      { path: ["episodeLearning", "enabled"], uiClass: "everyday", group: "groupEpisodes", hint: "fEpEnabledHint" },
      { path: ["episodeLearning", "captureArguments"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "resultExcerptChars"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "retentionDays"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "reviewEnabled"], uiClass: "advanced", group: "groupEpisodes", hint: "fEpReviewHint" },
      { path: ["episodeLearning", "confidenceFloor"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "expiryDays"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "operationalRecallEnabled"], uiClass: "advanced", group: "groupEpisodes", hint: "fEpRecallHint" },
      { path: ["episodeLearning", "maxRecallResults"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "maxRecallChars"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "skillMinEpisodes"], uiClass: "advanced", group: "groupEpisodes" },
      { path: ["episodeLearning", "skillDraftsEnabled"], uiClass: "advanced", group: "groupEpisodes", hint: "fEpSkillDraftsHint" }
    ];
    /** checkbox/number/text shape table mirrors the host schema. */
    var CHECKBOX_KEYS = [
      "enabled", "debug", "modules.capture", "modules.extract", "modules.consolidate", "modules.evolve", "modules.recall", "modules.tools",
      "extract.dedup", "extract.flushDrain", "extract.requireEvidence",
      "consolidate.scenesEnabled", "evolve.decay.enabled", "evolve.skillSynthesis.enabled", "review.enabled",
      "episodeLearning.enabled", "episodeLearning.captureArguments", "episodeLearning.reviewEnabled", "episodeLearning.operationalRecallEnabled", "episodeLearning.skillDraftsEnabled"
    ];
    var TEXT_KEYS = [
      "storageRoot", "extract.provider", "extract.model",
      "recall.embedding.baseUrl", "recall.embedding.model", "recall.embedding.apiKey",
      "evolve.skillSynthesis.skillsRoot", "evolve.skillSynthesis.prefix", "review.time"
    ];
    var SELECT_KEYS = ["recall.strategy", "extract.provenanceFilter"];
    function isPathLikeCheckbox(key) { return CHECKBOX_KEYS.includes(key); }
    function isPathLikeNumber(key) {
      return !isPathLikeCheckbox(key) && !TEXT_KEYS.includes(key) && !SELECT_KEYS.includes(key);
    }

    FIELDS.forEach(function (f) {
      f.key = f.path.join(".");
      f.label = ({
        "continuity.enabled": "fContinuityEnabled", "continuity.summaryEnabled": "fContinuitySummary", "continuity.excludedSessionIds": "fContinuitySessions", "continuity.excludedProjectIds": "fContinuityProjects",
        enabled: "fEnabled", debug: "fDebug",
        "modules.capture": "fCapture", "modules.extract": "fExtract", "modules.consolidate": "fConsolidate",
        "modules.evolve": "fEvolve", "modules.recall": "fRecall", "modules.tools": "fTools",
        storageRoot: "fStorageRoot", searchLimit: "fSearchLimit",
        "extract.provider": "fProvider", "extract.model": "fModel", "extract.intervalMinutes": "fInterval",
        "extract.batchMaxChars": "fBatchChars", "extract.maxOutputTokens": "fMaxTokens", "extract.timeoutMs": "fTimeoutMs", "extract.minImportance": "fMinImportance",
        "extract.dedup": "fDedup", "extract.fallbackOnBadJson": "fFallback", "extract.flushDrain": "fFlushDrain",
        "extract.provenanceFilter": "fProvenance", "extract.requireEvidence": "fRequireEvidence",
        "recall.strategy": "fStrategy", "recall.maxResults": "fMaxResults", "recall.scoreThreshold": "fScoreThreshold",
        "recall.relevanceMargin": "fRelevanceMargin", "recall.minImportance": "fRecallMinImportance",
        "recall.maxInjectPerTurn": "fMaxInjectPerTurn", "recall.timeoutMs": "fRecallTimeout", "recall.maxInjectChars": "fRecallInjectChars",
        "recall.embedding.baseUrl": "fEmbBase", "recall.embedding.apiKey": "fEmbKey", "recall.embedding.model": "fEmbModel",
        "recall.embedding.dimensions": "fEmbDims", "recall.embedding.timeoutMs": "fEmbTimeout",
        "consolidate.scenesEnabled": "fScenesEnabled", "consolidate.sceneMaxMemories": "fSceneMax",
        "consolidate.personaMaxMemories": "fPersonaMax", "consolidate.sceneBatchSize": "fSceneBatch",
        "evolve.decay.enabled": "fDecay", "evolve.decay.minAgeDays": "fDecayAge", "evolve.decay.threshold": "fDecayThreshold",
        "evolve.decay.retentionDays": "fDecayRetention", "evolve.decay.maxActiveMemories": "fDecayMaxActive",
        "evolve.skillSynthesis.enabled": "fSkill", "evolve.skillSynthesis.minImportance": "fSkillMin",
        "evolve.skillSynthesis.skillsRoot": "fSkillRoot", "evolve.skillSynthesis.prefix": "fSkillPrefix",
        "evolve.skillSynthesis.maxSkills": "fSkillMax",
        "housekeeping.personaVersions": "fHkPersona", "housekeeping.maxScenes": "fHkScenes",
        "housekeeping.sceneActiveRatio": "fHkSceneRatio", "housekeeping.conversationRetentionDays": "fHkConvDays",
        "review.enabled": "fReviewEnabled", "review.time": "fReviewTime",
        "episodeLearning.enabled": "fEpEnabled", "episodeLearning.captureArguments": "fEpCaptureArgs",
        "episodeLearning.resultExcerptChars": "fEpExcerpt", "episodeLearning.retentionDays": "fEpRetention",
        "episodeLearning.reviewEnabled": "fEpReview", "episodeLearning.confidenceFloor": "fEpConf",
        "episodeLearning.expiryDays": "fEpExpiry", "episodeLearning.operationalRecallEnabled": "fEpRecall",
        "episodeLearning.maxRecallResults": "fEpRecallMax", "episodeLearning.maxRecallChars": "fEpRecallChars",
        "episodeLearning.skillMinEpisodes": "fEpSkillMin",
        "episodeLearning.skillDraftsEnabled": "fEpSkillDrafts"
      })[f.key];
      f.type = f.type ?? (
        f.uiClass === "secret" ? "password"
        : f.type !== void 0 ? f.type
        : isPathLikeCheckbox(f.key) ? "checkbox"
        : (f.key === "recall.strategy" || f.key === "extract.provenanceFilter") ? "select"
        : isPathLikeNumber(f.key) ? "number"
        : "text"
      );
      f.secret = f.uiClass === "secret";
      f.initOnly = f.uiClass === "init-only";
    });

    function getPath(obj, path) {
      var cur = obj;
      for (var i = 0; i < path.length; i += 1) {
        if (cur === null || cur === void 0 || typeof cur !== "object") return void 0;
        cur = cur[path[i]];
      }
      return cur;
    }

    /**
     * The entry's settings-form state. THIS is the Phase A seam a future
     * shell refactor replaces: the ConfigForms model stays provider-owned
     * (we only subscribe/unsubscribe), and draft/dirty/baseline revision live
     * here — persisted across navigation (created once in apply()).
     */
    function bindSettingsForm(ctx) {
      var configForms = (function () {
        try { return ctx.get("configForms"); } catch (e) { return void 0; }
      })();
      if (configForms === void 0) return null;
      var form = configForms.get(NAMESPACE);
      var state = {
        snapshot: form.getSnapshot(),
        /** user edits, keyed by dotted field path */
        draft: {},
        /** dotted paths the user touched (order-stable array). */
        dirty: [],
        /** baseline revision captured when the first edit was drafted */
        baselineRevision: undefined,
        /** explicit visible stale-conflict banner state */
        conflict: null,
        listeners: new Set()
      };
      var emit = function () { state.listeners.forEach(function (l) { l(); }); };
      // Provider-owned model: subscribe, never dispose. The unsubscriber is
      // what the consuming effect registers.
      var unsubscribe = form.subscribe(function () {
        var next = form.getSnapshot();
        var revisionChanged = (
          state.snapshot.revision !== void 0 && next.revision !== void 0 &&
          next.revision !== state.snapshot.revision
        );
        state.snapshot = next;
        if (revisionChanged && state.dirty.length > 0 && state.conflict === null) {
          // A remote write moved the document under our dirty baseline: keep
          // the edits and lift the visible conflict banner (no silent accept).
          // `ours` is OUR captured edit-baseline revision, not the new snapshot
          // (this field previously recorded `theirs` twice, hiding the cause).
          state.conflict = { kind: "external", theirs: next.revision, ours: state.baselineRevision };
          emit();
          return;
        }
        emit();
      });
      return {
        /** Shared live state (stable object identity; listeners re-render). */
        state: state,
        /** @returns the current ConfigFormSnapshot (redacted values included). */
        snapshot: function () { return form.getSnapshot(); },
        snapshotState: function () { return state.snapshot; },
        subscribe: function (listener) {
          state.listeners.add(listener);
          return function () { state.listeners.delete(listener); };
        },
        /** Drop provider subscription (the form itself is provider-owned). */
        unsubscribeAll: unsubscribe,
        isDirty: function (key) { return state.dirty.includes(key); },
        dirtyPaths: function () { return state.dirty.map(function (key) { return key.split("."); }); },
        dirtyCount: function () { return state.dirty.length; },
        /** One keystroke: records the edit + pins the baseline revision. */
        setField: function (field, value) {
          if (!state.dirty.includes(field.key)) state.dirty.push(field.key);
          if (state.baselineRevision === void 0) {
            var snap = form.getSnapshot();
            state.baselineRevision = snap.revision;
          }
          state.draft[field.key] = value;
          state.conflict = null;
          emit();
        },
        /** Draft value the view renders for one field (falls back to host). */
        draftValue: function (f) { return state.draft[f.key]; },
        /** @returns true when the host accepted the write. */
        saveDirty: function () {
          var snap = form.getSnapshot();
          var ops = [];
          var invalidList = false;
          state.dirty.forEach(function (key) {
            var f = FIELDS.find(function (c) { return c.key === key; });
            if (!f || f.initOnly) return;
            // Migration-only/retired fields are inventoried but never
            // write-enabled from the ordinary form (no render, no save, no reset).
            if (f.uiClass === "migration-only" || f.uiClass === "retired") return;
            var d = state.draft[key];
            var current = getPath(snap.value, f.path);
            if (f.secret) {
              if (!d) return; // blank keeps the stored key (never echoed)
              if (d === String(current ?? "")) return;
              ops.push({ op: "set", path: f.path, value: d });
              return;
            }
            if (f.type === "checkbox") {
              // Note: disabling must use set false — unset would let the parsed
              // value fall back to the schema default, so the switch never turns off.
              ops.push({ op: "set", path: f.path, value: Boolean(d) });
              return;
            }
            if (f.type === "string-list") {
              var list;
              try { list = JSON.parse(String(d)); } catch (_) { invalidList = true; return; }
              if (!Array.isArray(list) || list.some(function (item) { return typeof item !== "string"; })) { invalidList = true; return; }
              if (JSON.stringify(list) === JSON.stringify(current ?? [])) return;
              ops.push({ op: "set", path: f.path, value: list }); // empty explicitly clears exclusions
              return;
            }
            if (f.type === "select") {
              if (String(d) === String(current ?? "")) return;
              ops.push(String(d) ? { op: "set", path: f.path, value: String(d) } : { op: "unset", path: f.path });
              return;
            }
            if (String(d) === String(current ?? "")) return;
            var isOverridden = getPath(snap.user, f.path) !== void 0;
            if (String(d).trim() === "" && !isOverridden) return;
            ops.push(String(d).trim() === "" ? { op: "unset", path: f.path } : { op: "set", path: f.path, value: f.type === "number" ? Number(d) : d });
          });
          if (invalidList) {
            state.lastError = "Exclusions must be a JSON array of strings; use [] to clear.";
            emit(); return Promise.resolve(false); // retain ALL drafts; no partial remote mutation
          }
          if (ops.length === 0) {
            // Every dirty draft already equals the live host value (restored or
            // no-op): clear the marker instead of leaving a stale "unsaved"
            // badge and enabled Save (mounted probe showed the stale badge).
            state.dirty = [];
            state.baselineRevision = void 0;
            state.conflict = null;
            Object.keys(state.draft).forEach(function (k) { delete state.draft[k]; });
            emit();
            return Promise.resolve(true);
          }
          // The baseline revision is the fence: a stale write is refused by
          // the host (ConfigFormController folds the refusal into a mirror
          // refresh and resolves false) → surfaced as the conflict banner.
          var fence = state.baselineRevision !== void 0 ? state.baselineRevision : snap.revision;
          return form.mutate(ops, fence).then(function (accepted) {
            if (accepted) {
              state.dirty = [];
              state.baselineRevision = void 0;
              state.conflict = null;
              Object.keys(state.draft).forEach(function (k) { delete state.draft[k]; });
              emit();
            } else {
              state.conflict = { kind: "refused", theirs: form.getSnapshot().revision, ours: fence };
              emit();
            }
            return accepted;
          }, function (error) {
            // Transport failures reject (rc.2 contract): surfaced as an error.
            state.conflict = null;
            state.lastError = String(error && error.message || error);
            emit();
            return false;
          });
        },
        /** Confirmed scoped reset ("Restore inherited defaults"). */
        resetScoped: function (group, confirmFn) {
          if (!confirmFn) return Promise.resolve(false);
          // Init-only fields are never part of a live scoped reset (the host
          // rejects nonvolatile paths risk-free anyway — explicit here), and
          // migration-only/retired fields are not write-enabled at all.
          var paths = FIELDS.filter(function (f) {
            return f.group === group && !f.secret && !f.initOnly &&
              f.uiClass !== "migration-only" && f.uiClass !== "retired";
          }).map(function (f) { return f.path; });
          if (paths.length === 0) return Promise.resolve(true);
          var snap = form.getSnapshot();
          var ops = paths.map(function (p) { return { op: "unset", path: p }; });
          return form.mutate(ops, snap.revision).then(function (accepted) {
            if (accepted) {
              paths.forEach(function (p) {
                var key = p.join(".");
                state.dirty = state.dirty.filter(function (k) { return k !== key; });
                delete state.draft[key];
              });
              if (state.dirty.length === 0) state.baselineRevision = void 0;
              state.conflict = null;
              emit();
            } else {
              state.conflict = { kind: "refused", theirs: form.getSnapshot().revision, ours: snap.revision };
              emit();
            }
            return accepted;
          });
        },
        /** Visible conflict/rebase actions. */
        rebaseDirty: function () {
          var snap = form.getSnapshot();
          state.baselineRevision = snap.revision;
          state.conflict = null;
          emit();
        },
        discardDirty: function () {
          state.dirty = [];
          state.baselineRevision = void 0;
          state.conflict = null;
          Object.keys(state.draft).forEach(function (k) { delete state.draft[k]; });
          emit();
        },
        clearError: function () { state.lastError = void 0; emit(); },
        /** Presence-only secret positions for this entry (never values). */
        secretPaths: function () {
          var face = configForms.describe();
          try { face.ensure(); } catch (e) { /* best effort */ }
          var view = face.getSnapshot().view;
          if (!view || !view.namespaces) return [];
          var row = view.namespaces.find(function (n) { return n.ns === NAMESPACE; });
          return row && row.secrets ? row.secrets.map(function (s) { return { path: s.path.slice(), set: s.set === true }; }) : [];
        },
        consentGateRead: function () {
          var snap = form.getSnapshot();
          var v = snap.value;
          return Boolean(v && v.episodeLearning && v.episodeLearning.enabled);
        }
      };
    }

    // ─═ [business-remote] ══════════════════════════════════════════════════
    /**
     * Typed client descriptors for the host business service
     * (src/business.ts MemoryBusinessService, service key
     * selfImprovedMemoryUi). Mirror of the host's @Remote SRC markers;
     * scripts/test-v02-settings.mjs asserts parity with the built source.
     *
     * Codecs are strict JSON validators (TypertSchema.parse + typeSymbol);
     * the trailing `signal` parameter is the Gateway SRC cancellation.
     */
    var STR_CODEC = { mode: "strict", typeSymbol: "dsh-self-improved#string", create: function () { return { parse: function (v) { if (typeof v !== "string") throw new TypeError("expected string"); return v; } }; } };
    var ARGS_CODEC = { mode: "strict", typeSymbol: "dsh-self-improved#browserActionArgs", create: function () {
      return { parse: function (v) {
        if (typeof v !== "object" || v === null || Array.isArray(v)) throw new TypeError("expected object");
        var out = { op: String(v.op) };
        ["id", "content", "name", "newId"].forEach(function (k) { if (typeof v[k] === "string") out[k] = v[k]; });
        if (typeof v.op !== "string" || v.op.length === 0) throw new TypeError("op required");
        return out;
      } };
    } };
    var TOKEN_CODEC = { mode: "strict", typeSymbol: "dsh-self-improved#authorization", create: function () {
      return { parse: function (v) { if (typeof v !== "object" || v === null || typeof v.token !== "string") throw new TypeError("authorization.token required"); return { token: v.token }; } };
    } };
    var PASS_CODEC = { mode: "strict", typeSymbol: "dsh-self-improved#json", create: function () { return { parse: function (v) { return v; } }; } };

    function param(name) { return { name: name, wire: name, source: "json", codec: STR_CODEC }; }
    var BUSINESS_DESCRIPTORS = [
      { id: "dsh-self-improved#selfImproved/snapshot", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "snapshot", invocation: { kind: "direct" }, parameters: [], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/memoryDetail", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "memoryDetail", invocation: { kind: "direct" }, parameters: [param("id")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/episodeDetail", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "episodeDetail", invocation: { kind: "direct" }, parameters: [param("id")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/prepareMutation", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "prepareMutation", invocation: { kind: "direct" }, parameters: [{ name: "args", wire: "args", source: "json", codec: ARGS_CODEC }], result: PASS_CODEC },
      { id: "dsh-self-improved#selfImproved/forget", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "forget", invocation: { kind: "direct" }, parameters: [param("id")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/correct", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "correct", invocation: { kind: "direct" }, parameters: [param("id"), param("content")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/confirmCorrect", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "confirmCorrect", invocation: { kind: "direct" }, parameters: [param("newId")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/deleteSkillRemoval", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "deleteSkillRemoval", invocation: { kind: "direct" }, parameters: [param("name")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/purgeEpisodes", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "purgeEpisodes", invocation: { kind: "direct" }, parameters: [param("scope")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/dryReview", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "dryReview", invocation: { kind: "direct" }, parameters: [], result: PASS_CODEC, cancellation: { parameter: "signal" } },
       { id: "dsh-self-improved#selfImproved/continuityStatus", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "continuityStatus", invocation: { kind: "direct" }, parameters: [param("targetSessionId")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/prepareContinue", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "prepareContinue", invocation: { kind: "direct" }, parameters: [param("targetSessionId"), param("jobId")], result: PASS_CODEC, cancellation: { parameter: "signal" } },
      { id: "dsh-self-improved#selfImproved/continueSession", service: "selfImprovedMemoryUi", namespace: REMOTE_NS, method: "continueSession", invocation: { kind: "direct" }, parameters: [param("targetSessionId"), param("jobId")], result: PASS_CODEC, cancellation: { parameter: "signal" } }
    ];
    /** Thr TokenType table: mutating endpoints list their authorization parameter. */
    var AUTH_PARAM = function (name) { return { name: name, wire: name, source: "json", codec: TOKEN_CODEC }; };
    BUSINESS_DESCRIPTORS.forEach(function (d) {
      if (["forget", "correct", "confirmCorrect", "deleteSkillRemoval", "purgeEpisodes", "dryReview", "continueSession"].includes(d.method)) {
        var hasSignal = d.cancellation !== void 0;
        d.parameters = d.parameters.concat([AUTH_PARAM("authorization")]);
        if (hasSignal) { /* the gateway appends the signal after business args */ }
      }
    });

    /**
     * Mount the plugin's business remote in this fiber (typed contributions).
     * @returns {{ settled: Promise<boolean>, dispose: () => Promise<void> | void }}
     *   `settled` exercises the mount, `dispose` is idempotent teardown.
     */
    function mountBusinessRemote(ctx) {
      var remote = (function () { try { return ctx.get("remote"); } catch (e) { return void 0; } })();
      if (remote === void 0 || typeof remote.$mount !== "function") {
        return { settled: Promise.resolve(false), dispose: function () {} };
      }
      var unmount = null;
      var settled = new Promise(function (resolve) {
        Promise.resolve(remote.$mount({ package: "dsh-self-improved", descriptors: BUSINESS_DESCRIPTORS }))
          .then(function (u) {
            unmount = u;
            resolve(true);
          }, function () { resolve(false); });
      });
      return {
        settled: settled,
        dispose: function () {
          var current = unmount;
          unmount = null;
          if (current) void Promise.resolve(current()).catch(function () { /* idempotent teardown */ });
          return settled;
        }
      };
    }

    /** Read the mounted business namespace.
     *
     * Governance note (measured): a context may only read services declared in
     * ITS inject list. The namespace lives under the service key
     * `remote.selfImproved`, and neither a property read of the `remote`
     * instance nor an undeclared fallback `ctx.get` is allowed — the mounted
     * render proved both throw/gate. Callers must run inside the child context
     * whose inject list grants `remote.` + REMOTE_NS (buildUiContext below).
     */
    function businessApi(ctx) {
      try {
        var ns = ctx.get("remote." + REMOTE_NS);
        if (!ns) return undefined;
        return ns;
      } catch (e) {
        return undefined;
      }
    }

    // ─═ [views] ════════════════════════════════════════════════════════════
    var KIND_LABEL = { fact: "📖 Fact", preference: "📌 Preference", event: "🧭 Event", instruction: "📋 Instruction", persona: "👤 Persona" };

    /** Modal dialog focus lifecycle (a11y gate): focus lands inside an opened
     *  dialog, Tab cycles within the dialog, and closing restores focus to the
     *  control that opened it. Self-contained: bound to the dialog node via a
     *  callback ref, so no mounted DOM is required. */
    var dialogFocus = {
      opener: null,
      open: function () {
        try {
          dialogFocus.opener = (typeof document !== "undefined" && document.activeElement && document.activeElement !== document.body) ? document.activeElement : null;
        } catch (e) { dialogFocus.opener = null; }
      },
      focusNode: function (node) {
        if (!node || typeof node.focus !== "function") return;
        if (node.setAttribute) node.setAttribute("tabindex", "-1");
        try { node.focus(); } catch (e) { /* inert document */ }
      },
      restore: function () {
        var op = dialogFocus.opener;
        dialogFocus.opener = null;
        if (!op || typeof op.focus !== "function") return;
        // Deferred: closing swaps the row (React re-render) and replaces the
        // opener node; a synchronous restore lands on a detached node while a
        // same-frame focus survives (mounted probe: opener focus was lost).
        requestAnimationFrame(function () {
          if (!op.ownerDocument || !op.ownerDocument.contains(op)) return;
          try { op.focus(); } catch (e) { /* detached during the next frame */ }
        });
      },
      trap: function (e) {
        if (e.key !== "Tab") return;
        var dlg = e.currentTarget;
        if (!dlg || typeof dlg.querySelectorAll !== "function") return;
        var tabs = dlg.querySelectorAll('button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])');
        if (!tabs || tabs.length === 0) { e.preventDefault(); return; }
        var first = tabs[0];
        var last = tabs[tabs.length - 1];
        if (e.shiftKey && e.target === first) { e.preventDefault(); last.focus(); return; }
        if (!e.shiftKey && e.target === last) { e.preventDefault(); first.focus(); }
      }
    };

    /** Config form (Config tab). */
    function MemorySection(props) {
      var t = props.t;
      var formBinding = props.formBinding;
      var app = props.app; // { consentConfirm: fn, businessReady ref }
      var [tick, setTick] = react.useState(0);
      react.useEffect(function () {
        if (!formBinding) return function () {};
        // Consumer subscription: unsubscribed on unmount; the shared form
        // model is provider-owned and survives navigation.
        var un = formBinding.subscribe(function () { setTick(function (x) { return x + 1; }); });
        setTick(function (x) { return x + 1; });
        return un;
      }, [formBinding]);
      if (!formBinding) return h("p", { className: "__dsi_unavailable" }, t("unavailable"));
      var state = formBinding.state;
      var snapshot = state.snapshot;
      if (snapshot.status === "unavailable") {
        return h("p", { className: "__dsi_unavailable" }, t("unavailable"));
      }
      if (snapshot.status !== "ready" || snapshot.value === void 0) {
        return h("p", { className: "__dsi_status" }, t("loading"));
      }
      var value = snapshot.value;
      var user = snapshot.user || {};
      var secretPaths = formBinding.secretPaths();
      var secretsByPath = {};
      secretPaths.forEach(function (s) { secretsByPath[s.path.join(".")] = s.set; });
      // rc.2 snapshots carried mode:"host"; 0.2.1 dropped the field and every
      // form is Host-backed, so only an explicit non-host mode is read-only.
      var writable = snapshot.writable !== false && (snapshot.mode === void 0 || snapshot.mode === "host");
      var busy = Boolean(state.busy);

      function draftOf(f) {
        var d = state.draft[f.key];
        if (d !== void 0) return d;
        var cur = getPath(value, f.path);
        if (f.secret) return "";
        if (f.type === "checkbox") return Boolean(cur);
        if (f.type === "string-list") return JSON.stringify(Array.isArray(cur) ? cur : []);
        if (f.type === "select") {
          if (cur === void 0 || cur === null || cur === "") {
            return f.fallback !== void 0 ? String(f.fallback) : "";
          }
          return String(cur);
        }
        return cur === void 0 || cur === null ? "" : String(cur);
      }
      function setField(f, v) {
        formBinding.setField(f, v);
        setTick(function (x) { return x + 1; });
      }

      function onSave() {
        // Consent stays a save-boundary check (a stale checkbox cannot arm
        // capture silently: flipping episodeLearning.enabled OFF→ON asks).
        var epKey = "episodeLearning.enabled";
        if (state.draft[epKey] === true) {
          var current = Boolean(getPath(value, ["episodeLearning", "enabled"]));
          if (!current && app && app.confirmConsent && !app.confirmConsent()) {
            setField(FIELDS.find(function (f) { return f.key === epKey; }), false);
            return;
          }
        }
        state.busy = true;
        setTick(function (x) { return x + 1; });
        formBinding.saveDirty().then(function (accepted) {
          state.busy = false;
          if (accepted) state.lastNotice = t("saved");
          setTick(function (x) { return x + 1; });
        }).catch(function () { state.busy = false; setTick(function (x) { return x + 1; }); });
      }

      function onResetGroup(group) {
        var ok = window.confirm(t("resetConfirm"));
        if (!ok) return;
        state.busy = true;
        setTick(function (x) { return x + 1; });
        formBinding.resetScoped(group).then(function () {
          state.busy = false;
          setTick(function (x) { return x + 1; });
        }).catch(function () { state.busy = false; setTick(function (x) { return x + 1; }); });
      }

      // Collapse groups in sync with module switches (unchanged UX).
      var GROUP_SWITCH = {
        groupExtract: "modules.extract",
        groupRecall: "modules.recall",
        groupConsolidate: "modules.consolidate",
        groupEvolve: "modules.evolve",
        // groupEpisodes stays VISIBLE while disabled (otherwise its enable
        // switch could never be reached); it only collapses with the master.
        groupEpisodes: "enabled",
        groupStorage: "enabled"
      };
      var draftKey = function (key) {
        var f = FIELDS.find(function (c) { return c.key === key; });
        return f ? draftOf(f) : false;
      };
      var masterOn = Boolean(draftKey("enabled"));
      function groupVisible(g) {
        if (g === "groupMaster" || g === "groupModules") return true;
        var sw = GROUP_SWITCH[g];
        if (!sw) return true;
        if (sw === "enabled") return masterOn;
        return masterOn && Boolean(draftKey(sw));
      }

      function badgesOf(f) {
        var overridden = getPath(user, f.path) !== void 0;
        var dirty = formBinding.isDirty(f.key);
        return [
          dirty ? h("span", { key: "d", className: "__dsi_dirty" }, t("dirtyBadge")) : null,
          overridden && !dirty ? h("span", { key: "o", className: "__dsi_override", title: t("overriddenHint") }, t("overridden")) : null,
          f.initOnly ? h("span", { key: "r", className: "__dsi_restart" }, t("restartNote")) : null
        ];
      }
      function renderField(f) {
        if (f.uiClass === "migration-only" || f.uiClass === "retired") return null;
        var badges = badgesOf(f);
        if (f.type === "checkbox") {
          return h("div", { key: f.key, className: "__dsi_switchRow" },
            h("div", { className: "__dsi_switchText" },
              h("label", { className: "__dsi_label", htmlFor: "dsi-" + f.key }, t(f.label), badges),
              f.hint ? h("span", { className: "__dsi_hint" }, t(f.hint)) : null),
            h("label", { className: "__dsi_switch" },
              h("input", { type: "checkbox", role: "switch", id: "dsi-" + f.key, "aria-label": t(f.label), checked: Boolean(draftOf(f)), disabled: busy || !writable,
                onChange: function (e) { setField(f, e.target.checked); } }),
              h("span", { className: "__dsi_switchTrack", "aria-hidden": "true" }),
              h("span", { className: "__dsi_switchThumb", "aria-hidden": "true" })));
        }
        var input;
        if (f.type === "string-list") {
          input = h(StringListInput, { key: "in", id: "dsi-" + f.key, json: draftOf(f), disabled: busy || !writable, onChange: function (json) { setField(f, json); } });
        } else if (f.type === "select") {
          input = h("select", {
            className: "__dsi_input", id: "dsi-" + f.key, value: draftOf(f), disabled: busy || !writable,
            onChange: function (e) { setField(f, e.target.value); }
          }, f.options.map(function (opt) { return h("option", { key: opt, value: opt }, opt); }));
        } else {
          var isSecret = f.secret;
          var secretSet = secretsByPath[f.key];
          input = h("input", {
            className: "__dsi_input",
            type: isSecret ? "password" : f.type === "number" ? "number" : "text",
            value: draftOf(f),
            disabled: busy || !writable || f.initOnly,
            id: "dsi-" + f.key,
            placeholder: isSecret ? (secretSet ? "••••••••" : t("secretHint")) : "",
            onChange: function (e) { setField(f, e.target.value); }
          });
        }
        return h("div", { key: f.key, className: "__dsi_field" },
          h("label", { className: "__dsi_label", htmlFor: "dsi-" + f.key }, t(f.label), badges),
          input,
          f.secret ? h("span", { className: "__dsi_hint" }, secretsByPath[f.key] ? t("secretSet") : t("secretUnset")) : null,
          f.hint ? h("span", { className: "__dsi_hint" }, t(f.hint)) : null);
      }
      function fieldsWhere(pred) { return FIELDS.filter(pred).map(renderField).filter(Boolean); }
      var byKey = function (key) { return FIELDS.find(function (f) { return f.key === key; }); };
      var essentials = [
        { id: "general", title: t("sectionGeneral"), keys: ["enabled", "modules.capture", "modules.extract", "modules.recall", "modules.tools"] },
        { id: "continuity", title: t("sectionContinuity"), sub: t("sectionContinuitySub"), keys: ["continuity.enabled", "continuity.summaryEnabled", "continuity.excludedSessionIds", "continuity.excludedProjectIds"] },
        { id: "episodes", title: t("sectionEpisodes"), keys: ["episodeLearning.enabled"] }
      ];
      var essentialKeys = [];
      essentials.forEach(function (sec) { essentialKeys = essentialKeys.concat(sec.keys); });
      var nodes = essentials.map(function (sec) {
        var fields = sec.keys.map(byKey).filter(Boolean).filter(function (f) { return sec.id === "general" || masterOn || f.key === "enabled"; }).map(renderField).filter(Boolean);
        if (!fields.length) return null;
        return h("section", { key: sec.id, className: "__dsi_card", "aria-labelledby": "dsi-sec-" + sec.id },
          h("h3", { className: "__dsi_cardTitle", id: "dsi-sec-" + sec.id }, sec.title),
          sec.sub ? h("p", { className: "__dsi_cardSub" }, sec.sub) : null,
          fields);
      });
      var GROUP_ORDER = ["groupMaster", "groupModules", "groupStorage", "groupExtract", "groupRecall", "groupConsolidate", "groupEvolve", "groupHousekeeping", "groupReview", "groupEpisodes"];
      var advanced = GROUP_ORDER.map(function (group) {
        if (!groupVisible(group)) return null;
        var fields = fieldsWhere(function (f) { return f.group === group && essentialKeys.indexOf(f.key) < 0; });
        if (!fields.length) return null;
        var dirtyHere = FIELDS.some(function (f) { return f.group === group && formBinding.isDirty(f.key); });
        return h("details", { key: group, className: "__dsi_details", open: dirtyHere || undefined },
          h("summary", null, t(group), dirtyHere ? h("span", { className: "__dsi_dirty" }, t("dirtyBadge")) : null),
          h("div", { className: "__dsi_detailsBody" },
            fields,
            group !== "groupMaster" && group !== "groupModules"
              ? h("div", null, h("button", { type: "button", className: "__dsi_btn __dsi_btnSm __dsi_btnGhost", onClick: function () { onResetGroup(group); }, disabled: busy || !writable }, t("resetScoped")))
              : null));
      }).filter(Boolean);

      var dirtyCount = formBinding.dirtyCount();
      var conflict = state.conflict;
      return h("div", { className: "__dsi_root" },
        h("div", { className: "__dsi_header" },
          h("p", { className: "__dsi_intro" }, t("intro")),
          h("button", {
            type: "button", className: "__dsi_helpBtn", title: t("helpTitle"), "aria-label": t("helpTitle"), "aria-expanded": Boolean(state.helpOpen),
            onClick: function () { state.helpOpen = !state.helpOpen; setTick(function (x) { return x + 1; }); }
          }, "?")
        ),
        state.helpOpen ? h("div", { className: "__dsi_help" },
          h("h4", null, t("helpTitle")),
          h("p", null, t("help"))
        ) : null,
        conflict !== null ? h("div", { className: "__dsi_conflict", role: "alert", "aria-live": "assertive" },
          h("span", { className: "__dsi_error" }, t("conflict")),
          h("div", { className: "__dsi_row" },
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { formBinding.rebaseDirty(); setTick(function (x) { return x + 1; }); } }, t("conflictKeep")),
            h("button", {
              type: "button", className: "__dsi_btn __dsi_btnDanger",
              onClick: function () {
                if (!window.confirm(t("conflictDiscardConfirm"))) return;
                formBinding.discardDirty();
                setTick(function (x) { return x + 1; });
              }
            }, t("conflictDiscard"))
          )
        ) : null,
        nodes,
        masterOn && advanced.length ? h("section", { className: "__dsi_section", "aria-labelledby": "dsi-sec-advanced" },
          h("h3", { className: "__dsi_sectionTitle", id: "dsi-sec-advanced" }, t("sectionAdvanced")),
          h("p", { className: "__dsi_muted" }, t("sectionAdvancedSub")),
          advanced) : null,
        h("div", { className: "__dsi_saveBar" },
          h("span", { className: dirtyCount > 0 ? "__dsi_status" : "__dsi_muted", role: "status", "aria-live": "polite" },
            busy ? t("saving")
              : state.lastError ? h("span", { className: "__dsi_error" }, t("error") + ": " + state.lastError)
              : dirtyCount > 0 ? t("dirtySummary").replace("{n}", String(dirtyCount))
              : state.lastNotice ? h("span", { className: "__dsi_ok" }, state.lastNotice) : t("allSaved")),
          h("div", { className: "__dsi_row" },
            dirtyCount > 0 ? h("button", { type: "button", className: "__dsi_btn __dsi_btnSm __dsi_btnGhost", disabled: busy,
              onClick: function () { formBinding.discardDirty(); setTick(function (x) { return x + 1; }); } }, t("discard")) : null,
            h("button", { type: "button", className: "__dsi_btn __dsi_btnSm __dsi_btnPrimary", onClick: onSave, disabled: busy || !writable || dirtyCount === 0 }, t("save"))))
      );
    }

    /** One-entry-per-line editor for a JSON string-array field. Keeps its own
     *  text so blank lines survive typing; the form receives the JSON array. */
    function StringListInput(props) {
      var toText = function (json) { try { var v = JSON.parse(json); return Array.isArray(v) ? v.join("\n") : ""; } catch (e) { return ""; } };
      var pair = react.useState(function () { return toText(props.json); }), text = pair[0], setText = pair[1];
      var last = react.useRef(props.json);
      react.useEffect(function () {
        if (props.json === last.current) return;
        last.current = props.json;
        var fromForm = toText(props.json), mine = JSON.stringify(text.split("\n").map(function (x) { return x.trim(); }).filter(Boolean));
        if (props.json !== mine) setText(fromForm);
      }, [props.json]);
      return h("textarea", { id: props.id, className: "__dsi_input __dsi_textarea", rows: 3, value: text, disabled: props.disabled, spellCheck: false,
        placeholder: "One ID per line",
        onChange: function (e) {
          var next = e.target.value; setText(next);
          var json = JSON.stringify(next.split("\n").map(function (x) { return x.trim(); }).filter(Boolean));
          last.current = json; props.onChange(json);
        } });
    }

    /** Memory browser (Memory tab) — typed business-remote consumer. */
    function BrowserSection(props) {
      var t = props.t;
      var ctx = props.ctx;
      var api = props.api;
      var [state, setState] = react.useState({ data: null, busy: false, error: null, notice: null, query: "", pending: null, pendingKind: null, episodeStatus: null });
      var [open, setOpen] = react.useState({ persona: false, memories: true, scenes: false, skills: false, episodes: false });
      var [closedDetailId, setClosedDetailId] = react.useState(null);
      var closedEpisodeDetailRef = react.useRef(null);
      var [episodeDetail, setEpisodeDetail] = react.useState(null);
      var [editingId, setEditingId] = react.useState(null);
      var [editDraft, setEditDraft] = react.useState("");
      var busy = state.busy;

      var refresh = react.useCallback(function () {
        if (!api) {
          setState(function (s) { return { ...s, error: t("browserRemoteUnavailable"), data: null }; });
          return;
        }
        setState(function (s) { return { ...s, busy: true, error: null }; });
        Promise.resolve(api.snapshot())
          .then(function (r) {
            if (!r.ok) { setState(function (s) { return { ...s, busy: false, error: remoteMessage(r) }; }); return; }
            setState(function (s) {
              var data = r.value;
              return { ...s, busy: false, data: data, episodeStatus: s.episodeStatus };
            });
          })
          .catch(function (e) { setState(function (s) { return { ...s, busy: false, error: String(e && e.message || e) }; }); });
      }, [api]);
      react.useEffect(function () { refresh(); }, [refresh]);

      /** Authorized two-step mutation: stage then echo the one-shot token. */
      function mutate(args, after) {
        if (!api) { setState(function (s) { return { ...s, error: t("browserRemoteUnavailable") }; }); return; }
        if (state.pending) return; // one pending handshake at a time
        setState(function (s) { return { ...s, busy: true, error: null, notice: null, pending: args, pendingKind: args.op }; });
        Promise.resolve(api.prepareMutation(args))
          .then(function (r) {
            if (!r.ok) { setState(function (s) { return { ...s, busy: false, pending: null, pendingKind: null, error: remoteMessage(r) }; }); return; }
            var executor = EXECUTORS[args.op];
            if (!executor) { setState(function (s) { return { ...s, busy: false, pending: null, pendingKind: null, error: "unsupported op" }; }); return; }
            return Promise.resolve(executor(api, args, r.value.token))
              .then(function (res) {
                setState(function (s) { return { ...s, busy: false, pending: null, pendingKind: null }; });
                if (res && !res.ok) { setState(function (s) { return { ...s, error: remoteMessage(res) }; }); return; }
                if (after) after(res && res.ok ? res.value : undefined);
                refresh();
              });
          })
          .catch(function (e) {
            setState(function (s) { return { ...s, busy: false, pending: null, pendingKind: null, error: String(e && e.message || e) }; });
          });
      }
      var EXECUTORS = {
        forget: function (api, args, token) { return api.forget(args.id, { token }); },
        correct: function (api, args, token) { return api.correct(args.id, args.content, { token }); },
        "confirm-correct": function (api, args, token) { return api.confirmCorrect(args.newId, { token }); },
        deleteSkill: function (api, args, token) { return api.deleteSkillRemoval(args.name, { token }); },
        purgeEpisodes: function (api, args, token) { return api.purgeEpisodes(args.id, { token }); },
        dryReview: function (api, args, token) {
          setState(function (s) { return { ...s, notice: t("browserEpisodeDryReviewRun") }; });
          return api.dryReview({ token });
        }
      };

      var data = state.data;
      if (data === null) {
        return h("div", { className: "__dsi_root" },
          h("p", { className: "__dsi_status" }, busy ? t("loading") : (state.error || t("browserRemoteUnavailable"))),
          api ? h("button", { type: "button", className: "__dsi_btn", onClick: refresh, disabled: busy }, t("browserRefresh")) : null,
          state.error ? h("p", { className: "__dsi_error", role: "alert" }, state.error) : null
        );
      }

      var memories = (data.memories || []).filter(function (m) { return m.status === "active"; });
      var q = state.query.trim().toLowerCase();
      var filtered = q ? memories.filter(function (m) { return m.content.toLowerCase().indexOf(q) >= 0 || m.kind.indexOf(q) >= 0; }) : memories;

      function viewDetail(m) {
        dialogFocus.open();
        setState(function (s) { return { ...s, busy: true }; });
        setClosedDetailId(null);
        Promise.resolve(api.memoryDetail(m.id)).then(function (r) {
          setState(function (s) { return { ...s, busy: false }; });
          if (!r.ok) { setState(function (s) { return { ...s, error: remoteMessage(r) }; }); return; }
          setState(function (s) {
            return { ...s, data: { ...s.data, __detail: r.value }, busy: false };
          });
        }).catch(function () { setState(function (s) { return { ...s, busy: false, error: "detail failed" }; }); });
      }
      var detailObj = data.__detail;
      var showDetail = detailObj && detailObj.id !== closedDetailId;
      function closeMemoryDetail() {
        setClosedDetailId(detailObj ? detailObj.id : null);
        dialogFocus.restore();
      }

      function forget(memory) {
        if (!window.confirm(t("browserForgetConfirm") + "\n" + memory.content.slice(0, 60))) return;
        mutate({ op: "forget", id: memory.id }, function () { setState(function (s) { return { ...s, notice: t("browserForgotten") }; }); });
      }
      function correct(memory) {
        setEditingId(memory.id);
        setEditDraft(memory.content);
      }
      function saveCorrect(memory) {
        var next = editDraft.trim();
        if (!next || next === memory.content) { cancelCorrect(); return; }
        mutate({ op: "correct", id: memory.id, content: next }, function () { setState(function (s) { return { ...s, notice: t("browserCorrected") }; }); cancelCorrect(); });
      }
      function cancelCorrect() { setEditingId(null); setEditDraft(""); }

      var listNodes = filtered.slice(0, 200).map(function (m) {
        if (editingId === m.id) {
          return h("div", { key: m.id, className: "__dsi_browserRow" },
            h("div", { className: "__dsi_browserMain" },
              h("span", { className: "__dsi_browserKind" }, (KIND_LABEL[m.kind] || m.kind) + " · " + t("browserCorrectPrompt")),
              h("textarea", {
                className: "__dsi_input", style: { height: "auto", minHeight: 60, resize: "vertical" },
                autoFocus: true, value: editDraft, disabled: busy,
                onChange: function (e) { setEditDraft(e.target.value); },
                onKeyDown: function (e) {
                  if (e.key === "Escape") { e.preventDefault(); cancelCorrect(); }
                  else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveCorrect(m); }
                }
              })
            ),
            h("span", { className: "__dsi_browserOps" },
              h("button", { type: "button", className: "__dsi_btn", onClick: function () { saveCorrect(m); }, disabled: busy || !editDraft.trim() }, t("save")),
              h("button", { type: "button", className: "__dsi_btn", onClick: cancelCorrect, disabled: busy }, t("browserCancel"))
            )
          );
        }
        return h("div", { key: m.id, className: "__dsi_browserRow" },
          h("div", { className: "__dsi_browserMain" },
            h("span", { className: "__dsi_browserKind" }, KIND_LABEL[m.kind] || m.kind),
            h("span", { className: "__dsi_browserContent" }, m.content),
            h("span", { className: "__dsi_browserMeta", title: "Memory " + m.id }, "Importance " + m.importance + " · recalled " + m.accessCount + (m.accessCount === 1 ? " time" : " times"))
          ),
          h("span", { className: "__dsi_browserOps" },
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { viewDetail(m); }, disabled: busy }, t("browserDetail")),
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { correct(m); }, disabled: busy }, t("browserCorrect")),
            h("button", { type: "button", className: "__dsi_btn __dsi_btnDanger", onClick: function () { forget(m); }, disabled: busy }, t("browserForget"))
          )
        );
      });

      var scenesArr = data.scenes || [];
      var scenesNodes = scenesArr.slice(0, 20).map(function (s) {
        return h("div", { key: s.id, className: "__dsi_browserRow" },
          h("div", { className: "__dsi_browserMain" },
            h("span", { className: "__dsi_browserKind" }, "🗂️" + s.title)));
      });
      var skills = data.skills || [];
      function deleteSkill(sk) {
        if (!window.confirm(t("browserSkillDeleteConfirm") + "\n" + sk.name)) return;
        mutate({ op: "deleteSkill", name: sk.name }, function () { setState(function (s) { return { ...s, notice: t("browserSkillDeleted") }; }); });
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
            h("button", { type: "button", className: "__dsi_btn __dsi_btnDanger", onClick: function () { deleteSkill(sk); }, disabled: busy }, t("browserSkillDelete"))
          ) : null);
      });

      function toggle(k) {
        setOpen(function (p) { var n = { ...p }; n[k] = !n[k]; return n; });
      }
      function collapse(key, title, count, body) {
        var isOpen = open[key];
        return h("div", { className: "__dsi_collapse" + (isOpen ? " __dsi_collapseOpen" : "") },
          h("button", {
            type: "button", className: "__dsi_collapseHeader", "aria-expanded": isOpen,
            onClick: function () { toggle(key); }
          },
            h("span", { className: "__dsi_collapseChevron" }, "▶"),
            h("span", { className: "__dsi_collapseTitle" }, title),
            h("span", { className: "__dsi_collapseCount" }, count)
          ),
          isOpen ? h("div", { className: "__dsi_collapseBody" }, body) : null
        );
      }
      var persona = data.persona;
      var personaBody = persona
        ? h("div", { className: "__dsi_persona" }, persona.content)
        : h("p", { className: "__dsi_status" }, t("browserPersonaEmpty"));
      var memoryBody = h("div", { className: "__dsi_collapse" },
        h("div", { className: "__dsi_row" },
          h("input", { className: "__dsi_input", style: { maxWidth: 260 }, placeholder: t("browserSearch"), value: state.query, onChange: function (e) { setState(function (s) { return { ...s, query: e.target.value }; }); } }),
          h("button", { type: "button", className: "__dsi_btn", onClick: refresh, disabled: busy }, t("browserRefresh"))
        ),
        listNodes.length ? listNodes : h("p", { className: "__dsi_status" }, t("browserEmpty"))
      );
      var scenesBody = scenesArr.length
        ? h("div", { className: "__dsi_collapse" }, scenesNodes)
        : h("p", { className: "__dsi_status" }, t("browserScenesEmpty"));
      var skillsBody = skills.length
        ? h("div", { className: "__dsi_collapse" }, skillsNodes)
        : h("p", { className: "__dsi_status" }, t("browserSkillsEmpty"));

      var epData = data.episodes || { counts: null, recent: null };
      var epCounts = epData.counts || {};
      var epTotal = ["pending", "succeeded", "failed", "ambiguous", "reviewed", "rejected"].reduce(function (acc, k) { return acc + (Number(epCounts[k]) || 0); }, 0);
      var epEnabled = Array.isArray(epData.recent);
      function viewEpisodeDetail(e) {
        dialogFocus.open();
        setEpisodeDetail(null);
        setState(function (s) { return { ...s, busy: true }; });
        Promise.resolve(api.episodeDetail(e.id)).then(function (r) {
          setState(function (s) { return { ...s, busy: false }; });
          if (!r.ok) { setState(function (s) { return { ...s, error: remoteMessage(r) }; }); return; }
          setEpisodeDetail(r.value);
        }).catch(function () { setState(function (s) { return { ...s, busy: false, error: "episode detail failed" }; }); });
      }
      function purgeEpisodes(scope) {
        if (!window.confirm(t("browserEpisodePurgeConfirm"))) return;
        mutate({ op: "purgeEpisodes", id: scope }, function () {
          setState(function (s) { return { ...s, notice: t("browserEpisodePurge") + (scope === "all" ? " (all)" : " (>30d)") }; });
        });
      }
      var EP_STATUS_LABEL = { pending: "pending", succeeded: "succeeded", failed: "failed", ambiguous: "ambiguous", reviewed: "reviewed", rejected: "rejected" };
      var episodeRows = (epData.recent || []).map(function (e) {
        return h("div", { key: e.id, className: "__dsi_browserRow" },
          h("div", { className: "__dsi_browserMain" },
            h("span", { className: "__dsi_browserKind" }, "⚗️ " + (EP_STATUS_LABEL[e.status] || e.status)),
            e.summary ? h("span", { className: "__dsi_browserContent" }, e.summary) : null,
            h("span", { className: "__dsi_browserMeta" }, "turn " + e.turn + " · " + String(e.projectId || "-").slice(0, 24) + " · " + fmtTime(e.updatedAt))
          ),
          h("span", { className: "__dsi_browserOps" },
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { viewEpisodeDetail(e); }, disabled: busy }, t("browserDetail"))
          )
        );
      });
      var episodesBody = h("div", { className: "__dsi_collapse" },
        h("div", { className: "__dsi_row" },
          h("span", { className: "__dsi_browserMeta" },
            (epCounts.reviewed || 0) + " reviewed · " + (epCounts.succeeded || 0) + " succeeded · " + (epCounts.failed || 0) + " failed · " + (epCounts.pending || 0) + " pending · " + (epCounts.ambiguous || 0) + " ambiguous · " + (epCounts.rejected || 0) + " rejected"),
          h("button", { type: "button", className: "__dsi_btn", onClick: function () { mutate({ op: "dryReview" }, function (summary) {
            setState(function (s) { return { ...s, episodeStatus: summary || {} }; });
          }); }, disabled: busy || state.pendingKind === "dryReview" }, state.pendingKind === "dryReview" ? t("browserEpisodeDryReviewRun") : t("browserEpisodeDryReview")),
          h("button", { type: "button", className: "__dsi_btn __dsi_btnDanger", onClick: function () { purgeEpisodes("30"); }, disabled: busy }, t("browserEpisodePurge")),
          h("button", { type: "button", className: "__dsi_btn __dsi_btnDanger", onClick: function () { purgeEpisodes("all"); }, disabled: busy }, t("browserEpisodePurgeAll"))
        ),
        state.episodeStatus ? h("p", { className: "__dsi_status" },
          t("browserEpisodeLastReview") + " " + JSON.stringify({
            dryRun: state.episodeStatus.dryRun === true,
            considered: state.episodeStatus.considered,
            reviewed: state.episodeStatus.reviewed,
            rejected: state.episodeStatus.rejected,
            memories: state.episodeStatus.memories,
            dropped: state.episodeStatus.dropped,
            errors: state.episodeStatus.errors
          })) : null,
        !epEnabled ? h("p", { className: "__dsi_status" }, t("browserEpisodesDisabled")) : null,
        epEnabled && episodeRows.length ? episodeRows : (epEnabled ? h("p", { className: "__dsi_status" }, t("browserEpisodesEmpty")) : null)
      );

      var STATUS_LABEL = { active: "Active", decayed: "Decayed", forgotten: "Forgotten", corrected: "Corrected" };
      function closeEpisodeDetail() {
        closedEpisodeDetailRef.current = episodeDetail ? episodeDetail.id : null;
        setEpisodeDetail(null);
        dialogFocus.restore();
      }
      function fmtTime(ts) {
        try { return new Date(ts).toLocaleString(); } catch (e) { return String(ts); }
      }
      var modal = showDetail && detailObj ? h("div", {
        className: "__dsi_modalBackdrop", onClick: function () { closeMemoryDetail(); }
      },
        h("div", {
          className: "__dsi_modal", role: "dialog", "aria-modal": true, "aria-label": t("browserDetail"),
          ref: dialogFocus.focusNode,
          onClick: function (e) { e.stopPropagation(); },
          onKeyDown: function (e) { dialogFocus.trap(e); if (e.key === "Escape") { e.stopPropagation(); closeMemoryDetail(); } }
        },
          h("div", { className: "__dsi_modalHeader" },
            h("span", { className: "__dsi_modalTitle" }, (KIND_LABEL[detailObj.kind] || detailObj.kind) + " · " + t("browserDetail")),
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { closeMemoryDetail(); } }, t("browserDetailClose"))
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

      var episodeModal = episodeDetail && episodeDetail.id !== closedEpisodeDetailRef.current ? h("div", {
        className: "__dsi_modalBackdrop", onClick: function () { closeEpisodeDetail(); }
      },
        h("div", {
          className: "__dsi_modal", role: "dialog", "aria-modal": true, "aria-label": t("browserEpisodeDetailTitle"),
          ref: dialogFocus.focusNode,
          onClick: function (e) { e.stopPropagation(); },
          onKeyDown: function (e) { dialogFocus.trap(e); if (e.key === "Escape") { e.stopPropagation(); closeEpisodeDetail(); } }
        },
          h("div", { className: "__dsi_modalHeader" },
            h("span", { className: "__dsi_modalTitle" }, "⚗️ " + t("browserEpisodeDetailTitle") + " · " + (EP_STATUS_LABEL[episodeDetail.status] || episodeDetail.status)),
            h("button", { type: "button", className: "__dsi_btn", onClick: function () { closeEpisodeDetail(); } }, t("browserDetailClose"))
          ),
          h("div", { className: "__dsi_modalBody" },
            h("div", { className: "__dsi_modalMeta" },
              h("b", null, t("browserMetaSession")), h("span", null, String(episodeDetail.sessionId || "-").slice(0, 20)),
              h("b", null, t("browserMetaTurn")), h("span", null, String(episodeDetail.turn)),
              h("b", null, t("browserMetaProject")), h("span", null, String(episodeDetail.projectId || "-").slice(0, 40)),
              h("b", null, t("browserMetaStarted")), h("span", null, fmtTime(episodeDetail.startedAt)),
              h("b", null, t("browserMetaEnded")), h("span", null, episodeDetail.endedAt ? fmtTime(episodeDetail.endedAt) : "-"),
              episodeDetail.summary ? h("b", null, t("browserMetaSummary")) : null,
              episodeDetail.summary ? h("span", null, episodeDetail.summary) : null,
              episodeDetail.confidence != null ? h("b", null, t("browserMetaConfidence")) : null,
              episodeDetail.confidence != null ? h("span", null, String(episodeDetail.confidence)) : null,
              episodeDetail.fingerprint ? h("b", null, t("browserMetaFingerprint")) : null,
              episodeDetail.fingerprint ? h("span", null, String(episodeDetail.fingerprint).slice(0, 16)) : null,
              episodeDetail.rejectReason ? h("b", null, t("browserMetaRejectReason")) : null,
              episodeDetail.rejectReason ? h("span", null, episodeDetail.rejectReason) : null
            ),
            (episodeDetail.steps || []).length === 0 ? h("p", { className: "__dsi_status" }, t("browserEpisodeNoSteps")) : null,
            (episodeDetail.steps || []).map(function (s) {
              return h("div", { key: s.ordinal, className: "__dsi_browserRow" },
                h("div", { className: "__dsi_browserMain" },
                  h("span", { className: "__dsi_browserKind" }, (s.isError ? "✗ " : "✓ ") + s.ordinal + ". " + s.toolName + (s.errorName ? " (" + s.errorName + ")" : "")),
                  h("span", { className: "__dsi_browserContent" }, String(s.argumentsRedacted || "").slice(0, 300)),
                  h("span", { className: "__dsi_browserMeta" }, String(s.resultExcerpt || "").slice(0, 300) + (s.resultTruncated ? " …[truncated]" : ""))
                )
              );
            })
          )
        )
      ) : null;

      return h("div", { className: "__dsi_root" },
        h("p", { className: "__dsi_status" },
          t("browserSummary").replace("{n}", String(memories.length)).replace("{p}", String(data.pending || 0)).replace("{s}", String(scenesArr.length)).replace("{v}", String(persona ? persona.ver : "-")).replace("{k}", String(skills.length)).replace("{e}", String(epTotal))
        ),
        state.notice ? h("p", { className: "__dsi_ok", role: "status" }, state.notice) : null,
        state.pendingKind && state.pending !== null ? h("p", { className: "__dsi_status", role: "status" }, t("browserStaged") + " — " + state.pendingKind) : null,
        state.error ? h("p", { className: "__dsi_error", role: "alert" }, state.error) : null,
        collapse("persona", t("browserPersona") + (persona ? " v" + persona.ver : ""), "", personaBody),
        collapse("memories", t("browserMemories"), String(memories.length), memoryBody),
        collapse("scenes", t("browserScenes"), String(scenesArr.length), scenesBody),
        collapse("skills", t("browserSkills"), String(skills.length), skillsBody),
        collapse("episodes", t("groupEpisodesBrowser"), String(epTotal), episodesBody),
        modal,
        episodeModal
      );
    }

    /** Map one RemoteResult failure onto a human message. */
    function remoteMessage(r) {
      if (r && !r.ok && r.error) return String(r.error.message || r.error.code || "remote failure");
      return "remote failure";
    }

    /** Main settings section: Config / Memory tabs (draft survives navigation,
     *  because the settings-form binding lives in apply()'s closure). */
    /** Real cancellable read ownership, shared by the new data views. */
    function useOwnedRead(api, kind) {
      var owner = react.useRef({ serial: 0, controller: null, alive: true });
      var pair = react.useState({ data: null, busy: false, error: null });
      var state = pair[0], setState = pair[1];
      react.useEffect(function () {
        owner.current.alive = true;
        return function () { owner.current.alive = false; owner.current.serial++; if (owner.current.controller) owner.current.controller.abort(); };
      }, []);
      var cancel = react.useCallback(function () {
        owner.current.serial++;
        if (owner.current.controller) owner.current.controller.abort();
        if (owner.current.alive) setState({ data: null, busy: false, error: null });
      }, []);
      var refresh = react.useCallback(function (target) {
        var current = owner.current;
        if (!current.alive) return;
        if (current.controller) current.controller.abort();
        var serial = ++current.serial, controller = new AbortController(); current.controller = controller;
        setState({ data: null, busy: true, error: null });
        function active() { return current.alive && current.serial === serial && !controller.signal.aborted; }
        return Promise.resolve().then(function () {
          if (!active()) return null;
          if (!api || typeof api[kind] !== "function") throw new Error("The native business remote is unavailable.");
          return kind === "snapshot" ? api.snapshot(controller.signal) : api.continuityStatus(target, controller.signal);
        }).then(function (result) {
          if (!active()) return;
          if (!result || !result.ok) throw new Error(remoteMessage(result));
          setState({ data: result.value, busy: false, error: null });
        }).catch(function (error) {
          if (active()) setState({ data: null, busy: false, error: String(error && error.message || error) });
        });
      }, [api, kind]);
      return { state: state, refresh: refresh, cancel: cancel };
    }
    function OverviewSection(props) {
      var read = useOwnedRead(props.api, "snapshot"), state = read.state;
      react.useEffect(function () { read.refresh(); }, [read.refresh]);
      var data = state.data, counts = data && data.episodes && data.episodes.counts;
      var lane = data && data.continuity ? data.continuity : null;
      function stat(label, value, hint) {
        return h("div", { key: label, className: "__dsi_stat", title: hint || undefined },
          h("span", { className: "__dsi_statValue" }, String(value)),
          h("span", { className: "__dsi_statLabel" }, label));
      }
      function kv(label, value) { return h("div", { key: label }, h("dt", null, label), h("dd", null, String(value))); }
      var laneStatus = !lane ? null : lane.structural === "on" ? (lane.failed ? ["Needs attention", "__dsi_pillWarn"] : ["On", "__dsi_pillOn"])
        : lane.structural === "off" ? ["Off", ""] : ["Unavailable", "__dsi_pillWarn"];
      var skillsActive = data && data.learnedSkills && data.learnedSkills.available ? (data.learnedSkills.active || []) : null;
      return h("div", { className: "__dsi_root" },
        h("div", { className: "__dsi_toolbar" },
          h("p", { className: "__dsi_cardSub" }, "What the plugin has stored and what it is doing right now."),
          h("button", { type: "button", className: "__dsi_btn __dsi_btnSm", disabled: state.busy, onClick: function () { read.refresh(); } },
            state.busy ? "Refreshing…" : props.t("browserRefresh"))),
        state.error ? h("p", { className: "__dsi_error", role: "alert" }, state.error) : null,
        !data && state.busy ? h("p", { className: "__dsi_muted", role: "status" }, "Loading…") : null,
        data ? h("div", { className: "__dsi_stats" },
          stat("Memories", (data.memories || []).length, "Active long-term memories (the list is capped)"),
          stat("Waiting to process", data.pending || 0, "Conversation sessions not yet turned into memories"),
          stat("Tool episodes reviewed", counts && counts.reviewed || 0),
          stat("Skills", (data.skills || []).length)) : null,
        lane ? h("section", { className: "__dsi_card", "aria-labelledby": "dsi-ov-cont" },
          h("div", { className: "__dsi_cardHead" },
            h("h3", { className: "__dsi_cardTitle", id: "dsi-ov-cont" }, "Session continuity"),
            h("span", { className: "__dsi_pill " + laneStatus[1] }, laneStatus[0])),
          h("p", { className: "__dsi_cardSub" }, "Picks up unfinished work from an earlier session in the same project."),
          lane.structural === "on" ? h("dl", { className: "__dsi_kv" },
            kv("Unfinished tasks", lane.pending || 0),
            kv("Ready to continue", lane.handoffs || 0),
            kv("Handoff summaries", lane.body === "on" ? (lane.route ? "On" : "On · no model") : "Off"),
            kv("Failed attempts", lane.failed || 0)) : null,
          lane.reason ? h("div", { className: "__dsi_callout", role: "status" },
            h("span", null, lane.reason),
            lane.structural === "off" && props.goTo
              ? h("button", { type: "button", className: "__dsi_btn __dsi_btnSm", onClick: function () { props.goTo("config"); } }, "Open settings")
              : lane.handoffs && props.goTo
                ? h("button", { type: "button", className: "__dsi_btn __dsi_btnSm __dsi_btnPrimary", onClick: function () { props.goTo("sessions"); } }, "Continue work")
                : null) : null) : null,
        skillsActive ? h("section", { className: "__dsi_card", "aria-labelledby": "dsi-ov-skills" },
          h("div", { className: "__dsi_cardHead" },
            h("h3", { className: "__dsi_cardTitle", id: "dsi-ov-skills" }, "Learned skills"),
            h("span", { className: "__dsi_pill" + (skillsActive.length ? " __dsi_pillOn" : "") }, skillsActive.length + " active")),
          skillsActive.length
            ? h("ul", { className: "__dsi_list" }, skillsActive.map(function (skill) {
                return h("li", { key: skill.name, className: "__dsi_listItem" },
                  h("div", { className: "__dsi_listMain" },
                    h("span", { className: "__dsi_listTitle" }, skill.name),
                    h("span", { className: "__dsi_muted" }, skill.evaluationVersion ? "Evaluation " + skill.evaluationVersion : "Activated after your review (not evaluated)")));
              }))
            : h("p", { className: "__dsi_cardSub" }, "No learned skill is active."),
          h("p", { className: "__dsi_muted" }, "Only you can invoke these; the model doesn't see them. Manage them with /memory skill-approve, skill-activate and skill-rollback.")) : null);
    }
    /** Readable label for one session summary from `remote.session.list`. */
    function sessionLabel(item) {
      var proj = item && item.projections && item.projections.values;
      var title = proj && proj.title && (proj.title.title || proj.title.text);
      var folder = item && item.cwd ? String(item.cwd).replace(/\/+$/, "").split("/").pop() : "";
      return (title ? String(title) : "Untitled session") + (folder ? " \u00b7 " + folder : "");
    }
    function relativeTime(ts) {
      if (!ts) return "";
      var minutes = Math.round((Date.now() - ts) / 60000);
      if (minutes < 1) return "just now";
      if (minutes < 60) return minutes + " min ago";
      var hours = Math.round(minutes / 60);
      if (hours < 24) return hours + " h ago";
      return Math.round(hours / 24) + " d ago";
    }
    function SessionsSection(props) {
      var targetPair = react.useState(""), target = targetPair[0], setTarget = targetPair[1];
      var listPair = react.useState({ loading: true, items: null }), list = listPair[0], setList = listPair[1];
      var read = useOwnedRead(props.api, "continuityStatus"), state = read.state, data = state.data;
      var rows = data && Array.isArray(data.rows) ? data.rows : [];
      var offers = data && Array.isArray(data.offers) ? data.offers : [];
      var continuePair = react.useState({ busy: false, error: null, notes: null, jobId: null });
      var cont = continuePair[0], setCont = continuePair[1];
      var sendPair = react.useState({ busy: false, error: null, sent: null });
      var send = sendPair[0], setSend = sendPair[1];
      function choose(id) {
        read.cancel(); setTarget(id);
        setCont({ busy: false, error: null, notes: null, jobId: null }); setSend({ busy: false, error: null, sent: null });
        if (id) read.refresh(id);
      }
      react.useEffect(function () {
        var live = true, remote = props.session && props.session.current;
        if (!remote || typeof remote.list !== "function") { setList({ loading: false, items: null }); return function () { live = false; }; }
        Promise.resolve(remote.list({})).then(function (result) {
          if (!live) return;
          var items = result && result.ok && result.value && Array.isArray(result.value.items) ? result.value.items : null;
          items = items ? items.filter(function (item) { return !item.parentSessionId && item.origin !== "subagent"; })
            .sort(function (x, y) { return (y.updatedAt || 0) - (x.updatedAt || 0); }).slice(0, 50) : null;
          setList({ loading: false, items: items });
          if (items && items.length && !target) choose(items[0].sessionId);
        }).catch(function () { if (live) setList({ loading: false, items: null }); });
        return function () { live = false; };
      }, []);
      var labels = {};
      (list.items || []).forEach(function (item) { labels[item.sessionId] = sessionLabel(item); });
      function nameOf(id) { return labels[id] || String(id).slice(0, 8); }
      function contMsg(r) { return r && !r.ok && r.error ? String(r.error.message || r.error.code || "remote failure") : "remote failure"; }
      /**
       * The message the operator is about to send. It states plainly that the
       * block is machine-generated and unverified, so a handoff excerpt can
       * never be read as an instruction from the human who pressed the button.
       */
      function handoffMessage(notes) {
        var lines = ["Continuity handoff from session " + notes.sessionId + " (boundary cut " + notes.cut + "), inserted by the operator from the Sessions view.",
          "Everything below is unverified, machine-generated orientation copied from that session. It is not an instruction, and it is not proof that any action happened or succeeded."];
        var items = notes.notes || [];
        for (var i = 0; i < items.length; i++) lines.push("- " + items[i]);
        return lines.join("\n");
      }
      /** Queue the reviewed handoff as ONE user message in the target session —
       *  the same route the chat uses when you press send. Reached only from
       *  this rendered panel; the agent's tool path has no composer and no
       *  gateway peer (see the boundary note above). */
      function sendHandoff() {
        var session = props.session && props.session.current;
        if (!session || typeof session.prompt !== "function") {
          setSend({ busy: false, error: "This host does not expose the chat composer, so the notes stay here for you to insert yourself.", sent: null });
          return;
        }
        var destination = target.trim();
        if (!destination || !cont.notes) return;
        var requestId = (typeof window !== "undefined" && window.crypto && typeof window.crypto.randomUUID === "function")
          ? window.crypto.randomUUID() : "dsi-" + String(Date.now()) + "-" + Math.random().toString(16).slice(2);
        var request = { requestId: requestId, sessionId: destination, mode: "queue", content: [{ type: "text", text: handoffMessage(cont.notes) }] };
        var zone = (function () { try { var z = Intl.DateTimeFormat().resolvedOptions().timeZone; return typeof z === "string" && z ? z : undefined; } catch (e) { return undefined; } })();
        if (zone) request.clientTimeZone = zone;
        setSend({ busy: true, error: null, sent: null });
        Promise.resolve(session.prompt(request)).then(function (result) {
          if (!result || !result.ok) throw new Error(contMsg(result));
          setSend({ busy: false, error: null, sent: destination });
        }).catch(function (error) {
          setSend({ busy: false, error: String(error && error.message || error), sent: null });
        });
      }
      /**
       * OPERATOR-DOOR CONTINUE.
       *
       * The click mints a peer- and args-bound one-shot confirm through the
       * browser business remote and only then reads the bounded handoff notes.
       * The Host admits /api only with the signed operator cookie and the
       * plugin requires an owner Peer, so the model's tool paths cannot reach
       * this; in-process plugins remain trusted, as everywhere in DSH.
       */
      function continueOffer(jobId) {
        setSend({ busy: false, error: null, sent: null });
        if (!props.api || typeof props.api.prepareContinue !== "function" || typeof props.api.continueSession !== "function") {
          setCont({ busy: false, error: "Continue needs the browser business remote.", notes: null, jobId: null });
          return;
        }
        setCont({ busy: true, error: null, notes: null, jobId: jobId });
        Promise.resolve(props.api.prepareContinue(target.trim(), jobId)).then(function (prepared) {
          if (!prepared || !prepared.ok) throw new Error(contMsg(prepared));
          var token = prepared.value && prepared.value.token;
          if (!token) throw new Error("Continue confirmation was not issued for this operator.");
          return props.api.continueSession(target.trim(), jobId, { token: token });
        }).then(function (result) {
          if (!result || !result.ok) throw new Error(contMsg(result));
          var value = result.value;
          if (!value) { setCont({ busy: false, error: "This handoff is no longer offered (current policy or source changed).", notes: null, jobId: jobId }); return; }
          setCont({ busy: false, error: null, notes: value, jobId: jobId });
        }).catch(function (error) {
          setCont({ busy: false, error: String(error && error.message || error), notes: null, jobId: jobId });
        });
      }
      var picker = list.items
        ? h("select", { id: "dsi-cont-target", className: "__dsi_input", value: target, onChange: function (event) { choose(event.target.value); } },
            target ? null : h("option", { value: "" }, "Choose a session…"),
            list.items.map(function (item) { return h("option", { key: item.sessionId, value: item.sessionId }, labels[item.sessionId] + " \u2014 " + relativeTime(item.updatedAt)); }))
        : h("input", { id: "dsi-cont-target", className: "__dsi_input", value: target, name: "sessionId", autoComplete: "off", spellCheck: false,
            placeholder: list.loading ? "Loading sessions…" : "Session ID",
            onChange: function (event) { read.cancel(); setTarget(event.target.value); },
            onKeyDown: function (event) { if (event.key === "Enter" && target.trim()) { event.preventDefault(); choose(target.trim()); } } });
      return h("div", { className: "__dsi_root" },
        h("section", { className: "__dsi_card", "aria-labelledby": "dsi-ss-head" },
          h("div", { className: "__dsi_cardHead" },
            h("h3", { className: "__dsi_cardTitle", id: "dsi-ss-head" }, "Continue unfinished work"),
            h("button", { type: "button", className: "__dsi_btn __dsi_btnSm", disabled: !target.trim() || state.busy, onClick: function () { read.refresh(target.trim()); } },
              state.busy ? "Refreshing…" : props.t("browserRefresh"))),
          h("p", { className: "__dsi_cardSub" }, "Pick the session you want to work in. Unfinished work from other sessions in the same project shows up below."),
          h("label", { className: "__dsi_field", htmlFor: "dsi-cont-target" }, h("span", { className: "__dsi_label" }, "Continue in"), picker),
          !list.loading && !list.items ? h("p", { className: "__dsi_muted" }, "This host can't list sessions; paste a session ID and press Enter.") : null,
          list.items && !list.items.length ? h("p", { className: "__dsi_muted", role: "status" }, "No sessions yet. Start a chat in a project, then come back here.") : null,
          state.error ? h("p", { className: "__dsi_error", role: "alert" }, state.error) : null,
          data && data.availability !== "ready" && data.reason ? h("div", { className: "__dsi_callout", role: "status" }, h("span", null, data.reason)) : null,
          data && data.availability === "ready" && offers.length
            ? h("ul", { className: "__dsi_list", "aria-label": "Unfinished work" }, offers.map(function (offer) {
                return h("li", { key: offer.jobId, className: "__dsi_listItem" },
                  h("div", { className: "__dsi_listMain" },
                    h("span", { className: "__dsi_listTitle" }, nameOf(offer.sessionId)),
                    h("span", { className: "__dsi_muted" }, "Stopped after message " + offer.cut)),
                  h("button", { type: "button", className: "__dsi_btn __dsi_btnSm __dsi_btnPrimary", disabled: cont.busy,
                    onClick: function () { continueOffer(offer.jobId); } }, cont.busy && cont.jobId === offer.jobId ? "Reading…" : "Continue"));
              }))
            : data && data.availability === "ready" ? h("p", { className: "__dsi_muted", role: "status" }, "No unfinished work from other sessions in this project. Work left in this session shows up when you pick a different session to continue in.") : null,
          cont.error ? h("p", { className: "__dsi_error", role: "alert" }, cont.error) : null),
        cont.notes ? h("section", { className: "__dsi_card", "aria-labelledby": "dsi-ss-notes" },
          h("div", { className: "__dsi_cardHead" },
            h("h3", { className: "__dsi_cardTitle", id: "dsi-ss-notes" }, "Handoff notes"),
            h("span", { className: "__dsi_pill __dsi_pillWarn" }, "Review before sending")),
          h("p", { className: "__dsi_cardSub" }, "Machine-written summary of where " + nameOf(cont.notes.sessionId) + " stopped. It can be stale or wrong, and it doesn't prove anything actually happened."),
          h("ul", { className: "__dsi_notes" }, (cont.notes.notes || []).map(function (note, index) { return h("li", { key: String(index) }, note); })),
          h("div", { className: "__dsi_toolbar" },
            h("p", { className: "__dsi_muted" }, "Sends one message to " + nameOf(target.trim()) + ", as if you typed it."),
            h("button", { type: "button", className: "__dsi_btn __dsi_btnPrimary", disabled: send.busy || !target.trim(), onClick: sendHandoff },
              send.busy ? "Sending…" : "Send to session")),
          send.error ? h("p", { className: "__dsi_error", role: "alert" }, send.error) : null,
          send.sent ? h("p", { className: "__dsi_ok", role: "status" }, "Sent to " + nameOf(send.sent) + ".") : null) : null,
        rows.length ? h("details", { className: "__dsi_details" },
          h("summary", null, "Background processing (" + rows.length + ")"),
          h("div", { className: "__dsi_detailsBody" },
            h("table", { className: "__dsi_table" },
              h("thead", null, h("tr", null, ["Session", "Status", "After message", "Attempts"].map(function (label) { return h("th", { key: label, scope: "col" }, label); }))),
              h("tbody", null, rows.map(function (row) { return h("tr", { key: row.id },
                h("td", null, nameOf(row.sessionId)), h("td", null, row.status), h("td", null, String(row.cut)), h("td", null, String(row.attempts))); }))))) : null);
    }

     var navigationCounter = 0;
    function MainSection(props) {
      var t = props.t;
      var [tab, setTab] = react.useState("overview");
      var navigationId = react.useRef(null); if (!navigationId.current) navigationId.current = "dsi-nav-" + (++navigationCounter);
      function navigateKey(event) {
        var keys = ["overview", "sessions", "config", "memories"], index = keys.indexOf(tab), next;
        if (event.key === "ArrowRight") next = (index + 1) % 4;
        else if (event.key === "ArrowLeft") next = (index + 3) % 4;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = 3;
        else return;
        event.preventDefault(); setTab(keys[next]);
        var buttons = event.currentTarget.querySelectorAll('[role="tab"]'); if (buttons[next]) buttons[next].focus();
      }
      return h("div", { className: "__dsi_tabs", style: { position: "relative" } },
        h("div", { className: "__dsi_tabBar", role: "tablist", "aria-label": "Memory navigation", onKeyDown: navigateKey },
           h("button", { type: "button", role: "tab", id: navigationId.current + "-overview", "aria-controls": navigationId.current + "-panel", tabIndex: tab === "overview" ? 0 : -1, "aria-selected": tab === "overview", className: "__dsi_tab" + (tab === "overview" ? " __dsi_tabActive" : ""), onClick: function () { setTab("overview"); } }, t("tabOverview")),
           h("button", { type: "button", role: "tab", id: navigationId.current + "-sessions", "aria-controls": navigationId.current + "-panel", tabIndex: tab === "sessions" ? 0 : -1, "aria-selected": tab === "sessions", className: "__dsi_tab" + (tab === "sessions" ? " __dsi_tabActive" : ""), onClick: function () { setTab("sessions"); } }, t("tabSessions")),
          h("button", { type: "button", role: "tab", id: navigationId.current + "-config", "aria-controls": navigationId.current + "-panel", tabIndex: tab === "config" ? 0 : -1, "aria-selected": tab === "config", className: "__dsi_tab" + (tab === "config" ? " __dsi_tabActive" : ""), onClick: function () { setTab("config"); } }, t("tabConfig")),
          h("button", { type: "button", role: "tab", id: navigationId.current + "-memories", "aria-controls": navigationId.current + "-panel", tabIndex: tab === "memories" ? 0 : -1, "aria-selected": tab === "memories", className: "__dsi_tab" + (tab === "memories" ? " __dsi_tabActive" : ""), onClick: function () { setTab("memories"); } }, t("tabMemories"))
        ),
        h("div", { role: "tabpanel", id: navigationId.current + "-panel", "aria-labelledby": navigationId.current + "-" + tab },
          tab === "overview" ? h(OverviewSection, Object.assign({ key: tab, goTo: setTab }, props)) : tab === "sessions" ? h(SessionsSection, Object.assign({ key: tab }, props)) : tab === "config" ? h(MemorySection, Object.assign({ key: tab }, props)) : h(BrowserSection, Object.assign({ key: tab }, props)))
      );
    }

    // ─═ [plugin] ═══════════════════════════════════════════════════════════
    async function apply(ctx) {
      var t = (function () { try { return ctx.locale.bind(NS); } catch (e) { return function (k) { return k; }; } })();
      ctx.effect(function () {
        try { return ctx.locale.register(NS, { zh: zh, en: en }); } catch (e) { return function () {}; }
      }, "dsh-self-improved: dictionaries");

      // Typed business remote (mount/unmount effect-owned). The MOUNT must
      // settle before the Memory UI lane starts: rc.2 inject governance only
      // lets a context read `remote.<namespace>` when the reading context
      // declares it, and the entry's own inject list cannot wait for a
      // namespace that the same entry mounts (mounted boot proved that path
      // deadlocks every client activation with "pending (waiting for service:
      // remote.selfImproved)"). The voice-input reference package uses the
      // same shape: mount, then register the UI in a `ctx.inject` child
      // context that grants the namespace key.
      var remoteMount = mountBusinessRemote(ctx);
      ctx.effect(function () {
        return function () { void Promise.resolve(remoteMount.dispose()).catch(function () { /* owned by the fiber too */ }); };
      }, "dsh-self-improved: business remote");
      await remoteMount.settled;

      // Shared entry-addressed settings-form state: created ONCE, persisted
      // across navigation/tabs; the consuming effect only unsubscribes.
      var formBinding = bindSettingsForm(ctx);
      ctx.effect(function () {
        if (!formBinding) return function () {};
        return formBinding.unsubscribeAll;
      }, "dsh-self-improved: settings form subscription");

      var consentApp = {
        confirmConsent: function () { return window.confirm(t("episodeEnableWarning")); }
      };

      // Follow the settings domain: render nothing while the Host does not
      // serve this entry (adapted via configForms.whileServed contract use).
      var configForms = (function () { try { return ctx.get("configForms"); } catch (e) { return void 0; } })();
      var sectionDispose = null; // never double-registered while served
      /** One served/registered cycle: the section lives in a child context
       *  whose inject list grants the business namespace (see businessApi),
       *  so its render closure reads typed business remotes legally. The
       *  child fiber is disposed with this plugin fiber by the Loader. */
      var sectionGoverned = null; // the ctx.inject fiber while the section is registered
      /**
       * The chat's own prompt route. It lives in a SEPARATE inject child so a
       * host that does not mount the session controller never blocks the
       * settings section above (an unsatisfied inject key keeps its own fiber
       * pending, nothing else). Undefined = this host cannot insert a message,
       * and the UI says so instead of pretending.
       */
      var sessionRemote = { current: undefined };
      void Promise.resolve(ctx.inject(["remote.session"], function (sessionCtx) {
        try { sessionRemote.current = sessionCtx.get("remote.session"); }
        catch (e) { sessionRemote.current = undefined; }
      })).catch(function (e) {
        console.warn("[dsh-self-improved] chat composer lane unavailable:", String(e && e.message || e));
      });
      var registerSection = function () {
        if (sectionDispose || sectionGoverned) return function () { /* already registered */ };
        var child = ctx.inject(["remote." + REMOTE_NS, "slots", "locale", "configForms"], function (childCtx) {
          if (sectionDispose) return;
          sectionDispose = childCtx.slots.inject("settings.section", function () {
            return childCtx.slots.register({
              name: "settings.section",
              id: "dsh-self-improved",
              order: 27,
              label: function () { return t("nav"); },
              locale: NS
            }, function (props) {
              return h(MainSection, Object.assign({}, props, { t: t, formBinding: formBinding, app: consentApp, ctx: childCtx, api: businessApi(childCtx), session: sessionRemote }));
            });
          }) || function () {};
        });
        sectionGoverned = child;
        void Promise.resolve(child).catch(function (e) {
          // Mount failure must not kill the plugin fiber (e.g. inject service
          // temporarily absent); a later whileServed cycle retries.
          sectionGoverned = null;
          console.warn("[dsh-self-improved] memory UI lane failed to start:", String(e && e.message || e));
        });
        return function () {
          var d = sectionDispose;
          sectionDispose = null;
          var g = sectionGoverned;
          sectionGoverned = null;
          if (d) d();
          if (d) { void Promise.resolve(g && g.dispose ? g.dispose() : null).catch(function () {}); }
        };
      };
      if (configForms && typeof configForms.whileServed === "function") {
        // The section follows the served settings namespace: registered once
        // the Host serves this entry, unregistered when none serves it; the
        // whileServed disposer itself is effect-owned below.
        var stopFollowing = configForms.whileServed([NAMESPACE], function () {
          return registerSection();
        });
        ctx.effect(function () { return stopFollowing; }, "dsh-self-improved: settings section follows the served entry");
      } else {
        ctx.effect(function () { return registerSection(); }, "dsh-self-improved: settings section (untracked composition)");
      }
    }

    exports.apply = apply;
    // Inject list: this entry MOUNTS the `remote.selfImproved` namespace itself
    // (mountBusinessRemote below), so listing `remote.selfImproved` here makes
    // the entry wait for a service it only creates after apply — a
    // self-referential gate the client Loader never satisfies (mounted boot
    // showed "pending (waiting for service: remote.selfImproved)" and the
    // whole plugin UI stayed unregistered). `remote` is injected so $mount can
    // run; the namespace is read lazily per render (businessApi).
    exports.inject = ["slots", "locale", "connection", "remote", "configForms"];
    return module.exports;
  }
});
