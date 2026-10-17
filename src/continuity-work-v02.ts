import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { MemoryStore } from "./storage.js";
import type { ContinuityTrigger } from "./continuity-store-v02.js";

export interface ContinuityWorkClaim {
  id: string; sessionId: string; projectId: string; generation: number;
  cut: number; sourceHash: string; trigger: ContinuityTrigger;
  token: string; leaseDeadline: number; attempts: number;
}
type Row = { id: string; session_id: string; project_id: string; generation: number;
  cut: number; source_hash: string; trigger: ContinuityTrigger; attempts: number | null };
const project = (id: string): void => {
  if (typeof id !== "string" || !/^pj-[a-f0-9]{32}$/.test(id)) throw new Error("invalid continuity project");
};
const time = (now: number): void => {
  if (!Number.isSafeInteger(now) || now < 0) throw new Error("invalid continuity time");
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const eligible = `JOIN continuity_policy p ON p.session_id=j.session_id
  AND p.project_id=j.project_id AND p.generation=j.generation AND p.allowed=1`;

export const CONTINUITY_WORK_V02_DDL = `CREATE TABLE IF NOT EXISTS continuity_work (
  job_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,
  lease_deadline INTEGER NOT NULL CHECK(lease_deadline>=0),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),
  status TEXT NOT NULL CHECK(status IN('running','completed','failed'))
) STRICT`;

/** Structural domain work ONLY. No source, body, provider or event observer.
 * Existing reference tables are untouched; legacy listPending is intentionally
 * not terminal-aware until a separate integration consumes this work ledger.
 */
export class ContinuityWorkV02 {
  private readonly db: DatabaseSync;
  constructor(private readonly store: MemoryStore) {
    this.db = store.getJournalSqlite();
    store.runInImmediateTransaction(() => this.db.exec(CONTINUITY_WORK_V02_DDL));
  }
  claim(projectId: string, now: number, ttl: number, scope?: Readonly<{ sessionId: string; minimumCut: number }>): ContinuityWorkClaim | null {
    project(projectId); time(now);
    const sessionId = scope?.sessionId ?? null, minimumCut = scope?.minimumCut ?? -1;
    if (scope && (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 || sessionId.includes("\0")
      || !Number.isSafeInteger(minimumCut) || minimumCut < 0)) throw new Error("invalid authenticated continuity claim scope");
    if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60000 || !Number.isSafeInteger(now + ttl)) throw new Error("invalid continuity lease");
    return this.store.runInImmediateTransaction(() => {
      // Bound expiry cleanup per acquisition so old backlog cannot monopolize
      // the shared writer. A later invocation continues after terminal rows.
      for (let scanned = 0; scanned < 100; scanned++) {
        const row = this.db.prepare(`SELECT j.id,j.session_id,j.project_id,j.generation,j.cut,j.source_hash,j.trigger,w.attempts
          FROM continuity_jobs j ${eligible} LEFT JOIN continuity_work w ON w.job_id=j.id
          WHERE j.project_id=? AND j.status='pending'
            AND (? IS NULL OR (j.session_id=? AND j.cut>=?))
            AND (w.job_id IS NULL OR (w.status='running' AND w.lease_deadline<=?))
          ORDER BY j.cut,j.id LIMIT 1`).get(projectId, sessionId, sessionId, minimumCut, now) as Row | undefined;
        if (!row) return null;
        if (row.attempts === 3) {
          this.db.prepare("UPDATE continuity_work SET status='failed' WHERE job_id=? AND status='running' AND lease_deadline<=?").run(row.id, now);
          continue;
        }
        // Detached plain structural snapshot; never serialize caller objects.
        if (typeof row.id !== "string" || !row.id || row.id.length > 256 || typeof row.session_id !== "string" || !row.session_id || row.session_id.length > 256
          || !Number.isSafeInteger(row.generation) || row.generation < 0 || !Number.isSafeInteger(row.cut) || row.cut < -1
          || typeof row.source_hash !== "string" || !/^[a-f0-9]{64}$/.test(row.source_hash)
          || !["turn-end", "pause", "finish"].includes(row.trigger)) throw new Error("invalid continuity reference");
        const attempts = (row.attempts ?? 0) + 1, token = randomUUID(), leaseDeadline = now + ttl;
        this.db.prepare(`INSERT INTO continuity_work VALUES(?,?,?,?,'running') ON CONFLICT(job_id) DO UPDATE SET
          token=excluded.token,lease_deadline=excluded.lease_deadline,attempts=excluded.attempts,status='running'`).run(row.id, token, leaseDeadline, attempts);
        return { id: row.id, sessionId: row.session_id, projectId: row.project_id, generation: row.generation,
          cut: row.cut, sourceHash: row.source_hash, trigger: row.trigger, token, leaseDeadline, attempts };
      }
      return null;
    });
  }
  /** A bounded claim may spend its budget terminalizing old expired rows.
   * Caller can schedule another bounded pass instead of mistaking null for
   * a permanently empty queue. Does not grant, lease or mutate any work. */
  hasEligibleWork(projectId: string, now: number): boolean {
    project(projectId); time(now);
    return this.db.prepare(`SELECT 1 FROM continuity_jobs j ${eligible}
      LEFT JOIN continuity_work w ON w.job_id=j.id
      WHERE j.project_id=? AND j.status='pending'
        AND (w.job_id IS NULL OR (w.status='running' AND w.lease_deadline<=?)) LIMIT 1`).get(projectId, now) !== undefined;
  }
  /** Point-in-time pre-source/pre-provider admission only, not a permission
   * receipt. Caller must also recheck live consent/disposal and own cancellation;
   * atomic handoff commit remains the final policy/token fence. Compare ALL
   * verified-source anchors, not merely a still-running token or session ID. */
  isCurrent(claim: ContinuityWorkClaim, now: number): boolean {
    time(now);
    const { id, sessionId, projectId, generation, cut, sourceHash, trigger, token, leaseDeadline, attempts } = claim;
    if (typeof token !== "string" || !uuid.test(token)
      || typeof id !== "string" || !id || id.length > 256
      || typeof sessionId !== "string" || !sessionId || sessionId.length > 256
      || typeof projectId !== "string" || !/^pj-[a-f0-9]{32}$/.test(projectId)
      || !Number.isSafeInteger(generation) || generation < 0
      || !Number.isSafeInteger(cut) || cut < -1
      || typeof sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(sourceHash)
      || !["turn-end", "pause", "finish"].includes(trigger)
      || !Number.isSafeInteger(leaseDeadline) || leaseDeadline <= now
      || !Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3) return false;
    return this.db.prepare(`SELECT 1 FROM continuity_work w
      JOIN continuity_jobs j ON j.id=w.job_id ${eligible}
      WHERE w.token=? AND w.status='running' AND w.lease_deadline=? AND w.lease_deadline>?
        AND w.attempts=? AND j.status='pending' AND j.id=? AND j.session_id=? AND j.project_id=?
        AND j.generation=? AND j.cut=? AND j.source_hash=? AND j.trigger=?`).get(token, leaseDeadline, now,
          attempts, id, sessionId, projectId, generation, cut, sourceHash, trigger) !== undefined;
  }
  finish(token: string, now: number): boolean { return this.settle(token, now, "completed"); }
  fail(token: string, now: number): boolean { return this.settle(token, now, "failed"); }
  private settle(token: string, now: number, status: "completed" | "failed"): boolean {
    time(now);
    if (typeof token !== "string" || !uuid.test(token)) return false;
    return this.store.runInImmediateTransaction(() => Number(this.db.prepare(`UPDATE continuity_work SET status=?
      WHERE token=? AND status='running' AND lease_deadline>?
        AND EXISTS(SELECT 1 FROM continuity_jobs j ${eligible} WHERE j.id=continuity_work.job_id AND j.status='pending')`).run(status, token, now).changes) === 1);
  }
  /** Bounded current-work inventory; not the paused/off saved-data browser.
   * Only currently admitted project references; no tokens, source bodies or
   * permission claims. States describe PROCESSING, never task success. An
   * expired lease is distinct from a persisted terminal failure. */
  listStatus(projectId: string, now: number): Array<{
    id: string; sessionId: string; cut: number; trigger: ContinuityTrigger;
    status: "queued" | "running" | "expired" | "completed" | "failed"; attempts: number;
  }> {
    project(projectId); time(now);
    const rows = this.db.prepare(`SELECT j.id,j.session_id,j.cut,j.trigger,w.status,w.attempts,w.lease_deadline
      FROM continuity_jobs j ${eligible} LEFT JOIN continuity_work w ON w.job_id=j.id
      WHERE j.project_id=? AND j.status='pending' ORDER BY j.cut DESC,j.id LIMIT 100`).all(projectId) as Array<{
        id: string; session_id: string; cut: number; trigger: ContinuityTrigger;
        status: "running" | "completed" | "failed" | null; attempts: number | null; lease_deadline: number | null;
      }>;
    return rows.map(row => {
      if (typeof row.id !== "string" || !row.id || row.id.length > 256
        || typeof row.session_id !== "string" || !row.session_id || row.session_id.length > 256
        || !Number.isSafeInteger(row.cut) || row.cut < -1
        || !["turn-end", "pause", "finish"].includes(row.trigger)
        || (row.status !== null && (!["running", "completed", "failed"].includes(row.status)
          || !Number.isSafeInteger(row.attempts) || row.attempts! < 1 || row.attempts! > 3
          || !Number.isSafeInteger(row.lease_deadline) || row.lease_deadline! < 0))) throw new Error("invalid continuity inventory");
      return { id: row.id, sessionId: row.session_id, cut: row.cut, trigger: row.trigger,
        status: row.status === null ? "queued" : row.status === "running" && row.lease_deadline! <= now
          ? "expired" : row.status,
        attempts: row.attempts ?? 0 };
    });
  }
  readStatus(projectId: string, jobId: string): { status: "running" | "completed" | "failed"; attempts: number; leaseDeadline: number } | null {
    project(projectId);
    if (typeof jobId !== "string" || !jobId || jobId.length > 256) throw new Error("invalid continuity job");
    const row = this.db.prepare(`SELECT w.status,w.attempts,w.lease_deadline FROM continuity_work w
      JOIN continuity_jobs j ON j.id=w.job_id ${eligible} WHERE j.id=? AND j.project_id=? AND j.status='pending'`).get(jobId, projectId) as
      { status: "running" | "completed" | "failed"; attempts: number; lease_deadline: number } | undefined;
    return row ? { status: row.status, attempts: row.attempts, leaseDeadline: row.lease_deadline } : null;
  }
}
