/**
 * dsh-self-improved —— DeepSeek Harness 长期记忆与自进化插件（纯本地）。
 *
 * M1 状态：记忆库（SQLite + FTS5 + sqlite-vec 骨架）+ L0 捕获落盘 + 记忆/对话搜索工具。
 * 设计文档见 docs/（design/ 与 research/）。
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

// 服务类型增强：把各 dsh-* 包的 `declare module '@deepseek-ai/cordis'` 类型增强引入本次编译。
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-schedule";
import "@deepseek-ai/dsh-session-query";

import { MemoryStore, defaultMemoryDir } from "./storage.js";
import { installCapture } from "./capture.js";
import { registerMemoryTools } from "./tools.js";
import { Extractor, type ExtractSettings } from "./extract.js";
import { RecallService, createOpenAiEmbedding, type RecallSettings } from "./recall.js";
import { installRecallInjection } from "./inject.js";
import { Consolidator } from "./consolidate.js";
import { applyDecay, synthesizeSkills } from "./evolve.js";
import { installMemoryCommands, browserSnapshot } from "./commands.js";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "self-improved";

/** 需要的宿主服务（Cordis inject 列表；M1 新增 sessionQuery 用于对话全文搜索） */
export const inject = ["sessions", "settings", "tools", "sessionQuery", "llm"] as const;

/** 模块开关（联动规则见 docs/design/dsh-memory-detailed-design.md §2.5） */
export interface ModuleSwitches {
  capture: boolean;
  extract: boolean;
  consolidate: boolean;
  evolve: boolean;
  recall: boolean;
  tools: boolean;
}

export interface ExtractConfig {
  /** 定时轮询间隔（分钟） */
  intervalMinutes: number;
  /** 单次提取输入字符上限 */
  batchMaxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** 去重 */
  dedup: boolean;
  /** 坏 JSON 回退原文摘要（默认关闭，避免产生低价值摘要噪音） */
  fallbackOnBadJson: boolean;
  /** 丢弃重要度低于该值的提取结果（降噪，默认 3） */
  minImportance: number;
  /** headless：flush 时同步排空 */
  flushDrain: boolean;
  /** 提取模型（留空跟随 DSH 默认） */
  model: string;
  provider: string;
}

export interface EmbeddingConfig {
  /** OpenAI 兼容 embedding 端点；留空 = 纯关键词召回 */
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

export interface RecallConfig {
  strategy: "keyword" | "hybrid";
  maxResults: number;
  scoreThreshold: number;
  timeoutMs: number;
  embedding: EmbeddingConfig;
}

export interface Config {
  /** L1 总开关：随时关闭/开启，热切换，不重启 */
  enabled: boolean;
  /** 探针/调试日志 */
  debug: boolean;
  /** 记忆库根目录；留空 = $DSH_HOME/memory */
  storageRoot: string;
  /** 工具默认返回条数 */
  searchLimit: number;
  /** L2 模块开关 */
  modules: ModuleSwitches;
  /** L1 提取管线参数 */
  extract: ExtractConfig;
  /** M3 召回参数 */
  recall: RecallConfig;
  /** M4 巩固（L2/L3）参数 */
  consolidate: { sceneMaxMemories: number; personaMaxMemories: number; sceneBatchSize: number };
  /** M4 自进化参数 */
  evolve: {
    decay: { enabled: boolean; minAgeDays: number; threshold: number; retentionDays: number };
    skillSynthesis: { enabled: boolean; minImportance: number; skillsRoot: string; prefix: string };
  };
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  debug: z.boolean().default(false),
  storageRoot: z.string().default(""),
  searchLimit: z.number().min(1).max(50).default(5),
  modules: z.object({
    capture: z.boolean().default(true),
    extract: z.boolean().default(true),
    consolidate: z.boolean().default(true),
    evolve: z.boolean().default(true),
    recall: z.boolean().default(true),
    tools: z.boolean().default(true),
  }),
  extract: z.object({
    intervalMinutes: z.number().min(1).default(15),
    batchMaxChars: z.number().min(2000).max(100000).default(12000),
    maxOutputTokens: z.number().min(128).default(2000),
    timeoutMs: z.number().min(5000).default(60000),
    dedup: z.boolean().default(true),
    fallbackOnBadJson: z.boolean().default(false),
    minImportance: z.number().min(1).max(10).default(3),
    flushDrain: z.boolean().default(false),
    model: z.string().default(""),
    provider: z.string().default(""),
  }),
  recall: z.object({
    strategy: z.string().default("keyword"),
    maxResults: z.number().min(1).max(20).default(5),
    scoreThreshold: z.number().min(0).default(0),
    timeoutMs: z.number().min(1000).default(5000),
    embedding: z.object({
      baseUrl: z.string().default(""),
      apiKey: z.string().default(""),
      model: z.string().default(""),
      dimensions: z.number().min(64).default(1024),
      timeoutMs: z.number().min(1000).default(10000),
    }),
  }),
  consolidate: z.object({
    sceneMaxMemories: z.number().min(1).default(50),
    personaMaxMemories: z.number().min(1).default(30),
    sceneBatchSize: z.number().min(1).max(20).default(8),
  }),
  evolve: z.object({
    decay: z.object({
      enabled: z.boolean().default(true),
      minAgeDays: z.number().min(1).default(30),
      threshold: z.number().min(0).default(2),
      retentionDays: z.number().min(0).default(180),
    }),
    skillSynthesis: z.object({
      enabled: z.boolean().default(true),
      minImportance: z.number().min(1).max(10).default(7),
      skillsRoot: z.string().default(""),
      prefix: z.string().default("dsi-"),
    }),
  }),
});

