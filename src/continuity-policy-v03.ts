import type { DatabaseSync } from "node:sqlite";
import { CONTINUITY_ANCESTOR_LIMIT } from "./continuity-ancestry-v02.js";
import { continuityCanonicalDigest } from "./continuity-checkpoint-v02.js";
import { composeContinuityPreviewLineagePolicyStampV03,
  type ContinuityPreviewLineagePolicyRowV03,
  type ContinuityPreviewLineagePolicyStampV03 } from "./continuity-lineage-policy-v03.js";
import {
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03PolicyDbRow,
  isSafeContinuityV03SessionId,
} from "./continuity-schema-contract-v03.js";
import { classifyContinuitySchemaV03 } from "./continuity-schema-v03.js";
import { preflightContinuityV03Rows } from "./continuity-v03-row-preflight.js";
import { readContinuitySummaryPolicyEpochV02 } from "./continuity-summary-ledger-owner.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Same-store owner; the v3 policy class is DDL-free and never touches summary ledgers. */
export interface ContinuityV03PolicyOwner {
  getJournalSqlite(): DatabaseSync;
  runInImmediateTransaction<T>(operation: () => T): T;
}

interface PolicyRow { projectId: string; generation: number; allowed: boolean }
interface PolicyDbRow { project_id: string; generation_text: string; allowed: number }
interface PolicySnapshotDbRow extends PolicyDbRow { session_id: string }

function validatePolicyArgs(sessionId: string, projectId: string, allowed: boolean): void {
  if (!isSafeContinuityV03SessionId(sessionId) || !isSafeContinuityV03ProjectId(projectId) || typeof allowed !== "boolean") {
    throw new Error("invalid v3 continuity policy coordinates");
  }
}

function parseGeneration(text: unknown): number | null {
  if (typeof text !== "string" || !/^(0|[1-9][0-9]*)$/.test(text)) return null;
  let value: bigint;
  try { value = BigInt(text); } catch { return null; }
  return value >= 0n && value <= MAX_SAFE ? Number(value) : null;
}

function exactSnapshotData(value: unknown): { binding: unknown; sessionIds: unknown } | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch { return null; }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== 2 || !keys.includes("binding") || !keys.includes("sessionIds")) return null;
  const binding = descriptors.binding, sessionIds = descriptors.sessionIds;
  if (!binding || !Object.hasOwn(binding, "value") || !sessionIds || !Object.hasOwn(sessionIds, "value")) return null;
  return { binding: binding.value, sessionIds: sessionIds.value };
}

function exactSessionIdArray(value: unknown): string[] | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (!Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch { return null; }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 1
    || lengthDescriptor.value > CONTINUITY_ANCESTOR_LIMIT + 1) return null;
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || !Object.hasOwn(descriptors, "length")) return null;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || !isSafeContinuityV03SessionId(descriptor.value)
      || seen.has(descriptor.value)) return null;
    seen.add(descriptor.value);
    ids.push(descriptor.value);
  }
  if (keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
    || Number(key) >= length))) return null;
  return ids;
}

/**
 * Continuity-only policy generation owner. `allowed` must come from an already
 * authorized settings/consent owner; this class persists that decision but does
 * not authenticate it or update body-summary consent. Every change revokes
 * pending work, invalidates checkpoints and running leases in the same transaction.
 * Re-enable never resurrects cancelled jobs. A project move purges the old active
 * lane, including its handoffs/boundary, to avoid cross-project orphan anchors.
 */
export class ContinuityPolicyV03 {
  private readonly db: DatabaseSync;

  constructor(private readonly owner: ContinuityV03PolicyOwner) {
    this.db = owner.getJournalSqlite();
  }

  /** User/host-owned policy change. Even identical explicit changes advance the generation. */
  setPolicy(sessionId: string, projectId: string, allowed: boolean): number {
    validatePolicyArgs(sessionId, projectId, allowed);
    return this.owner.runInImmediateTransaction(() => {
      const schema = this.assertReady();
      return this.setPolicyInTransaction(sessionId, projectId, allowed, schema.workerPair);
    });
  }

  /** Idempotent startup reconciliation; unchanged policy preserves the generation and work. */
  ensurePolicy(sessionId: string, projectId: string, allowed: boolean): number {
    validatePolicyArgs(sessionId, projectId, allowed);
    return this.owner.runInImmediateTransaction(() => {
      const schema = this.assertReady();
      const current = this.readPolicyRow(sessionId);
      if (current && current.projectId === projectId && current.allowed === allowed) return current.generation;
      return this.setPolicyInTransaction(sessionId, projectId, allowed, schema.workerPair);
    });
  }

