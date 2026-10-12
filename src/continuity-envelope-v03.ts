import { continuityCanonicalDigest as digest } from "./continuity-checkpoint-v02.js";
import type { ContinuityHistoricalLineageBindingV02 } from "./continuity-ancestry-v02.js";
import { CONTINUITY_STATE_VERSION_V03, type ContinuityProjectionStateV03, type ContinuityV03LineageKind } from "./continuity-projection-v03.js";
import {
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03SessionId,
  isSafeContinuityV03Sha256,
} from "./continuity-schema-contract-v03.js";

export const CONTINUITY_CHECKPOINT_FORMAT_V03 = 2;
export const CONTINUITY_SOURCE_BINDING_VERSION_V03 = 3;
export const CONTINUITY_LINEAGE_FORMAT_V03 = 2;
export const CONTINUITY_LINEAGE_BINDING_VERSION_V03 = 3;
export const CONTINUITY_V03_LINEAGE_EDGE_LIMIT = 16;

export type ContinuityV03PersistedLineageKind = "root" | "fork";
export interface ContinuityProjectionCheckpointRowV03 {
  ver: typeof CONTINUITY_STATE_VERSION_V03;
  seq: number;
  val: ContinuityProjectionStateV03;
}
export interface ContinuityCheckpointEnvelopeV03 {
  checkpointFormat: typeof CONTINUITY_CHECKPOINT_FORMAT_V03;
  sourceBindingVersion: typeof CONTINUITY_SOURCE_BINDING_VERSION_V03;
  sessionId: string;
  projectId: string;
  generation: number;
  headerHash: string;
  inheritedEventCount: number;
  asOfSeq: number;
  selectedSourceHash: string;
  sourceHash: string;
  lineageKind: ContinuityV03PersistedLineageKind;
  lineageHash: string;
  lineage: ContinuityHistoricalLineageBindingV02;
  row: ContinuityProjectionCheckpointRowV03;
}

export interface ContinuityV03JobAnchor {
  id: string;
  sessionId: string;
  projectId: string;
  generation: number;
  cut: number;
  sourceHash: string;
  selectedSourceHash: string;
  checkpointFormat: typeof CONTINUITY_CHECKPOINT_FORMAT_V03;
  sourceBindingVersion: typeof CONTINUITY_SOURCE_BINDING_VERSION_V03;
  lineageFormat: typeof CONTINUITY_LINEAGE_FORMAT_V03;
  lineageBindingVersion: typeof CONTINUITY_LINEAGE_BINDING_VERSION_V03;
  lineageKind: ContinuityV03PersistedLineageKind;
  lineageHash: string;
  trigger: "turn-end" | "pause" | "finish";
  status: "pending" | "cancelled";
}

export interface ContinuityV03WorkRow {
  jobId: string;
  token: string;
  leaseDeadline: number;
  attempts: number;
  status: "running" | "completed" | "failed";
}

export interface ContinuityHandoffV03 {
  jobId: string;
  sessionId: string;
  projectId: string;
  generation: number;
  cut: number;
  sourceHash: string;
  selectedSourceHash: string;
  checkpointFormat: typeof CONTINUITY_CHECKPOINT_FORMAT_V03;
  sourceBindingVersion: typeof CONTINUITY_SOURCE_BINDING_VERSION_V03;
  lineageFormat: typeof CONTINUITY_LINEAGE_FORMAT_V03;
  lineageBindingVersion: typeof CONTINUITY_LINEAGE_BINDING_VERSION_V03;
  lineageKind: ContinuityV03PersistedLineageKind;
  lineageHash: string;
  notes: string[];
  uncertain: true;
}

const ZERO = String.fromCharCode(0);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TURN_STATES = new Set(["unknown", "running", "completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"]);
const JOB_TRIGGERS = new Set(["turn-end", "pause", "finish"]);
const JOB_STATUSES = new Set(["pending", "cancelled"]);
const WORK_STATUSES = new Set(["running", "completed", "failed"]);
const ENVELOPE_KEYS = ["checkpointFormat", "sourceBindingVersion", "sessionId", "projectId", "generation", "headerHash",
  "inheritedEventCount", "asOfSeq", "selectedSourceHash", "sourceHash", "lineageKind", "lineageHash", "lineage", "row"] as const;
