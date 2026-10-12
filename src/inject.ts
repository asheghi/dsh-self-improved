/**
 * Recall injection module (Phase A rc.2 adapter + Phase B revocation fence):
 * recall is admitted through the `agent/pre-step` waterfall by RETURNING a
 * memory-tagged message inside the step decision. This is the supported,
 * logged admission path with correct timing — the returned decision's messages
 * are exactly what the step admits and the harness logs; dynamic-context/
 * system-prompt registries avoid this adapter because prompting assembly/
 * pre-step ordering made them mistimed for the first request
 * (MIGRATION-V0.2.md §recall timing). Because every admitted decision message
 * becomes a durable `user/message` event and rc.2 request assembly does not
 * prune earlier producer snapshots, the adapter applies emit-on-change
 * discipline: a repeat turn re-admits only when the rendered recall changed,
 * otherwise the earlier snapshot in history keeps serving.
 *
 * Phase B revocation fence (MIGRATION-V0.2.md "trusted recall cache" defect):
 * the previously UNFENCED query-by-session rendered cache replayed stale
 * recall after a correction/forget/pause/expiry raced an identical query.
 * The cache is now fenced by TWO durable snapshots and a final gate:
 * - a REAL monotonic memory revision (`MemoryStore.getMemoryRevision()`,
 *   SQLite-backed, bumped in the same transaction as every recall-affecting
 *   mutation); a cache entry may be replayed ONLY while the revision and the
 *   eligibility-policy fingerprint both measure unchanged, and the revision
 *   is re-probed immediately BEFORE the native logged admission, so a
 *   mutation that commits between the search and the admission is refused —
 *   fail closed, with no other decision fields, history, or attribution
 *   touched;
 * - when the revision provider is unwired, threw, or reported a NON-MONOTONIC
 *   value (e.g. a recreated store), the adapter FAILS CLOSED: no replay from
 *   cache, and a fresh current-state search decides each turn. An absent or
 *   unreliable revision is never substituted by a fake value as durability
 *   proof.
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
 * - A paused (disabled) controller refuses late admission after ANY await
 *   (search, requery, or right before admission): a pause that flips during
 *   retrieval can never admit context that was retrieved before the pause;
 * - Memories from the current session are never injected back (self-echo guard);
 * - Access-count attribution happens ONLY on actual admission, after all
 *   fences passed (a refused generation leaves no side effect to roll back);
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
  /** Called with the ids of memories actually injected (access tracking; host
   *  wires store.recordAccess) plus, when known, the session and query that
   *  produced them so a bounded delivery ledger can explain them. */
  onInjected?: (ids: string[], context?: { sessionId?: string; query?: string }) => void;
  /** Project key resolution from the pre-step payload (cwd/workspace-based scoping) */
  projectKeyOf?: (agent: unknown) => string;
  /** Session id of the current conversation for cache scoping + self-echo guard */
  sessionIdOf?: (agent: unknown) => string;
  /**
   * Phase B revocation fence: the REAL monotonic durable memory revision
   * (`MemoryStore.getMemoryRevision()` — SQLite-backed, strictly increasing,
   * bumped in the SAME transaction as memory insert / explicit correction /
   * forget / status transition / row deletion / journal source revocation /
   * external import, and NEVER by popularity reads). Ownership of the store
   * contract is the storage lane's; this adapter only READS it.
   *
   * Semantics, in force here:
   * - wired and healthy → cached rendered recall may be replayed for an
   *   identical (project, session, query) ONLY while the revision and the
   *   eligibility-policy fingerprint measure unchanged, and the revision is
   *   re-probed immediately before admission;
   * - unwired → fail closed: every admission is decided by a fresh
   *   current-state search; no replay, no fence claim, no fake durability;
   * - throwing/ill-shaped read, or a NON-MONOTONIC value (recreated store):
   *   no admission that turn (the revision contract is violated/unprovable).
   */
  memoryRevision?: () => number;
  /**
   * Optional eligibility-policy snapshot: must change whenever a
   * recall-affecting POLICY changes that a row mutation cannot express
   * (recall strategy, BM25 thresholds/margins, importance floor, per-lane
   * caps' origins). The host composes it from live config; when missing, the
   * fingerprint covers only this adapter's own cap/gates (documented
   * limitation, never a false claim of full policy coverage).
   */
  eligibilityPolicyFingerprint?: () => string;
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

