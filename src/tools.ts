/**
 * 记忆工具模块（M1/M4）：memory_search / conversation_search / memory_correct / memory_forget。
 * 返回注销函数（运行时开关工具组用）。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore } from "./storage.js";

export function registerMemoryTools(ctx: Context, store: MemoryStore, defaultLimit: number): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.tools.register(defineTool({
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
  })));

  disposers.push(ctx.tools.register(defineTool({
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
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memory_correct",
    description:
      "纠正一条记忆：把新内容写入（supersedes 指向旧记忆），旧记忆标记为 corrected。用户明确纠正你记住的内容时使用。",
    parameters: {
      memory_id: { type: "string", description: "要纠正的旧记忆 id", required: true },
      new_content: { type: "string", description: "纠正后的内容（一句话）", required: true },
      kind: { type: "string", description: "新记忆类型（可选，默认沿用旧记忆类型）" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { new_id: { type: "string" }, error: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: value.new_id ? `已纠正记忆，新 id: ${value.new_id}` : `纠正失败：${value.error}` }],
    },
    async execute(args) {
      const old = store.getMemory(String(args.memory_id));
      if (!old) return { error: "未找到该记忆" };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const kind = (args.kind as any) || old.kind;
      const record = store.insertMemory({
        kind,
        content: String(args.new_content),
        importance: old.importance,
        supersedes: old.id,
      });
      store.setMemoryStatus(old.id, "corrected");
      return { new_id: record.id };
    },
  })));

  disposers.push(ctx.tools.register(defineTool({
    name: "memory_forget",
    description: "遗忘一条记忆（标记 forgotten，不再参与检索与注入）。",
    parameters: {
      memory_id: { type: "string", description: "要遗忘的记忆 id", required: true },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
      },
      render: (_args, value) => [{ type: "text", text: value.ok ? "已遗忘该记忆" : "未找到该记忆" }],
    },
    async execute(args) {
      return { ok: store.forgetMemory(String(args.memory_id)) };
    },
  })));
  return () => { for (const d of disposers) d(); };
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
