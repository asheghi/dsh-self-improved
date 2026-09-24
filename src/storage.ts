/**
 * Storage module (M1): SQLite memory store.
 *
 * - memory.db: memories main table + FTS5 full-text index (a derived read model that can be rebuilt)
 * - vectors.db: sqlite-vec vec0 vector table (embedding filled from M2/M3 on; M1 only verifies the extension loads)
 *
 * Hermes-style additions (M7):
 * - memories_meta side table: provenance / source / scope / project / session / confidence / expiry / evidence / read stats
 *   (side table keeps the STRICT memories table untouched; all migrations are additive and idempotent)
 * - baseline table: bounded curated global memory slots for new-chat recall
 * - new statuses: quarantined (preserved but not searchable/injectable) and migrated (superseded legacy duplicate)
 * - schema_state KV watermark so migrations run once, idempotently
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
export type MemoryStatus = "active" | "decayed" | "forgotten" | "corrected" | "quarantined" | "migrated";
/**
 * Provenance of the content, decided before insertion:
 * user / assistant / derived = legitimate memory input;
 * system / tool / skill / unknown = must never be injected (legacy or captured system text).
 */
export type MemoryProvenance = "user" | "assistant" | "derived" | "system" | "tool" | "skill" | "unknown" | "persona";
export type MemorySource =
  | "llm-extract"
  | "user-direct"
  | "browser-correct"
  | "tool-correct"
  | "baseline-pin"
  | "legacy"
  | "persona";
export type MemoryScope = "global" | "project" | "session";

export interface MemoryMetaInput {
  provenance?: MemoryProvenance;
  source?: MemorySource;
  scope?: MemoryScope;
  projectId?: string | null;
  sessionId?: string | null;
  confidence?: number;
  expiresAt?: number | null;
  evidence?: Array<{ sessionId?: string; seq?: number; snippet?: string }>;
}

export interface MemoryMeta {
  provenance: MemoryProvenance;
  source: MemorySource;
  scope: MemoryScope;
  projectId: string | null;
  sessionId: string | null;
  confidence: number;
  expiresAt: number | null;
  evidence: Array<{ sessionId?: string; seq?: number; snippet?: string }>;
  readCount: number;
  lastReadAt: number | null;
  /** Present only for legacy rows backfilled by the store migration */
  legacy: boolean;
}

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
  meta?: MemoryMeta;
}

export function toMemoryRecord(row: Record<string, unknown>, meta?: MemoryMeta | null): MemoryRecord {
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
    ...(meta ? { meta } : {}),
  };
}

export interface MemorySearchHit {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  accessCount: number;
  score: number; // bm25 score (smaller = more relevant)
  confidence?: number;
}

export interface MemorySearchOptions {
  limit?: number;
  /** true = any term matches (OR, good for recall); false = all terms must match (AND, good for exact search) */
  matchAny?: boolean;
  /** Restrict to memories from this project (plus scope='global'); omitted = no scoping */
  projectId?: string | null;
  /** Current session id: memories created by this session are excluded (anti self-echo); empty = no filter */
  excludeSessionId?: string;
  /** Exclude rows never confirmed as legitimate memory input (provenance system/tool/skill/unknown; also excl. quarantine/migrated by status) */
  injectableOnly?: boolean;
  kind?: MemoryKind;
}

export interface ConversationSliceRecord {
  type: "user" | "assistant" | "tool";
  seq: number;
  turn?: number;
  step?: number;
  ts: number;
  text: string;
  sessionId: string;
  /** Provenance marker from capture: session events are labeled by the host (user turn vs. system-injected text) */
  injected?: boolean;
  /** host source kind recorded verbatim (e.g. "plugin", "skill-catalog"); lets extraction classify without guessing */
  sourceKind?: string;
}

const INJECTABLE_PROVENANCES: ReadonlySet<string> = new Set(["user", "persona"]);

