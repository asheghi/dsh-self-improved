import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { classifyContinuitySchemaV03 } from "./continuity-schema-v03.js";
import {
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03Sha256,
  isSafeContinuityV03SessionId,
} from "./continuity-schema-contract-v03.js";
import {
  parseContinuityV03HandoffPayload,
  parseContinuityV03JobAnchor,
  type ContinuityHandoffV03,
  type ContinuityV03JobAnchor,
} from "./continuity-envelope-v03.js";
import type { CanonicalContinuitySource } from "./continuity-checkpoint-v02.js";
import {
  isContinuityV03JobSourceCurrent,
  type ContinuityV03AncestryQuery,
} from "./continuity-source-v03.js";
import { preflightContinuityV03Rows } from "./continuity-v03-row-preflight.js";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CLAIM_KEYS = ["id", "sessionId", "projectId", "generation", "cut", "sourceHash", "selectedSourceHash",
  "checkpointFormat", "sourceBindingVersion", "lineageFormat", "lineageBindingVersion", "lineageKind", "lineageHash",
  "trigger", "token", "leaseDeadline", "attempts"] as const;

/** Same-store transaction seam required by the v3 owner. This class never owns DDL. */
export interface ContinuityV03WorkOwner {
  getJournalSqlite(): DatabaseSync;
  isInsideTransaction(): boolean;
  runInImmediateTransaction<T>(operation: () => T): T;
}

/** A detached, body-free claim containing every persisted source/version anchor. */
export interface ContinuityV03WorkClaim extends Omit<ContinuityV03JobAnchor, "status"> {
  token: string;
  leaseDeadline: number;
  attempts: number;
}

export interface ContinuityV03CurrentHandoffIdentity {
  job: ContinuityV03JobAnchor;
}
export interface ContinuityV03CurrentHandoff extends ContinuityV03CurrentHandoffIdentity {
  handoff: ContinuityHandoffV03;
}

type WorkRow = {
  id: string; session_id: string; project_id: string; generation_text: string; cut_text: string;
  source_hash: string; checkpoint_format: number; source_binding_version: number; selected_source_hash: string;
  lineage_format: number; lineage_binding_version: number; lineage_kind: string; lineage_hash: string;
  trigger: string; status: string; attempts: number | null;
};
interface ParsedClaim { job: ContinuityV03JobAnchor; token: string; leaseDeadline: number; attempts: number }
interface CurrentHandoffRow {
  id: string; session_id: string; project_id: string; generation_text: string; cut_text: string; source_hash: string;
  checkpoint_format: number; source_binding_version: number; selected_source_hash: string; lineage_format: number;
  lineage_binding_version: number; lineage_kind: string; lineage_hash: string; trigger: string; status: string; payload: string;
}
type CurrentHandoffIdentityRow = Omit<CurrentHandoffRow, "payload">;
export type ContinuityV03FreshSourceReader = (signal: AbortSignal) => Promise<CanonicalContinuitySource>;

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: PropertyDescriptorMap;
  try {
    if (Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value);
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

function exactNotes(value: unknown): string[] | null {
  const wrapper = exactDataRecord(value, ["notes"]);
  if (!wrapper) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  let length: number;
  try {
    if (!Array.isArray(wrapper.notes)) return null;
    length = wrapper.notes.length;
    descriptors = Object.getOwnPropertyDescriptors(wrapper.notes) as unknown as Record<string, PropertyDescriptor>;
  } catch { return null; }
  if (!Number.isSafeInteger(length) || length > 3) return null;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || !Object.hasOwn(descriptors, "length")
    || keys.some(key => typeof key !== "string")) return null;
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")
      || typeof descriptor.value !== "string" || descriptor.value.length > 280) return null;
    result.push(descriptor.value);
  }
  if (keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
    || Number(key) >= length))) return null;
  return result;
}

function jobRowForSource(job: ContinuityV03JobAnchor): unknown {
  return {
    id: job.id, session_id: job.sessionId, project_id: job.projectId,
    generation_text: String(job.generation), cut_text: String(job.cut), source_hash: job.sourceHash,
    checkpoint_format: job.checkpointFormat, source_binding_version: job.sourceBindingVersion,
    selected_source_hash: job.selectedSourceHash, lineage_format: job.lineageFormat,
    lineage_binding_version: job.lineageBindingVersion, lineage_kind: job.lineageKind,
    lineage_hash: job.lineageHash, trigger: job.trigger, status: job.status,
  };
}