  /**
   * Read one current policy row for each raw child-to-root ID in a verified
   * snapshot, requiring the child's row generation to match the preview claim.
   * Missing/denied rows fail closed. After read-only preflight, one DDL-free
   * SELECT reads the chain. The Host must source the snapshot from native
   * verification and globalEpoch from its privacy/exclusion owner; neither is
   * authenticated here.
   */
  readLineagePolicyStamp(
    snapshotValue: unknown,
    projectId: string,
    expectedChildGeneration: number,
    globalEpoch: number,
  ): ContinuityPreviewLineagePolicyStampV03 | null {
    if (!isSafeContinuityV03ProjectId(projectId) || !Number.isSafeInteger(expectedChildGeneration)
      || expectedChildGeneration < 0) return null;
    const snapshot = exactSnapshotData(snapshotValue);
    if (!snapshot) return null;
    const sessionIds = exactSessionIdArray(snapshot.sessionIds);
    if (!sessionIds) return null;
    const probeRows: ContinuityPreviewLineagePolicyRowV03[] = sessionIds.map((sessionId, index) => ({
      sessionKey: continuityCanonicalDigest(sessionId), projectId,
      generation: index === 0 ? expectedChildGeneration : 0, allowed: true,
    }));
    if (!composeContinuityPreviewLineagePolicyStampV03(snapshot.binding, probeRows, globalEpoch)) return null;

    this.assertReady();
    const placeholders = sessionIds.map(() => "?").join(",");
    const dbRows = this.db.prepare(`SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text,allowed
      FROM main.continuity_policy WHERE session_id IN (${placeholders})`).all(...sessionIds) as unknown as PolicySnapshotDbRow[];
    if (dbRows.length !== sessionIds.length) return null;
    const byId = new Map<string, PolicySnapshotDbRow>();
    for (const row of dbRows) {
      if (!isSafeContinuityV03SessionId(row.session_id) || byId.has(row.session_id)) return null;
      const generation = parseGeneration(row.generation_text);
      if (generation === null || !isSafeContinuityV03PolicyDbRow({
        session_id: row.session_id, project_id: row.project_id, generation, allowed: row.allowed,
      })) return null;
      byId.set(row.session_id, row);
    }
    const rows: ContinuityPreviewLineagePolicyRowV03[] = [];
    for (let index = 0; index < sessionIds.length; index++) {
      const sessionId = sessionIds[index]!;
      const row = byId.get(sessionId);
      if (!row) return null;
      const generation = parseGeneration(row.generation_text);
      if (generation === null || row.project_id !== projectId || row.allowed !== 1
        || (index === 0 && generation !== expectedChildGeneration)) return null;
      rows.push({ sessionKey: continuityCanonicalDigest(sessionId), projectId, generation, allowed: true });
    }
    return composeContinuityPreviewLineagePolicyStampV03(snapshot.binding, rows, globalEpoch);
  }

  /**
   * Atomically read the allowed summary-policy epoch and the complete lineage
   * policy chain on the same owner connection. The immediate transaction is
   * intentionally short, DDL-free, and performs no writes; any owner/schema
   * error fails closed. Use this rather than supplying an epoch from a separate
   * connection/read when admitting preview payloads.
   */
  readCurrentLineagePolicyStamp(
    snapshotValue: unknown,
    projectId: string,
    expectedChildGeneration: number,
  ): ContinuityPreviewLineagePolicyStampV03 | null {
    try {
      return this.owner.runInImmediateTransaction(() => {
        const globalEpoch = readContinuitySummaryPolicyEpochV02(this.db);
        if (globalEpoch === null) return null;
        return this.readLineagePolicyStamp(snapshotValue, projectId, expectedChildGeneration, globalEpoch);
      });
    } catch { return null; }
  }

  private setPolicyInTransaction(
    sessionId: string,
    projectId: string,
    allowed: boolean,
    workerPair: "absent" | "present",
  ): number {
    const current = this.readPolicyRow(sessionId);
    const generation = current ? current.generation + 1 : 0;
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error("v3 continuity generation overflow");

    if (current && current.projectId !== projectId) {
      if (workerPair === "present") {
        this.db.prepare(`DELETE FROM main.continuity_handoff WHERE job_id IN
          (SELECT id FROM main.continuity_jobs WHERE session_id=?)`).run(sessionId);
        this.db.prepare(`DELETE FROM main.continuity_work WHERE job_id IN
          (SELECT id FROM main.continuity_jobs WHERE session_id=?)`).run(sessionId);
      }
      this.db.prepare("DELETE FROM main.continuity_jobs WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM main.continuity_checkpoint WHERE session_id=?").run(sessionId);
      this.db.prepare("DELETE FROM main.continuity_v3_human_boundary WHERE session_id=?").run(sessionId);
    } else {
      this.db.prepare("UPDATE main.continuity_jobs SET status='cancelled' WHERE session_id=? AND status='pending'").run(sessionId);
      if (workerPair === "present") {
        this.db.prepare(`UPDATE main.continuity_work SET status='failed' WHERE status='running'
          AND job_id IN (SELECT id FROM main.continuity_jobs WHERE session_id=? AND status='cancelled')`).run(sessionId);
      }
      this.db.prepare("DELETE FROM main.continuity_checkpoint WHERE session_id=?").run(sessionId);
    }

    this.db.prepare(`INSERT INTO main.continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,?)
      ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,generation=excluded.generation,allowed=excluded.allowed`)
      .run(sessionId, projectId, generation, allowed ? 1 : 0);
    this.assertReady();
    return generation;
  }

  private readPolicyRow(sessionId: string): PolicyRow | null {
    const row = this.db.prepare(`SELECT project_id,CAST(generation AS TEXT) AS generation_text,allowed
      FROM main.continuity_policy WHERE session_id=?`).get(sessionId) as PolicyDbRow | undefined;
    if (!row) return null;
    const generation = parseGeneration(row.generation_text);
    if (generation === null || !isSafeContinuityV03PolicyDbRow({
      session_id: sessionId, project_id: row.project_id, generation, allowed: row.allowed,
    })) throw new Error("unsafe v3 continuity policy row");
    return { projectId: row.project_id, generation, allowed: row.allowed === 1 };
  }

  private assertReady(): { workerPair: "absent" | "present" } {
    const schema = classifyContinuitySchemaV03(this.db);
    if (schema.kind !== "v3-schema") throw new Error("v3 policy requires an exact active schema");
    const rows = preflightContinuityV03Rows(this.db);
    if (rows.kind !== "safe-v3-row-preflight") throw new Error("v3 policy row preflight refused");
    return { workerPair: schema.workerPair };
  }
}