export class MemoryStore {
  readonly dir: string;
  private db: DatabaseSync;
  private vectors: DatabaseSync | null = null;
  private closed = false;

  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.db = this.openDatabase(join(dir, "memory.db"));
    this.ensureLegacyBackup();
    this.ensureSchema(this.db);
    this.ensureSchemaVersion();
    this.repairConsistency();
    this.tryLoadVectors();
  }

  /**
   * Take the pre-Hermes backup BEFORE any schema DDL runs against an existing
   * legacy database. AUTHORITY RULE: schema_state('v1') is the only reliable
   * marker of a completed migration — a stale PRAGMA user_version>=1 without a
   * schema_state row (e.g. an interrupted upgrade from an older build) must still
   * be treated as legacy here. VACUUM INTO produces one transactionally
   * consistent snapshot (committed WAL contents included), which copying
   * db/wal/shm files separately does not.
   */
  private ensureLegacyBackup(): void {
    try {
      const v1 = this.db
        .prepare("SELECT value FROM schema_state WHERE key = 'v1'")
        .get() as { value?: string } | undefined;
      if (v1?.value) return;
    } catch {
      /* schema_state does not exist yet → pre-migration db */
    }
    let memoriesTable = false;
    let legacyCount = 0;
    try {
      const t = this.db
        .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name='memories'")
        .get() as { n?: number } | undefined;
      memoriesTable = Number(t?.n ?? 0) > 0;
      if (memoriesTable) {
        const c = this.db.prepare("SELECT COUNT(*) n FROM memories").get() as { n?: number } | undefined;
        legacyCount = Number(c?.n ?? 0);
      }
    } catch {
      /* unreadable → treat as empty */
    }
    if (legacyCount > 0) {
      const backupPath = join(this.dir, "memory.db.pre-hermes.bak");
      if (!existsSync(backupPath)) {
        try {
          const quoted = backupPath.replace(/'/g, "''");
          this.db.exec(`VACUUM INTO '${quoted}'`);
        } catch (error) {
          console.warn("[dsh-self-improved] pre-Hermes backup failed:", String(error));
        }
      }
    }
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
      -- Provenance/scope metadata side table (additive; keeps the STRICT memories table untouched)
      CREATE TABLE IF NOT EXISTS memories_meta (
        memory_id    TEXT PRIMARY KEY,
        provenance   TEXT NOT NULL DEFAULT 'unknown',
        source       TEXT NOT NULL DEFAULT 'legacy',
        scope        TEXT NOT NULL DEFAULT 'global',
        project_id   TEXT,
        session_id   TEXT,
        confidence   REAL NOT NULL DEFAULT 0.3,
        expires_at   INTEGER,
        evidence     TEXT NOT NULL DEFAULT '[]',
        read_count   INTEGER NOT NULL DEFAULT 0,
        last_read_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_memories_meta_project ON memories_meta(project_id);
      -- Bounded curated global baseline slots (slot -> memory)
      CREATE TABLE IF NOT EXISTS baseline (
        slot       INTEGER PRIMARY KEY,
        memory_id  TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_baseline_memory_id ON baseline(memory_id);
      -- Durable session → workspace mapping. Extraction may run long after the
      -- originating session flush, so project scope cannot live in mutable process state.
      CREATE TABLE IF NOT EXISTS session_projects (
        session_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      ) STRICT;
    `);
  }

  /**
   * Idempotent versioned migration. AUTHORITY: the schema_state ('v1') row is the
   * source of truth, not PRAGMA user_version — user_version is only written as a
   * courtesy marker for external tooling. v1 = provenance backfill for pre-meta
   * rows: every memories row without meta gets provenance 'unknown' / source
   * 'legacy' (never injected until explicitly accepted), and instruction-kind
   * legacy rows are quarantined (preserved, excluded from FTS search + injection —
   * status filters in queries make them invisible without deleting anything).
   */
  private ensureSchemaVersion(): void {
    let applied = false;
    try {
      const row = this.db.prepare("SELECT value FROM schema_state WHERE key = 'v1'").get() as
        | { value?: string }
        | undefined;
      applied = Boolean(row?.value);
    } catch {
      applied = false;
    }
    if (applied) {
      // Keep user_version in sync for external tooling even when schema_state says done
      this.db.exec("PRAGMA user_version = 1");
      return;
    }

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.markMigration("v1", "provenance/scope metadata backfill + legacy instruction quarantine");
      // Backfill meta for every memory row that lacks it (legacy = pre-upgrade)
      this.db.exec(`
        INSERT INTO memories_meta (memory_id, provenance, source, scope, confidence, evidence)
        SELECT m.id, 'unknown', 'legacy', 'global', 0.3, '[]'
        FROM memories m
        WHERE NOT EXISTS (SELECT 1 FROM memories_meta mm WHERE mm.memory_id = m.id)
      `);
      // Quarantine legacy injected-instruction noise (extracted system/plugin text), never delete
      this.db.exec(`
        UPDATE memories SET status = 'quarantined', updated_at = updated_at
        WHERE kind = 'instruction' AND status IN ('active', 'decayed', 'corrected')
      `);
      // Legacy quarantined rows are dropped out of the FTS index too
      this.rebuildFts();
      this.db.exec("PRAGMA user_version = 1");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private markMigration(key: string, description: string): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT`,
      )
      .run();
    this.db
      .prepare(
        `INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO NOTHING`,
      )
      .run(key, description, Date.now());
  }

  /** Whether the store has ever run the Hermes migration (used to gate one-shot scripts) */
  migrationApplied(): boolean {
    return this.migrationAppliedAt() > 0;
  }

  migrationAppliedAt(): number {
    try {
      const row = this.db.prepare("SELECT applied_at FROM schema_state WHERE key = 'v1'").get() as
        | { applied_at: number }
        | undefined;
      return Number(row?.applied_at ?? 0);
    } catch {
      return 0;
    }
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

  /** Insert one atomic memory (L1). meta records provenance/scope/origin. */
  insertMemory(input: {
    kind: MemoryKind;
    content: string;
    importance?: number;
    supersedes?: string;
  }, meta: MemoryMetaInput = {}): MemoryRecord {
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
    // Atomicity: main row + FTS row + meta row all commit together or not at all,
    // so a crash can never leave an orphaned FTS/meta row behind.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(record.id, record.kind, record.content, record.importance, 0, now, now, "active", record.supersedes ?? null);
      this.db
        .prepare(`INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)`)
        .run(tokenize(record.content), record.kind, record.id);
      this.upsertMeta(record.id, {
        provenance: meta.provenance ?? "user",
        source: meta.source ?? "user-direct",
        scope: meta.scope ?? "global",
        projectId: meta.projectId ?? null,
        sessionId: meta.sessionId ?? null,
        confidence: meta.confidence ?? 0.6,
        expiresAt: meta.expiresAt ?? null,
        evidence: meta.evidence ?? [],
        readCount: 0,
        lastReadAt: null,
        legacy: false,
      });
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    return this.getMemory(record.id) ?? record;
  }

  /**
   * Startup repair for main/meta/FTS inconsistencies (idempotent):
   * - meta rows without a memory row are removed;
   * - memory rows without a meta row are backfilled as unknown/legacy (never injected);
   * - FTS rows that point at missing or non-visible memories are dropped;
   * - visible memories missing their FTS row get re-indexed.
   * Only runs as a structural repair: an inserted memory always writes all three
   * rows atomically, so any leftover comes from a pre-transactional build or crash.
   */
  repairConsistency(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`
        DELETE FROM memories_meta
        WHERE memory_id NOT IN (SELECT id FROM memories)
      `);
      this.db.exec(`
        INSERT INTO memories_meta (memory_id, provenance, source, scope, confidence, evidence)
        SELECT m.id, 'unknown', 'legacy', 'global', 0.3, '[]'
        FROM memories m
        LEFT JOIN memories_meta mm ON mm.memory_id = m.id
        WHERE mm.memory_id IS NULL
      `);
      this.db.exec(`
        DELETE FROM memories_fts
        WHERE content_rowid NOT IN (
          SELECT id FROM memories WHERE status = 'active'
        )
      `);
      this.db.exec(`
        INSERT INTO memories_fts (search_text, kind, content_rowid)
        SELECT '', m.kind, m.id
        FROM memories m
        WHERE m.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM memories_fts f WHERE f.content_rowid = m.id)
      `);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    // Re-tokenize rows backfilled above with an empty search_text (two-phase keeps
    // the transaction free of the (slow) tokenizer loop in the common no-repair case).
    try {
      const stale = this.db
        .prepare("SELECT memories_fts.rowid AS rid, memories_fts.content_rowid AS mid FROM memories_fts WHERE search_text = '' LIMIT 512")
        .all() as Array<{ rid: number; mid: string }>;
      if (stale.length > 0) {
        const del = this.db.prepare("DELETE FROM memories_fts WHERE rowid = ?");
        const ins = this.db.prepare("INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)");
        for (const row of stale) {
          const m = this.db.prepare("SELECT kind, content, status FROM memories WHERE id = ?").get(row.mid) as
            | { kind?: string; content?: string; status?: string }
            | undefined;
          del.run(row.rid);
          if (m && m.status === "active" && m.content) {
            ins.run(tokenize(String(m.content)), String(m.kind), String(row.mid));
          }
        }
      }
    } catch (error) {
      console.warn("[dsh-self-improved] FTS re-tokenization repair failed:", String(error));
    }
  }

  /** Insert or update the meta row (on conflict only explicit fields are replaced) */
  private upsertMeta(memoryId: string, meta: MemoryMeta): void {
    this.db
      .prepare(
        `INSERT INTO memories_meta
           (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           provenance = excluded.provenance,
           source = excluded.source,
           scope = excluded.scope,
           project_id = excluded.project_id,
           session_id = excluded.session_id,
           confidence = excluded.confidence,
           expires_at = COALESCE(excluded.expires_at, memories_meta.expires_at),
           evidence = excluded.evidence`,
      )
      .run(
        memoryId,
        meta.provenance,
        meta.source,
        meta.scope,
        meta.projectId,
        meta.sessionId,
        meta.confidence,
        meta.expiresAt,
        JSON.stringify(meta.evidence ?? []),
        meta.readCount,
        meta.lastReadAt,
      );
  }

  /** Patch meta fields (accept-legacy, expiry, provenance demotion, …) */
  updateMeta(memoryId: string, patch: Partial<MemoryMetaInput> & { legacy?: boolean } = {}): boolean {
    const cur = this.readMeta(memoryId);
    if (!cur) return false;
    const next: MemoryMeta = {
      provenance: patch.provenance ?? cur.provenance,
      source: patch.source ?? cur.source,
      scope: patch.scope ?? cur.scope,
      projectId: patch.projectId !== undefined ? patch.projectId ?? null : cur.projectId,
      sessionId: patch.sessionId !== undefined ? patch.sessionId ?? null : cur.sessionId,
      confidence: patch.confidence ?? cur.confidence,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt ?? null : cur.expiresAt,
      evidence: patch.evidence ?? cur.evidence,
      readCount: cur.readCount,
      lastReadAt: cur.lastReadAt,
      legacy: patch.legacy ?? cur.legacy,
    };
    this.upsertMeta(memoryId, next);
    return true;
  }

  private readMeta(memoryId: string): MemoryMeta | null {
    const row = this.db.prepare("SELECT * FROM memories_meta WHERE memory_id = ?").get(memoryId) as
      | Record<string, unknown>
      | undefined;
    if (!row) return null;
    return {
      provenance: row.provenance as MemoryProvenance,
      source: row.source as MemorySource,
      scope: row.scope as MemoryScope,
      projectId: row.project_id == null ? null : String(row.project_id),
      sessionId: row.session_id == null ? null : String(row.session_id),
      confidence: Number(row.confidence),
      expiresAt: row.expires_at == null ? null : Number(row.expires_at),
      evidence: parseEvidence(String(row.evidence)),
      readCount: Number(row.read_count),
      lastReadAt: row.last_read_at == null ? null : Number(row.last_read_at),
      legacy: row.source === "legacy",
    };
  }

  getMeta(memoryId: string): MemoryMeta | undefined {
    return this.readMeta(memoryId) ?? undefined;
  }

  /** Record a recall hit: bumps access stats (memories.access_count + meta read stats). Deduped per 1h window in-process. */
  recordAccess(ids: string[]): void {
    const now = Date.now();
    for (const id of ids) {
      const key = `access:${id}`;
      const last = this.accessDedup.get(key);
      if (last && now - last < ACCESS_DEDUP_MS) continue;
      this.accessDedup.set(key, now);
      this.db.prepare("UPDATE memories SET access_count = access_count + 1 WHERE id = ?").run(id);
      this.db
        .prepare(
          `UPDATE memories_meta SET read_count = read_count + 1, last_read_at = ? WHERE memory_id = ?`,
        )
        .run(now, id);
    }
    if (this.accessDedup.size > 4096) {
      this.accessDedup.clear();
    }
  }

  private accessDedup = new Map<string, number>();

  /** Keyword search (jieba tokenization + FTS5 + BM25). matchAny=true uses OR (recall), default AND */
  searchMemories(query: string, options: MemorySearchOptions & MemorySearchOptions2 = {}): MemorySearchHit[] {
    const limit = options.limit ?? 10;
    if (!query.trim()) return [];
    const terms = this.ftsTerms(query);
    if (terms.length === 0) return [];
    const escaped = terms.join(options.matchAny ? " OR " : " AND ");
    const where: string[] = [];
    const whereParams: Array<string | number> = [];
    // Only provenance-legitimate rows are recallable when injectableOnly (legacy/tool/skill/system rows stay invisible to injection).
    // scope='session' rows are task-local simply by being written — structurally excluded from injection, not just prompted away.
    // Expired rows (expires_at in the past) are also dropped: the expiry signal must take effect, not just be stored.
    if (options.injectableOnly) {
      where.push(
        `(EXISTS (SELECT 1 FROM memories_meta mm WHERE mm.memory_id = m.id AND mm.provenance IN ('user','persona'))` +
        ` AND NOT EXISTS (SELECT 1 FROM memories_meta mms WHERE mms.memory_id = m.id AND mms.scope = 'session')` +
        ` AND NOT EXISTS (SELECT 1 FROM memories_meta mme WHERE mme.memory_id = m.id AND mme.expires_at IS NOT NULL AND mme.expires_at <= ?))`,
      );
      whereParams.push(Date.now());
    }
    if (options.projectId) {
      where.push("(mmj.scope = 'global' OR (mmj.scope = 'project' AND mmj.project_id = ?))");
      whereParams.push(options.projectId);
    }
    if (options.excludeSessionId) {
      where.push("NOT EXISTS (SELECT 1 FROM memories_meta mmx WHERE mmx.memory_id = m.id AND mmx.session_id = ?)");
      whereParams.push(options.excludeSessionId);
    }
    if (options.kind) {
      where.push("m.kind = ?");
      whereParams.push(options.kind);
    }
    const sql = `
      SELECT m.id, m.kind, m.content, m.importance, m.access_count,
             bm25(memories_fts) AS score,
             mmj.confidence AS confidence
      FROM memories_fts
      JOIN memories m ON m.id = memories_fts.content_rowid
      JOIN memories_meta mmj ON mmj.memory_id = m.id
      WHERE memories_fts MATCH ?
        AND m.status = 'active'
        ${where.length > 0 ? `AND ${where.join(" AND ")}` : ""}
      ORDER BY score
      LIMIT ?`;
    const rows = this.db.prepare(sql).all(escaped, ...whereParams, limit) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      kind: row.kind as MemoryKind,
      content: String(row.content),
      importance: Number(row.importance),
      accessCount: Number(row.access_count),
      score: Number(row.score),
      ...(row.confidence == null ? {} : { confidence: Number(row.confidence) }),
    }));
  }

  /** jieba tokenization → FTS5 quoted terms (punctuation stripped, FTS syntax injection impossible) */
  private ftsTerms(query: string, maxTerms = 24): string[] {
    const raw = tokenize(query)
      .split(/\s+/)
      .filter(Boolean)
      .map((term) => term.replace(/"/g, ""))
      .filter((term) => term.length > 0);
    // Long queries must remain bounded (defence against pathological inputs)
    return raw.slice(0, maxTerms).map((term) => `"${term}"`);
  }

  listMemories(options: { kind?: MemoryKind; limit?: number; offset?: number; status?: MemoryStatus; injectableOnly?: boolean } = {}): MemoryRecord[] {
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.kind) { where.push("kind = ?"); params.push(options.kind); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.injectableOnly) {
      where.push("EXISTS (SELECT 1 FROM memories_meta mm WHERE mm.memory_id = memories.id AND mm.provenance IN ('user','persona'))");
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM memories ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toFullRecord(r));
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.toFullRecord(row);
  }

  private toFullRecord(row: Record<string, unknown>): MemoryRecord {
    const record: MemoryRecord = {
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
    const meta = this.readMeta(record.id);
    if (meta) record.meta = meta;
    // MemoryRecord.meta carries a legacy flag field, keep it on the object
    return record;
  }

  /** Mark as forgotten (paired with decay from M4 on; M1 provides basic delete capability) */
  forgetMemory(id: string): boolean {
    const res = this.db.prepare("UPDATE memories SET status = 'forgotten', updated_at = ? WHERE id = ?").run(Date.now(), id);
    return res.changes > 0;
  }

  /** Point a memory at its supersedes winner (migration dedup traceability); no-op when already set */
  updateSupersedes(id: string, winnerId: string): boolean {
    const res = this.db
      .prepare("UPDATE memories SET supersedes = ?, updated_at = ? WHERE id = ? AND supersedes IS NULL")
      .run(winnerId, Date.now(), id);
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
    this.db.prepare("DELETE FROM memories_meta WHERE memory_id = ?").run(id);
    this.db.prepare("DELETE FROM baseline WHERE memory_id = ?").run(id);
    return res.changes > 0;
  }

  /** Rebuild the FTS index from the memories table (only active rows are indexed; corrected/superseded rows are no longer recalled). Deterministic + lossless. */
  rebuildFts(): void {
    this.db.prepare("DELETE FROM memories_fts").run();
    const rows = this.db.prepare("SELECT id, kind, content FROM memories WHERE status = 'active'").all() as
      Array<Record<string, unknown>>;
    const insert = this.db.prepare("INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)");
    for (const r of rows) insert.run(tokenize(String(r.content)), String(r.kind), String(r.id));
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

  /** Persist the canonical workspace key for a session so delayed extraction keeps correct scope. */
  setSessionProject(sessionId: string, projectId: string): void {
    const normalized = projectId.trim() || "default";
    this.db
      .prepare(
        `INSERT INTO session_projects (session_id, project_id, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET project_id = excluded.project_id, updated_at = excluded.updated_at`,
      )
      .run(sessionId, normalized, Date.now());
  }

  getSessionProject(sessionId: string): string {
    const row = this.db.prepare("SELECT project_id FROM session_projects WHERE session_id = ?").get(sessionId) as
      | { project_id?: string }
      | undefined;
    return row?.project_id ? String(row.project_id) : "default";
  }

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

  /** Number of memories created after ts (with optional importance floor); persona/scene quality gate */
  countNewMemoriesSince(ts: number, minImportance = 0): number {
    const row = minImportance > 0
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? (this.db.prepare("SELECT COUNT(*) c FROM memories WHERE status = 'active' AND created_at > ? AND importance >= ?").get(ts, minImportance) as any)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : (this.db.prepare("SELECT COUNT(*) c FROM memories WHERE status = 'active' AND created_at > ?").get(ts) as any);
    return Number(row?.c ?? 0);
  }

  /**
   * Currently active memories (consumed by consolidate / evolve).
   * injectableOnly=true restricts to provenance-legitimate rows, so consolidation,
   * persona/scene synthesis and skill synthesis never run on legacy/system text
   * (dead work) and legacy noise does not push real memories out of the decay cap.
   */
  getActiveMemories(limit: number, minImportance = 0, injectableOnly = false): MemoryRecord[] {
    const where = injectableOnly
      ? [`EXISTS (SELECT 1 FROM memories_meta mm WHERE mm.memory_id = memories.id AND mm.provenance IN ('user','persona'))`]
      : [];
    const params: Array<string | number> = [];
    if (minImportance > 0) { where.push("importance >= ?"); params.push(minImportance); }
    const whereSql = where.length > 0 ? `WHERE status = 'active' AND ${where.join(" AND ")}` : "WHERE status = 'active'";
    const rows2 = this.db
      .prepare(`SELECT * FROM memories ${whereSql} ORDER BY importance DESC, updated_at DESC LIMIT ?`)
      .all(...params, limit);
    return (rows2 as Array<Record<string, unknown>>).map((r) => this.toFullRecord(r));
  }

  /** Set a memory's status (corrected / decayed / forgotten / active / quarantined / migrated) */
  setMemoryStatus(id: string, status: MemoryStatus): boolean {
    const res = this.db.prepare("UPDATE memories SET status = ?, updated_at = ? WHERE id = ?").run(status, Date.now(), id);
    if (res.changes === 0) return false;
    // FTS mirrors visibility: only active rows stay indexed. Reactivating rebuilds
    // the row; any other transition (corrected/decayed/forgotten/quarantined/migrated)
    // must remove it so a superseded record can never be recalled again.
    this.db.prepare("DELETE FROM memories_fts WHERE content_rowid = ?").run(id);
    if (status === "active") {
      const row = this.db.prepare("SELECT kind, content FROM memories WHERE id = ?").get(id) as
        | { kind?: string; content?: string }
        | undefined;
      if (row?.content) {
        this.db.prepare("INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)").run(tokenize(row.content), row.kind ?? "fact", id);
      }
    }
    return true;
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

  // ---------- Curated global baseline ----------

  /**
   * Pin a memory into the first free baseline slot (bounded manual curation).
   * Uniqueness: memory_id holds at most one pin — re-pinning returns the existing
   * slot. When all maxSlots are full this returns null (nothing is auto-evicted;
   * manual replacement via pinBaselineSlot stays available). Returns the slot.
   */
  pinBaseline(memoryId: string, maxSlots = 15): number | null {
    if (!this.getMemory(memoryId)) return null;
    const existing = this.db.prepare("SELECT slot FROM baseline WHERE memory_id = ?").get(memoryId) as
      | { slot: number }
      | undefined;
    if (existing) return Number(existing.slot);
    const used = this.db.prepare("SELECT slot FROM baseline ORDER BY slot").all() as Array<{ slot: number }>;
    const taken = new Set(used.map((u) => Number(u.slot)));
    for (let slot = 1; slot <= maxSlots; slot++) {
      if (taken.has(slot)) continue;
      this.db
        .prepare(`INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(slot) DO UPDATE SET memory_id = excluded.memory_id, updated_at = excluded.updated_at`)
        .run(slot, memoryId, Date.now());
      return slot;
    }
    return null;
  }

  /**
   * Replace one slot's content (slot 1..maxSlots must already exist or be free).
   * Uniqueness enforced: a memory already pinned elsewhere is MOVED to the target
   * slot; when that slot is occupied the occupant swaps into the vacated slot, so
   * no duplicate memory_id can ever exist and no slot silently loses content.
   */
  pinBaselineSlot(memoryId: string, slot: number): number | null {
    if (!this.getMemory(memoryId)) return null;
    if (!Number.isInteger(slot) || slot < 1) return null;
    const current = this.db.prepare("SELECT slot FROM baseline WHERE memory_id = ?").get(memoryId) as
      | { slot: number }
      | undefined;
    const currentSlot = current ? Number(current.slot) : null;
    if (currentSlot === slot) return slot;
    const occupant = this.db.prepare("SELECT memory_id FROM baseline WHERE slot = ?").get(slot) as
      | { memory_id: string }
      | undefined;
    const occupantId = occupant ? String(occupant.memory_id) : null;

    if (currentSlot === null) {
      // Not pinned yet: manual replacement of the target slot is allowed
      this.db
        .prepare(`INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)
                  ON CONFLICT(slot) DO UPDATE SET memory_id = excluded.memory_id, updated_at = excluded.updated_at`)
        .run(slot, memoryId, Date.now());
      return slot;
    }
    // Already pinned: move the pin (swap with the occupant when present)
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (occupantId) {
        this.db.prepare("UPDATE baseline SET slot = ? WHERE memory_id = ?").run(Number.MAX_SAFE_INTEGER, occupantId);
        this.db.prepare("UPDATE baseline SET slot = ? WHERE memory_id = ?").run(slot, memoryId);
        this.db.prepare("UPDATE baseline SET slot = ? WHERE memory_id = ?").run(currentSlot, occupantId);
      } else {
        this.db.prepare("UPDATE baseline SET slot = ? WHERE memory_id = ?").run(slot, memoryId);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    const moved = this.db.prepare("SELECT slot FROM baseline WHERE memory_id = ?").get(memoryId) as
      | { slot: number }
      | undefined;
    return moved ? Number(moved.slot) : null;
  }

  unpinBaseline(slot: number): boolean {
    return this.db.prepare("DELETE FROM baseline WHERE slot = ?").run(slot).changes > 0;
  }

  listBaseline(): Array<{ slot: number; memoryId: string; memory?: MemoryRecord }> {
    const rows = this.db.prepare("SELECT slot, memory_id FROM baseline ORDER BY slot").all() as
      Array<Record<string, unknown>>;
    return rows.map((r) => {
      const slot = Number(r.slot);
      const memoryId = String(r.memory_id);
      return { slot, memoryId, memory: this.getMemory(memoryId) };
    });
  }

  // ---------- Growth governance (M6) ----------

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

// Options alias to keep the extended search signature readable
type MemorySearchOptions2 = {
  excludeSessionId?: string;
  injectableOnly?: boolean;
};

const ACCESS_DEDUP_MS = 3_600_000;

function parseEvidence(raw: string): Array<{ sessionId?: string; seq?: number; snippet?: string }> {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as Array<{ sessionId?: string; seq?: number; snippet?: string }>).slice(0, 5) : [];
  } catch {
    return [];
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
