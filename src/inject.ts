/**
 * 召回注入模块（M3）：在 agent/pre-step 瀑布中，把相关记忆渲染成一条 user 消息
 * 追加进 decision.messages（官方注入正路，仿 dsh-time-context 范式）。
 *
 * 规则：
 * - 仅在 step 1 注入（对话开始前，对齐腾讯 Auto-Recall）；
 * - 按当前用户消息文本做去重缓存（同一消息不重复注入）；
 * - 检索超时/失败 → 跳过注入，绝不阻塞回合；
 * - 注入消息 source: { kind: "plugin", plugin: "dsh-self-improved", form: "snapshot" }（可回放、可审计）。
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { RecallService } from "./recall.js";
import { renderRecallBlock } from "./recall.js";

export interface InjectController {
  enabled(): boolean;
  maxHits: number;
  /** 注入块字符上限（防单次注入撑爆上下文） */
  maxChars?: number;
  debug?: boolean;
}

export function installRecallInjection(ctx: Context, recall: RecallService, controller: InjectController): void {
  // 最近注入过的用户消息（文本 hash → 注入文本），避免同一步/重复消息反复注入
  const injectedCache = new Map<string, string>();
  const CACHE_MAX = 128;

  ctx.on(
    "agent/pre-step",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (payload: any, next: any) => {
      const decision = await next();
      if (decision.kind === "reject" || payload.signal?.aborted) return decision;
      if (!controller.enabled()) return decision;

      // 仅回合第一步注入
      if (payload.step !== 1) return decision;

      // 取本次待处理消息中的最后一条 user 消息作为检索查询
      const query = lastUserText(decision.messages);
      if (controller.debug) console.log("[dsh-self-improved] pre-step query:", JSON.stringify(query.slice(0, 80)), "step:", payload.step);
      if (!query) return decision;
      const cacheKey = hashText(query);
      if (injectedCache.has(cacheKey)) return decision;

      const hits = await recall.search(query, { maxResults: controller.maxHits });
      if (controller.debug) console.log("[dsh-self-improved] recall hits:", hits.length, hits.map((h) => h.kind).join(","));
      let block = renderRecallBlock(hits, controller.maxHits);
      if (controller.maxChars && block.length > controller.maxChars) {
        block = block.slice(0, controller.maxChars) + "\n…（已截断）";
      }
      if (!block) return decision;

      // 缓存并注入
      if (injectedCache.size >= CACHE_MAX) injectedCache.clear();
      injectedCache.set(cacheKey, block);
      return {
        kind: "enter",
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: "text", text: block }],
            source: {
              kind: "plugin",
              plugin: "dsh-self-improved",
              form: "snapshot",
              sections: [{ name: "memory-recall", text: block }],
            },
          }),
        ],
      };
    },
    { prepend: true },
  );
}

/** 从待处理消息中取最后一条"真实用户消息"的文本（用于检索；跳过插件注入/快照类 user 消息） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastUserText(messages: any[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const src = msg.source;
    // 跳过系统/插件注入的 user 消息（运行时上下文、AGENTS.md 指令、技能目录、召回快照等）
    if (src) {
      const form = src.form;
      const kind = src.kind;
      if (
        kind === "plugin" ||
        kind === "agent-instructions" ||
        kind === "skill-catalog" ||
        kind === "skill-invocation" ||
        form === "snapshot"
      ) {
        continue;
      }
    }
    const content = msg.content;
    if (Array.isArray(content)) {
      const texts = content
        .filter((b: { type?: string; text?: unknown }) => b && b.type === "text" && typeof b.text === "string")
        .map((b: { text: string }) => b.text);
      if (texts.length > 0) return texts.join("\n");
    }
    if (typeof content === "string") return content;
  }
  return "";
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}
