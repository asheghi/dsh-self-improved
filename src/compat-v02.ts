/**
 * Phase A typed compatibility adapters (MIGRATION-V0.2.md).
 *
 * This module names every rc.2 contract fact this plugin relies on at a single
 * site, so future runtime bumps change one file:
 *
 * - `MessageSourceMap` is merge-extensible: this plugin declares its own source
 *   kind `dsh-self-improved` instead of the removed `plugin` catch-all kind.
 *   Model-visible injected context uses the harness `snapshot` context form:
 *   recall is current state whose later snapshot from the same producer
 *   supersedes the earlier one, so a per-turn re-admission never accumulates
 *   duplicated recall in derived history (the superseding behavior is the
 *   harness's `snapshot` contract, not a plugin-side cache trick).
 * - Session event reads: rc.2 deprecates synchronous `session.events` access;
 *   own events after the fork-inherited prefix are read through
 *   `session.ownEvents()` with the exact fork boundary
 *   `session.inheritedEventCount`. Replacement through the session-query
 *   observation contract happens at one site: {@link readOwnSessionEvents}.
 * - Agent request admission goes through the `agent/pre-step` waterfall with
 *   the FULL `PreStepDecision` shape (including `startsRequestSeries`);
 *   callers must spread and not reconstruct the decision.
 * - Auxiliary model calls: `Purpose` is fuse-limited to `compaction |
 *   session-title` so memory work never claims one of them; aux requests set a
 *   concrete `provider` + `model` and validate the terminal `finish` reason
 *   (only `stop` accepts text as a completed review).
 */
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    /** Producer-supplied context registered by the dsh-self-improved plugin. */
    "dsh-self-improved": {
      kind: "dsh-self-improved";
    };
  }
}

/**
 * Build a model-visible injected-context user message carrying the plugin's
 * own declared source kind and the harness `recall` context form. This is the
 * only sanctioned construction of plugin memory text on the model surface.
 */
export function createRecallContextMessage(text: string): ReturnType<typeof createUserMessage<{
  content: readonly ContentBlock[];
  source: { kind: "dsh-self-improved"; form: "snapshot"; sections: readonly { name: string; text: string }[] };
}>> {
  return createUserMessage({
    content: [{ type: "text", text }],
    // snapshot form: later snapshots from this producer supersede earlier ones.
    source: { kind: "dsh-self-improved", form: "snapshot", sections: [{ name: "long-term-memory-recall", text }] },
  });
}

/**
 * A producer-supplied user message (assistant tool briefs, plugin injections,
 * coordinator relays read back from logs): any producer kind that is not
 * `user` is never treated as direct human authority. Unknown kinds stay
 * untrusted by definition of the merge-extensible vocabulary.
 */
export function isDirectHumanUserSource(source: unknown): boolean {
  return !!source && typeof source === "object"
    && (source as { kind?: unknown }).kind === "user";
}

/**
 * Is this message a plugin/recall/context injection rather than a genuine user
 * request? Used both for the self-echo guard in injection query extraction and
 * for counting our own blocks already present in a proposed step.
 */
export function isInjectedContextUserSource(source: unknown): boolean {
  if (!source || typeof source !== "object") return false;
  const s = source as { kind?: unknown; form?: unknown };
  return s.kind === "dsh-self-improved"
    || s.kind === "plugin"
    || s.kind === "agent-instructions"
    || s.kind === "skill-catalog"
    || s.kind === "skill-invocation"
    || s.form === "snapshot"
    || s.form === "recall";
}

/**
 * Read one resume-safe owned event window from a rc.2 Session.
 *
 * `session.events` is gone in rc.2; snapshots/own-events are deliberately
 * deprecated in favor of asynchronous query observations. Until the Phase B
 * job ledger owns a durable read, this is the single site where those
 * deprecated synchronous reads happen, with the exact fork boundary honored:
 * a forked child's inherited prefix is never recaptured and a legitimate
 * zero-based event is never skipped (floor starts at -1 semantics via
 * `inheritedEventCount - 1`). Sessions or test doubles without
 * `ownEvents()` keep a structurally typed `events` fallback so legacy mocks
 * and direct SessionEvent inputs still flow through this same adapter.
 *
 * @param fromSeqExclusive event sequences strictly above this are returned
 *   (durable cursor: last consumed seq, or -1 for an empty log).
 */
export function readOwnSessionEvents(
  session: Session,
  fromSeqExclusive: number,
  limit?: number,
): readonly SessionEvent[] {
  const holder = session as unknown as {
    ownEvents?(): readonly SessionEvent[];
    events?: readonly SessionEvent[];
  };
  const own = typeof holder.ownEvents === "function" ? holder.ownEvents() : holder.events ?? [];
  if (!Number.isFinite(fromSeqExclusive)) return [];
  const start = Math.max(fromSeqExclusive + 1, 0);
  const tail: SessionEvent[] = [];
  for (const event of own) {
    if (!Number.isFinite(event.seq) || event.seq < start) continue;
    tail.push(event);
  }
  return limit === undefined ? tail : tail.slice(0, Math.max(0, limit));
}

export type TerminalFinishReason =
  | { kind: "stop" | "unknown"; complete: boolean; blocked: boolean }
  | { kind: "tool-calls" | "max-tokens" | "aborted" | "error"; complete: false; blocked: true };

/**
 * Definitive terminal-finish validation for auxiliary (non-conversational)
 * model calls: only a `stop` finish makes the accumulated text a completed
 * review. `tool-calls` cannot complete a text review without an implemented,
 * verified tool round-trip (these calls declare no tools); `max-tokens`,
 * `aborted`, and `error` finishes fail explicitly so partial output is never
 * treated as a completed extraction/review/skill call. Unknown extensible
 * reasons are treated as blocked-conservative.
 */
export function evaluateTerminalFinish(kind: string, hasFinishChunk: boolean): TerminalFinishReason {
  if (!hasFinishChunk) {
    return { kind: "error", complete: false, blocked: true };
  }
  switch (kind) {
    case "stop":
      return { kind: "stop", complete: true, blocked: false };
    case "tool-calls":
      // Auxiliary extraction/review calls declare no tools; a tool-calls finish
      // without a verified tool round-trip can never prove a completed review.
      return { kind: "tool-calls", complete: false, blocked: true };
    case "max-tokens":
    case "aborted":
    case "error":
      return { kind, complete: false, blocked: true };
    default:
      // Unknown future provider-specific reasons: conservative refusal.
      return { kind: "unknown", complete: false, blocked: true };
  }
}