function sampleClock(clock: () => number): number | null {
  let now: number;
  try { now = clock(); } catch { return null; }
  return Number.isSafeInteger(now) && now >= 0 ? now : null;
}

function parseClaim(value: unknown): ParsedClaim | null {
  const row = exactDataRecord(value, CLAIM_KEYS);
  if (!row || typeof row.id !== "string" || !UUID.test(row.id)
    || !isSafeContinuityV03SessionId(row.sessionId) || !isSafeContinuityV03ProjectId(row.projectId)
    || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0
    || typeof row.cut !== "number" || !Number.isSafeInteger(row.cut) || row.cut < -1
    || !isSafeContinuityV03Sha256(row.sourceHash) || !isSafeContinuityV03Sha256(row.selectedSourceHash)
    || !isSafeContinuityV03Sha256(row.lineageHash) || typeof row.lineageKind !== "string"
    || typeof row.token !== "string" || !UUID.test(row.token)
    || typeof row.leaseDeadline !== "number" || !Number.isSafeInteger(row.leaseDeadline) || row.leaseDeadline < 0
    || typeof row.attempts !== "number" || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.attempts > 3) return null;

  const job = parseContinuityV03JobAnchor({
    id: row.id, session_id: row.sessionId, project_id: row.projectId,
    generation_text: String(row.generation), cut_text: String(row.cut), source_hash: row.sourceHash,
    checkpoint_format: row.checkpointFormat, source_binding_version: row.sourceBindingVersion,
    selected_source_hash: row.selectedSourceHash, lineage_format: row.lineageFormat,
    lineage_binding_version: row.lineageBindingVersion, lineage_kind: row.lineageKind,
    lineage_hash: row.lineageHash, trigger: row.trigger, status: "pending",
  });
  return job ? { job, token: row.token, leaseDeadline: row.leaseDeadline, attempts: row.attempts } : null;
}

function jobRowForParser(row: WorkRow): unknown {
  return {
    id: row.id, session_id: row.session_id, project_id: row.project_id,
    generation_text: row.generation_text, cut_text: row.cut_text, source_hash: row.source_hash,
    checkpoint_format: row.checkpoint_format, source_binding_version: row.source_binding_version,
    selected_source_hash: row.selected_source_hash, lineage_format: row.lineage_format,
    lineage_binding_version: row.lineage_binding_version, lineage_kind: row.lineage_kind,
    lineage_hash: row.lineage_hash, trigger: row.trigger, status: row.status,
  };
}

/**
 * DDL-free active v3 work ledger. Construction assumes the schema owner already
 * created the inseparable worker pair; each mutating/currentness operation then
 * reclassifies and structurally preflights inside the same store transaction.
 * Source freshness itself is asynchronous and remains a separate verifier.
 */
export class ContinuityWorkV03 {
  private readonly db: DatabaseSync;

  constructor(private readonly owner: ContinuityV03WorkOwner) {
    this.db = owner.getJournalSqlite();
  }

