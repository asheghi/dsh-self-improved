import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { SessionHeader } from "@deepseek-ai/dsh-session/types";
import type { ContinuityPreviewResultV03 } from "./continuity-preview-v03.js";
import type { ContinuityV03CurrentHandoffIdentity } from "./continuity-work-v03.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";
import { classifyContinuityV03Lineage } from "./continuity-projection-v03.js";
import { isAbsolute } from "node:path";

export type ContinuitySessionsAvailabilityV03 = "available" | "no-authenticated-host-intent" | "policy-denied" | "no-unfinished-work" | "source-unavailable";
export interface ContinuitySessionCandidateV03 {
  sessionId: string; projectId: string; title?: string; updatedAt?: number;
  hasUnfinishedWork: boolean; workMetadata?: Readonly<Record<string, unknown>>;
}
export interface ContinuitySessionsViewV03 {
  targetSessionId: string; projectId: string; candidates: readonly ContinuitySessionCandidateV03[];
  unfinishedWork: readonly ContinuitySessionCandidateV03[]; summaryAccess: "protected";
  availability: ContinuitySessionsAvailabilityV03; availabilityReason: string; canContinue: boolean;
}
export interface ContinuitySessionsIntentV03 { targetSessionId: string; sourceSessionId: string; authenticated: boolean; }
export interface ContinuitySessionsSourceOwnerV03 {
  listCandidates(projectId: string, targetSessionId: string): readonly ContinuitySessionCandidateV03[];
  readHandoffIdentity(projectId: string, sourceSessionId: string): ContinuityV03CurrentHandoffIdentity | null;
}
export interface ContinuitySessionsOrchestratorV03 {
  view(targetSessionId: string): Promise<ContinuitySessionsViewV03>;
  continue(intent: ContinuitySessionsIntentV03, signal?: AbortSignal): Promise<ContinuityPreviewResultV03 | null>;
}
/** These callbacks are trusted Host wiring, never client-supplied predicates. */
export interface ContinuitySessionsGatesV03 {
  hostCapability(): boolean;
  policyAllows(projectId: string, sessionId: string): boolean;
}
const DENY: ContinuitySessionsGatesV03 = { hostCapability: () => false, policyAllows: () => false };
const MAX_CANDIDATES = 128;
type Observation = Awaited<ReturnType<SessionQueryEngine["observeSession"]>>;
type Preview = { resolve(request: { targetSessionId: string; jobId: string }, signal?: AbortSignal): Promise<ContinuityPreviewResultV03 | null> };
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, "value") ? d.value : undefined; }
  catch { return undefined; }
}
function safeId(id: unknown): id is string { return typeof id === "string" && id.length > 0 && id.length <= 256 && !id.includes("\0"); }
function projectOf(observation: Observation, id: string): string | null {
  const header = observation.header;
  if (header.id !== id || typeof header.cwd !== "string" || !isAbsolute(header.cwd)
    || classifyContinuityV03Lineage(header, observation.inheritedEventCount) === "denied") return null;
  try { return opaqueProjectIdFromKey(projectKeyFromCwd(header.cwd)); } catch { return null; }
}
function candidate(value: unknown, projectId: string): ContinuitySessionCandidateV03 | null {
  const sessionId = own(value, "sessionId"); const hasUnfinishedWork = own(value, "hasUnfinishedWork");
  if (!safeId(sessionId) || own(value, "projectId") !== projectId || typeof hasUnfinishedWork !== "boolean") return null;
  const result: ContinuitySessionCandidateV03 = { sessionId, projectId, hasUnfinishedWork };
  const title = own(value, "title"); if (typeof title === "string") result.title = title.slice(0, 256);
  const updatedAt = own(value, "updatedAt"); if (typeof updatedAt === "number" && Number.isSafeInteger(updatedAt) && updatedAt >= 0) result.updatedAt = updatedAt;
  // Only structural metadata may cross this boundary; never arbitrary body fields.
  const source = own(value, "workMetadata"); const metadata: Record<string, unknown> = Object.create(null);
  for (const key of ["pendingCalls", "asOfSeq"] as const) { const n = own(source, key); if (typeof n === "number" && Number.isSafeInteger(n) && n >= 0) metadata[key] = n; }
  const incomplete = own(source, "coverageIncomplete"); if (typeof incomplete === "boolean") metadata.coverageIncomplete = incomplete;
  const state = own(source, "turnState"); if (typeof state === "string" && ["unknown", "running", "completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"].includes(state)) metadata.turnState = state;
  if (Object.keys(metadata).length) result.workMetadata = Object.freeze(metadata);
  return Object.freeze(result);
}

/** DDL-free, read-only adapter. Protected preview requires independent Host intent and live policy. */
export class ContinuitySessionsV03 implements ContinuitySessionsOrchestratorV03 {
  constructor(private readonly query: Pick<SessionQueryEngine, "observeSession">,
    private readonly owner: ContinuitySessionsSourceOwnerV03, private readonly preview: Preview,
    private readonly authenticatedIntent: (intent: Readonly<ContinuitySessionsIntentV03>) => boolean = () => false,
    private readonly gates: ContinuitySessionsGatesV03 = DENY) {}

