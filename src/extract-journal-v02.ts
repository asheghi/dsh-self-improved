/**
 * Phase B journal extract worker lane (MIGRATION-PHASE-B-EXTRACT.md, per
 * MIGRATION-PHASE-B-EXTRACT-DESIGN.md): the durable claim → all-bounded-chunks
 * → validated-terminal-verdict → same-tx-commit ack loop over ONE
 * MemoryJournalV02 instance through the documented JournalExtractorSeam
 * (src/capture.ts — CONTRACT only, untouched by this lane).
 *
 * REPLACEMENT CONTRACT: the runtime drives THIS worker at every extraction
 * drive point (flush, maintenance timer, review drains, startup backfill).
 * The legacy `Extractor.pump()`/`advanceProcessed` path is retired at those
 * lanes: no full-range ack, no head+tail prompt rendering with middle
 * omission, no `fallbackOnBadJson` fabricated summary, and no
 * `provenance:"user"` extract-write shortcut (the legacy lane's documented
 * divergence at extract.ts:273 is not copied).
 *
 * CORE RULES (each enforced below, never implied):
 * - Every consumed coordinate requires ONE typed verdict on THAT chunk's
 *   exact persisted evidence, delivered through `seam.commitChunkResult`
 *   (which IS the journal's single transaction: candidate inserts +
 *   candidate_key dedup mapping + chunk ack + consumed-range recompute +
 *   last-chunk job-done, all on the store's ONE connection through
 *   insertMemoryInTx). The worker never writes candidates,
 *   `journal_sources.consumed` flags or chunk acks by any other path (no raw
 *   sqlite, no `store.advanceProcessed`).
 * - A validated terminal outcome is the ONLY acked state: a definitive
 *   `{"memories":[]}` / no-eligible-events verdict, or ≥1 candidate that
 *   passed every deterministic gate — over a `stop` finish or an explicitly
 *   reported unavailable source. Anything else (malformed / aborted /
 *   provider-truncated / tool-call finish / unknown-or-error finish / missing
 *   / revoked evidence) is `retryable` (no ack) or a verbatim
 *   `source-unavailable` relay — bounded by the journal's own deterministic
 *   retry budget (backoff + max_attempts), never a fabricated ack.
 * - Trust only ever comes from a verbatim quote inside the retained
 *   (minimized) journal text every future reviewer sees. The provider JSON
 *   contract carries NO provenance/confirmed/permissions field: every commit
 *   candidate is `provenance:"derived"` (review-required and NOT injectable —
 *   INJECTABLE_PROVENANCES is user/persona only), `source:"llm-extract"`
 *   (`"llm-extract-pasted"` when paste-demoted). No `pinBaseline` is ever
 *   called from this lane.
 * - The pump never runs inside a caller transaction: every seam call
 *   opens/commits its own transaction on the single store connection; the
 *   LLM await never spans a held tx.
 * - Leases are taken UP FRONT (no renew-lease API exists on the verified
 *   journal contract): baseline = max(60s, 32 ×(perCall+5s)); the journal
 *   atomically extends it to pendingChunks ×(perCall+5s) +5s before claiming.
 *   A job whose bounded chunk work outlives that lease hits a typed
 *   JournalContractError("lease-expired") at one commit — the claim is then
 *   durably requeued with every acked prefix intact and the next pump
 *   resumes at the first unacked chunk (candidate_key idempotence prevents
 *   duplicate memories). The worker never retries the commit itself.
 * - Per-request routing/model/max-tokens resolve LIVE from the volatile
 *   config view at each call (explicit route, never guessed); lane
 *   cancellation is AbortSignal.timeout(settings.timeoutMs) ⊕ deadline and a
 *   pre-aborted lane never opens a provider stream at all. Once the owned
 *   journal connection reports closed, the pump stops without starting any
 *   further work (no active work after the owned resource is closed).
 * - PENDING-DRAIN CONTRACT (MIGRATION-PHASE-B-PENDING-DRAIN.md, the repair of
 *   the runtime-review MIN_PUMP_INTERVAL_MS defect): a pump request in-window
 *   or overlapping an in-flight round is never silently dropped anymore. It
 *   is coalesced into ONE bounded, worker-owned pending drain — the trailing
 *   round of the in-flight chain, or ONE explicit one-shot timer armed at the
 *   throttle window's end (no busy polls, no sleeps, no adhoc events). The
 *   30s immediate-round gate is UNCHANGED storm protection and the journal's
 *   retry_after_at/backoff budget is untouched; durable accepted ranges
 *   therefore eventually drain inside the process without another external
 *   flush, at most one extra claim round per coalesced chain. The close hook
 *   `dispose()` (plus an already-aborted deadline signal) stops ALL late
 *   work after pause/close: no timer fire, no trailing round, no pump entry
 *   ever claims again; durable accepted work is recovered by recoverStartup.
 */
import type { StreamChunk, GenerateOptions } from "@deepseek-ai/dsh-llm";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { evaluateTerminalFinish, type TerminalFinishReason } from "./compat-v02.js";
import {
  EXTRACT_SYSTEM_PROMPT,
  looksTaskLocal,
  looksLikeInstruction,
  isPasteSuspiciousSlice,
  durableScopeForDraft,
} from "./extract.js";
import { findNeighbors, classify, DEFAULT_DEDUPE_SETTINGS, type DedupeSettings } from "./dedupe.js";
import type {
  MemoryStore,
  MemoryProvenance,
  MemoryKind,
} from "./storage.js";
import type {
  JournalCandidateInput,
  JournalChunkCommitReport,
  JournalChunkEvidence,
  JournalEvidenceEvent,
  JournalClaim,
  JournalVerdict,
} from "./memory-journal-v02.js";
import type { JournalExtractorSeam } from "./capture.js";

// ---------------------------------------------------------------------------
// Parsed draft shape — principal-compatible re-implementation of the legacy
// extract.ts parseMemories per-item validation over the durable chunk
// (extract.ts is NOT modified by this lane; the parity is pinned by tests).
// ---------------------------------------------------------------------------