const LINEAGE_KEYS = ["format", "bindingVersion", "projectId", "child", "edges", "rootSessionKey", "bindingHash"] as const;
const LINEAGE_CHILD_KEYS = ["sessionKey", "headerHash", "inheritedEventCount", "selectedCut", "selectedSourceHash"] as const;
const LINEAGE_EDGE_KEYS = ["childSessionKey", "parentSessionKey", "childHeaderHash", "parentHeaderHash", "childInheritedEventCount",
  "parentInheritedEventCount", "copiedPrefixCut", "copiedPrefixHash"] as const;
const ROW_KEYS = ["ver", "seq", "val"] as const;
const STATE_KEYS = ["version", "inheritedEventCount", "lineageKind", "lastOwnSeq", "lastHumanSeq", "lastBoundarySeq", "turnState",
  "pendingCalls", "recentExecutions", "coverageIncomplete", "unmatchedResults"] as const;
const CALL_KEYS = ["callKey", "callSeq"] as const;
const EXECUTION_KEYS = ["callKey", "callSeq", "resultSeq", "outcome", "verified"] as const;
const JOB_KEYS = ["id", "session_id", "project_id", "generation_text", "cut_text", "source_hash", "checkpoint_format",
  "source_binding_version", "selected_source_hash", "lineage_format", "lineage_binding_version", "lineage_kind", "lineage_hash", "trigger", "status"] as const;
const WORK_KEYS = ["job_id", "token", "lease_deadline_text", "attempts_text", "status"] as const;
const HANDOFF_KEYS = ["jobId", "sessionId", "projectId", "generation", "cut", "sourceHash", "checkpointFormat",
  "sourceBindingVersion", "selectedSourceHash", "lineageFormat", "lineageBindingVersion", "lineageKind", "lineageHash", "notes", "uncertain"] as const;

/** Copy exact own data properties; reject getters, symbols, unknown keys and proxies that throw. */
function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
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

function exactArray(value: unknown, maximum: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > maximum) return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>; } catch { return null; }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== value.length + 1 || !Object.hasOwn(descriptors, "length")) return null;
  const copy: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    copy.push(descriptor.value);
  }
  return copy;
}

function safeInt(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function safeSeq(value: unknown): value is number { return safeInt(value, -1); }
function safeText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= maximum && !value.includes(ZERO);
}
function integerText(value: unknown, minimum: bigint, maximumExclusive: bigint): number | null {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed >= minimum && parsed < maximumExclusive && parsed <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(parsed) : null;
  } catch { return null; }
}

/** Versioned composite hash explicitly binds selected source and full lineage proof. */
export function continuitySourceHashV03(
  sessionId: string,
  projectId: string,
  cut: number,
  lineageKind: ContinuityV03PersistedLineageKind,
  selectedSourceHash: string,
  lineageHash: string,
): string {
  if (!isSafeContinuityV03SessionId(sessionId) || !isSafeContinuityV03ProjectId(projectId) || !safeSeq(cut)
    || !["root", "fork"].includes(lineageKind) || !isSafeContinuityV03Sha256(selectedSourceHash)
    || !isSafeContinuityV03Sha256(lineageHash)) {
    throw new Error("invalid v3 composite source-hash anchors");
  }
  return digest({ sourceBindingVersion: CONTINUITY_SOURCE_BINDING_VERSION_V03,
    sessionKey: digest(sessionId), projectId, cut, lineageKind, selectedSourceHash, lineageHash });
}

