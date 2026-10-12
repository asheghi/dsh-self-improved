import { randomUUID } from "node:crypto";
import type * as Zod from "zod";
import { continuityProjectionDefinition } from "./continuity-registry-v02.js";
import { CONTINUITY_STATE_VERSION, type ContinuityProjectionState } from "./continuity-projection-v02.js";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "./storage.js";
import type { BoundContinuityCheckpoint } from "./continuity-checkpoint-v02.js";

export type ContinuityTrigger = "turn-end" | "pause" | "finish";
export interface ContinuityJobReference {
  id: string; sessionId: string; projectId: string; cut: number; generation: number;
  trigger: ContinuityTrigger; status: "pending" | "cancelled";
}
export const CONTINUITY_V02_DDL = {
  continuity_policy: `CREATE TABLE IF NOT EXISTS continuity_policy (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>=0), allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
  ) STRICT`,
  continuity_checkpoint: `CREATE TABLE IF NOT EXISTS continuity_checkpoint (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL,
    cut INTEGER NOT NULL CHECK(cut>=-1), source_hash TEXT NOT NULL, envelope TEXT NOT NULL
  ) STRICT`,
  continuity_jobs: `CREATE TABLE IF NOT EXISTS continuity_jobs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    generation INTEGER NOT NULL, cut INTEGER NOT NULL CHECK(cut>=-1), source_hash TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN('turn-end','pause','finish')),
    status TEXT NOT NULL CHECK(status IN('pending','cancelled')),
    UNIQUE(session_id,generation,cut,source_hash,trigger)
  ) STRICT`,
} as const;
export type ContinuityV02Table = keyof typeof CONTINUITY_V02_DDL;
/** Canonical strict envelope schema shared by enqueue and offline row preflight. */
export function continuityV02CheckpointEnvelopeSchema(z: typeof Zod): Zod.ZodType {
  return z.object({ format: z.literal(1), sessionId: z.string().min(1).max(256),
    headerHash: z.string().regex(/^[a-f0-9]{64}$/), inheritedEventCount: z.number().int().nonnegative(),
    asOfSeq: z.number().int().min(-1), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    row: z.object({ ver: z.literal(CONTINUITY_STATE_VERSION), seq: z.number().int().min(-1),
      val: continuityProjectionDefinition(z).stateSchema }).strict(),
  }).strict();
}
const CONTINUITY_V02_COLUMNS: Record<ContinuityV02Table, readonly { name: string; type: string; pk: number }[]> = {
  continuity_policy: [
    { name: "session_id", type: "TEXT", pk: 1 }, { name: "project_id", type: "TEXT", pk: 0 },
    { name: "generation", type: "INTEGER", pk: 0 }, { name: "allowed", type: "INTEGER", pk: 0 },
  ],
  continuity_checkpoint: [
    { name: "session_id", type: "TEXT", pk: 1 }, { name: "project_id", type: "TEXT", pk: 0 },
    { name: "generation", type: "INTEGER", pk: 0 }, { name: "cut", type: "INTEGER", pk: 0 },
    { name: "source_hash", type: "TEXT", pk: 0 }, { name: "envelope", type: "TEXT", pk: 0 },
  ],
  continuity_jobs: [
    { name: "id", type: "TEXT", pk: 1 }, { name: "session_id", type: "TEXT", pk: 0 },
    { name: "project_id", type: "TEXT", pk: 0 }, { name: "generation", type: "INTEGER", pk: 0 },
    { name: "cut", type: "INTEGER", pk: 0 }, { name: "source_hash", type: "TEXT", pk: 0 },
    { name: "trigger", type: "TEXT", pk: 0 }, { name: "status", type: "TEXT", pk: 0 },
  ],
};
export function normalizeContinuityDdl(sql: string): string {
  // Remove only the CREATE prefix's idempotency modifier. Normalize formatting
  // outside quoted values, whose case and whitespace can change CHECK semantics.
  const source = sql.replace(/^\s*CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+/i, "CREATE TABLE ");
  let result = "";
  let inString = false;
  let pendingSpace = false;
  const punctuation = "(),=<>";
  for (let index = 0; index < source.length; index++) {
    const char = source[index]!;
    if (inString) {
      result += char;
      if (char === "'") {
        if (source[index + 1] === "'") result += source[++index]!;
        else inString = false;
      }
      continue;
    }
    if (char === "'") {
      if (pendingSpace && result.length && !punctuation.includes(result.at(-1)!)) result += " ";
      pendingSpace = false;
      result += char;
      inString = true;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && result.length && !punctuation.includes(char) && !punctuation.includes(result.at(-1)!)) result += " ";
    pendingSpace = false;
    result += char;
  }
  return result.trim();
}
function denyContinuityRows(db: DatabaseSync, denyAll: boolean, sessionIds: readonly string[], projectIds: readonly string[]): void {
  if (denyAll) {
    db.exec("UPDATE main.continuity_policy SET allowed=0,generation=generation+1 WHERE allowed=1");
    db.exec("UPDATE main.continuity_jobs SET status='cancelled' WHERE status='pending'");
    db.exec("DELETE FROM main.continuity_checkpoint");
    return;
  }
  for (const sessionId of new Set(sessionIds)) {
    db.prepare("UPDATE main.continuity_policy SET allowed=0,generation=generation+1 WHERE session_id=? AND allowed=1").run(sessionId);
    db.prepare("UPDATE main.continuity_jobs SET status='cancelled' WHERE session_id=? AND status='pending'").run(sessionId);
    db.prepare("DELETE FROM main.continuity_checkpoint WHERE session_id=?").run(sessionId);
  }
  for (const projectId of new Set(projectIds)) {
    db.prepare("UPDATE main.continuity_policy SET allowed=0,generation=generation+1 WHERE project_id=? AND allowed=1").run(projectId);
    db.prepare("UPDATE main.continuity_jobs SET status='cancelled' WHERE project_id=? AND status='pending'").run(projectId);
    db.prepare("DELETE FROM main.continuity_checkpoint WHERE project_id=?").run(projectId);
  }
}
/** Revoke EXISTING continuity rows independently of optional SDK/Zod ability.
 * Fixed schema metadata only: no table creation, source read, parser or grant.
 * Partial/incompatible schemas throw before writes; caller closes ingress.
 */
