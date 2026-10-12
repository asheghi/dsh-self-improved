import type { DatabaseSync } from "node:sqlite";
import type * as Zod from "zod";
import {
  classifyContinuitySchemaV03,
  type ContinuitySchemaV03Refusal,
} from "./continuity-schema-v03.js";
import { continuityV02CheckpointEnvelopeSchema } from "./continuity-store-v02.js";
import {
  parseContinuityCheckpointEnvelopeV03,
  parseContinuityV03HandoffPayload,
  parseContinuityV03JobAnchor,
  parseContinuityV03WorkRow,
  type ContinuityCheckpointEnvelopeV03,
  type ContinuityV03JobAnchor,
  type ContinuityV03WorkRow,
} from "./continuity-envelope-v03.js";
import {
  isSafeContinuityV03PolicyDbRow,
  isSafeContinuityV03HumanBoundaryDbRow,
} from "./continuity-schema-contract-v03.js";

const PROJECT_ID = /^pj-[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const HANDOFF_FIELDS = new Set(["jobId", "sessionId", "projectId", "generation", "cut", "sourceHash", "notes", "uncertain"]);

export type ContinuityV2RowPreflight =
  | { kind: "safe-v2-row-preflight"; workerPair: "absent" | "present"; counts: { policies: number; checkpoints: number; jobs: number; work: number; handoffs: number } }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal };

interface PolicyRow { session_id: string; project_id: string; generation_text: string; allowed: number }
interface JobRow {
  id: string; session_id: string; project_id: string; generation_text: string; cut_text: string;
  source_hash: string; trigger: string; status: string;
}
interface WorkRow { job_id: string; token: string; lease_text: string; attempts_text: string; status: string }
interface HandoffRow {
  job_id: string; session_id: string; project_id: string; generation_text: string; cut_text: string;
  source_hash: string; payload: string;
}
interface CheckpointRow {
  session_id: string; project_id: string; generation_text: string; cut_text: string;
  source_hash: string; envelope: string;
}
interface ParsedCheckpointEnvelope {
  sessionId: string; inheritedEventCount: number; asOfSeq: number; sourceHash: string;
  row: { seq: number; val: { inheritedEventCount: number; lastOwnSeq: number } };
}
interface PolicyAnchor { projectId: string; generation: bigint; allowed: number }
interface JobAnchor { sessionId: string; projectId: string; generation: bigint; cut: bigint; sourceHash: string }

function integerText(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) return null;
  try { return BigInt(value); } catch { return null; }
}
function boundedInteger(value: unknown, minimum: bigint, maximumExclusive: bigint): bigint | null {
  const parsed = integerText(value);
  return parsed !== null && parsed >= minimum && parsed < maximumExclusive ? parsed : null;
}
function validSessionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !value.includes(String.fromCharCode(0));
}
function containsEmbeddedNul(db: DatabaseSync, table: string, columns: readonly string[]): boolean {
  if (columns.length === 0) return false;
  const predicate = columns.map(column => `instr(CAST(\"${column}\" AS BLOB),X'00')>0`).join(" OR ");
  return db.prepare(`SELECT 1 AS found FROM main.\"${table}\" WHERE ${predicate} LIMIT 1`).get() !== undefined;
}
function validProjectId(value: unknown): boolean {
  return typeof value === "string" && PROJECT_ID.test(value);
}
function validSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256.test(value);
}
function validHandoffPayload(text: string, row: HandoffRow, job: JobAnchor, jobId: string): boolean {
  if (text.length > 4000) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return false; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
  const value = parsed as Record<string, unknown>;
  const keys = Object.keys(value);
  if (keys.length !== HANDOFF_FIELDS.size || keys.some(key => !HANDOFF_FIELDS.has(key))) return false;
  if (!validSessionId(value.jobId) || value.jobId !== jobId
    || !validSessionId(value.sessionId) || value.sessionId !== row.session_id || value.sessionId !== job.sessionId
    || !validProjectId(value.projectId) || value.projectId !== row.project_id || value.projectId !== job.projectId
    || typeof value.generation !== "number" || !Number.isSafeInteger(value.generation) || value.generation < 0
    || BigInt(value.generation) !== job.generation
    || typeof value.cut !== "number" || !Number.isSafeInteger(value.cut) || value.cut < -1
    || BigInt(value.cut) !== job.cut
    || !validSha256(value.sourceHash) || value.sourceHash !== row.source_hash || value.sourceHash !== job.sourceHash
    || value.uncertain !== true || !Array.isArray(value.notes) || value.notes.length > 3) return false;
  return value.notes.every(note => typeof note === "string" && note.length <= 280);
}
type ArchiveRowsResult =
  | { kind: "safe-archive-rows"; jobs: number; handoffs: number }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal };

function preflightLegacyArchiveRows(
  db: DatabaseSync,
  archiveState: "none" | "jobs-only" | "jobs-and-handoffs" | "purged",
): ArchiveRowsResult {
  if (archiveState === "none" || archiveState === "purged") return { kind: "safe-archive-rows", jobs: 0, handoffs: 0 };
  const jobTable = "continuity_jobs_legacy_v2";
  if (containsEmbeddedNul(db, jobTable, ["id", "session_id", "project_id", "source_hash", "trigger", "status"])) {
    return { kind: "refuse", reason: "unsafe-v2-archive-job-row" };
  }
  const jobRows = db.prepare(`SELECT id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
    CAST(cut AS TEXT) AS cut_text,source_hash,trigger,status FROM main.${jobTable}`).all() as unknown as JobRow[];
  const anchors = new Map<string, JobAnchor>();
  for (const row of jobRows) {
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE);
    const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
    if (!validSessionId(row.id) || !validSessionId(row.session_id) || !validProjectId(row.project_id)
      || generation === null || cut === null || !validSha256(row.source_hash)
      || !["turn-end", "pause", "finish"].includes(row.trigger) || row.status !== "cancelled") {
      return { kind: "refuse", reason: "unsafe-v2-archive-job-row" };
    }
    anchors.set(row.id, { sessionId: row.session_id, projectId: row.project_id, generation, cut, sourceHash: row.source_hash });
  }

  if (archiveState === "jobs-only") return { kind: "safe-archive-rows", jobs: jobRows.length, handoffs: 0 };
  const handoffTable = "continuity_handoff_legacy_v2";
  if (containsEmbeddedNul(db, handoffTable, ["job_id", "session_id", "project_id", "source_hash"])) {
    return { kind: "refuse", reason: "unsafe-v2-archive-handoff-row" };
  }
  if (containsEmbeddedNul(db, handoffTable, ["payload"])) {
    return { kind: "refuse", reason: "unsafe-v2-archive-handoff-payload" };
  }
  const handoffRows = db.prepare(`SELECT job_id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
    CAST(cut AS TEXT) AS cut_text,source_hash,payload FROM main.${handoffTable}`).all() as unknown as HandoffRow[];
  for (const row of handoffRows) {
    const job = anchors.get(row.job_id);
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE);
    const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
    if (!job || generation === null || cut === null || row.session_id !== job.sessionId || row.project_id !== job.projectId
      || generation !== job.generation || cut !== job.cut || row.source_hash !== job.sourceHash) {
      return { kind: "refuse", reason: "unsafe-v2-archive-handoff-row" };
    }
    if (!validHandoffPayload(row.payload, row, job, row.job_id)) {
      return { kind: "refuse", reason: "unsafe-v2-archive-handoff-payload" };
    }
  }
  return { kind: "safe-archive-rows", jobs: jobRows.length, handoffs: handoffRows.length };
}

function validCheckpointRow(row: CheckpointRow, policy: PolicyAnchor | undefined): boolean {
  const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE);
  const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
  return validSessionId(row.session_id) && validProjectId(row.project_id) && validSha256(row.source_hash)
    && generation !== null && cut !== null && !!policy && policy.allowed === 1
    && policy.projectId === row.project_id && policy.generation === generation;
}
function validCheckpointEnvelope(
  text: string,
  row: CheckpointRow,
  envelopeSchema: ReturnType<typeof continuityV02CheckpointEnvelopeSchema>,
): boolean {
  if (typeof text !== "string" || text.length > 24_000) return false;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return false; }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success) return false;
  const envelope = parsed.data as ParsedCheckpointEnvelope;
  const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
  return cut !== null && envelope.sessionId === row.session_id && envelope.sourceHash === row.source_hash
    && Number.isSafeInteger(envelope.inheritedEventCount) && envelope.inheritedEventCount >= 0
    && Number.isSafeInteger(envelope.asOfSeq) && envelope.asOfSeq >= -1
    && Number.isSafeInteger(envelope.row.seq) && envelope.row.seq === envelope.asOfSeq
    && BigInt(envelope.asOfSeq) === cut
    && envelope.row.val.inheritedEventCount === envelope.inheritedEventCount
    && Number.isSafeInteger(envelope.row.val.lastOwnSeq) && envelope.row.val.lastOwnSeq <= envelope.asOfSeq;
}