interface ParsedLineage {
  value: ContinuityHistoricalLineageBindingV02;
  kind: ContinuityV03PersistedLineageKind;
}
function parseLineage(value: unknown): ParsedLineage | null {
  const row = exactRecord(value, LINEAGE_KEYS);
  if (!row || row.format !== CONTINUITY_LINEAGE_FORMAT_V03 || row.bindingVersion !== CONTINUITY_LINEAGE_BINDING_VERSION_V03
    || !isSafeContinuityV03ProjectId(row.projectId) || !isSafeContinuityV03Sha256(row.rootSessionKey)
    || !isSafeContinuityV03Sha256(row.bindingHash)) return null;
  const child = exactRecord(row.child, LINEAGE_CHILD_KEYS);
  if (!child || !isSafeContinuityV03Sha256(child.sessionKey) || !isSafeContinuityV03Sha256(child.headerHash)
    || !safeInt(child.inheritedEventCount, 0) || !safeSeq(child.selectedCut)
    || child.selectedCut + 1 < child.inheritedEventCount || !isSafeContinuityV03Sha256(child.selectedSourceHash)) return null;
  const rawEdges = exactArray(row.edges, CONTINUITY_V03_LINEAGE_EDGE_LIMIT);
  if (!rawEdges) return null;
  const edges: ContinuityHistoricalLineageBindingV02["edges"] = [];
  for (const raw of rawEdges) {
    const edge = exactRecord(raw, LINEAGE_EDGE_KEYS);
    if (!edge || !isSafeContinuityV03Sha256(edge.childSessionKey) || !isSafeContinuityV03Sha256(edge.parentSessionKey)
      || !isSafeContinuityV03Sha256(edge.childHeaderHash) || !isSafeContinuityV03Sha256(edge.parentHeaderHash)
      || !safeInt(edge.childInheritedEventCount, 0) || !safeInt(edge.parentInheritedEventCount, 0)
      || !safeSeq(edge.copiedPrefixCut) || edge.copiedPrefixCut + 1 !== edge.childInheritedEventCount
      || !isSafeContinuityV03Sha256(edge.copiedPrefixHash)) return null;
    edges.push({
      childSessionKey: edge.childSessionKey,
      parentSessionKey: edge.parentSessionKey,
      childHeaderHash: edge.childHeaderHash,
      parentHeaderHash: edge.parentHeaderHash,
      childInheritedEventCount: edge.childInheritedEventCount,
      parentInheritedEventCount: edge.parentInheritedEventCount,
      copiedPrefixCut: edge.copiedPrefixCut,
      copiedPrefixHash: edge.copiedPrefixHash,
    });
  }

  let kind: ContinuityV03PersistedLineageKind;
  if (edges.length === 0) {
    if (row.rootSessionKey !== child.sessionKey || child.inheritedEventCount !== 0) return null;
    kind = "root";
  } else {
    if (edges[0]!.childSessionKey !== child.sessionKey || edges[0]!.childHeaderHash !== child.headerHash
      || edges[0]!.childInheritedEventCount !== child.inheritedEventCount) return null;
    const visited = new Set<string>([child.sessionKey]);
    for (let index = 0; index < edges.length; index++) {
      const edge = edges[index]!;
      if (edge.childSessionKey === edge.parentSessionKey || visited.has(edge.parentSessionKey)) return null;
      visited.add(edge.parentSessionKey);
      const next = edges[index + 1];
      if (next) {
        if (edge.parentSessionKey !== next.childSessionKey || edge.parentHeaderHash !== next.childHeaderHash
          || edge.parentInheritedEventCount !== next.childInheritedEventCount) return null;
      } else if (edge.parentSessionKey !== row.rootSessionKey || edge.parentInheritedEventCount !== 0) return null;
    }
    kind = "fork";
  }

  const payload = {
    format: CONTINUITY_LINEAGE_FORMAT_V03,
    bindingVersion: CONTINUITY_LINEAGE_BINDING_VERSION_V03,
    projectId: row.projectId,
    child: {
      sessionKey: child.sessionKey,
      headerHash: child.headerHash,
      inheritedEventCount: child.inheritedEventCount,
      selectedCut: child.selectedCut,
      selectedSourceHash: child.selectedSourceHash,
    },
    edges,
    rootSessionKey: row.rootSessionKey,
  } as const;
  if (digest(payload) !== row.bindingHash) return null;
  return { value: { ...payload, bindingHash: row.bindingHash }, kind };
}

