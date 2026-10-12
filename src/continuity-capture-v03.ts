import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { continuitySourceAtCut, type CanonicalContinuitySource } from "./continuity-checkpoint-v02.js";
import { createContinuityCheckpointEnvelopeV03, type ContinuityV03AncestryQuery } from "./continuity-source-v03.js";
import {
  isSafeContinuityV03HumanBoundaryDbRow,
  isSafeContinuityV03PolicyDbRow,
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03SessionId,
} from "./continuity-schema-contract-v03.js";
import { classifyContinuitySchemaV03 } from "./continuity-schema-v03.js";
import { preflightContinuityV03Rows } from "./continuity-v03-row-preflight.js";
import type { ContinuityCheckpointEnvelopeV03 } from "./continuity-envelope-v03.js";

const REQUEST_KEYS = ["kind", "sessionId", "projectId", "generation", "turnEndSeq"] as const;
const REQUEST_KEY_SET = new Set<string>(REQUEST_KEYS);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Exact trigger coordinate; provenance of the live Host event is not authenticated here. */
export interface ContinuityV03TurnEndCaptureRequest {
  kind: "host-live-turn-end";
  sessionId: string;
  projectId: string;
  generation: number;
  turnEndSeq: number;
}

export interface ContinuityV03CaptureOwner {
  getJournalSqlite(): DatabaseSync;
  isInsideTransaction(): boolean;
  runInImmediateTransaction<T>(operation: () => T): T;
}

export type ContinuityV03FreshSourceReader = (signal: AbortSignal) => Promise<CanonicalContinuitySource>;
export interface ContinuityV03CaptureResult { jobId: string; created: boolean; consumedHumanSeq: number }

interface CaptureRequest {
  sessionId: string; projectId: string; generation: number; turnEndSeq: number;
}
interface BoundaryRow {
  session_id: string; project_id: string; header_hash: string; inherited_event_count: number;
  generation: number; latest_live_human_seq: number; last_enqueued_human_seq: number;
}

function parseRequest(value: unknown): CaptureRequest | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>; }
  catch { return null; }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== REQUEST_KEYS.length || keys.some(key => typeof key !== "string" || !REQUEST_KEY_SET.has(key))) return null;
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of REQUEST_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return null;
    fields[key] = descriptor.value;
  }
  if (fields.kind !== "host-live-turn-end" || !isSafeContinuityV03SessionId(fields.sessionId)
    || !isSafeContinuityV03ProjectId(fields.projectId)
    || typeof fields.generation !== "number" || !Number.isSafeInteger(fields.generation) || fields.generation < 0
    || typeof fields.turnEndSeq !== "number" || !Number.isSafeInteger(fields.turnEndSeq) || fields.turnEndSeq < 0) return null;
  return { sessionId: fields.sessionId, projectId: fields.projectId, generation: fields.generation, turnEndSeq: fields.turnEndSeq };
}

function safeIntText(value: unknown, min: bigint): number | null {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value)) return null;
  let parsed: bigint;
  try { parsed = BigInt(value); } catch { return null; }
  return parsed >= min && parsed <= MAX_SAFE ? Number(parsed) : null;
}

/**
 * DDL-free exact-cut automatic capture owner. The caller must supply a Host
 * verified turn/end coordinate and a fresh native source reader. This class
 * independently proves source/lineage at T, but it does not authenticate that
 * the trigger or live-human watermark came from a trusted Host route.
 */
export class ContinuityCaptureV03 {
  private readonly db: DatabaseSync;

  constructor(private readonly owner: ContinuityV03CaptureOwner) {
    this.db = owner.getJournalSqlite();
  }

