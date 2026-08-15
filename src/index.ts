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
  /** 坏 JSON 回退原文摘要 */
  fallbackOnBadJson: boolean;
  /** headless：flush 时同步排空 */
  flushDrain: boolean;
  /** 提取模型（留空跟随 DSH 默认） */
  model: string;
  provider: string;
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
    fallbackOnBadJson: z.boolean().default(true),
    flushDrain: z.boolean().default(false),
    model: z.string().default(""),
    provider: z.string().default(""),
  }),
});

export function apply(ctx: Context, config: Config): void {
  const log = (...args: unknown[]): void => {
    if (config.debug) console.log("[dsh-self-improved]", ...args);
  };

  // ① 设置命名空间：Web UI 设置页自动渲染表单（随时开关的地基）
  ctx.settings.register(settingsNamespace("dsh-self-improved"), Config, { base: config });
  log("settings namespace registered");

  // ② 记忆库（M1）：SQLite + FTS5 + sqlite-vec 骨架
  const dir = config.storageRoot.trim() || defaultMemoryDir();
  const store = new MemoryStore(dir);
  log("memory store ready:", dir);

  // ③ L0 捕获 + L1 提取：session/flush 屏障内落盘切片并标记队列；
  //    headless（flushDrain）时同步排空提取，防止 5s 关停超时杀掉管线。
  const extractSettings: ExtractSettings = {
    enabled: config.enabled && config.modules.extract,
    intervalMinutes: config.extract.intervalMinutes,
    batchMaxChars: config.extract.batchMaxChars,
    maxOutputTokens: config.extract.maxOutputTokens,
    timeoutMs: config.extract.timeoutMs,
    dedup: config.extract.dedup,
    fallbackOnBadJson: config.extract.fallbackOnBadJson,
    flushDrain: config.extract.flushDrain,
  };
  const extractor = new Extractor(store, extractSettings, async ({ system, user, sessionId, signal }) => {
    if (config.debug) {
      console.log("[dsh-self-improved] extract llm input:", typeof user, "len:", String(user).length, "session:", sessionId);
    }
    const assembler = new BlockAssembler();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const options: any = {
      messages: [
        createUserMessage({
          content: [{ type: "text", text: user }],
          source: { kind: "plugin", plugin: "dsh-self-improved" },
        }),
      ],
      system,
      maxTokens: extractSettings.maxOutputTokens,
      sessionId,
      purpose: "memory-extract",
      signal,
    };
    if (config.extract.provider) options.provider = config.extract.provider;
    if (config.extract.model) options.model = config.extract.model;
    for await (const chunk of ctx.llm.stream(options)) {
      signal.throwIfAborted();
      assembler.push(chunk);
    }
    return assembler
      .blocks()
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
  });
  const runExtract = (): void => {
    extractor.pump().catch((error) => console.warn("[dsh-self-improved] extract pump error:", String(error)));
  };
  installCapture(ctx, store, { enabled: () => config.enabled && config.modules.capture }, () => {
    if (!extractSettings.enabled) return;
    const result = extractor.pump();
    if (extractSettings.flushDrain) return result;
    result.catch((error) => console.warn("[dsh-self-improved] extract pump error:", String(error)));
  });
  log("capture + extract installed");

  // 定时泵（dsh-schedule 不在 headless base 装配中，M2 用进程内定时器）
  const timer = setInterval(runExtract, config.extract.intervalMinutes * 60_000);
  timer.unref?.();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => {
    clearInterval(timer);
    store.close();
  });
  log("extract timer scheduled (every", config.extract.intervalMinutes, "min)");

  // ④ 记忆工具（M1）：memory_search / conversation_search
  if (config.enabled && config.modules.tools) {
    registerMemoryTools(ctx, store, config.searchLimit);
    log("tools registered (memory_search / conversation_search)");
  }

  // ⑤ 召回注入探针（M3 起真实实现）：agent/pre-step 瀑布，prepend 抢占
  ctx.on(
    "agent/pre-step",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (payload: any, next: any) => {
      const decision = await next();
      if (decision.kind === "reject" || payload.signal?.aborted) return decision;
      if (!config.enabled || !config.modules.recall) return decision;
      log("agent/pre-step", payload.agent?.id, "turn", payload.turn, "step", payload.step);
      // TODO(M3): recall.search(当前用户消息) → 渲染一条 user 消息追加进 decision.messages
      return decision;
    },
    { prepend: true },
  );

  // ⑥ 后台管线（M2 起：extract/consolidate/evolve，dsh-schedule 驱动）
  // 注：M0 已确认 schedule 服务不在 headless base 装配中，引入时需按装配判断

  log("dsh-self-improved 已加载（M1 记忆库）");
}
