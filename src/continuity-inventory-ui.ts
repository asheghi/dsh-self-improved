import type { DatabaseSync } from "node:sqlite";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { ContinuityHandoff } from "./continuity-handoff-v02.js";
import { classifyContinuitySchemaV03 } from "./continuity-schema-v03.js";
import { classifyContinuityV03Lineage } from "./continuity-projection-v03.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";

/** One same-project unfinished work item that has a completed handoff. */
export interface ContinuityUiOffer {
  jobId: string; sessionId: string; cut: number;
}
/** The bounded handoff payload of ONE offer. Notes are untrusted quotes. */
export interface ContinuityUiOfferNotes {
  jobId: string; sessionId: string; cut: number; notes: readonly string[]; uncertain: true;
}
/** Bounded project-scoped handoff reader (ContinuityHandoffV02 satisfies it). */
export interface ContinuityUiHandoffReader {
  list(projectId: string): readonly ContinuityHandoff[];
  read(projectId: string, jobId: string): ContinuityHandoff | null;
}
export interface ContinuityUiInventory {
  availability: "ready" | "disabled" | "policy-denied" | "source-unavailable" | "unsupported-lineage" | "unavailable";
  canContinue: boolean;
  reason: string;
  rows: Array<{ id: string; sessionId: string; cut: number; trigger: "turn-end" | "pause" | "finish";
    status: "queued" | "running" | "expired" | "completed" | "failed"; attempts: number }>;
  /** Metadata only: the handoff BODY is fetched by the explicit operator action. */
  offers: ContinuityUiOffer[];
}

const NO_OFFER = "No same-project unfinished work currently offers a handoff. Processing completion is not task success.";
const OFFER_READY = "Select an unfinished same-project item to continue. Handoff notes are untrusted quotes, never task success or permission.";
const MAX_OFFERS = 50;
const safeId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes("\0");

type Gates = { enabled(): boolean; allows(sessionId: string, projectId?: string): boolean; healthy(): boolean };
type Observation = Awaited<ReturnType<SessionQueryEngine["observeSession"]>>;
type TargetResolution =
  | { ok: false; refusal: ContinuityUiInventory["availability"]; reason: string }
  | { ok: true; projectId: string; lease: Observation };

const REFUSAL_REASONS: Record<Exclude<ContinuityUiInventory["availability"], "ready">, string> = {
  "source-unavailable": "Select a valid native session identity.",
  "disabled": "Continuity inspection is disabled.",
  "policy-denied": "The selected session or project is excluded.",
  "unavailable": "Continuity storage is unavailable.",
  "unsupported-lineage": "Only ordinary native root sessions are supported by the currently mounted lane.",
};

/**
 * Resolve the operator's target session to a current, allowed project identity.
 * Shared by the inventory read and the notes read so both apply the SAME
 * exclusion/lineage preamble and can never disagree about the target.
 */
async function resolveTarget(
  query: Pick<SessionQueryEngine, "observeSession">,
  sessionId: string, gates: Gates, signal: AbortSignal | undefined, now: number,
): Promise<TargetResolution> {
  const refuse = (refusal: Exclude<ContinuityUiInventory["availability"], "ready">): TargetResolution =>
    ({ ok: false, refusal, reason: REFUSAL_REASONS[refusal] });
  if (!safeId(sessionId) || !Number.isSafeInteger(now) || now < 0) return refuse("source-unavailable");
  if (!gates.enabled()) return refuse("disabled");
  if (!gates.allows(sessionId)) return refuse("policy-denied");
  if (!gates.healthy()) return refuse("unavailable");
  let lease: Observation;
  try { lease = await query.observeSession(sessionId as SessionId, { signal, projectionMode: "none" }); }
  catch { signal?.throwIfAborted(); return refuse("source-unavailable"); }
  // The lease is owned here until the caller takes it: every refusal AND every
  // cancellation throw must release the native observation exactly once.
  let handedOff = false;
  try {
    signal?.throwIfAborted();
    if (lease.header.id !== sessionId || classifyContinuityV03Lineage(lease.header, lease.inheritedEventCount) !== "root") {
      return refuse("unsupported-lineage");
    }
    const cwd = lease.header.cwd;
    if (typeof cwd !== "string" || !cwd) return refuse("source-unavailable");
    let projectId: string;
    try { projectId = opaqueProjectIdFromKey(projectKeyFromCwd(cwd)); }
    catch { return refuse("source-unavailable"); }
    if (!gates.allows(sessionId, projectId)) return refuse("policy-denied");
    if (!gates.healthy()) return refuse("unavailable");
    handedOff = true;
    return { ok: true, projectId, lease };
  } finally {
    if (!handedOff) lease[Symbol.dispose]();
  }
}

