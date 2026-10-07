/**
 * Recall injection module (Phase A rc.2 adapter): recall is admitted through
 * the `agent/pre-step` waterfall by RETURNING a memory-tagged message inside
 * the step decision. This is the supported, logged admission path with correct
 * timing — the returned decision's messages are exactly what the step admits
 * and the harness logs; dynamic-context/system-prompt registries avoid this
 * adapter because prompting assembly/pre-step ordering made them mistimed for
 * the first request (MIGRATION-V0.2.md §recall timing). Because every admitted
 * decision message becomes a durable `user/message` event and rc.2 request
 * assembly does not prune earlier producer snapshots, the adapter applies
 * emit-on-change discipline: a repeat turn re-admits only when the rendered
 * recall changed, otherwise the earlier snapshot in history keeps serving.
 *
 * Remaining behavior (M7 rules preserved):
 * - Inject only at step 1 (before the conversation starts):
 *   steps later than 1 reuse the turn's context;
 * - The decision is SPREAD, never reconstructed: `startsRequestSeries` and any
 *   future fields survive our append;
 * - Dedup cache is (project, session, query-hash) keyed and LRU-capped, so
 *   identical queries in different sessions each get their own recall;
 * - The block is delimited, marked fallible and subordinate to current user
 *   instructions, and attributed with the plugin's declared source kind plus
 *   the harness `snapshot` context form; an unchanged repeat turn is not
 *   re-admitted (unchanged-snapshot gate), a changed one re-admits by
 *   re-emitting the newest state;
 * - The search query comes ONLY from the last verified direct-human user
 *   message; harness runtime-context snapshots and injected producer context
 *   that follow it are skipped, not refused;
 * - Memories from the current session are never injected back (self-echo guard);
 * - Successful injection bumps access counts;
 * - Search timeout/failure → skip injection, never block the turn;
 * - Plugin stacking cap counts OUR source kind among the proposed messages.
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { UserMessage } from "@deepseek-ai/dsh-llm";
import { renderRecallBlock } from "./recall.js";
import type { RecallService } from "./recall.js";
import { createRecallContextMessage, isInjectedContextUserSource } from "./compat-v02.js";

type OperationalHitPayload = { id: string; kind: string; content: string; confidence: number };

export interface InjectController {
  enabled(): boolean;
  maxHits: number;
  /** Character cap for the injection block (prevents a single injection from flooding the context) */
  maxChars?: number;
  debug?: boolean;
  /** Cap of dsh-self-improved blocks already proposed in this step (0 = no cap) */
  maxInjectPerTurn?: number;
  /** Called with the ids of memories actually injected (access tracking; host wires store.recordAccess) */
  onInjected?: (ids: string[]) => void;
  /** Project key resolution from the pre-step payload (cwd/workspace-based scoping) */
  projectKeyOf?: (agent: unknown) => string;
  /** Session id of the current conversation for cache scoping + self-echo guard */
  sessionIdOf?: (agent: unknown) => string;
  /**
   * Operational-recall lane (independent, separately fenced + capped;
   * disabled/absent = behavior exactly as before). Its own enable gate, result
   * cap, char cap and confidence floor; trusted recall is never touched.
   */
  operational?: {
    enabled(): boolean;
    maxResults: number;
    maxChars: number;
    confidenceFloor: number;
  };
}

const CACHE_MAX = 128;

