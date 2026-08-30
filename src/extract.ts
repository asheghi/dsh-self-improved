/**
 * L1 extraction pipeline (M2): consumes L0 conversation slices → LLM extracts atomic memories → validation/dedup → storage.
 *
 * Design notes (lessons learned from dsh-tdai-memory):
 * - LLM output must pass strict JSON validation plus a fallback path (bad output → source-text summary); never fail silently;
 * - Extraction must never block the main conversation (the caller decides when to await);
 * - Content and queries share one jieba tokenizer; dedup relies on token overlap.
 */
import type { MemoryStore, MemoryKind, ConversationSliceRecord } from "./storage.js";
import { tokenize } from "./storage.js";
import type { EmbeddingProvider } from "./recall.js";

export interface ExtractedMemoryDraft {
  kind: MemoryKind;
  content: string;
  importance: number;
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
  /** Dedup: skip when token overlap with an existing memory is too high */
  dedup: boolean;
  /** On bad JSON, fall back to a "source-text summary" memory instead of dropping it silently */
  fallbackOnBadJson: boolean;
  /** Drop extracted results whose importance is below this value (noise reduction) */
  minImportance: number;
  /** Headless one-shot run: drain synchronously on flush (avoids the 5s shutdown timeout) */
  flushDrain: boolean;
}

export interface ExtractPumpResult {
  sessions: number;
  memories: number;
  skipped: number;
  errors: number;
}

export const EXTRACT_SYSTEM_PROMPT = `You are a long-term memory extractor. Your task is to extract atomic memories "worth remembering long term" from conversations.

Requirements:
1. Output only a single JSON object, with no other text, explanations, or code fence markers.
2. The JSON structure is fixed: {"memories":[{"kind":"fact|preference|event|instruction","content":"one sentence","importance":1-10}]}
3. kind meanings: fact = objective fact; preference = user preference/habit; event = something that happened; instruction = an instruction/agreement for the future AI.
4. content must be a self-contained, retrievable sentence (third person, no "I said" / "the user said"), no longer than 80 characters.
5. importance 1-10: the higher the long-term collaboration value, the higher the score; do not extract trivial small talk.
6. Do not extract sensitive credentials such as API keys, passwords, or tokens; do not extract transient content.
7. When there is nothing worth remembering, output {"memories":[]}.`;

const SENSITIVE_RE = /\b(sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|password\s*[:=]|token\s*[:=])\b/i;

export class Extractor {
  constructor(
    private readonly store: MemoryStore,
    private readonly settings: ExtractSettings,
    private readonly callLlm: ExtractCallLlm,
    private readonly embedding: EmbeddingProvider | null = null,
  ) {}