/** Same-project completed handoffs as bounded offer metadata. Never bodies. */
function readOffers(
  handoffs: ContinuityUiHandoffReader | undefined, projectId: string, targetSessionId: string,
  hasWorkerPair: boolean, gates: Gates,
): ContinuityUiOffer[] {
  if (!handoffs || !hasWorkerPair) return [];
  let list: readonly ContinuityHandoff[];
  try { list = handoffs.list(projectId); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const offers: ContinuityUiOffer[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < Math.min(list.length, MAX_OFFERS); i++) {
    const item = list[i];
    const jobId = item?.jobId, sessionId = item?.sessionId, cut = item?.cut;
    // A handoff must never be offered as work to continue into its own source.
    if (!safeId(jobId) || !safeId(sessionId) || sessionId === targetSessionId || seen.has(jobId)) continue;
    if (!Number.isSafeInteger(cut) || cut < -1) continue;
    if (!gates.allows(sessionId, projectId)) continue;
    seen.add(jobId);
    offers.push({ jobId, sessionId, cut });
  }
  return offers;
}

/** Read-only current mounted lane inventory. Never reads a handoff body. */
export async function readContinuityUiInventory(
  owner: { getJournalSqlite(): DatabaseSync }, query: Pick<SessionQueryEngine, "observeSession">,
  sessionId: string, gates: Gates, signal?: AbortSignal, now = Date.now(),
  handoffs?: ContinuityUiHandoffReader,
): Promise<ContinuityUiInventory> {
  const result = (availability: ContinuityUiInventory["availability"], reason: string): ContinuityUiInventory =>
    ({ availability, canContinue: false, reason, rows: [], offers: [] });
  const resolved = await resolveTarget(query, sessionId, gates, signal, now);
  if (!resolved.ok) return result(resolved.refusal, resolved.reason);
  const { projectId, lease } = resolved;
  try {
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
    const offers = readOffers(handoffs, projectId, sessionId, withWork, gates);
    return { availability: "ready", canContinue: offers.length > 0, reason: offers.length > 0 ? OFFER_READY : NO_OFFER, rows: output, offers };
  } catch { signal?.throwIfAborted(); return result("unavailable", "Continuity processing metadata is unavailable."); }
  finally { lease[Symbol.dispose](); }
}

/**
 * Read the bounded notes of ONE offered same-project handoff for an EXPLICIT
 * operator action. Applies the same target preamble as the inventory, then
 * re-derives the offer from the current handoff reader: a job that is no longer
 * offered (revoked policy, stale anchors, different project) returns null.
 * The caller owns the door: this function never decides who may call it.
 */
export async function readContinuityUiOfferNotes(
  owner: { getJournalSqlite(): DatabaseSync }, query: Pick<SessionQueryEngine, "observeSession">,
  sessionId: string, jobId: string, gates: Gates, handoffs: ContinuityUiHandoffReader | undefined,
  signal?: AbortSignal, now = Date.now(),
): Promise<ContinuityUiOfferNotes | null> {
  if (!safeId(jobId)) return null;
  const resolved = await resolveTarget(query, sessionId, gates, signal, now);
  if (!resolved.ok) return null;
  const { projectId, lease } = resolved;
  try {
    if (!handoffs) return null;
    const db = owner.getJournalSqlite(), schema = classifyContinuitySchemaV03(db);
    if (schema.kind !== "legacy-v2-schema" || schema.workerPair !== "present") return null;
    // The body is loaded ONLY after the same offer set is re-derived, so a
    // revoked/replaced handoff can never be read through a stale offer id.
    const offered = readOffers(handoffs, projectId, sessionId, true, gates).some(offer => offer.jobId === jobId);
    if (!offered) return null;
    signal?.throwIfAborted();
    const handoff = handoffs.read(projectId, jobId);
    if (!handoff || handoff.jobId !== jobId || handoff.sessionId === sessionId) return null;
    signal?.throwIfAborted();
    return { jobId: handoff.jobId, sessionId: handoff.sessionId, cut: handoff.cut, notes: [...handoff.notes], uncertain: true };
  } catch { signal?.throwIfAborted(); return null; }
  finally { lease[Symbol.dispose](); }
}