function parseCall(value: unknown): { callKey: string; callSeq: number } | null {
  const call = exactRecord(value, CALL_KEYS);
  return call && isSafeContinuityV03Sha256(call.callKey) && safeInt(call.callSeq, 0)
    ? { callKey: call.callKey, callSeq: call.callSeq } : null;
}
function parseState(value: unknown, floor: number, cut: number, persistedKind: ContinuityV03PersistedLineageKind): ContinuityProjectionStateV03 | null {
  const state = exactRecord(value, STATE_KEYS);
  if (!state || state.version !== CONTINUITY_STATE_VERSION_V03 || state.inheritedEventCount !== floor
    || !["root", "fork-candidate"].includes(state.lineageKind as string)
    || state.lineageKind !== (persistedKind === "root" ? "root" : "fork-candidate")
    || !safeSeq(state.lastOwnSeq) || state.lastOwnSeq < floor - 1 || state.lastOwnSeq > cut
    || !safeSeq(state.lastHumanSeq) || !safeSeq(state.lastBoundarySeq)
    || typeof state.turnState !== "string" || !TURN_STATES.has(state.turnState)
    || typeof state.coverageIncomplete !== "boolean" || !safeInt(state.unmatchedResults, 0) || state.unmatchedResults > 1_000_000_000) return null;
  if (persistedKind === "root" && floor !== 0) return null;
  for (const seq of [state.lastHumanSeq, state.lastBoundarySeq]) {
    if (seq !== -1 && (seq < floor || seq > state.lastOwnSeq)) return null;
  }

  const pendingRaw = exactArray(state.pendingCalls, 32);
  const executionsRaw = exactArray(state.recentExecutions, 16);
  if (!pendingRaw || !executionsRaw) return null;
  const pendingCalls: Array<{ callKey: string; callSeq: number }> = [];
  const recentExecutions: Array<{ callKey: string; callSeq: number; resultSeq: number; outcome: "returned" | "failed"; verified: false }> = [];
  const seen = new Set<string>();
  for (const raw of pendingRaw) {
    const call = parseCall(raw);
    if (!call || call.callSeq < floor || call.callSeq > state.lastOwnSeq || seen.has(call.callKey)) return null;
    seen.add(call.callKey); pendingCalls.push(call);
  }
  for (const raw of executionsRaw) {
    const execution = exactRecord(raw, EXECUTION_KEYS);
    if (!execution || !isSafeContinuityV03Sha256(execution.callKey) || !safeInt(execution.callSeq, 0)
      || !safeInt(execution.resultSeq, 0) || execution.resultSeq <= execution.callSeq || execution.resultSeq > state.lastOwnSeq
      || execution.callSeq < floor || execution.callSeq > state.lastOwnSeq || !["returned", "failed"].includes(execution.outcome as string)
      || execution.verified !== false || seen.has(execution.callKey)) return null;
    seen.add(execution.callKey);
    recentExecutions.push({ callKey: execution.callKey, callSeq: execution.callSeq, resultSeq: execution.resultSeq,
      outcome: execution.outcome as "returned" | "failed", verified: false });
  }
  return {
    version: CONTINUITY_STATE_VERSION_V03,
    inheritedEventCount: floor,
    lineageKind: state.lineageKind as ContinuityProjectionStateV03["lineageKind"],
    lastOwnSeq: state.lastOwnSeq,
    lastHumanSeq: state.lastHumanSeq,
    lastBoundarySeq: state.lastBoundarySeq,
    turnState: state.turnState as ContinuityProjectionStateV03["turnState"],
    pendingCalls,
    recentExecutions,
    coverageIncomplete: state.coverageIncomplete,
    unmatchedResults: state.unmatchedResults,
  };
}

