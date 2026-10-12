import type * as Zod from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "./storage.js";

export interface ContinuityHandoff {
  jobId: string; sessionId: string; projectId: string; generation: number;
  cut: number; sourceHash: string; notes: string[]; uncertain: true;
}
/** Shared strict persisted DTO parser; does not read, create or grant anything. */
export function continuityHandoffSchema(z: typeof Zod): Zod.ZodType<ContinuityHandoff> {
  return z.object({ jobId: z.string().min(1).max(256), sessionId: z.string().min(1).max(256),
    projectId: z.string().regex(/^pj-[a-f0-9]{32}$/), generation: z.number().int().nonnegative().refine(Number.isSafeInteger),
    cut: z.number().int().min(-1).refine(Number.isSafeInteger), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    notes: z.array(z.string().max(280)).max(3), uncertain: z.literal(true),
  }).strict();
}
const eligible = `JOIN continuity_policy p ON p.session_id=j.session_id
  AND p.project_id=j.project_id AND p.generation=j.generation AND p.allowed=1`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const time = (now: number): void => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid continuity time");
};
export const CONTINUITY_HANDOFF_V02_DDL = `CREATE TABLE IF NOT EXISTS continuity_handoff (
  job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
  generation INTEGER NOT NULL, cut INTEGER NOT NULL, source_hash TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(length(payload)<=4000)
) STRICT`;
/** Bounded handoff + work settlement only, on the shared IMMEDIATE owner.
 * CALLER MUST verify the exact canonical source cut/hash before commit and own
 * the clock. Strict input validation does NOT authenticate source truth or
 * prevent a bounded note from containing fabricated/malicious prose. Nothing
 * here grants task completion, goals, permissions or a Continue action.
 */
export class ContinuityHandoffV02 {
  private readonly db: DatabaseSync;
  private readonly input: Zod.ZodType<{ notes: string[] }>;
  private readonly output: Zod.ZodType<ContinuityHandoff>;
  constructor(private readonly store: MemoryStore, z: typeof Zod) {
    const notes = z.array(z.string().max(280)).max(3);
    this.input = z.object({ notes }).strict();
    this.output = continuityHandoffSchema(z);
    this.db = store.getJournalSqlite();
    store.runInImmediateTransaction(() => this.db.exec(CONTINUITY_HANDOFF_V02_DDL));
  }
  commit(token: string, now: number, notes: unknown): boolean {
    // Parse ONCE before even token/time/DB checks. Never serialize/re-read the
    // caller's object, hidden toJSON or changing getter after this snapshot.
    const parsed = this.input.parse(notes);
    time(now);
    if (typeof token !== "string" || !uuid.test(token)) return false;
    return this.store.runInImmediateTransaction(() => {
      const row = this.db.prepare(`SELECT j.id,j.session_id,j.project_id,j.generation,j.cut,j.source_hash
        FROM continuity_work w JOIN continuity_jobs j ON j.id=w.job_id ${eligible}
        WHERE w.token=? AND w.status='running' AND w.lease_deadline>? AND j.status='pending'`).get(token, now) as
        { id: string; session_id: string; project_id: string; generation: number; cut: number; source_hash: string } | undefined;
      if (!row) return false;
      const result = this.output.parse({ jobId: row.id, sessionId: row.session_id, projectId: row.project_id,
        generation: row.generation, cut: row.cut, sourceHash: row.source_hash, notes: parsed.notes, uncertain: true });
      const text = JSON.stringify(result);
      if (text.length > 4000) throw new Error("continuity handoff exceeds budget");
      this.db.prepare("INSERT INTO continuity_handoff VALUES(?,?,?,?,?,?,?)").run(result.jobId, result.sessionId, result.projectId,
        result.generation, result.cut, result.sourceHash, text);
      const changed = this.db.prepare(`UPDATE continuity_work SET status='completed'
        WHERE token=? AND job_id=? AND status='running' AND lease_deadline>?
          AND EXISTS(SELECT 1 FROM continuity_jobs j ${eligible} WHERE j.id=continuity_work.job_id AND j.status='pending'
            AND j.session_id=? AND j.project_id=? AND j.generation=? AND j.cut=? AND j.source_hash=?)`).run(token, result.jobId, now,
              result.sessionId, result.projectId, result.generation, result.cut, result.sourceHash);
      if (Number(changed.changes) !== 1) throw new Error("continuity handoff admission changed");
      return true;
    });
  }
  /** Bounded CURRENT admitted handoffs for same-project offers, not automatic
   * Continue or a paused/off archive browser. Each payload passes read's exact
   * anchor/schema checks; notes remain untrusted quotes, never permission or
   * task-success evidence. A later action must recheck canonical source/policy.
   * External writers may revoke between enumeration and read: omit stale rows. */
  list(projectId: string): ContinuityHandoff[] {
    if (typeof projectId !== "string" || !/^pj-[a-f0-9]{32}$/.test(projectId)) throw new Error("invalid continuity handoff ownership");
    const ids = this.db.prepare(`SELECT h.job_id FROM continuity_handoff h
      JOIN continuity_jobs j ON j.id=h.job_id AND j.session_id=h.session_id AND j.project_id=h.project_id
        AND j.generation=h.generation AND j.cut=h.cut AND j.source_hash=h.source_hash ${eligible}
      JOIN continuity_work w ON w.job_id=j.id AND w.status='completed'
      WHERE h.project_id=? AND j.status='pending' ORDER BY h.cut DESC,h.job_id LIMIT 50`).all(projectId) as Array<{ job_id: string }>;
    const results: ContinuityHandoff[] = [];
    for (const { job_id } of ids) {
      const handoff = this.read(projectId, job_id);
      if (handoff) results.push(handoff);
    }
    return results;
  }
  read(projectId: string, jobId: string): ContinuityHandoff | null {
    if (typeof projectId !== "string" || !/^pj-[a-f0-9]{32}$/.test(projectId) || typeof jobId !== "string" || !jobId || jobId.length > 256) throw new Error("invalid continuity handoff ownership");
    const row = this.db.prepare(`SELECT h.payload,h.session_id,h.generation,h.cut,h.source_hash FROM continuity_handoff h
      JOIN continuity_jobs j ON j.id=h.job_id AND j.session_id=h.session_id AND j.project_id=h.project_id
        AND j.generation=h.generation AND j.cut=h.cut AND j.source_hash=h.source_hash ${eligible}
      JOIN continuity_work w ON w.job_id=j.id AND w.status='completed'
      WHERE h.project_id=? AND h.job_id=? AND j.status='pending'`).get(projectId, jobId) as { payload: string; session_id: string; generation: number; cut: number; source_hash: string } | undefined;
    if (!row) return null;
    if (row.payload.length > 4000) throw new Error("continuity handoff exceeds budget");
    const result = this.output.parse(JSON.parse(row.payload));
    // A persisted payload cannot silently claim anchors different from the
    // joined authoritative row, even if its JSON is schema-valid.
    if (result.projectId !== projectId || result.jobId !== jobId) throw new Error("continuity handoff payload ownership mismatch");
    if (result.sessionId !== row.session_id || result.generation !== row.generation || result.cut !== row.cut || result.sourceHash !== row.source_hash) throw new Error("continuity handoff payload anchors mismatch");
    return result;
  }
}