/**
 * Read-only row-safety pass for exact Legacy-v2 schema, including checkpoints
 * that the migration is required to discard. It validates stored structure and
 * cross-row anchors, not hashes against a native source observation. A
 * successful result is only data-preflight evidence: it does not prove
 * exclusive ownership, backup, offline shutdown, or permission to migrate.
 * The gated offline migrator uses the package's exact declared Zod4 instance
 * and calls this before its first continuity write in the same IMMEDIATE
 * transaction; operator confirmations remain a separate capability boundary.
 */
export function preflightContinuityV2RowsV03(db: DatabaseSync, z: typeof Zod): ContinuityV2RowPreflight {
  const schema = classifyContinuitySchemaV03(db);
  if (schema.kind === "refuse") return schema;
  if (schema.kind !== "legacy-v2-schema") return { kind: "refuse", reason: "not-exact-legacy-v2-schema" };
  // node:sqlite truncates returned TEXT at embedded NUL, so JS-only validation
  // can mistake a valid-looking prefix for the complete persisted value. Probe
  // the exact SQLite BLOB before any row parser sees those strings.
  if (containsEmbeddedNul(db, "continuity_policy", ["session_id", "project_id"])) {
    return { kind: "refuse", reason: "unsafe-v2-policy-row" };
  }
  if (containsEmbeddedNul(db, "continuity_jobs", ["id", "session_id", "project_id", "source_hash", "trigger", "status"])) {
    return { kind: "refuse", reason: "unsafe-v2-job-row" };
  }
  if (schema.workerPair === "present") {
    if (containsEmbeddedNul(db, "continuity_work", ["job_id", "token", "status"])) {
      return { kind: "refuse", reason: "unsafe-v2-work-row" };
    }
    if (containsEmbeddedNul(db, "continuity_handoff", ["job_id", "session_id", "project_id", "source_hash"])) {
      return { kind: "refuse", reason: "unsafe-v2-handoff-row" };
    }
    if (containsEmbeddedNul(db, "continuity_handoff", ["payload"])) {
      return { kind: "refuse", reason: "unsafe-v2-handoff-payload" };
    }
  }
  if (containsEmbeddedNul(db, "continuity_checkpoint", ["session_id", "project_id", "source_hash"])) {
    return { kind: "refuse", reason: "unsafe-v2-checkpoint-row" };
  }
  if (containsEmbeddedNul(db, "continuity_checkpoint", ["envelope"])) {
    return { kind: "refuse", reason: "unsafe-v2-checkpoint-envelope" };
  }
  const envelopeSchema = continuityV02CheckpointEnvelopeSchema(z);

  const policies = db.prepare(`SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text,allowed
    FROM main.continuity_policy`).all() as unknown as PolicyRow[];
  const policiesBySession = new Map<string, PolicyAnchor>();
  for (const row of policies) {
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE);
    if (!validSessionId(row.session_id) || !validProjectId(row.project_id)
      || generation === null || (row.allowed !== 0 && row.allowed !== 1)) {
      return { kind: "refuse", reason: "unsafe-v2-policy-row" };
    }
    policiesBySession.set(row.session_id, { projectId: row.project_id, generation, allowed: row.allowed });
  }

  const jobs = db.prepare(`SELECT id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
    CAST(cut AS TEXT) AS cut_text,source_hash,trigger,status FROM main.continuity_jobs`).all() as unknown as JobRow[];
  const anchors = new Map<string, JobAnchor>();
  for (const row of jobs) {
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE);
    const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
    if (!validSessionId(row.id) || !validSessionId(row.session_id) || !validProjectId(row.project_id)
      || generation === null || cut === null || !validSha256(row.source_hash)
      || !["turn-end", "pause", "finish"].includes(row.trigger)
      || !["pending", "cancelled"].includes(row.status)) return { kind: "refuse", reason: "unsafe-v2-job-row" };
    anchors.set(row.id, { sessionId: row.session_id, projectId: row.project_id, generation, cut, sourceHash: row.source_hash });
  }

  const workRows = schema.workerPair === "present"
    ? db.prepare(`SELECT job_id,token,CAST(lease_deadline AS TEXT) AS lease_text,
        CAST(attempts AS TEXT) AS attempts_text,status FROM main.continuity_work`).all() as unknown as WorkRow[]
    : [];
  const workByJob = new Map<string, WorkRow>();
  for (const row of workRows) {
    const attempts = boundedInteger(row.attempts_text, 1n, 4n);
    if (!validSessionId(row.job_id) || !anchors.has(row.job_id) || !TOKEN.test(row.token)
      || boundedInteger(row.lease_text, 0n, MAX_SAFE + 1n) === null || attempts === null
      || !["running", "completed", "failed"].includes(row.status)) {
      return { kind: "refuse", reason: "unsafe-v2-work-row" };
    }
    workByJob.set(row.job_id, row);
  }

  const handoffs = schema.workerPair === "present"
    ? db.prepare(`SELECT job_id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
        CAST(cut AS TEXT) AS cut_text,source_hash,payload FROM main.continuity_handoff`).all() as unknown as HandoffRow[]
    : [];
  for (const row of handoffs) {
    const job = anchors.get(row.job_id);
    const work = workByJob.get(row.job_id);
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE);
    const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
    if (!job || !work || work.status !== "completed" || generation === null || cut === null
      || row.session_id !== job.sessionId || row.project_id !== job.projectId
      || generation !== job.generation || cut !== job.cut || row.source_hash !== job.sourceHash) {
      return { kind: "refuse", reason: "unsafe-v2-handoff-row" };
    }
    if (!validHandoffPayload(row.payload, row, job, row.job_id)) {
      return { kind: "refuse", reason: "unsafe-v2-handoff-payload" };
    }
  }

  const checkpoints = db.prepare(`SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text,
    CAST(cut AS TEXT) AS cut_text,source_hash,envelope FROM main.continuity_checkpoint`).all() as unknown as CheckpointRow[];
  for (const row of checkpoints) {
    const policy = policiesBySession.get(row.session_id);
    if (!validCheckpointRow(row, policy)) return { kind: "refuse", reason: "unsafe-v2-checkpoint-row" };
    if (!validCheckpointEnvelope(row.envelope, row, envelopeSchema)) {
      return { kind: "refuse", reason: "unsafe-v2-checkpoint-envelope" };
    }
  }

  return {
    kind: "safe-v2-row-preflight",
    workerPair: schema.workerPair,
    counts: { policies: policies.length, checkpoints: checkpoints.length, jobs: jobs.length, work: workRows.length, handoffs: handoffs.length },
  };
}

