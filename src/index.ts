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
import { installCapture } from "./capture.js";
import { registerMemoryTools } from "./tools.js";
import { Extractor, type ExtractSettings } from "./extract.js";
import { RecallService, createOpenAiEmbedding, type RecallSettings } from "./recall.js";
import { installRecallInjection } from "./inject.js";
import { Consolidator } from "./consolidate.js";
import { applyDecay, synthesizeSkills, deleteSkill } from "./evolve.js";
import { installMemoryCommands, browserSnapshot } from "./commands.js";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";

export const name = "self-improved";

/** Required host services (Cordis inject list; M1 adds sessionQuery for conversation full-text search) */
export const inject = ["sessions", "settings", "tools", "sessionQuery", "llm"] as const;

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
  /** Drop extracted results whose importance is below this value (noise reduction, default 3) */
  minImportance: number;
  /** headless: drain extraction synchronously on flush */
  flushDrain: boolean;
  /** Extraction model (leave empty to follow the DSH default) */
  model: string;
  provider: string;
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
  embedding: EmbeddingConfig;
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
  consolidate: { sceneMaxMemories: number; personaMaxMemories: number; sceneBatchSize: number };
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
    minImportance: z.number().min(1).max(10).default(3),
    flushDrain: z.boolean().default(false),
    model: z.string().default(""),
    provider: z.string().default(""),
  }),
  recall: z.object({
    strategy: z.string().default("keyword"),
    maxResults: z.number().min(1).max(20).default(5),
    scoreThreshold: z.number().min(0).default(0),
    timeoutMs: z.number().min(1000).default(5000),
    maxInjectChars: z.number().min(100).default(800),
    embedding: z.object({
      baseUrl: z.string().default(""),
      apiKey: z.string().default(""),
      model: z.string().default(""),
      dimensions: z.number().min(64).default(1024),
      timeoutMs: z.number().min(1000).default(10000),
    }),
  }),
  consolidate: z.object({
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
      enabled: z.boolean().default(true),
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
  log("memory store ready:", dir);

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
  };
  const embeddingProvider = createOpenAiEmbedding(config.recall.embedding);

  // Shared LLM caller (used by extraction/consolidation/skill synthesis; reuses the DSH model stack)
  const makeLlmCall = (purpose: string, maxTokens: number) =>
    async (input: { system: string; user: string; sessionId?: string; signal: AbortSignal }): Promise<string> => {
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
        maxTokens,
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
  const extractLlm = makeLlmCall("memory-extract", extractSettings.maxOutputTokens);

  const extractor = new Extractor(store, extractSettings, async ({ system, user, sessionId, signal }) => {
    if (config.debug) {
      console.log("[dsh-self-improved] extract llm input:", typeof user, "len:", String(user).length, "session:", sessionId);
    }
    return extractLlm({ system, user, sessionId, signal });
  }, embeddingProvider);
  installCapture(ctx, store, { enabled: () => readModule("capture") }, () => {
    if (!extractSettings.enabled) return;
    const result = extractor.pump();
    if (extractSettings.flushDrain) return result;
    result.catch((error) => console.warn("[dsh-self-improved] extract pump error:", String(error)));
  });
  log("capture + extract installed");

  // Timed evolution pipeline (dsh-schedule is not part of the headless base assembly, so in-process timers are used)
  const consolidateLlm = makeLlmCall("memory-consolidate", 2000);
  const consolidator = new Consolidator(
    store,
    {
      sceneMaxMemories: config.consolidate.sceneMaxMemories,
      personaMaxMemories: config.consolidate.personaMaxMemories,
      sceneBatchSize: config.consolidate.sceneBatchSize,
    },
    async ({ system, user, signal }) => consolidateLlm({ system, user, signal }),
    embeddingProvider,
  );
  const skillLlm = makeLlmCall("memory-skill", 3000);
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

  // ⑤ Recall injection (M3): automatically inject relevant memories at agent/pre-step
  const recallSettings: RecallSettings = {
    strategy: config.recall.strategy === "hybrid" ? "hybrid" : "keyword",
    maxResults: config.recall.maxResults,
    scoreThreshold: config.recall.scoreThreshold,
    timeoutMs: config.recall.timeoutMs,
  };
  const recall = new RecallService(store, recallSettings, embeddingProvider);
  installRecallInjection(ctx, recall, {
    enabled: () => readModule("recall"),
    maxHits: config.recall.maxResults,
    maxChars: config.recall.maxInjectChars,
    debug: config.debug,
  });
  log("recall injection installed (strategy:", recallSettings.strategy, ")");

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
    commandsDispose = installMemoryCommands(ctx, store, { evolve: () => fullReview("manual"), isEnabled: () => state.enabled });
    if (commandsDispose) {
      log("memory command installed (/memory)");
    } else {
      log("commands service unavailable in this host — skip /memory command");
    }
  };
  syncCommands();

  // ⑦ Hot apply: settings/updated → update runtime state (toggle anytime, no restart)
  scope.watch((next) => {
    state.enabled = next.enabled;
    state.modules = { ...next.modules };
    extractSettings.enabled = readModule("extract");
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

  // ⑧ Memory browser data channel (the settings-page frontend can read/operate memories without a session):
  //    dedicated namespace dsh-self-improved-browser: snapshot = snapshot JSON, action = operation sent by the frontend
  const browserNs = settingsNamespace("dsh-self-improved-browser");
  const BrowserSchema = z.object({
    snapshot: z.string().default("{}"),
    action: z.string().default(""),
    detail: z.string().default(""),
  });
  const browserScope = ctx.settings.register(browserNs, BrowserSchema);
  let lastSnapshotJson = "";
  let lastHandledAction = "";
  const refreshBrowserSnapshot = (): void => {
    try {
      const json = JSON.stringify(browserSnapshot(store));
      if (json === lastSnapshotJson) return;
      lastSnapshotJson = json;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cur = (browserScope.get() ?? {}) as any;
      browserScope.replace({ snapshot: json, action: cur.action ?? "" }).catch(() => { /* best effort */ });
    } catch {
      /* noop */
    }
  };
  const handleBrowserAction = (raw: string): void => {
    if (!raw || raw === lastHandledAction) return;
    lastHandledAction = raw;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const action = JSON.parse(raw) as any;
      // Detail: return the full memory on demand (content is truncated in the snapshot)
      if (action.op === "detail" && typeof action.id === "string") {
        const m = store.getMemory(action.id);
        if (m) {
          browserScope
            .replace({ snapshot: lastSnapshotJson, action: "", detail: JSON.stringify(m) })
            .catch(() => { /* noop */ });
        }
        return; // detail does not need a snapshot refresh
      }
      if (action.op === "forget" && typeof action.id === "string") {
        store.forgetMemory(action.id);
        log("browser action: forget", action.id.slice(0, 8));
      } else if (action.op === "correct" && typeof action.id === "string" && typeof action.content === "string") {
        const old = store.getMemory(action.id);
        if (old) {
          store.insertMemory({ kind: old.kind, content: action.content, importance: old.importance, supersedes: old.id });
          store.setMemoryStatus(old.id, "corrected");
          log("browser action: correct", action.id.slice(0, 8));
        }
      } else if (action.op === "deleteSkill" && typeof action.name === "string") {
        if (deleteSkill(action.name, config.evolve.skillSynthesis.skillsRoot)) {
          log("browser action: deleteSkill", action.name);
        }
      }
    } catch {
      /* noop */
    }
    lastSnapshotJson = ""; // force a refresh on the next round
    refreshBrowserSnapshot();
    browserScope.replace({ snapshot: lastSnapshotJson, action: "" }).catch(() => { /* noop */ });
  };
  browserScope.watch((next, _prev) => {
    if (next.action) handleBrowserAction(next.action);
  });
  refreshBrowserSnapshot();
  const browserTimer = setInterval(refreshBrowserSnapshot, 60_000);
  browserTimer.unref?.();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ctx as any).on("dispose", () => clearInterval(browserTimer));
  log("memory browser channel ready (dsh-self-improved-browser)");

  // ⑥ Background pipeline (from M2 on: extract/consolidate/evolve, driven by dsh-schedule)
  // Note: M0 confirmed the schedule service is not in the headless base assembly; gate on the assembly when introducing it

  log("dsh-self-improved loaded (full M5 build)");
}
