import { isAbsolute } from "node:path";
import type { SessionQueryEngine, SessionObservation } from "@deepseek-ai/dsh-session-query";
import type { SessionHeader } from "@deepseek-ai/dsh-session/types";
import type * as Zod from "zod";
import { opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";
import type { ContinuityHistoricalLineageSnapshotV02 } from "./continuity-ancestry-v02.js";
import type { ContinuityPreviewLineagePolicyStampV03 } from "./continuity-lineage-policy-v03.js";
export { composeContinuityPreviewLineagePolicyStampV03 } from "./continuity-lineage-policy-v03.js";
export type { ContinuityPreviewLineagePolicyRowV03, ContinuityPreviewLineagePolicyStampV03 }
  from "./continuity-lineage-policy-v03.js";
import { parseContinuityV03HandoffPayload, parseContinuityV03JobAnchor, type ContinuityHandoffV03,
  type ContinuityV03JobAnchor } from "./continuity-envelope-v03.js";
import { createContinuityCheckpointEnvelopeWithLineageSnapshotV03 } from "./continuity-source-v03.js";
import type { ContinuityV03CurrentHandoff, ContinuityV03CurrentHandoffIdentity } from "./continuity-work-v03.js";
import { isSafeContinuityV03SessionId, isSafeContinuityV03Sha256 } from "./continuity-schema-contract-v03.js";

export interface ContinuityPreviewRequestV03 { targetSessionId: string; jobId: string }
export interface ContinuityPreviewResultV03 {
  targetSessionId: string;
  sourceSessionId: string;
  projectId: string;
  jobId: string;
  cut: number;
  sourceHash: string;
  lineageKind: "root" | "fork";
  notes: string[];
  uncertain: true;
  untrusted: true;
  orientationOnly: true;
}
export interface ContinuityPreviewReaderV03 {
  readCurrentHandoffIdentity(projectId: string, jobId: string): ContinuityV03CurrentHandoffIdentity | null;
  readCurrentHandoffRecord(projectId: string, jobId: string): ContinuityV03CurrentHandoff | null;
}
/** Direct, body-free policy check before native observation; default deny. */
export type ContinuityPreviewPreflightV03 = (
  request: Readonly<ContinuityPreviewRequestV03>,
  role: "target" | "source",
  sessionId: string,
) => boolean;
export type ContinuityPreviewGenerationV03 = (
  header: SessionHeader,
  role: "target" | "source",
  projectId: string,
) => number | null;
/**
/** Trusted Host callback only: receives sensitive ephemeral raw IDs; return a stable stamp or null. Never forward the snapshot to clients/providers. */
export type ContinuityPreviewLineageAdmissionV03 = (
  header: SessionHeader,
  role: "target" | "source",
  projectId: string,
  generation: number,
  lineageSnapshot: ContinuityHistoricalLineageSnapshotV02,
) => ContinuityPreviewLineagePolicyStampV03 | null;

function projectFromHeader(header: SessionHeader): string | null {
  if (!isSafeContinuityV03SessionId(header.id) || typeof header.cwd !== "string" || !isAbsolute(header.cwd)) return null;
  try { return opaqueProjectIdFromKey(projectKeyFromCwd(header.cwd)); }
  catch { return null; }
}

const JOB_ANCHOR_KEYS = ["id", "sessionId", "projectId", "generation", "cut", "sourceHash", "selectedSourceHash",
  "checkpointFormat", "sourceBindingVersion", "lineageFormat", "lineageBindingVersion", "lineageKind", "lineageHash",
  "trigger", "status"] as const;
const HANDOFF_KEYS = ["jobId", "sessionId", "projectId", "generation", "cut", "sourceHash", "selectedSourceHash",
  "checkpointFormat", "sourceBindingVersion", "lineageFormat", "lineageBindingVersion", "lineageKind", "lineageHash",
  "notes", "uncertain"] as const;

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch { return null; }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function exactDataArray(value: unknown, max: number): unknown[] | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (!Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch { return null; }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > max) return null;
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || !Object.hasOwn(descriptors, "length")) return null;
  const out: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    out.push(descriptor.value);
  }
  if (keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
    || Number(key) >= length))) return null;
  return out;
}