interface ParsedExtractDraft {
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  evidence: string;
  sourceRole: "user" | "assistant";
  scope: "global" | "project";
}

/** kind remains storage-valid for back-compat, but the extractor never produces it. */
const EXTRACTABLE_KINDS: ReadonlySet<string> = new Set(["fact", "preference", "event"]);

/** Exact legacy structural sensitive-content gate (extract.ts SENSITIVE_RE). */
const SENSITIVE_RE = /\b(sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=])\b/i;

/** Identical semantics to the legacy per-item validation; no synthesized items. */
function parseExtractDrafts(text: string): { drafts: ParsedExtractDraft[]; parsedOk: boolean } {
  const json = extractJson(text);
  const drafts: ParsedExtractDraft[] = [];
  let parsedOk = false;
  if (json && typeof json === "object" && Array.isArray((json as { memories?: unknown }).memories)) {
    parsedOk = true;
    for (const item of (json as { memories: unknown[] }).memories) {
      if (!item || typeof item !== "object") continue;
      // Only the documented extraction fields are read; the model JSON
      // contract has no provenance/confirmed/permissions field, so any
      // provider-attested trust claim is structurally ignored (it cannot
      // reach the commit candidate shape).
      const raw = item as {
        kind?: unknown;
        scope?: unknown;
        content?: unknown;
        importance?: unknown;
        confidence?: unknown;
        evidence?: unknown;
        source_role?: unknown;
      };
      const kind = raw.kind as MemoryKind;
      const content = typeof raw.content === "string" ? raw.content.trim() : "";
      const importance = typeof raw.importance === "number" ? Math.round(raw.importance) : 5;
      const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
      const evidence = typeof raw.evidence === "string" ? raw.evidence.trim().slice(0, 160) : "";
      const sourceRole = raw.source_role === "user" ? ("user" as const) : ("assistant" as const);
      const scope = raw.scope === "global" ? ("global" as const) : ("project" as const);
      if (!EXTRACTABLE_KINDS.has(String(kind))) continue;
      if (content.length < 2 || content.length > 500) continue;
      if (SENSITIVE_RE.test(content)) continue;
      drafts.push({
        kind,
        content,
        importance: Math.max(1, Math.min(10, importance)),
        confidence,
        evidence,
        sourceRole,
        scope,
      });
    }
  }
  return { drafts, parsedOk };
}

/** Extracts JSON from model text as best as possible (tolerates code fences and surrounding noise). */
function extractJson(text: string): unknown | null {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidate = (fenced ? fenced[1] : trimmed).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    /* keep trying */
  }
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function normalizedEvidence(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/**
 * Verbatim-evidence gate over the chunk's exact retained evidence events:
 * identical semantics to the legacy isVerbatimUserEvidence, quoted against
 * the JournalEvidenceEvent.text every future reviewer sees — a
 * fabricated-evidence regression is structurally impossible. Returns the
 * FIRST matched event so evidence coordinates persist explicitly.
 */
function matchVerbatimEvidence(
  evidence: string,
  events: JournalEvidenceEvent[],
): JournalEvidenceEvent | null {
  const needle = normalizedEvidence(evidence);
  if (needle.length < 4) return null;
  return events.find((event) => normalizedEvidence(event.text).includes(needle)) ?? null;
}

// ---------------------------------------------------------------------------
// Typed aux LLM call (per-request route; terminal-finish validated)
// ---------------------------------------------------------------------------

/**
 * One aux extraction model call's outcome. NEVER a bare partial string:
 * genuine lane cancellation, provider/transport failures and explicit
 * non-stop terminal finishes are distinct cases (each maps to a DIFFERENT
 * typed verdict).
 */
export type ExtractCallOutcome =
  | { status: "completed"; text: string; finishKind: string; hasFinish: boolean }
  | { status: "signal-aborted"; message: string }
  | { status: "provider-failure"; message: string };

export interface JournalExtractCallLlm {
  (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }): Promise<ExtractCallOutcome>;
}

export interface JournalExtractCallDeps {
  /**
   * The genuine host stream transport (rc.2 contract: adapters honor
   * GenerateOptions.signal; the runtime normalizes adapter failures to a
   * terminal error/aborted finish chunk before the consumer sees them).
   */
  streamChunks: (options: GenerateOptions) => AsyncIterable<StreamChunk>;
  /**
   * LIVE route resolver per request: explicit provider+model, plugin config
   * first, host default-model selection next, fail-loud when unconfigured
   * (NO provider fallback guessing — the MIGRATION-V0.2 rule).
   */
  route: () => { provider: string; model: string };
  /** LIVE per-request output cap (volatile settings take effect per call). */
  maxOutputTokens: () => number;
}

/**
 * Build the typed aux extraction call. Mirrors the legacy makeLlmCall
 * transport (aux one-shot: system slot + identity-free user message with the
 * plugin's declared source kind; NO wire `purpose` — rc.2 reserves
 * compaction|session-title), but blocked terminal finishes are RETURNED,
 * not thrown, so the worker's verdict mapping stays exact
 * (max-tokens vs tool-calls vs unknown-terminal-finish).
 */
