/**
 * dsh-self-improved — DeepSeek Harness long-term memory and self-evolution plugin (fully local).
 *
 * M1 status: memory store (SQLite + FTS5 + sqlite-vec skeleton) + L0 capture persistence + memory/conversation search tools.
 * Design docs live in docs/ (design/ and research/).
 */
import z from "@deepseek-ai/schemastery";
import type { Context, Volatile } from "@deepseek-ai/cordis";

// Service type augmentation: pull the `declare module '@deepseek-ai/cordis'` type augmentations from the dsh-* packages into this compilation.
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-schedule";
import "@deepseek-ai/dsh-session-query";
import "@deepseek-ai/dsh-settings";

import { MemoryStore, defaultMemoryDir } from "./storage.js";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";
import { evaluateTerminalFinish } from "./compat-v02.js";
import { installCapture, projectKeyFromCwd, opaqueProjectIdFromKey, isDelegatedHeader } from "./capture.js";
import { closeStalePendingEpisodes, repairEpisodeConsistency, assembleSessionEpisodes } from "./episodes.js";
import { EpisodeReviewAbortGate, runEpisodeReview } from "./episode-review.js";
import type { EpisodeReviewSummary } from "./episode-review.js";
import { registerMemoryTools } from "./tools.js";
import { type ExtractSettings } from "./extract.js";
import { RecallService, createOpenAiEmbedding, renderCuratedProfile, type RecallSettings } from "./recall.js";
import { installRecallInjection } from "./inject.js";
import { Consolidator } from "./consolidate.js";
import { applyDecay, createSkillDraftsFromEpisodes, deleteSkill } from "./evolve.js";
import { installMemoryCommands, installBrowserChannel } from "./commands.js";
import { readValue, assignPlainTree } from "./runtime-config.js";
import { createMemoryBusiness, type MemoryJournalMutationPolicy, registerMemoryBusinessRemote } from "./business.js";
// Phase A shutdown boundary (bounded safe close of accepted work) lives in
// src/shutdown-v02.ts; owned deadline-cancellation signals are united with
// each lane's own per-call timeout signal through combineAbortSignals.
import { combineAbortSignals, registerShutdownDrain } from "./shutdown-v02.js";
// Phase B capture→journal producer lane (MIGRATION-PHASE-B-CAPTURE.md): ONE
// durable journal instance, startup recovery, and the documented narrow
// extractor seam (the worker loop over it is wired below).
import { MemoryJournalV02 } from "./memory-journal-v02.js";
import { createJournalExtractSeam } from "./capture.js";
// Phase B journal extract worker lane (MIGRATION-PHASE-B-EXTRACT.md): the
// claim → all-bounded-chunks → validated-terminal-verdict → same-tx-commit
// loop. It REPLACES the legacy advanceProcessed extractor at every drive
// point (flush/timer/review/startup).
import { createJournalExtractWorker, type JournalExtractWorker, createJournalExtractCall, emptyJournalExtractPump } from "./extract-journal-v02.js";
// rc.2 augmentations for the loader-owned events this plugin subscribes to
// (the volatile settings hook) — side-effect import only.
import "@deepseek-ai/cordis-plugin-loader";
import type { BrowserChannel } from "./commands.js";
import { createContinuityRegistrationController, loadContinuitySchema, CONTINUITY_PROJECTION_KEY } from "./continuity-registry-v02.js";
import { ContinuityStoreV02, fenceExistingContinuity } from "./continuity-store-v02.js";
import { mountContinuityRuntime } from "./continuity-runtime-v02.js";
import { ContinuityWorkerV02 } from "./continuity-worker-v02.js";
import { ContinuityHandoffV02 } from "./continuity-handoff-v02.js";
import { LearnedSkillActivator } from "./skill-activation.js";
import { activateDraftSkill, deactivateInvalidatedDrafts, restoreActivatedDrafts, rollbackDraftSkill } from "./skill-activation-runtime.js";
import { readContinuityLaneStatus, readContinuityUiInventory, readContinuityUiOfferNotes, type ContinuityUiHandoffReader } from "./continuity-inventory-ui.js";
import { continuityCanonicalDigest, continuityCanonicalHeader } from "./continuity-checkpoint-v02.js";
import { claimContinuitySummaryHumanV02, continuitySummaryLedgersReadyV02,
  continuitySummaryPolicyFingerprintV02, syncContinuitySummaryPolicyV02 } from "./continuity-summary-ledger-owner.js";
export const name = "self-improved";

/** Required host services (Cordis inject list; M1 adds sessionQuery for conversation full-text search) */
export const inject = ["sessions", "settings", "tools", "sessionQuery", "llm", "systemPrompt"] as const;

/** Module switches (see docs/design/dsh-memory-detailed-design.md §2.5 for coupling rules) */
export interface ModuleSwitches {
  capture: boolean;
  extract: boolean;
  consolidate: boolean;
  evolve: boolean;
  recall: boolean;
  tools: boolean;
}

export interface ExtractConfig {
  /** Polling interval in minutes */
  intervalMinutes: number;
  /** Max input characters per extraction batch */
  batchMaxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Deduplicate */
  dedup: boolean;
  /** Fall back to summarizing the raw text on bad JSON (off by default to avoid low-value summary noise) */
  fallbackOnBadJson: boolean;
  /** Drop extracted results whose importance is below this value (noise reduction, high floor = extraction is a privilege) */
  minImportance: number;
  /** headless: drain extraction synchronously on flush */
  flushDrain: boolean;
  /** Extraction model (leave empty to follow the DSH default) */
  model: string;
  provider: string;
  /** strict = conservative extraction gate (task-local/system-ish output rejected); off = legacy migration replays only */
  provenanceFilter: "strict" | "off";
  /** Require verbatim evidence on every extracted memory */
  requireEvidence: boolean;
}

export interface EmbeddingConfig {
  /** OpenAI-compatible embedding endpoint; empty = keyword-only recall */
  baseUrl: string;
  /** Secret credential (role('secret') schema slot, non-defaulted; undefined = no key stored). */
  apiKey?: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

export interface RecallConfig {
  strategy: "keyword" | "hybrid";
  maxResults: number;
  scoreThreshold: number;
  timeoutMs: number;
  /** Max characters per injected block (prevents a single injection from blowing up the context) */
  maxInjectChars: number;
  /** Relative relevance gate margin (0–1; hits must score within this fraction of the best hit) */
  relevanceMargin: number;
  /** Importance floor for contextual (non-baseline) injection hits */
  minImportance: number;
  /** Max memory blocks per turn (stacking guard; 0 = unlimited) */
  maxInjectPerTurn: number;
  embedding: EmbeddingConfig;
}

/**
 * Episode learning: capture + review + recall. Skill proposals are an explicit
 * opt-in and remain inactive drafts until evaluation and human activation exist.
 */
export interface EpisodeLearningConfig {
  /** Master switch for episode capture/assembly (off = no episode events captured) */
  enabled: boolean;
  /** In this slice capture is gated together with this flag (episodeCtl.enabled); off = nothing captured */
  captureArguments: boolean;
  /** Redacted argument/result bound in characters (also the residual-exposure bound) */
  resultExcerptChars: number;
  /** Episodes + audit rows older than this many days are purged (bounded growth; 7–365, default 90) */
  retentionDays: number;
  /** Phase 3: LLM outcome review of assembled episodes (off = no memories learned, episodes stay unreviewed) */
  reviewEnabled: boolean;
  /** Minimum reviewer confidence for a memory to be stored (0–1, default 0.8) */
  confidenceFloor: number;
  /** Expiry of derived operational memories in days (7–365, default 90) */
  expiryDays: number;
  /** Phase 4: separately-gated operational recall injection (off = rollout default) */
  operationalRecallEnabled: boolean;
  /** Operational hits per injection (1–10, default 2) */
  maxRecallResults: number;
  /** Character cap of the operational fence itself (100–5000, default 600) */
  maxRecallChars: number;
  /** Minimum distinct sessions that must support an inactive skill draft (2–10, default 2) */
  skillMinEpisodes: number;
  /** Opt-in to generate SQLite-backed inactive skill drafts during full review; never publishes active skills. */
  skillDraftsEnabled: boolean;
}

export interface ConsolidateConfig {
  scenesEnabled: boolean;
  sceneMaxMemories: number;
  personaMaxMemories: number;
  sceneBatchSize: number;
}

export interface EvolveConfig {
  decay: { enabled: boolean; minAgeDays: number; threshold: number; retentionDays: number; maxActiveMemories: number };
  skillSynthesis: { enabled: boolean; minImportance: number; skillsRoot: string; prefix: string; maxSkills: number };
}

export interface HousekeepingConfig {
  personaVersions: number;
  maxScenes: number;
  sceneActiveRatio: number;
  conversationRetentionDays: number;
}

export interface ReviewConfig {
  enabled: boolean;
  time: string;
}

export interface ContinuityConfig {
  /** Explicit opt-in for durable local structural native continuity references. */
  enabled: boolean;
  /** Separate opt-in: minimized own user excerpts sent to the configured model
   * for PARTIAL extractive handoffs. Missing/default false never permits egress. */
  summaryEnabled?: boolean;
  excludedSessionIds: string[];
  excludedProjectIds: string[];
}

export interface Config {
  /** L1 master switch: turn off/on at any time, hot-switched, no restart */
  enabled: boolean;
  /** Probe/debug logging */
  debug: boolean;
  /** Memory store root directory; empty = $DSH_HOME/memory; INIT-ONLY (restart on change) */
  storageRoot: string;
  /** Default number of results returned by tools */
  searchLimit: number;
  /** L2 module switches */
  modules: ModuleSwitches;
  /** L1 extraction pipeline parameters */
  extract: ExtractConfig;
  /** M3 recall parameters */
  recall: RecallConfig;
  /** M4 consolidation (L2/L3) parameters */
  consolidate: ConsolidateConfig;
  /** M4 self-evolution parameters */
  evolve: EvolveConfig;
  /** M6 growth governance: caps and cleanup for persona versions/scenes/conversation slices */
  housekeeping: HousekeepingConfig;
  /** M6 nightly review schedule: run one full evolution at a fixed time every day (extraction drain + consolidation + skills + governance) */
  review: ReviewConfig;
  /** Episode learning (capture/assembly; later phases add review/recall/skill fields) */
  episodeLearning: EpisodeLearningConfig;
  /** Optional for older typed fixture configs; missing always denies continuity. */
  continuity?: ContinuityConfig;
}

/**
 * What the rc.2 Loader hands to apply() for this plugin's Config: every field
 * the schema declares `.volatile()` arrives as a stable Volatile ref whose
 * `.get()` reads the current validated value (see src/runtime-config.ts for
 * the policy). `storageRoot` stays nonvolatile on purpose (init-only; a
 * change must restart the fiber and close/reopen the store under drain).
 */
export interface RuntimeConfig {
  enabled: Volatile<boolean>;
  debug: Volatile<boolean>;
  storageRoot: string;
  searchLimit: Volatile<number>;
  modules: Volatile<ModuleSwitches>;
  extract: Volatile<ExtractConfig>;
  recall: Volatile<RecallConfig>;
  consolidate: Volatile<ConsolidateConfig>;
  evolve: Volatile<EvolveConfig>;
  housekeeping: Volatile<HousekeepingConfig>;
  review: Volatile<ReviewConfig>;
  episodeLearning: Volatile<EpisodeLearningConfig>;
  continuity?: Volatile<ContinuityConfig>;
}

// Shared LLM caller (used by extraction/consolidation/skill synthesis; reuses the DSH model stack).
// maxTokens may be a getter so settings hot-apply takes effect per call instead
// of being captured at creation time.
export function makeLlmCall(
  ctx: Context,
  config: Config,
  /** Plugin-internal audit label only; NEVER sent to the model. rc.2's wire `purpose` is reserved for `compaction | session-title`. */
  purpose: string,
  maxTokens: number | (() => number),
): (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }) => Promise<string> {
  return async (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }): Promise<string> => {
      const maxOutputTokens = typeof maxTokens === "function" ? maxTokens() : maxTokens;
      const assembler = new BlockAssembler();
      // Auxiliary one-shot request: identity-free user input, system prompt in
      // the system slot. `provider`/`model` must resolve clearly — extraction,
      // consolidation, review, and skill work never silently ride the wrong
      // route, and an unconfigured route fails loudly instead of guessing.
      const { provider, model } = resolveAuxModelRoute(ctx, config);
      const options: GenerateOptions = {
        messages: [
          createUserMessage({
            content: [{ type: "text", text: input.user }],
            source: { kind: "dsh-self-improved" },
          }),
        ],
        system: input.system,
        maxTokens: maxOutputTokens,
        provider,
        model,
        signal: input.signal,
      };
      // Keep auxiliary reviews detached from native session transport: a
      // sessionId enables dsh_session_log to attach unminimized canonical
      // history outside this caller's bounded/redacted evidence messages.
      // Internal evidence lineage and explicit routing/cancellation remain.
      // Terminal-finish validation: ONLY an explicit `stop` finish yields
      // completed text for these tool-less auxiliary reviews; `tool-calls`,
      // `max-tokens`, `aborted`, `error`, unknown reasons, and a truncated
      // stream (no finish chunk) must all fail rather than feed partial
      // reviews back (evaluateTerminalFinish implements the matrix).
      let finishKind: string | null = null;
      // Cancelled-before-start: a lane signal (per-call timeout ⊕ shutdown
      // deadline, src/shutdown-v02.ts combineAbortSignals) that is already
      // aborted must not even open a doomed provider stream.
      input.signal.throwIfAborted();
      for await (const chunk of ctx.llm.stream(options)) {
        input.signal.throwIfAborted();
        assembler.push(chunk);
        if (chunk.type === "finish") finishKind = chunk.reason.kind;
      }
      input.signal.throwIfAborted();
      const verdict = evaluateTerminalFinish(finishKind ?? "absent", finishKind !== null);
      if (verdict.blocked) {
        throw new Error(`[dsh-self-improved] ${purpose}: incomplete model response (finish reason: ${verdict.kind}); not accepted as a completed review`);
      }
      const text = assembler
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (!text.trim()) {
        throw new Error(`[dsh-self-improved] ${purpose}: model returned no text`);
      }
      return text;
    };
}

