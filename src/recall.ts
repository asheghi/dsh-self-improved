/**
 * 召回服务（M3）：关键词（jieba+FTS5 BM25）+ 可选向量（sqlite-vec）+ 混合（RRF 融合）。
 *
 * embedding 可插拔：未配置 embedding 时退化为纯关键词召回；
 * 混合召回需要 embedding provider 与已写入的向量（M2 提取管线可选地回填向量）。
 */
import type { MemoryStore, MemorySearchHit } from "./storage.js";

export type RecallStrategy = "keyword" | "hybrid";

export interface RecallSettings {
  strategy: RecallStrategy;
  maxResults: number;
  /** 关键词 BM25 分数阈值（bm25 越小越相关；0 = 不过滤） */
  scoreThreshold: number;
  timeoutMs: number;
}

export interface EmbeddingProvider {
  /** 把文本批量转为向量；失败抛错由调用方降级 */
  embed(texts: string[]): Promise<number[][]>;
}

export interface RecallHit {
  id: string;
  kind: string;
  content: string;
  importance: number;
  /** 融合后的相关分（越大越相关） */
  score: number;
}

/**
 * 创建 OpenAI 兼容的 embedding provider（POST {baseUrl}/embeddings）。
 * 未配置 baseUrl 时返回 null（纯关键词模式）。
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

  /** 检索入口：策略路由 + 超时降级（失败返回空，绝不阻塞回合） */
  async search(query: string, options: { maxResults?: number } = {}): Promise<RecallHit[]> {
    if (!query.trim()) return [];
    const maxResults = options.maxResults ?? this.settings.maxResults;
    try {
      const deadline = AbortSignal.timeout(this.settings.timeoutMs);
      // 关键词路径是同步 DB 查询；向量/混合路径可能涉及外部调用
      const result =
        this.settings.strategy === "hybrid" && this.embedding
          ? await this.hybridSearch(query, maxResults, deadline)
          : await this.keywordSearch(query, maxResults, deadline);
      // 时间分片内 abort 检查（防外部调用挂起）
      deadline.throwIfAborted();
      return result;
    } catch (error) {
      console.warn("[dsh-self-improved] recall degraded:", String(error));
      return [];
    }
  }

  /** 关键词召回（BM25，jieba 分词；OR 语义保证口语化查询也能命中，按 BM25 排序） */
  private async keywordSearch(query: string, limit: number, _signal: AbortSignal): Promise<RecallHit[]> {
    const hits = this.store.searchMemories(query, { limit: Math.max(limit * 3, 10), matchAny: true });
    return hits
      .filter((h) => this.settings.scoreThreshold <= 0 || h.score <= this.settings.scoreThreshold)
      .slice(0, limit)
      .map((h) => toRecallHit(h, h.score));
  }

  /** 混合召回：关键词 + 向量，RRF 融合 */
  private async hybridSearch(query: string, limit: number, signal: AbortSignal): Promise<RecallHit[]> {
    const [keywordHits, vectorHits] = await Promise.all([
      this.keywordSearch(query, Math.max(limit * 3, 10), signal),
      this.vectorSearch(query, Math.max(limit * 3, 10), signal),
    ]);
    return rrfFuse([keywordHits, vectorHits], limit);
  }

  /** 向量召回（含回填：新内容先写入 embedding 再检索，保证冷启动可用） */
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

/** 倒数排名融合（RRF）：k=60，合并多路结果按融合分排序 */
function rrfFuse(lists: RecallHit[][], limit: number): RecallHit[] {
  const scores = new Map<string, { hit: RecallHit; score: number }>();
  const K = 60;
  for (const list of lists) {
    list.forEach((hit, rank) => {
      const existing = scores.get(hit.id);
      const contribution = 1 / (K + rank + 1);
      if (existing) {
        existing.score += contribution;
        // 保留更高的重要度
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

/** 渲染注入块（纯函数，供测试与 agent/pre-step 注入使用） */
export function renderRecallBlock(hits: RecallHit[], maxHits = 5): string {
  if (hits.length === 0) return "";
  const lines = hits.slice(0, maxHits).map((h) => `- [${kindLabel(h.kind)}] ${h.content}（重要度 ${h.importance}/10）`);
  return `【相关记忆】\n${lines.join("\n")}`;
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "fact":
      return "事实";
    case "preference":
      return "偏好";
    case "event":
      return "事件";
    case "instruction":
      return "指令";
    default:
      return kind;
  }
}