export function createJournalExtractCall(deps: JournalExtractCallDeps): JournalExtractCallLlm {
  return async (input): Promise<ExtractCallOutcome> => {
    // Already-aborted lane signal: never open the doomed provider stream.
    input.signal.throwIfAborted();
    let provider: string;
    let model: string;
    try {
      const resolved = deps.route();
      provider = resolved.provider;
      model = resolved.model;
    } catch (error) {
      // Explicit route misconfiguration — not a provider transport event but
      // equally non-committal: bounded retry, no chunk advancement.
      return { status: "provider-failure", message: `route-unresolved: ${shortMessage(error)}` };
    }
    const options: GenerateOptions = {
      messages: [
        createUserMessage({
          content: [{ type: "text", text: input.user }],
          source: { kind: "dsh-self-improved" },
        }),
      ],
      system: input.system,
      maxTokens: deps.maxOutputTokens(),
      provider,
      model,
      signal: input.signal,
    };
    // Evidence identity belongs to our durable journal, NOT the provider
    // request. Binding a native session here enables the runtime's
    // dsh_session_log extension to upload unminimized canonical history,
    // bypassing the privacy/source-cut boundary even with bounded messages.
    // Route and cancellation are explicit; omission is the native contract's
    // supported session-independent auxiliary call, not a fake purpose tag.
    const assembler = new BlockAssembler();
    let finishKind: string | null = null;
    try {
      for await (const chunk of deps.streamChunks(options)) {
        input.signal.throwIfAborted();
        assembler.push(chunk);
        if (chunk.type === "finish") finishKind = chunk.reason.kind;
      }
    } catch (error) {
      // Distinct typed outcomes: genuine lane cancellation versus a provider
      // or transport failure. Both retryable, neither acks a chunk.
      if (input.signal.aborted) return { status: "signal-aborted", message: shortMessage(error) };
      return { status: "provider-failure", message: shortMessage(error) };
    }
    input.signal.throwIfAborted();
    const text = assembler
      .blocks()
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    // An empty completed body is not an unknown-finish catchall case: it
    // stays typed "completed" so the worker maps it to malformed-model-output.
    return { status: "completed", text, finishKind: finishKind ?? "absent", hasFinish: finishKind !== null };
  };
}

function shortMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").slice(0, 200);
}

// ---------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------

/** One round's counters; the runtime logs this shape verbatim. */
export interface JournalExtractPumpResult {
  /** Jobs claimed this round. */
  claimed: number;
  /** Chunks acked this round (validated terminal verdicts only). */
  chunksAcked: number;
  /** Memories committed this round (accepted candidates; derived provenance). */
  memories: number;
  nothingToLearn: number;
  /** Retryable/no-ack verdicts reported (malformed/aborted/truncated/…). */
  retryable: number;
  /** Terminal source-unavailable relays (missing/revoked). */
  sourceUnavailable: number;
  /** Claims released unprocessed (delegated/stale/deadline/iteration-cap). */
  released: number;
  /**
   * Pump requests coalesced into the owned pending drain (MIGRATION-PHASE-B-
   * PENDING-DRAIN.md §3): on a parked in-window/overlapping call exactly the
   * requests that call parked (1); on an immediate/drain round the requests
   * that round SERVED from the coalesced latch. Disabled/close returns 0.
   */
  deferred: number;
  /** Deterministic gate counters across every processed chunk this round. */
  gateCounters: {
    rejectedTaskLocal: number;
    rejectedLowValue: number;
    duplicatesDropped: number;
    conflicts: number;
    demotedPasteSuspicious: number;
  };
  errors: number;
}

export function emptyJournalExtractPump(): JournalExtractPumpResult {
  return {
    claimed: 0,
    chunksAcked: 0,
    memories: 0,
    nothingToLearn: 0,
    retryable: 0,
    sourceUnavailable: 0,
    released: 0,
    deferred: 0,
    gateCounters: {
      rejectedTaskLocal: 0,
      rejectedLowValue: 0,
      duplicatesDropped: 0,
      conflicts: 0,
      demotedPasteSuspicious: 0,
    },
    errors: 0,
  };
}

/** Live settings view (volatile edits take effect at the next pump/chunk). Lives views are property getters. */
export interface JournalExtractSettings {
  /** Master/module gate incl. the shutdown guard — read at call time. */
  readonly enabled: boolean;
  /** Per-chunk LLM timeout (AbortSignal.timeout); runtime schema-bounded. */
  readonly timeoutMs: number;
  /** Importance floor for an accepted candidate (legacy-parity gate). */
  readonly minImportance: number;
  /** Duplicate pre-commit filter gate; undefined ⇒ enabled. */
  readonly dedup?: boolean;
}

/**
 * Owned one-shot timer surface for the coalesced pending-drain kick
 * (MIGRATION-PHASE-B-PENDING-DRAIN.md §3). Tests inject a controlled fake so
 * the window can be fired deterministically; production defaults to a real
 * unref'd setTimeout — the kick timer is the ONLY scheduling mechanism this
 * worker owns (no busy polls, no sleeps, no adhoc events, no requeue loops).
 */