  /** Processes every session with pending slices; returns a summary. Re-entrancy guard + throttling. */
  async pump(): Promise<ExtractPumpResult> {
    if (!this.settings.enabled) return { sessions: 0, memories: 0, skipped: 0, errors: 0 };
    if (this.pumping) return { sessions: 0, memories: 0, skipped: 0, errors: 0 };
    const now = Date.now();
    if (now - this.lastPumpAt < MIN_PUMP_INTERVAL_MS) return { sessions: 0, memories: 0, skipped: 0, errors: 0 };
    this.pumping = true;
    this.lastPumpAt = now;
    try {
      const pending = this.store.pendingSessions();
      let memories = 0;
      let skipped = 0;
      let errors = 0;
      for (const p of pending) {
        try {
          const r = await this.extractForSession(p.sessionId, p.processedSeq, p.pendingSeq);
          memories += r.memories;
          skipped += r.skipped;
        } catch (error) {
          errors++;
          console.warn(
            "[dsh-self-improved] extract failed for",
            p.sessionId,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      return { sessions: pending.length, memories, skipped, errors };
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
  ): Promise<{ memories: number; skipped: number }> {
    const slices = this.store.readSlices(sessionId, fromSeq, toSeq);
    if (slices.length === 0) {
      // Advance the watermark even when there is no new content, to avoid spinning on empty runs
      this.store.advanceProcessed(sessionId, toSeq);
      return { memories: 0, skipped: 0 };
    }
    const user = renderPrompt(slices, this.settings.batchMaxChars);
    const signal = AbortSignal.timeout(this.settings.timeoutMs);
    const text = await this.callLlm({ system: EXTRACT_SYSTEM_PROMPT, user, sessionId, signal });
    const drafts = this.parseMemories(text, user);

    let memories = 0;
    let skipped = 0;
    const inserted: Array<{ content: string; id: string }> = [];
    for (const draft of drafts) {
      if (draft.importance < this.settings.minImportance) {
        skipped++; // low-value noise dropped outright (noise reduction)
        continue;
      }
      if (this.settings.dedup && this.isDuplicate(draft)) {
        skipped++;
        continue;
      }
      const record = this.store.insertMemory(draft);
      inserted.push({ content: record.content, id: record.id });
      memories++;
    }
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
    return { memories, skipped };
  }

  /** Parses and validates LLM output; bad output takes the fallback path (when fallbackOnBadJson is on) */
  parseMemories(text: string, sourceSummary: string): ExtractedMemoryDraft[] {
    const json = extractJson(text);
    const drafts: ExtractedMemoryDraft[] = [];
    let parsedOk = false;
    if (json && typeof json === "object" && Array.isArray((json as { memories?: unknown }).memories)) {
      parsedOk = true;
      for (const item of (json as { memories: unknown[] }).memories) {
        if (!item || typeof item !== "object") continue;
        const raw = item as { kind?: unknown; content?: unknown; importance?: unknown };
        const kind = raw.kind as MemoryKind;
        const content = typeof raw.content === "string" ? raw.content.trim() : "";
        const importance = typeof raw.importance === "number" ? Math.round(raw.importance) : 5;
        if (!KINDS.has(kind)) continue;
        if (content.length < 2 || content.length > 500) continue;
        if (SENSITIVE_RE.test(content)) continue;
        drafts.push({ kind, content, importance: Math.max(1, Math.min(10, importance)) });
      }
    }
    // Fallback: only when JSON parsing failed (i.e. not a "valid empty result") and the text is non-empty, record the source summary as a low-importance event
    if (drafts.length === 0 && !parsedOk && this.settings.fallbackOnBadJson && text.trim()) {
      const summary = summarize(sourceSummary, 200);
      if (summary) {
        drafts.push({ kind: "event", content: `[auto summary] ${summary}`, importance: 1 });
      }
    }
    return drafts;
  }

  /** Basic dedup: judges jieba token overlap against the nearest memory hits */
  private isDuplicate(draft: ExtractedMemoryDraft): boolean {
    const tokens = new Set(tokenize(draft.content).split(/\s+/).filter(Boolean));
    if (tokens.size === 0) return false;
    const hits = this.store.searchMemories(draft.content, { limit: 3 });
    for (const hit of hits) {
      const hitTokens = new Set(tokenize(hit.content).split(/\s+/).filter(Boolean));
      let inter = 0;
      for (const t of tokens) if (hitTokens.has(t)) inter++;
      const union = new Set([...tokens, ...hitTokens]).size;
      if (union > 0 && inter / union > 0.6) return true;
    }
    return false;
  }
}

const KINDS: ReadonlySet<string> = new Set(["fact", "preference", "event", "instruction"]);

/** Minimum interval between two pumps: DSH fires callbacks at multiple flush checkpoints, so avoid an LLM call storm */
const MIN_PUMP_INTERVAL_MS = 30_000;

/** Renders the LLM input: role labels + head/tail truncation */
function renderPrompt(slices: ConversationSliceRecord[], maxChars: number): string {
  const parts = slices.map((s) => {
    const role = s.type === "user" ? "User" : s.type === "assistant" ? "AI" : "Tool result";
    return `${role}: ${s.text}`;
  });
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
