/**
 * dsh-self-improved — DeepSeek Harness long-term memory and self-evolution plugin (fully local).
 *
 * M1 status: memory store (SQLite + FTS5 + sqlite-vec skeleton) + L0 capture persistence + memory/conversation search tools.
 * Design docs live in docs/ (design/ and research/).
 */
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";
import { settingsNamespace } from "@deepseek-ai/dsh-settings";

// Service type augmentation: pull the `declare module '@deepseek-ai/cordis'` type augmentations from the dsh-* packages into this compilation.
import "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-agent";
import "@deepseek-ai/dsh-system-prompt";
import "@deepseek-ai/dsh-llm";
import "@deepseek-ai/dsh-schedule";
import "@deepseek-ai/dsh-session-query";

import { MemoryStore, defaultMemoryDir } from "./storage.js";
import { installCapture, projectKeyFromCwd } from "./capture.js";
import { closeStalePendingEpisodes, repairEpisodeConsistency, assembleSessionEpisodes } from "./episodes.js";
import { registerMemoryTools } from "./tools.js";
import { Extractor, type ExtractSettings } from "./extract.js";
import { RecallService, createOpenAiEmbedding, renderCuratedProfile, type RecallSettings } from "./recall.js";
import { installRecallInjection } from "./inject.js";
import { Consolidator } from "./consolidate.js";
import { applyDecay, synthesizeSkills, deleteSkill } from "./evolve.js";
import { installMemoryCommands, installBrowserChannel } from "./commands.js";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

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
  ctx: any,
  config: Config,
  purpose: string,
  maxTokens: number | (() => number),
): (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }) => Promise<string> {
  return async (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }): Promise<string> => {
      const maxOutputTokens = typeof maxTokens === "function" ? maxTokens() : maxTokens;
      const assembler = new BlockAssembler();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const options: any = {
        messages: [
          createUserMessage({
            content: [{ type: "text", text: input.user }],
            source: { kind: "plugin", plugin: "dsh-self-improved" },
          }),
        ],
        system: input.system,
        maxTokens: maxOutputTokens,
        purpose,
        signal: input.signal,
      };
      if (input.sessionId) options.sessionId = input.sessionId;
      // Extraction/consolidation/skill model: explicit config first, then fall back to the DSH default model (agentDefaultModel)
      let provider = config.extract.provider;
      let model = config.extract.model;
      if (!provider || !model) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dm = (ctx as any).get?.("agentDefaultModel");
          const sel = dm?.currentSelection?.();
          if (sel && typeof sel.provider === "string" && typeof sel.model === "string") {
            provider = provider || sel.provider;
            model = model || sel.model;
          }
        } catch {
          /* stay unconfigured when there is no default model */
        }
      }
      if (provider) options.provider = provider;
      if (model) options.model = model;
      for await (const chunk of ctx.llm.stream(options)) {
        input.signal.throwIfAborted();
        assembler.push(chunk);
      }
      return assembler
        .blocks()
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
    };
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
  }),
});