/** One trusted-lane rendered result, retained ONLY under a proven fence. */
interface RecallCacheEntry {
  /** Rendered trusted block (already within the trusted char cap at save time). */
  trustedBlock: string;
  /** Eligibility-policy snapshot of the turn that produced the block. */
  policyFp: string;
  /**
   * Durable revision fence the block was rendered under. `null` = the revision
   * could not prove stability at that turn (unwired/erratic): such an entry is
   * NEVER replayed.
   */
  revision: number | null;
}

/**
 * Probed durable revision: a finite non-negative integer when the provider is
 * wired AND read reliably; null otherwise (unwired, threw, or ill-shaped —
 * never a fabricated substitute value).
 */
type RevisionRead = number | null;

/** Trusted-lane search result shape (subset the adapter renders/bumps). */
interface TrustedHit {
  id: string;
  kind: string;
  content: string;
  importance: number;
  score: number;
}

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
  // Fenced recall cache: key = (project, session, hash(query)); holds the
  // trusted rendered block ONLY (the operational lane is recomputed fresh so
  // runtime revocations take effect on the next identical query). An entry is
  // replayable ONLY under the Phase B fence: a proven-unchanged durable
  // revision + eligibility-policy snapshot (see InjectController).
  const injectedCache = new Map<string, RecallCacheEntry>();
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
  // forget, expiry, pause re-arm, or an operational-fence update), and never
  // admit on the first absent state change either. Restart clears the gate,
  // so the first post-restart repeat re-admits at most one (bounded) duplicate.
  const admittedBlock = new Map<string, string>();
  // Highest durable revision ever observed by THIS install. The revision
  // contract is monotonic; a smaller value can only mean a recreated/replaced
  // backend mid-run, which makes every fence proof void (fail closed).
  let highestRevisionSeen: number | null = null;
  const onInjected = controller.onInjected;
  const revisionWired = typeof controller.memoryRevision === "function";

  const debug = (message: string, ...extra: unknown[]): void => {
    if (controller.debug) console.log("[dsh-self-improved]", message, ...extra);
  };

  /**
   * Probe the durable revision. A provider that was wired by the host but
   * throws or returns a non-integer/negative value is UNRELIABLE, not "zero":
   * it must never be silently substituted by a fake token.
   */
  const readRevision = (): RevisionRead => {
    if (typeof controller.memoryRevision !== "function") return null;
    try {
      const raw = controller.memoryRevision();
      if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0 && raw <= Number.MAX_SAFE_INTEGER) {
        return raw;
      }
      return null;
    } catch {
      return null;
    }
  };

  /** True when `n` respects the monotonic revision contract; records it otherwise. */
  const claimMonotonic = (n: number): boolean => {
    if (highestRevisionSeen !== null && n < highestRevisionSeen) return false;
    highestRevisionSeen = highestRevisionSeen === null ? n : Math.max(highestRevisionSeen, n);
    return true;
  };

  /**
   * Eligibility-policy snapshot. The host-provided fingerprint (recall
   * strategy/thresholds/floors) must change with any policy the store
   * revision cannot express; this adapter's own cap/gate values are always
   * included. Returns null when the policy state cannot be trusted/read —
   * a null fingerprint disables replay (fail closed).
   */
  const buildPolicyFp = (): string | null => {
    let hostPart = "";
    const explicit = controller.eligibilityPolicyFingerprint;
    if (typeof explicit === "function") {
      try {
        const value = explicit();
        hostPart = value == null ? "" : String(value);
      } catch {
        return null;
      }
    }
    const op = controller.operational;
    const own = [
      controller.maxHits | 0,
      controller.maxChars ?? 0,
      controller.maxInjectPerTurn ?? 0,
      op ? `${op.enabled() ? "op1" : "op0"}|${op.maxResults}|${op.maxChars}|${op.confidenceFloor}` : "op-off",
    ].join("|");
    return `${own}#${hostPart}`;
  };

  const teardown = typeof ctx.effect === "function"
    ? ctx.effect(() => {
        return () => {
          injectedCache.clear();
          admittedBlock.clear();
          highestRevisionSeen = null;
        };
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
        debug("injection skipped: plugin block cap reached");
        return decision;
      }

      const sessionId = (controller.sessionIdOf?.(payload.agent) ?? payload.agent?.id ?? "") || "";
      // DEFAULT PROJECT ISOLATION: automatic recall always carries a project key,
      // including the literal 'default'. null never means "unscoped automatic
      // recall" — cross-project leakage is impossible at the query boundary.
      const projectKey = (controller.projectKeyOf?.(payload.agent) || "default");
      const cacheKey = `${projectKey}:${sessionId || "no-session"}:${hashText(query)}`;

      // Phase B fence snapshots, taken BEFORE any await this turn:
      const policyFp = buildPolicyFp();
      const revisionAtTurn = readRevision();

      // ── Phase 1: resolve the trusted lane results under the fence ──
      // Two outcomes: (a) a fenced REPLAY of a previously rendered block —
      // allowed only while the durable revision AND policy snapshot both
      // measure unchanged; (b) a FRESH current-state search — the only path
      // when the fence cannot prove stability (unwired revision, policy
      // change, new query). The operational lane never uses the cache.
      let trustedFromCache = false;
      let trustedHits: TrustedHit[] = [];
      let trustedBlock = "";
      // Set only when the adapter can PROVE the state the results describe:
      // null = fresh-path decision with no durability claim (never replayed).
      let stableRevision: number | null = null;

      const cached = injectedCache.get(cacheKey);
      const canReplay = ((): boolean => {
        // Fenced replay REQUIRES proof, decided in this exact order:
        if (!revisionWired || cached === undefined) return false;
        if (cached.revision === null) return false; // entry rendered without a proven fence
        if (policyFp === null || cached.policyFp !== policyFp) return false;
        if (revisionAtTurn === null || revisionAtTurn !== cached.revision) return false;
        return claimMonotonic(revisionAtTurn);
      })();
      if (canReplay && cached !== undefined) {
        debug("fence passed: replaying cached recall for identical query (revision+policy unchanged)");
        trustedFromCache = true;
        trustedBlock = cached.trustedBlock;
        stableRevision = cached.revision;
      } else {
        // FRESH PATH — the current admission is computed from current store state.
        const searchOptions = {
          maxResults: controller.maxHits,
          projectId: projectKey,
          excludeSessionId: sessionId || undefined,
        };
        if (revisionWired) {
          // The revision source IS wired but this turn cannot read it
          // (threw/ill-shaped): fail closed — no admission without a fence,
          // and never a fabricated value.
          if (revisionAtTurn === null) {
            debug("memory revision read failed at turn start; refusing this admission");
            return decision;
          }
          // A revision SMALLER than one already observed violates the
          // monotonic contract (recreated backend); durability is unprovable.
          if (!claimMonotonic(revisionAtTurn)) {
            debug("memory revision REGRESSED (non-monotonic); refusing this admission");
            return decision;
          }
        }
        // FENCE THE ASYNC WINDOW: a recall-affecting mutation (insert /
        // correction / forget / status change / source revocation / import)
        // that commits while the search runs makes its results stale. Probe
        // the revision after every search, requery BOUNDED times against the
        // newer state, and fail closed if the window keeps moving.
        let hits: TrustedHit[] = [];
        if (revisionWired) {
          let boundary = revisionAtTurn;
          for (let requery = 0; ; requery++) {
            hits = await recall.search(query, searchOptions);
            // Lifecycle + revocation re-check AFTER each async search, BEFORE
            // any use: a pause during retrieval never admits late context.
            if (payload.signal?.aborted) {
              debug("injection aborted after recall; skipping");
              return decision;
            }
            if (!controller.enabled()) {
              debug("controller paused during retrieval; refusing late admission");
              return decision;
            }
            const revisionAfterSearch = readRevision();
            // The revision source degraded mid-window: no fence, no admission.
            if (revisionAfterSearch === null) {
              debug("memory revision read failed during search; refusing this admission");
              return decision;
            }
            if (!claimMonotonic(revisionAfterSearch)) {
              debug("memory revision REGRESSED during search; refusing this admission");
              return decision;
            }
            if (revisionAfterSearch === boundary) {
              // The search ran entirely inside one durable revision: fenced.
              break;
            }
            if (requery >= 2) {
              debug("revision kept changing during search; failing closed");
              return decision;
            }
            boundary = revisionAfterSearch; // newer state: requery against it
            debug(`revision changed during search; requerying against the newer state (${requery + 1}/2)`);
          }
          stableRevision = boundary;
          trustedHits = hits;
        } else {
          // UNWIRED REVISION: fail closed to the fresh current-state path with
          // NO fence and NO replay — `stableRevision` stays null and the
          // decision rests entirely on what the search reads right now.
          hits = await recall.search(query, searchOptions);
          if (payload.signal?.aborted) {
            debug("injection aborted after recall; skipping");
            return decision;
          }
          if (!controller.enabled()) {
            debug("controller paused during retrieval; refusing late admission");
            return decision;
          }
          trustedHits = hits;
        }
        trustedBlock = renderRecallBlock(trustedHits, controller.maxHits);
        debug("recall hits:", trustedHits.length, "rendered:", trustedBlock.length);
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
          if (!trustedFromCache) {
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

      // ── Phase B FINAL FENCE: the last checks IMMEDIATELY BEFORE the native
      // logged admission (account-and-correction / forget / pause races):
      // every refused generation must be side-effect-free — the decision
      // fields, history and attribution are returned untouched.
      if (payload.signal?.aborted) {
        debug("injection aborted before admission; skipping");
        return decision;
      }
      if (!controller.enabled()) {
        debug("controller paused right before admission; refusing");
        return decision;
      }
      if (stableRevision !== null) {
        const revisionFinal = readRevision();
        if (revisionFinal === null) {
          debug("memory revision read failed before admission; refusing");
          return decision;
        }
        if (!claimMonotonic(revisionFinal)) {
          debug("memory revision REGRESSED before admission; refusing");
          return decision;
        }
        if (revisionFinal !== stableRevision) {
          // A correction/forget/consent mutation committed between the state
          // the results were computed against and the admission moment: the
          // eligibility of the rendered content is no longer proven. Fail
          // closed (never admit possibly-revoked material; never replay).
          debug("memory revision moved between search and admission; refusing");
          return decision;
        }
      }

      // UNCHANGED-SNAPSHOT GATE (rc.2 accumulation fix): a repeated identical
      // turn whose rendered block equals the last admitted one for this query
      // must not append a second identical durable snapshot — the earlier one
      // is already in history and nothing prunes it. A changed snapshot
      // (verified content above) still re-admits below.
      if (admittedBlock.get(cacheKey) === block) {
        debug("injection unchanged since last admission; snapshot not duplicated");
        return decision;
      }

      // Cache (LRU-cap: evict the oldest, never wipe fresh entries wholesale) —
      // trusted block only, AFTER any combined-cap shrink, so the next identical
      // turn replays exactly this trusted text. Reusability is fenced: an entry
      // rendered without a proven-fence revision is stored with `null` and can
      // never be replayed (fail closed on unwired/unreliable revisions).
      if (!trustedFromCache) {
        while (injectedCache.size >= CACHE_MAX) {
          const oldest = injectedCache.keys().next().value;
          if (oldest === undefined) break;
          injectedCache.delete(oldest);
        }
        injectedCache.set(cacheKey, {
          trustedBlock,
          policyFp: policyFp ?? "",
          revision: stableRevision,
        });
      }

      // Access tracking: only hits actually rendered into the block (after char
      // trimming) count as recall access; dropped hits were never shown, and
      // refused generations never leave this (or any) side effect to roll back.
      if (onInjected) {
        const ids = [
          ...(trustedFromCache ? [] : trustedBlock ? trustedHits.map((h) => h.id) : []),
          ...opsForRender.map((h) => h.id),
        ];
        if (ids.length > 0) onInjected(ids, { sessionId, query });
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