  /** Claim one eligible job on the same SQLite writer as its policy and lease. Expired attempt-exhausted rows are terminalized in a bounded pass; call hasEligibleWork after null to detect remaining backlog. */
  claim(projectId: string, now: number, ttl: number, jobId?: string): ContinuityV03WorkClaim | null {
    if (!isSafeContinuityV03ProjectId(projectId) || !Number.isSafeInteger(now) || now < 0
      || (jobId !== undefined && (typeof jobId !== "string" || !UUID.test(jobId)))
      || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 60_000 || !Number.isSafeInteger(now + ttl)) {
      throw new Error("invalid v3 continuity lease coordinates");
    }
    return this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      for (let scanned = 0; scanned < 100; scanned++) {
        const row = this.db.prepare(`SELECT j.id,j.session_id,j.project_id,CAST(j.generation AS TEXT) AS generation_text,
            CAST(j.cut AS TEXT) AS cut_text,j.source_hash,j.checkpoint_format,j.source_binding_version,
            j.selected_source_hash,j.lineage_format,j.lineage_binding_version,j.lineage_kind,j.lineage_hash,
            j.trigger,j.status,w.attempts
          FROM main.continuity_jobs j
          JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id
            AND p.generation=j.generation AND p.allowed=1
          JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id
            AND c.generation=j.generation AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind
          LEFT JOIN main.continuity_work w ON w.job_id=j.id
          WHERE j.project_id=? AND j.status='pending' AND (? IS NULL OR j.id=?)
            AND (w.job_id IS NULL OR (w.status='running' AND w.lease_deadline<=?))
          ORDER BY j.cut,j.id LIMIT 1`).get(projectId, jobId ?? null, jobId ?? null, now) as WorkRow | undefined;
        if (!row) return null;
        const job = parseContinuityV03JobAnchor(jobRowForParser(row));
        if (!job || job.status !== "pending" || ![null, 1, 2, 3].includes(row.attempts)) {
          throw new Error("unsafe v3 work candidate");
        }
        if (row.attempts === 3) {
          const changed = this.db.prepare(`UPDATE main.continuity_work SET status='failed'
            WHERE job_id=? AND status='running' AND lease_deadline<=? AND attempts=3`).run(job.id, now).changes;
          if (Number(changed) !== 1) throw new Error("v3 expired work row changed during claim");
          continue;
        }
        const attempts = (row.attempts ?? 0) + 1;
        const token = randomUUID();
        const leaseDeadline = now + ttl;
        if (row.attempts === null) {
          this.db.prepare(`INSERT INTO main.continuity_work(job_id,token,lease_deadline,attempts,status)
            VALUES(?,?,?,?,'running')`).run(job.id, token, leaseDeadline, attempts);
        } else {
          const changed = this.db.prepare(`UPDATE main.continuity_work SET token=?,lease_deadline=?,attempts=?,status='running'
            WHERE job_id=? AND status='running' AND lease_deadline<=? AND attempts=?`).run(
            token, leaseDeadline, attempts, job.id, now, row.attempts).changes;
          if (Number(changed) !== 1) throw new Error("v3 expired lease changed during claim");
        }
        const { status: _status, ...anchors } = job;
        return { ...anchors, token, leaseDeadline, attempts };
      }
      return null;
    });
  }

  /** True after a bounded claim pass when another queued or expired lease still needs processing. */
  hasEligibleWork(projectId: string, now: number): boolean {
    if (!isSafeContinuityV03ProjectId(projectId) || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("invalid v3 continuity work coordinates");
    }
    return this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      return this.db.prepare(`SELECT 1 FROM main.continuity_jobs j
        JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id
          AND p.generation=j.generation AND p.allowed=1
        JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id
          AND c.generation=j.generation AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind
        LEFT JOIN main.continuity_work w ON w.job_id=j.id
        WHERE j.project_id=? AND j.status='pending'
          AND (w.job_id IS NULL OR (w.status='running' AND w.lease_deadline<=?)) LIMIT 1`).get(projectId, now) !== undefined;
    });
  }

  /**
   * Read one currently admitted completed handoff by its exact project/job.
   * This is persisted-data access only: it proves neither native source freshness,
   * target/ancestor policy, operator intent, nor permission to display or continue.
   * A preview caller must apply those independent gates before exposing notes.
   */
  readCurrentHandoffRecord(projectId: string, jobId: string): ContinuityV03CurrentHandoff | null {
    if (!isSafeContinuityV03ProjectId(projectId) || typeof jobId !== "string" || !UUID.test(jobId)) {
      throw new Error("invalid v3 continuity handoff ownership");
    }
    return this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      const row = this.db.prepare(`SELECT j.id,j.session_id,j.project_id,CAST(j.generation AS TEXT) AS generation_text,
        CAST(j.cut AS TEXT) AS cut_text,j.source_hash,j.checkpoint_format,j.source_binding_version,
        j.selected_source_hash,j.lineage_format,j.lineage_binding_version,j.lineage_kind,j.lineage_hash,j.trigger,j.status,
        h.payload
        FROM main.continuity_jobs j
        JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id
          AND p.generation=j.generation AND p.allowed=1
        JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id
          AND c.generation=j.generation AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind
        JOIN main.continuity_work w ON w.job_id=j.id AND w.status='completed'
        JOIN main.continuity_handoff h ON h.job_id=j.id AND h.session_id=j.session_id AND h.project_id=j.project_id
          AND h.generation=j.generation AND h.cut=j.cut AND h.source_hash=j.source_hash
          AND h.checkpoint_format=j.checkpoint_format AND h.source_binding_version=j.source_binding_version
          AND h.selected_source_hash=j.selected_source_hash AND h.lineage_format=j.lineage_format
          AND h.lineage_binding_version=j.lineage_binding_version AND h.lineage_kind=j.lineage_kind
          AND h.lineage_hash=j.lineage_hash
        WHERE j.project_id=? AND j.id=? AND j.status='pending'`).get(projectId, jobId) as CurrentHandoffRow | undefined;
      if (!row) return null;
      const job = parseContinuityV03JobAnchor({
        id: row.id, session_id: row.session_id, project_id: row.project_id, generation_text: row.generation_text,
        cut_text: row.cut_text, source_hash: row.source_hash, checkpoint_format: row.checkpoint_format,
        source_binding_version: row.source_binding_version, selected_source_hash: row.selected_source_hash,
        lineage_format: row.lineage_format, lineage_binding_version: row.lineage_binding_version,
        lineage_kind: row.lineage_kind, lineage_hash: row.lineage_hash, trigger: row.trigger, status: row.status,
      });
      if (!job || job.projectId !== projectId || job.id !== jobId) throw new Error("unsafe v3 current handoff anchor");
      const payload = parseContinuityV03HandoffPayload(row.payload, job);
      if (!payload) throw new Error("unsafe v3 current handoff payload");
      return { job, handoff: payload };
    });
  }

  /**
   * Read only the current body-free job identity, never the handoff payload.
   * This lets a preview authorize the selected source before loading its notes.
   */
  readCurrentHandoffIdentity(projectId: string, jobId: string): ContinuityV03CurrentHandoffIdentity | null {
    if (!isSafeContinuityV03ProjectId(projectId) || typeof jobId !== "string" || !UUID.test(jobId)) {
      throw new Error("invalid v3 continuity handoff ownership");
    }
    return this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      const row = this.db.prepare(`SELECT j.id,j.session_id,j.project_id,CAST(j.generation AS TEXT) AS generation_text,
        CAST(j.cut AS TEXT) AS cut_text,j.source_hash,j.checkpoint_format,j.source_binding_version,
        j.selected_source_hash,j.lineage_format,j.lineage_binding_version,j.lineage_kind,j.lineage_hash,j.trigger,j.status
        FROM main.continuity_jobs j
        JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id
          AND p.generation=j.generation AND p.allowed=1
        JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id
          AND c.generation=j.generation AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind
        JOIN main.continuity_work w ON w.job_id=j.id AND w.status='completed'
        JOIN main.continuity_handoff h ON h.job_id=j.id AND h.session_id=j.session_id AND h.project_id=j.project_id
          AND h.generation=j.generation AND h.cut=j.cut AND h.source_hash=j.source_hash
          AND h.checkpoint_format=j.checkpoint_format AND h.source_binding_version=j.source_binding_version
          AND h.selected_source_hash=j.selected_source_hash AND h.lineage_format=j.lineage_format
          AND h.lineage_binding_version=j.lineage_binding_version AND h.lineage_kind=j.lineage_kind
          AND h.lineage_hash=j.lineage_hash
        WHERE j.project_id=? AND j.id=? AND j.status='pending'`).get(projectId, jobId) as CurrentHandoffIdentityRow | undefined;
      if (!row) return null;
      const job = parseContinuityV03JobAnchor({
        id: row.id, session_id: row.session_id, project_id: row.project_id, generation_text: row.generation_text,
        cut_text: row.cut_text, source_hash: row.source_hash, checkpoint_format: row.checkpoint_format,
        source_binding_version: row.source_binding_version, selected_source_hash: row.selected_source_hash,
        lineage_format: row.lineage_format, lineage_binding_version: row.lineage_binding_version,
        lineage_kind: row.lineage_kind, lineage_hash: row.lineage_hash, trigger: row.trigger, status: row.status,
      });
      if (!job || job.projectId !== projectId || job.id !== jobId) throw new Error("unsafe v3 current handoff identity");
      return { job };
    });
  }

  /** Convenience projection for callers that need only the detached payload. */
  readCurrentHandoff(projectId: string, jobId: string): ContinuityHandoffV03 | null {
    return this.readCurrentHandoffRecord(projectId, jobId)?.handoff ?? null;
  }

  /** Point-in-time SQLite policy/job/checkpoint/lease fence; no native source or permission proof. */
  isCurrent(value: unknown, now: number): boolean {
    const parsed = parseClaim(value);
    if (!parsed || !Number.isSafeInteger(now) || now < 0 || parsed.leaseDeadline <= now) return false;
    try {
      return this.owner.runInImmediateTransaction(() => {
        this.assertReady();
        return this.isCurrentInTransaction(parsed, now);
      });
    } catch { return false; }
  }

  /**
   * Combine the SQL lease/policy gate with a fresh native child-to-root source
   * check, then repeat the SQL gate after the asynchronous read. Call before
   * provider work; user intent and cancellation ownership remain external.
   */
  async isCurrentWithFreshSource(
    query: ContinuityV03AncestryQuery,
    readFreshSource: ContinuityV03FreshSourceReader,
    value: unknown,
    clock: () => number,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    this.assertNoOpenTransactionForAsyncSource();
    const claim = parseClaim(value);
    if (!claim || typeof readFreshSource !== "function" || typeof clock !== "function"
      || !this.isCurrentWithClock(claim, clock)) return false;
    let source: CanonicalContinuitySource;
    try { source = await readFreshSource(signal); }
    catch { signal.throwIfAborted(); return false; }
    signal.throwIfAborted();
    const sourceCurrent = await isContinuityV03JobSourceCurrent(query, source, jobRowForSource(claim.job), signal);
    signal.throwIfAborted();
    return sourceCurrent && this.isCurrentWithClock(claim, clock);
  }

  /**
   * Final post-generation gate: refresh native source, then in one immediate
   * transaction recheck policy/job/checkpoint/token/deadline, insert the strict
   * body-free handoff, and mark work completed. It grants no Continue authority.
   */
  async completeWithFreshSource(
    query: ContinuityV03AncestryQuery,
    readFreshSource: ContinuityV03FreshSourceReader,
    value: unknown,
    clock: () => number,
    notesValue: unknown,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    this.assertNoOpenTransactionForAsyncSource();
    const claim = parseClaim(value);
    const notes = exactNotes(notesValue);
    if (!claim || !notes || typeof readFreshSource !== "function" || typeof clock !== "function") return false;
    if (!await this.isCurrentWithFreshSource(query, readFreshSource, value, clock, signal)) return false;
    signal.throwIfAborted();
    return this.owner.runInImmediateTransaction(() => {
      this.assertReady();
      const now = sampleClock(clock);
      if (now === null || claim.leaseDeadline <= now || !this.isCurrentInTransaction(claim, now)) return false;
      const job = claim.job;
      const candidate: ContinuityHandoffV03 = {
        jobId: job.id, sessionId: job.sessionId, projectId: job.projectId, generation: job.generation,
        cut: job.cut, sourceHash: job.sourceHash, selectedSourceHash: job.selectedSourceHash,
        checkpointFormat: job.checkpointFormat, sourceBindingVersion: job.sourceBindingVersion,
        lineageFormat: job.lineageFormat, lineageBindingVersion: job.lineageBindingVersion,
        lineageKind: job.lineageKind, lineageHash: job.lineageHash, notes, uncertain: true,
      };
      const payloadText = JSON.stringify(candidate);
      const payload = parseContinuityV03HandoffPayload(payloadText, job);
      if (!payload) return false;
      this.db.prepare(`INSERT INTO main.continuity_handoff(job_id,session_id,project_id,generation,cut,source_hash,
        checkpoint_format,source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,
        lineage_kind,lineage_hash,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        payload.jobId, payload.sessionId, payload.projectId, payload.generation, payload.cut, payload.sourceHash,
        payload.checkpointFormat, payload.sourceBindingVersion, payload.selectedSourceHash, payload.lineageFormat,
        payload.lineageBindingVersion, payload.lineageKind, payload.lineageHash, payloadText);
      const changed = this.db.prepare(`UPDATE main.continuity_work SET status='completed'
        WHERE job_id=? AND token=? AND status='running' AND lease_deadline=? AND lease_deadline>? AND attempts=?
          AND EXISTS(SELECT 1 FROM main.continuity_jobs j
            JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id
              AND p.generation=j.generation AND p.allowed=1
            JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id
              AND c.generation=j.generation AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind
            WHERE j.id=continuity_work.job_id AND j.status='pending' AND j.id=? AND j.session_id=?
              AND j.project_id=? AND j.generation=? AND j.cut=? AND j.source_hash=? AND j.selected_source_hash=?
              AND j.checkpoint_format=? AND j.source_binding_version=? AND j.lineage_format=?
              AND j.lineage_binding_version=? AND j.lineage_kind=? AND j.lineage_hash=? AND j.trigger=?)`).run(
        job.id, claim.token, claim.leaseDeadline, now, claim.attempts, job.id, job.sessionId, job.projectId,
        job.generation, job.cut, job.sourceHash, job.selectedSourceHash, job.checkpointFormat, job.sourceBindingVersion,
        job.lineageFormat, job.lineageBindingVersion, job.lineageKind, job.lineageHash, job.trigger).changes;
      if (Number(changed) !== 1) throw new Error("v3 handoff completion fence changed");
      return true;
    });
  }

  /** Mark failed work only while every original DB anchor and live lease still match. */
  fail(value: unknown, now: number): boolean {
    const parsed = parseClaim(value);
    if (!parsed || !Number.isSafeInteger(now) || now < 0 || parsed.leaseDeadline <= now) return false;
    try {
      return this.owner.runInImmediateTransaction(() => {
        this.assertReady();
        if (!this.isCurrentInTransaction(parsed, now)) return false;
        const changed = this.db.prepare(`UPDATE main.continuity_work SET status='failed'
          WHERE job_id=? AND token=? AND status='running' AND lease_deadline=? AND lease_deadline>?
            AND attempts=?`).run(parsed.job.id, parsed.token, parsed.leaseDeadline, now, parsed.attempts).changes;
        return Number(changed) === 1;
      });
    } catch { return false; }
  }

  private assertNoOpenTransactionForAsyncSource(): void {
    if (this.owner.isInsideTransaction()) {
      throw new Error("v3 native source revalidation cannot await inside a store transaction");
    }
  }

  private isCurrentWithClock(claim: ParsedClaim, clock: () => number): boolean {
    try {
      return this.owner.runInImmediateTransaction(() => {
        this.assertReady();
        const now = sampleClock(clock);
        return now !== null && claim.leaseDeadline > now && this.isCurrentInTransaction(claim, now);
      });
    } catch { return false; }
  }

  private assertReady(): void {
    const schema = classifyContinuitySchemaV03(this.db);
    if (schema.kind !== "v3-schema" || schema.workerPair !== "present") {
      throw new Error("v3 work requires an exact active schema and worker pair");
    }
    const rows = preflightContinuityV03Rows(this.db);
    if (rows.kind !== "safe-v3-row-preflight") throw new Error("v3 work row preflight refused");
  }

  private isCurrentInTransaction(claim: ParsedClaim, now: number): boolean {
    const job = claim.job;
    return this.db.prepare(`SELECT 1 FROM main.continuity_work w
      JOIN main.continuity_jobs j ON j.id=w.job_id
      JOIN main.continuity_policy p ON p.session_id=j.session_id AND p.project_id=j.project_id
        AND p.generation=j.generation AND p.allowed=1
      JOIN main.continuity_checkpoint c ON c.session_id=j.session_id AND c.project_id=j.project_id
        AND c.generation=j.generation AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind
      WHERE w.job_id=? AND w.token=? AND w.status='running' AND w.lease_deadline=? AND w.lease_deadline>?
        AND w.attempts=? AND j.status='pending' AND j.id=? AND j.session_id=? AND j.project_id=?
        AND j.generation=? AND j.cut=? AND j.source_hash=? AND j.selected_source_hash=?
        AND j.checkpoint_format=? AND j.source_binding_version=? AND j.lineage_format=?
        AND j.lineage_binding_version=? AND j.lineage_kind=? AND j.lineage_hash=? AND j.trigger=?
        AND p.session_id=j.session_id AND p.project_id=j.project_id AND p.generation=j.generation AND p.allowed=1
        AND c.session_id=j.session_id AND c.project_id=j.project_id AND c.generation=j.generation
        AND c.cut>=j.cut AND c.lineage_kind=j.lineage_kind`).get(
      job.id, claim.token, claim.leaseDeadline, now, claim.attempts, job.id, job.sessionId, job.projectId,
      job.generation, job.cut, job.sourceHash, job.selectedSourceHash, job.checkpointFormat, job.sourceBindingVersion,
      job.lineageFormat, job.lineageBindingVersion, job.lineageKind, job.lineageHash, job.trigger) !== undefined;
  }
}
