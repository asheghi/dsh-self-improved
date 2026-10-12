import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import { classifyContinuitySchemaV03 } from "./continuity-schema-v03.js";
import { classifyContinuityV03Lineage } from "./continuity-projection-v03.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";

export interface ContinuityUiInventory {
  availability: "ready" | "disabled" | "policy-denied" | "source-unavailable" | "unsupported-lineage" | "unavailable";
  canContinue: false;
  reason: string;
  rows: Array<{ id: string; sessionId: string; cut: number; trigger: "turn-end" | "pause" | "finish";
    status: "queued" | "running" | "expired" | "completed" | "failed"; attempts: number }>;
}
const CONTINUE_UNAVAILABLE = "Continue is unavailable until authenticated Host ingress is integrated. Processing completion is not task success.";
const safeId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes("\0");
/** Read-only current mounted v2 lane inventory. Does not create a work table, read handoff bodies or confer intent. */
export async function readContinuityUiInventory(
  owner: { getJournalSqlite(): DatabaseSync }, query: Pick<SessionQueryEngine, "observeSession">,
  sessionId: string, gates: { enabled(): boolean; allows(sessionId: string, projectId?: string): boolean; healthy(): boolean },
  signal?: AbortSignal, now = Date.now(),
): Promise<ContinuityUiInventory> {
  const result = (availability: ContinuityUiInventory["availability"], reason: string): ContinuityUiInventory => ({ availability, canContinue: false, reason, rows: [] });
  signal?.throwIfAborted();
  if (!safeId(sessionId) || !Number.isSafeInteger(now) || now < 0) return result("source-unavailable", "Select a valid native session identity.");
  if (!gates.enabled()) return result("disabled", "Continuity inspection is disabled.");
  if (!gates.allows(sessionId)) return result("policy-denied", "The selected session is excluded.");
  if (!gates.healthy()) return result("unavailable", "Continuity storage is unavailable.");
  let lease;
  try { lease = await query.observeSession(sessionId as SessionId, { signal, projectionMode: "none" }); }
  catch { signal?.throwIfAborted(); return result("source-unavailable", "The selected native session cannot be observed."); }
  try {
    signal?.throwIfAborted();
    if (!gates.enabled()) return result("disabled", "Continuity inspection is disabled.");
    if (lease.header.id !== sessionId || classifyContinuityV03Lineage(lease.header, lease.inheritedEventCount) !== "root") {
      return result("unsupported-lineage", "Only ordinary native root sessions are supported by the currently mounted lane.");
    }
    const cwd = lease.header.cwd;
    if (typeof cwd !== "string" || !cwd) return result("source-unavailable", "The session has no project identity.");
    const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
    if (!gates.allows(sessionId, projectId)) return result("policy-denied", "The selected session or project is excluded.");
    if (!gates.healthy()) return result("unavailable", "Continuity storage is unavailable.");
    const db = owner.getJournalSqlite(), schema = classifyContinuitySchemaV03(db);
    if (schema.kind !== "legacy-v2-schema") return result("unavailable", "The current mounted inventory requires the validated v2 lane; v3 runtime mounting remains pending.");
    const withWork = schema.workerPair === "present";
    const rows = db.prepare(`SELECT j.id,j.session_id,j.cut,j.trigger,
      ${withWork ? "w.status,w.attempts,w.lease_deadline" : "NULL AS status,NULL AS attempts,NULL AS lease_deadline"}
      FROM main.continuity_jobs j JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id AND p.generation=j.generation AND p.allowed=1
      JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id AND c.generation=j.generation AND c.cut>=j.cut
      ${withWork ? "LEFT JOIN main.continuity_work w ON w.job_id=j.id" : ""}
      WHERE j.project_id=? AND j.status='pending' ORDER BY j.cut DESC,j.id LIMIT 100`).all(projectId) as Array<{
        id: string; session_id: string; cut: number; trigger: string; status: string | null; attempts: number | null; lease_deadline: number | null;
      }>;
    const output: ContinuityUiInventory["rows"] = [];
    for (const row of rows) {
      if (!safeId(row.id) || !safeId(row.session_id) || !Number.isSafeInteger(row.cut) || row.cut < -1
        || !["turn-end", "pause", "finish"].includes(row.trigger)
        || (row.status !== null && (!["running", "completed", "failed"].includes(row.status)
          || !Number.isSafeInteger(row.attempts) || row.attempts! < 1 || row.attempts! > 3
          || !Number.isSafeInteger(row.lease_deadline) || row.lease_deadline! < 0))) return result("unavailable", "Continuity processing metadata failed validation.");
      if (!gates.allows(row.session_id, projectId)) continue;
      output.push({ id: row.id, sessionId: row.session_id, cut: row.cut, trigger: row.trigger as ContinuityUiInventory["rows"][number]["trigger"],
        status: row.status === null ? "queued" : row.status === "running" && row.lease_deadline! <= now ? "expired"
          : row.status as "running" | "completed" | "failed", attempts: row.attempts ?? 0 });
    }
    signal?.throwIfAborted();
    return { availability: "ready", canContinue: false, reason: CONTINUE_UNAVAILABLE, rows: output };
  } catch { signal?.throwIfAborted(); return result("unavailable", "Continuity processing metadata is unavailable."); }
  finally { lease[Symbol.dispose](); }
}
