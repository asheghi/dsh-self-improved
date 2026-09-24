/**
 * Recall injection module (M3 + M7): in the agent/pre-step waterfall, renders relevant memories
 * into the owning agent's scoped system-prompt context. DSH serializes dynamic context as an
 * attributed snapshot before the live request, so memory never masquerades as the latest user request.
 * A message-append fallback remains only for minimal/headless hosts without systemPrompt.context.
 *
 * M7 rules:
 * - Inject only at step 1 (before the conversation starts, aligned with Tencent Auto-Recall);
 * - Dedup cache is session-scoped: keyed by (project, session, message hash) and capped via LRU,
 *   so identical messages in different sessions each get their own recall;
 * - At most maxInjectPerTurn memory blocks in pending messages (guards runaway plugin stacking);
 * - The block is clearly delimited, marked fallible and subordinate to current user instructions
 *   (see renderRecallBlock), and records provenance { roleHint: "memory" } for downstream routing;
 * - Memories created by the *current session* are never injected back (self-echo guard);
 * - Successful injection bumps access counts (read_count / last_read_at / access_count);
 * - Search timeout/failure → skip injection, never block the turn.
 */
import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { RecallService } from "./recall.js";
import { renderRecallBlock } from "./recall.js";

export interface InjectController {
  enabled(): boolean;
  maxHits: number;
  /** Character cap for the injection block (prevents a single injection from flooding the context) */
  maxChars?: number;
  debug?: boolean;
  /** Project key for cache scoping + project-aware recall (stable per workspace; reused until changed) */
  projectKey?: () => string;
  /** Session id of the current conversation for cache scoping + self-echo guard */
  sessionIdOf?: (payload: unknown) => string;
  /** Project key resolution from the pre-step payload (cwd/workspace-based scoping) */
  projectKeyOf?: (payload: unknown) => string;
  /** Cap of dsh-self-improved blocks already pending in the turn (0 = no cap) */
  maxInjectPerTurn?: number;
  /** Called with the ids of memories actually injected (access tracking; host wires store.recordAccess) */
  onInjected?: (ids: string[]) => void;
}

const CACHE_MAX = 128;

