/**
 * Memory tools module (M1/M4): memory_search / conversation_search / memory_correct / memory_forget.
 * Returns a disposer (used to toggle the tool group on/off at runtime).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore } from "./storage.js";

export function registerMemoryTools(ctx: Context, store: MemoryStore, defaultLimit: number): () => void {
  const disposers: Array<() => void> = [];
  disposers.push(ctx.tools.register(defineTool({
    name: "memory_search",
    description:
      "Search the long-term memory store for structured memories (facts/preferences/events/instructions). Use when you need to recall cross-session history, user preferences, or past decisions.",
    parameters: {
      query: { type: "string", description: "Keyword or one-sentence description", required: true },
      kind: {
        type: "string",
        description: "Memory kind filter: fact / preference / event / instruction (optional)",
      },
      limit: { type: "integer", description: "Maximum number of results to return" },
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
      "Full-text search across all historical conversation transcripts (reuses the DSH session full-text index). Use when you need to find the original wording or details of a past conversation.",
    parameters: {
      query: { type: "string", description: "Full-text search keywords", required: true },
      limit: { type: "integer", description: "Maximum number of results to return" },
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
      "Correct a memory: writes the new content (its supersedes field points to the old memory) and marks the old memory as corrected. Use when the user explicitly corrects something you remembered.",
    parameters: {
      memory_id: { type: "string", description: "The id of the old memory to correct", required: true },
      new_content: { type: "string", description: "The corrected content (one sentence)", required: true },
      kind: { type: "string", description: "Kind of the new memory (optional; defaults to the old memory's kind)" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { new_id: { type: "string" }, error: { type: "string" } },
      },
      render: (_args, value) => [{ type: "text", text: value.new_id ? `Memory corrected, new id: ${value.new_id}` : `Correction failed: ${value.error}` }],
    },
    async execute(args) {
      const old = store.getMemory(String(args.memory_id));
      if (!old) return { error: "Memory not found" };
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
    description: "Forget a memory (marks it forgotten; it no longer participates in search or injection).",
    parameters: {
      memory_id: { type: "string", description: "The id of the memory to forget", required: true },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { ok: { type: "boolean" } },
      },
      render: (_args, value) => [{ type: "text", text: value.ok ? "Memory forgotten" : "Memory not found" }],
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
  if (hits.length === 0) return [{ type: "text", text: "No relevant memories found." }];
  const lines = hits.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any, i: number) =>
      `${i + 1}. [${h.kind}] ${h.content} (importance ${h.importance}/10, id: ${h.id})`,
  );
  return [{ type: "text", text: lines.join("\n") }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function renderConversationHits(value: any): Array<{ type: "text"; text: string }> {
  const hits = value?.hits ?? [];
  if (hits.length === 0) return [{ type: "text", text: "No relevant conversations found." }];
  const lines = hits.map(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h: any, i: number) => `${i + 1}. [session ${h.sessionId}] ${h.title ? h.title + " — " : ""}${h.snippet}`,
  );
  return [{ type: "text", text: lines.join("\n") }];
}