export function matchesContinuityV02Schema(db: DatabaseSync, table: ContinuityV02Table): boolean {
  const stored = db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=? COLLATE NOCASE").get(table) as { sql: string | null } | undefined;
  if (!stored?.sql || normalizeContinuityDdl(stored.sql) !== normalizeContinuityDdl(CONTINUITY_V02_DDL[table])) return false;
  const columns = db.prepare(`PRAGMA main.table_xinfo('${table}')`).all() as Array<{
    cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number;
  }>;
  const expected = CONTINUITY_V02_COLUMNS[table];
  if (columns.length !== expected.length || !expected.every((field, index) => {
    const column = columns[index];
    return column.cid === index && column.hidden === 0 && column.name === field.name && column.type === field.type
      && column.notnull === 1 && column.dflt_value === null && column.pk === field.pk;
  })) return false;
  const expectedOrigins = table === "continuity_jobs" ? ["pk", "u"] : ["pk"];
  const indexes = db.prepare(`PRAGMA main.index_list('${table}')`).all() as Array<{ unique: number; origin: string; partial: number }>;
  if (indexes.length !== expectedOrigins.length || indexes.some(index => index.unique !== 1 || index.partial !== 0
    || !expectedOrigins.includes(index.origin)) || expectedOrigins.some(origin => indexes.filter(index => index.origin === origin).length !== 1)) return false;
  const customIndex = db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='index' AND tbl_name=? COLLATE NOCASE AND sql IS NOT NULL LIMIT 1").get(table);
  const trigger = db.prepare("SELECT 1 AS found FROM sqlite_schema WHERE type='trigger' AND tbl_name=? COLLATE NOCASE LIMIT 1").get(table);
  return customIndex === undefined && trigger === undefined;
}
/** Revoke EXISTING continuity rows independently of optional SDK/Zod ability.
 * Fixed schema metadata only: no table creation, source read, parser or grant.
 * Any schema other than this exact v2 layout throws before the first row write.
 */