  private candidates(projectId: string, targetId: string): readonly ContinuitySessionCandidateV03[] {
    const raw = this.owner.listCandidates(projectId, targetId); if (!Array.isArray(raw)) return [];
    const seen = new Set<string>(); const result: ContinuitySessionCandidateV03[] = [];
    for (let i = 0; i < Math.min(raw.length, MAX_CANDIDATES); i++) {
      const item = candidate(own(raw, String(i)), projectId);
      if (!item || item.sessionId === targetId || seen.has(item.sessionId) || !this.gates.policyAllows(projectId, item.sessionId)) continue;
      seen.add(item.sessionId); result.push(item);
    }
    return Object.freeze(result);
  }
  private empty(targetSessionId: string, availability: ContinuitySessionsAvailabilityV03, projectId = ""): ContinuitySessionsViewV03 {
    const reasons = { "available": "Select same-project unfinished work.", "no-authenticated-host-intent": "Authenticated Host Continue capability is unavailable.", "policy-denied": "Continuity access is disabled by current policy.", "no-unfinished-work": "No unfinished work is available.", "source-unavailable": "Target session is unavailable." };
    return { targetSessionId, projectId, candidates: [], unfinishedWork: [], summaryAccess: "protected", availability, availabilityReason: reasons[availability], canContinue: false };
  }
  async view(targetSessionId: string): Promise<ContinuitySessionsViewV03> {
    if (!safeId(targetSessionId)) throw new Error("invalid target session id");
    let target: Observation | undefined;
    try {
      target = await this.query.observeSession(targetSessionId as SessionHeader["id"], { projectionMode: "none" });
      const projectId = projectOf(target, targetSessionId); if (!projectId) return this.empty(targetSessionId, "source-unavailable");
      if (!this.gates.policyAllows(projectId, targetSessionId)) return this.empty(targetSessionId, "policy-denied", projectId);
      const candidates = this.candidates(projectId, targetSessionId);
      const unfinishedWork = Object.freeze(candidates.filter(item => item.hasUnfinishedWork));
      const availability = !this.gates.hostCapability() ? "no-authenticated-host-intent" : unfinishedWork.length ? "available" : "no-unfinished-work";
      return { ...this.empty(targetSessionId, availability, projectId), candidates, unfinishedWork, canContinue: availability === "available" };
    } finally { target?.[Symbol.dispose](); }
  }
  async continue(intent: ContinuitySessionsIntentV03, signal?: AbortSignal): Promise<ContinuityPreviewResultV03 | null> {
    const targetId = own(intent, "targetSessionId"); const sourceId = own(intent, "sourceSessionId");
    if (!safeId(targetId) || !safeId(sourceId) || targetId === sourceId || own(intent, "authenticated") !== true
      || signal?.aborted || !this.gates.hostCapability()) return null;
    const trusted = Object.freeze({ targetSessionId: targetId, sourceSessionId: sourceId, authenticated: true });
    if (!this.authenticatedIntent(trusted)) return null;
    let target: Observation | undefined; let source: Observation | undefined;
    try {
      // Sequential acquisition makes every accepted lease visible to finally, including partial failures.
      target = await this.query.observeSession(targetId as SessionHeader["id"], { projectionMode: "none", signal });
      signal?.throwIfAborted();
      const projectId = projectOf(target, targetId);
      if (!projectId || !this.gates.policyAllows(projectId, targetId) || !this.gates.policyAllows(projectId, sourceId)) return null;
      source = await this.query.observeSession(sourceId as SessionHeader["id"], { projectionMode: "none", signal });
      signal?.throwIfAborted();
      if (projectOf(source, sourceId) !== projectId || !this.candidates(projectId, targetId).some(item => item.sessionId === sourceId && item.hasUnfinishedWork)) return null;
      // Identity lookup is permitted only after both current policy checks. The real preview independently verifies lineage and source/policy snapshots.
      if (!this.gates.policyAllows(projectId, targetId) || !this.gates.policyAllows(projectId, sourceId)) return null;
      const identity = this.owner.readHandoffIdentity(projectId, sourceId);
      if (!identity || !safeId(identity.job?.id)) return null;
      return await this.preview.resolve({ targetSessionId: targetId, jobId: identity.job.id }, signal);
    } finally { try { source?.[Symbol.dispose](); } finally { target?.[Symbol.dispose](); } }
  }
}
export function createContinuitySessionsV03(query: Pick<SessionQueryEngine, "observeSession">,
  owner: ContinuitySessionsSourceOwnerV03, preview: Preview,
  authenticatedIntent?: (intent: Readonly<ContinuitySessionsIntentV03>) => boolean,
  gates?: ContinuitySessionsGatesV03): ContinuitySessionsOrchestratorV03 {
  return new ContinuitySessionsV03(query, owner, preview, authenticatedIntent, gates);
}