  /**
   * Read native state outside SQLite, then atomically commit checkpoint, pending
   * job, and one-time human-watermark consumption after rechecking policy and
   * boundary. Returns null on stale/invalid capture evidence; abort propagates.
   */
  async captureAtTurnEnd(
    query: ContinuityV03AncestryQuery,
    readFreshSource: ContinuityV03FreshSourceReader,
    requestValue: unknown,
    signal: AbortSignal,
  ): Promise<ContinuityV03CaptureResult | null> {
    signal.throwIfAborted();
    this.assertNoOpenTransactionForSourceRead();
    const request = parseRequest(requestValue);
    if (!request || typeof readFreshSource !== "function") return null;
    const eligibleBeforeRead = this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      return this.eligibleBoundary(request);
    });
    if (!eligibleBeforeRead) return null;

    let source: CanonicalContinuitySource;
    let selected: CanonicalContinuitySource;
    let envelope: ContinuityCheckpointEnvelopeV03;
    try {
      source = structuredClone(await readFreshSource(signal));
      signal.throwIfAborted();
      selected = continuitySourceAtCut(source, request.turnEndSeq);
      const trigger = selected.events.at(-1);
      if (!trigger || trigger.seq !== request.turnEndSeq || trigger.type !== "turn/end") return null;
      envelope = await createContinuityCheckpointEnvelopeV03(
        query, source, request.projectId, request.generation, request.turnEndSeq, signal,
      );
    } catch {
      signal.throwIfAborted();
      return null;
    }
    signal.throwIfAborted();

    const envelopeText = JSON.stringify(envelope);
    if (envelopeText.length > 24_000 || Buffer.byteLength(envelopeText, "utf8") > 48_000) return null;
    const trigger = selected.events.at(-1);
    const state = envelope.row.val;
    if (!trigger || trigger.seq !== request.turnEndSeq || trigger.type !== "turn/end"
      || envelope.sessionId !== request.sessionId || envelope.projectId !== request.projectId
      || envelope.generation !== request.generation || envelope.asOfSeq !== request.turnEndSeq
      || envelope.row.seq !== request.turnEndSeq || state.lastOwnSeq !== request.turnEndSeq
      || state.lastBoundarySeq !== request.turnEndSeq) return null;

    return this.owner.runInImmediateTransaction(() => {
      signal.throwIfAborted();
      this.assertReady();
      const boundary = this.eligibleBoundary(request);
      if (!boundary || envelope.headerHash !== boundary.header_hash
        || envelope.inheritedEventCount !== boundary.inherited_event_count
        || state.lastHumanSeq !== boundary.latest_live_human_seq
        || boundary.latest_live_human_seq > request.turnEndSeq) return null;

      const previous = this.db.prepare(`SELECT CAST(cut AS TEXT) AS cut_text,source_hash
        FROM main.continuity_checkpoint WHERE session_id=?`).get(request.sessionId) as
        { cut_text: string; source_hash: string } | undefined;
      if (previous) {
        const previousCut = safeIntText(previous.cut_text, -1n);
        if (previousCut === null || previousCut > request.turnEndSeq
          || (previousCut === request.turnEndSeq && previous.source_hash !== envelope.sourceHash)) return null;
      }

      this.db.prepare(`INSERT INTO main.continuity_checkpoint(session_id,project_id,generation,cut,source_hash,checkpoint_format,
        source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,envelope)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,
        generation=excluded.generation,cut=excluded.cut,source_hash=excluded.source_hash,checkpoint_format=excluded.checkpoint_format,
        source_binding_version=excluded.source_binding_version,selected_source_hash=excluded.selected_source_hash,
        lineage_format=excluded.lineage_format,lineage_binding_version=excluded.lineage_binding_version,
        lineage_kind=excluded.lineage_kind,lineage_hash=excluded.lineage_hash,envelope=excluded.envelope`)
        .run(envelope.sessionId, envelope.projectId, envelope.generation, envelope.asOfSeq, envelope.sourceHash,
          envelope.checkpointFormat, envelope.sourceBindingVersion, envelope.selectedSourceHash,
          envelope.lineage.format, envelope.lineage.bindingVersion, envelope.lineageKind, envelope.lineageHash, envelopeText);

      const candidateId = randomUUID();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO main.continuity_jobs(id,session_id,project_id,generation,cut,source_hash,
        checkpoint_format,source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,trigger,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'turn-end','pending')`)
        .run(candidateId, envelope.sessionId, envelope.projectId, envelope.generation, envelope.asOfSeq, envelope.sourceHash,
          envelope.checkpointFormat, envelope.sourceBindingVersion, envelope.selectedSourceHash,
          envelope.lineage.format, envelope.lineage.bindingVersion, envelope.lineageKind, envelope.lineageHash);
      const job = this.db.prepare(`SELECT id FROM main.continuity_jobs WHERE session_id=? AND project_id=? AND generation=? AND cut=?
        AND source_hash=? AND checkpoint_format=? AND source_binding_version=? AND selected_source_hash=?
        AND lineage_format=? AND lineage_binding_version=? AND lineage_kind=? AND lineage_hash=? AND trigger='turn-end'`)
        .get(envelope.sessionId, envelope.projectId, envelope.generation, envelope.asOfSeq, envelope.sourceHash,
          envelope.checkpointFormat, envelope.sourceBindingVersion, envelope.selectedSourceHash,
          envelope.lineage.format, envelope.lineage.bindingVersion, envelope.lineageKind, envelope.lineageHash) as { id: string } | undefined;
      if (!job) throw new Error("v3 capture job insert postcondition failed");

      const consumed = this.db.prepare(`UPDATE main.continuity_v3_human_boundary SET last_enqueued_human_seq=?
        WHERE session_id=? AND project_id=? AND header_hash=? AND inherited_event_count=? AND generation=?
        AND latest_live_human_seq=? AND last_enqueued_human_seq=?`)
        .run(boundary.latest_live_human_seq, boundary.session_id, boundary.project_id, boundary.header_hash,
          boundary.inherited_event_count, boundary.generation, boundary.latest_live_human_seq, boundary.last_enqueued_human_seq);
      if (Number(consumed.changes) !== 1) throw new Error("v3 capture boundary consumption postcondition failed");
      this.assertReady();
      return { jobId: job.id, created: Number(inserted.changes) === 1, consumedHumanSeq: boundary.latest_live_human_seq };
    });
  }

  private eligibleBoundary(request: CaptureRequest): BoundaryRow | null {
    const policy = this.db.prepare(`SELECT project_id,CAST(generation AS TEXT) AS generation_text,allowed
      FROM main.continuity_policy WHERE session_id=?`).get(request.sessionId) as
      { project_id: string; generation_text: string; allowed: number } | undefined;
    const generation = safeIntText(policy?.generation_text, 0n);
    if (!policy || generation === null || !isSafeContinuityV03PolicyDbRow({
      session_id: request.sessionId, project_id: policy.project_id, generation, allowed: policy.allowed,
    }) || policy.allowed !== 1 || policy.project_id !== request.projectId || generation !== request.generation) return null;

    const raw = this.db.prepare(`SELECT session_id,project_id,header_hash,inherited_event_count,generation,
      latest_live_human_seq,last_enqueued_human_seq FROM main.continuity_v3_human_boundary WHERE session_id=?`)
      .get(request.sessionId);
    if (raw === undefined) return null;
    if (!isSafeContinuityV03HumanBoundaryDbRow(raw)) throw new Error("unsafe v3 capture boundary row");
    const row = raw as BoundaryRow;
    if (row.project_id !== request.projectId || row.generation !== request.generation
      || row.latest_live_human_seq > request.turnEndSeq || row.latest_live_human_seq <= row.last_enqueued_human_seq) return null;
    return row;
  }

  private assertNoOpenTransactionForSourceRead(): void {
    if (this.owner.isInsideTransaction()) throw new Error("v3 capture cannot await a native source read inside a store transaction");
  }

  private assertReady(): void {
    const schema = classifyContinuitySchemaV03(this.db);
    if (schema.kind !== "v3-schema") throw new Error("v3 capture requires an exact active schema");
    const rows = preflightContinuityV03Rows(this.db);
    if (rows.kind !== "safe-v3-row-preflight") throw new Error("v3 capture row preflight refused");
  }
}