export function fenceExistingContinuity(store: MemoryStore, enabled: boolean, sessionIds: readonly string[], projectIds: readonly string[]): void {
  store.runInImmediateTransaction(() => {
    const db = store.getJournalSqlite();
    // TEMP objects can shadow main names or attach triggers/indexes to main tables.
    const tempObject = db.prepare("SELECT 1 AS found FROM sqlite_temp_schema WHERE name COLLATE NOCASE IN ('continuity_policy','continuity_checkpoint','continuity_jobs') OR tbl_name COLLATE NOCASE IN ('continuity_policy','continuity_checkpoint','continuity_jobs') LIMIT 1").get();
    if (tempObject !== undefined) throw new Error("incompatible existing continuity schema");
    const tables = db.prepare("SELECT name,type,strict FROM pragma_table_list WHERE name COLLATE NOCASE IN ('continuity_policy','continuity_checkpoint','continuity_jobs') AND schema='main'")
      .all() as Array<{ name: string; type: string; strict: number }>;
    if (tables.length === 0) return;
    const expectedTables = Object.keys(CONTINUITY_V02_DDL) as ContinuityV02Table[];
    if (tables.length !== expectedTables.length || tables.some(table => table.type !== "table" || table.strict !== 1)
      || expectedTables.some(name => !tables.some(table => table.name.toLowerCase() === name))
      || expectedTables.some(name => !matchesContinuityV02Schema(db, name)))
      throw new Error("incompatible existing continuity schema");
    denyContinuityRows(db, !enabled, sessionIds, projectIds);
  });
}
/** Separate continuity references, not personal-memory extraction sources.
 * No body, tool arguments/results, provider verdict or permission is stored.
 * All writes share the MemoryStore connection/IMMEDIATE transaction owner.
 */