export function parseContinuityCheckpointEnvelopeV03(value: unknown): ContinuityCheckpointEnvelopeV03 | null {
  const envelope = exactRecord(value, ENVELOPE_KEYS);
  if (!envelope || envelope.checkpointFormat !== CONTINUITY_CHECKPOINT_FORMAT_V03
    || envelope.sourceBindingVersion !== CONTINUITY_SOURCE_BINDING_VERSION_V03
    || !isSafeContinuityV03SessionId(envelope.sessionId) || !isSafeContinuityV03ProjectId(envelope.projectId)
    || !safeInt(envelope.generation, 0) || !isSafeContinuityV03Sha256(envelope.headerHash)
    || !safeInt(envelope.inheritedEventCount, 0) || !safeSeq(envelope.asOfSeq)
    || envelope.asOfSeq + 1 < envelope.inheritedEventCount || !isSafeContinuityV03Sha256(envelope.selectedSourceHash)
    || !isSafeContinuityV03Sha256(envelope.sourceHash)
    || !["root", "fork"].includes(envelope.lineageKind as string) || !isSafeContinuityV03Sha256(envelope.lineageHash)) return null;
  const parsedLineage = parseLineage(envelope.lineage);
  if (!parsedLineage) return null;
  const lineage = parsedLineage.value;
  if (envelope.lineageKind !== parsedLineage.kind || envelope.lineageHash !== lineage.bindingHash
    || envelope.projectId !== lineage.projectId || envelope.headerHash !== lineage.child.headerHash
    || envelope.sessionId === "" || digest(envelope.sessionId) !== lineage.child.sessionKey
    || envelope.inheritedEventCount !== lineage.child.inheritedEventCount || envelope.asOfSeq !== lineage.child.selectedCut
    || envelope.selectedSourceHash !== lineage.child.selectedSourceHash) return null;
  const expectedSourceHash = continuitySourceHashV03(envelope.sessionId, envelope.projectId, envelope.asOfSeq,
    parsedLineage.kind, envelope.selectedSourceHash, lineage.bindingHash);
  if (envelope.sourceHash !== expectedSourceHash) return null;

  const row = exactRecord(envelope.row, ROW_KEYS);
  if (!row || row.ver !== CONTINUITY_STATE_VERSION_V03 || row.seq !== envelope.asOfSeq) return null;
  const state = parseState(row.val, envelope.inheritedEventCount, envelope.asOfSeq, parsedLineage.kind);
  if (!state) return null;
  return {
    checkpointFormat: CONTINUITY_CHECKPOINT_FORMAT_V03,
    sourceBindingVersion: CONTINUITY_SOURCE_BINDING_VERSION_V03,
    sessionId: envelope.sessionId,
    projectId: envelope.projectId,
    generation: envelope.generation,
    headerHash: envelope.headerHash,
    inheritedEventCount: envelope.inheritedEventCount,
    asOfSeq: envelope.asOfSeq,
    selectedSourceHash: envelope.selectedSourceHash,
    sourceHash: envelope.sourceHash,
    lineageKind: parsedLineage.kind,
    lineageHash: lineage.bindingHash,
    lineage,
    row: { ver: CONTINUITY_STATE_VERSION_V03, seq: row.seq, val: state },
  };
}

