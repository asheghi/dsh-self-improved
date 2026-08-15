/**
 * 记忆工具模块（M1）：memory_search（L1 结构化记忆）+ conversation_search（L0 对话全文，复用 ctx.sessionQuery）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore } from "./storage.js";

export function registerMemoryTools(ctx: Context, store: MemoryStore, defaultLimit: number): void {
  ctx.tools.register(defineTool({
    name: "memory_search",
    description:
      "在长期记忆库中搜索结构化记忆（事实/偏好/事件/指令）。当你需要回忆跨会话的历史信息、用户偏好、过往决策时使用。",
    parameters: {
      query: { type: "string", description: "关键词或一句话描述", required: true },
      kind: {
        type: "string",
        description: "记忆类型过滤：fact 事实 / preference 偏好 / event 事件 / instruction 指令（可选）",
      },
      limit: { type: "integer", description: "返回条数上限" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hits: {
            type: "array",
            items: { type: "json" },
            required: true,
          },
        },
      },
      render: (_args, value) => renderMemoryHits(value),
    },
    async execute(args) {
      const limit = typeof args.limit === "number" ? args.limit : defaultLimit;
      const hits = store.searchMemories(String(args.query), { limit });
      if (typeof args.kind === "string" && args.kind) {
        return {
          hits: hits
            .filter((h) => h.kind === args.kind)
            .map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance })),
        };
      }
      return { hits: hits.map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance })) };
    },
  }));

  ctx.tools.register(defineTool({
    name: "conversation_search",
    description:
      "在全部历史会话原文中全文搜索（复用 DSH 会话全文索引）。当你需要找到某次对话的原始表述或细节时使用。",
    parameters: {
      query: { type: "string", description: "全文检索关键词", required: true },
      limit: { type: "integer", description: "返回条数上限" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          hits: {
            type: "array",
            items: { type: "json" },
            required: true,
          },
        },
      },
      render: (_args, value) => renderConversationHits(value),
    },
    async execute(args) {
      const limit = typeof args.limit === "number" ? args.limit : defaultLimit;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sessionQuery: any = (ctx as any).sessionQuery;
        const page = await sessionQuery.searchSessions({
          query: String(args.query),
          limit,
        });
        const items: unknown[] = page?.items ?? [];
        return {
          hits: items.map((hit) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const h = hit as any;
            return {
              sessionId: String(h.id ?? h.sessionId ?? ""),
              title: h.title ? String(h.title) : "",
              snippet: h.snippet ? String(h.snippet) : "",
            };
          }),
        };
      } catch (error) {
        return { hits: [], error: String(error) };
      }
    },
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderMemoryHits(value: any): Array<{ type: "text"; text: string }> {
  const hits = value?.hits ?? [];
  if (hits.length === 0) return [{ type: "text", text: "（没有找到相关记忆）" }];
  const lines = hits.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any, i: number) =>
      `${i + 1}. [${h.kind}] ${h.content}（重要度 ${h.importance}/10，id: ${h.id}）`,
  );
  return [{ type: "text", text: lines.join("\n") }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderConversationHits(value: any): Array<{ type: "text"; text: string }> {
  const hits = value?.hits ?? [];
  if (hits.length === 0) return [{ type: "text", text: "（没有找到相关对话）" }];
  const lines = hits.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any, i: number) => `${i + 1}. [会话 ${h.sessionId}] ${h.title ? h.title + " — " : ""}${h.snippet}`,
  );
  return [{ type: "text", text: lines.join("\n") }];
}
