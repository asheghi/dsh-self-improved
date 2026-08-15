/**
 * 存储模块（M1）：SQLite 记忆库。
 *
 * - memory.db：memories 主表 + FTS5 全文索引（可重建派生读模型）
 * - vectors.db：sqlite-vec vec0 向量表（M2/M3 起填充 embedding；M1 仅验证扩展可加载）
 *
 * 设计对齐：docs/design/dsh-memory-plugin-design.md §4.2 / §5.3
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { getLoadablePath } from "sqlite-vec";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { Jieba } from "@node-rs/jieba";

const require = createRequire(import.meta.url);

export type MemoryKind = "fact" | "preference" | "event" | "instruction" | "persona";
export type MemoryStatus = "active" | "decayed" | "forgotten" | "corrected";

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number; // 1-10
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  status: MemoryStatus;
  supersedes?: string;
}

export interface MemorySearchHit {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  accessCount: number;
  score: number; // bm25 得分（越小越相关）
}

export interface MemorySearchOptions {
  limit?: number;
  /** true = 任意词命中（OR，适合召回）；false = 全部词命中（AND，适合精确搜索） */
  matchAny?: boolean;
}

export interface ConversationSliceRecord {
  type: "user" | "assistant" | "tool";
  seq: number;
  turn?: number;
  step?: number;
  ts: number;
  text: string;
  sessionId: string;
}

