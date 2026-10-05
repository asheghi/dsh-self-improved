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
 * coordinator = text authored by a delegating coordinator (task brief) captured in
 * a delegated subagent session — preserved for audit but NEVER injectable;
 * system / tool / skill / unknown = must never be injected (legacy or captured system text).
 */
export type MemoryProvenance = "user" | "assistant" | "derived" | "system" | "tool" | "skill" | "unknown" | "persona" | "coordinator";
export type MemorySource =
  | "llm-extract"
  /** paste-suspicious demoted draft: recallable in its own scope, never persona/profile material */
  | "llm-extract-pasted"
  | "user-direct"
  | "browser-correct"
  | "tool-correct"
  | "baseline-pin"
  | "episode-review"
  | "legacy"
  | "persona";
export type MemoryScope = "global" | "project" | "session";

/**
 * Evidence entry stored with memory meta. Episode-review rows additionally
 * point at the source episode and the exact successful step call.
 */
export interface MemoryEvidence {
  sessionId?: string;
  seq?: number;
  snippet?: string;
  /** Episode-learning linkage (Phase 3): source episode + successful call id */
  episodeId?: string;
  callId?: string;
}

export interface MemoryMetaInput {
  provenance?: MemoryProvenance;
  source?: MemorySource;
  scope?: MemoryScope;
  projectId?: string | null;
  sessionId?: string | null;
  confidence?: number;
  expiresAt?: number | null;
  evidence?: Array<MemoryEvidence>;
}