function currentJobAnchor(value: unknown, projectId: string, jobId: string): ContinuityV03JobAnchor | null {
  const raw = exactDataRecord(value, JOB_ANCHOR_KEYS);
  if (!raw || typeof raw.generation !== "number" || !Number.isSafeInteger(raw.generation) || raw.generation < 0
    || typeof raw.cut !== "number" || !Number.isSafeInteger(raw.cut) || raw.cut < -1) return null;
  const job = parseContinuityV03JobAnchor({
    id: raw.id, session_id: raw.sessionId, project_id: raw.projectId,
    generation_text: String(raw.generation), cut_text: String(raw.cut), source_hash: raw.sourceHash,
    checkpoint_format: raw.checkpointFormat, source_binding_version: raw.sourceBindingVersion,
    selected_source_hash: raw.selectedSourceHash, lineage_format: raw.lineageFormat,
    lineage_binding_version: raw.lineageBindingVersion, lineage_kind: raw.lineageKind,
    lineage_hash: raw.lineageHash, trigger: raw.trigger, status: raw.status,
  });
  return job && job.id === jobId && job.projectId === projectId && job.status === "pending" ? job : null;
}

function currentIdentity(value: unknown, projectId: string, jobId: string): ContinuityV03JobAnchor | null {
  const identity = exactDataRecord(value, ["job"]);
  return identity ? currentJobAnchor(identity.job, projectId, jobId) : null;
}

function exactStringArray(value: unknown, max: number): string[] | null {
  const items = exactDataArray(value, max);
  return items && items.every((item): item is string => typeof item === "string") ? items as string[] : null;
}

function currentRecord(value: unknown, expected: ContinuityV03JobAnchor): ContinuityHandoffV03 | null {
  const record = exactDataRecord(value, ["job", "handoff"]);
  if (!record) return null;
  const job = currentJobAnchor(record.job, expected.projectId, expected.id);
  if (!job || JSON.stringify(job) !== JSON.stringify(expected)) return null;
  const handoff = exactDataRecord(record.handoff, HANDOFF_KEYS);
  if (!handoff) return null;
  const notes = exactStringArray(handoff.notes, 3);
  if (!notes || notes.some(note => note.length > 280)) return null;
  let encoded: string;
  try { encoded = JSON.stringify({ ...handoff, notes }); } catch { return null; }
  return parseContinuityV03HandoffPayload(encoded, job);
}

/**
 * Cold, read-only v3 orientation preview. Reader/query are trusted Host-owned
 * capabilities; operator, preflight, generation, and lineage-admission
 * callbacks are trusted Host integrations and default-deny. The lineage
 * callback must check the verified chain plus ancestor policy and return its
 * epoch-bound snapshot stamp; this class compares it across awaits. The operator callback must authenticate UI
 * intent and selected source. This class implements neither proof and grants
 * no Continue/action.
 */
export class ContinuityPreviewV03 {
  private disposed = false;
  private readonly stop = new AbortController();

  constructor(
    private readonly reader: ContinuityPreviewReaderV03,
    private readonly query: Pick<SessionQueryEngine, "observeSession">,
    private readonly z: typeof Zod,
    private readonly operator: (request: Readonly<ContinuityPreviewRequestV03>, selectedSourceSessionId?: string) => boolean = () => false,
    private readonly preflight: ContinuityPreviewPreflightV03 = () => false,
    private readonly generation: ContinuityPreviewGenerationV03 = () => null,
    private readonly admitted: ContinuityPreviewLineageAdmissionV03 = () => null,
  ) {}

