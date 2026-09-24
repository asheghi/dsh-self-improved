/**
 * Memory tools module (M1/M4): memory_search / conversation_search / memory_correct / memory_forget.
 * Returns a disposer (used to toggle the tool group on/off at runtime).
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore } from "./storage.js";
import { projectKeyFromCwd } from "./capture.js";

export function registerMemoryTools(ctx: Context, store: MemoryStore, defaultLimit: number): () => void {
  const disposers: Array<() => void> = [];
  // Tool-call scope resolution: like automatic recall, tool-driven lookup stays
  // project-aware (global rows + the caller's project only). The registry hands
  // every execute() a ToolRunContext carrying the calling agent; its session
  // cwd maps to the same stable project key used by capture/injection, and the
  // agent id doubles as the self-echo session filter. A missing context
  // (tests / registry-less dispatch) falls back to the unscoped explicit path.
  const scopeOf = (exec: unknown): { projectId?: string | null; excludeSessionId?: string } => {
    const agent = (exec as { agent?: { id?: unknown; session?: { header?: { cwd?: unknown } } } } | undefined)?.agent;
    if (!agent || typeof agent !== "object") return {};
    // DEFAULT PROJECT ISOLATION holds here too: an empty cwd resolves to the
    // literal 'default' key, never to "no scoping".
    const cwd = agent.session?.header?.cwd;
    const excludeSessionId = typeof agent.id === "string" && agent.id ? agent.id : undefined;
    return {
      projectId: projectKeyFromCwd(typeof cwd === "string" ? cwd : ""),
      ...(excludeSessionId ? { excludeSessionId } : {}),
    };
  };
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
    async execute(args, exec) {
      const limit = typeof args.limit === "number" ? args.limit : defaultLimit;
      const scope = scopeOf(exec);
      const hits = store.searchMemories(String(args.query), { limit, ...scope });
      const filtered = typeof args.kind === "string" && args.kind
        ? hits.filter((h) => h.kind === args.kind)
        : hits;
      // Access accounting: only hits actually RETURNED to the model count — a
      // kind filter applied after the query means filtered-out rows were never
      // rendered and must not consume an access bump.
      if (filtered.length > 0) store.recordAccess(filtered.map((h) => h.id));
      return {
        hits: filtered.map((h) => ({ id: h.id, kind: h.kind, content: h.content, importance: h.importance })),
      };
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
      "Stage a correction candidate when the user explicitly corrects a memory. Tool-authored arguments stay untrusted for automatic recall; the user must confirm via the direct /memory correct command or the memory browser before the corrected content is trusted.",
    parameters: {
      memory_id: { type: "string", description: "The id of the old memory to correct", required: true },
      new_content: { type: "string", description: "The corrected content (one sentence)", required: true },
      kind: { type: "string", description: "Kind of the new memory (optional; defaults to the old memory's kind)" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { new_id: { type: "string" }, pending: { type: "boolean" }, note: { type: "string" }, error: { type: "string" } },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render: (_args, value) => [{ type: "text", text: renderCorrectionOutcome(value) }],
    },
    async execute(args) {
      const old = store.getMemory(String(args.memory_id));
      if (!old) return { error: "Memory not found" };
      const requestedKind = typeof args.kind === "string" ? args.kind : "";
      const validKinds = new Set(["fact", "preference", "event", "instruction", "persona"]);
      if (requestedKind && !validKinds.has(requestedKind)) return { error: `Invalid memory kind: ${requestedKind}` };
      const kind = (requestedKind || old.kind) as typeof old.kind;
      const record = store.insertMemory(
        {
          kind,
          content: String(args.new_content),
          importance: old.importance,
          supersedes: old.id,
        },
        {
          // Tool arguments are model-authored and cannot prove a direct human assertion.
          // Stage the candidate with derived provenance; the ORIGINAL row stays active
          // and recallable until the user confirms the correction through the direct
          // /memory command or the browser action (which promote the candidate and
          // retire the old row coherently).
          provenance: "derived",
          source: "tool-correct",
          scope: old.meta?.scope ?? "global",
          projectId: old.meta?.projectId ?? null,
          sessionId: old.meta?.sessionId ?? null,
          confidence: 0.5,
        },
      );
      return {
        new_id: record.id,
        pending: true,
        note: "Correction candidate staged with UNTRUSTED provenance. The original memory remains active in recall until the user confirms the correction with /memory correct or the memory browser.",
      };
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
function renderCorrectionOutcome(value: any): string {
  if (value?.error) return `Correction failed: ${value.error}`;
  if (value?.new_id) {
    return [
      `Correction candidate staged: ${value.new_id}`,
      "The candidate carries tool-authored (derived) provenance and is NOT used in automatic recall.",
      `The original memory stays active until the USER confirms the correction via /memory correct or the memory browser.`,
    ].join(" ");
  }
  return "Correction failed: unknown error";
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