/**
 * Current request text for retrieval. ONLY the last DIRECT-HUMAN user-role
 * message is eligible and only when its provenance verifies as human
 * (`source.kind === "user"`): an earlier genuine message never lends
 * authority to a later coordinator/relay/tool turn, and a user-role message
 * with missing provenance is untrusted — rc.2 UserMessage carries a REQUIRED
 * source, so absent provenance is malformed, not implicit human input.
 *
 * Two producer-context exceptions are SKIPPED (scanning continues backward),
 * because they are not requests at all and may legitimately sit AFTER the
 * genuine turn inside the same pre-step decision:
 * - `kind: "runtime-context"` — the harness agent-loop appends its own
 *   runtime-context snapshot message (`[...claimed, context]`, see
 *   dsh-agent-loop preStep) as the LAST decision message; refusing on it
 *   would silently skip recall on every turn whose dynamic context changed.
 * - injected-context shapes ({@link isInjectedContextUserSource}): our own
 *   recalled snapshots and legacy plugin/injection kinds.
 * Any other (unknown) producer kind on the last user-role message still
 * refuses the step: observed authority must never silently widen.
 *
 * Known rc.2 limitation (documented here rather than papered over): the
 * SubAgent service admits model-authored delegation prompts with
 * `source: { kind: "user" }` (dsh-subagent submitMaterialized), so kind alone
 * cannot distinguish the delegating coordinator's model-authored task brief
 * from direct human input. For the retrieval-query path this is intentional
 * (the child agent works from that task and benefits from project recall);
 * direct-human AUTHORITY for extraction is anchored separately
 * (capture.ts isDelegatedHeader + Phase B request-header provenance).
 */
export function lastUserText(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as { role?: unknown; source?: unknown; content?: unknown } | null;
    if (!msg || msg.role !== "user") continue;
    const src = msg.source as { kind?: unknown } | undefined;
    if (src === undefined || src === null) return "";
    const kind = src.kind;
    if (kind === "user") return textOfContent(msg.content);
    if (kind === "runtime-context" || isInjectedContextUserSource(src)) continue;
    return "";
  }
  return "";
}

export function textOfContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("\n").trim();
  }
  return "";
}

