/**
 * dsh-self-improved — browser half.
 *
 * A "自进化记忆" section inside the Web UI settings page: edits the
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
      ".__dsi_unavailable{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}";
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
      nav: "自进化记忆",
      intro: "长期记忆与自进化插件：自动捕获对话、提炼记忆、回合前召回注入，并随时间巩固、遗忘与进化。",
      helpTitle: "插件说明",
      help: [
        "dsh-self-improved 为 DSH 补充跨会话的长期记忆与自进化能力，所有数据默认保存在本地（$DSH_HOME/memory），不上传。",
        "",
        "【工作流程】",
        "L0 对话捕获：每个会话结束时自动把对话写入本地切片，供提取管线使用。",
        "L1 记忆提取：后台用大模型从对话中提炼「原子记忆」（事实 / 偏好 / 事件 / 指令），带 JSON 校验、去重与敏感信息过滤。",
        "L2 场景归纳 / L3 用户画像：定期把记忆归纳为场景块，并增量合成用户画像（版本化，可回滚）。",
        "自动召回注入：新回合开始前，按当前问题检索相关记忆，以「【相关记忆】」块注入给模型——AI 从此记得你。",
        "自进化：记忆按「重要度 × 新鲜度 × 被引用次数」衰减遗忘；用户可纠正记忆；成功经验可提炼为可复用技能写入 dsh-skill。",
        "",
        "【模块开关】",
        "• 记录对话：捕获 L0（关闭后不再产生新记忆素材）",
        "• 提炼记忆：L1 提取（关闭后召回仍可用旧记忆）",
        "• 归纳场景/画像：L2/L3（关闭后画像不更新）",
        "• 自进化：衰减/技能合成（关闭后记忆只增不减）",
        "• 自动召回注入：回合前注入（关闭后仍可用工具主动搜索）",
        "• 记忆工具：memory_search / memory_correct / memory_forget 等模型可见工具",
        "",
        "【怎么用】",
        "• 聊天输入框敲「/」打开命令菜单：/memory status、/memory list、/memory search <词>、/memory forget <id>、/memory correct <id> <新内容>",
        "• 模型会自动使用记忆工具（memory_search 等），无需手动操作",
        "• 本页修改保存后立即生效，无需重启",
        "",
        "【模型与隐私】",
        "• 提取/画像/技能默认使用 DSH 默认模型，可在「提取」分组单独指定",
        "• 敏感凭据（API key / 密码等）会被过滤，不会写入记忆",
        "• 记忆库纯本地；向量召回需配置 embedding 端点，未配置时自动降级为关键词召回",
        "",
        "【注意事项】",
        "• 提取依赖可用的模型且输出稳定；长会话会分批消化（每次一批、一次调用，30 秒节流）",
        "• 画像（persona）与技能会在记忆积累到一定量后逐步生成",
        "• 卸载插件不会自动删除本地记忆数据"
      ].join("\n"),
      groupMaster: "总开关",
      groupModules: "模块开关",
      groupStorage: "存储",
      groupExtract: "提取（L1）",
      groupRecall: "召回 / 向量",
      groupConsolidate: "巩固（L2/L3）",
      groupEvolve: "自进化",
      save: "保存",
      reset: "恢复默认",
      saved: "已保存并立即生效",
      saving: "保存中…",
      error: "保存失败",
      unavailable: "设置命名空间不可用（服务端未注册 dsh-self-improved？）",
      overridden: "已覆盖",
      loading: "加载中…",
      fEnabled: "启用插件（总开关）",
      fDebug: "调试日志",
      fCapture: "记录对话（L0 捕获）",
      fExtract: "提炼记忆（L1 提取）",
      fConsolidate: "归纳场景/画像（L2/L3）",
      fEvolve: "自进化（衰减/技能）",
      fRecall: "自动召回注入",
      fTools: "记忆工具（memory_search 等）",
      fStorageRoot: "记忆库目录（留空 = $DSH_HOME/memory）",
      fSearchLimit: "工具默认返回条数",
      fProvider: "提取 Provider（留空用默认模型）",
      fModel: "提取模型（留空用默认模型）",
      fInterval: "定时轮询间隔（分钟）",
      fBatchChars: "单次提取输入字符上限",
      fMaxTokens: "最大输出 Tokens",
      fTimeoutMs: "提取超时（毫秒）",
      fDedup: "去重（token 重叠）",
      fFallback: "坏 JSON 回退原文摘要",
      fFlushDrain: "headless 退出前排空提取",
      fStrategy: "召回策略",
      fMaxResults: "召回条数上限",
      fScoreThreshold: "相似度阈值（0=不过滤）",
      fRecallTimeout: "召回超时（毫秒）",
      fEmbBase: "Embedding Base URL（留空=纯关键词）",
      fEmbKey: "Embedding API Key（只写）",
      fEmbModel: "Embedding 模型",
      fEmbDims: "向量维度",
      fEmbTimeout: "Embedding 超时（毫秒）",
      fSceneMax: "参与场景归纳的记忆数",
      fPersonaMax: "参与画像合成的记忆数",
      fSceneBatch: "每个场景最大记忆数",
      fDecay: "遗忘衰减",
      fDecayAge: "最小存在天数（天）",
      fDecayThreshold: "衰减评分阈值",
      fDecayRetention: "遗忘清理保留期（天，0=不清理）",
      fSkill: "技能合成（→ dsh-skill）",
      fSkillMin: "技能合成最低重要度",
      fSkillRoot: "技能根目录（留空 = $DSH_HOME/skills）",
      secretHint: "留空保持当前密钥。"
    };
    var en = {
      nav: "Evolving Memory",
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
        "",
        "[Module switches]",
        "• Capture (L0): records conversations (off = no new memory material)",
        "• Extract (L1): distillation (off = recall still uses old memories)",
        "• Consolidate (L2/L3): scenes/persona (off = persona not updated)",
        "• Evolve: decay & skill synthesis (off = memory only grows)",
        "• Recall injection: pre-turn injection (off = tools still allow manual search)",
        "• Tools: memory_search / memory_correct / memory_forget model-visible tools",
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
        "• Uninstalling the plugin does not delete local memory data"
      ].join("\n"),
      groupMaster: "Master",
      groupModules: "Modules",
      groupStorage: "Storage",
      groupExtract: "Extraction (L1)",
      groupRecall: "Recall / Embedding",
      groupConsolidate: "Consolidation (L2/L3)",
      groupEvolve: "Self-evolution",
      save: "Save",
      reset: "Reset",
      saved: "Saved — applied immediately",
      saving: "Saving…",
      error: "Save failed",
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
      fStrategy: "Recall strategy",
      fMaxResults: "Max recall results",
      fScoreThreshold: "Score threshold (0 = off)",
      fRecallTimeout: "Recall timeout (ms)",
      fEmbBase: "Embedding Base URL (blank = keyword only)",
      fEmbKey: "Embedding API Key (write-only)",
      fEmbModel: "Embedding model",
      fEmbDims: "Vector dimensions",
      fEmbTimeout: "Embedding timeout (ms)",
      fSceneMax: "Memories for scene grouping",
      fPersonaMax: "Memories for persona",
      fSceneBatch: "Max memories per scene",
      fDecay: "Forgetting decay",
      fDecayAge: "Min age (days)",
      fDecayThreshold: "Decay score threshold",
      fDecayRetention: "Forgotten retention (days, 0=keep)",
      fSkill: "Skill synthesis (→ dsh-skill)",
      fSkillMin: "Skill min importance",
      fSkillRoot: "Skills root (blank = $DSH_HOME/skills)",
      secretHint: "Leave blank to keep the current key."
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
      { path: ["recall", "strategy"], label: "fStrategy", type: "select", options: ["keyword", "hybrid"], group: "groupRecall" },
      { path: ["recall", "maxResults"], label: "fMaxResults", type: "number", group: "groupRecall" },
      { path: ["recall", "scoreThreshold"], label: "fScoreThreshold", type: "number", group: "groupRecall" },
      { path: ["recall", "timeoutMs"], label: "fRecallTimeout", type: "number", group: "groupRecall" },
      { path: ["recall", "embedding", "baseUrl"], label: "fEmbBase", type: "text", group: "groupRecall" },
      { path: ["recall", "embedding", "apiKey"], label: "fEmbKey", type: "password", secret: true, group: "groupRecall" },
      { path: ["recall", "embedding", "model"], label: "fEmbModel", type: "text", group: "groupRecall" },
      { path: ["recall", "embedding", "dimensions"], label: "fEmbDims", type: "number", group: "groupRecall" },
      { path: ["recall", "embedding", "timeoutMs"], label: "fEmbTimeout", type: "number", group: "groupRecall" },
      { path: ["consolidate", "sceneMaxMemories"], label: "fSceneMax", type: "number", group: "groupConsolidate" },
      { path: ["consolidate", "personaMaxMemories"], label: "fPersonaMax", type: "number", group: "groupConsolidate" },
      { path: ["consolidate", "sceneBatchSize"], label: "fSceneBatch", type: "number", group: "groupConsolidate" },
      { path: ["evolve", "decay", "enabled"], label: "fDecay", type: "checkbox", group: "groupEvolve" },
      { path: ["evolve", "decay", "minAgeDays"], label: "fDecayAge", type: "number", group: "groupEvolve" },
      { path: ["evolve", "decay", "threshold"], label: "fDecayThreshold", type: "number", group: "groupEvolve" },
      { path: ["evolve", "decay", "retentionDays"], label: "fDecayRetention", type: "number", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "enabled"], label: "fSkill", type: "checkbox", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "minImportance"], label: "fSkillMin", type: "number", group: "groupEvolve" },
      { path: ["evolve", "skillSynthesis", "skillsRoot"], label: "fSkillRoot", type: "text", group: "groupEvolve" }
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
        scope.load();
        var alive = true;
        var sync = function () { if (alive) setSnapshot(scope.getSnapshot()); };
        var un = typeof scope.subscribe === "function" ? scope.subscribe(sync) : null;
        return function () { alive = false; if (un) un(); if (scope.dispose) scope.dispose(); };
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
        return draft[f.key] !== void 0 ? draft[f.key] : String(getPath(value, f.path) ?? "");
      }
      function setField(f, v) {
        setDraft(function (prev) { var next = Object.assign({}, prev); next[f.key] = v; return next; });
        setNotice(null);
        setError(null);
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
            ops.push(Boolean(d) ? { op: "set", path: f.path, value: true } : { op: "unset", path: f.path });
            continue;
          }
          if (f.type === "select") {
            if (String(d) === String(current ?? "")) continue;
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
          setBusy(false);
          if (!response.result.ok) {
            var detail = response.result.error || {};
            setError(t("error") + ": " + String(detail.message || detail.code || "unknown"));
            return;
          }
          setNotice(t("saved"));
          if (response.result.value) setDraft(Object.assign({}, valueToDraft(response.result.value)));
          scope.load();
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
          setBusy(false);
          if (!response.result.ok) { setError(t("error")); return; }
          setNotice(t("saved"));
          if (response.result.value) setDraft(Object.assign({}, valueToDraft(response.result.value)));
          scope.load();
        }).catch(function (e) {
          setBusy(false); setError(t("error") + ": " + String(e && e.message || e));
        });
      }

      var nodes = [];
      var lastGroup = null;
      FIELDS.forEach(function (f) {
        if (f.group !== lastGroup) {
          lastGroup = f.group;
          nodes.push(h("div", { key: "g" + f.group, className: "__dsi_group" }, t(f.group)));
        }
        var overridden = getPath(user, f.path) !== void 0;
        if (f.type === "checkbox") {
          nodes.push(h("label", { key: f.path.join("."), className: "__dsi_field" },
            h("span", { className: "__dsi_row" },
              h("input", { className: "__dsi_check", type: "checkbox", checked: Boolean(fieldDraft(f)), onChange: function (e) { setField(f, e.target.checked); } }),
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
          f.type === "password" ? h("span", { className: "__dsi_hint" }, t("secretHint")) : null
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

    // ── plugin ────────────────────────────────────────────────────────────
    function apply(ctx) {
      var t = ctx.locale.bind(NS);
      ctx.effect(function () { return ctx.locale.register(NS, { zh: zh, en: en }); }, "dsh-self-improved: dictionaries");
      var scope = ctx.settingsScope.bind({ namespace: "dsh-self-improved" });
      var api = ctx.connection.api;
      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: "dsh-self-improved",
          order: 27,
          label: function () { return t("nav"); },
          locale: NS
        }, function (props) {
          return h(MemorySection, Object.assign({}, props, { scope: scope, api: api }));
        });
      });
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
