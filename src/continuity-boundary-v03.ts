import type { DatabaseSync } from "node:sqlite";
import {
  isSafeContinuityV03HumanBoundaryDbRow,
  isSafeContinuityV03PolicyDbRow,
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03SessionId,
  isSafeContinuityV03Sha256,
} from "./continuity-schema-contract-v03.js";
import { classifyContinuitySchemaV03 } from "./continuity-schema-v03.js";
import { preflightContinuityV03Rows } from "./continuity-v03-row-preflight.js";

const LIVE_EVENT_KEYS = ["kind", "sessionId", "projectId", "headerHash", "inheritedEventCount", "generation", "seq"] as const;
const LIVE_EVENT_KEY_SET = new Set<string>(LIVE_EVENT_KEYS);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** A structured coordinate from the Host's already-verified live event path. */
export interface ContinuityV03EligibleLiveHuman {
  kind: "host-direct-user-message";
  sessionId: string;
  projectId: string;
  headerHash: string;
  inheritedEventCount: number;
  generation: number;
  seq: number;
}

/** Synchronous same-store owner; this boundary recorder is DDL-free. */
export interface ContinuityV03BoundaryOwner {
  getJournalSqlite(): DatabaseSync;
  runInImmediateTransaction<T>(operation: () => T): T;
}

interface BoundaryRow {
  session_id: string; project_id: string; header_hash: string; inherited_event_count: number;
  generation: number; latest_live_human_seq: number; last_enqueued_human_seq: number;
}

function exactLiveHuman(value: unknown): ContinuityV03EligibleLiveHuman | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>;
  } catch { return null; }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== LIVE_EVENT_KEYS.length || keys.some(key => typeof key !== "string" || !LIVE_EVENT_KEY_SET.has(key))) return null;
  const fields: Record<string, unknown> = Object.create(null);
  for (const key of LIVE_EVENT_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return null;
    fields[key] = descriptor.value;
  }
  if (fields.kind !== "host-direct-user-message"
    || !isSafeContinuityV03SessionId(fields.sessionId)
    || !isSafeContinuityV03ProjectId(fields.projectId)
    || !isSafeContinuityV03Sha256(fields.headerHash)
    || typeof fields.inheritedEventCount !== "number" || !Number.isSafeInteger(fields.inheritedEventCount) || fields.inheritedEventCount < 0
    || typeof fields.generation !== "number" || !Number.isSafeInteger(fields.generation) || fields.generation < 0
    || typeof fields.seq !== "number" || !Number.isSafeInteger(fields.seq) || fields.seq < fields.inheritedEventCount) return null;
  return {
    kind: "host-direct-user-message", sessionId: fields.sessionId, projectId: fields.projectId,
    headerHash: fields.headerHash, inheritedEventCount: fields.inheritedEventCount,
    generation: fields.generation, seq: fields.seq,
  };
}

function safeDbGeneration(value: unknown): number | null {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) return null;
  let number: bigint;
  try { number = BigInt(value); } catch { return null; }
  return number >= 0n && number <= MAX_SAFE ? Number(number) : null;
}

/**
 * Persist only the latest Host-verified live direct-user message coordinate.
 * This class does not inspect session events or authenticate `kind`; callers
 * must be an internal Host-owned verifier. The watermark is for automatic
 * capture only and never authorizes provider work or Continue/actions.
 */
export class ContinuityBoundaryV03 {
  private readonly db: DatabaseSync;

  constructor(private readonly owner: ContinuityV03BoundaryOwner) {
    this.db = owner.getJournalSqlite();
  }

  /** Returns true only when a new eligible sequence was committed. */
  recordEligibleLiveHuman(value: unknown): boolean {
    const event = exactLiveHuman(value);
    if (!event) return false;
    return this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      const policyRow = this.db.prepare(`SELECT project_id,CAST(generation AS TEXT) AS generation_text,allowed
        FROM main.continuity_policy WHERE session_id=?`).get(event.sessionId) as
        { project_id: string; generation_text: string; allowed: number } | undefined;
      const generation = safeDbGeneration(policyRow?.generation_text);
      if (!policyRow || generation === null || !isSafeContinuityV03PolicyDbRow({
        session_id: event.sessionId, project_id: policyRow.project_id, generation, allowed: policyRow.allowed,
      }) || policyRow.allowed !== 1 || policyRow.project_id !== event.projectId || generation !== event.generation) return false;

      const rawBoundary = this.db.prepare(`SELECT session_id,project_id,header_hash,inherited_event_count,generation,
        latest_live_human_seq,last_enqueued_human_seq FROM main.continuity_v3_human_boundary WHERE session_id=?`)
        .get(event.sessionId);
      if (rawBoundary !== undefined && !isSafeContinuityV03HumanBoundaryDbRow(rawBoundary)) {
        throw new Error("unsafe v3 live-human boundary row");
      }
      const current = rawBoundary === undefined ? null : rawBoundary as BoundaryRow;
      const sameIdentity = current !== null && current.project_id === event.projectId
        && current.header_hash === event.headerHash && current.inherited_event_count === event.inheritedEventCount
        && current.generation === event.generation;

      if (sameIdentity) {
        if (event.seq <= current.latest_live_human_seq) return false;
        this.db.prepare(`UPDATE main.continuity_v3_human_boundary SET latest_live_human_seq=? WHERE session_id=?`)
          .run(event.seq, event.sessionId);
      } else {
        this.db.prepare(`INSERT INTO main.continuity_v3_human_boundary(session_id,project_id,header_hash,inherited_event_count,
          generation,latest_live_human_seq,last_enqueued_human_seq) VALUES(?,?,?,?,?,?,-1)
          ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,header_hash=excluded.header_hash,
          inherited_event_count=excluded.inherited_event_count,generation=excluded.generation,
          latest_live_human_seq=excluded.latest_live_human_seq,last_enqueued_human_seq=-1`)
          .run(event.sessionId, event.projectId, event.headerHash, event.inheritedEventCount, event.generation, event.seq);
      }
      this.assertReady();
      return true;
    });
  }

  private assertReady(): void {
    const schema = classifyContinuitySchemaV03(this.db);
    if (schema.kind !== "v3-schema") throw new Error("v3 boundary requires an exact active schema");
    const rows = preflightContinuityV03Rows(this.db);
    if (rows.kind !== "safe-v3-row-preflight") throw new Error("v3 boundary row preflight refused");
  }
}