export type ContinuityV03RowPreflight =
  | { kind: "safe-v3-row-preflight"; counts: { policies: number; boundaries: number; checkpoints: number; jobs: number; work: number; handoffs: number; archivedJobs: number; archivedHandoffs: number } }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal };

interface V3CheckpointDbRow {
  session_id: string; project_id: string; generation_text: string; cut_text: string; source_hash: string; selected_source_hash: string;
  checkpoint_format: number; source_binding_version: number; lineage_format: number; lineage_binding_version: number;
  lineage_kind: string; lineage_hash: string; envelope: string;
}
interface V3HandoffDbRow extends Omit<V3CheckpointDbRow, "envelope"> { job_id: string; payload: string }

/**
 * Read-only structural validation for v3 active rows and anchors. This checks
 * internal persisted consistency, not hashes against a live native observation;
 * it cannot grant lineage, policy, worker, preview, or Continue authority.
 */
export function preflightContinuityV03Rows(db: DatabaseSync): ContinuityV03RowPreflight {
  const schema = classifyContinuitySchemaV03(db);
  if (schema.kind !== "v3-schema") return { kind: "refuse", reason: schema.kind === "refuse" ? schema.reason : "v3-required-table-missing" };
  const archiveRows = preflightLegacyArchiveRows(db, schema.legacyArchiveState);
  if (archiveRows.kind === "refuse") return archiveRows;

  const textColumns: Array<[string, readonly string[]]> = [
    ["continuity_policy", ["session_id", "project_id"]],
    ["continuity_v3_human_boundary", ["session_id", "project_id", "header_hash"]],
    ["continuity_checkpoint", ["session_id", "project_id", "source_hash", "selected_source_hash", "lineage_kind", "lineage_hash", "envelope"]],
    ["continuity_jobs", ["id", "session_id", "project_id", "source_hash", "selected_source_hash", "lineage_kind", "lineage_hash", "trigger", "status"]],
  ];
  if (schema.workerPair === "present") {
    textColumns.push(
      ["continuity_work", ["job_id", "token", "status"]],
      ["continuity_handoff", ["job_id", "session_id", "project_id", "source_hash", "selected_source_hash", "lineage_kind", "lineage_hash", "payload"]],
    );
  }
  for (const [table, columns] of textColumns) {
    if (containsEmbeddedNul(db, table, columns)) {
      const reason = table === "continuity_policy" ? "unsafe-v3-policy-row"
        : table === "continuity_v3_human_boundary" ? "unsafe-v3-boundary-row" : "unsafe-v3-row";
      return { kind: "refuse", reason };
    }
  }

  const policyRows = db.prepare("SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text,allowed FROM main.continuity_policy").all() as
    Array<{ session_id: string; project_id: string; generation_text: string; allowed: number }>;
  const policyBySession = new Map<string, { projectId: string; generation: bigint; allowed: number }>();
  for (const row of policyRows) {
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE + 1n);
    if (generation === null || !isSafeContinuityV03PolicyDbRow({
      session_id: row.session_id, project_id: row.project_id, generation: Number(generation), allowed: row.allowed,
    })) return { kind: "refuse", reason: "unsafe-v3-policy-row" };
    policyBySession.set(row.session_id, { projectId: row.project_id, generation, allowed: row.allowed });
  }

  const boundaryRows = db.prepare(`SELECT session_id,project_id,header_hash,inherited_event_count,generation,
    latest_live_human_seq,last_enqueued_human_seq FROM main.continuity_v3_human_boundary`).all();
  // Structural consistency only: a body-free historical boundary may remain
  // after policy denial/revocation. It is stale and non-authoritative when its
  // generation is behind. Every capture caller must independently require
  // current policy.allowed===1 and exact generation in its transaction.
  for (const row of boundaryRows) {
    if (!isSafeContinuityV03HumanBoundaryDbRow(row)) return { kind: "refuse", reason: "unsafe-v3-boundary-row" };
    const policy = policyBySession.get(row.session_id);
    if (!policy || policy.projectId !== row.project_id || BigInt(row.generation) > policy.generation) {
      return { kind: "refuse", reason: "unsafe-v3-boundary-row" };
    }
  }

  const checkpointRows = db.prepare(`SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text,
    CAST(cut AS TEXT) AS cut_text,source_hash,checkpoint_format,source_binding_version,selected_source_hash,lineage_format,
    lineage_binding_version,lineage_kind,lineage_hash,envelope FROM main.continuity_checkpoint`).all() as unknown as V3CheckpointDbRow[];
  const checkpointsBySession = new Map<string, ContinuityCheckpointEnvelopeV03>();
  for (const row of checkpointRows) {
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE + 1n);
    const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
    const policy = policyBySession.get(row.session_id);
    if (generation === null || cut === null || !validSessionId(row.session_id) || !validProjectId(row.project_id)
      || !validSha256(row.source_hash) || !validSha256(row.selected_source_hash)
      || row.checkpoint_format !== 2 || row.source_binding_version !== 3
      || row.lineage_format !== 2 || row.lineage_binding_version !== 3 || !["root", "fork"].includes(row.lineage_kind)
      || !validSha256(row.lineage_hash) || typeof row.envelope !== "string") {
      return { kind: "refuse", reason: "unsafe-v3-checkpoint-row" };
    }
    if (row.envelope.length > 24_000 || Buffer.byteLength(row.envelope, "utf8") > 48_000) {
      return { kind: "refuse", reason: "unsafe-v3-checkpoint-envelope" };
    }
    let raw: unknown;
    try { raw = JSON.parse(row.envelope); } catch { return { kind: "refuse", reason: "unsafe-v3-checkpoint-envelope" }; }
    const envelope = parseContinuityCheckpointEnvelopeV03(raw);
    if (!envelope || envelope.sessionId !== row.session_id || envelope.projectId !== row.project_id
      || envelope.generation !== Number(generation) || envelope.asOfSeq !== Number(cut) || envelope.sourceHash !== row.source_hash
      || envelope.selectedSourceHash !== row.selected_source_hash || envelope.checkpointFormat !== row.checkpoint_format || envelope.sourceBindingVersion !== row.source_binding_version
      || envelope.lineageKind !== row.lineage_kind || envelope.lineageHash !== row.lineage_hash
      || !policy || policy.allowed !== 1 || policy.projectId !== row.project_id || policy.generation !== generation) {
      return { kind: "refuse", reason: "unsafe-v3-checkpoint-envelope" };
    }
    checkpointsBySession.set(row.session_id, envelope);
  }

  const jobRows = db.prepare(`SELECT id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
    CAST(cut AS TEXT) AS cut_text,source_hash,checkpoint_format,source_binding_version,selected_source_hash,lineage_format,
    lineage_binding_version,lineage_kind,lineage_hash,trigger,status FROM main.continuity_jobs`).all() as unknown[];
  const jobsById = new Map<string, ContinuityV03JobAnchor>();
  for (const raw of jobRows) {
    const job = parseContinuityV03JobAnchor(raw);
    if (!job) return { kind: "refuse", reason: "unsafe-v3-job-row" };
    const policy = policyBySession.get(job.sessionId);
    if (!policy || policy.projectId !== job.projectId || BigInt(job.generation) > policy.generation
      || (job.status === "pending" && (policy.allowed !== 1 || BigInt(job.generation) !== policy.generation))) {
      return { kind: "refuse", reason: "unsafe-v3-job-row" };
    }
    const checkpoint = checkpointsBySession.get(job.sessionId);
    if (job.status === "pending" && (!checkpoint || checkpoint.projectId !== job.projectId
      || checkpoint.generation !== job.generation || checkpoint.asOfSeq < job.cut || checkpoint.lineageKind !== job.lineageKind)) {
      return { kind: "refuse", reason: "unsafe-v3-job-row" };
    }
    if (job.status === "pending" && checkpoint && checkpoint.generation === job.generation && checkpoint.asOfSeq === job.cut
      && (checkpoint.sourceHash !== job.sourceHash || checkpoint.selectedSourceHash !== job.selectedSourceHash
        || checkpoint.lineageKind !== job.lineageKind || checkpoint.lineageHash !== job.lineageHash
        || checkpoint.checkpointFormat !== job.checkpointFormat
        || checkpoint.sourceBindingVersion !== job.sourceBindingVersion)) {
      return { kind: "refuse", reason: "unsafe-v3-job-row" };
    }
    jobsById.set(job.id, job);
  }

  const workRows = schema.workerPair === "present"
    ? db.prepare(`SELECT job_id,token,CAST(lease_deadline AS TEXT) AS lease_deadline_text,
        CAST(attempts AS TEXT) AS attempts_text,status FROM main.continuity_work`).all() as unknown[]
    : [];
  const workByJob = new Map<string, ContinuityV03WorkRow>();
  for (const raw of workRows) {
    const work = parseContinuityV03WorkRow(raw);
    if (!work || !jobsById.has(work.jobId) || workByJob.has(work.jobId)) {
      return { kind: "refuse", reason: "unsafe-v3-work-row" };
    }
    workByJob.set(work.jobId, work);
  }

  const handoffRows = schema.workerPair === "present"
    ? db.prepare(`SELECT job_id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
        CAST(cut AS TEXT) AS cut_text,source_hash,checkpoint_format,source_binding_version,selected_source_hash,lineage_format,
        lineage_binding_version,lineage_kind,lineage_hash,payload FROM main.continuity_handoff`).all() as unknown as V3HandoffDbRow[]
    : [];
  for (const row of handoffRows) {
    const job = jobsById.get(row.job_id);
    const work = workByJob.get(row.job_id);
    const generation = boundedInteger(row.generation_text, 0n, MAX_SAFE + 1n);
    const cut = boundedInteger(row.cut_text, -1n, MAX_SAFE + 1n);
    if (!job || !work || work.status !== "completed" || generation === null || cut === null
      || row.session_id !== job.sessionId || row.project_id !== job.projectId || Number(generation) !== job.generation
      || Number(cut) !== job.cut || row.source_hash !== job.sourceHash || row.checkpoint_format !== job.checkpointFormat
      || row.source_binding_version !== job.sourceBindingVersion || row.selected_source_hash !== job.selectedSourceHash
      || row.lineage_format !== job.lineageFormat
      || row.lineage_binding_version !== job.lineageBindingVersion || row.lineage_kind !== job.lineageKind
      || row.lineage_hash !== job.lineageHash) {
      return { kind: "refuse", reason: "unsafe-v3-handoff-row" };
    }
    if (!parseContinuityV03HandoffPayload(row.payload, job)) {
      return { kind: "refuse", reason: "unsafe-v3-handoff-payload" };
    }
  }

  return {
    kind: "safe-v3-row-preflight",
    counts: {
      policies: policyRows.length, boundaries: boundaryRows.length, checkpoints: checkpointRows.length,
      jobs: jobRows.length, work: workRows.length, handoffs: handoffRows.length,
      archivedJobs: archiveRows.jobs, archivedHandoffs: archiveRows.handoffs,
    },
  };
}
