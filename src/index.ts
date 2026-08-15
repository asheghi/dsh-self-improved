/**
 * dsh-self-improved —— DeepSeek Harness 长期记忆与自进化插件（纯本地）。
 *
 * M0 探针阶段：验证 DSH 接线点。
 * 设计文档见 docs/（design/ 与 research/）。
 *
 * 架构（对齐 TencentDB Agent Memory 四层金字塔，自研实现）：
 *   L0 capture(对话捕获) → L1 extract(记忆提取) → L2 consolidate(场景/画像) → L3 evolve(自进化)
 *   服务面：recall(检索) / inject(召回注入) / tools(记忆工具) / ui(设置+浏览器)
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

// 服务类型增强：以下 import 把各 dsh-* 包的 `declare module '@deepseek-ai/cordis'`
// 类型增强（ctx.settings / ctx.sessions / agent 事件等）引入本次编译。
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-schedule";

export const name = "self-improved";

/** 需要的宿主服务（Cordis inject 列表；M0 只声明实际使用的服务） */
export const inject = ["sessions", "settings", "tools"] as const;

/** 模块开关（联动规则见 docs/design/dsh-memory-detailed-design.md §2.5） */
export interface ModuleSwitches {
  capture: boolean;
  extract: boolean;
  consolidate: boolean;
  evolve: boolean;
  recall: boolean;
  tools: boolean;
}

export interface Config {
  /** L1 总开关：随时关闭/开启，热切换，不重启 */
  enabled: boolean;
  /** 探针日志（M0 用） */
  debug: boolean;
  /** L2 模块开关 */
  modules: ModuleSwitches;
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  debug: z.boolean().default(false),
  modules: z.object({
    capture: z.boolean().default(true),
    extract: z.boolean().default(true),
    consolidate: z.boolean().default(true),
    evolve: z.boolean().default(true),
    recall: z.boolean().default(true),
    tools: z.boolean().default(true),
  }),
});

export function apply(ctx: Context, config: Config): void {
  const log = (...args: unknown[]): void => {
    if (config.debug) console.log("[dsh-self-improved]", ...args);
  };

  // ============ M0 探针接线（逐点验证，随后里程碑替换为真实实现） ============

  // ① 设置命名空间：Web UI 设置页自动渲染表单；settings/updated 热应用（随时开关的地基）
  ctx.settings.register(settingsNamespace("dsh-self-improved"), Config, { base: config });
  log("probe: settings namespace registered");

  // ② 会话事件捕获（L0 地基）：session/flush 是持久化屏障，监听器必须 await；
  //    headless 退出前在此收尾管线，否则 5s 关停超时会杀任务。
  ctx.on("session/flush", async (session) => {
    if (!config.enabled || !config.modules.capture) return;
    log("probe session/flush", session.id, "events:", session.events.length);
    // TODO(M1): 归一化切片 → 提取队列（按 session+turn 幂等游标，落 memory 域）
  });

  // ③ 召回注入（agent/pre-step 瀑布，prepend 抢占；官方注入正路，见 dsh-time-context 范式）
  //    必须 await next() 拿默认决策，再追加/改写 decision.messages。
  ctx.on(
    "agent/pre-step",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (payload: any, next: any) => {
      const decision = await next();
      if (decision.kind === "reject" || payload.signal?.aborted) return decision;
      if (!config.enabled || !config.modules.recall) return decision;
      log("probe agent/pre-step", payload.agent?.id, "turn", payload.turn, "step", payload.step);
      // TODO(M3): recall.search(当前用户消息) → 渲染一条 user 消息追加进 decision.messages
      //           （source: { kind: "plugin", plugin: "dsh-self-improved", form: "snapshot" }）
      return decision;
    },
    { prepend: true },
  );

  // ④ 工具注册（M1 起提供 memory_search / conversation_search / memory_correct / memory_forget）
  if (config.enabled && config.modules.tools) {
    ctx.tools.register(defineTool({
      name: "memory_probe",
      description: "[M0 探针] 验证 dsh-self-improved 工具注册链路是否对模型可见。",
      parameters: { text: { type: "string", description: "任意文本", required: true } },
      output: {
        schema: { type: "object", additionalProperties: false, properties: {} },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        render: (_args: any, value: any) => [{ type: "text", text: String(value) }],
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async execute(args: any) {
        return { received: args.text };
      },
    }));
    log("probe: tool memory_probe registered");
  }

  // ⑤ 稳定上下文段（M3 起注册画像摘要/场景目录；systemPrompt.context 自动差分投影为 user 消息）
  // ctx.systemPrompt.context({ name: "self-improved-persona", order: 500, text: () => "…" });

  // ⑥ 后台管线（M2 起用 dsh-schedule 驱动 extract/consolidate/evolve；空闲触发 + 定时）
  // const job = ctx.schedule.createEveryScheduleRecord({ minutes: 15 }, async () => { … });
  // ctx.on("dispose", () => job.cancel?.());

  log("dsh-self-improved 已加载（M0 探针）");
}