export class MemoryStore {
  readonly dir: string;
  private db: DatabaseSync;
  private vectors: DatabaseSync | null = null;
  private closed = false;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.db = this.openDatabase(join(dir, "memory.db"));
    this.ensureSchema(this.db);
    this.tryLoadVectors();
  }

  /** 打开一个 SQLite 数据库（node:sqlite，DSH 同款；allowExtension 允许加载 sqlite-vec） */
  private openDatabase(path: string): DatabaseSync {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = new DatabaseSync(path, { allowExtension: true } as any);
    db.exec("PRAGMA journal_mode = WAL");
    return db;
  }

  private ensureSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL,
        content      TEXT NOT NULL,
        importance   INTEGER NOT NULL DEFAULT 5,
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'active',
        supersedes   TEXT
      ) STRICT;
      -- search_text 为 jieba 分词后的空格分隔词序列（unicode61 不做中文分词）
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        search_text,
        kind UNINDEXED,
        content_rowid UNINDEXED,
        tokenize = 'unicode61'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      -- 提取管线状态：每会话已处理/待处理的 L0 seq 游标（持久化，重启不丢）
      CREATE TABLE IF NOT EXISTS extract_state (
        session_id    TEXT PRIMARY KEY,
        processed_seq INTEGER NOT NULL DEFAULT 0,
        pending_seq   INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL
      ) STRICT;
    `);
  }

  /** 尝试加载 sqlite-vec 扩展；失败仅禁用向量能力（M1 不依赖向量检索） */
  private tryLoadVectors(): void {
    try {
      this.vectors = this.openDatabase(join(this.dir, "vectors.db"));
      this.vectors.loadExtension(getLoadablePath());
      this.vectors.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
          memory_id TEXT PRIMARY KEY,
          embedding FLOAT[1024]
        );
      `);
    } catch (error) {
      console.warn("[dsh-self-improved] sqlite-vec 不可用，向量检索禁用：", String(error));
      this.vectors = null;
    }
  }

  /** 写入一条原子记忆（L1） */
  insertMemory(input: {
    kind: MemoryKind;
    content: string;
    importance?: number;
    supersedes?: string;
  }): MemoryRecord {
    const now = Date.now();
    const record: MemoryRecord = {
      id: randomUUID(),
      kind: input.kind,
      content: input.content,
      importance: Math.max(1, Math.min(10, input.importance ?? 5)),
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
      status: "active",
      supersedes: input.supersedes,
    };
    this.db
      .prepare(
        `INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(record.id, record.kind, record.content, record.importance, 0, now, now, "active", record.supersedes ?? null);
    this.db
      .prepare(`INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)`)
      .run(tokenize(record.content), record.kind, record.id);
    return record;
  }

  /** 关键词检索（jieba 分词 + FTS5 + BM25）。matchAny=true 用 OR（召回），默认 AND（精确） */
  searchMemories(query: string, options: MemorySearchOptions = {}): MemorySearchHit[] {
    const limit = options.limit ?? 10;
    if (!query.trim()) return [];
    const terms = tokenize(query)
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => `"${term}"`);
    if (terms.length === 0) return [];
    const escaped = terms.join(options.matchAny ? " OR " : " AND ");
    const stmt = this.db.prepare(`
      SELECT m.id, m.kind, m.content, m.importance, m.access_count,
             bm25(memories_fts) AS score
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.content_rowid
      WHERE memories_fts MATCH ?
        AND m.status = 'active'
      ORDER BY score
      LIMIT ?
    `);
    const rows = stmt.all(escaped, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as MemoryKind,
      content: String(row.content),
      importance: Number(row.importance),
      accessCount: Number(row.access_count),
      score: Number(row.score),
    }));
  }

  listMemories(options: { kind?: MemoryKind; limit?: number; offset?: number } = {}): MemoryRecord[] {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const rows = options.kind
      ? this.db.prepare("SELECT * FROM memories WHERE kind = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(options.kind, limit, offset)
      : this.db.prepare("SELECT * FROM memories ORDER BY updated_at DESC LIMIT ? OFFSET ?").all(limit, offset);
    return (rows as Array<Record<string, unknown>>).map((r) => ({
      id: String(r.id),
      kind: r.kind as MemoryKind,
      content: String(r.content),
      importance: Number(r.importance),
      accessCount: Number(r.access_count),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
      status: r.status as MemoryStatus,
      supersedes: r.supersedes == null ? undefined : String(r.supersedes),
    }));
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      kind: row.kind as MemoryKind,
      content: String(row.content),
      importance: Number(row.importance),
      accessCount: Number(row.access_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      status: row.status as MemoryStatus,
      supersedes: row.supersedes == null ? undefined : String(row.supersedes),
    };
  }

  /** 标记遗忘（M4 起配合衰减；M1 提供基础删除能力） */
  forgetMemory(id: string): boolean {
    const res = this.db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return res.changes > 0;
  }

  // ---------- 向量（M3，sqlite-vec KNN） ----------

  /** 写入/更新记忆向量（向量检索开启时由 recall 调用；vec0 虚拟表不支持 UPSERT，用 INSERT OR REPLACE） */
  upsertEmbedding(memoryId: string, vector: number[]): boolean {
    if (!this.vectors) return false;
    try {
      this.vectors
        .prepare("INSERT OR REPLACE INTO memory_vec (memory_id, embedding) VALUES (?, ?)")
        .run(memoryId, JSON.stringify(vector));
      return true;
    } catch (error) {
      console.warn("[dsh-self-improved] upsertEmbedding failed:", String(error));
      return false;
    }
  }

  /** 向量近邻检索（KNN）；返回 [{memoryId, distance}] */
  vectorSearch(vector: number[], limit: number): Array<{ memoryId: string; distance: number }> {
    if (!this.vectors || vector.length === 0) return [];
    try {
      const rows = this.vectors
        .prepare("SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ?")
        .all(JSON.stringify(vector), limit) as Array<Record<string, unknown>>;
      return rows.map((r) => ({ memoryId: String(r.memory_id), distance: Number(r.distance) }));
    } catch (error) {
      console.warn("[dsh-self-improved] vectorSearch failed:", String(error));
      return [];
    }
  }

  deleteMemory(id: string): boolean {
    const res = this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM memories_fts WHERE content_rowid = ?").run(id);
    return res.changes > 0;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.vectors?.close(); } catch { /* noop */ }
    this.db.close();
  }

  /** 原始会话切片落盘（L0 JSONL，每行一条；供提取管线输入/备份） */
  appendConversationSlice(sessionId: string, records: ConversationSliceRecord[]): void {
    if (records.length === 0) return;
    const dir = join(this.dir, "conversations");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeSegment(sessionId)}.jsonl`);
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(path, lines, { encoding: "utf8", flag: "a" });
  }

  // ---------- 提取管线状态（M2） ----------

  /** 标记某会话的切片已捕获到 seq（提取队列的待处理水位） */
  markPending(sessionId: string, seq: number): void {
    this.db
      .prepare(
        `INSERT INTO extract_state (session_id, processed_seq, pending_seq, updated_at)
         VALUES (?, 0, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           pending_seq = MAX(pending_seq, excluded.pending_seq),
           updated_at = excluded.updated_at`,
      )
      .run(sessionId, seq, Date.now());
  }

  /** 有待处理切片的会话列表 */
  pendingSessions(): Array<{ sessionId: string; processedSeq: number; pendingSeq: number }> {
    const rows = this.db
      .prepare("SELECT session_id, processed_seq, pending_seq FROM extract_state WHERE pending_seq > processed_seq")
      .all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      sessionId: String(r.session_id),
      processedSeq: Number(r.processed_seq),
      pendingSeq: Number(r.pending_seq),
    }));
  }

  /** 读取某会话 [fromSeq, toSeq] 区间内的切片（从 JSONL） */
  readSlices(sessionId: string, fromSeq: number, toSeq: number): ConversationSliceRecord[] {
    if (toSeq <= fromSeq) return [];
    const path = join(this.dir, "conversations", `${safeSegment(sessionId)}.jsonl`);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      return [];
    }
    const out: ConversationSliceRecord[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rec = JSON.parse(line) as any;
        if (typeof rec.seq === "number" && rec.seq > fromSeq && rec.seq <= toSeq) out.push(rec);
      } catch {
        // 忽略坏行
      }
    }
    return out;
  }

  /** 推进已处理水位 */
  advanceProcessed(sessionId: string, seq: number): void {
    this.db
      .prepare("UPDATE extract_state SET processed_seq = ?, updated_at = ? WHERE session_id = ?")
      .run(seq, Date.now(), sessionId);
  }
}

/**
 * jieba 中文分词：内容与查询统一走同一分词器，保证检索一致。
 * 分词器惰性初始化（词典加载有成本）。
 */
let jieba: Jieba | null = null;
export function tokenize(text: string): string {
  if (!jieba) {
    try {
      const dictPath = require.resolve("@node-rs/jieba/dict.txt");
      jieba = Jieba.withDict(readFileSync(dictPath));
    } catch {
      jieba = null; // 词典加载失败时降级为按空白切分
    }
  }
  try {
    const words = jieba ? jieba.cut(text, false) : text.split(/\s+/);
    return words
      .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")) // 清洗标点（FTS5 unicode61 不索引标点）
      .filter((t) => t.length > 0)
      .join(" ");
  } catch {
    return text;
  }
}

function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function defaultMemoryDir(): string {
  // 对齐 DSH 的 dsh-home-paths：$DSH_HOME/memory
  return join(resolveDshHome(undefined, process.env), "memory");
}
