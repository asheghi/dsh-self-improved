import type { SessionQueryEngine, SessionObservation } from "@deepseek-ai/dsh-session-query";
import type { SessionHeader } from "@deepseek-ai/dsh-session/types";
import type * as Zod from "zod";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "./storage.js";
import { continuityHandoffSchema } from "./continuity-handoff-v02.js";
import { isDelegatedHeader, opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";

export interface ContinuityArchiveItem {
  jobId: string; sourceSessionId: string; projectId: string; cut: number; generation: number;
  sourceReferenceStatus: "pending" | "cancelled"; notes: string[];
  archived: true; untrusted: true; uncertain: true; usageEligible: false;
}
export interface ContinuityArchivePage { items: ContinuityArchiveItem[]; hasMore: boolean }
/** Explicit operator SAVED-data inspection ONLY. Current processing consent,
 * exclusions and generations do not decide operator archive authorization.
 * No authority to recall, Continue, wake a model or recreate forgotten rows.
 * Caller must render notes as untrusted archived text, never executable HTML.
 * Reads compatible existing tables only; constructor creates/migrates nothing. */
export class ContinuityArchiveV02 {
  private readonly db: DatabaseSync;
  private readonly stop = new AbortController();
  private disposed = false;
  constructor(store: MemoryStore, private readonly query: Pick<SessionQueryEngine, "observeSession">,
    private readonly z: typeof Zod,
    private readonly operator: (targetSessionId: string, projectId?: string) => boolean = () => false) {
    this.db = store.getJournalSqlite();
  }
  private compatible(): boolean {
    const tables = this.db.prepare("SELECT name,strict FROM pragma_table_list WHERE schema='main' AND name IN ('continuity_handoff','continuity_jobs')").all() as Array<{ name: string; strict: number }>;
    if (tables.length === 0) return false;
    if (tables.length !== 2 || tables.some(table => table.strict !== 1)) throw new Error("incompatible continuity archive schema");
    const required: Record<string, Record<string, string>> = {
      continuity_handoff: { job_id: "TEXT", session_id: "TEXT", project_id: "TEXT", generation: "INTEGER", cut: "INTEGER", source_hash: "TEXT", payload: "TEXT" },
      continuity_jobs: { id: "TEXT", session_id: "TEXT", project_id: "TEXT", generation: "INTEGER", cut: "INTEGER", source_hash: "TEXT", trigger: "TEXT", status: "TEXT" },
    };
    for (const [table, fields] of Object.entries(required)) {
      const columns = this.db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string; type: string; notnull: number; pk: number }>;
      for (const [name, type] of Object.entries(fields)) {
        const column = columns.find(value => value.name === name);
        if (!column || column.type !== type || (!column.notnull && !column.pk)) throw new Error("incompatible continuity archive columns");
      }
      const key = columns.find(value => value.name === (table === "continuity_handoff" ? "job_id" : "id"));
      if (key?.pk !== 1 || columns.filter(column => column.pk > 0).length !== 1) throw new Error("incompatible continuity archive primary key");
    }
    return true;
  }
  async list(targetSessionId: string, signal?: AbortSignal): Promise<ContinuityArchivePage | null> {
    const id = this.z.string().min(1).max(256).parse(targetSessionId);
    const abort = signal ? AbortSignal.any([signal, this.stop.signal]) : this.stop.signal;
    let projectId: string | undefined;
    const alive = () => !this.disposed && !abort.aborted && this.operator(id, projectId);
    if (!alive()) return null;
    if (!this.compatible()) return { items: [], hasMore: false };
    let target: SessionObservation | undefined;
    try {
      try { target = await this.query.observeSession(id as SessionHeader["id"], { signal: abort, projectionMode: "none" }); }
      catch (error) {
        if (abort.aborted && (error === abort.reason || (error instanceof Error && "code" in error
          && error.code === "SESSION_QUERY_ABORTED" && error.cause === abort.reason))) return null;
        throw error;
      }
      if (!alive() || target.header.id !== id || !target.header.cwd || isDelegatedHeader(target.header)) return null;
      projectId = opaqueProjectIdFromKey(projectKeyFromCwd(target.header.cwd));
      if (!alive()) return null;
      // No policy/work joins: archive visibility intentionally differs from
      // eligibility. Missing or mismatched historical job anchors are corrupt,
      // not silently rebound to a new scope or treated as completed actions.
      const rows = this.db.prepare(`SELECT h.*,j.id AS j_id,j.session_id AS j_session,j.project_id AS j_project,
        j.generation AS j_generation,j.cut AS j_cut,j.source_hash AS j_hash,j.status AS j_status
        FROM continuity_handoff h LEFT JOIN continuity_jobs j ON j.id=h.job_id
        WHERE h.project_id=? ORDER BY h.cut DESC,h.job_id LIMIT 51`).all(projectId) as Array<{
          job_id: string; session_id: string; project_id: string; generation: number; cut: number; source_hash: string; payload: string;
          j_id: string | null; j_session: string | null; j_project: string | null; j_generation: number | null; j_cut: number | null; j_hash: string | null; j_status: string | null;
        }>;
      const schema = continuityHandoffSchema(this.z);
      const items: ContinuityArchiveItem[] = rows.slice(0, 50).map(row => {
        if (typeof row.payload !== "string" || row.payload.length > 4000) throw new Error("invalid archived handoff payload budget");
        const parsed = schema.parse(JSON.parse(row.payload));
        if (parsed.jobId !== row.job_id || parsed.sessionId !== row.session_id || parsed.projectId !== projectId || parsed.projectId !== row.project_id
          || parsed.generation !== row.generation || parsed.cut !== row.cut || parsed.sourceHash !== row.source_hash
          || row.j_id !== row.job_id || row.j_session !== row.session_id || row.j_project !== row.project_id
          || row.j_generation !== row.generation || row.j_cut !== row.cut || row.j_hash !== row.source_hash
          || (row.j_status !== "pending" && row.j_status !== "cancelled")) throw new Error("archived handoff anchor mismatch");
        return { jobId: parsed.jobId, sourceSessionId: parsed.sessionId, projectId: parsed.projectId,
          cut: parsed.cut, generation: parsed.generation, sourceReferenceStatus: row.j_status, notes: [...parsed.notes],
          archived: true, untrusted: true, uncertain: true, usageEligible: false };
      });
      if (!alive()) return null;
      return { items, hasMore: rows.length > 50 };
    } finally { target?.[Symbol.dispose](); }
  }
  dispose(): void { this.disposed = true; this.stop.abort(); }
}