export interface MemoryMeta {
  provenance: MemoryProvenance;
  source: MemorySource;
  scope: MemoryScope;
  projectId: string | null;
  sessionId: string | null;
  confidence: number;
  expiresAt: number | null;
  evidence: Array<MemoryEvidence>;
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
        ver           INTEGER PRIMARY KEY AUTOINCREMENT,
        content       TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        mem_watermark INTEGER
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
      -- Insertion-order watermark: a global monotonic sequence per memory. Persona
      -- gating uses this instead of millisecond timestamps, so memories added in the
      -- same clock tick are still counted as "newer than the stored version".
      CREATE TABLE IF NOT EXISTS memories_seq (
        memory_id TEXT PRIMARY KEY,
        seq       INTEGER NOT NULL
      ) STRICT;
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
    // Additive migration: databases created before mem_watermark lack the column
    // (CREATE TABLE IF NOT EXISTS does not alter an existing table).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const personaCols = db.prepare("PRAGMA table_info(persona_versions)").all() as Array<any>;
    if (personaCols.length > 0 && !personaCols.some((c) => c.name === "mem_watermark")) {
      db.exec("ALTER TABLE persona_versions ADD COLUMN mem_watermark INTEGER");
    }
    this.ensureEpisodeSchema(db);
  }

  /**
   * Episode-learning tables (schema v2). STRICT + additive only; every statement
   * is CREATE TABLE IF NOT EXISTS, so it is safe to run from both ensureSchema and
   * the v2 migration recovery path (an interrupted migration re-runs cleanly).
   * Result pairing in episode_steps happens ONLY via call_id, never by position.
   */
  private ensureEpisodeSchema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS episode_events (
        session_id TEXT NOT NULL, kind TEXT NOT NULL, call_id TEXT,
        turn INTEGER NOT NULL, step INTEGER, seq INTEGER NOT NULL, at INTEGER NOT NULL,
        payload TEXT NOT NULL, created_at INTEGER NOT NULL, episode_id TEXT,
        PRIMARY KEY (session_id, kind, call_id, seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_episode_events_session ON episode_events(session_id, episode_id);
      CREATE TABLE IF NOT EXISTS episodes (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL,
        project_id   TEXT NOT NULL,
        turn         INTEGER NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending',
        started_at   INTEGER NOT NULL,
        ended_at     INTEGER,
        updated_at   INTEGER NOT NULL,
        first_seq    INTEGER,
        last_seq     INTEGER,
        reviewed_at  INTEGER,
        summary      TEXT,
        confidence   REAL,
        fingerprint  TEXT,
        delegated    INTEGER NOT NULL DEFAULT 0,
        reject_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_episodes_project_status ON episodes(project_id, status, updated_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_session_turn ON episodes(session_id, turn);
      CREATE INDEX IF NOT EXISTS idx_episodes_reviewed ON episodes(reviewed_at);
      CREATE INDEX IF NOT EXISTS idx_episodes_fingerprint ON episodes(fingerprint);
      CREATE TABLE IF NOT EXISTS episode_steps (
        episode_id         TEXT NOT NULL,
        ordinal            INTEGER NOT NULL,
        call_id            TEXT NOT NULL,
        tool_name          TEXT NOT NULL,
        arguments_redacted TEXT NOT NULL,
        result_excerpt     TEXT NOT NULL,
        is_error           INTEGER NOT NULL,
        error_name         TEXT,
        error_code         TEXT,
        call_seq           INTEGER,
        result_seq         INTEGER,
        call_at            INTEGER,
        result_at          INTEGER,
        args_truncated     INTEGER NOT NULL DEFAULT 0,
        result_truncated   INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (episode_id, ordinal),
        UNIQUE (episode_id, call_id)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_episode_steps_call ON episode_steps(episode_id, call_id);
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
      this.ensureSchemaV2();
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
    this.ensureSchemaV2();
  }

  /**
   * Idempotent v2 marker (episode learning tables). The episode DDL itself is
   * created by ensureSchema (CREATE TABLE IF NOT EXISTS), so the v2 transaction
   * only records the schema_state marker; because every statement idempotent,
   * an interrupted earlier attempt (tables present, marker absent, e.g. deleted
   * manually or killed mid-transaction) re-runs cleanly. Memories/meta rows are
   * never touched by this migration.
   */
  private ensureSchemaV2(): void {
    let applied = false;
    try {
      const row = this.db.prepare("SELECT value FROM schema_state WHERE key = 'v2'").get() as
        | { value?: string }
        | undefined;
      applied = Boolean(row?.value);
    } catch {
      applied = false;
    }
    if (applied) {
      this.db.exec("PRAGMA user_version = 2");
      return;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.ensureEpisodeSchema(this.db);
      this.markMigration("v2", "episode learning tables (episodes/episode_steps/episode_events)");
      this.db.exec("PRAGMA user_version = 2");
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

  /** Schema_state marker version: v1&&v2 → 2, v1 → 1, unset → 0 */
  schemaVersion(): number {
    try {
      const rows = this.db.prepare("SELECT key FROM schema_state").all() as Array<{ key: string }>;
      const keys = new Set(rows.map((r) => String(r.key)));
      if (keys.has("v1") && keys.has("v2")) return 2;
      if (keys.has("v1")) return 1;
      return 0;
    } catch {
      return 0;
    }
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

  /** Lazily-loaded base of the insertion watermark (MAX(seq) over memories_seq; -1 = uninitialized) */
  private memSeqBase = -1;

  /** Next insertion-watermark value. Strictly increasing over the store lifetime. */
  private nextMemSeq(): number {
    if (this.memSeqBase < 0) {
      const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM memories_seq").get() as { m: number };
      this.memSeqBase = Number(row.m);
    }
    this.memSeqBase += 1;
    return this.memSeqBase;
  }

  /**
   * Insert one atomic memory (L1). meta records provenance/scope/origin.
   * FAIL CLOSED: omitting provenance yields the untrusted 'unknown' tier (never
   * injected); every trusted insert must state provenance explicitly.
   */
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
        .prepare(`INSERT INTO memories_seq (memory_id, seq) VALUES (?, ?)`)
        .run(record.id, this.nextMemSeq());
      this.db
        .prepare(`INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)`)
        .run(tokenize(record.content), record.kind, record.id);
      this.upsertMeta(record.id, {
        // Fail closed: an omitted provenance MUST NOT default to the trusted tier.
        // 'unknown' rows are never injected or recallable until a caller or user
        // explicitly asserts their origin.
        provenance: meta.provenance ?? "unknown",
        source: meta.provenance ? (meta.source ?? "user-direct") : "legacy",
        scope: meta.scope ?? "global",
        projectId: meta.projectId ?? null,
        sessionId: meta.sessionId ?? null,
        confidence: meta.confidence ?? (meta.provenance ? 0.6 : 0.3),
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
   * ATOMIC episode-review persistence: insert the derived memories AND mark the
   * episode reviewed in ONE BEGIN IMMEDIATE transaction, or nothing at all.
   * Gates (refused → rollback, return false; no state change):
   *  - the episode must still be terminal & unreviewed ('succeeded'/'failed',
   *    reviewed_at NULL) when the transaction runs — a concurrent review pass,
   *    demotion to ambiguous, or deletion invalidates the batch;
   *  - EVERY evidence entry must reference an existing episode_steps row of
   *    THIS episode with is_error = 0 (successful calls only).
   * opts.validateOnly = validation only, no writes (dryRun path).
   * On any throw: ROLLBACK + rethrow (caller counts an error; episode stays
   * unreviewed for the next pass).
   */
  commitEpisodeLearnings(
    input: {
      episodeId: string;
      // 'rejected' verdicts persist reject_reason and leave no memories.
      status: "reviewed" | "rejected";
      summary: string | null;
      confidence: number | null;
      rejectReason: string | null;
      memories: Array<{
        content: string;
        confidence: number;
        expiresAt?: number | null;
        evidence: Array<{ episodeId: string; callId: string; snippet: string }>;
      }>;
    },
    opts: { validateOnly?: boolean } = {},
  ): boolean {
    const loadEpisode = (): { status: string; reviewed_at: number | null; session_id: string | null; project_id: string | null } | undefined =>
      this.db
        .prepare(`SELECT status, reviewed_at, session_id, project_id FROM episodes WHERE id = ?`)
        .get(input.episodeId) as
        | { status: string; reviewed_at: number | null; session_id: string | null; project_id: string | null }
        | undefined;
    const verifyEvidence = (memory: {
      evidence: Array<{ episodeId: string; callId: string; snippet: string }>;
    }): boolean => {
      const stmt = this.db.prepare(
        `SELECT 1 FROM episode_steps WHERE episode_id = ? AND call_id = ? AND is_error = 0`,
      );
      for (const ev of memory.evidence) {
        if (!stmt.get(input.episodeId, ev.callId)) return false;
      }
      return true;
    };
    if (opts.validateOnly === true) {
      const row = loadEpisode();
      if (!row || (row.status !== "succeeded" && row.status !== "failed") || row.reviewed_at !== null) return false;
      for (const memory of input.memories) {
        if (!verifyEvidence(memory)) return false;
      }
      return true;
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = loadEpisode();
      if (
        !row ||
        (row.status !== "succeeded" && row.status !== "failed") ||
        row.reviewed_at !== null ||
        !input.memories.every(verifyEvidence)
      ) {
        this.db.exec("ROLLBACK");
        return false;
      }
      const now = Date.now();
      for (const memory of input.memories) {
        const record: MemoryRecord = {
          id: randomUUID(),
          kind: "fact",
          content: memory.content,
          importance: 6,
          accessCount: 0,
          createdAt: now,
          updatedAt: now,
          status: "active",
        };
        // Mirror insertMemory's row set exactly: main row + seq + FTS + meta.
        this.db
          .prepare(
            `INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(record.id, record.kind, record.content, record.importance, 0, now, now, "active", record.supersedes ?? null);
        this.db.prepare(`INSERT INTO memories_seq (memory_id, seq) VALUES (?, ?)`).run(record.id, this.nextMemSeq());
        this.db
          .prepare(`INSERT INTO memories_fts (search_text, kind, content_rowid) VALUES (?, ?, ?)`)
          .run(tokenize(record.content), record.kind, record.id);
        this.upsertMeta(record.id, {
          provenance: "derived",
          source: "episode-review",
          scope: "project",
          projectId: row.project_id ?? null,
          sessionId: row.session_id ?? null,
          confidence: memory.confidence,
          expiresAt: memory.expiresAt ?? null,
          evidence: memory.evidence.map((e) => ({
            episodeId: e.episodeId,
            callId: e.callId,
            sessionId: row.session_id ?? undefined,
            snippet: e.snippet,
          })),
          readCount: 0,
          lastReadAt: null,
          legacy: false,
        });
      }
      this.db
        .prepare(
          `UPDATE episodes SET status = ?, summary = ?, confidence = ?, reject_reason = ?,
              reviewed_at = ?, updated_at = ?
           WHERE id = ? AND status IN ('succeeded', 'failed') AND reviewed_at IS NULL`,
        )
        .run(input.status, input.summary ?? "", input.confidence ?? 0, input.rejectReason ?? null, now, now, input.episodeId);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    return true;
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

  /**
   * Operational-memory search (Phase 4, SEPARATE recall lane). Only rows written
   * by episode review (provenance='derived' + source='episode-review', project
   * scope, non-expired, confidence floor, carrying episode/call evidence) are
   * eligible. This lane never touches the trusted recall paths: derived rows
   * remain invisible to searchMemories/injectableOnly/baseline/persona.
   * FAIL CLOSED: empty projectId or empty trimmed query → [].
   */
  searchOperationalMemories(
    query: string,
    options: { projectId: string; excludeSessionId?: string; limit?: number; confidenceFloor?: number },
  ): Array<{
    id: string;
    kind: MemoryKind;
    content: string;
    importance: number;
    score: number;
    confidence: number;
    evidence: Array<MemoryEvidence>;
  }> {
    const projectId = options.projectId;
    // FAIL CLOSED: an empty project key or empty query yields nothing (never unscoped)
    if (!projectId || !projectId.trim() || !query.trim()) return [];
    const terms = this.ftsTerms(query);
    if (terms.length === 0) return [];
    const limit = Math.max(0, Math.min(Math.floor(options.limit ?? 10), 50));
    const floor = options.confidenceFloor ?? 0;
    // Over-fetch (bounded) so rows failing the post-fetch evidence validation can
    // be filtered out while the requested count is still filled.
    const fetchLimit = limit * 3;
    const rows = this.db
      .prepare(
        `
        SELECT m.id, m.kind, m.content, m.importance,
               bm25(memories_fts) AS score,
               mm.confidence AS confidence,
               mm.evidence AS evidence_json
        FROM memories_fts
        JOIN memories m ON m.id = memories_fts.content_rowid
        JOIN memories_meta mm ON mm.memory_id = m.id
        WHERE memories_fts MATCH ?
          AND m.status = 'active'
          AND mm.provenance = 'derived'
          AND mm.source = 'episode-review'
          AND mm.scope = 'project'
          AND mm.project_id = ?
          AND mm.evidence != '[]'
          AND (mm.expires_at IS NULL OR mm.expires_at > ?)
          AND mm.confidence >= ?
          ${
            options.excludeSessionId
              ? "AND NOT EXISTS (SELECT 1 FROM memories_meta mms WHERE mms.memory_id = m.id AND mms.session_id = ?)"
              : ""
          }
        ORDER BY score
        LIMIT ?`,
      )
      .all(...(options.excludeSessionId
        ? [terms.join(" OR "), projectId, Date.now(), floor, options.excludeSessionId, fetchLimit]
        : [terms.join(" OR "), projectId, Date.now(), floor, fetchLimit])) as Array<Record<string, unknown>>;
    // Evidence eligibility is the SERIALIZED structure, not a non-empty string:
    // every returned row must carry at least one evidence entry with BOTH a
    // non-empty episodeId and a non-empty callId; malformed JSON drops out too.
    return rows
      .filter((row) => {
        const evidence = parseEvidence(String(row.evidence_json ?? "[]"));
        return evidence.some(
          (e) => typeof e.episodeId === "string" && e.episodeId.trim() !== "" && typeof e.callId === "string" && e.callId.trim() !== "",
        );
      })
      .slice(0, limit)
      .map((row) => ({
      id: String(row.id),
      kind: row.kind as MemoryKind,
      content: String(row.content),
      importance: Number(row.importance),
      score: Number(row.score),
      confidence: Number(row.confidence),
      evidence: parseEvidence(String(row.evidence_json ?? "[]")),
    }));
  }

  /**
   * Derived operational-memory contents learned from the given sessions'
   * episodes (Phase 5 skill-synthesis support EVIDENCE ONLY: provenance
   * 'derived', source 'episode-review'). Read-only, additive, bounded.
   */
  operationalMemoryContentsBySession(sessionIds: string[], limitPerSession = 10, maxChars = 500): string[] {
    const contents: string[] = [];
    const seen = new Set<string>();
    for (const chunk of chunkList(sessionIds.filter((s) => s && s.trim()), 100)) {
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT m.content, m.id FROM memories m
           JOIN memories_meta mm ON mm.memory_id = m.id
           WHERE mm.source = 'episode-review'
             AND mm.provenance = 'derived'
             AND mm.session_id IN (${placeholders})
           ORDER BY m.created_at DESC `,
        )
        .all(...chunk) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const id = String(row.id);
        if (seen.has(id)) continue;
        seen.add(id);
        if (contents.length < limitPerSession * Math.max(1, sessionIds.length)) {
          contents.push(String(row.content ?? "").slice(0, maxChars));
        }
      }
    }
    return contents.slice(0, limitPerSession * Math.max(1, sessionIds.length));
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

  /** Current deterministic insertion watermark: the MAX(seq) of memories_seq at
   *  the moment of the call. Capture this BEFORE an awaited step (e.g. the LLM
   *  call in persona synthesis) and pass it to savePersona, so rows inserted
   *  while the awaited work runs stay visible to the next regeneration gate. */
  personaMemWatermark(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM memories_seq").get() as { m: number };
    return Number(row.m);
  }

  /** Save the persona (version +1, writes the persona.md mirror).
   *  memWatermark: pre-captured insertion watermark (captured together with the
   *  synthesis input snapshot, BEFORE the awaited LLM call). When omitted the
   *  current MAX(seq) at save time is used — acceptable only when no awaited
   *  work separates the input snapshot from the save (e.g. rebuild scripts). */
  savePersona(content: string, memWatermark?: number): number {
    const now = Date.now();
    const watermark = memWatermark ?? this.personaMemWatermark();
    const res = this.db
      .prepare("INSERT INTO persona_versions (content, created_at, mem_watermark) VALUES (?, ?, ?)")
      .run(content, now, watermark);
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

  /** Read the latest persona (undefined if none). memWatermark = deterministic
   * insertion-order seq at save time (null for pre-watermark rows → caller falls
   * back to the millisecond createdAt comparison). */
  getPersona(): { ver: number; content: string; createdAt: number; memWatermark: number | null } | undefined {
    const row = this.db
      .prepare("SELECT ver, content, created_at, mem_watermark FROM persona_versions ORDER BY ver DESC LIMIT 1")
      .get() as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      ver: Number(row.ver),
      content: String(row.content),
      createdAt: Number(row.created_at),
      memWatermark: row.mem_watermark == null ? null : Number(row.mem_watermark),
    };
  }

  /**
   * Deterministic persona-regeneration gate: count the same candidate rows the
   * consolidator feeds the personas (active, user-provenance, global scope,
   * fact/preference, not paste-demoted) that were INSERTED after the persona
   * version represented by `persona`'s watermark. Watermark comparison is by
   * insertion sequence, never wall-clock, so rows added in the same millisecond
   * as the saved persona still count as newer. Legacy personas without a
   * watermark fall back to the createdAt comparison (same as before).
   */
  countNewMemoriesForPersona(
    persona: { ver: number; memWatermark: number | null; createdAt: number },
  ): number {
    // Watermark mode (all persona rows written by this build): count candidate
    // rows whose insertion seq exceeds the persona watermark — deterministic,
    // independent of wall-clock ticks. Seq rows of deleted memories are orphaned
    // but harmless: the JOIN only counts memories that still exist.
    if (persona.memWatermark != null) {
      const counted = this.db
        .prepare(
          `SELECT COUNT(*) AS n
           FROM memories_seq s
           JOIN memories ON memories.id = s.memory_id
           JOIN memories_meta mm ON mm.memory_id = memories.id
           WHERE s.seq > ?
             AND memories.status = 'active'
             AND mm.provenance = 'user'
             AND mm.source != 'llm-extract-pasted'
             AND mm.scope = 'global'
             AND memories.kind IN ('fact', 'preference')`,
        )
        .get(persona.memWatermark) as { n: number };
      return Number(counted.n);
    }
    // Legacy fallback (pre-watermark personas): the original millisecond gate.
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n
         FROM memories
         JOIN memories_meta mm ON mm.memory_id = memories.id
         WHERE memories.status = 'active'
           AND mm.provenance = 'user'
           AND mm.source != 'llm-extract-pasted'
           AND mm.scope = 'global'
           AND memories.kind IN ('fact', 'preference')
           AND memories.created_at > ?`,
      )
      .get(persona.createdAt) as { n: number };
    return Number(row.n);
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

  /** Trusted-provenance gate for baseline pins: only user/persona rows may be pinned */
  private isBaselineEligible(memoryId: string): boolean {
    const record = this.getMemory(memoryId);
    if (!record) return false;
    const provenance = record.meta?.provenance;
    return provenance === "user" || provenance === "persona";
  }

  /**
   * Pin a memory into the first free baseline slot (bounded manual curation).
   * Uniqueness: memory_id holds at most one pin — re-pinning returns the existing
   * slot. When all maxSlots are full this returns null (nothing is auto-evicted;
   * manual replacement via pinBaselineSlot stays available). Returns the slot.
   * HARD GATE: derived/episode-review rows (and any non-user/persona provenance)
   * can NEVER be pinned into the global baseline.
   */
  pinBaseline(memoryId: string, maxSlots = 15): number | null {
    if (!this.isBaselineEligible(memoryId)) return null;
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
    if (!this.isBaselineEligible(memoryId)) return null;
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

  // ---------- Episode learning (schema v2) ----------

  /** Per-session delegated classification stated by capture (in-process; decided from the immutable header each flush) */
  private sessionEpisodeDelegated = new Map<string, boolean>();

  /** Whether the session was last classified as delegated by episode capture */
  episodeDelegated(sessionId: string): boolean {
    return this.sessionEpisodeDelegated.get(sessionId) ?? false;
  }

  /**
   * Append raw (already REDACTED-and-bounded) episode event rows for one session.
   * Idempotent: INSERT OR IGNORE keyed on (session_id, kind, call_id, seq).
   * The project scope is recorded so delayed assembly keeps correct scoping.
   */
  appendEpisodeEvents(sessionId: string, projectId: string, delegated: boolean, rows: EpisodeEventInput[]): void {
    if (rows.length === 0) return;
    if (delegated || !this.sessionEpisodeDelegated.has(sessionId)) {
      this.sessionEpisodeDelegated.set(sessionId, delegated);
    }
    this.setSessionProject(sessionId, projectId);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db
        .prepare(
          `INSERT OR IGNORE INTO episode_events
             (session_id, kind, call_id, turn, step, seq, at, payload, created_at, episode_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        );
      const now = Date.now();
      for (const r of rows) {
        stmt.run(sessionId, r.kind, r.callId, r.turn, r.step, r.seq, r.at, r.payload, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  /** Unclaimed (episode_id IS NULL) episode events, ordered by seq */
  getPendingEpisodeEvents(sessionId: string, limit = 2000): EpisodeEventRecord[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM episode_events WHERE session_id = ? AND episode_id IS NULL ORDER BY seq LIMIT ?`,
      )
      .all(sessionId, limit) as Array<Record<string, unknown>>;
    return rows.map((r) => toEpisodeEventRecord(r));
  }

  /** Distinct sessions that still hold unclaimed episode events (recovery/retention sweep). */
  sessionsWithPendingEpisodeEvents(limit = 500): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT session_id FROM episode_events WHERE episode_id IS NULL LIMIT ?`)
      .all(limit) as Array<{ session_id: string }>;
    return rows.map((r) => String(r.session_id));
  }

  /** Highest turn among ALL episode events of a session (claimed + unclaimed).
   * Turn-closure detection must read the full ledger, not just the pending
   * prefix: a 2000-row open turn must not hide later-turn closure forever. */
  maxEventTurn(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(MAX(turn), 0) AS m FROM episode_events WHERE session_id = ?`)
      .get(sessionId) as { m: number };
    return Number(row.m);
  }

  /** All episode events of one turn (claimed or not) — closed turns are re-derived from the full set so flush-straddling pairs are never lost. */
  getTurnEpisodeEvents(sessionId: string, turn: number): EpisodeEventRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM episode_events WHERE session_id = ? AND turn = ? ORDER BY seq`)
      .all(sessionId, turn) as Array<Record<string, unknown>>;
    return rows.map((r) => toEpisodeEventRecord(r));
  }

  /** Highest captured episode-event seq for a session (cursor floor for capture) */
  lastEpisodeSeq(sessionId: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM episode_events WHERE session_id = ?")
      .get(sessionId) as { m: number };
    return Number(row.m);
  }

  /**
   * Claim a closed turn's episode events into an episode (durable linkage for
   * audit; includes turn-end rows and toolCallId-less result rows).
   */
  claimEpisodeEvents(sessionId: string, callIds: string[], turn: number, episodeId: string): number {
    let changes = 0;
    const chunks = callIds.length === 0 ? [[]] : chunkList(callIds, 400);
    for (const chunk of chunks) {
      const placeholders = chunk.map(() => "?").join(",");
      const res = this.db
        .prepare(
          `UPDATE episode_events SET episode_id = ?
           WHERE session_id = ? AND turn = ? AND episode_id IS NULL
             AND (kind = 'turn-end' OR call_id IS NULL OR call_id = '' OR call_id IN (${placeholders}))`,
        )
        .run(
          episodeId,
          sessionId,
          turn,
          ...(chunk.length === 0 ? [] : chunk),
        );
      changes += Number(res.changes);
    }
    return changes;
  }

  /**
   * Upsert one (session_id, turn) episode. NEVER reclassifies: when the row is
   * frozen (reviewed/rejected) or already terminal, it is returned untouched;
   * only new rows and pending rows are updated. Runs INSIDE a caller transaction
   * when invoked via commitEpisode.
   */
  upsertEpisode(input: EpisodeUpsertInput): { id: string; created: boolean } {
    const now = Date.now();
    const existing = this.getEpisodeBySessionTurn(input.sessionId, input.turn);
    if (existing) {
      const frozen =
        existing.reviewedAt != null || existing.status === "reviewed" || existing.status === "rejected";
      if (frozen || existing.status !== "pending") {
        return { id: existing.id, created: false };
      }
      const firstSeq = minNullable(input.firstSeq, existing.firstSeq);
      const lastSeq = maxNullable(input.lastSeq, existing.lastSeq);
      this.db
        .prepare(
          `UPDATE episodes SET status = ?, project_id = ?, started_at = ?, ended_at = ?, updated_at = ?,
             first_seq = ?, last_seq = ?, fingerprint = ?, delegated = ?
           WHERE id = ?`,
        )
        .run(
          input.status,
          input.projectId,
          Math.min(input.startedAt, existing.startedAt),
          input.endedAt ?? existing.endedAt,
          now,
          firstSeq,
          lastSeq,
          input.fingerprint ?? existing.fingerprint,
          input.delegated || existing.delegated ? 1 : 0,
          existing.id,
        );
      return { id: existing.id, created: false };
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO episodes
           (id, session_id, project_id, turn, status, started_at, ended_at, updated_at, first_seq, last_seq,
            reviewed_at, summary, confidence, fingerprint, delegated, reject_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL)`,
      )
      .run(
        id,
        input.sessionId,
        input.projectId,
        input.turn,
        input.status,
        input.startedAt,
        input.endedAt,
        now,
        input.firstSeq,
        input.lastSeq,
        input.fingerprint,
        input.delegated ? 1 : 0,
      );
    return { id, created: true };
  }

  /**
   * Commit one closed turn atomically: episode upsert + step rows + event claims
   * all commit together or not at all (acid replay safety).
   */
  commitEpisode(
    input: EpisodeUpsertInput,
    steps: EpisodeStepInput[],
    claimCallIds: string[],
  ): { id: string; created: boolean } {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // Gate: re-read the target episode inside the transaction; reviewed/rejected
      // rows are frozen — inserting steps/claims into them must be refused.
      const existing = this.getEpisodeBySessionTurn(input.sessionId, input.turn);
      if (existing && (existing.reviewedAt != null || existing.status === "reviewed" || existing.status === "rejected")) {
        console.warn("[dsh-self-improved] commitEpisode refused (frozen episode):", existing.id, existing.status);
        this.db.exec("ROLLBACK");
        return { id: existing.id, created: false };
      }
      const { id, created } = this.upsertEpisode(input);
      const stmt = this.db
        .prepare(
          `INSERT OR IGNORE INTO episode_steps
             (episode_id, ordinal, call_id, tool_name, arguments_redacted, result_excerpt, is_error,
              error_name, error_code, call_seq, result_seq, call_at, result_at, args_truncated, result_truncated)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
      for (const s of steps) {
        stmt.run(
          id,
          s.ordinal,
          s.callId,
          s.toolName,
          s.argumentsRedacted,
          s.resultExcerpt,
          s.isError,
          s.errorName,
          s.errorCode,
          s.callSeq,
          s.resultSeq,
          s.callAt,
          s.resultAt,
          s.argsTruncated,
          s.resultTruncated,
        );
      }
      this.claimEpisodeEvents(input.sessionId, claimCallIds, input.turn, id);
      this.db.exec("COMMIT");
      return { id, created };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }

  getEpisode(id: string): EpisodeRecord | undefined {
    const row = this.db.prepare("SELECT * FROM episodes WHERE id = ?").get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? toEpisodeRecord(row) : undefined;
  }

  getEpisodeBySessionTurn(sessionId: string, turn: number): EpisodeRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM episodes WHERE session_id = ? AND turn = ?")
      .get(sessionId, turn) as Record<string, unknown> | undefined;
    return row ? toEpisodeRecord(row) : undefined;
  }

  listEpisodes(
    options: { projectId?: string; status?: EpisodeStatus; limit?: number; unreviewedOnly?: boolean } = {},
  ): EpisodeRecord[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
    if (options.status) { where.push("status = ?"); params.push(options.status); }
    if (options.unreviewedOnly) { where.push("reviewed_at IS NULL"); }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM episodes ${whereSql} ORDER BY updated_at DESC LIMIT ?`)
      .all(...params, options.limit ?? 50) as Array<Record<string, unknown>>;
    return rows.map((r) => toEpisodeRecord(r));
  }

  /** Counts per episode status in a project (or store-wide) */
  episodeCounts(projectId?: string): Record<
    "pending" | "succeeded" | "failed" | "ambiguous" | "reviewed" | "rejected",
    number
  > {
    const rows = (projectId
      ? this.db
          .prepare(
            `SELECT status, COUNT(*) n FROM episodes WHERE project_id = ? GROUP BY status`,
          )
          .all(projectId)
      : this.db.prepare(`SELECT status, COUNT(*) n FROM episodes GROUP BY status`).all()) as Array<{
      status: string;
      n: number;
    }>;
    const counts = { pending: 0, succeeded: 0, failed: 0, ambiguous: 0, reviewed: 0, rejected: 0 };
    for (const r of rows) {
      const key = r.status as keyof typeof counts;
      if (key in counts) counts[key] = Number(r.n);
    }
    return counts;
  }

  getEpisodeSteps(episodeId: string): EpisodeStepRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM episode_steps WHERE episode_id = ? ORDER BY ordinal`)
      .all(episodeId) as Array<Record<string, unknown>>;
    return rows.map((r) => toEpisodeStepRecord(r));
  }

  /** Record a review outcome (reviewed/rejected); ambiguous/pending rows are never learned from.
   * Gate: only terminal, never-reviewed episodes ('succeeded'/'failed' with reviewed_at NULL)
   * can be reviewed — anything else refuses and returns false. */
  setEpisodeReview(
    id: string,
    review: { summary: string; confidence: number; status: "reviewed" | "rejected"; rejectReason?: string | null },
  ): boolean {
    const now = Date.now();
    const res = this.db
      .prepare(
        `UPDATE episodes SET summary = ?, confidence = ?, status = ?, reject_reason = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('succeeded', 'failed') AND reviewed_at IS NULL`,
      )
      .run(review.summary, review.confidence, review.status, review.rejectReason ?? null, now, now, id);
    return res.changes > 0;
  }

  /** Generic episode status update (consistency repair paths); never touches reviewed/rejected rows. */
  private updateEpisodeStatusId(id: string, status: EpisodeStatus, endedAtFromUpdatedAt: boolean): boolean {
    const row = this.getEpisode(id);
    if (!row || row.reviewedAt != null || row.status === "reviewed" || row.status === "rejected") return false;
    const endedAt = endedAtFromUpdatedAt ? (row.endedAt ?? row.updatedAt) : row.endedAt;
    const res = this.db
      .prepare(`UPDATE episodes SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?`)
      .run(status, endedAt, Date.now(), id);
    return res.changes > 0;
  }

  /**
   * Late-evidence revalidation: a terminal (succeeded/failed) episode with
   * reviewed_at NULL whose turn just received NEW unclaimed event rows is demoted
   * to ambiguous ('late-evidence') — completion proof may have changed. Reviewed/
   * rejected rows and ambiguous/pending rows are never touched here.
   * Returns the episode id when demoted, null otherwise.
   */
  revalidateEpisodeLateEvidence(sessionId: string, turn: number): string | null {
    const row = this.getEpisodeBySessionTurn(sessionId, turn);
    if (!row || row.reviewedAt != null) return null;
    if (row.status !== "succeeded" && row.status !== "failed") return null;
    const res = this.db
      .prepare(
        `UPDATE episodes SET status = 'ambiguous', summary = NULL, confidence = NULL,
            reject_reason = 'late-evidence', updated_at = ?
          WHERE id = ? AND status IN ('succeeded', 'failed') AND reviewed_at IS NULL`,
      )
      .run(Date.now(), row.id);
    return Number(res.changes) > 0 ? row.id : null;
  }

  /**
   * Close stale pending episodes (no deterministic evidence of completion within
   * the window): status pending AND updated_at < now-olderThanMs → ambiguous,
   * ended_at falls back to the last update time. Ambiguous episodes are never
   * learned from. Returns the number closed.
   */
  closeStalePendingEpisodes(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const res = this.db
      .prepare(
        `UPDATE episodes SET status = 'ambiguous',
           ended_at = COALESCE(ended_at, updated_at),
           updated_at = ?
         WHERE status = 'pending' AND updated_at < ?`,
      )
      .run(Date.now(), cutoff);
    return Number(res.changes);
  }

  /** Raw episode-event row count (governance) */
  totalEpisodeEventCount(): number {
    const row = this.db.prepare("SELECT COUNT(*) n FROM episode_events").get() as { n: number };
    return Number(row.n);
  }

  /**
   * Purge episodes (+ steps, + their event rows) plus stale unclaimed event rows.
   * Returns deleted counts. Never touches memories rows.
   * The age cutoff is INCLUSIVE (updated_at <= olderThanTs), so days=0 purges
   * everything up to and including now; a project filter alone purges the whole
   * project; with NO filters at all nothing is deleted (no unfiltered universe).
   */
  purgeEpisodes(options: { projectId?: string; olderThanTs?: number } = {}): {
    episodes: number;
    steps: number;
    events: number;
  } {
    const counts = { episodes: 0, steps: 0, events: 0 };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const where: string[] = [];
      const params: Array<string | number> = [];
      if (options.projectId) { where.push("project_id = ?"); params.push(options.projectId); }
      if (options.olderThanTs !== undefined) { where.push("COALESCE(updated_at, 0) <= ?"); params.push(options.olderThanTs); }
      if (where.length > 0) {
        const ids = (
          this.db
            .prepare(`SELECT id FROM episodes WHERE ${where.join(" AND ")}`)
            .all(...params) as Array<{ id: string }>
        ).map((r) => String(r.id));
        if (ids.length > 0) {
          for (const chunk of chunkList(ids, 400)) {
            const ph = chunk.map(() => "?").join(",");
            const resSteps = this.db.prepare(`DELETE FROM episode_steps WHERE episode_id IN (${ph})`).run(...chunk);
            const resEvents = this.db.prepare(`DELETE FROM episode_events WHERE episode_id IN (${ph})`).run(...chunk);
            const resEpisodes = this.db.prepare(`DELETE FROM episodes WHERE id IN (${ph})`).run(...chunk);
            counts.steps += Number(resSteps.changes);
            counts.events += Number(resEvents.changes);
            counts.episodes += Number(resEpisodes.changes);
          }
        }
      }
      if (options.olderThanTs !== undefined) {
        // Stale unclaimed rows (never assembled) are purged on created_at AGE,
        // never on seq (seq is an event counter, not an epoch timestamp), and are
        // scoped by project through the durable session→project mapping.
        const purgeUnclaimed = this.db
          .prepare(
            `DELETE FROM episode_events
               WHERE episode_id IS NULL AND created_at < ?
                 ${options.projectId ? "AND session_id IN (SELECT session_id FROM session_projects WHERE project_id = ?)" : ""}`,
          )
          .run(...(options.projectId ? [options.olderThanTs, options.projectId] : [options.olderThanTs]));
        counts.events += Number(purgeUnclaimed.changes);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
    return counts;
  }

  /**
   * Episode-side consistency repair (idempotent, called at startup like repairConsistency):
   * ① orphan steps (episode row gone) are deleted;
   * ② succeeded/failed episodes with zero steps are demoted to ambiguous (no evidence → never learned from);
   * ③ pending episodes whose turn is provably closed (a later turn exists in the same session) but were
   *    never assembled are demoted to ambiguous (unpaired evidence).
   */
  repairEpisodeConsistency(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec(`DELETE FROM episode_steps WHERE episode_id NOT IN (SELECT id FROM episodes)`);
      const now = Date.now();
      this.db
        .prepare(
          `UPDATE episodes SET status = 'ambiguous',
             ended_at = COALESCE(ended_at, updated_at), updated_at = ?
           WHERE status IN ('succeeded', 'failed')
             AND NOT EXISTS (SELECT 1 FROM episode_steps s WHERE s.episode_id = episodes.id)`,
        )
        .run(now);
      this.db
        .prepare(
          `UPDATE episodes SET status = 'ambiguous',
             ended_at = COALESCE(ended_at, updated_at), updated_at = ?
           WHERE status = 'pending'
             AND EXISTS (
               SELECT 1 FROM episodes later
               WHERE later.session_id = episodes.session_id AND later.turn > episodes.turn
             )`,
        )
        .run(now);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw error;
    }
  }
}

// ---------- Episode learning types ----------

export type EpisodeStatus = "pending" | "succeeded" | "failed" | "ambiguous" | "reviewed" | "rejected";
export type EpisodeEventKind = "call" | "result" | "turn-end";

/** Redaction happened BEFORE this struct is built; payload here is the bounded JSON string. */
export interface EpisodeEventInput {
  kind: EpisodeEventKind;
  callId: string | null;
  turn: number;
  step: number | null;
  seq: number;
  at: number;
  payload: string;
}

export interface EpisodeEventRecord extends EpisodeEventInput {
  sessionId: string;
  episodeId: string | null;
}

export interface EpisodeStepInput {
  episodeId: string;
  ordinal: number;
  callId: string;
  toolName: string;
  argumentsRedacted: string;
  resultExcerpt: string;
  isError: number;
  errorName: string | null;
  errorCode: string | null;
  callSeq: number | null;
  resultSeq: number | null;
  callAt: number | null;
  resultAt: number | null;
  argsTruncated: number;
  resultTruncated: number;
}

export type EpisodeStepRecord = EpisodeStepInput;

export interface EpisodeUpsertInput {
  sessionId: string;
  projectId: string;
  turn: number;
  status: EpisodeStatus;
  startedAt: number;
  endedAt: number | null;
  firstSeq: number | null;
  lastSeq: number | null;
  fingerprint: string | null;
  delegated: boolean;
}

export interface EpisodeRecord {
  id: string;
  sessionId: string;
  projectId: string;
  turn: number;
  status: EpisodeStatus;
  startedAt: number;
  endedAt: number | null;
  updatedAt: number;
  firstSeq: number | null;
  lastSeq: number | null;
  reviewedAt: number | null;
  summary: string | null;
  confidence: number | null;
  fingerprint: string | null;
  delegated: boolean;
  rejectReason: string | null;
}

function toEpisodeEventRecord(row: Record<string, unknown>): EpisodeEventRecord {
  return {
    sessionId: String(row.session_id),
    kind: row.kind as EpisodeEventKind,
    callId: row.call_id == null ? null : String(row.call_id),
    turn: Number(row.turn),
    step: row.step == null ? null : Number(row.step),
    seq: Number(row.seq),
    at: Number(row.at),
    payload: String(row.payload),
    episodeId: row.episode_id == null ? null : String(row.episode_id),
  };
}

function toEpisodeRecord(row: Record<string, unknown>): EpisodeRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    projectId: String(row.project_id),
    turn: Number(row.turn),
    status: row.status as EpisodeStatus,
    startedAt: Number(row.started_at),
    endedAt: row.ended_at == null ? null : Number(row.ended_at),
    updatedAt: Number(row.updated_at),
    firstSeq: row.first_seq == null ? null : Number(row.first_seq),
    lastSeq: row.last_seq == null ? null : Number(row.last_seq),
    reviewedAt: row.reviewed_at == null ? null : Number(row.reviewed_at),
    summary: row.summary == null ? null : String(row.summary),
    confidence: row.confidence == null ? null : Number(row.confidence),
    fingerprint: row.fingerprint == null ? null : String(row.fingerprint),
    delegated: Number(row.delegated) === 1,
    rejectReason: row.reject_reason == null ? null : String(row.reject_reason),
  };
}

function toEpisodeStepRecord(row: Record<string, unknown>): EpisodeStepRecord {
  return {
    episodeId: String(row.episode_id),
    ordinal: Number(row.ordinal),
    callId: String(row.call_id),
    toolName: String(row.tool_name),
    argumentsRedacted: String(row.arguments_redacted),
    resultExcerpt: String(row.result_excerpt),
    isError: Number(row.is_error),
    errorName: row.error_name == null ? null : String(row.error_name),
    errorCode: row.error_code == null ? null : String(row.error_code),
    callSeq: row.call_seq == null ? null : Number(row.call_seq),
    resultSeq: row.result_seq == null ? null : Number(row.result_seq),
    callAt: row.call_at == null ? null : Number(row.call_at),
    resultAt: row.result_at == null ? null : Number(row.result_at),
    argsTruncated: Number(row.args_truncated),
    resultTruncated: Number(row.result_truncated),
  };
}

function chunkList<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function minNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.min(a, b);
}

function maxNullable(a: number | null, b: number | null): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return Math.max(a, b);
}

// Options alias to keep the extended search signature readable
type MemorySearchOptions2 = {
  excludeSessionId?: string;
  injectableOnly?: boolean;
};

const ACCESS_DEDUP_MS = 3_600_000;

function parseEvidence(raw: string): Array<MemoryEvidence> {
  try {
    const arr = JSON.parse(raw) as unknown;
    return Array.isArray(arr) ? (arr as Array<MemoryEvidence>).slice(0, 5) : [];
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