  async resolve(request: ContinuityPreviewRequestV03, signal?: AbortSignal): Promise<ContinuityPreviewResultV03 | null> {
    const parsed = this.z.object({ targetSessionId: this.z.string().min(1).max(256),
      jobId: this.z.string().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/) }).strict().parse(request);
    if (!isSafeContinuityV03SessionId(parsed.targetSessionId)) throw new Error("invalid v3 preview target session id");
    const req = Object.freeze(parsed);
    const abort = signal ? AbortSignal.any([this.stop.signal, signal]) : this.stop.signal;
    let selectedSourceSessionId: string | undefined;
    const alive = (): boolean => {
      if (this.disposed || abort.aborted) return false;
      try { return this.operator(req, selectedSourceSessionId) === true; }
      catch { return false; }
    };
    const preflightAllowed = (role: "target" | "source", sessionId: string): boolean => {
      try { return this.preflight(req, role, sessionId) === true; }
      catch { return false; }
    };
    const generationFor = (header: SessionHeader, role: "target" | "source", projectId: string): number | null => {
      try {
        const value = this.generation(header, role, projectId);
        return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
      } catch { return null; }
    };
    const lineagePolicyStamp = (header: SessionHeader, role: "target" | "source", projectId: string,
      generation: number, lineageSnapshot: ContinuityHistoricalLineageSnapshotV02): string | null => {
      try {
        const lineage = lineageSnapshot.binding;
        const value = exactDataRecord(this.admitted(header, role, projectId, generation, lineageSnapshot),
          ["lineageBindingHash", "policyRowsHash", "globalEpoch"]);
        if (!value || value.lineageBindingHash !== lineage.bindingHash
          || !isSafeContinuityV03Sha256(value.policyRowsHash)
          || !Number.isSafeInteger(value.globalEpoch) || (value.globalEpoch as number) < 0) return null;
        return JSON.stringify([value.lineageBindingHash, value.policyRowsHash, value.globalEpoch]);
      } catch { return null; }
    };
    if (!alive() || !preflightAllowed("target", req.targetSessionId)) return null;

    const observe = async (id: SessionHeader["id"]): Promise<SessionObservation | undefined> => {
      try { return await this.query.observeSession(id, { signal: abort, projectionMode: "none" }); }
      catch (error) {
        if (abort.aborted && (error === abort.reason || (error instanceof Error && "code" in error
          && error.code === "SESSION_QUERY_ABORTED" && error.cause === abort.reason))) return undefined;
        throw error;
      }
    };

