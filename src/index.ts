/**
 * dsh-self-improved — DeepSeek Harness long-term memory and self-evolution plugin (fully local).
 *
 * M1 status: memory store (SQLite + FTS5 + sqlite-vec skeleton) + L0 capture persistence + memory/conversation search tools.
 * Design docs live in docs/ (design/ and research/).
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";

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
import type { Context as CordisContext } from "@deepseek-ai/cordis";
import { evaluateTerminalFinish } from "./compat-v02.js";
import { installCapture, projectKeyFromCwd } from "./capture.js";
import { closeStalePendingEpisodes, repairEpisodeConsistency, assembleSessionEpisodes } from "./episodes.js";
import { EpisodeReviewAbortGate, runEpisodeReview } from "./episode-review.js";
import type { EpisodeReviewSummary } from "./episode-review.js";
import { registerMemoryTools } from "./tools.js";
import { Extractor, type ExtractSettings } from "./extract.js";
import { RecallService, createOpenAiEmbedding, renderCuratedProfile, type RecallSettings } from "./recall.js";
import { installRecallInjection } from "./inject.js";
import { Consolidator } from "./consolidate.js";
import { applyDecay, synthesizeSkills, synthesizeSkillsFromEpisodes, deleteSkill } from "./evolve.js";
import { installMemoryCommands, installBrowserChannel } from "./commands.js";
import type { BrowserChannel } from "./commands.js";
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
  apiKey: string;
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
 * Episode learning (Phases 1+2 slice): capture + redaction + assembly. Only these
 * three fields in THIS slice; the plan adds review/recall/skill fields in later
 * phases (see docs/episode-learning-implementation-plan.md).
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
  /** Phase 5: minimum reviewed-successful-episode group size for automatic skill synthesis (2–10, default 2) */
  skillMinEpisodes: number;
}

export interface Config {
  /** L1 master switch: turn off/on at any time, hot-switched, no restart */
  enabled: boolean;
  /** Probe/debug logging */
  debug: boolean;
  /** Memory store root directory; empty = $DSH_HOME/memory */
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
  consolidate: { scenesEnabled: boolean; sceneMaxMemories: number; personaMaxMemories: number; sceneBatchSize: number };
  /** M4 self-evolution parameters */
  evolve: {
    decay: { enabled: boolean; minAgeDays: number; threshold: number; retentionDays: number; maxActiveMemories: number };
    skillSynthesis: { enabled: boolean; minImportance: number; skillsRoot: string; prefix: string; maxSkills: number };
  };
  /** M6 growth governance: caps and cleanup for persona versions/scenes/conversation slices */
  housekeeping: {
    personaVersions: number;
    maxScenes: number;
    sceneActiveRatio: number;
    conversationRetentionDays: number;
  };
  /** M6 nightly review schedule: run one full evolution at a fixed time every day (extraction drain + consolidation + skills + governance) */
  review: { enabled: boolean; time: string };
  /** Episode learning (capture/assembly; later phases add review/recall/skill fields) */
  episodeLearning: EpisodeLearningConfig;
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
      if (input.sessionId) options.sessionId = input.sessionId as GenerateOptions["sessionId"];
      // Terminal-finish validation: ONLY an explicit `stop` finish yields
      // completed text for these tool-less auxiliary reviews; `tool-calls`,
      // `max-tokens`, `aborted`, `error`, unknown reasons, and a truncated
      // stream (no finish chunk) must all fail rather than feed partial
      // reviews back (evaluateTerminalFinish implements the matrix).
      let finishKind: string | null = null;
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
function resolveAuxModelRoute(ctx: Context, config: Config): { provider: string; model: string } {
  let provider = config.extract.provider?.trim() ?? "";
  let model = config.extract.model?.trim() ?? "";
  if (provider && model) return { provider, model };
  try {
    const selection = (ctx as CordisContext).agentDefaultModel?.currentSelection?.();
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
export const Config = z.object({
  enabled: z.boolean().default(true),
  debug: z.boolean().default(false),
  storageRoot: z.string().default(""),
  searchLimit: z.number().min(1).max(50).default(5),
  modules: z.object({
    capture: z.boolean().default(true),
    extract: z.boolean().default(true),
    consolidate: z.boolean().default(true),
    evolve: z.boolean().default(true),
    recall: z.boolean().default(true),
    tools: z.boolean().default(true),
  }),
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
  }),
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
      apiKey: z.string().default(""),
      model: z.string().default(""),
      dimensions: z.number().min(64).default(1024),
      timeoutMs: z.number().min(1000).default(10000),
    }),
  }),
  consolidate: z.object({
    scenesEnabled: z.boolean().default(false),
    sceneMaxMemories: z.number().min(1).default(50),
    personaMaxMemories: z.number().min(1).default(30),
    sceneBatchSize: z.number().min(1).max(20).default(8),
  }),
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
  }),
  housekeeping: z.object({
    personaVersions: z.number().min(1).default(10),
    maxScenes: z.number().min(1).default(50),
    sceneActiveRatio: z.number().min(0).max(1).default(0.3),
    conversationRetentionDays: z.number().min(0).default(90),
  }),
  review: z.object({
    enabled: z.boolean().default(true),
    time: z.string().default("22:00"),
  }),
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
  }),
});