export function installRecallInjection(ctx: Context, recall: RecallService, controller: InjectController): void {
  // LRU-ish dedup cache: key = (project, session, hash(query)); holds the
  // trusted rendered block ONLY (the operational lane is recomputed fresh so
  // runtime revocations take effect on the next identical query).
  const injectedCache = new Map<string, string>();
  // Last ADMISSION record per query cache key: the exact rendered block this
  // plugin last had admitted into the step decision for that
  // (project, session, query). rc.2 admits every pre-step decision message as
  // a durable `user/message` event (dsh-agent-loop step()), and no rc.2
  // consumer prunes earlier producer snapshots from derived history, so
  // re-admitting an UNCHANGED snapshot on a repeated identical turn
  // accumulated duplicate recall in the model-visible request forever — the
  // documented "later snapshot supersedes earlier one" presentation contract
  // is not enforced by rc.2 request assembly. Compare with the harness's own
  // RuntimeContextProjection, which emits its snapshot ONLY when the rendered
  // text changed; this plugin now applies the same discipline: skip the
  // admission when the rendered block is unchanged (the earlier snapshot
  // already carries that state), re-admit when it changed (correction,
  // forget, expiry, or an operational-fence update), and never admit on the
  // first absent state change either. Restart clears the gate, so the first
  // post-restart repeat re-admits at most one (bounded) duplicate.
  const admittedBlock = new Map<string, string>();
  const onInjected = controller.onInjected;

  const teardown = typeof ctx.effect === "function"
    ? ctx.effect(() => {
        return () => { injectedCache.clear(); };
      }, "recall injection teardown")
    : null;
  if (teardown === null) {
    // Minimal hosts without effect support (test doubles): the cache clears on every install.
  }

  ctx.on(
    "agent/pre-step",
    async (payload: { agent: Agent; messages: UserMessage[]; step: number; signal: AbortSignal }, next: () => Promise<PreStepDecision>) => {
      const decision = await next();
      if (decision.kind === "reject" || payload.signal?.aborted) return decision;

      // Refresh/clear the scoped context once per turn; later tool steps reuse it.
      if (payload.step !== 1) return decision;
      if (!controller.enabled()) return decision;

      // Use the last user message among the proposed messages as the search query
      const messages = decision.kind === "enter" ? decision.messages : [];
      const query = lastUserText(messages);
      if (controller.debug) console.log("[dsh-self-improved] pre-step query:", JSON.stringify(query.slice(0, 80)), "step:", payload.step);
      if (!query) return decision;

      // Guard: never stack memory blocks on top of a step that already carries several plugin injections
      const cap = controller.maxInjectPerTurn ?? 0;
      if (cap > 0 && messages.filter(countOwnBlocks).length >= cap) {
        if (controller.debug) console.log("[dsh-self-improved] injection skipped: plugin block cap reached");
        return decision;
      }

      const sessionId = (controller.sessionIdOf?.(payload.agent) ?? payload.agent?.id ?? "") || "";
      // DEFAULT PROJECT ISOLATION: automatic recall always carries a project key,
      // including the literal 'default'. null never means "unscoped automatic
      // recall" — cross-project leakage is impossible at the query boundary.
      const projectKey = (controller.projectKeyOf?.(payload.agent) || "default");
      const cacheKey = `${projectKey}:${sessionId || "no-session"}:${hashText(query)}`;
      // Trusted lane result is cached per (project, session, query); the
      // operational lane ALWAYS recomputes so revocation/expiry/pause are
      // visible on the very next identical query. A repeat turn whose rendered
      // block CHANGED re-admits it as a newer producer snapshot (the newest
      // copy arrives closest to the live request); an unchanged block is not
      // re-admitted (see the unchanged-snapshot gate — rc.2 request assembly
      // nowhere prunes earlier producer snapshots from derived history).
      const trustedCached = injectedCache.has(cacheKey);
      let trustedBlock = trustedCached ? injectedCache.get(cacheKey) ?? "" : "";
      let trustedHits: Array<{ id: string; kind: string; content: string; importance: number; score: number }> = [];
      if (!trustedCached) {
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
        if (controller.debug) console.log("[dsh-self-improved] recall hits:", trustedHits.length);

        trustedHits = hits;
        trustedBlock = renderRecallBlock(trustedHits, controller.maxHits);
        if (controller.maxChars && trustedBlock.length > controller.maxChars) {
          // Trusted char cap: a still-oversized trusted block ends up empty
          // instead of flooding the context.
          const capChars = controller.maxChars;
          while (trustedBlock.length > capChars && trustedHits.length > 1) {
            trustedHits = trustedHits.slice(0, -1);
            trustedBlock = renderRecallBlock(trustedHits, controller.maxHits);
          }
          if (trustedBlock.length > capChars) trustedBlock = "";
        }
      }

      // Operational lane runs AFTER the trusted lane, with its OWN
      // caps/enable gate. Fails soft (searchOperational never throws).
      let opsForRender: OperationalHitPayload[] = [];
      let opFence = "";
      const renderOpFence = (ops: OperationalHitPayload[], maxResults: number): string =>
        renderRecallBlock([], controller.maxHits, undefined, { hits: ops, maxResults });
      if (controller.operational?.enabled()) {
        const ops = recall.searchOperational(query, {
          projectId: projectKey,
          excludeSessionId: sessionId || undefined,
          maxResults: controller.operational.maxResults,
          confidenceFloor: controller.operational.confidenceFloor,
        });
        opsForRender = ops.map((h) => ({ id: h.id, kind: h.kind, content: h.content, confidence: h.confidence }));
        opFence = renderOpFence(opsForRender, controller.operational.maxResults);
        // Independent operational cap (declared maxChars now enforced): drop the
        // weakest operational hits one by one; a still-oversized fence drops
        // whole. The trusted block is never touched here.
        const opCap = controller.operational.maxChars;
        while (opFence.length > opCap && opsForRender.length > 1) {
          opsForRender = opsForRender.slice(0, -1);
          opFence = renderOpFence(opsForRender, controller.operational.maxResults);
        }
        if (opFence.length > opCap) {
          opFence = "";
          opsForRender = [];
        }
      }

      let block = trustedBlock && opFence ? `${trustedBlock}\n${opFence}` : trustedBlock || opFence;
      if (controller.maxChars) {
        // Overall combined cap: drop the weakest OPERATIONAL hits first, then
        // trusted hits (only possible on the fresh trusted path; a cached
        // trusted block is already within its own cap).
        const capChars = controller.maxChars;
        while (block.length > capChars && opsForRender.length > 0) {
          opsForRender = opsForRender.slice(0, -1);
          opFence = opsForRender.length > 0 ? renderOpFence(opsForRender, controller.operational!.maxResults) : "";
          block = trustedBlock && opFence ? `${trustedBlock}\n${opFence}` : trustedBlock || opFence;
        }
        if (block.length > capChars) {
          if (!trustedCached) {
            // Shrink by dropping the weakest contextual hits (rank order) instead of slicing
            // mid-text, which would leave the wrapper tags unbalanced.
            while (block.length > capChars && trustedHits.length > 1) {
              trustedHits = trustedHits.slice(0, -1);
              trustedBlock = renderRecallBlock(trustedHits, controller.maxHits);
              block = trustedBlock && opFence ? `${trustedBlock}\n${opFence}` : trustedBlock || opFence;
            }
          } else {
            // Cached trusted block cannot be re-shrunk (no hits at hand); the
            // operational fence already shrunk — drop it whole if still over.
            opFence = "";
            opsForRender = [];
            block = trustedBlock;
          }
        }
        if (block.length > capChars) block = "";
      }
      if (!block) return decision;

      // UNCHANGED-SNAPSHOT GATE (rc.2 accumulation fix): a repeated identical
      // turn whose rendered block equals the last admitted one for this query
      // must not append a second identical durable snapshot — the earlier one
      // is already in history and nothing prunes it. A changed snapshot
      // (verified content above) still re-admits below.
      if (admittedBlock.get(cacheKey) === block) {
        if (controller.debug) console.log("[dsh-self-improved] injection unchanged since last admission; snapshot not duplicated");
        return decision;
      }

      // Cache (LRU-cap: evict the oldest, never wipe fresh entries wholesale) —
      // trusted block only, AFTER any combined-cap shrink, so the next identical
      // turn replays exactly this trusted text.
      if (!trustedCached) {
        while (injectedCache.size >= CACHE_MAX) {
          const oldest = injectedCache.keys().next().value;
          if (oldest === undefined) break;
          injectedCache.delete(oldest);
        }
        injectedCache.set(cacheKey, trustedBlock);
      }

      // Access tracking: only hits actually rendered into the block (after char
      // trimming) count as recall access; dropped hits were never shown.
      if (onInjected) {
        const ids = [
          ...(trustedCached ? [] : trustedBlock ? trustedHits.map((h) => h.id) : []),
          ...opsForRender.map((h) => h.id),
        ];
        if (ids.length > 0) onInjected(ids);
      }

      // ADMISSION: spread the decision and append the attributed recall
      // message; `startsRequestSeries` (and any future decision fields) are
      // preserved verbatim.
      if (decision.kind === "enter") {
        // Record the admission BEFORE returning, so a subsequent identical
        // turn is recognized as unchanged (see the gate above). Same
        // LRU-cap discipline as the trusted cache.
        while (admittedBlock.size >= CACHE_MAX) {
          const oldestAdmitted = admittedBlock.keys().next().value;
          if (oldestAdmitted === undefined) break;
          admittedBlock.delete(oldestAdmitted);
        }
        admittedBlock.set(cacheKey, block);
        // SPREAD, never reconstruct: extension fields beyond the documented
        // union keep flowing (verified by scripts/test-phase-a.mjs).
        return {
          ...decision,
          messages: [...decision.messages, createRecallContextMessage(block)],
        };
      }
      return decision;
    },
    { prepend: true },
  );

}

function countOwnBlocks(message: unknown): boolean {
  // Stacking guard counts every injected-context user message (ours and
  // legacy plugin kinds so pre-migration turns are not double-counted).
  const m = message as { role?: unknown; source?: unknown } | null | undefined;
  return !!m && m.role === "user" && isInjectedContextUserSource(m.source);
}

function hashText(text: string): string {
  let hash = 0;
  for (let i = text.length - 1; i >= 0; i--) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  return String(hash);
}