export class ContinuityStoreV02 {
  private readonly db: DatabaseSync;
  private readonly envelopeSchema: Zod.ZodType;
  private readonly stateSchema: Zod.ZodType<ContinuityProjectionState>;
  constructor(private readonly store: MemoryStore, z: typeof Zod) {
    this.stateSchema = continuityProjectionDefinition(z).stateSchema;
    this.envelopeSchema = continuityV02CheckpointEnvelopeSchema(z);
    this.db = store.getJournalSqlite();
    store.runInImmediateTransaction(() => this.db.exec(Object.values(CONTINUITY_V02_DDL).join(";\n")));
  }
  /** Explicit admission owner must resolve native session/project/privacy first.
   * Denial invalidates queued references and checkpoint together; reenable
   * never resurrects cancelled work. Even identical policy updates fence work.
   */
  setPolicy(sessionId: string, projectId: string, allowed: boolean): number {
    if (!sessionId || !/^pj-[a-f0-9]{32}$/.test(projectId)) throw new Error("invalid continuity ownership");
    return this.store.runInImmediateTransaction(() => {
      const old = this.db.prepare("SELECT generation FROM continuity_policy WHERE session_id=?").get(sessionId) as { generation: number } | undefined;
      const generation = (old?.generation ?? -1) + 1;
      if (!Number.isSafeInteger(generation)) throw new Error("continuity generation overflow");
      this.db.prepare(`INSERT INTO continuity_policy VALUES(?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        project_id=excluded.project_id,generation=excluded.generation,allowed=excluded.allowed`).run(sessionId, projectId, generation, allowed ? 1 : 0);
      this.db.prepare("UPDATE continuity_jobs SET status='cancelled' WHERE session_id=? AND status='pending'").run(sessionId);
      this.db.prepare("DELETE FROM continuity_checkpoint WHERE session_id=?").run(sessionId);
      return generation;
    });
  }
  /** Master/capture privacy pause fences ALL admitted references atomically.
   * Repeated denied sync is inert; no task/body data is reconstructed here. */
  denyAll(): void {
    this.store.runInImmediateTransaction(() => denyContinuityRows(this.db, true, [], []));
  }
  /** Current session/project exclusions revoke OLD rows immediately, without
   * waiting for a future boundary. All matched fences commit together. */
  denyExcluded(sessionIds: readonly string[], projectIds: readonly string[]): void {
    this.store.runInImmediateTransaction(() => denyContinuityRows(this.db, false, sessionIds, projectIds));
  }
  /** Read existing ownership without invalidating restart continuity. */
  readPolicy(sessionId: string): { projectId: string; generation: number; allowed: boolean } | null {
    const row = this.db.prepare("SELECT project_id,generation,allowed FROM continuity_policy WHERE session_id=?").get(sessionId) as { project_id: string; generation: number; allowed: number } | undefined;
    return row ? { projectId: row.project_id, generation: row.generation, allowed: row.allowed === 1 } : null;
  }
  /** Idempotent trusted admission: unchanged boot policy preserves work;
   * changed project/privacy controls fence it in the same transaction. */
  ensurePolicy(sessionId: string, projectId: string, allowed: boolean): number {
    return this.store.runInImmediateTransaction(() => {
      const current = this.readPolicy(sessionId);
      return current && current.projectId === projectId && current.allowed === allowed
        ? current.generation : this.setPolicy(sessionId, projectId, allowed);
    });
  }
  /** Atomically checkpoint + deduplicated job reference. Caller must pass a
   * canonical-bound/recovered envelope, not an arbitrary client/model blob.
   */
  enqueue(envelope: BoundContinuityCheckpoint, projectId: string, generation: number, trigger: ContinuityTrigger): { id: string; created: boolean } {
    if (!Number.isSafeInteger(generation) || generation < 0 || !["turn-end", "pause", "finish"].includes(trigger)) throw new Error("invalid continuity enqueue");
    // Persist/use ONLY the parsed plain snapshot. Serializing or validating
    // the caller's object can invoke hidden toJSON or changing getters.
    envelope = this.envelopeSchema.parse(envelope) as BoundContinuityCheckpoint;
    if (envelope.row.seq !== envelope.asOfSeq) throw new Error("invalid continuity source cut");
    const state = this.stateSchema.parse(envelope.row.val);
    if (state.inheritedEventCount !== envelope.inheritedEventCount || state.lastOwnSeq > envelope.asOfSeq) throw new Error("continuity envelope anchors disagree");
    const text = JSON.stringify(envelope);
    // Structural checkpoint must be bounded and body-free even if caller errs.
    if (text.length > 24_000) throw new Error("continuity checkpoint exceeds structural budget");
    return this.store.runInImmediateTransaction(() => {
      const policy = this.db.prepare("SELECT * FROM continuity_policy WHERE session_id=?").get(envelope.sessionId) as { project_id: string; generation: number; allowed: number } | undefined;
      if (!policy || !policy.allowed || policy.project_id !== projectId || policy.generation !== generation) throw new Error("continuity admission stale or denied");
      const previous = this.db.prepare("SELECT cut,source_hash FROM continuity_checkpoint WHERE session_id=?").get(envelope.sessionId) as { cut: number; source_hash: string } | undefined;
      if (previous && (previous.cut > envelope.asOfSeq || (previous.cut === envelope.asOfSeq && previous.source_hash !== envelope.sourceHash))) throw new Error("continuity cut regression or conflict");
      this.db.prepare(`INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET
        project_id=excluded.project_id,generation=excluded.generation,cut=excluded.cut,source_hash=excluded.source_hash,envelope=excluded.envelope`).run(envelope.sessionId, projectId, generation, envelope.asOfSeq, envelope.sourceHash, text);
      const id = randomUUID();
      const inserted = this.db.prepare("INSERT OR IGNORE INTO continuity_jobs VALUES(?,?,?,?,?,?,?,'pending')").run(id, envelope.sessionId, projectId, generation, envelope.asOfSeq, envelope.sourceHash, trigger);
      const row = this.db.prepare("SELECT id FROM continuity_jobs WHERE session_id=? AND generation=? AND cut=? AND source_hash=? AND trigger=?").get(envelope.sessionId, generation, envelope.asOfSeq, envelope.sourceHash, trigger) as { id: string };
      return { id: row.id, created: Number(inserted.changes) === 1 };
    });
  }
  readCheckpoint(sessionId: string, projectId: string): BoundContinuityCheckpoint | null {
    const row = this.db.prepare(`SELECT c.envelope FROM continuity_checkpoint c JOIN continuity_policy p USING(session_id)
      WHERE c.session_id=? AND c.project_id=? AND p.project_id=c.project_id AND p.allowed=1 AND p.generation=c.generation`).get(sessionId, projectId) as { envelope: string } | undefined;
    return row ? JSON.parse(row.envelope) as BoundContinuityCheckpoint : null;
  }
  listPending(projectId: string): ContinuityJobReference[] {
    const rows = this.db.prepare(`SELECT j.* FROM continuity_jobs j JOIN continuity_policy p USING(session_id)
      WHERE j.project_id=? AND p.project_id=j.project_id AND p.allowed=1 AND p.generation=j.generation AND j.status='pending'
      ORDER BY j.cut,j.id LIMIT 100`).all(projectId) as Array<{ id: string; session_id: string; project_id: string; cut: number; generation: number; trigger: ContinuityTrigger; status: "pending" }>;
    return rows.map(row => ({ id: row.id, sessionId: row.session_id, projectId: row.project_id, cut: row.cut, generation: row.generation, trigger: row.trigger, status: row.status }));
  }
}