/**
 * Resolve the concrete aux-call model route. Explicit plugin config wins
 * (correct for a dedicated memory model); otherwise the host default model
 * selection is used when the host provides it; otherwise the call fails
 * visibly. MIGRATION-V0.2.md excludes any provider fallback guessing.
 */
/** Exported (MIGRATION-PHASE-B-EXTRACT-DESIGN.md anchor §5.4) so the
 *  journal extract worker builds its typed aux call on the SAME route
 *  resolution; live per-request provider/model resolution stays in one site. */
export function resolveAuxModelRoute(ctx: Context, config: Config): { provider: string; model: string } {
  let provider = config.extract.provider?.trim() ?? "";
  let model = config.extract.model?.trim() ?? "";
  if (provider && model) return { provider, model };
  try {
    // This is an optional Host service. `Context.agentDefaultModel` is only
    // populated for fibers that hard-inject it; use `get()` so a mounted
    // sibling provider is visible without turning it into a hard dependency.
    const selection = ctx.get("agentDefaultModel")?.currentSelection?.();
    if (selection && typeof selection.provider === "string" && typeof selection.model === "string") {
      provider = provider || selection.provider;
      model = model || selection.model;
    }
  } catch {
    /* stay unconfigured when there is no default model service */
  }
  if (!provider) {
    throw new Error(
      "dsh-self-improved: no model provider configured — set extract.provider/extract.model (e.g. provider 'go-opencode', model 'glm-5.3-flash')",
    );
  }
  if (!model) {
    throw new Error(`dsh-self-improved: model provider '${provider}' selected but extract.model is empty`);
  }
  return { provider, model };
}
/**
 * Plugin Config schema (rc.2).
 *
 * MIGRATION-V0.2.md Phase A acceptance scope: editable fields are EXPLICITLY
 * volatile (`.volatile()` markers below) so a settings edit commits into the
 * running fiber's volatile refs and emits `loader/volatile-update` instead of
 * remounting the plugin; `storageRoot` stays nonvolatile so a storage-root
 * change still owns the full restart lifecycle (store close under drain).
 * The embedding API key is a schema-declared SECRET (`role('secret')`): wire
 * reads return the redacted view plus a presence-only sidecar
 * (`SettingsNamespaceView.secrets`), so UI drafts never receive the value.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  debug: z.boolean().default(false).volatile(),
  // INIT-ONLY: deliberately nonvolatile — see src/runtime-config.ts policy.
  storageRoot: z.string().default(""),
  searchLimit: z.number().min(1).max(50).default(5).volatile(),
  continuity: z.object({
    enabled: z.boolean().default(false),
    summaryEnabled: z.boolean().default(false),
    excludedSessionIds: z.array(z.string().min(1).max(256)).max(128).default([]),
    excludedProjectIds: z.array(z.string().pattern(/^pj-[a-f0-9]{32}$/)).max(128).default([]),
  }).volatile(),
  modules: z.object({
    capture: z.boolean().default(true),
    extract: z.boolean().default(true),
    consolidate: z.boolean().default(true),
    evolve: z.boolean().default(true),
    recall: z.boolean().default(true),
    tools: z.boolean().default(true),
  }).volatile(),
  extract: z.object({
    intervalMinutes: z.number().min(1).default(15),
    batchMaxChars: z.number().min(2000).max(100000).default(12000),
    maxOutputTokens: z.number().min(128).default(2000),
    timeoutMs: z.number().min(5000).default(60000),
    dedup: z.boolean().default(true),
    fallbackOnBadJson: z.boolean().default(false),
    minImportance: z.number().min(1).max(10).default(6),
    flushDrain: z.boolean().default(false),
    model: z.string().default(""),
    provider: z.string().default(""),
    provenanceFilter: z.string().default("strict"),
    requireEvidence: z.boolean().default(true),
  }).volatile(),
  recall: z.object({
    strategy: z.string().default("keyword"),
    maxResults: z.number().min(1).max(20).default(5),
    scoreThreshold: z.number().default(0),
    timeoutMs: z.number().min(1000).default(5000),
    maxInjectChars: z.number().min(100).default(800),
    relevanceMargin: z.number().min(0).max(1).default(0.5),
    minImportance: z.number().min(0).max(10).default(0),
    maxInjectPerTurn: z.number().min(0).max(20).default(4),
    embedding: z.object({
      baseUrl: z.string().default(""),
      // SECRET SLOT: present-but-redacted on every wire read; consumers write
      // it through settings mutates, never echo it back into drafts.
      // NO default: a defaulted secret value sits in every composed namespace
      // view, and the host presence walker (`set: value !== void 0`,
      // dsh-settings redact.walk) would then report a phantom "key stored"
      // even with nothing stored (observed in the mounted describe mirror).
      // Absent value = no key; presence-only display stays truthful.
      apiKey: z.string().role("secret"),
      model: z.string().default(""),
      dimensions: z.number().min(64).default(1024),
      timeoutMs: z.number().min(1000).default(10000),
    }),
  }).volatile(),
  consolidate: z.object({
    scenesEnabled: z.boolean().default(false),
    sceneMaxMemories: z.number().min(1).default(50),
    personaMaxMemories: z.number().min(1).default(30),
    sceneBatchSize: z.number().min(1).max(20).default(8),
  }).volatile(),
  evolve: z.object({
    decay: z.object({
      enabled: z.boolean().default(true),
      minAgeDays: z.number().min(1).default(7),
      threshold: z.number().min(0).default(2),
      retentionDays: z.number().min(0).default(180),
      maxActiveMemories: z.number().min(0).default(500),
    }),
    skillSynthesis: z.object({
      enabled: z.boolean().default(false),
      minImportance: z.number().min(1).max(10).default(7),
      skillsRoot: z.string().default(""),
      prefix: z.string().default("dsi-"),
      maxSkills: z.number().min(0).default(100),
    }),
  }).volatile(),
  housekeeping: z.object({
    personaVersions: z.number().min(1).default(10),
    maxScenes: z.number().min(1).default(50),
    sceneActiveRatio: z.number().min(0).max(1).default(0.3),
    conversationRetentionDays: z.number().min(0).default(90),
  }).volatile(),
  review: z.object({
    enabled: z.boolean().default(true),
    time: z.string().default("22:00"),
  }).volatile(),
  episodeLearning: z.object({
    enabled: z.boolean().default(false),
    captureArguments: z.boolean().default(true),
    resultExcerptChars: z.number().min(200).max(50000).default(4000),
    retentionDays: z.number().min(7).max(365).default(90),
    reviewEnabled: z.boolean().default(true),
    confidenceFloor: z.number().min(0).max(1).default(0.8),
    expiryDays: z.number().min(7).max(365).default(90),
    operationalRecallEnabled: z.boolean().default(false),
    maxRecallResults: z.number().min(1).max(10).default(2),
    maxRecallChars: z.number().min(100).max(5000).default(600),
    skillMinEpisodes: z.number().min(2).max(10).default(2),
    skillDraftsEnabled: z.boolean().default(false),
  }).volatile(),
});

/**
 * Build the plugin's plain live-view over the volatile refs the Loader handed
 * to apply(). Refs stay owned by the loader; consumers receive this mutable
 * plain object and every volatile update commits INTO it in place (same
 * nested object identities), so closures that read properties at call time
 * stay fresh and closures that captured objects keep working.
 */