export function apply(ctx: Context, config: Config): void {
  const log = (...args: unknown[]): void => {
    if (config.debug) console.log("[dsh-self-improved]", ...args);
  };

  // ① Settings page policy (rc.2): Config comes from the Loader entry, so the
  //    legacy `settingsNamespace`/`register`/`watch` pipeline is gone. We only
  //    opt into the settings UI's auto-generated config page. Changing a
  //    (nonvolatile) entry restarts this fiber — unload runs every dispose and
  //    apply() re-runs with the new validated config. Hot continuous state is
  //    intentionally NOT rebuilt here: Phase A keeps restart semantics, which
  //    are conservative (well-tested disable-then-reapply behavior) and avoid
  //    the legacy mutation-mirror bugs.
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
  log("settings page policy registered (restart-on-change semantics)");

  // Runtime mutable state (M5: master/module switches can be flipped at any time without a restart)
  const state = { enabled: config.enabled, modules: { ...config.modules } };
  const readModule = (m: keyof ModuleSwitches): boolean => state.enabled && state.modules[m];

  // ② Memory store (M1): SQLite + FTS5 + sqlite-vec skeleton
  const dir = config.storageRoot.trim() || defaultMemoryDir();
  const store = new MemoryStore(dir);
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
  const extractSettings: ExtractSettings = {
    enabled: readModule("extract"),
    intervalMinutes: config.extract.intervalMinutes,
    batchMaxChars: config.extract.batchMaxChars,
    maxOutputTokens: config.extract.maxOutputTokens,
    timeoutMs: config.extract.timeoutMs,
    dedup: config.extract.dedup,
    fallbackOnBadJson: config.extract.fallbackOnBadJson,
    minImportance: config.extract.minImportance,
    flushDrain: config.extract.flushDrain,
    provenanceFilter: config.extract.provenanceFilter === "off" ? ("off" as const) : ("strict" as const),
    requireEvidence: config.extract.requireEvidence,
    projectId: "",
    projectIdForSession: (sessionId) => store.getSessionProject(sessionId),
  };
  const embeddingProvider = createOpenAiEmbedding(config.recall.embedding);

  const extractLlm = makeLlmCall(ctx, config, "memory-extract", () => extractSettings.maxOutputTokens);

  const extractor = new Extractor(store, extractSettings, async ({ system, user, sessionId, signal }) => {
    if (config.debug) {
      console.log("[dsh-self-improved] extract llm input:", typeof user, "len:", String(user).length, "session:", sessionId);
    }
    return extractLlm({ system, user, sessionId, signal });
  }, embeddingProvider);
  // Episode-learning runtime state (re-read at every apply; config is nonvolatile/restart)
  const episodeState = { enabled: config.episodeLearning.enabled, captureArguments: config.episodeLearning.captureArguments, maxChars: config.episodeLearning.resultExcerptChars, reviewEnabled: config.episodeLearning.reviewEnabled, confidenceFloor: config.episodeLearning.confidenceFloor, expiryDays: config.episodeLearning.expiryDays, operationalRecallEnabled: config.episodeLearning.operationalRecallEnabled, maxRecallResults: config.episodeLearning.maxRecallResults, maxRecallChars: config.episodeLearning.maxRecallChars, skillMinEpisodes: config.episodeLearning.skillMinEpisodes };
  const episodeReviewGate = new EpisodeReviewAbortGate();
  episodeReviewGate.setEnabled(state.enabled && episodeState.enabled && episodeState.reviewEnabled);
  installCapture(ctx, store, { enabled: () => readModule("capture") }, () => {
    if (!extractSettings.enabled) return;
    const result = extractor.pump();
    if (extractSettings.flushDrain) return result;
    result.catch((error) => console.warn("[dsh-self-improved] extract pump error:", String(error)));
  }, {
    enabled: () => readModule("capture") && episodeState.enabled && episodeState.captureArguments,
    maxChars: () => episodeState.maxChars,
  });
  log("capture + extract installed");

  // Timed evolution pipeline (dsh-schedule is not part of the headless base assembly, so in-process timers are used)
  const consolidateLlm = makeLlmCall(ctx, config, "memory-consolidate", 2000);
  const consolidateSettings = {
    scenesEnabled: config.consolidate.scenesEnabled,
    sceneMaxMemories: config.consolidate.sceneMaxMemories,
    personaMaxMemories: config.consolidate.personaMaxMemories,
    sceneBatchSize: config.consolidate.sceneBatchSize,
  };
  const consolidator = new Consolidator(
    store,
    consolidateSettings,
    async ({ system, user, signal }) => consolidateLlm({ system, user, signal }),
    embeddingProvider,
  );
  const skillLlm = makeLlmCall(ctx, config, "memory-skill", 3000);
  const episodeReviewLlm = makeLlmCall(ctx, config, "episode-review", 2000);
  const episodeSkillLlm = makeLlmCall(ctx, config, "episode-skill", 3000);
  let lastEvolveTs = 0;
  /**
   * Run one evolution round.
   * heavy=true: run consolidation + skills (heavy LLM work) — for nightly review / manual / startup backfill;
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
    if (doHeavy && readModule("evolve")) {
      jobs.push(
        synthesizeSkills(
          store,
          async ({ system, user, signal }) => skillLlm({ system, user, signal }),
          {
            enabled: config.evolve.skillSynthesis.enabled,
            minImportance: config.evolve.skillSynthesis.minImportance,
            skillsRoot: config.evolve.skillSynthesis.skillsRoot,
            prefix: config.evolve.skillSynthesis.prefix,
            maxSkills: config.evolve.skillSynthesis.maxSkills,
          },
          config.evolve.skillSynthesis.skillsRoot,
        )
          .then((n) => { summary.skills = n; if (n > 0) log("skills synthesized:", n); })
          .catch((e) => console.warn("[dsh-self-improved] skill synthesis error:", String(e))),
      );
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
  // Full review: drain pending extraction + full evolution (consolidation/skills/decay/governance)
  const fullReview = async (reason: string): Promise<Record<string, unknown>> => {
    const pumped = await extractor.pump().catch((e) => {
      console.warn("[dsh-self-improved] review pump error:", String(e));
      return { sessions: 0, memories: 0, skipped: 0, errors: 1 };
    });
    const episodeReviewPromise =
      state.enabled && episodeState.enabled && episodeState.reviewEnabled
        ? runEpisodeReview(
            store,
            async ({ system, user, signal }) => episodeReviewLlm({ system, user, signal }),
            {
              confidenceFloor: episodeState.confidenceFloor,
              expiryDays: episodeState.expiryDays,
            },
            episodeReviewGate.getSignal(),
          )
            .then((s) => { log("episode review:", JSON.stringify(s)); return s; })
            .catch((e) => console.warn("[dsh-self-improved] episode review error:", String(e)))
        : null;
    const summary = await runEvolution(true, true);
    if (episodeReviewPromise) await episodeReviewPromise;
    // Phase 5 (OPT-IN, runs only from fullReview — never per-flush): episode-to-skill
    // synthesis needs the Phase 3 review to have committed its derived memories first.
    if (
      readModule("evolve") &&
      episodeState.enabled &&
      config.evolve.skillSynthesis.enabled
    ) {
      try {
        const n = await synthesizeSkillsFromEpisodes(
          store,
          async ({ system, user, signal }) => episodeSkillLlm({ system, user, signal }),
          {
            skillsRoot: config.evolve.skillSynthesis.skillsRoot,
            prefix: config.evolve.skillSynthesis.prefix,
            maxSkills: config.evolve.skillSynthesis.maxSkills,
            minEpisodes: episodeState.skillMinEpisodes,
          },
        );
        if (n > 0) log("episode skills synthesized:", n);
        summary.episodeSkills = n;
      } catch (e) {
        console.warn("[dsh-self-improved] episode skill synthesis error:", String(e));
      }
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
    if (!state.enabled) return;
    timer = setInterval(() => {
      void extractor
        .pump()
        .then(() => runEvolution(false, false))
        .then((s) => {
          if (s.skipped) log("maintenance round (no heavy work)");
          // Stale pending episodes: never assembled in-window → ambiguous (never learned from)
          if (state.enabled && episodeState.enabled) {
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
              const total = purged.episodes + purged.steps + purged.events;
              if (total > 0) log("episode retention purge:", JSON.stringify(purged));
            } catch (e) {
              console.warn("[dsh-self-improved] episode retention purge error:", String(e));
            }
          }
        })
        .catch((e) => console.warn("[dsh-self-improved] extract pump error:", String(e)));
    }, config.extract.intervalMinutes * 60_000);
    timer.unref?.();
  };

  // Nightly review: run once a day at config.review.time (default 22:00); re-arm for the next day after it completes
  const armNightlyReview = (): void => {
    if (reviewTimer) clearTimeout(reviewTimer);
    reviewTimer = undefined;
    if (!state.enabled || !config.review.enabled) return;
    const hhmm = parseHHMM(config.review.time);
    const now = new Date();
    const target = new Date(now);
    target.setHours(0, 0, 0, 0);
    target.setTime(target.getTime() + hhmm);
    let diff = target.getTime() - now.getTime();
    if (diff <= 0) diff += 24 * 3_600_000;
    reviewTimer = setTimeout(() => {
      void fullReview("nightly")
        .catch((e) => console.warn("[dsh-self-improved] nightly review error:", String(e)))
        .finally(() => armNightlyReview());
    }, diff);
    reviewTimer.unref?.();
    log("nightly review armed at", config.review.time, "(in", Math.round(diff / 60_000), "min)");
  };

  // Startup backfill: ~60s after boot, run one full review if there are active memories (no data lost on restart, no waiting for nighttime); runs only once
  const armStartupReview = (): void => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
    if (startupReviewDone || !state.enabled) return;
    if (store.newestMemoryTs() <= 0) return;
    startupTimer = setTimeout(() => {
      startupReviewDone = true;
      void fullReview("startup").catch((e) => console.warn("[dsh-self-improved] startup review error:", String(e)));
    }, 60_000);
    startupTimer.unref?.();
  };

  const syncSchedulers = (): void => {
    armMaintenanceTimer();
    armNightlyReview();
    armStartupReview();
  };
  syncSchedulers();

  // Effect-owned teardown (Phase A): every owned job drains or is cancelled
  // before the store closes; timers lock out first (below on the old handler).
  ctx.effect(
    () => () => {
      episodeReviewGate.abort();
      if (timer) clearInterval(timer);
      if (startupTimer) clearTimeout(startupTimer);
      if (reviewTimer) clearTimeout(reviewTimer);
      if (toolsDispose) toolsDispose();
      if (commandsDispose) commandsDispose();
      if (browserChannel) browserChannel.stop();
      store.close();
    },
    "shutdown drain + store close",
  );
  log("schedulers armed (15min maintenance, nightly review, 60s startup backfill); disabling master switch stops all timers");

  // ④ Memory tools (M1/M4): runtime-toggleable (tools module)
  let toolsDispose: (() => void) | null = null;
  const syncTools = (): void => {
    const want = readModule("tools");
    if (want && !toolsDispose) {
      toolsDispose = registerMemoryTools(ctx, store, config.searchLimit, {
        confidenceFloor: () => episodeState.confidenceFloor,
        maxResults: () => episodeState.maxRecallResults,
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
  const rec: { recallSettings: RecallSettings } = { recallSettings: {
    strategy: config.recall.strategy === "hybrid" ? "hybrid" : "keyword",
    maxResults: config.recall.maxResults,
    scoreThreshold: config.recall.scoreThreshold,
    timeoutMs: config.recall.timeoutMs,
    relevanceMargin: config.recall.relevanceMargin,
    minImportance: config.recall.minImportance,
  } };
  const recall = new RecallService(store, rec.recallSettings, embeddingProvider);
  const injectionCtl = {
    enabled: () => readModule("recall"),
    maxHits: config.recall.maxResults,
    maxChars: config.recall.maxInjectChars,
    debug: config.debug,
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

  // ⑥ CLI command (M5): /memory (active when the host provides a commands service); hot-registers/unregisters following the master switch
  // Browser channel is created below (⑧) but referenced by the episode-review
  // delegate (dry-review summaries publish into the served snapshot), so the
  // variable must exist before the command handler can run — command
  // invocations can only arrive after apply() finishes anyway.
  let browserChannel: BrowserChannel | null = null;
  /** Manual/nightly episode review runner. dry=true → validateOnly commits (nothing persists).
   *  Gated on the master switch + episodeLearning.enabled + reviewEnabled; publishes the
   *  summary line into the browser snapshot so the UI can display the last verdict. */
  const episodeReviewRun = (dry: boolean): Promise<EpisodeReviewSummary> => {
    if (!state.enabled || !episodeState.enabled || !episodeState.reviewEnabled) {
      return Promise.reject(
        new Error("Episode learning review is disabled (dsh-self-improved enabled / episodeLearning.enabled / reviewEnabled)"),
      );
    }
    return runEpisodeReview(
      store,
      async ({ system, user, signal }) => episodeReviewLlm({ system, user, signal }),
      {
        confidenceFloor: episodeState.confidenceFloor,
        expiryDays: episodeState.expiryDays,
        dryRun: dry,
      },
      episodeReviewGate.getSignal(),
    ).then((s) => {
      log("episode review" + (dry ? " (dry-run)" : "") + ":", JSON.stringify(s));
      try {
        browserChannel?.episodeStatus(JSON.stringify({ ...s, dryRun: dry, at: Date.now() }));
      } catch { /* status publish is best effort */ }
      return s;
    });
  };
  let commandsDispose: (() => void) | null = null;
  const syncCommands = (): void => {
    if (!state.enabled) {
      if (commandsDispose) {
        commandsDispose();
        commandsDispose = null;
        log("/memory command disabled");
      }
      return;
    }
    if (commandsDispose) return;
    commandsDispose = installMemoryCommands(ctx, store, {
      evolve: () => fullReview("manual"),
      isEnabled: () => state.enabled,
      // Live getters: hot-applied synthesis settings must reach `/memory browser --json`
      // and the synthesized-skill flags without re-registering the command.
      skillsPrefix: () => config.evolve.skillSynthesis.prefix,
      skillsRoot: () => config.evolve.skillSynthesis.skillsRoot,
      episodeEnabled: () => episodeState.enabled,
      episodeReview: (dry) => episodeReviewRun(dry),
    });
    if (commandsDispose) {
      log("memory command installed (/memory)");
    } else {
      log("commands service unavailable in this host — skip /memory command");
    }
  };
  syncCommands();

  // ⑦ Hot apply (legacy) replaced by rc.2 restart semantics: every Config field
  // is nonvolatile in Phase A, so a settings change unloads this fiber cleanly
  // (running all effect-owned disposers, incl. the shutdown drain) and reloads
  // it with the new validated config. Runtime consumers re-read config at
  // every apply; no mutation-mirroring scope.watch path remains.

  // ⑧ Memory browser data channel (see installBrowserChannel in commands.ts).
  // Mutating ops run a 3-step one-shot challenge handshake: the executing
  // credential is a short-TTL challenge bound to the exact op + arguments,
  // published through the snapshot and consumed atomically — captured payloads
  // cannot be replayed for arbitrary actions.
  browserChannel = installBrowserChannel({
    ctx,
    store,
    skillsPrefix: () => config.evolve.skillSynthesis.prefix,
    skillsRoot: () => config.evolve.skillSynthesis.skillsRoot,
    deleteSkill,
    episodeEnabled: () => episodeState.enabled,
    episodeDryReview: () =>
      episodeState.enabled && episodeState.reviewEnabled ? episodeReviewRun(true) : null,
    log,
  });
  log("memory browser channel ready (dsh-self-improved-browser)");

  // ⑥ Background pipeline (from M2 on: extract/consolidate/evolve, driven by dsh-schedule)
  // Note: M0 confirmed the schedule service is not in the headless base assembly; gate on the assembly when introducing it

  log("dsh-self-improved loaded (full M5 build)");
}
