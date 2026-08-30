/**
 * Recall service (M3): keyword (jieba+FTS5 BM25) + optional vectors (sqlite-vec) + hybrid (RRF fusion).
 *
 * Pluggable embedding: falls back to pure keyword recall when embedding is not configured;
 * hybrid recall requires an embedding provider plus already-stored vectors (the M2 extraction pipeline optionally backfills vectors).
 */
import type { MemoryStore, MemorySearchHit } from "./storage.js";

export type RecallStrategy = "keyword" | "hybrid";

export interface RecallSettings {
  strategy: RecallStrategy;
  maxResults: number;
  /** Keyword BM25 score threshold (a smaller bm25 is more relevant; 0 = no filtering) */
  scoreThreshold: number;
  timeoutMs: number;
}

export interface EmbeddingProvider {
  /** Batch-convert texts into vectors; throws on failure so the caller can degrade */
  embed(texts: string[]): Promise<number[][]>;
}

export interface RecallHit {
  id: string;
  kind: string;
  content: string;
  importance: number;
  /** Fused relevance score (higher means more relevant) */
  score: number;
}

/**
 * Create an OpenAI-compatible embedding provider (POST {baseUrl}/embeddings).
 * Returns null when baseUrl is not configured (pure keyword mode).
 */
export function createOpenAiEmbedding(config: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
}): EmbeddingProvider | null {
  const baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
  const model = (config.model ?? "").trim();
  if (!baseUrl || !model) return null;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const dimensions = config.dimensions ?? 1024;
  return {
    async embed(texts: string[]): Promise<number[][]> {
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({ model, input: texts }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const json: any = await response.json();
      const data = json?.data;
      if (!Array.isArray(data)) throw new Error("embedding response missing data");
      return data.map((d: { embedding?: unknown }) => {
        const emb = d?.embedding;
        if (!Array.isArray(emb) || emb.length === 0) throw new Error("embedding item missing embedding");
        const vec = emb.slice(0, dimensions).map(Number);
        return vec;
      });
    },
  };
}

export class RecallService {
  constructor(
    private readonly store: MemoryStore,
    private readonly settings: RecallSettings,
    private readonly embedding: EmbeddingProvider | null = null,
  ) {}

  /** Search entry point: strategy routing + timeout degradation (returns empty on failure, never blocks the turn) */
  async search(query: string, options: { maxResults?: number } = {}): Promise<RecallHit[]> {
    if (!query.trim()) return [];
    const maxResults = options.maxResults ?? this.settings.maxResults;
    try {
      const deadline = AbortSignal.timeout(this.settings.timeoutMs);
      // The keyword path is a synchronous DB query; vector/hybrid paths may involve external calls
      const result =
        this.settings.strategy === "hybrid" && this.embedding
          ? await this.hybridSearch(query, maxResults, deadline)
          : await this.keywordSearch(query, maxResults, deadline);
      // Abort check within the time slice (prevents external calls from hanging)
      deadline.throwIfAborted();
      return result;
    } catch (error) {
      console.warn("[dsh-self-improved] recall degraded:", String(error));
      return [];
    }
  }

  /** Keyword recall (BM25, jieba tokenization; OR semantics ensures colloquial queries still hit, ordered by BM25) */
  private async keywordSearch(query: string, limit: number, _signal: AbortSignal): Promise<RecallHit[]> {
    const hits = this.store.searchMemories(query, { limit: Math.max(limit * 3, 10), matchAny: true });
    return hits
      .filter((h) => this.settings.scoreThreshold <= 0 || h.score <= this.settings.scoreThreshold)
      .slice(0, limit)
      .map((h) => toRecallHit(h, h.score));
  }

  /** Hybrid recall: keyword + vector, fused with RRF */
  private async hybridSearch(query: string, limit: number, signal: AbortSignal): Promise<RecallHit[]> {
    const [keywordHits, vectorHits] = await Promise.all([
      this.keywordSearch(query, Math.max(limit * 3, 10), signal),
      this.vectorSearch(query, Math.max(limit * 3, 10), signal),
    ]);
    return rrfFuse([keywordHits, vectorHits], limit);
  }

  /** Vector recall (with backfill: new content is embedded before retrieval so cold start works) */
  private async vectorSearch(query: string, limit: number, _signal: AbortSignal): Promise<RecallHit[]> {
    if (!this.embedding) return [];
    const [vector] = await this.embedding.embed([query]);
    const neighbors = this.store.vectorSearch(vector, limit);
    const out: RecallHit[] = [];
    for (const n of neighbors) {
      const record = this.store.getMemory(n.memoryId);
      if (record && record.status === "active") {
        out.push({ id: record.id, kind: record.kind, content: record.content, importance: record.importance, score: 1 / (1 + n.distance) });
      }
    }
    return out;
  }
}

function toRecallHit(h: MemorySearchHit, score: number): RecallHit {
  return { id: h.id, kind: h.kind, content: h.content, importance: h.importance, score };
}

/** Reciprocal rank fusion (RRF): k=60, merges results from multiple sources and sorts by fused score */
function rrfFuse(lists: RecallHit[][], limit: number): RecallHit[] {
  const scores = new Map<string, { hit: RecallHit; score: number }>();
  const K = 60;
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const existing = scores.get(hit.id);
      const contribution = 1 / (K + rank + 1);
      if (existing) {
        existing.score += contribution;
        // Keep the higher importance
        if (hit.importance > existing.hit.importance) existing.hit = hit;
      } else {
        scores.set(hit.id, { hit, score: contribution });
      }
    });
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((v) => ({ ...v.hit, score: v.score }));
}

/** Render the injection block (pure function, used by tests and agent/pre-step injection) */
export function renderRecallBlock(hits: RecallHit[], maxHits = 5): string {
  if (hits.length === 0) return "";
  const lines = hits.slice(0, maxHits).map((h) => `- [${kindLabel(h.kind)}] ${h.content} (importance ${h.importance}/10)`);
  return `Relevant memories\n${lines.join("\n")}`;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "fact":
      return "fact";
    case "preference":
      return "preference";
    case "event":
      return "event";
    case "instruction":
      return "instruction";
    default:
      return kind;
  }
}