export interface JournalExtractScheduleTimer {
  set(timeoutCallback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const DEFAULT_PUMP_TIMER: JournalExtractScheduleTimer = {
  set: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    // The kick timer must never keep a process alive past teardown.
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

export interface JournalExtractWorkerDeps {
  /** The documented claim/read/commit/release surface over ONE journal. */
  seam: JournalExtractorSeam;
  /**
   * Optional store access for the read-only duplicate pre-commit filter
   * (classify/findNeighbors). Matching duplicates are DROPPED (a later retry
   * converges via journal candidate_key idempotence); a confirmed conflict is
   * kept flagged with conflict-of evidence, as the legacy path stored it.
   */
  store?: MemoryStore;
  dedupeSettings?: DedupeSettings;
  callLlm: JournalExtractCallLlm;
  /** Owned lane deadline signal (shutdown); checked per chunk, ⊕ per-call timeout. */
  deadlineSignal?: AbortSignal;
  settings: JournalExtractSettings;
  log?: (message: string) => void;
  warn?: (message: string) => void;
  /** Injected clock (tests); production defaults to Date.now. */
  nowMs?: () => number;
  /**
   * Injected one-shot timer (tests); production defaults to a real unref'd
   * setTimeout. Backing the coalesced pending-drain kick (§3 of
   * MIGRATION-PHASE-B-PENDING-DRAIN.md).
   */
  timer?: JournalExtractScheduleTimer;
  /** Register timer-started work with the owner's shutdown drain before yielding. */
  onDeferredJob?: (job: Promise<JournalExtractPumpResult>) => void;
}

export interface JournalExtractWorker {
  /**
   * Drive one extraction effort. Immediate-round semantics preserved (30s
   * gate, claim-until-null, single flight); an in-window or overlapping
   * request is coalesced into the owned pending drain and never dropped
   * (MIGRATION-PHASE-B-PENDING-DRAIN.md §3).
   */
  pump(): Promise<JournalExtractPumpResult>;
  /**
   * REQUIRED CLOSE HOOK for the runtime owner to wire (owner34 owns index.ts;
   * documented in MIGRATION-PHASE-B-PENDING-DRAIN.md §5): stop ALL late
   * scheduled work after pause/close — clear the pending-drain kick timer and
   * the coalesced latch so nothing claims after the drained teardown past
   * this point, and pump() becomes a no-op. Durable accepted work not yet
   * drained is recovered by recoverStartup on the next boot. Idempotent; the
   * in-flight round (if any) keeps its own boundary (per-chunk deadline
   * ownership and closed-journal stops own that path — dispose does not
   * abort runs mid-commit).
   */
  dispose(): void;
  /** Explicit awaited flush barrier: join single-flight work, then drain without the background throttle. */
  drain(): Promise<JournalExtractPumpResult>;
}

/**
 * Minimum interval between two IMMEDIATE claim rounds (DSH fires callbacks at
 * multiple flush checkpoints — parity with lib/extract.js MIN_PUMP_INTERVAL_MS
 * storm protection). In-window requests are NOT dropped by this gate anymore:
 * they latch onto ONE coalesced pending drain this worker owns (see pump/§3 of
 * MIGRATION-PHASE-B-PENDING-DRAIN.md).
 */
const MIN_PUMP_INTERVAL_MS = 30_000;

/** Floor for pending-drain timers below the window (a long in-flight round must not drive sub-second recheck polls). */
const KICK_RECHECK_FLOOR_MS = 1_000;

/** Safety cap of inner chunk iterations per job beyond its own chunk plan. */
const CHUNK_ITERATION_SAFETY_CAP = 8;

/**
 * Up-front baseline in coverage units. The journal knows the selected job's
 * pending chunk count inside the claim transaction and extends this baseline
 * with the supplied per-chunk timeout/overhead budget. No renewal is needed.
 * Exceptional suspension beyond that sized lease remains a typed expiry:
 * the acked prefix survives and a later wake resumes the unacked suffix.
 */
const LEASE_CHUNK_CEILING = 32;

/** One round's identical up-front lease for any claim (design §2.1 note). */
function leaseForClaim(perCallTimeoutMs: number): number {
  return Math.max(60_000, LEASE_CHUNK_CEILING * (perCallTimeoutMs + 5_000));
}

export function createJournalExtractWorker(deps: JournalExtractWorkerDeps): JournalExtractWorker {
  const log = deps.log ?? (() => undefined);
  const warn =
    deps.warn ??
    ((message: string) => console.warn("[dsh-self-improved]", message));
  const dedupeSettings = deps.dedupeSettings ?? DEFAULT_DEDUPE_SETTINGS;
  const nowMs = deps.nowMs ?? Date.now;
  const timer = deps.timer ?? DEFAULT_PUMP_TIMER;
  const deadline = deps.deadlineSignal;

  // -- owned pending-drain state (MIGRATION-PHASE-B-PENDING-DRAIN.md §3) -----
  /** A drain chain is in flight — every further request coalesces into it. */
  let roundActive = false;
  let activeRoundPromise: Promise<JournalExtractPumpResult> | undefined;
  /** Coalesced pump requests parked for a (trailing) drain round. */
  let pendingKickCount = 0;
  /** The ONE owned one-shot pending-drain timer, when armed. */
  let kickTimer: unknown = null;
  /** Close hook landed (dispose()/closing via deadline): no late work starts. */
  let closed = false;
  /** Start time of the most recent IMMEDIATE claim round (30s window anchor). */
  let lastPumpAt = 0;

  /**
   * Arm (or re-arm) the ONE owned pending-drain kick timer. Called with no
   * round in flight: the delay is the remaining throttle window (≡1s floor
   * is a recheck for a long in-flight round, never a sub-second poll).
   */
  function scheduleKick(): void {
    if (closed || roundActive || !deps.settings.enabled) return;
    const remaining = lastPumpAt === 0 ? 0 : MIN_PUMP_INTERVAL_MS - (nowMs() - lastPumpAt);
    const delay = remaining > 0 ? remaining : KICK_RECHECK_FLOOR_MS;
    if (kickTimer !== null) {
      timer.clear(kickTimer);
      kickTimer = null;
    }
    kickTimer = timer.set(() => {
      kickTimer = null;
      void drainKick();
    }, delay);
    log(`journal extract: pending drain armed (${delay}ms) for ${pendingKickCount} coalesced request(s)`);
  }

  /**
   * The pending-drain kick fired: consume the coalesced latch exactly once and
   * start ONE bounded chain — or drop the latch when the module is disabled
   * or the owned lane is closing (late work never starts after pause/close;
   * the durable accepted work is recoverStartup's on the next boot).
   */
  async function drainKick(): Promise<void> {
    if (closed) {
      pendingKickCount = 0;
      return;
    }
    if (!deps.settings.enabled) {
      pendingKickCount = 0;
      log("journal extract: pending drain unlatched — extraction module disabled");
      return;
    }
    if (deadline?.aborted) {
      pendingKickCount = 0;
      warn("journal extract: pending drain dropped — owned lane closing; durable accepted work is recoverStartup's");
      return;
    }
    if (roundActive) {
      // The in-flight chain will consume the latch in its trailing step (and
      // re-arm here if it cannot); this is a bounded ≥1s recheck, not a poll.
      scheduleKick();
      return;
    }
    const served = pendingKickCount;
    pendingKickCount = 0;
    const job = beginRound("coalesced-pending-drain", served);
    deps.onDeferredJob?.(job);
    const result = await job;
    log(`journal extract: coalesced pending drain (${JSON.stringify(result)})`);
  }

  /**
   * One single-flight drain chain: at most TWO bounded claim rounds — the
   * immediate round plus ONE trailing round when requests were coalesced
   * while it ran — then any leftover requests re-arm the owned timer for the
   * next window. Never two rounds at once, never an unbounded loop.
   */
  async function startRound(reason: string, parkedAtStart: number): Promise<JournalExtractPumpResult> {
    roundActive = true;
    lastPumpAt = nowMs();
    let leftover = false;
    let summary: JournalExtractPumpResult;
    try {
      const first = await runRound();
      summary = { ...first, deferred: parkedAtStart };
      if (pendingKickCount > 0 && !closed && deps.settings.enabled && !deadline?.aborted) {
        // Bounded trailing drain, exactly once per chain: accepted work that
        // arrived while the first round ran (second flush, overlapping drive
        // point) drains WITHOUT another external flush.
        const trailingParked = pendingKickCount;
        pendingKickCount = 0;
        const second = await runRound();
        summary = mergeRoundResults(summary, second, summary.deferred + trailingParked);
      }
      leftover = pendingKickCount > 0;
    } finally {
      roundActive = false;
    }
    if (leftover) scheduleKick();
    return summary;
  }

  function mergeRoundResults(
    a: JournalExtractPumpResult,
    b: JournalExtractPumpResult,
    deferred: number,
  ): JournalExtractPumpResult {
    return {
      claimed: a.claimed + b.claimed,
      chunksAcked: a.chunksAcked + b.chunksAcked,
      memories: a.memories + b.memories,
      nothingToLearn: a.nothingToLearn + b.nothingToLearn,
      retryable: a.retryable + b.retryable,
      sourceUnavailable: a.sourceUnavailable + b.sourceUnavailable,
      released: a.released + b.released,
      deferred,
      gateCounters: {
        rejectedTaskLocal: a.gateCounters.rejectedTaskLocal + b.gateCounters.rejectedTaskLocal,
        rejectedLowValue: a.gateCounters.rejectedLowValue + b.gateCounters.rejectedLowValue,
        duplicatesDropped: a.gateCounters.duplicatesDropped + b.gateCounters.duplicatesDropped,
        conflicts: a.gateCounters.conflicts + b.gateCounters.conflicts,
        demotedPasteSuspicious: a.gateCounters.demotedPasteSuspicious + b.gateCounters.demotedPasteSuspicious,
      },
      errors: a.errors + b.errors,
    };
  }

  /**
   * Drive ONE extraction effort. The 30s immediate-round gate and the single
   * flight are preserved exactly; the two historical silent drops are gone:
   * an in-window or overlapping request is counted (`deferred`) and
   * coalesced into the owned pending drain instead of vanishing.
   */
  async function pump(): Promise<JournalExtractPumpResult> {
    log(`journal extract: drive enabled=${deps.settings.enabled} closed=${closed} aborted=${deadline?.aborted ?? false} active=${roundActive}`);
    if (!deps.settings.enabled) return emptyJournalExtractPump();
    if (closed) return emptyJournalExtractPump();
    if (deadline?.aborted) return emptyJournalExtractPump();
    if (roundActive) {
      pendingKickCount++;
      log("journal extract: overlapping pump request coalesced into the in-flight round");
      return { ...emptyJournalExtractPump(), deferred: 1 };
    }
    const at = nowMs();
    if (lastPumpAt !== 0 && at - lastPumpAt < MIN_PUMP_INTERVAL_MS) {
      pendingKickCount++;
      log("journal extract: in-window pump request coalesced into the owned pending drain");
      scheduleKick();
      return { ...emptyJournalExtractPump(), deferred: 1 };
    }
    return beginRound("pump", 0);
  }

  function beginRound(reason: string, parked: number): Promise<JournalExtractPumpResult> {
    const job = startRound(reason, parked);
    activeRoundPromise = job;
    void job.finally(() => { if (activeRoundPromise === job) activeRoundPromise = undefined; }).catch(() => {});
    return job;
  }

  async function drain(): Promise<JournalExtractPumpResult> {
    // An explicit flush is an awaited owner, not another background kick.
    // Joining the active chain prevents concurrent claims/provider storms.
    if (activeRoundPromise) await activeRoundPromise;
    if (closed || !deps.settings.enabled || deadline?.aborted) return emptyJournalExtractPump();
    if (activeRoundPromise) return activeRoundPromise;
    const parked = pendingKickCount;
    pendingKickCount = 0;
    if (kickTimer !== null) { timer.clear(kickTimer); kickTimer = null; }
    return beginRound("explicit-flush-drain", parked);
  }

  /**
   * Close hook (wired by the runtime owner at teardown; §5 of
   * MIGRATION-PHASE-B-PENDING-DRAIN.md): stop ALL late work — the kick timer
   * is cleared, parked requests are dropped, and pumps after this point are
   * empty no-ops. Idempotent.
   */
  function dispose(): void {
    if (closed) return;
    closed = true;
    if (kickTimer !== null) {
      timer.clear(kickTimer);
      kickTimer = null;
    }
    const dropped = pendingKickCount;
    pendingKickCount = 0;
    if (dropped > 0) {
      log(`journal extract: dispose stopped ${dropped} coalesced pending request(s); durable accepted work is recoverStartup's`);
    }
  }

  /**
   * ONE bounded claim round: claim until no runnable job remains
   * (extract-kind filtered; the journal honors retry_after_at — its
   * deterministic backoff — so retriable jobs simply do not come up here).
   * Loop semantics unchanged from the pre-fix lane.
   */
  async function runRound(): Promise<JournalExtractPumpResult> {
    const result = emptyJournalExtractPump();
    for (;;) {
      // One claim at a time, extract-kind filtered; the journal honors
      // retry_after_at (its deterministic backoff) so retriable jobs wait.
      let claim: JournalClaim | null;
      try {
        const perCallMs = Math.max(5_000, deps.settings.timeoutMs);
        claim = deps.seam.claimWork(
          { kind: "extract", perChunkLeaseMs: Math.ceil(perCallMs + 5_000) },
          leaseForClaim(perCallMs),
        );
      } catch (error) {
        if (isClosedError(error)) {
          warn("journal extract pump stops: owned journal connection closed");
          break;
        }
        warn(`journal extract claim failed (${journalErrorCode(error)}): ${shortMessage(error)}`);
        result.errors++;
        break;
      }
      if (claim === null) break; // round ends: no runnable job remains

      // Defense-in-depth: producer23 owns direct-human eligibility through
      // the header. A delegated claim here is visible drift: release the
      // claim unprocessed (never widen the personal lane) and END the
      // round — the release returns the job to the queue, so continuing to
      // claim in this round would spin on the same drifted job.
      if (claim.producerHeader.delegated === true) {
        warn(`journal extract: delegated ${claim.jobId} released — outside the personal lane`);
        deps.seam.releaseClaim(claim, "delegated-header-outside-personal-lane");
        result.claimed++;
        result.released++;
        break;
      }

      result.claimed++;
      const inner = await runClaimedJob(claim, result);
      if (inner === "stop-round") break;
    }
    return result;
  }

  type ClaimRunResult = "continue" | "stop-round";

  /**
   * Drain ONE claimed job chunk by chunk (journal-ordered, bounded):
   * readChunkEvidence → typed verdict → commitChunkResult, until `exhausted`
   * (the canonical EXPLICIT terminal stop) or a non-retryable terminal.
   */
  async function runClaimedJob(
    claim: JournalClaim,
    result: JournalExtractPumpResult,
  ): Promise<ClaimRunResult> {
    const perCallTimeoutMs = Math.max(5_000, deps.settings.timeoutMs);
    const maxIterations = claim.chunksTotal + CHUNK_ITERATION_SAFETY_CAP;
    let iterations = 0;
    for (;;) {
      if (iterations >= maxIterations) {
        // Rationale cap: an unavailable/corrupt corner can never hang the
        // round; the durable state stays recovery-owned.
        deps.seam.releaseClaim(claim, "chunk-iteration-cap-reached");
        result.released++;
        warn(`journal extract: ${claim.jobId} released at the chunk iteration cap`);
        return "stop-round";
      }
      iterations++;

      // Per-chunk deadline: no work proceeds on the lane's owned abort.
      const deadline = deps.deadlineSignal;
      if (deadline?.aborted) {
        deps.seam.releaseClaim(claim, "shutdown-budget-reached");
        result.released++;
        log("journal extract: released claim on shutdown deadline");
        return "stop-round";
      }

      let evidence: JournalChunkEvidence;
      try {
        evidence = deps.seam.readChunkEvidence(claim);
      } catch (error) {
        if (isClosedError(error)) return stopOnClosed();
        return handleContractError(error, claim, result);
      }

      if (evidence.status === "exhausted") {
        // EXPLICIT TERMINAL STOP: every chunk of this claim validated (the
        // journal marked the job done on the last acked commit). NEVER
        // release a fully-acked claim — that would resurrect a done job into
        // an empty claimed state.
        log(`journal extract: ${claim.jobId} exhausted (${iterations - 1} chunk verdicts this round)`);
        return "continue";
      }

      if (evidence.status === "unavailable") {
        if (evidence.chunkIdx < 0 || evidence.reasonCode === "range-not-stored") {
          // Stale claim (job no longer claimed under this token: requeued,
          // cancelled or finalized done). Do NOT releaseClaim here — a reader
          // race can observe a just-finalized job, and releaseClaim would
          // resurrect a done job into an empty queued state (verified journal
          // behavior: releaseClaimInternal does not re-check the state; see
          // report interface-issue J3). The claim is dead; end the round.
          result.released++;
          return "stop-round";
        }
        // Relay verbatim as the typed terminal verdict: the journal's own
        // terminal-fail semantics — missing/revoked sources are NEVER acked.
        const verdict: JournalVerdict = {
          kind: "source-unavailable",
          reason: evidence.reasonCode === "revoked-source" ? "revoked" : "missing",
          message: evidence.message,
        };
        try {
          deps.seam.commitChunkResult(claim, evidence.chunkIdx, verdict);
          result.sourceUnavailable++;
          return "continue";
        } catch (error) {
          if (isClosedError(error)) return stopOnClosed();
          return handleContractError(error, claim, result);
        }
      }

      // status === "ok": the exact persisted minimized evidence of THIS chunk.
      const chunkIdx = evidence.chunkIdx;
      const eligible = evidence.events.filter((event) => event.kind === "user" && !event.injected);
      if (eligible.length === 0) {
        try {
          deps.seam.commitChunkResult(claim, chunkIdx, {
            kind: "nothing-to-learn",
            note: "no direct-human events",
          });
          result.chunksAcked++;
          result.nothingToLearn++;
          continue;
        } catch (error) {
          if (isClosedError(error)) return stopOnClosed();
          return handleContractError(error, claim, result);
        }
      }

      const signal = combineLaneSignals(AbortSignal.timeout(perCallTimeoutMs), deadline);
      let outcome: Awaited<ReturnType<JournalExtractCallLlm>>;
      try {
        outcome = await deps.callLlm({
          system: EXTRACT_SYSTEM_PROMPT,
          user: renderChunkPrompt(eligible),
          sessionId: claim.sessionId,
          signal,
        });
      } catch (error) {
        // A typed call surface must never reject in principle; if a shim
        // still does, the outcome is a bounded retry, never an ack.
        if (signal.aborted) {
          outcome = { status: "signal-aborted", message: shortMessage(error) };
        } else {
          outcome = { status: "provider-failure", message: `${journalErrorCode(error)}: ${shortMessage(error)}` };
        }
      }

      let verdict: JournalVerdict;
      try {
        verdict = verdictFromOutcome(outcome, eligible, claim, result);
      } catch (error) {
        // A programming error in the mapping must never become an ack.
        verdict = { kind: "retryable", reason: "transient", message: `verdict-error: ${shortMessage(error)}` };
        warn(`journal extract: verdict mapping failed (${verdict.message}) — retryable, no ack`);
      }
      if (deadline?.aborted) {
        // OWNED CANCELLATION STRICTLY PRECEDES COMMIT: the provider may have
        // resolved (or a shim may have ignored the signal) after the deadline
        // fired. No validated row commit, no late ack — claim-derived
        // cancellation/consent trips are additionally store-guarded by the
        // journal, but shutdown cancellation is the lane's own boundary.
        verdict = { kind: "retryable", reason: "aborted", message: "owned lane deadline reached before commit" };
      }

      try {
        const report = deps.seam.commitChunkResult(claim, chunkIdx, verdict);
        applyCommitReport(report, verdict, result);
        // A committed no-ack verdict (retryable budget/backoff, or a terminal
        // relay) leaves this claim invalidated by design: the loop must NOT
        // re-read/re-release it — the journal owns the retry schedule and the
        // next claim resumes where the durable state stands.
        if (verdict.kind !== "consumed" && verdict.kind !== "nothing-to-learn") {
          return "continue";
        }
        // Job finalized in the same commit transaction (last chunk acked ⇒
        // state='done'): the exhausted read is unreachable NOW (the job is no
        // longer claimed), so this authoritative commit report IS the terminal
        // stop for this job. Never re-read, never release.
        if (report.jobState === "done") {
          log(`journal extract: ${claim.jobId} finalized (all chunks acked)`);
          return "continue";
        }
      } catch (error) {
        if (isClosedError(error)) return stopOnClosed();
        return handleContractError(error, claim, result);
      }
    }
  }

  function stopOnClosed(): ClaimRunResult {
    warn("journal extract pump stops: owned journal connection closed");
    return "stop-round";
  }

  function applyCommitReport(
    report: JournalChunkCommitReport,
    verdict: JournalVerdict,
    result: JournalExtractPumpResult,
  ): void {
    if (report.acked) {
      result.chunksAcked++;
      result.memories += report.memoryIds.length;
      if (verdict.kind === "nothing-to-learn") result.nothingToLearn++;
    } else if (verdict.kind === "source-unavailable") {
      result.sourceUnavailable++;
    } else if (verdict.kind === "retryable") {
      result.retryable++;
    }
  }

  /**
   * Typed contract-error outcomes are recovery-owned: the worker never
   * retries the commit itself (the journal has already made the durable
   * release/cancel decision inside its own transaction).
   */
  function handleContractError(
    error: unknown,
    claim: JournalClaim,
    result: JournalExtractPumpResult,
  ): ClaimRunResult {
    warn(
      `journal extract seam rejected ${
        isContractShaped(error) ? journalErrorCode(error) : "unexpectedly"
      } for ${claim.jobId} (${shortMessage(error)}) — recovery owns the durable state, no worker-side retry`,
    );
    result.errors++;
    return "stop-round";
  }

  // -- verdict mapping (§3 matrix of MIGRATION-PHASE-B-EXTRACT-DESIGN.md) ---

  function verdictFromOutcome(
    outcome: ExtractCallOutcome,
    eligible: JournalEvidenceEvent[],
    claim: JournalClaim,
    result: JournalExtractPumpResult,
  ): JournalVerdict {
    if (outcome.status === "signal-aborted") {
      return {
        kind: "retryable",
        reason: "aborted",
        message: outcome.message || "aux extraction signal aborted",
      };
    }
    if (outcome.status === "provider-failure") {
      return { kind: "retryable", reason: "transient", message: outcome.message };
    }
    const finish: TerminalFinishReason = evaluateTerminalFinish(outcome.finishKind, outcome.hasFinish);
    if (finish.blocked) {
      switch (finish.kind) {
        case "max-tokens":
          return {
            kind: "retryable",
            reason: "provider-truncated",
            message: "finish reason max-tokens: partial output is never committed",
          };
        case "tool-calls":
          return {
            kind: "retryable",
            reason: "toolcall-finish",
            message: "finish reason tool-calls: no verified tool round-trip exists for this lane",
          };
        case "aborted":
          return {
            kind: "retryable",
            reason: "aborted",
            message: "model response terminated with an aborted finish",
          };
        case "error":
          return {
            kind: "retryable",
            reason: "unknown-terminal-finish",
            message: "finish reason error (stream-level failure)",
          };
        default:
          return {
            kind: "retryable",
            reason: "unknown-terminal-finish",
            message: `unknown terminal finish reason: ${outcome.finishKind}`,
          };
      }
    }
    if (!outcome.text.trim()) {
      return {
        kind: "retryable",
        reason: "malformed-model-output",
        message: "empty model text on a stop finish",
      };
    }

    const { drafts, parsedOk } = parseExtractDrafts(outcome.text);
    if (!parsedOk) {
      // finish === stop here (already validated above). Bad JSON is a retry,
      // never a fabricated memory — the legacy fallbackOnBadJson summary is
      // deliberately NOT reproduced on this lane.
      return {
        kind: "retryable",
        reason: "malformed-model-output",
        message: 'no valid {"memories":[…]} JSON object on a stop finish',
      };
    }
    if (drafts.length === 0) {
      return {
        kind: "nothing-to-learn",
        note: 'definitive {"memories":[]} on a stop finish (ill-shaped items dropped by validation)',
      };
    }

    const counters = result.gateCounters;
    const minImportance = deps.settings.minImportance;
    const dedupEnabled = deps.settings.dedup !== false;
    const candidates: JournalCandidateInput[] = [];
    let evidenceFailures = 0;
    let deterministicFailures = 0;
    for (const draft of drafts) {
      // Deterministic gates first — strict is ALWAYS on for the journal lane;
      // the provenanceFilter "off" bypass is a migration-only affordance.
      if (looksTaskLocal(draft.content) || looksLikeInstruction(draft.content)) {
        counters.rejectedTaskLocal++;
        deterministicFailures++;
        continue;
      }
      if (draft.importance < minImportance) {
        counters.rejectedLowValue++;
        deterministicFailures++;
        continue;
      }
      const matched = matchVerbatimEvidence(draft.evidence, eligible);
      if (!matched || draft.sourceRole !== "user") {
        evidenceFailures++;
        continue;
      }

      // Paste-suspicion demotion measured on the matched evidence text (a
      // demotion, never a rejection: false positives must not discard
      // genuinely user-stated facts that share a message with pasted matter).
      const pasteSuspicious = isPasteSuspiciousSlice(matched.text);
      if (pasteSuspicious) counters.demotedPasteSuspicious++;
      const importance = pasteSuspicious ? Math.min(draft.importance, 7) : draft.importance;
      const confidence = pasteSuspicious ? Math.min(draft.confidence, 0.6) : draft.confidence;
      const scope = durableScopeForDraft(
        {
          kind: draft.kind,
          content: draft.content,
          importance,
          confidence,
          evidence: draft.evidence,
          sourceRole: draft.sourceRole,
          scope: draft.scope,
        },
        pasteSuspicious,
      );

      // Read-only duplicate pre-commit filter (store-backed neighbors):
      // duplicates are DROPPED at validation (never merged into trusted rows
      // from a derived lane); a confirmed conflict is stored flagged via
      // conflict-of evidence exactly as the legacy path stored it.
      let droppedAsDuplicate = false;
      let conflictNeighborId: string | null = null;
      if (deps.store && dedupEnabled) {
        const neighbors = findNeighbors(
          deps.store,
          draft.content,
          3,
          {
            kind: draft.kind,
            scope,
            projectId: scope === "project" ? claim.projectId : null,
          },
        );
        for (const neighbor of neighbors) {
          const judgement = classify(draft.content, neighbor, dedupeSettings);
          if (judgement === "duplicate") {
            droppedAsDuplicate = true;
            counters.duplicatesDropped++;
            break;
          }
          if (judgement === "conflict") {
            conflictNeighborId = neighbor.record.id;
            counters.conflicts++;
            break;
          }
        }
      }
      if (droppedAsDuplicate) {
        continue;
      }

      // Explicit evidence coordinates per matched event (claiming the
      // journal's first-five default is NOT allowed when a specific quote
      // exists); snippet ≤200 chars as the legacy evidence bound.
      const evidence: Array<{ sessionId: string; seq: number; snippet?: string }> = [
        { sessionId: claim.sessionId, seq: matched.seq, snippet: draft.evidence.slice(0, 200) },
      ];
      if (conflictNeighborId !== null) {
        evidence.push({ sessionId: claim.sessionId, seq: matched.seq, snippet: `conflict-of:${conflictNeighborId}` });
      }

      candidates.push({
        text: draft.content,
        kind: draft.kind,
        // PROVENANCE IS NOT DERIVED FROM PROVIDER OUTPUT: inferred outputs are
        // review-required/derived/ineligible for recall until review. No
        // baseline pinning is ever issued from this lane.
        provenance: "derived" as MemoryProvenance,
        source: pasteSuspicious ? "llm-extract-pasted" : "llm-extract",
        scope,
        importance,
        confidence,
        evidence,
      });
    }

    log(
      `journal extract chunk verdict for ${claim.jobId}: candidates=${candidates.length} evidenceFailures=${evidenceFailures} deterministicFailures=${deterministicFailures}`,
    );

    if (candidates.length > 0) {
      return { kind: "consumed", candidates };
    }
    if (evidenceFailures === 0) {
      // Every candidate was deterministically rejected (gates or duplicate
      // convergence): retrying cannot change the outcome → validated empty.
      return {
        kind: "nothing-to-learn",
        note: `all candidates deterministically rejected (importance<${minImportance}/task-local/duplicate); rejectedTaskLocal=${counters.rejectedTaskLocal}, rejectedLowValue=${counters.rejectedLowValue}, duplicatesDropped=${counters.duplicatesDropped}`,
      };
    }
    return {
      kind: "retryable",
      reason: "evidence-shortfall",
      message: `${evidenceFailures} candidate(s) carried no verbatim evidence inside the retained chunk text`,
    };
  }

  return { pump, drain, dispose };
}

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

/** Structural duck-typing of JournalContractError (the class lives in the lane-owned journal module). */
function isContractShaped(error: unknown): boolean {
  return error instanceof Error && error.name === "JournalContractError" && "code" in error;
}

function journalErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    return (error as { code: string }).code;
  }
  return "unknown";
}

/** True when the owned journal/store connection itself is closed: no member of the owned handle may run again, and no late work may start. */
function isClosedError(error: unknown): boolean {
  if (journalErrorCode(error) === "closed") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /not open|already closed|database is not open/i.test(message);
}

/**
 * Union the per-call timeout with the lane deadline signal — the same
 * semantics as combineAbortSignals (src/shutdown-v02.ts), localized so this
 * module depends only on signal values: an already-aborted deadline passes
 * through unchanged (its reason preserved), and the union aborts with the
 * first source's reason.
 */
function combineLaneSignals(timeoutSignal: AbortSignal, deadline?: AbortSignal): AbortSignal {
  if (deadline?.aborted) return deadline;
  if (!deadline) return timeoutSignal;
  const controller = new AbortController();
  for (const s of [timeoutSignal, deadline]) {
    s.addEventListener(
      "abort",
      () => {
        controller.abort(s.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

/** Renders ONLY direct-human evidence events: "User: <text>" lines — no omission, no middle drop. */
function renderChunkPrompt(events: JournalEvidenceEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    parts.push(`User: ${event.text}`);
  }
  return parts.join("\n");
}