    let target: SessionObservation | undefined;
    let source: SessionObservation | undefined;
    let targetFresh: SessionObservation | undefined;
    let sourceFresh: SessionObservation | undefined;
    try {
      target = await observe(req.targetSessionId as SessionHeader["id"]);
      if (!target || !alive() || target.header.id !== req.targetSessionId) return null;
      const projectId = projectFromHeader(target.header);
      if (!projectId) return null;
      const targetGeneration = generationFor(target.header, "target", projectId);
      if (targetGeneration === null) return null;
      const targetBoundContext = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(
        this.query, target, projectId, targetGeneration, target.cursor, abort);
      const targetBound = targetBoundContext.envelope;
      if (targetBound.row.val.lastHumanSeq < targetBound.inheritedEventCount) return null;
      const targetPolicyStamp = lineagePolicyStamp(
        target.header, "target", projectId, targetGeneration, targetBoundContext.lineageSnapshot);
      if (!targetPolicyStamp) return null;

      const selectedJob = currentIdentity(
        this.reader.readCurrentHandoffIdentity(projectId, req.jobId), projectId, req.jobId);
      if (!selectedJob) return null;
      selectedSourceSessionId = selectedJob.sessionId;
      if (!alive() || !preflightAllowed("source", selectedJob.sessionId)) return null;
      // Selected-source UI intent and direct policy precede payload and source reads.

      source = await observe(selectedJob.sessionId as SessionHeader["id"]);
      if (!source || !alive() || source.header.id !== selectedJob.sessionId) return null;
      const sourceProjectId = projectFromHeader(source.header);
      if (sourceProjectId !== projectId) return null;
      const sourceBoundContext = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(
        this.query, source, projectId, selectedJob.generation, selectedJob.cut, abort);
      const sourceBound = sourceBoundContext.envelope;
      if (sourceBound.sessionId !== selectedJob.sessionId || sourceBound.projectId !== selectedJob.projectId
        || sourceBound.generation !== selectedJob.generation || sourceBound.asOfSeq !== selectedJob.cut
        || sourceBound.sourceHash !== selectedJob.sourceHash || sourceBound.selectedSourceHash !== selectedJob.selectedSourceHash
        || sourceBound.checkpointFormat !== selectedJob.checkpointFormat
        || sourceBound.sourceBindingVersion !== selectedJob.sourceBindingVersion
        || sourceBound.lineage.format !== selectedJob.lineageFormat
        || sourceBound.lineage.bindingVersion !== selectedJob.lineageBindingVersion
        || sourceBound.lineageKind !== selectedJob.lineageKind || sourceBound.lineageHash !== selectedJob.lineageHash) return null;
      const sourceGeneration = generationFor(source.header, "source", projectId);
      if (sourceGeneration !== selectedJob.generation) return null;
      const sourcePolicyStamp = lineagePolicyStamp(
        source.header, "source", projectId, sourceGeneration, sourceBoundContext.lineageSnapshot);
      if (!sourcePolicyStamp) return null;
      if (!alive()) return null;

      // Refresh both sessions at their original selected cuts; later tails do
      // not replace the preview's target identity or stored source prefix.
      if (!preflightAllowed("target", req.targetSessionId)
        || !preflightAllowed("source", selectedJob.sessionId)) return null;
      targetFresh = await observe(target.header.id);
      if (!targetFresh || !alive() || targetFresh.header.id !== req.targetSessionId
        || projectFromHeader(targetFresh.header) !== projectId) return null;
      const targetFreshBoundContext = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(
        this.query, targetFresh, projectId, targetGeneration, targetBound.asOfSeq, abort);
      const targetFreshBound = targetFreshBoundContext.envelope;
      if (targetFreshBound.asOfSeq !== targetBound.asOfSeq || targetFreshBound.sourceHash !== targetBound.sourceHash
        || targetFreshBound.headerHash !== targetBound.headerHash
        || targetFreshBound.inheritedEventCount !== targetBound.inheritedEventCount
        || targetFreshBound.selectedSourceHash !== targetBound.selectedSourceHash
        || targetFreshBound.lineageKind !== targetBound.lineageKind
        || targetFreshBound.lineageHash !== targetBound.lineageHash) return null;
      const refreshedTargetGeneration = generationFor(targetFresh.header, "target", projectId);
      const refreshedTargetPolicyStamp = lineagePolicyStamp(
        targetFresh.header, "target", projectId, targetGeneration, targetFreshBoundContext.lineageSnapshot);
      if (refreshedTargetGeneration !== targetGeneration || refreshedTargetPolicyStamp !== targetPolicyStamp) return null;

      if (!alive() || !preflightAllowed("source", selectedJob.sessionId)) return null;
      sourceFresh = await observe(selectedJob.sessionId as SessionHeader["id"]);
      if (!sourceFresh || !alive() || sourceFresh.header.id !== selectedJob.sessionId
        || projectFromHeader(sourceFresh.header) !== projectId) return null;
      const sourceFreshBoundContext = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(
        this.query, sourceFresh, projectId, selectedJob.generation, selectedJob.cut, abort);
      const sourceFreshBound = sourceFreshBoundContext.envelope;
      if (sourceFreshBound.sessionId !== selectedJob.sessionId || sourceFreshBound.projectId !== selectedJob.projectId
        || sourceFreshBound.generation !== selectedJob.generation || sourceFreshBound.asOfSeq !== selectedJob.cut
        || sourceFreshBound.sourceHash !== selectedJob.sourceHash || sourceFreshBound.selectedSourceHash !== selectedJob.selectedSourceHash
        || sourceFreshBound.checkpointFormat !== selectedJob.checkpointFormat
        || sourceFreshBound.sourceBindingVersion !== selectedJob.sourceBindingVersion
        || sourceFreshBound.lineage.format !== selectedJob.lineageFormat
        || sourceFreshBound.lineage.bindingVersion !== selectedJob.lineageBindingVersion
        || sourceFreshBound.lineageKind !== selectedJob.lineageKind || sourceFreshBound.lineageHash !== selectedJob.lineageHash) return null;
      const refreshedSourceGeneration = generationFor(sourceFresh.header, "source", projectId);
      const refreshedSourcePolicyStamp = lineagePolicyStamp(
        sourceFresh.header, "source", projectId, selectedJob.generation, sourceFreshBoundContext.lineageSnapshot);
      if (refreshedSourceGeneration !== selectedJob.generation || refreshedSourcePolicyStamp !== sourcePolicyStamp) return null;

      if (!alive() || !preflightAllowed("target", req.targetSessionId)
        || !preflightAllowed("source", selectedJob.sessionId)) return null;
      const preReadTargetGeneration = generationFor(targetFresh.header, "target", projectId);
      const preReadSourceGeneration = generationFor(sourceFresh.header, "source", projectId);
      if (preReadTargetGeneration !== targetGeneration || preReadSourceGeneration !== selectedJob.generation) return null;
      const preReadTargetStamp = lineagePolicyStamp(
        targetFresh.header, "target", projectId, preReadTargetGeneration, targetFreshBoundContext.lineageSnapshot);
      const preReadSourceStamp = lineagePolicyStamp(
        sourceFresh.header, "source", projectId, preReadSourceGeneration, sourceFreshBoundContext.lineageSnapshot);
      if (preReadTargetStamp !== targetPolicyStamp || preReadSourceStamp !== sourcePolicyStamp) return null;
      const currentJob = currentIdentity(this.reader.readCurrentHandoffIdentity(projectId, req.jobId), projectId, req.jobId);
      if (!currentJob || JSON.stringify(currentJob) !== JSON.stringify(selectedJob)) return null;
      const handoff = currentRecord(this.reader.readCurrentHandoffRecord(projectId, req.jobId), selectedJob);
      if (!handoff || !alive() || !preflightAllowed("target", req.targetSessionId)
        || !preflightAllowed("source", selectedJob.sessionId)) return null;
      const postReadTargetGeneration = generationFor(targetFresh.header, "target", projectId);
      const postReadSourceGeneration = generationFor(sourceFresh.header, "source", projectId);
      if (postReadTargetGeneration !== targetGeneration || postReadSourceGeneration !== selectedJob.generation) return null;
      const postReadTargetStamp = lineagePolicyStamp(
        targetFresh.header, "target", projectId, postReadTargetGeneration, targetFreshBoundContext.lineageSnapshot);
      const postReadSourceStamp = lineagePolicyStamp(
        sourceFresh.header, "source", projectId, postReadSourceGeneration, sourceFreshBoundContext.lineageSnapshot);
      if (postReadTargetStamp !== targetPolicyStamp || postReadSourceStamp !== sourcePolicyStamp) return null;
      return {
        targetSessionId: req.targetSessionId, sourceSessionId: selectedJob.sessionId, projectId,
        jobId: selectedJob.id, cut: selectedJob.cut, sourceHash: selectedJob.sourceHash,
        lineageKind: selectedJob.lineageKind, notes: [...handoff.notes],
        uncertain: true, untrusted: true, orientationOnly: true,
      };
    } catch (error) {
      if (abort.aborted) return null;
      throw error;
    } finally {
      try { targetFresh?.[Symbol.dispose](); }
      finally {
        try { sourceFresh?.[Symbol.dispose](); }
        finally { try { source?.[Symbol.dispose](); } finally { target?.[Symbol.dispose](); } }
      }
    }
  }

  dispose(): void { this.disposed = true; this.stop.abort(); }
}