export function parseContinuityV03JobAnchor(value: unknown): ContinuityV03JobAnchor | null {
  const row = exactRecord(value, JOB_KEYS);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id) || !isSafeContinuityV03SessionId(row.session_id)
    || !isSafeContinuityV03ProjectId(row.project_id)) return null;
  const generation = integerText(row.generation_text, 0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  const cut = integerText(row.cut_text, -1n, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  if (generation === null || cut === null || !isSafeContinuityV03Sha256(row.selected_source_hash)
    || !isSafeContinuityV03Sha256(row.source_hash) || row.checkpoint_format !== CONTINUITY_CHECKPOINT_FORMAT_V03
    || row.source_binding_version !== CONTINUITY_SOURCE_BINDING_VERSION_V03
    || row.lineage_format !== CONTINUITY_LINEAGE_FORMAT_V03
    || row.lineage_binding_version !== CONTINUITY_LINEAGE_BINDING_VERSION_V03
    || !["root", "fork"].includes(row.lineage_kind as string) || !isSafeContinuityV03Sha256(row.lineage_hash)
    || typeof row.trigger !== "string" || !JOB_TRIGGERS.has(row.trigger)
    || typeof row.status !== "string" || !JOB_STATUSES.has(row.status)) return null;
  let expectedSourceHash: string;
  try { expectedSourceHash = continuitySourceHashV03(row.session_id, row.project_id, cut,
    row.lineage_kind as ContinuityV03PersistedLineageKind, row.selected_source_hash, row.lineage_hash); }
  catch { return null; }
  if (row.source_hash !== expectedSourceHash) return null;
  return {
    id: row.id, sessionId: row.session_id, projectId: row.project_id, generation, cut, sourceHash: row.source_hash,
    selectedSourceHash: row.selected_source_hash,
    checkpointFormat: CONTINUITY_CHECKPOINT_FORMAT_V03, sourceBindingVersion: CONTINUITY_SOURCE_BINDING_VERSION_V03,
    lineageFormat: CONTINUITY_LINEAGE_FORMAT_V03, lineageBindingVersion: CONTINUITY_LINEAGE_BINDING_VERSION_V03,
    lineageKind: row.lineage_kind as ContinuityV03PersistedLineageKind, lineageHash: row.lineage_hash,
    trigger: row.trigger as ContinuityV03JobAnchor["trigger"], status: row.status as ContinuityV03JobAnchor["status"],
  };
}

export function parseContinuityV03WorkRow(value: unknown): ContinuityV03WorkRow | null {
  const row = exactRecord(value, WORK_KEYS);
  if (!row || typeof row.job_id !== "string" || !UUID.test(row.job_id) || typeof row.token !== "string" || !UUID.test(row.token)
    || typeof row.status !== "string" || !WORK_STATUSES.has(row.status)) return null;
  const leaseDeadline = integerText(row.lease_deadline_text, 0n, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
  const attempts = integerText(row.attempts_text, 1n, 4n);
  if (leaseDeadline === null || attempts === null) return null;
  return { jobId: row.job_id, token: row.token, leaseDeadline, attempts, status: row.status as ContinuityV03WorkRow["status"] };
}

export function parseContinuityV03HandoffPayload(
  text: unknown,
  job: ContinuityV03JobAnchor,
): ContinuityHandoffV03 | null {
  if (typeof text !== "string" || text.length > 4000 || Buffer.byteLength(text, "utf8") > 8000 || text.includes(ZERO)) return null;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const payload = exactRecord(raw, HANDOFF_KEYS);
  if (!payload || payload.jobId !== job.id || payload.sessionId !== job.sessionId || payload.projectId !== job.projectId
    || payload.generation !== job.generation || payload.cut !== job.cut || payload.sourceHash !== job.sourceHash
    || payload.checkpointFormat !== job.checkpointFormat || payload.sourceBindingVersion !== job.sourceBindingVersion
    || payload.selectedSourceHash !== job.selectedSourceHash
    || payload.lineageFormat !== job.lineageFormat || payload.lineageBindingVersion !== job.lineageBindingVersion
    || payload.lineageKind !== job.lineageKind || payload.lineageHash !== job.lineageHash
    || payload.uncertain !== true) return null;
  const notes = exactArray(payload.notes, 3);
  if (!notes || notes.some(note => typeof note !== "string" || note.length > 280)) return null;
  return {
    jobId: job.id, sessionId: job.sessionId, projectId: job.projectId, generation: job.generation, cut: job.cut,
    sourceHash: job.sourceHash, selectedSourceHash: job.selectedSourceHash,
    checkpointFormat: job.checkpointFormat, sourceBindingVersion: job.sourceBindingVersion,
    lineageFormat: job.lineageFormat, lineageBindingVersion: job.lineageBindingVersion, lineageKind: job.lineageKind,
    lineageHash: job.lineageHash, notes: [...notes] as string[], uncertain: true,
  };
}
