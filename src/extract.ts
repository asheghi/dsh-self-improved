/**
 * L1 extraction pipeline (M2 + Hermes hardening): consumes L0 conversation slices → LLM extracts atomic memories → validation/dedup → storage.
 *
 * Conservative gate (M7):
 * - Only durable user facts / preferences / explicit corrections / stable environment
 *   and workflow facts are extracted. System/plugin/skill-injected text is filtered at
 *   capture time (`injected` flag) and again at prompt-build time; tool results are
 *   never rendered into the extraction prompt.
 * - The extractor no longer emits `instruction` memories (repo SOPs belong to dsh-skill);
 *   the kind stays storage-valid for back-compat only.
 * - Task-local constraints, acceptance criteria, temporary plans/status and completed-work
 *   logs are rejected with distinct counters.
 * - Evidence is required: every accepted memory carries a short verbatim quote.
 */
import type { MemoryStore, MemoryKind, ConversationSliceRecord, MemoryMetaInput } from "./storage.js";
import type { EmbeddingProvider } from "./recall.js";
import {
  findNeighbors,
  classify,
  mergeDuplicate,
  tokenJaccard,
  DEFAULT_DEDUPE_SETTINGS,
  type DedupeSettings,
} from "./dedupe.js";

export interface ExtractedMemoryDraft {
  kind: MemoryKind;
  content: string;
  importance: number;
  confidence: number;
  evidence: string;
  /** role of the evidence. Only user evidence is accepted by the structural gate. */
  sourceRole: "user" | "assistant";
  /** Suggested durability scope; global is accepted only for user-profile-like facts/preferences. */
  scope: "global" | "project";
}

/** LLM call abstraction: takes a prompt and returns model text (the host implements it with ctx.llm.stream; tests can inject a fake) */
export interface ExtractCallLlm {
  (input: { system: string; user: string; sessionId: string; signal: AbortSignal }): Promise<string>;
}

export interface ExtractSettings {
  enabled: boolean;
  /** Polling interval in minutes */
  intervalMinutes: number;
  /** Max input characters per extraction run (head+tail are kept beyond the limit) */
  batchMaxChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  /** Dedup: skip/merge when token overlap with an existing memory is too high */
  dedup: boolean;
  /** On bad JSON, fall back to a low-value summary event instead of dropping silently */
  fallbackOnBadJson: boolean;
  /** Drop extracted results whose importance is below this value (high default = extraction is a privilege) */
  minImportance: number;
  /** Headless one-shot run: drain synchronously on flush (avoids the 5s shutdown timeout) */
  flushDrain: boolean;
  /** strict: reject task-local/system-ish content at output level (relax only for legacy migration replays) */
  provenanceFilter: "strict" | "off";
  /** Require every accepted memory to carry a verbatim evidence quote */
  requireEvidence: boolean;
  /** Legacy/static project key used by tests and simple hosts. */
  projectId: string;
  /** Durable resolver used by production; evaluated separately for every pending session. */
  projectIdForSession?: (sessionId: string) => string;
}

export interface ExtractPumpResult {
  sessions: number;
  memories: number;
  skipped: number;
  errors: number;
  /** Drafts rejected by the deterministic task-local heuristics */
  rejectedTaskLocal: number;
  /** Drafts rejected for missing evidence / importance below the floor */
  rejectedLowValue: number;
  /** Near-duplicates merged into existing rows (not inserted) */
  duplicatesMerged: number;
  /** Conflicting drafts stored alongside the existing row (both kept, flagged) */
  conflicts: number;
}

export const emptyPumpResult: ExtractPumpResult = {
  sessions: 0, memories: 0, skipped: 0, errors: 0, rejectedTaskLocal: 0, rejectedLowValue: 0, duplicatesMerged: 0, conflicts: 0,
};