export function installRecallInjection(ctx: Context, recall: RecallService, controller: InjectController): void {
  // LRU-ish dedup cache: key = (project, session, hash(query))
  const injectedCache = new Map<string, string>();
  const onInjected = controller.onInjected;
  // Iterable plugin-owned lifecycle tracking (NOT WeakMap): every scoped system-prompt
  // context is disposed on agent disposal, plugin dispose, or when a fresh turn replaces it.
  const contextDisposers = new Map<object, () => void>();

  const clearScopedContext = (agent: unknown): void => {
    if (!agent || typeof agent !== "object") return;
    const dispose = contextDisposers.get(agent as object);
    if (dispose) {
      dispose();
      contextDisposers.delete(agent as object);
    }
  };
  const clearAllScopedContexts = (): void => {
    for (const dispose of contextDisposers.values()) {
      try { dispose(); } catch { /* best effort */ }
    }
    contextDisposers.clear();
  };
  // Agent teardown: drop scoped context immediately (plugin-owned iterable state, no WeakGC timing)
  ctx.on("agent/disposed", (payload: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    clearScopedContext((payload as any)?.agent ?? payload);
  });
  // Plugin teardown: dispose every live context registration we own
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => { clearAllScopedContexts(); });

  const enterWithContext = (payload: any, decision: any, block: string): any => {
    const agent = payload?.agent;
    const registry = agent?.ctx?.systemPrompt;
    if (agent && typeof agent === "object" && registry && typeof registry.context === "function") {
      clearScopedContext(agent);
      if (block && payload?.signal?.aborted) return decision;
      if (block) {
        const dispose = registry.context({ name: "dsh-self-improved:recall", order: 90, text: block });
        if (typeof dispose === "function") contextDisposers.set(agent, dispose);
      }
      return decision;
    }
    if (!block) return decision;
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
            roleHint: "memory",
          } as any,
        }),
      ],
    };
  };

  ctx.on(
    "agent/pre-step",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (payload: any, next: any) => {
      const decision = await next();
      if (decision.kind === "reject" || payload.signal?.aborted) return decision;

      // Refresh/clear the scoped context once per turn; later tool steps reuse it.
      if (payload.step !== 1) return decision;
      if (!controller.enabled()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        clearScopedContext(payload?.agent ?? payload);
        return decision;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      clearScopedContext(payload?.agent ?? payload);

      // Use the last user message among the pending messages as the search query
      const query = lastUserText(decision.messages);
      if (controller.debug) console.log("[dsh-self-improved] pre-step query:", JSON.stringify(query.slice(0, 80)), "step:", payload.step);
      if (!query) return decision;

      // Guard: never stack memory blocks on top of a turn that already carries several plugin injections
      const cap = controller.maxInjectPerTurn ?? 0;
      if (cap > 0 && countPluginBlocks(decision.messages) >= cap) {
        if (controller.debug) console.log("[dsh-self-improved] injection skipped: plugin block cap reached");
        return decision;
      }

      const sessionId = controller.sessionIdOf?.(payload) ?? payload.agent?.id ?? payload.sessionId ?? "";
      // DEFAULT PROJECT ISOLATION: automatic recall always carries a project key,
      // including the literal 'default'. null never means "unscoped automatic
      // recall" — cross-project leakage is impossible at the query boundary.
      const projectKey = controller.projectKeyOf?.(payload) || "default";
      const cacheKey = `${projectKey}:${sessionId || "no-session"}:${hashText(query)}`;
      const cached = injectedCache.get(cacheKey);
      if (cached) {
        const registry = payload.agent?.ctx?.systemPrompt;
        return registry && typeof registry.context === "function" ? enterWithContext(payload, decision, cached) : decision;
      }

      const hits = await recall.search(query, {
        maxResults: controller.maxHits,
        projectId: projectKey,
        excludeSessionId: sessionId || undefined,
      });
      // Lifecycle: re-check abort AFTER the recall await and before registering context
      if (payload.signal?.aborted) {
        if (controller.debug) console.log("[dsh-self-improved] injection aborted after recall; skipping");
        return decision;
      }
      if (controller.debug) console.log("[dsh-self-improved] recall hits:", hits.length);
      let hitsForRender = hits;
      let block = renderRecallBlock(hitsForRender, controller.maxHits);
      if (controller.maxChars && block.length > controller.maxChars) {
        // Shrink by dropping the weakest contextual hits (rank order) instead of slicing
        // mid-text, which would leave the wrapper tags unbalanced.
        const cap = controller.maxChars;
        while (block.length > cap && hitsForRender.length > 1) {
          hitsForRender = hitsForRender.slice(0, -1);
          block = renderRecallBlock(hitsForRender, controller.maxHits);
        }
        if (block.length > cap) block = "";
      }
      if (!block) return decision;

      // Cache (LRU-cap: evict the oldest, never wipe fresh entries wholesale)
      while (injectedCache.size >= CACHE_MAX) {
        const oldest = injectedCache.keys().next().value;
        if (oldest === undefined) break;
        injectedCache.delete(oldest);
      }
      injectedCache.set(cacheKey, block);

      // Access tracking: only hits actually rendered into the block (after char
      // trimming) count as recall access; dropped hits were never shown.
      if (onInjected && hitsForRender.length > 0) onInjected(hitsForRender.map((h) => h.id));

      return enterWithContext(payload, decision, block);
    },
    { prepend: true },
  );
}

  /** Count pending plugin messages already injected into this turn (stacking guard) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function countPluginBlocks(messages: any[]): number {
  if (!Array.isArray(messages)) return 0;
  return messages.filter(
    (m) =>
      m &&
      m.role === "user" &&
      m.source &&
      m.source.kind === "plugin" &&
      (m.source.plugin === undefined || m.source.plugin === "dsh-self-improved" || m.source.roleHint === "memory"),
  ).length;
}

/** Take the text of the last "real user message" among the pending messages (used for search; skips plugin-injected/snapshot user messages) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lastUserText(messages: any[] | undefined): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== "user") continue;
    const src = msg.source;
    // Skip user messages injected by the system/plugins (runtime context, AGENTS.md instructions, skill catalog, recall snapshots, etc.)
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
