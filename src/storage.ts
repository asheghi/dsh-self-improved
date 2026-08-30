/**
 * Storage module (M1): SQLite memory store.
 *
 * - memory.db: memories main table + FTS5 full-text index (a derived read model that can be rebuilt)
 * - vectors.db: sqlite-vec vec0 vector table (embedding filled from M2/M3 on; M1 only verifies the extension loads)
 *
 * Design alignment: docs/design/dsh-memory-plugin-design.md §4.2 / §5.3
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
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
  score: number; // bm25 score (smaller = more relevant)
}

export interface MemorySearchOptions {
  limit?: number;
  /** true = any term matches (OR, good for recall); false = all terms must match (AND, good for exact search) */
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

  /** Open a SQLite database (node:sqlite, same as DSH; allowExtension allows loading sqlite-vec) */
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
      -- search_text is the space-separated token sequence produced by jieba (unicode61 does not segment Chinese)
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        search_text,
        kind UNINDEXED,
        content_rowid UNINDEXED,
        tokenize = 'unicode61'
      );
      CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);
      -- Extraction pipeline state: per-session processed/pending L0 seq cursors (persisted, survives restarts)
      CREATE TABLE IF NOT EXISTS extract_state (
        session_id    TEXT PRIMARY KEY,
        processed_seq INTEGER NOT NULL DEFAULT 0,
        pending_seq   INTEGER NOT NULL DEFAULT 0,
        updated_at    INTEGER NOT NULL
      ) STRICT;
      -- L2 scene blocks (M4)
      CREATE TABLE IF NOT EXISTS scenes (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        markdown     TEXT NOT NULL,
        memory_ids   TEXT NOT NULL DEFAULT '[]',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      ) STRICT;
      -- L3 user persona versions (M4, append-only for easy rollback)
      CREATE TABLE IF NOT EXISTS persona_versions (
        ver        INTEGER PRIMARY KEY AUTOINCREMENT,
        content    TEXT NOT NULL,
        created_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  /** Try to load the sqlite-vec extension; on failure only vector capabilities are disabled (M1 does not depend on vector search) */
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
      console.warn("[dsh-self-improved] sqlite-vec unavailable, vector search disabled:", String(error));
      this.vectors = null;
    }
  }

  /** Insert one atomic memory (L1) */
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

  /** Keyword search (jieba tokenization + FTS5 + BM25). matchAny=true uses OR (recall), default is AND (exact) */
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

  /** Mark as forgotten (paired with decay from M4 on; M1 provides basic delete capability) */
  forgetMemory(id: string): boolean {
    const res = this.db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return res.changes > 0;
  }

  // ---------- Vectors (M3, sqlite-vec KNN) ----------

  /** Insert/update a memory embedding (called by recall when vector search is on; the vec0 virtual table does not support UPSERT, so INSERT OR REPLACE is used) */
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

  /** Vector nearest-neighbor search (KNN); returns [{memoryId, distance}] */
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

  /** Persist raw conversation slices (L0 JSONL, one record per line; input/backup for the extraction pipeline) */
  appendConversationSlice(sessionId: string, records: ConversationSliceRecord[]): void {
    if (records.length === 0) return;
    const dir = join(this.dir, "conversations");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `${safeSegment(sessionId)}.jsonl`);
    const lines = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    writeFileSync(path, lines, { encoding: "utf8", flag: "a" });
  }

  // ---------- Extraction pipeline state (M2) ----------

  /** Mark a session's slices as captured up to seq (pending watermark of the extraction queue) */
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

  /** Sessions with pending slices */
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

  /** Read a session's slices in the [fromSeq, toSeq] range (from JSONL) */
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
        // Ignore malformed lines
      }
    }
    return out;
  }

  /** Advance the processed watermark */
  advanceProcessed(sessionId: string, seq: number): void {
    this.db
      .prepare("UPDATE extract_state SET processed_seq = ?, updated_at = ? WHERE session_id = ?")
      .run(seq, Date.now(), sessionId);
  }

  // ---------- M4: scenes / persona / decay ----------

  /** Creation time of the newest active memory (0 = none); used for the "evolve only when there are new memories" check */
  newestMemoryTs(): number {
    const row = this.db.prepare("SELECT MAX(created_at) m FROM memories WHERE status = 'active'").get() as
      | { m: number | null }
      | undefined;
    return row && row.m !== null ? row.m : 0;
  }

  /** Currently active memories (consumed by consolidate / evolve) */
  getActiveMemories(limit: number, minImportance = 0): MemoryRecord[] {
    const rows = minImportance > 0
      ? this.db.prepare("SELECT * FROM memories WHERE status = 'active' AND importance >= ? ORDER BY importance DESC, updated_at DESC LIMIT ?").all(minImportance, limit)
      : this.db.prepare("SELECT * FROM memories WHERE status = 'active' ORDER BY importance DESC, updated_at DESC LIMIT ?").all(limit);
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

  /** Set a memory's status (corrected / decayed / forgotten / active) */
  setMemoryStatus(id: string, status: MemoryStatus): boolean {
    const res = this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    return res.changes > 0;
  }

  /** Save the persona (version +1, writes the persona.md mirror) */
  savePersona(content: string): number {
    const now = Date.now();
    const res = this.db.prepare("INSERT INTO persona_versions (content, created_at) VALUES (?, ?)").run(content, now);
    const ver = Number(res.lastInsertRowid);
    const dir = join(this.dir, "persona");
    mkdirSync(dir, { recursive: true });
    // Rolling backup: keep persona.md.bak1 / .bak2
    const main = join(dir, "persona.md");
    if (existsSyncSafe(main)) {
      const bak2 = join(dir, "persona.md.bak2");
      const bak1 = join(dir, "persona.md.bak1");
      if (existsSyncSafe(bak1)) copyFileSyncSafe(bak1, bak2);
      copyFileSyncSafe(main, bak1);
    }
    writeFileSync(main, content, { encoding: "utf8" });
    return ver;
  }

  /** Read the latest persona (undefined if none) */
  getPersona(): { ver: number; content: string; createdAt: number } | undefined {
    const row = this.db.prepare("SELECT ver, content, created_at FROM persona_versions ORDER BY ver DESC LIMIT 1").get() as
      | Record<string, unknown>
      | undefined;
    if (!row) return undefined;
    return { ver: Number(row.ver), content: String(row.content), createdAt: Number(row.created_at) };
  }

  /** Save a scene block */
  saveScene(input: { id: string; title: string; markdown: string; memoryIds: string[] }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO scenes (id, title, markdown, memory_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, markdown = excluded.markdown, memory_ids = excluded.memory_ids, updated_at = excluded.updated_at`,
      )
      .run(input.id, input.title, input.markdown, JSON.stringify(input.memoryIds), now, now);
  }

  listScenes(limit = 20): Array<{ id: string; title: string; markdown: string; memoryIds: string[]; updatedAt: number }> {
    const rows = this.db.prepare("SELECT * FROM scenes ORDER BY updated_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      markdown: String(r.markdown),
      memoryIds: JSON.parse(String(r.memory_ids)) as string[],
      updatedAt: Number(r.updated_at),
    }));
  }

  /** Delete forgotten memories past their retention window (cleanup) */
  deleteForgottenOlderThan(ts: number): number {
    const res = this.db
      .prepare("DELETE FROM memories WHERE status = 'forgotten' AND updated_at < ?")
      .run(ts);
    return Number(res.changes);
  }

  // ---------- Growth governance (M6): caps and cleanup for persona versions / scenes / conversation slices ----------

  /** Keep only the most recent "keep" persona versions; returns the number deleted */
  prunePersonaVersions(keep: number): number {
    if (keep <= 0) return 0;
    const row = this.db.prepare("SELECT MAX(ver) m FROM persona_versions").get() as { m: number } | undefined;
    if (!row || row.m === null) return 0;
    const res = this.db.prepare("DELETE FROM persona_versions WHERE ver <= ?").run(row.m - keep);
    return Number(res.changes);
  }

  /**
   * Scene governance: ① delete scenes whose source memories are mostly stale
   * (active ratio < activeRatio); ② when the total number of scenes exceeds
   * maxScenes, delete the oldest. Returns the number deleted.
   */
  pruneScenes(maxScenes: number, activeRatio: number): number {
    let deleted = 0;
    const scenes = this.listScenes(10_000);
    // ① Scenes whose source memories went stale
    for (const s of scenes) {
      const ids = (s.memoryIds ?? []).filter((id) => typeof id === "string").slice(0, 50);
      if (ids.length === 0) continue;
      const placeholders = ids.map(() => "?").join(",");
      const row = this.db
        .prepare(`SELECT COUNT(*) n FROM memories WHERE id IN (${placeholders}) AND status = 'active'`)
        .get(...ids) as { n: number };
      if (row.n / ids.length < activeRatio) {
        if (this.db.prepare("DELETE FROM scenes WHERE id = ?").run(s.id).changes > 0) deleted++;
      }
    }
    // ② Total count cap (delete the oldest)
    const remaining = this.listScenes(10_000);
    const overflow = remaining.length - maxScenes;
    if (overflow > 0) {
      const keepIds = remaining.slice(0, maxScenes).map((s) => s.id);
      const keepPh = keepIds.map(() => "?").join(",");
      const res = this.db
        .prepare(`DELETE FROM scenes WHERE id NOT IN (${keepPh})`)
        .run(...keepIds);
      deleted += Number(res.changes);
    }
    return deleted;
  }

  /** Clean up conversation slice files past their retention window (conversations/*.jsonl); returns the number of files deleted */
  pruneConversationSlices(olderThanMs: number): number {
    const dir = join(this.dir, "conversations");
    let deleted = 0;
    let files: string[] = [];
    try {
      files = readdirSync(dir);
    } catch {
      return 0;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      try {
        if (statSync(join(dir, f)).mtimeMs < olderThanMs) {
          unlinkSync(join(dir, f));
          deleted++;
        }
      } catch {
        /* noop */
      }
    }
    return deleted;
  }
}

/**
 * jieba Chinese tokenization: content and queries use the same tokenizer to keep search consistent.
 * The tokenizer is lazily initialized (loading the dictionary has a cost).
 */
let jieba: Jieba | null = null;
export function tokenize(text: string): string {
  if (!jieba) {
    try {
      const dictPath = require.resolve("@node-rs/jieba/dict.txt");
      jieba = Jieba.withDict(readFileSync(dictPath));
    } catch {
      jieba = null; // fall back to whitespace splitting when the dictionary fails to load
    }
  }
  try {
    const words = jieba ? jieba.cut(text, false) : text.split(/\s+/);
    return words
      .map((t) => t.replace(/[^\p{L}\p{N}_]/gu, "")) // strip punctuation (FTS5 unicode61 does not index punctuation)
      .filter((t) => t.length > 0)
      .join(" ");
  } catch {
    return text;
  }
}

function safeSegment(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function existsSyncSafe(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function copyFileSyncSafe(from: string, to: string): void {
  try {
    copyFileSync(from, to);
  } catch {
    /* a failed backup does not block persona saving */
  }
}

export function defaultMemoryDir(): string {
  // Aligned with DSH's dsh-home-paths: $DSH_HOME/memory
  return join(resolveDshHome(undefined, process.env), "memory");
}