export const EXTRACT_SYSTEM_PROMPT = `You are a long-term memory extractor for a personal memory store. Extract only memories with durable, cross-session value for the USER.

Hard rules:
1. Output only a single JSON object, no code fences, no extra text: {"memories":[{"kind":"fact|preference|event","scope":"global|project","content":"one sentence","importance":1-10,"confidence":0-1,"source_role":"user","evidence":"short verbatim quote from the user"}]}
2. Extract ONLY: user facts (name, OS, editor, standing environment), stable user preferences and habits, explicit "remember this" requests, and stable project/workflow facts the user stated themselves. Use scope=global only for facts/preferences about the user that should follow them across every project; use project for repository or application facts.
3. NEVER output kind "instruction". Repo SOPs and tool rules are NOT memories.
4. REJECT entirely (output nothing for them): tool outputs, system/plugin/skill text, task-local constraints ("for this PR...", "the build must..."), acceptance criteria, TODO/temporary plans, status reports, completed-work logs, and anything the user did not state themselves.
5. content must be time-free, self-contained and retrievable ("User prefers pnpm", never "will switch today"). Max 80 characters. No credentials, keys or tokens.
6. Every memory MUST include evidence: a verbatim snippet taken from the User lines that supports it (max 160 chars).
7. When nothing qualifies, output {"memories":[]}.`;

const SENSITIVE_RE = /\b(sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=])\b/i;

/** kind remains storage-valid for back-compat, but the extractor may not produce it */
const EXTRACTABLE_KINDS: ReadonlySet<string> = new Set(["fact", "preference", "event"]);

/** Task-local / workflow-log vocabulary (deterministic backstop behind the LLM gate) */
export const TASK_LOCAL_RE = /\b(for this (?:pr|task|ticket|branch|repo|project)|acceptance criteria|todo|next step|hotfix|rebasing|commit message|this milestone)\b/i;
export const COMPLETED_WORK_RE = /\b(completed|finished|merged|deployed|shipped)\b.*\b(today|yesterday|this morning|just now|already)\b/i;

export function looksTaskLocal(content: string): boolean {
  return TASK_LOCAL_RE.test(content) || COMPLETED_WORK_RE.test(content);
}