export function unwrapRuntimeConfig(raw: RuntimeConfig): Config {
  return {
    enabled: readValue(raw.enabled),
    debug: readValue(raw.debug),
    storageRoot: raw.storageRoot,
    searchLimit: readValue(raw.searchLimit),
    modules: { ...readValue(raw.modules) },
    extract: { ...readValue(raw.extract) },
    recall: { ...readValue(raw.recall), embedding: { ...readValue(raw.recall).embedding } },
    consolidate: { ...readValue(raw.consolidate) },
    evolve: { decay: { ...readValue(raw.evolve).decay }, skillSynthesis: { ...readValue(raw.evolve).skillSynthesis } },
    housekeeping: { ...readValue(raw.housekeeping) },
    review: { ...readValue(raw.review) },
    episodeLearning: { ...readValue(raw.episodeLearning) },
    continuity: {
      enabled: readValue(raw.continuity)?.enabled === true,
      summaryEnabled: readValue(raw.continuity)?.summaryEnabled === true,
      excludedSessionIds: [...(readValue(raw.continuity)?.excludedSessionIds ?? [])],
      excludedProjectIds: [...(readValue(raw.continuity)?.excludedProjectIds ?? [])],
    },
  };
}

/** Commit one volatile update in place (same nested live object identities).
 *  Volatile snapshots are recursively FROZEN: each group is copied through
 *  `assignPlainTree` (src/runtime-config.ts) so the owned live view stays
 *  mutable and nested references (recall.embedding, evolve.*) are updated in
 *  place. A shallow Object.assign proved to break the NEXT hot edit with a
 *  read-only TypeError against the genuine Loader. */
function commitVolatileUpdate(live: Config, raw: RuntimeConfig): void {
  Object.assign(live, {
    enabled: readValue(raw.enabled),
    debug: readValue(raw.debug),
    searchLimit: readValue(raw.searchLimit),
  });
  assignPlainTree(live.modules, readValue(raw.modules));
  assignPlainTree(live.extract, readValue(raw.extract));
  assignPlainTree(live.recall, readValue(raw.recall));
  assignPlainTree(live.consolidate, readValue(raw.consolidate));
  assignPlainTree(live.evolve, readValue(raw.evolve));
  assignPlainTree(live.housekeeping, readValue(raw.housekeeping));
  assignPlainTree(live.review, readValue(raw.review));
  assignPlainTree(live.episodeLearning, readValue(raw.episodeLearning));
  const continuity = readValue(raw.continuity);
  live.continuity ??= { enabled: false, excludedSessionIds: [], excludedProjectIds: [] };
  assignPlainTree(live.continuity, {
    enabled: continuity?.enabled === true,
    summaryEnabled: continuity?.summaryEnabled === true,
    excludedSessionIds: [...(continuity?.excludedSessionIds ?? [])],
    excludedProjectIds: [...(continuity?.excludedProjectIds ?? [])],
  });
}