export function apply(ctx: Context, config: Config): void {
  const log = (...args: unknown[]): void => {
    if (config.debug) console.log("[dsh-self-improved]", ...args);
  };

  // ① 设置命名空间：Web UI 设置页自动渲染表单 + settings/updated 热应用（随时开关的核心）
  const ns = settingsNamespace("dsh-self-improved");
  const scope = ctx.settings.register(ns, Config, { base: config });
  log("settings namespace registered");

  // 运行时可变状态（M5：总开关/模块开关随时切换，无需重启）
  const state = { enabled: config.enabled, modules: { ...config.modules } };
  const readModule = (m: keyof ModuleSwitches): boolean => state.enabled && state.modules[m];

  // ② 记忆库（M1）：SQLite + FTS5 + sqlite-vec 骨架
  const dir = config.storageRoot.trim() || defaultMemoryDir();
  const store = new MemoryStore(dir);
  log("memory store ready:", dir);

  // ③ L0 捕获 + L1 提取：session/flush 屏障内落盘切片并标记队列；
  //    headless（flushDrain）时同步排空提取，防止 5s 关停超时杀掉管线。
  const extractSettings: ExtractSettings = {
    enabled: readModule("extract"),
    intervalMinutes: config.extract.intervalMinutes,
    batchMaxChars: config.extract.batchMaxChars,
    maxOutputTokens: config.extract.maxOutputTokens,
    timeoutMs: config.extract.timeoutMs,
    dedup: config.extract.dedup,
    fallbackOnBadJson: config.extract.fallbackOnBadJson,
    minImportance: config.extract.minImportance,
    flushDrain: config.extract.flushDrain,
  };
  const embeddingProvider = createOpenAiEmbedding(config.recall.embedding);

  // 通用 LLM 调用器（提取/巩固/技能合成共用；复用 DSH 模型栈）
  const makeLlmCall = (purpose: string, maxTokens: number) =>
    async (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }): Promise<string> => {
      const assembler = new BlockAssembler();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: any = {
        messages: [
          createUserMessage({
            content: [{ type: "text", text: input.user }],
            source: { kind: "plugin", plugin: "dsh-self-improved" },
          }),
        ],
        system: input.system,
        maxTokens,
        purpose,
        signal: input.signal,
      };
      if (input.sessionId) options.sessionId = input.sessionId;
      // 提取/巩固/技能模型：优先显式配置，其次回退到 DSH 默认模型（agentDefaultModel）
      let provider = config.extract.provider;
      let model = config.extract.model;
      if (!provider || !model) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dm = (ctx as any).get?.("agentDefaultModel");
          const sel = dm?.currentSelection?.();
          if (sel && typeof sel.provider === "string" && typeof sel.model === "string") {
            provider = provider || sel.provider;
            model = model || sel.model;
          }
        } catch {
          /* 无默认模型则保持未配置 */
        }
      }
      if (provider) options.provider = provider;
      if (model) options.model = model;
      for await (const chunk of ctx.llm.stream(options)) {
        input.signal.throwIfAborted();
        assembler.push(chunk);
      }
      return assembler
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    };
  const extractLlm = makeLlmCall("memory-extract", extractSettings.maxOutputTokens);

  const extractor = new Extractor(store, extractSettings, async ({ system, user, sessionId, signal }) => {
    if (config.debug) {
      console.log("[dsh-self-improved] extract llm input:", typeof user, "len:", String(user).length, "session:", sessionId);
    }
    return extractLlm({ system, user, sessionId, signal });
  }, embeddingProvider);
  installCapture(ctx, store, { enabled: () => readModule("capture") }, () => {
    if (!extractSettings.enabled) return;
    const result = extractor.pump();
    if (extractSettings.flushDrain) return result;
    result.catch((error) => console.warn("[dsh-self-improved] extract pump error:", String(error)));
  });
  log("capture + extract installed");

  // 定时进化管线（dsh-schedule 不在 headless base 装配中，用进程内定时器）
  const consolidateLlm = makeLlmCall("memory-consolidate", 2000);
  const consolidator = new Consolidator(
    store,
    {
      sceneMaxMemories: config.consolidate.sceneMaxMemories,
      personaMaxMemories: config.consolidate.personaMaxMemories,
      sceneBatchSize: config.consolidate.sceneBatchSize,
    },
    async ({ system, user, signal }) => consolidateLlm({ system, user, signal }),
    embeddingProvider,
  );
  const skillLlm = makeLlmCall("memory-skill", 3000);
  const runEvolution = (): void => {
    const jobs: Array<Promise<unknown>> = [];
    if (readModule("consolidate")) {
      jobs.push(consolidator.consolidate().catch((e) => console.warn("[dsh-self-improved] consolidate error:", String(e))));
    }
    if (readModule("evolve")) {
      jobs.push(
        Promise.resolve()
          .then(() =>
            applyDecay(store, {
              enabled: config.evolve.decay.enabled,
              minAgeDays: config.evolve.decay.minAgeDays,
              threshold: config.evolve.decay.threshold,
              retentionDays: config.evolve.decay.retentionDays,
            }),
          )
          .then((r) => {
            if (r.decayed > 0 || r.deleted > 0) log("decay applied:", JSON.stringify(r));
          })
          .catch((e) => console.warn("[dsh-self-improved] decay error:", String(e))),
      );
      jobs.push(
        synthesizeSkills(
          store,
          async ({ system, user, signal }) => skillLlm({ system, user, signal }),
          {
            enabled: config.evolve.skillSynthesis.enabled,
            minImportance: config.evolve.skillSynthesis.minImportance,
            skillsRoot: config.evolve.skillSynthesis.skillsRoot,
            prefix: config.evolve.skillSynthesis.prefix,
          },
          config.evolve.skillSynthesis.skillsRoot,
        )
          .then((n) => {
            if (n > 0) log("skills synthesized:", n);
          })
          .catch((e) => console.warn("[dsh-self-improved] skill synthesis error:", String(e))),
      );
    }
    void Promise.allSettled(jobs);
  };
  const timer = setInterval(() => {
    const jobs: Array<Promise<unknown>> = [];
    jobs.push(extractor.pump().catch((e) => console.warn("[dsh-self-improved] extract pump error:", String(e))));
    jobs.push(Promise.resolve().then(runEvolution));
    void Promise.allSettled(jobs);
  }, config.extract.intervalMinutes * 60_000);
  timer.unref?.();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => {
    clearInterval(timer);
    store.close();
  });
  log("evolution timer scheduled (every", config.extract.intervalMinutes, "min)");

  // ④ 记忆工具（M1/M4）：可运行时开关（tools 模块）
  let toolsDispose: (() => void) | null = null;
  const syncTools = (): void => {
    const want = readModule("tools");
    if (want && !toolsDispose) {
      toolsDispose = registerMemoryTools(ctx, store, config.searchLimit);
      log("tools enabled");
    } else if (!want && toolsDispose) {
      toolsDispose();
      toolsDispose = null;
      log("tools disabled");
    }
  };
  syncTools();

  // ⑤ 召回注入（M3）：agent/pre-step 自动注入相关记忆
  const recallSettings: RecallSettings = {
    strategy: config.recall.strategy === "hybrid" ? "hybrid" : "keyword",
    maxResults: config.recall.maxResults,
    scoreThreshold: config.recall.scoreThreshold,
    timeoutMs: config.recall.timeoutMs,
  };
  const recall = new RecallService(store, recallSettings, embeddingProvider);
  installRecallInjection(ctx, recall, {
    enabled: () => readModule("recall"),
    maxHits: config.recall.maxResults,
    debug: config.debug,
  });
  log("recall injection installed (strategy:", recallSettings.strategy, ")");

  // ⑥ CLI 命令（M5）：/memory（宿主提供 commands 服务时生效）
  if (installMemoryCommands(ctx, store)) {
    log("memory command installed (/memory)");
  } else {
    log("commands service unavailable in this host — skip /memory command");
  }

  // ⑦ 热应用：settings/updated → 更新运行时状态（随时开关，无需重启）
  scope.watch((next) => {
    state.enabled = next.enabled;
    state.modules = { ...next.modules };
    extractSettings.enabled = readModule("extract");
    syncTools();
    log("runtime config applied:", "enabled=", next.enabled, "modules=", JSON.stringify(next.modules));
  });

  // ⑧ 记忆浏览器数据通道（设置页前端无需 session 即可读取/操作记忆）：
  //    专用命名空间 dsh-self-improved-browser：snapshot=快照 JSON，action=前端发来的操作
  const browserNs = settingsNamespace("dsh-self-improved-browser");
  const BrowserSchema = z.object({
    snapshot: z.string().default("{}"),
    action: z.string().default(""),
  });
  const browserScope = ctx.settings.register(browserNs, BrowserSchema);
  let lastSnapshotJson = "";
  let lastHandledAction = "";
  const refreshBrowserSnapshot = (): void => {
    try {
      const json = JSON.stringify(browserSnapshot(store));
      if (json === lastSnapshotJson) return;
      lastSnapshotJson = json;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = (browserScope.get() ?? {}) as any;
      browserScope.replace({ snapshot: json, action: cur.action ?? "" }).catch(() => { /* 尽力而为 */ });
    } catch {
      /* noop */
    }
  };
  const handleBrowserAction = (raw: string): void => {
    if (!raw || raw === lastHandledAction) return;
    lastHandledAction = raw;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = JSON.parse(raw) as any;
      if (action.op === "forget" && typeof action.id === "string") {
        store.forgetMemory(action.id);
        log("browser action: forget", action.id.slice(0, 8));
      } else if (action.op === "correct" && typeof action.id === "string" && typeof action.content === "string") {
        const old = store.getMemory(action.id);
        if (old) {
          store.insertMemory({ kind: old.kind, content: action.content, importance: old.importance, supersedes: old.id });
          store.setMemoryStatus(old.id, "corrected");
          log("browser action: correct", action.id.slice(0, 8));
        }
      }
    } catch {
      /* noop */
    }
    lastSnapshotJson = ""; // 强制下次刷新
    refreshBrowserSnapshot();
    browserScope.replace({ snapshot: lastSnapshotJson, action: "" }).catch(() => { /* noop */ });
  };
  browserScope.watch((next, _prev) => {
    if (next.action) handleBrowserAction(next.action);
  });
  refreshBrowserSnapshot();
  const browserTimer = setInterval(refreshBrowserSnapshot, 60_000);
  browserTimer.unref?.();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => clearInterval(browserTimer));
  log("memory browser channel ready (dsh-self-improved-browser)");

  // ⑥ 后台管线（M2 起：extract/consolidate/evolve，dsh-schedule 驱动）
  // 注：M0 已确认 schedule 服务不在 headless base 装配中，引入时需按装配判断

  log("dsh-self-improved 已加载（M5 完整版）");
}