/** Imperative rule about repo/build/config vocabulary without any user attribution (repo SOP, not a user fact) */
export function looksLikeInstruction(content: string): boolean {
  if (!/\b(must|should (?:always|never)|never allow|do not|don'?t)\b/i.test(content)) return false;
  if (/\b(user|customer|my|mine)\b/i.test(content)) return false;
  return /\b(repo|build|commit|branch|deploy|config|script|folder|directory|file|pnpm|npm|bun|steps?|ci|lint|settings)\b/i.test(content);
}

function normalizedEvidence(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/** Evidence is accepted only when it is actually present in a direct human slice. */
export function isVerbatimUserEvidence(evidence: string, slices: ConversationSliceRecord[]): boolean {
  const needle = normalizedEvidence(evidence);
  if (needle.length < 4) return false;
  return slices.some((slice) => normalizedEvidence(slice.text).includes(needle));
}

/** The model may suggest global scope, but deterministic guards own the final decision. */
export function durableScopeForDraft(draft: ExtractedMemoryDraft): "global" | "project" {
  if (draft.scope !== "global") return "project";
  if (draft.kind !== "preference" && !/^User\b/i.test(draft.content)) return "project";
  if (/\b(project|repository|repo|workboard|application|codebase|branch|ticket|PR)\b/i.test(draft.content)) return "project";
  return "global";
}

export class Extractor {
  constructor(
    private readonly store: MemoryStore,
    private readonly settings: ExtractSettings,
    private readonly callLlm: ExtractCallLlm,
    private readonly embedding: EmbeddingProvider | null = null,
    private readonly dedupeSettings: DedupeSettings = DEFAULT_DEDUPE_SETTINGS,
  ) {}

  /** Processes every session with pending slices; returns a summary. Re-entrancy guard + throttling. */
  async pump(): Promise<ExtractPumpResult> {
    const base = { ...emptyPumpResult };
    if (!this.settings.enabled) return base;
    if (this.pumping) return base;
    const now = Date.now();
    if (now - this.lastPumpAt < MIN_PUMP_INTERVAL_MS) return base;
    this.pumping = true;
    this.lastPumpAt = now;
    try {
      const pending = this.store.pendingSessions();
      const result: ExtractPumpResult = { ...base, sessions: pending.length };
      for (const p of pending) {
        try {
          const r = await this.extractForSession(p.sessionId, p.processedSeq, p.pendingSeq);
          result.memories += r.memories ?? 0;
          result.skipped += r.skipped ?? 0;
          result.rejectedTaskLocal += r.rejectedTaskLocal ?? 0;
          result.rejectedLowValue += r.rejectedLowValue ?? 0;
          result.duplicatesMerged += r.duplicatesMerged ?? 0;
          result.conflicts += r.conflicts ?? 0;
        } catch (error) {
          result.errors++;
          console.warn(
            "[dsh-self-improved] extract failed for",
            p.sessionId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return result;
    } finally {
      this.pumping = false;
    }
  }

  private pumping = false;
  private lastPumpAt = 0;

  private async extractForSession(
    sessionId: string,
    fromSeq: number,
    toSeq: number,
  ): Promise<Partial<ExtractPumpResult>> {
    const r: Partial<ExtractPumpResult> = {};
    const allSlices = this.store.readSlices(sessionId, fromSeq, toSeq);
    if (allSlices.length === 0) {
      this.store.advanceProcessed(sessionId, toSeq);
      return r;
    }
    const userSlices = allSlices.filter((s) => s.type === "user" && !s.injected && s.sourceKind === "user");
    const user = renderPrompt(allSlices, this.settings.batchMaxChars);
    if (!user.trim()) {
      // Batch contained only injected content / tool output: nothing legitimately extractable
      this.store.advanceProcessed(sessionId, toSeq);
      return r;
    }
    const signal = AbortSignal.timeout(this.settings.timeoutMs);
    const text = await this.callLlm({ system: EXTRACT_SYSTEM_PROMPT, user, sessionId, signal });
    const drafts = this.parseMemories(text);

    let memories = 0;
    let skipped = 0;
    const inserted: Array<{ content: string; id: string }> = [];
    for (const draft of drafts) {
      if (this.settings.provenanceFilter === "strict" && looksTaskLocal(draft.content)) {
        r.rejectedTaskLocal = (r.rejectedTaskLocal ?? 0) + 1;
        continue;
      }
      if (this.settings.provenanceFilter === "strict" && looksLikeInstruction(draft.content)) {
        r.rejectedTaskLocal = (r.rejectedTaskLocal ?? 0) + 1;
        continue;
      }
      if (
        this.settings.requireEvidence &&
        (!draft.evidence.trim() || draft.sourceRole !== "user" || !isVerbatimUserEvidence(draft.evidence, userSlices))
      ) {
        r.rejectedLowValue = (r.rejectedLowValue ?? 0) + 1;
        continue;
      }
      if (draft.importance < this.settings.minImportance) {
        r.rejectedLowValue = (r.rejectedLowValue ?? 0) + 1;
        continue;
      }
      const projectId = (this.settings.projectIdForSession?.(sessionId) ?? this.settings.projectId) || "default";
      const scope = durableScopeForDraft(draft);
      const meta: MemoryMetaInput = {
        provenance: "user",
        source: "llm-extract",
        scope,
        projectId: scope === "project" ? projectId : null,
        sessionId,
        confidence: draft.confidence,
        evidence: draft.evidence.trim() ? [{ sessionId, snippet: draft.evidence.slice(0, 200) }] : [],
      };
      let record: { id: string; content: string } | null = null;
      if (this.settings.dedup) {
        const gateResult = this.dedupeCheck(draft, meta, scope, projectId);
        if (gateResult.duplicated) {
          r.duplicatesMerged = (r.duplicatesMerged ?? 0) + 1;
          continue;
        }
        record = this.store.insertMemory(
          { kind: draft.kind, content: draft.content, importance: draft.importance },
          gateResult.conflict
            ? { ...meta, evidence: [...(meta.evidence ?? []), { sessionId, snippet: `conflict-of:${gateResult.neighborId}` }] }
            : meta,
        );
        if (gateResult.conflict) r.conflicts = (r.conflicts ?? 0) + 1;
      } else {
        record = this.store.insertMemory({ kind: draft.kind, content: draft.content, importance: draft.importance }, meta);
      }
      if (
        scope === "global" &&
        (draft.kind === "preference" || draft.kind === "fact") &&
        draft.importance >= 8 &&
        draft.confidence >= 0.8
      ) {
        // Hermes-style bounded baseline: only strong, user-backed global facts are
        // promoted automatically; the 15-slot cap forces consolidation over growth.
        this.store.pinBaseline(record.id, 15);
      }
      inserted.push({ content: record.content, id: record.id });
      memories++;
    }
    r.memories = memories;
    r.skipped = skipped;

    // Embedding backfill (optional): written when an embedding provider is configured, for hybrid retrieval
    if (inserted.length > 0 && this.embedding) {
      try {
        const vectors = await this.embedding.embed(inserted.map((m) => m.content));
        inserted.forEach((m, i) => {
          if (vectors[i]?.length) this.store.upsertEmbedding(m.id, vectors[i]);
        });
      } catch (error) {
        console.warn("[dsh-self-improved] embedding backfill skipped:", String(error));
      }
    }
    this.store.advanceProcessed(sessionId, toSeq);
    return r;
  }

  /** Duplicate/contradiction decision against active memories (token overlap; no embeddings needed).
   * Neighbor lookup is boundary-restricted by the draft's own kind + final scope/project:
   * trusted new content is only ever merged into compatible, trusted, same-scope rows. */
  private dedupeCheck(draft: ExtractedMemoryDraft, meta: MemoryMetaInput, scope: "global" | "project", projectId: string): { duplicated: boolean; conflict: boolean; neighborId: string | null } {
    const neighbors = findNeighbors(this.store, draft.content, 3, {
      kind: draft.kind,
      scope,
      projectId,
    });
    for (const n of neighbors) {
      const verdict = classify(draft.content, n, this.dedupeSettings);
      if (verdict === "duplicate") {
        mergeDuplicate(this.store, n.record, { evidence: meta.evidence });
        return { duplicated: true, conflict: false, neighborId: n.record.id };
      }
      if (verdict === "conflict") {
        return { duplicated: false, conflict: true, neighborId: n.record.id };
      }
    }
    return { duplicated: false, conflict: false, neighborId: null };
  }

  /** Parses and validates LLM output. Invalid kinds/entries dropped; no `instruction` kind ever produced. */
  parseMemories(text: string, sourceSummary = ""): ExtractedMemoryDraft[] {
    const json = extractJson(text);
    const drafts: ExtractedMemoryDraft[] = [];
    let parsedOk = false;
    if (json && typeof json === "object" && Array.isArray((json as { memories?: unknown }).memories)) {
      parsedOk = true;
      for (const item of (json as { memories: unknown[] }).memories) {
        if (!item || typeof item !== "object") continue;
        const raw = item as {
          kind?: unknown; scope?: unknown; content?: unknown; importance?: unknown; confidence?: unknown; evidence?: unknown; source_role?: unknown;
        };
        const kind = raw.kind as MemoryKind;
        const content = typeof raw.content === "string" ? raw.content.trim() : "";
        const importance = typeof raw.importance === "number" ? Math.round(raw.importance) : 5;
        const confidence = typeof raw.confidence === "number" ? Math.max(0, Math.min(1, raw.confidence)) : 0.5;
        const evidence = typeof raw.evidence === "string" ? raw.evidence.trim().slice(0, 160) : "";
        const sourceRole = raw.source_role === "user" ? ("user" as const) : ("assistant" as const);
        const scope = raw.scope === "global" ? ("global" as const) : ("project" as const);
        if (!EXTRACTABLE_KINDS.has(String(kind))) continue; // instruction/nonsense kinds rejected outright
        if (content.length < 2 || content.length > 500) continue;
        if (SENSITIVE_RE.test(content)) continue;
        drafts.push({ kind, content, importance: Math.max(1, Math.min(10, importance)), confidence, evidence, sourceRole, scope });
      }
    }
    // Fallback: only when JSON parsing failed (not a valid empty result) and enabled, record a low-value marker event
    if (drafts.length === 0 && !parsedOk && this.settings.fallbackOnBadJson && text.trim()) {
      drafts.push({
        kind: "event",
        content: `[auto summary] ${summarize(sourceSummary || text, 180)}`,
        importance: 1,
        confidence: 0.2,
        evidence: "",
        sourceRole: "user",
        scope: "project",
      });
    }
    return drafts;
  }
}

/** Minimum interval between two pumps: DSH fires callbacks at multiple flush checkpoints, so avoid an LLM call storm */
const MIN_PUMP_INTERVAL_MS = 30_000;

/** Renders only direct-human source slices; every other merge-extensible source is untrusted. */
export function renderPrompt(slices: ConversationSliceRecord[], maxChars: number): string {
  const parts: string[] = [];
  for (const s of slices) {
    if (s.injected || s.type !== "user" || s.sourceKind !== "user") continue;
    parts.push(`User: ${s.text}`);
  }
  const joined = parts.join("\n");
  if (joined.length <= maxChars) return joined;
  const head = Math.floor(maxChars * 0.6);
  const tail = maxChars - head;
  return joined.slice(0, head) + "\n…[middle omitted]…\n" + joined.slice(-tail);
}

/** Extracts JSON from model text as best as possible (tolerates code fences and surrounding noise) */
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

function summarize(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
}

// Re-export for tests / migration tooling
export { tokenJaccard };
