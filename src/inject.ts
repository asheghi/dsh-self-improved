/**
 * Recall injection module (M3): in the agent/pre-step waterfall, renders relevant memories into a user message
 * appended to decision.messages (the official injection path, modeled after the dsh-time-context pattern).
 *
 * Rules:
 * - Inject only at step 1 (before the conversation starts, aligned with Tencent Auto-Recall);
 * - Dedup cache keyed by the current user message text (the same message is never injected twice);
 * - Search timeout/failure → skip injection, never block the turn;
 * - Injected message source: { kind: "plugin", plugin: "dsh-self-improved", form: "snapshot" } (replayable, auditable).
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
}

export function installRecallInjection(ctx: Context, recall: RecallService, controller: InjectController): void {
  // User messages recently injected (text hash → injected text), so the same step/repeated messages are not injected over and over
  const injectedCache = new Map<string, string>();
  const CACHE_MAX = 128;

  ctx.on(
    "agent/pre-step",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async (payload: any, next: any) => {
      const decision = await next();
      if (decision.kind === "reject" || payload.signal?.aborted) return decision;
      if (!controller.enabled()) return decision;

      // Inject only on the first step of a turn
      if (payload.step !== 1) return decision;

      // Use the last user message among the pending messages as the search query
      const query = lastUserText(decision.messages);
      if (controller.debug) console.log("[dsh-self-improved] pre-step query:", JSON.stringify(query.slice(0, 80)), "step:", payload.step);
      if (!query) return decision;
      const cacheKey = hashText(query);
      if (injectedCache.has(cacheKey)) return decision;

      const hits = await recall.search(query, { maxResults: controller.maxHits });
      if (controller.debug) console.log("[dsh-self-improved] recall hits:", hits.length, hits.map((h) => h.kind).join(","));
      let block = renderRecallBlock(hits, controller.maxHits);
      if (controller.maxChars && block.length > controller.maxChars) {
        block = block.slice(0, controller.maxChars) + "\n… (truncated)";
      }
      if (!block) return decision;

      // Cache and inject
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