export function apply(ctx: Context, config: Config): void {
  const log = (...args: unknown[]): void => {
    if (config.debug) console.log("[dsh-self-improved]", ...args);
  };

  // ① Settings namespace: the web UI settings page auto-renders the form + hot-apply via settings/updated (the core of the anytime on/off switch)
  const ns = settingsNamespace("dsh-self-improved");
  const scope = ctx.settings.register(ns, Config, { base: config });
  log("settings namespace registered");

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
  // Episode-learning runtime state (hot-applied by scope.watch below)
  const episodeState = { enabled: config.episodeLearning.enabled, captureArguments: config.episodeLearning.captureArguments, maxChars: config.episodeLearning.resultExcerptChars };
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
    const summary = await runEvolution(true, true);
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

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => {
    if (timer) clearInterval(timer);
    if (startupTimer) clearTimeout(startupTimer);
    if (reviewTimer) clearTimeout(reviewTimer);
    if (commandsDispose) commandsDispose();
    store.close();
  });
  log("schedulers armed (15min maintenance, nightly review, 60s startup backfill); disabling master switch stops all timers");

  // ④ Memory tools (M1/M4): runtime-toggleable (tools module)
  let toolsDispose: (() => void) | null = null;
  const syncTools = (): void => {
    const want = readModule("tools");
    if (want && !toolsDispose) {
      toolsDispose = registerMemoryTools(ctx, store, config.searchLimit);
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
  const projectKeyOfPayload = (payload: unknown): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (payload as any)?.agent?.session?.header?.cwd;
    return projectKeyFromCwd(typeof cwd === "string" ? cwd : "");
  };
  const sessionIdForPayload = (payload: unknown): string => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = (payload as any)?.agent?.id;
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
    projectKeyOf: projectKeyOfPayload,
    sessionIdOf: sessionIdForPayload,
    maxInjectPerTurn: config.recall.maxInjectPerTurn,
    onInjected: (ids: string[]) => store.recordAccess(ids),
  };
  installRecallInjection(ctx, recall, injectionCtl);
  log("recall injection installed (strategy:", rec.recallSettings.strategy, ", project scoping on)");

  // ⑥ CLI command (M5): /memory (active when the host provides a commands service); hot-registers/unregisters following the master switch
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
    });
    if (commandsDispose) {
      log("memory command installed (/memory)");
    } else {
      log("commands service unavailable in this host — skip /memory command");
    }
  };
  syncCommands();

  // ⑦ Hot apply: settings/updated → update runtime state (toggle anytime, no restart).
  //    Every settings field the UI exposes is applied to its live consumer object:
  //    extract/recall/consolidate read their settings objects per operation, and the
  //    decay/skill/housekeeping rounds rebuild options from `config` each run.
  scope.watch((next) => {
    state.enabled = next.enabled;
    state.modules = { ...next.modules };
    episodeState.enabled = next.episodeLearning.enabled;
    episodeState.captureArguments = next.episodeLearning.captureArguments;
    episodeState.maxChars = next.episodeLearning.resultExcerptChars;
    config.episodeLearning.retentionDays = next.episodeLearning.retentionDays;
    extractSettings.enabled = readModule("extract");
    extractSettings.intervalMinutes = next.extract.intervalMinutes;
    extractSettings.batchMaxChars = next.extract.batchMaxChars;
    extractSettings.maxOutputTokens = next.extract.maxOutputTokens;
    extractSettings.timeoutMs = next.extract.timeoutMs;
    extractSettings.dedup = next.extract.dedup;
    extractSettings.fallbackOnBadJson = next.extract.fallbackOnBadJson;
    extractSettings.minImportance = next.extract.minImportance;
    extractSettings.flushDrain = next.extract.flushDrain;
    extractSettings.provenanceFilter = next.extract.provenanceFilter === "off" ? ("off" as const) : ("strict" as const);
    extractSettings.requireEvidence = next.extract.requireEvidence;
    rec.recallSettings.strategy = next.recall.strategy === "hybrid" ? "hybrid" : "keyword";
    rec.recallSettings.maxResults = next.recall.maxResults;
    rec.recallSettings.scoreThreshold = next.recall.scoreThreshold;
    rec.recallSettings.timeoutMs = next.recall.timeoutMs;
    rec.recallSettings.relevanceMargin = next.recall.relevanceMargin;
    rec.recallSettings.minImportance = next.recall.minImportance;
    injectionCtl.maxHits = next.recall.maxResults;
    injectionCtl.maxChars = next.recall.maxInjectChars;
    injectionCtl.maxInjectPerTurn = next.recall.maxInjectPerTurn;
    injectionCtl.debug = next.debug;
    consolidateSettings.scenesEnabled = next.consolidate.scenesEnabled;
    consolidateSettings.sceneMaxMemories = next.consolidate.sceneMaxMemories;
    consolidateSettings.personaMaxMemories = next.consolidate.personaMaxMemories;
    consolidateSettings.sceneBatchSize = next.consolidate.sceneBatchSize;
    // Per-round option builders read the config object: keep it in sync so the
    // next decay/skill/housekeeping round and the shared LLM route pick up changes.
    config.debug = next.debug;
    config.extract.intervalMinutes = next.extract.intervalMinutes;
    config.extract.provider = next.extract.provider;
    config.extract.model = next.extract.model;
    config.evolve.decay.enabled = next.evolve.decay.enabled;
    config.evolve.decay.minAgeDays = next.evolve.decay.minAgeDays;
    config.evolve.decay.threshold = next.evolve.decay.threshold;
    config.evolve.decay.retentionDays = next.evolve.decay.retentionDays;
    config.evolve.decay.maxActiveMemories = next.evolve.decay.maxActiveMemories;
    config.evolve.skillSynthesis.enabled = next.evolve.skillSynthesis.enabled;
    config.evolve.skillSynthesis.minImportance = next.evolve.skillSynthesis.minImportance;
    config.evolve.skillSynthesis.skillsRoot = next.evolve.skillSynthesis.skillsRoot;
    config.evolve.skillSynthesis.prefix = next.evolve.skillSynthesis.prefix;
    config.evolve.skillSynthesis.maxSkills = next.evolve.skillSynthesis.maxSkills;
    config.housekeeping.personaVersions = next.housekeeping.personaVersions;
    config.housekeeping.maxScenes = next.housekeeping.maxScenes;
    config.housekeeping.sceneActiveRatio = next.housekeeping.sceneActiveRatio;
    config.housekeeping.conversationRetentionDays = next.housekeeping.conversationRetentionDays;
    config.recall.embedding.baseUrl = next.recall.embedding.baseUrl;
    config.recall.embedding.apiKey = next.recall.embedding.apiKey;
    config.recall.embedding.model = next.recall.embedding.model;
    config.recall.embedding.dimensions = next.recall.embedding.dimensions;
    config.recall.embedding.timeoutMs = next.recall.embedding.timeoutMs;
    // The embedding provider reads the shared config object per call, so the
    // fields above hot-apply without rebuilding it.
    // Tool default result limit: cheap to re-register when it changes.
    if (next.searchLimit !== config.searchLimit) {
      config.searchLimit = next.searchLimit;
      if (toolsDispose) { toolsDispose(); toolsDispose = null; }
    }
    syncTools();
    syncCommands(); // master switch off → unregister the /memory command; on → register again
    // Nightly review time/switch hot-changed: re-arm the timers
    if (next.review.enabled !== config.review.enabled || next.review.time !== config.review.time) {
      config.review = { enabled: next.review.enabled, time: next.review.time };
    }
    // Any runtime config change → re-arm the feature timers uniformly (master switch off = all timers stop immediately)
    syncSchedulers();
    log("runtime config applied:", "enabled=", next.enabled, "modules=", JSON.stringify(next.modules));
  });

  // ⑧ Memory browser data channel (see installBrowserChannel in commands.ts).
  // Mutating ops run a 3-step one-shot challenge handshake: the executing
  // credential is a short-TTL challenge bound to the exact op + arguments,
  // published through the snapshot and consumed atomically — captured payloads
  // cannot be replayed for arbitrary actions.
  const browserChannel = installBrowserChannel({
    ctx,
    store,
    skillsPrefix: () => config.evolve.skillSynthesis.prefix,
    skillsRoot: () => config.evolve.skillSynthesis.skillsRoot,
    deleteSkill,
    log,
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => browserChannel.stop());
  log("memory browser channel ready (dsh-self-improved-browser)");

  // ⑥ Background pipeline (from M2 on: extract/consolidate/evolve, driven by dsh-schedule)
  // Note: M0 confirmed the schedule service is not in the headless base assembly; gate on the assembly when introducing it

  log("dsh-self-improved loaded (full M5 build)");
}