export function apply(ctx: Context, rawConfig: RuntimeConfig): void {
  // Live config view (updated in place by the volatile-update hook below —
  // closed-over objects keep working because the plugin's config shape is
  // stable and leaf objects are never replaced).
  const config: Config = unwrapRuntimeConfig(rawConfig);
  const log = (...args: unknown[]): void => {
    if (config.debug) console.log("[dsh-self-improved]", ...args);
  };

  // ① Settings page policy (rc.2): Config comes from the Loader entry.
  //    Editable fields are VOLATILE (see Config schema + runtime-config.ts):
  //    a settings edit commits into `config` in place and emits
  //    `loader/volatile-update`; the hook below re-applies hot state
  //    (schedulers, consent gate, tools/commands) without remounting.
  //    `storageRoot` stays nonvolatile: changing it restarts this fiber —
  //    unload runs every effect-owned disposer incl. the store close, and
  //    apply() re-runs with the new validated init-only config.
  // Effect-owned: the page-policy disposer runs on fiber unload (config change restart or disable).
  ctx.effect(
    () => {
      try {
        return ctx.settings.configure({ auto: true });
      } catch (error) {
        console.warn("[dsh-self-improved] settings page policy registration unavailable:", String(error));
        return () => {};
      }
    },
    "settings page policy",
  );
  log("settings page policy registered (volatile fields hot-apply; storageRoot is init-only)");

  // Runtime mutable state (M5): master/module switches read the live view;
  // the volatile-update hook re-derives everything below when the user edits
  // settings. No mutation-mirroring scope.watch path remains (rc.2 has none).
  const readModule = (m: keyof ModuleSwitches): boolean => !shuttingDown && config.enabled && config.modules[m];
  /** Init-only skills root (see runtime-config.ts INIT_ONLY_PATHS): resolved
   *  ONCE at plugin start; every consumer reads this captured value so a live
   *  edit can never retarget where synthesis/rollback writes. */
  const skillsRootInit = (config.evolve.skillSynthesis.skillsRoot ?? "").trim();
  const skillsRootLive = (): string => skillsRootInit;
  /**
   * Lifecycle boundary (Phase A): once shutdown begins, EVERY owned pipeline
   * ingress refuses new work and every already-accepted job is tracked so the
   * close disposer joins them (bounded) before `store.close()`. This is the
   * ordering that fixes the runtime-report race D1: an accepted flush
   * extraction insert was losing to `store.close()` (`database is not open`)
   * because the old teardown cleared timers and closed the store while the
   * capture/flush listener was still registered and pumps were untracked.
   */
  let shuttingDown = false;
  // Optional native capability: profiles without sessionProjections still
  // run accepted memory lanes. Projection registration is structural only;
  // the separate default-off provider worker is wired after source ownership.
  // Continue is installed as an OPERATOR-DOOR action only (see business.ts):
  // the browser remote mints the peer/args-bound confirm; no message marker,
  // tool call or in-process caller can open a handoff.
  let syncContinuityProjection: () => void = () => {};
  let syncContinuityRuntime: () => void = () => {};
  let stopContinuityRuntime: () => void = () => {};
  let syncContinuityStorePolicy: () => void = () => {};
  let continuityStorePolicyHealthy = true;
  /**
   * Operator-door Continue reader for the mounted lane. Null while the lane is
   * unmounted, disabled or unhealthy, and the business layer then serves no
   * offers at all. Created lazily on first operator request so a disabled lane
   * never touches the continuity tables.
   */
  let continuityHandoffReader: (() => ContinuityUiHandoffReader | undefined) | null = null;
  let syncContinuitySummaryPolicy: () => void = () => {};
  let stopContinuityWorker: () => void = () => {};
  let summaryPolicyHealthy = true;
  let summaryPolicyGeneration = -1;
  let summaryPolicyFingerprint: string | undefined;
  /** Currently accepted background jobs (extraction pumps, reviews, evolution rounds). */
  const acceptedJobs = new Set<Promise<unknown>>();
  /**
   * Owned shutdown deadline cancellation (src/shutdown-v02.ts): the drain's
   * `cancel()` hook aborts this controller AT THE DEADLINE, and every accepted
   * auxiliary LLM lane unions the signal into its real request path with
   * `combineAbortSignals(perCallSignal, shutdownDeadlineGate.signal)` — the
   * genuine `GenerateOptions.signal` transport, not a warning-only path.
   */
  const shutdownDeadlineGate = new AbortController();
  const trackAcceptedJob = <T,>(job: Promise<T>): Promise<T> => {
    // Settle-tracking without ever "handling" the job's own rejection: the
    // first real consumer (flush barrier / command / review runner) still
    // observes the failure; the drain only counts/settles it.
    void Promise.resolve(job).finally(() => {
      acceptedJobs.delete(job);
      return undefined;
    }).catch(() => {});
    acceptedJobs.add(job);
    return job;
  };
  /** Everything that must follow a hot settings edit WITHOUT a restart. */
  const applyHotSettingsUpdate = (): void => {
    // Init-only filesystem root enforcement (skillsRoot): the loader CAN carry
    // a live edit through its volatile group, but the plugin keeps the startup
    // value effective — a live write never retargets a running filesystem root.
    const liveSkillsRoot = (config.evolve.skillSynthesis.skillsRoot ?? "").trim();
    if (liveSkillsRoot !== skillsRootInit) {
      console.warn(
        "[dsh-self-improved] evolve.skillSynthesis.skillsRoot is initialization-only; the running fiber keeps",
        JSON.stringify(skillsRootInit), "— restart to apply", JSON.stringify(liveSkillsRoot),
      );
    }
    // Consent is rechecked at the authoritative boundary: disabling review or
    // draft generation aborts in-flight work as well as ceasing eligibility.
    episodeReviewGate.setEnabled(config.enabled && episodeState.enabled && episodeState.reviewEnabled);
    episodeSkillDraftGate.setEnabled(config.enabled && episodeState.enabled && episodeState.skillDraftsEnabled);
    syncSchedulers();
    syncTools();
    syncCommands();
    applyJournalJobPolicyTransitions();
  };
  /**
   * Journal job-policy volatile transitions (MIGRATION-PHASE-B-WORKER-REVIEW
   * F1); every call executes ALL pending transitions in ONE synchronous
   * section, atomically owned:
   * - master pause / extract-module disable: durable policy generation bump ∧
   *   owned in-flight abort (accepted pending sources REPLAN on resume —
   *   drain, not discard);
   * - extract-job re-enable: fresh gate + worker + coverage replan for pending
   *   sources (the re-armed schedulers then drain them);
   * - episode-learning consent revoke: durable CANCELLATION generation bump —
   *   queued journal jobs are cancelled immediately and in-flight commits are
   *   journal-rejected into terminal cancellation (the binding F1 gap);
   * - consent re-arm: coverage replan for still-pending (never-revoked)
   *   sources under the new cancellation generation.
   * Boot-time enables/false states never trip these (compare against the
   * previous LIVE state, so a config-disabled mount stays bit-identical).
   */
  const applyJournalJobPolicyTransitions = (): void => {
    // ── pause / resume ──
    const extractJobsEnabled = config.enabled && config.modules.extract;
    if (!extractJobsEnabled && extractJobsOn) {
      try {
        pauseExtractJobs(`pause:extract-jobs(${extractJobsPolicyGen + 1})`);
        log("extract job policy PAUSED: policy generation", extractJobsPolicyGen, "— in-flight pump cancelled, queued jobs cancelled, pending sources replan on resume");
      } catch (error) {
        console.warn("[dsh-self-improved] extract job pause failed (in-flight gate aborted alone):", String(error));
        extractJobsPolicyGate.abort(new Error(`extract job policy pause (bump failed): ${String(error)}`));
      }
    } else if (extractJobsEnabled && !extractJobsOn) {
      try {
        resumeExtractJobs(`resume:extract-jobs(gen=${journal.getPolicyGeneration()})`);
      } catch (error) {
        console.warn("[dsh-self-improved] extract job resume failed:", String(error));
      }
    }
    extractJobsOn = extractJobsEnabled;
    // ── consent revoke / re-arm (episodeLearning) ──
    const consentEnabled = episodeState.enabled === true;
    if (!consentEnabled && episodeConsentOn) {
      try {
        const gen = journal.bumpCancellationGeneration("consent-revoked:episodeLearning");
        log("episode-learning consent REVOKED: journal cancellation generation", gen, "— queued jobs cancelled, in-flight commits terminally blocked");
      } catch (error) {
        console.warn("[dsh-self-improved] consent revocation: journal cancellation bump failed:", String(error));
      }
    } else if (consentEnabled && !episodeConsentOn) {
      try {
        const planned = journal.planJobsCoverPending();
        log("episode-learning consent re-armed: coverage replanned", planned.jobsCreated, "jobs (pending, non-revoked sources only) under cancellation generation", journal.getCancellationGeneration());
      } catch (error) {
        console.warn("[dsh-self-improved] consent re-arm: coverage replan failed (boot recovery still replans):", String(error));
      }
    }
    episodeConsentOn = consentEnabled;
  };
  ctx.on("loader/volatile-update", () => {
    if (shuttingDown) return;
    try {
      commitVolatileUpdate(config, rawConfig);
    } catch (error) {
      console.warn("[dsh-self-improved] volatile config commit failed:", String(error));
      return;
    }
    syncContinuitySummaryPolicy(); // durable body fence + cancel, before structural work
    syncContinuityStorePolicy(); // independent of schema/capability availability
    try {
      syncContinuityRuntime(); // privacy fence independent of structural registration
    } catch {
      console.warn("[dsh-self-improved] continuity runtime policy reapplication failed");
      stopContinuityRuntime(); // never keep ingress open on a failed fence
    }
    try {
      syncContinuityProjection();
    } catch (error) {
      console.warn("[dsh-self-improved] continuity policy reapplication failed:", String(error));
    }
    try {
      applyHotSettingsUpdate();
    } catch (error) {
      console.warn("[dsh-self-improved] hot settings reapplication failed:", String(error));
    }
    log("volatile settings applied (no restart)");
  });

  // ② Memory store (M1): SQLite + FTS5 + sqlite-vec skeleton
  const dir = config.storageRoot.trim() || defaultMemoryDir();
  const store = new MemoryStore(dir);
  // Revocation must work even when optional projections or declared schema
  // dependency cannot load. Inspect/fence only EXISTING compatible tables;
  // never create continuity data or guess a missing schema here.
  syncContinuityStorePolicy = (): void => {
    if (shuttingDown) return; // unload retains progress, unlike privacy denial
    try {
      fenceExistingContinuity(store, readModule("capture") && config.continuity?.enabled === true,
        config.continuity?.excludedSessionIds ?? [], config.continuity?.excludedProjectIds ?? []);
      continuityStorePolicyHealthy = true;
    } catch {
      continuityStorePolicyHealthy = false;
      stopContinuityRuntime();
      console.warn("[dsh-self-improved] continuity existing-store policy fence unavailable");
    }
  };
  syncContinuityStorePolicy();
  // Separate body/provider generation: summary-only pause never destroys local
  // structural references/checkpoints. Fence EXISTING rows even without optional
  // SDK/Zod; default-off fresh boot creates no summary namespace. Old summaries
  // may remain operator-browsable, but no recall/Continue consumer is installed.
  const summaryEnabled = (): boolean => summaryPolicyHealthy && continuityStorePolicyHealthy
    && readModule("capture") && config.continuity?.enabled === true && config.continuity?.summaryEnabled === true;
  const currentSummaryRoute = (): { provider: string; model: string } | null => {
    if (!readModule("capture") || config.continuity?.enabled !== true || config.continuity?.summaryEnabled !== true) return null;
    try { return resolveAuxModelRoute(ctx, config); } catch { return null; }
  };
  syncContinuitySummaryPolicy = (): void => {
    if (shuttingDown) return;
    const route = currentSummaryRoute();
    const allowed = readModule("capture") && config.continuity?.enabled === true && config.continuity?.summaryEnabled === true && route !== null;
    const fingerprint = continuitySummaryPolicyFingerprintV02({
      allowed, route,
      excludedSessionIds: config.continuity?.excludedSessionIds ?? [],
      excludedProjectIds: config.continuity?.excludedProjectIds ?? [],
    });
    if (summaryPolicyFingerprint === fingerprint && summaryPolicyHealthy) return;
    // Close accepted body ingress and propagate transport abort BEFORE storage
    // operations. A failed durable fence must never leave a provider running.
    stopContinuityWorker();
    try {
      summaryPolicyGeneration = store.runInImmediateTransaction(() =>
        syncContinuitySummaryPolicyV02(store.getJournalSqlite(), allowed));
      summaryPolicyFingerprint = fingerprint; summaryPolicyHealthy = true;
    } catch {
      summaryPolicyHealthy = false; summaryPolicyGeneration = -1;
      console.warn("[dsh-self-improved] continuity summary provider consent fence unavailable; no body work admitted");
    }
  };
  syncContinuitySummaryPolicy();
  // Current default-route changes are owned by settings documents rather than
  // this entry's volatile refs. Recheck that exact route and cancel old epochs;
  // this notification never schedules model work or resumes a task.
  ctx.on("settings/document-updated", () => { if (!shuttingDown) syncContinuitySummaryPolicy(); });
  // Structural registration remains capture-gated even when durable
  // continuity is off. Runtime admission is a separate explicit opt-in.
  ctx.inject(["sessionProjections"], async (child) => {
    let disposed = false;
    child.effect(() => () => { disposed = true; }, "continuity import lifetime");
    try {
      const schemaZod = await loadContinuitySchema();
      if (disposed || shuttingDown) return;
      const controller = createContinuityRegistrationController(child, schemaZod);
      const syncProjection = (): void => controller.sync(readModule("capture"));
      child.effect(() => () => {
        controller.dispose();
        if (syncContinuityProjection === syncProjection) syncContinuityProjection = () => {};
      }, "continuity registration policy owner");
      syncContinuityProjection = syncProjection;
      syncProjection();
      child.inject(["sessionQuery"], (queryChild) => {
        if (disposed || shuttingDown || !continuityStorePolicyHealthy) return;
        try {
          const lane = new ContinuityStoreV02(store, schemaZod);
          const continuityEnabled = (): boolean => continuityStorePolicyHealthy && readModule("capture") && config.continuity?.enabled === true;
          // Operator-door Continue reader. Built on the FIRST operator request
          // and only while the lane is enabled, so a disabled lane creates no
          // continuity tables and holds no handoff instance at all.
          let operatorHandoffs: ContinuityHandoffV02 | null = null;
          const operatorHandoffReader = (): ContinuityUiHandoffReader | undefined => {
            if (!continuityEnabled()) return undefined;
            if (!operatorHandoffs) {
              try { operatorHandoffs = new ContinuityHandoffV02(store, schemaZod); }
              catch { operatorHandoffs = null; return undefined; }
            }
            return operatorHandoffs;
          };
          continuityHandoffReader = operatorHandoffReader;
          const runtime = mountContinuityRuntime(queryChild, lane, queryChild.sessionProjections, schemaZod, queryChild.sessionQuery,
            (session) => continuityEnabled() && !!session.header.cwd
              && !config.continuity?.excludedSessionIds.includes(session.id)
              && !config.continuity?.excludedProjectIds.includes(opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd))),
            (task) => { trackAcceptedJob(task); });
          const syncRuntime = (): void => {
            // Shutdown UNLOAD preserves durable progress. Privacy/settings
            // denial instead fences old rows immediately, even without events.
            if (shuttingDown) { runtime.dispose(); return; }
            lane.denyExcluded(config.continuity?.excludedSessionIds ?? [], config.continuity?.excludedProjectIds ?? []);
            runtime.sync(continuityEnabled());
          };
          let activeWorker: ContinuityWorkerV02 | undefined;
          let workerPending = false, workerDisposed = false;
          const stopWorker = (): void => { activeWorker?.dispose(); };
          stopContinuityWorker = stopWorker;
          const claimHumanBoundary = (session: import("@deepseek-ai/dsh-session").Session, projectId: string, humanSeq: number, generation: number): boolean => {
            // Budget authority is DURABLE. A process-local evictable map would
            // treat an unchanged old human as new after eviction or restart.
            // Bind original native identity/project/header/fork floor, not an
            // arbitrary same-ID row or a provider-declared occurrence.
            const headerHash = continuityCanonicalDigest({ header: continuityCanonicalHeader(session.header), inheritedEventCount: session.inheritedEventCount });
            return store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(store.getJournalSqlite(), {
              sessionId: session.id, projectId, headerHash, inheritedFloor: session.inheritedEventCount, humanSeq, generation,
            }));
          };
          const removeWorkerBoundary = queryChild.on("session/event", (session, event) => {
            if (workerDisposed || workerPending || !summaryEnabled() || event.type !== "turn/end"
              || event.seq < session.inheritedEventCount || !session.header.cwd || isDelegatedHeader(session.header)) return;
            const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd));
            if (config.continuity?.excludedSessionIds.includes(session.id) || config.continuity?.excludedProjectIds.includes(projectId)) return;
            // Native projection is framework-owned and pure. A fresh OWN human
            // coordinate is necessary; mere model/tool boundary activity does
            // not repeatedly schedule provider work for an abandoned task.
            const state = queryChild.sessionProjections.stateOf(session, CONTINUITY_PROJECTION_KEY);
            if (!state || state.lastHumanSeq < session.inheritedEventCount) return;
            const route = currentSummaryRoute(), generation = summaryPolicyGeneration;
            if (!route || generation < 0) return;
            try { if (!claimHumanBoundary(session, projectId, state.lastHumanSeq, generation)) return; }
            catch { console.warn("[dsh-self-improved] continuity handoff human authority watermark refused"); return; }
            workerPending = true;
            const consent = (scope: Readonly<{ sessionId: string; projectId: string }>): boolean => {
              if (workerDisposed || !summaryEnabled() || scope.projectId !== projectId || summaryPolicyGeneration !== generation
                || config.continuity?.excludedSessionIds.includes(scope.sessionId) || config.continuity?.excludedProjectIds.includes(scope.projectId)) return false;
              const current = currentSummaryRoute();
              if (!current || current.provider !== route.provider || current.model !== route.model) return false;
              try {
                return store.runInImmediateTransaction(() => {
                  const db = store.getJournalSqlite();
                  if (!continuitySummaryLedgersReadyV02(db)) return false;
                  const row = db.prepare("SELECT generation,allowed FROM main.continuity_summary_policy WHERE id=1").get() as
                    { generation: number; allowed: number } | undefined;
                  return row?.allowed === 1 && row.generation === generation;
                });
              } catch { return false; }
            };
            const task = (async () => {
              // The structural listener was installed first. Its accepted job
              // must durably enqueue/finish its native lease BEFORE this claim.
              await runtime.flush();
              if (!consent({ sessionId: session.id, projectId })) return;
              const worker = new ContinuityWorkerV02(store, queryChild.sessionQuery, queryChild.sessionProjections,
                schemaZod, queryChild.llm, route, consent);
              activeWorker = worker;
              try {
                const result = await worker.runOne(projectId, shutdownDeadlineGate.signal);
                if (result === "failed") console.warn("[dsh-self-improved] continuity handoff processing failed; source not acknowledged");
              } finally { worker.dispose(); if (activeWorker === worker) activeWorker = undefined; }
            })().catch(() => {
              console.warn("[dsh-self-improved] continuity handoff boundary failed; no task resumed");
            }).finally(() => { workerPending = false; });
            // Includes source lease/provider settlement and finally disposal.
            // Noncooperative work retains the SAME shared-store ownership.
            trackAcceptedJob(task);
          });
          const stopRuntime = (): void => { runtime.dispose(); workerDisposed = true; removeWorkerBoundary(); stopWorker(); };
          queryChild.effect(() => () => {
            stopRuntime();
            if (continuityHandoffReader === operatorHandoffReader) continuityHandoffReader = null;
            if (stopContinuityWorker === stopWorker) stopContinuityWorker = () => {};
            if (syncContinuityRuntime === syncRuntime) syncContinuityRuntime = () => {};
            if (stopContinuityRuntime === stopRuntime) stopContinuityRuntime = () => {};
          }, "continuity runtime policy owner");
          syncContinuityRuntime = syncRuntime;
          stopContinuityRuntime = stopRuntime;
          syncRuntime(); // false boot MUST deny old durable rows
        } catch {
          console.warn("[dsh-self-improved] continuity runtime unavailable");
        }
      });
    } catch (error) {
      console.warn("[dsh-self-improved] continuity projection unavailable:", String(error));
    }
  });
  // Episode-side consistency repair is idempotent (same discipline as repairConsistency)
  try {
    repairEpisodeConsistency(store);
  } catch (error) {
    console.warn("[dsh-self-improved] episode consistency repair failed:", String(error));
  }
  // Startup recovery: stranded episode events (e.g. a previous process died
  // between append and assembly, or assembly was skipped) are re-assembled.
  for (const sessionId of store.sessionsWithPendingEpisodeEvents(500)) {
    try {
      assembleSessionEpisodes(store, sessionId);
    } catch (error) {
      console.warn("[dsh-self-improved] startup episode assembly failed:", sessionId, String(error));
    }
  }
  log("memory store ready:", dir);

  // ── Phase B producer lane: ONE durable journal instance (§4.2 contract:
  // all enqueue/claim/commit/recovery runs on this single SQLite-backed
  // handle) with idempotent startup recovery. The store connection stays
  // owned by MemoryStore; the journal's lifetime therefore follows the
  // store's (closed by the shutdown drain's `close` step exactly once). ──
  const journal = new MemoryJournalV02(store);
  try {
    const recovery = journal.recoverStartup();
    if (recovery.jobsPlanned > 0 || recovery.jobsRequeued > 0 || recovery.jobsCancelled > 0) {
      log("journal startup recovery:", JSON.stringify(recovery));
    }
  } catch (error) {
    console.warn("[dsh-self-improved] journal startup recovery failed:", String(error));
  }
  // Ingress open/close signal for the capture→journal enqueue lane (same
  // Effect-owned lifecycle as the flush listener itself): once the shutdown
  // boundary drops the ingress, `journalIngressClosed` makes every later
  // flush a no-op BEFORE any owned write — the drain then only settles
  // accepted work before the store close below.
  let journalIngressClosed = false;
  const journalCaptureSink = {
    append: (input: Parameters<typeof journal.appendSession>[0]) => journal.appendSession(input),
    closed: (): boolean => journalIngressClosed,
  };

  // Hermes-style durable baseline: a small curated profile belongs in the
  // system prompt, not after the current request as another user-role message.
  // Contextual/project recall remains a separately labeled runtime snapshot.
  ctx.systemPrompt.section({
    name: "dsh-self-improved:curated-profile",
    order: 20,
    text: () => (readModule("recall") ? renderCuratedProfile(store, 2400) : ""),
  });

  // ③ L0 capture + L1 extraction: persist slices and mark the queue inside session/flush barriers;
  //    in headless mode (flushDrain) drain extraction synchronously so the 5s shutdown timeout does not kill the pipeline.
  // Extraction settings as a LIVE view over `config`: volatile edits reach the
  // running extractor without restart, so every field is read at call time.
  const extractSettings: ExtractSettings = {
    get enabled() { return readModule("extract"); },
    get intervalMinutes() { return config.extract.intervalMinutes; },
    get batchMaxChars() { return config.extract.batchMaxChars; },
    get maxOutputTokens() { return config.extract.maxOutputTokens; },
    get timeoutMs() { return config.extract.timeoutMs; },
    get dedup() { return config.extract.dedup; },
    get fallbackOnBadJson() { return config.extract.fallbackOnBadJson; },
    get minImportance() { return config.extract.minImportance; },
    get flushDrain() { return config.extract.flushDrain; },
    get provenanceFilter() { return (config.extract.provenanceFilter === "off" ? "off" : "strict") as "off" | "strict"; },
    get requireEvidence() { return config.extract.requireEvidence; },
    projectId: "",
    projectIdForSession: (sessionId) => store.getSessionProject(sessionId),
  };
  // Embedding settings are read at call time as well (secret slot included);
  // createOpenAiEmbedding keeps the live object reference.
  const embeddingProvider = createOpenAiEmbedding(config.recall.embedding);

  // ── Phase B journal extract worker (MIGRATION-PHASE-B-EXTRACT.md): this is
  // the ONE driven extraction lane now. Every drive point below (flush,
  // 15-min maintenance, review drains incl. the 60s startup backfill) invokes
  // journalExtract.pump() — the claim → all-bounded-chunks →
  // validated-terminal-verdict → same-tx-commit loop over the ONE durable
  // journal instance. The legacy Extractor/advanceProcessed drivers are
  // retired here (no full-range ack, no middle-omission prompt, no
  // fallbackOnBadJson event, no provenance:"user" shortcut); the legacy class
  // itself stays untouched in src/extract.ts for migration tooling/tests.
  const extractJournalSeam = createJournalExtractSeam(journal);
  // ── Phase B policy lane trigger wiring (MIGRATION-PHASE-B-WORKER-REVIEW.md
  // F1 fix, this lane): the journal's generation machinery now has REAL owned
  // runtime triggers over the ONE durable journal instance:
  //
  // - extractJobsPolicyGate is the plugin-OWNED in-flight signal. A volatile
  //   master pause / extract-module disable ABORTS the in-flight aux transport
  //   and the claimed pump round atomically with the durable policy bump
  //   (bumpPolicyGeneration cancels queued jobs immediately; a claimed job's
  //   late commit is journal-rejected stale-policy-generation and the journal
  //   itself releases that claim back to the queue). Re-enable rebuilds the
  //   gate + worker AND replans coverage over pending sources — accepted
  //   pending jobs DRAIN through the re-armed schedulers, never discarded.
  // - Consent revocation (episodeLearning.enabled on→off) and episode purges
  //   trip the durable cancellation generation through the SHARED business
  //   journal policy lane (injected into createMemoryBusiness below), so the
  //   browser remote, /memory command, and memory tool reach the journal the
  //   same way — previously bumpCancellationGeneration/revokeSessions had ZERO
  //   production call sites (review F1).
  // - Per-source forget/correct tombstones bound the affected evidence to the
  //   row's own lineage (journal-derived meta.sessionId = the stable opaque
  //   journal session identity, plus its evidence sourceRefs) — never a
  //   blanket revoke of all user data; shared lane in src/business.ts.
  // A mount that starts DISABLED (insert-with-disabled or config-disabled
  // mount) never bumps anything: the case4 quiescence contract requires the
  // accepted job's journal artifacts byte-identical across those mounts.
  let extractJobsPolicyGate = new AbortController();
  /** The effective job-policy switch tracked across volatile updates so each
   *  transition trips the journal policy EXACTLY once (off at boot = inert
   *  mounted mount, never a bump). */
  let extractJobsOn = config.enabled && config.modules.extract;
  let extractJobsPolicyGen = 0;
  /** Last consent state, to trip the durable cancellation exactly once on
   *  revoke and to replan coverage on re-arm (deferred-drain semantics).
   *  episodeState's live view is declared below; the raw config read is the
   *  same live source (volatile commits land on this object in place). */
  let episodeConsentOn = config.episodeLearning.enabled === true;
  const buildExtractWorker = (): JournalExtractWorker =>
    createJournalExtractWorker({
      seam: extractJournalSeam,
      store,
      log: (message) => log(message),
      onDeferredJob: (job) => { trackAcceptedJob(job); },
      callLlm: createJournalExtractCall({
        // Live routing, explicit per request: the exported resolveAuxModelRoute
        // reads the volatile config view AT EACH CALL (fail loud when
        // unconfigured; never a guessed fallback route).
        streamChunks: (options) => ctx.llm.stream(options),
        route: () => resolveAuxModelRoute(ctx, config),
        maxOutputTokens: () => extractSettings.maxOutputTokens,
      }),
      // Owned shutdown deadline cancellation reaches this lane through the
      // genuine request signal, UNITED with the plugin's owned job-policy gate
      // (a pause/disable aborts in-flight transports without touching the
      // store-drain discipline): per-call timeout ⊕ shutdown deadline ⊕ job
      // policy. The worker never holds txs across the await, and claims are
      // durably released on abort.
      deadlineSignal: combineAbortSignals(shutdownDeadlineGate.signal, extractJobsPolicyGate.signal),
      settings: {
        get enabled() { return readModule("extract"); },
        get timeoutMs() { return config.extract.timeoutMs; },
        get minImportance() { return config.extract.minImportance; },
        get dedup() { return config.extract.dedup; },
      },
    });
  let journalExtract: JournalExtractWorker = buildExtractWorker();
  /** One owned pause: durable job-policy generation_plus in-flight abort, in
   *  ONE synchronous section (no await between them; the volatile handler's
   *  single event carries both). */
  const pauseExtractJobs = (reason: string): void => {
    extractJobsPolicyGen = journal.bumpPolicyGeneration(reason);
    journalExtract.dispose();
    extractJobsPolicyGate.abort(new Error(`extract job policy: ${reason}`));
  };
  /** One owned resume: fresh in-flight gate + worker, and coverage replan so
   *  accepted pending jobs drain through the already re-armed schedulers —
   *  pause-cancelled queued rows are re-created as FRESH jobs under the new
   *  policy generation (the journal's documented policy-change semantics),
   *  never blindly discarded and never resurrected as their old rows. */
  const resumeExtractJobs = (reason: string): void => {
    extractJobsPolicyGate = new AbortController();
    journalExtract = buildExtractWorker();
    try {
      const planned = journal.planJobsCoverPending();
      log(
        "extract jobs resumed (", reason, "): coverage replanned as",
        planned.jobsCreated, "jobs /", planned.chunksPlanned, "chunks; policy generation", journal.getPolicyGeneration(),
      );
    } catch (error) {
      console.warn("[dsh-self-improved] extract jobs resume: coverage replan failed (startup recovery still replans at boot):", String(error));
    }
  };
  if (config.debug) {
    log("journal extract worker ready (journal claim → bounded chunks → validated verdicts; legacy advanceProcessed lane retired)");
  }
  // Episode-learning runtime state as a LIVE view over config (volatile edits
  // reach capture/review/recall/skill gates without a restart).
  const episodeState = {
    get enabled() { return config.episodeLearning.enabled; },
    get captureArguments() { return config.episodeLearning.captureArguments; },
    get maxChars() { return config.episodeLearning.resultExcerptChars; },
    get reviewEnabled() { return config.episodeLearning.reviewEnabled; },
    get confidenceFloor() { return config.episodeLearning.confidenceFloor; },
    get expiryDays() { return config.episodeLearning.expiryDays; },
    get operationalRecallEnabled() { return config.episodeLearning.operationalRecallEnabled; },
    get maxRecallResults() { return config.episodeLearning.maxRecallResults; },
    get maxRecallChars() { return config.episodeLearning.maxRecallChars; },
    get skillMinEpisodes() { return config.episodeLearning.skillMinEpisodes; },
    get skillDraftsEnabled() { return config.episodeLearning.skillDraftsEnabled; },
  };
  const episodeReviewGate = new EpisodeReviewAbortGate();
  episodeReviewGate.setEnabled(config.enabled && episodeState.enabled && episodeState.reviewEnabled);
  const episodeSkillDraftGate = new EpisodeReviewAbortGate();
  episodeSkillDraftGate.setEnabled(config.enabled && episodeState.enabled && episodeState.skillDraftsEnabled);
  // Ingress (L0): the capture/flush listener. The accepted pump is TRACKED so
  // shutdown can drain it before store.close(); readModule()'s shuttingDown
  // gate refuses new capture work once shutdown starts.
  const captureDispose = installCapture(
    ctx,
    store,
    { enabled: () => readModule("capture") },
    () => {
      if (!extractSettings.enabled) return undefined;
      // Journal extract worker pump (replaces the legacy advanceProcessed
      // driver): journal claim → all bounded chunks → validated terminal
      // verdicts → same-tx commit/acks, throttled and deadline-bounded.
      const pumpJob = trackAcceptedJob(extractSettings.flushDrain ? journalExtract.drain() : journalExtract.pump());
      if (!extractSettings.flushDrain) {
        void pumpJob.catch((error) => console.warn("[dsh-self-improved] extract pump error:", String(error)));
        return undefined;
      }
      // flushDrain: the flush barrier awaits THIS promise — the same tracked job
      // that the shutdown drain joins, so the flush's own accepted extraction
      // commits before the teardown's store close.
      return pumpJob;
    },
    {
      enabled: () => readModule("capture") && episodeState.enabled && episodeState.captureArguments,
      maxChars: () => episodeState.maxChars,
    },
    // Phase B producer lane: atomic journal enqueue of only direct-human
    // minimized evidence (MIGRATION-PHASE-B-CAPTURE.md); the raw JSONL slice
    // write is gone, so this sink IS the plugin-owned persistence for
    // personal-lane text from here on.
    journalCaptureSink,
  );
  log("capture + extract installed");

  // Timed evolution pipeline (dsh-schedule is not part of the headless base assembly, so in-process timers are used)
  const consolidateLlm = makeLlmCall(ctx, config, "memory-consolidate", 2000);
  // Live view again: consolidation defaults follow volatile edits without restart.
  const consolidateSettings = {
    get scenesEnabled() { return config.consolidate.scenesEnabled; },
    get sceneMaxMemories() { return config.consolidate.sceneMaxMemories; },
    get personaMaxMemories() { return config.consolidate.personaMaxMemories; },
    get sceneBatchSize() { return config.consolidate.sceneBatchSize; },
  };
  const consolidator = new Consolidator(
    store,
    consolidateSettings,
    async ({ system, user, signal }) =>
      consolidateLlm({ system, user, signal: combineAbortSignals(signal, shutdownDeadlineGate.signal) }),
    embeddingProvider,
  );
  const episodeReviewLlm = makeLlmCall(ctx, config, "episode-review", 2000);
  const episodeSkillDraftLlm = makeLlmCall(ctx, config, "episode-skill", 3000);
  let lastEvolveTs = 0;
  /**
   * Run one evolution round.
   * heavy=true: run consolidation (heavy LLM work) — for nightly review / manual / startup backfill;
   * heavy=false: only free maintenance (decay + governance) — used by the 15-minute timer round.
   * force=true: ignore the "no new memories" skip condition (manual/nightly/startup).
   */
  const runEvolution = async (force: boolean, heavy = true): Promise<Record<string, unknown>> => {
    const summary: Record<string, unknown> = { forced: force, heavy };
    const jobs: Array<Promise<unknown>> = [];
    const newest = store.newestMemoryTs();
    const hasNew = newest > lastEvolveTs;
    const doHeavy = heavy && (force || hasNew) && (readModule("consolidate") || readModule("evolve"));
    if (doHeavy && readModule("consolidate")) {
      jobs.push(
        consolidator.consolidate().then((r) => { summary.consolidate = r; }).catch((e) => console.warn("[dsh-self-improved] consolidate error:", String(e))),
      );
    }
    if (doHeavy && readModule("evolve") && config.evolve.skillSynthesis.enabled) {
      // The v0.2 migration retires legacy writers that publish straight into an
      // active skill root. Resume only through the draft → evaluation → human
      // activation workflow; until then preserve the block visibly in the result.
      summary.skills = {
        status: "retired",
        reason: "awaiting inactive draft, evaluation, and human activation workflow",
      };
    }
    if (heavy && !doHeavy) summary.skipped = "no new memories";
    // Free maintenance: decay + growth governance (no LLM, runs every round)
    jobs.push(
      Promise.resolve()
        .then(() =>
          applyDecay(store, {
            enabled: config.evolve.decay.enabled,
            minAgeDays: config.evolve.decay.minAgeDays,
            threshold: config.evolve.decay.threshold,
            retentionDays: config.evolve.decay.retentionDays,
            maxActiveMemories: config.evolve.decay.maxActiveMemories,
          }),
        )
        .then((r) => { summary.decay = r; if (r.decayed > 0 || r.deleted > 0) log("decay applied:", JSON.stringify(r)); })
        .catch((e) => console.warn("[dsh-self-improved] decay error:", String(e))),
    );
    jobs.push(
      Promise.resolve()
        .then(() => {
          const g = {
            personaVersions: store.prunePersonaVersions(config.housekeeping.personaVersions),
            scenes: store.pruneScenes(config.housekeeping.maxScenes, config.housekeeping.sceneActiveRatio),
            slices: store.pruneConversationSlices(Date.now() - config.housekeeping.conversationRetentionDays * 86_400_000),
          };
          if (g.personaVersions > 0 || g.scenes > 0 || g.slices > 0) log("housekeeping:", JSON.stringify(g));
          return g;
        })
        .then((g) => { summary.housekeeping = g; })
        .catch((e) => console.warn("[dsh-self-improved] housekeeping error:", String(e))),
    );
    await Promise.allSettled(jobs);
    if (newest > 0) lastEvolveTs = newest;
    return summary;
  };
  // Full review: drain pending extraction (journal worker lane) + full evolution (consolidation/maintenance; active skill writers retired)
  const fullReview = async (reason: string): Promise<Record<string, unknown>> => {
    const pumped = await journalExtract.pump().catch((e) => {
      console.warn("[dsh-self-improved] review pump error:", String(e));
      return { ...emptyJournalExtractPump(), errors: 1 };
    });
    const episodeReviewPromise =
      config.enabled && episodeState.enabled && episodeState.reviewEnabled
        ? runEpisodeReview(
            store,
            // The scheduled/manual lane shares the SAME per-call aux transport
            // (deadline ⊕ per-call timeout) but has NO per-request carrier: its
            // lane signal stays the consent gate — shared command/no-carrier
            // review behavior is unchanged apart from the new per-call bound.
            episodeReviewAuxCall,
            {
              confidenceFloor: episodeState.confidenceFloor,
              expiryDays: episodeState.expiryDays,
            },
            episodeReviewGate.getSignal(),
          )
            .then((s) => { log("episode review:", JSON.stringify(s)); return s; })
            .catch((e) => console.warn("[dsh-self-improved] episode review error:", String(e)))
        : null;
    const summary = await runEvolution(true, true);    if (episodeReviewPromise) await episodeReviewPromise;
    if (readModule("evolve") && episodeState.enabled && episodeState.skillDraftsEnabled) {
      const skillDraftConsentSignal = combineAbortSignals(episodeSkillDraftGate.getSignal(), shutdownDeadlineGate.signal);
      const drafts = await createSkillDraftsFromEpisodes(
        store,
        ({ system, user, signal }) => episodeSkillDraftLlm({ system, user, signal }),
        { prefix: "", maxDrafts: 100, minIndependentSupport: episodeState.skillMinEpisodes, signal: skillDraftConsentSignal },
      );
      summary.skillDrafts = drafts;
    }
    if (readModule("evolve") && episodeState.enabled && config.evolve.skillSynthesis.enabled) {
      summary.legacyEpisodeSkillSynthesis = {
        status: "retired",
        reason: "use episodeLearning.skillDraftsEnabled for inactive proposals; active publication is disabled",
      };
    }
    log(`review(${reason}) done:`, JSON.stringify({ pumped, ...summary }));
    return { pumped, ...summary };
  };

  // Unified timer management: follows the master switch — off stops all timers immediately, on re-arms them automatically
  let timer: NodeJS.Timeout | undefined;
  let reviewTimer: NodeJS.Timeout | undefined;
  let startupTimer: NodeJS.Timeout | undefined;
  let startupReviewDone = false;

  const parseHHMM = (s: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return 22 * 3_600_000; // fall back to 22:00 on invalid config
    return Number(m[1]) * 3_600_000 + Number(m[2]) * 60_000;
  };

  // 15-minute round: only "extraction + free maintenance", no heavy LLM work (evolution is left to nightly review / manual / startup backfill)
  const armMaintenanceTimer = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!config.enabled) return;
    timer = setInterval(() => {
      trackAcceptedJob(
        journalExtract
          .pump()
          .then(() => runEvolution(false, false))
        .then((s) => {
          if (s.skipped) log("maintenance round (no heavy work)");
          // Stale pending episodes: never assembled in-window → ambiguous (never learned from)
          if (config.enabled && episodeState.enabled) {
            // Starvation recovery: stranded pending events get re-assembled here too
            try {
              for (const sessionId of store.sessionsWithPendingEpisodeEvents(500)) {
                assembleSessionEpisodes(store, sessionId);
              }
            } catch (e) {
              console.warn("[dsh-self-improved] maintenance episode assembly error:", String(e));
            }
            const closed = closeStalePendingEpisodes(store, 30 * 60_000);
            if (closed > 0) log("stale pending episodes closed:", closed);
            // Retention: bound episode/evidence growth to retentionDays
            try {
              const cutoff = Date.now() - config.episodeLearning.retentionDays * 86_400_000;
              const purged = store.purgeEpisodes({ olderThanTs: cutoff });
              const total = purged.episodes + purged.steps + purged.events + purged.memories;
              if (total > 0) log("episode retention purge:", JSON.stringify(purged));
            } catch (e) {
              console.warn("[dsh-self-improved] episode retention purge error:", String(e));
            }
          }
        })
        .catch((e) => console.warn("[dsh-self-improved] extract pump error:", String(e))),
      );
    }, config.extract.intervalMinutes * 60_000);
    timer.unref?.();
  };

  // Nightly review: run once a day at config.review.time (default 22:00); re-arm for the next day after it completes
  const armNightlyReview = (): void => {
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = undefined;
    if (!config.enabled || !config.review.enabled) return;
    const hhmm = parseHHMM(config.review.time);
    const now = new Date();
    const target = new Date(now);
    target.setHours(0, 0, 0, 0);
    target.setTime(target.getTime() + hhmm);
    let diff = target.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 3_600_000;
    reviewTimer = setTimeout(() => {
      trackAcceptedJob(
        fullReview("nightly")
          .catch((e) => console.warn("[dsh-self-improved] nightly review error:", String(e)))
          .finally(() => armNightlyReview()),
      );
    }, diff);
    reviewTimer.unref?.();
    log("nightly review armed at", config.review.time, "(in", Math.round(diff / 60_000), "min)");
  };

  // Startup backfill: ~60s after boot, run one full review if there are active memories (no data lost on restart, no waiting for nighttime); runs only once
  const armStartupReview = (): void => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    if (startupReviewDone || !config.enabled) return;
    if (store.newestMemoryTs() <= 0) return;
    startupTimer = setTimeout(() => {
      startupReviewDone = true;
      trackAcceptedJob(
        fullReview("startup").catch((e) => console.warn("[dsh-self-improved] startup review error:", String(e))),
      );
    }, 60_000);
    startupTimer.unref?.();
  };

  const syncSchedulers = (): void => {
    armMaintenanceTimer();
    armNightlyReview();
    armStartupReview();
  };
  syncSchedulers();
  log("schedulers armed (15min maintenance, nightly review, 60s startup backfill); disabling master switch stops all timers");

  // ④ Memory tools (M1/M4): runtime-toggleable (tools module)
  let toolsDispose: (() => void) | null = null;
  const syncTools = (): void => {
    const want = readModule("tools");
    if (want && !toolsDispose) {
      toolsDispose = registerMemoryTools(ctx, store, config.searchLimit, {
        confidenceFloor: () => episodeState.confidenceFloor,
        maxResults: () => episodeState.maxRecallResults,
      // SHARED LANE: the model's memory_forget runs the SAME single-owner
      // policy boundary as the browser remote and /memory forget (command
      // caller lane). Resolved per call, so a later-created businessApi counts.
      }, () => {
        if (!businessApi) return null;
        return (id: string) =>
          businessApi!.forget({ peerId: null, source: "command" }, id, { token: "" }, undefined);
      });
      log("tools enabled");
    } else if (!want && toolsDispose) {
      toolsDispose();
      toolsDispose = null;
      log("tools disabled");
    }
  };
  syncTools();

  // ⑤ Recall injection (M3): automatically inject relevant memories at agent/pre-step.
  // Scope comes directly from the event's owning Agent, never mutable cross-session state.
  const projectKeyOfAgent = (agent: unknown): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (agent as any)?.session?.header?.cwd;
    return projectKeyFromCwd(typeof cwd === "string" ? cwd : "");
  };
  const sessionIdForAgent = (agent: unknown): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (agent as any)?.id;
    return typeof id === "string" ? id : "";
  };
  // Recall settings as a LIVE view: volatile edits reach the next query.
  const rec: { recallSettings: RecallSettings } = { recallSettings: {
    get strategy() { return config.recall.strategy === "hybrid" ? ("hybrid" as const) : ("keyword" as const); },
    get maxResults() { return config.recall.maxResults; },
    get scoreThreshold() { return config.recall.scoreThreshold; },
    get timeoutMs() { return config.recall.timeoutMs; },
    get relevanceMargin() { return config.recall.relevanceMargin; },
    get minImportance() { return config.recall.minImportance; },
  } };
  const recall = new RecallService(store, rec.recallSettings, embeddingProvider);
  const injectionCtl = {
    enabled: () => readModule("recall"),
    get maxHits() { return config.recall.maxResults; },
    get maxChars() { return config.recall.maxInjectChars; },
    get debug() { return config.debug; },
    projectKeyOf: projectKeyOfAgent,
    sessionIdOf: sessionIdForAgent,
    maxInjectPerTurn: config.recall.maxInjectPerTurn,
    onInjected: (ids: string[]) => store.recordAccess(ids),
    // Phase 4: operational lane (live getters so settings hot-apply reaches each pre-step)
    operational: {
      enabled: () => readModule("recall") && episodeState.enabled && episodeState.operationalRecallEnabled,
      get maxResults() { return episodeState.maxRecallResults; },
      get maxChars() { return episodeState.maxRecallChars; },
      get confidenceFloor() { return episodeState.confidenceFloor; },
    },
  };
  installRecallInjection(ctx, recall, injectionCtl);
  log("recall injection installed (strategy:", rec.recallSettings.strategy, ", project scoping on)");

  /**
   * Phase E live activations. The skills service is OPTIONAL on other hosts, so
   * this is an inject child: without it the skill commands refuse instead of
   * pretending, and every other lane is unaffected. Learned skills are
   * registered as user-invocable only and are disposed with this child, so an
   * activation is always reversible and never outlives the plugin.
   */
  let skillActivation: {
    activate(draftId: string, projectId?: string): { ok: boolean; reason: string };
    rollback(name: string): { ok: boolean; reason: string };
    sweep(): { deactivated: number; failed: string[] };
    list(): Array<{ name: string; draftId: string; evaluationVersion: string | null; activatedAt: number }>;
  } | null = null;
  ctx.inject(["skills"], (skillsChild) => {
    try {
      const activator = new LearnedSkillActivator({ register: (skill) => skillsChild.skills.register(skill) });
      const deps = { store, activator };
      // Boot order matters: drop anything whose support is already invalidated,
      // then replay only drafts that are STILL durably activated.
      const swept = deactivateInvalidatedDrafts(deps);
      if (swept.failed.length) console.warn("[dsh-self-improved] skill deactivation failed for:", swept.failed.join(", "));
      const restored = restoreActivatedDrafts(deps);
      if (restored.failed.length) console.warn("[dsh-self-improved] skill restore failed for:", restored.failed.join(", "));
      if (restored.restored > 0) log(`skills: restored ${restored.restored} activated learned skill(s)`);
      skillsChild.effect(() => () => { activator.dispose(); skillActivation = null; }, "dsh-self-improved: learned skill activations");
      skillActivation = {
        activate: (draftId, projectId) => activateDraftSkill(deps, draftId, projectId),
        rollback: (name) => rollbackDraftSkill(deps, name),
        sweep: () => deactivateInvalidatedDrafts(deps),
        list: () => activator.list().map((record) => ({ name: record.name, draftId: record.draftId,
          evaluationVersion: record.evaluationVersion, activatedAt: record.activatedAt })),
      };
      log("skills: learned skill activations available (user-invocable only)");
    } catch (error) {
      console.warn("[dsh-self-improved] skill activation lane unavailable:", String(error instanceof Error ? error.message : error));
      skillActivation = null;
    }
  });

  let browserChannel: BrowserChannel | null = null;
  let businessApi: ReturnType<typeof createMemoryBusiness> | null = null;
  try {
    // The shared business API (commands+browser use the same instance); the
    // remote surface is the ONLY config-namespace-free action channel on rc.2.
    // ONE gate set for both operator-door continuity reads, so the inventory
    // and the Continue action can never disagree about what is excluded.
    const continuityUiGates = {
      enabled: () => !shuttingDown && readModule("capture") && config.continuity?.enabled === true,
      healthy: () => continuityStorePolicyHealthy,
      allows: (id: string, projectId?: string) => !(config.continuity?.excludedSessionIds ?? []).includes(id)
        && (projectId === undefined || !(config.continuity?.excludedProjectIds ?? []).includes(projectId)),
    };
    const businessDeps = {
      store,
      enabled: () => config.enabled,
      continuityStatus: (sessionId: string, signal?: AbortSignal) =>
        readContinuityUiInventory(store, ctx.sessionQuery, sessionId, continuityUiGates, signal, Date.now(), continuityHandoffReader?.()),
      continuityOfferNotes: (targetSessionId: string, jobId: string, signal?: AbortSignal) =>
        readContinuityUiOfferNotes(store, ctx.sessionQuery, targetSessionId, jobId, continuityUiGates, continuityHandoffReader?.(), signal),
      // Overview status: WHY nothing can be continued, as bounded counts plus an
      // actionable reason. Counts only — never an id, body or envelope.
      // Reading the live activation lane first DROPS any skill whose support is
      // no longer activated, so what an operator observes is what is still
      // eligible; the sweep only ever removes, and is bounded by live skills.
      learnedSkills: () => {
        const lane = skillActivation;
        if (!lane) return { available: false, active: [], deactivated: 0 };
        const sweep = lane.sweep();
        return { available: true, deactivated: sweep.deactivated,
          active: lane.list().slice(0, 50).map((entry) => ({ name: entry.name,
            evaluationVersion: entry.evaluationVersion, activatedAt: entry.activatedAt })) };
      },
      continuityLane: () => readContinuityLaneStatus(store, {
        enabled: config.continuity?.enabled === true,
        bodyEnabled: summaryEnabled(),
        route: currentSummaryRoute() !== null,
        healthy: !shuttingDown && continuityStorePolicyHealthy,
      }) as unknown as Record<string, unknown>,
      skillsPrefix: () => config.evolve.skillSynthesis.prefix,
      skillsRoot: () => skillsRootLive(),
      episodeEnabled: () => episodeState.enabled,
      deleteSkill,
      episodeDryReview: (callSignal?: AbortSignal) =>
        (!shuttingDown && episodeState.enabled && episodeState.reviewEnabled) ? episodeReviewRun(true, callSignal) : null,
      // SHARED journal mutation policy lane (review F1): every mutating
      // business op reaches the ONE durable journal the same way on every
      // surface (broker remote step-1/step-2 handshake, /memory command,
      // memory tool). Bounded per-source actions only — the session/project
      // memory ids select source coordinates through the journal's durable
      // derivation ledger, never through model-declared session identities.
      journalPolicy: {
        revokeMemoryEvidence: (memoryIds: readonly string[], reason: string) =>
          journal.revokeMemoryEvidence({ memoryIds, reason }),
        cancelPending: (reason: string) => journal.bumpCancellationGeneration(reason),
      } satisfies MemoryJournalMutationPolicy,
      log: (...args: unknown[]): void => { if (config.debug) console.log("[dsh-self-improved]", ...args); },
    };
    businessApi = createMemoryBusiness(businessDeps);
    ctx.effect(() => {
      const businessDispose = registerMemoryBusinessRemote(ctx, businessDeps, businessApi!);
      return businessDispose;
    }, "memory business remote");
    log("memory business remote registered (selfImproved namespace)");
  } catch (error) {
    console.warn("[dsh-self-improved] business remote registration failed:", String(error));
  }

  // ⑥ CLI command (M5): /memory (active when the host provides a commands service); hot-registers/unregisters following the master switch
  // Browser channel is created below (⑧) but referenced by the episode-review
  // delegate (dry-review summaries publish into the served snapshot), so the
  // variable must exist before the command handler can run — command
  // invocations can only arrive after apply() finishes anyway.
  /**
   * The REAL aux transport of one review LLM call. `signal` is the review
   * lane's combined signal (per-call carrier cancel ⊕ consent gate). It is
   * united with the owned shutdown deadline and ONE per-call timeout abort —
   * created PER CALL so a timeout (or caller cancel) of one episode's request
   * can never abort an unrelated concurrent call — and the union reaches
   * `GenerateOptions.signal` of the genuine ctx.llm.stream request (the rc.2
   * adapter contract MUST honor it), not a post-hoc warning.
   */
  const EPISODE_REVIEW_CALL_TIMEOUT_MS = 180_000;
  const episodeReviewAuxCall = async ({ system, user, signal }: { system: string; user: string; signal: AbortSignal })=> {
    return episodeReviewLlm({
      system,
      user,
      signal: combineAbortSignals(signal, shutdownDeadlineGate.signal, AbortSignal.timeout(EPISODE_REVIEW_CALL_TIMEOUT_MS)),
    });
  };
  /** Manual/nightly episode review runner. dry=true → validateOnly commits (nothing persists).
   *  Gated on the master switch + episodeLearning.enabled + reviewEnabled; publishes the
   *  summary line into the browser snapshot so the UI can display the last verdict.
   *
   *  `callSignal` carries the RPC dryReview call's own carrier cancellation
   *  (rc.2 Gateway invocation signal forwarded by the business deps). It is
   *  UNIONED with the plugin-owned consent gate — never replacing it — so:
   *  - a per-call cancel stops ONLY that review pass (the shared consent gate
   *    is not tripped, other passes/lanes keep running);
   *  - disabling/discharging the consent gate still cancels every queued AND
   *    in-flight pass (its abort rides the same combined lane signal);
   *  - the command lane (/memory episode-review) passes no carrier and remains
   *    bounded by the gate + downstream per-call timeout exactly as before. */
  const episodeReviewRun = (dry: boolean, callSignal?: AbortSignal): Promise<EpisodeReviewSummary> => {
    if (!config.enabled || !episodeState.enabled || !episodeState.reviewEnabled) {
      return Promise.reject(
        new Error("Episode learning review is disabled (dsh-self-improved enabled / episodeLearning.enabled / reviewEnabled)"),
      );
    }
    // Already-aborted carrier passes through as the FIRST already-aborted input
    // (src/shutdown-v02.ts combineAbortSignals), so a pre-cancelled call never
    // opens review work; a mid-flight cancel aborts the pass it belongs to.
    const laneSignal = combineAbortSignals(callSignal, episodeReviewGate.getSignal());
    return trackAcceptedJob(
      runEpisodeReview(
        store,
        episodeReviewAuxCall,
        {
          confidenceFloor: episodeState.confidenceFloor,
          expiryDays: episodeState.expiryDays,
          dryRun: dry,
        },
        laneSignal,
      ).then((s) => {
        log("episode review" + (dry ? " (dry-run)" : "") + ":", JSON.stringify(s));
        try {
          browserChannel?.episodeStatus(JSON.stringify({ ...s, dryRun: dry, at: Date.now() }));
        } catch { /* status publish is best effort */ }
        return s;
      }),
    );
  };
  let commandsDispose: (() => void) | null = null;
  const syncCommands = (): void => {
    if (!config.enabled) {
      if (commandsDispose) {
        commandsDispose();
        commandsDispose = null;
        log("/memory command disabled");
      }
      return;
    }
    if (commandsDispose) return;
    commandsDispose = installMemoryCommands(ctx, store, {
      evolve: () => trackAcceptedJob(fullReview("manual")),
      isEnabled: () => config.enabled,
      // Live getters: hot-applied synthesis settings must reach `/memory browser --json`
      // and the synthesized-skill flags without re-registering the command.
      skillsPrefix: () => config.evolve.skillSynthesis.prefix,
      skillsRoot: () => skillsRootLive(),
      episodeEnabled: () => episodeState.enabled,
      episodeReview: (dry) => episodeReviewRun(dry),
      // rc.2: browse/forget/correct run the shared business lane (one
      // operation, shared with the typed browser remote).
      business: businessApi ?? undefined,
      // Phase E: live when the skills service mounted; the commands refuse
      // (never pretend) when this host exposes no skills service.
      skillActivation: () => skillActivation,
    });
    if (commandsDispose) {
      log("memory command installed (/memory)");
    } else {
      log("commands service unavailable in this host — skip /memory command");
    }
  };
  syncCommands();

  // ⑦ Hot apply (rc.2 volatile semantics): editable fields are volatile (see
  // the Config schema + runtime-config.ts policy); the `loader/volatile-update`
  // hook above commits edits into the live view and re-derives consent gates,
  // schedulers, and tools/commands registrations without a restart.
  // `storageRoot` is init-only: that edit alone still goes through the full
  // restart lifecycle above (store close under drain).

  // ⑧ Memory browser data channels.
  // ⑧a LEGACY (rc.6/rc.8 hosts): Config-namespace channel stays available only
  //    via the legacy settingsApi and remains inert on rc.2 (fail-closed
  //    scaffolding, kept for rollback/compat evidence).
  // ⑧b rc.2 channel: the typed business Remote surface (src/business.ts) —
  //    entry-addressed reads plus authorized one-shot-challenge mutating calls
  //    and cancellable model work, shared with commands/tools.
  browserChannel = installBrowserChannel({
    ctx,
    store,
    skillsPrefix: () => config.evolve.skillSynthesis.prefix,
    skillsRoot: () => skillsRootLive(),
    deleteSkill,
    episodeEnabled: () => episodeState.enabled,
    episodeDryReview: (callSignal?: AbortSignal) =>
      (!shuttingDown && episodeState.enabled && episodeState.reviewEnabled) ? episodeReviewRun(true, callSignal) : null,
    log,
  });
  log("memory browser channel installed (legacy CAM; rc.2 path is the typed business remote)");


  // ⑥ Background pipeline (from M2 on: extract/consolidate/evolve, driven by dsh-schedule)
  // Note: M0 confirmed the schedule service is not in the headless base assembly; gate on the assembly when introducing it

  log("dsh-self-improved loaded (full M5 build)");

  // ── Effect-owned lifecycle ordering (Phase A) ──────────────────────────
  // Accepted-work/shutdown contract (numbered steps documented inside
  // registerShutdownDrain): the effect is registered LAST so cordis's reverse
  // disposal order runs it FIRST on unload/restart/disable. This fixes
  // runtime-report defect D1: the old teardown closed the store while the
  // capture/flush listener was still registered and while untracked pump
  // promises were mid-flight, so an accepted flush extraction insert was lost
  // with `database is not open`. The coordinator round-59 deadline race (warn
  // → wipe the tracking set → close while accepted jobs still ran) is closed
  // by the new policy in src/shutdown-v02.ts: owned deadline cancellation,
  // retained ownership, and a storage close that fires only after every
  // accepted job in the live tracking set actually settles.
  registerShutdownDrain(ctx, {
    onShutdownStart: () => {
      shuttingDown = true;
      stopContinuityWorker(); // immediate owned provider abort, join promise below
      stopContinuityRuntime(); // unload: ingress/abort stop, committed progress survives
      syncContinuityProjection();
    },
    dropIngress: () => {
      captureDispose();
      // Phase B journal lane ingress close: after this point NO flush may
      // enqueue journal work (owned-write barrier). Recovery of any work
      // enqueued earlier remains guaranteed by recoverStartup on next boot.
      journalIngressClosed = true;
    },
    preClose: () => {
      journalExtract.dispose();
      // ③ consent gates cancel review and draft work; timers lock out; ④ registrations.
      episodeReviewGate.abort();
      episodeSkillDraftGate.abort();
      if (timer) { clearInterval(timer); timer = undefined; }
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = undefined; }
      if (reviewTimer) { clearTimeout(reviewTimer); reviewTimer = undefined; }
      if (toolsDispose) { toolsDispose(); toolsDispose = null; }
      if (commandsDispose) { commandsDispose(); commandsDispose = null; }
      if (browserChannel) browserChannel.stop();
    },
    cancel: () => {
      // Deadline cancellation through the plugin's OWNED signals: the review and
      // draft consent gates stop in-flight episode work, and every other
      // accepted auxiliary LLM lane already unions its per-call timeout signal
      // with this controller (combineAbortSignals above), so the abort reaches
      // ctx.llm.stream through GenerateOptions.signal — not a warning-only path.
      shutdownDeadlineGate.abort(new Error("shutdown deadline reached: cancelling owned auxiliary work"));
    },
    jobs: acceptedJobs,
    close: () => store.close(),
    warn: (message: string) => console.warn("[dsh-self-improved]", message),
  });
}

/**
 * Phase A lifecycle boundary (accepted-work shutdown ordering) moved to
 * src/shutdown-v02.ts — the coordinator round-59 probe showed the previous
 * in-file implementation racing `Promise.allSettled` with the 5 s budget and
 * then warning/clearing the tracking set/closing the store WHILE accepted jobs
 * were still running. The bound is now SAFE: cancellation through owned
 * signals at the deadline, ownership retained until actual settlement, and a
 * store close that is deferred (never raced) underneath unsettled accepted
 * work. Re-exported unchanged so the focused suites keep binding the exact
 * symbols apply() uses (single implementation, no reimplementation).
 */
export {
  SHUTDOWN_DRAIN_BUDGET_MS,
  combineAbortSignals,
  registerShutdownDrain,
} from "./shutdown-v02.js";
export type { ShutdownDrainTarget } from "./shutdown-v02.js";
