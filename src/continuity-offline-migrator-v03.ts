import type { DatabaseSync } from "node:sqlite";
import type * as Zod from "zod";
import { isAbsolute, join, parse as parsePath, resolve } from "node:path";
import type { ContinuityV03SchemaStore } from "./continuity-owner-v03.js";
import {
  CONTINUITY_V03_ACTIVE_DDL,
  CONTINUITY_V03_DDL_FINGERPRINT,
  CONTINUITY_V03_LEGACY_ARCHIVE_DDL,
  CONTINUITY_V03_MARKER_DDL,
} from "./continuity-schema-contract-v03.js";
import { classifyContinuitySchemaV03, type ContinuitySchemaV03Refusal } from "./continuity-schema-v03.js";
import { preflightContinuityV2RowsV03, preflightContinuityV03Rows } from "./continuity-v03-row-preflight.js";

const OFFLINE_APPROVED = "--offline-approved";
const EXCLUSIVE_OWNER_CONFIRMED = "--exclusive-owner-confirmed";
const BACKUP_CONFIRMED = "--backup-confirmed";
const STORE_ROOT = "--store-root";
const OFFLINE_V03_CAPABILITY: unique symbol = Symbol("continuity-v03-offline-cutover");
const consumedAuthorizations = new WeakSet<object>();

export interface ContinuityV03OfflineAuthorization {
  readonly [OFFLINE_V03_CAPABILITY]: true;
  readonly storeRoot: string;
}

export type ConsumeContinuityV03AuthorizationResult =
  | { kind: "authorized"; authorization: ContinuityV03OfflineAuthorization }
  | { kind: "refuse"; reason: "offline-authorization-required" | "offline-authorization-invalid" };

export interface ContinuityV03OfflinePathStat {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ContinuityV03OfflinePathOps {
  realpath(path: string): string;
  stat(path: string): ContinuityV03OfflinePathStat;
  lstat(path: string): ContinuityV03OfflinePathStat;
}

export type ValidateContinuityV03OfflineTargetResult =
  | { kind: "valid-target"; storeRoot: string }
  | { kind: "refuse"; reason: "offline-store-target-invalid" };

export type ContinuityV03OfflineMigrationResult =
  | {
      kind: "migrated-v2";
      archiveState: "jobs-only" | "jobs-and-handoffs";
      counts: { policies: number; jobs: number; handoffs: number };
      summaryLedgersPresent: boolean;
      summaryLedgersValidated: false;
    }
  | {
      kind: "already-v3";
      origin: "fresh" | "v2-cutover";
      legacyArchiveState: "none" | "jobs-only" | "jobs-and-handoffs" | "purged";
      summaryLedgersPresent: boolean;
      summaryLedgersValidated: false;
    }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal | "offline-store-open-failed" | "offline-authorization-invalid" };

export interface ContinuityV03OfflineStore extends ContinuityV03SchemaStore {
  close(): void;
}

/**
 * Parse and consume the exact one-shot launcher arguments before any store
 * factory is invoked. Confirmation flags are operator assertions, not a claim
 * that the process can detect other Hosts or make a backup for the operator.
 */
export function consumeContinuityV03OfflineAuthorization(args: string[]): ConsumeContinuityV03AuthorizationResult {
  if (!Array.isArray(args) || args.some(argument => typeof argument !== "string")) {
    return { kind: "refuse", reason: "offline-authorization-invalid" };
  }
  if (!args.includes(OFFLINE_APPROVED)) return { kind: "refuse", reason: "offline-authorization-required" };
  let approved = 0, exclusive = 0, backup = 0, root: string | null = null;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (argument === OFFLINE_APPROVED) { approved++; continue; }
    if (argument === EXCLUSIVE_OWNER_CONFIRMED) { exclusive++; continue; }
    if (argument === BACKUP_CONFIRMED) { backup++; continue; }
    if (argument === STORE_ROOT) {
      if (root !== null || index + 1 >= args.length) return { kind: "refuse", reason: "offline-authorization-invalid" };
      root = args[++index]!;
      continue;
    }
    return { kind: "refuse", reason: "offline-authorization-invalid" };
  }
  if (approved !== 1 || exclusive !== 1 || backup !== 1 || typeof root !== "string" || !root || root.includes(String.fromCharCode(0))
    || !isAbsolute(root) || resolve(root) === parsePath(root).root) {
    return { kind: "refuse", reason: "offline-authorization-invalid" };
  }
  const authorization = Object.freeze({ [OFFLINE_V03_CAPABILITY]: true as const, storeRoot: resolve(root) });
  // Remove all grants and the target from the caller-owned argv array. The
  // capability is consumed again by runContinuityV03OfflineMigration.
  args.splice(0, args.length);
  return { kind: "authorized", authorization };
}

/** Validate the canonical root and existing database entry without opening it. */
export function validateContinuityV03OfflineStoreTarget(
  requestedRoot: string,
  pathOps: ContinuityV03OfflinePathOps,
): ValidateContinuityV03OfflineTargetResult {
  try {
    const storeRoot = resolve(pathOps.realpath(requestedRoot));
    if (storeRoot === parsePath(storeRoot).root || !pathOps.stat(storeRoot).isDirectory()) {
      return { kind: "refuse", reason: "offline-store-target-invalid" };
    }
    const databaseStat = pathOps.lstat(join(storeRoot, "memory.db"));
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      return { kind: "refuse", reason: "offline-store-target-invalid" };
    }
    return { kind: "valid-target", storeRoot };
  } catch {
    return { kind: "refuse", reason: "offline-store-target-invalid" };
  }
}

function refuse(reason: ContinuitySchemaV03Refusal | "offline-store-open-failed" | "offline-authorization-invalid"):
  ContinuityV03OfflineMigrationResult {
  return { kind: "refuse", reason };
}

function migrateLegacyV2(store: ContinuityV03OfflineStore, z: typeof Zod): ContinuityV03OfflineMigrationResult {
  try {
    if (store.isInsideTransaction()) return refuse("v3-owner-transaction-failed");
    const db: DatabaseSync = store.getJournalSqlite();
    return store.runInImmediateTransaction(() => {
      const schema = classifyContinuitySchemaV03(db);
      if (schema.kind === "refuse") return refuse(schema.reason);
      if (schema.kind === "v3-schema") {
        const rows = preflightContinuityV03Rows(db);
        if (rows.kind === "refuse") return refuse(rows.reason);
        return {
          kind: "already-v3", origin: schema.origin, legacyArchiveState: schema.legacyArchiveState,
          summaryLedgersPresent: schema.summaryLedgersPresent, summaryLedgersValidated: false,
        };
      }
      if (schema.kind !== "legacy-v2-schema") return refuse("not-exact-legacy-v2-schema");

      // Complete all exact schema/row validation before the first continuity
      // write; this includes rows that will be discarded or archived.
      const preflight = preflightContinuityV2RowsV03(db, z);
      if (preflight.kind === "refuse") return refuse(preflight.reason);
      const archiveState = schema.workerPair === "present" ? "jobs-and-handoffs" : "jobs-only";
      const policyBefore = db.prepare(`SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text
        FROM main.continuity_policy`).all() as Array<{ session_id: string; project_id: string; generation_text: string }>;

      // Revoke every old grant exactly once, fence pending jobs, and then make
      // inert v2 copies. Work/lease state is intentionally never archived.
      db.exec("UPDATE main.continuity_policy SET allowed=0,generation=generation+1");
      db.exec("UPDATE main.continuity_jobs SET status='cancelled' WHERE status='pending'");
      db.exec(CONTINUITY_V03_LEGACY_ARCHIVE_DDL.continuity_jobs_legacy_v2);
      db.exec(`INSERT INTO main.continuity_jobs_legacy_v2(id,session_id,project_id,generation,cut,source_hash,trigger,status)
        SELECT id,session_id,project_id,generation,cut,source_hash,trigger,status FROM main.continuity_jobs`);
      if (schema.workerPair === "present") {
        db.exec(CONTINUITY_V03_LEGACY_ARCHIVE_DDL.continuity_handoff_legacy_v2);
        db.exec(`INSERT INTO main.continuity_handoff_legacy_v2(job_id,session_id,project_id,generation,cut,source_hash,payload)
          SELECT job_id,session_id,project_id,generation,cut,source_hash,payload FROM main.continuity_handoff`);
      }

      db.exec("DELETE FROM main.continuity_checkpoint");
      db.exec("DROP TABLE main.continuity_checkpoint");
      db.exec("DROP TABLE main.continuity_jobs");
      if (schema.workerPair === "present") {
        db.exec("DROP TABLE main.continuity_work");
        db.exec("DROP TABLE main.continuity_handoff");
      }
      db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_checkpoint);
      db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_jobs);
      db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_v3_human_boundary);
      db.exec(CONTINUITY_V03_MARKER_DDL);
      db.prepare(`INSERT INTO main.continuity_schema_meta
        (id,marker_format,schema_epoch,origin,legacy_archive_state,ddl_fingerprint) VALUES(1,1,3,'v2-cutover',?,?)`)
        .run(archiveState, CONTINUITY_V03_DDL_FINGERPRINT);

      const after = classifyContinuitySchemaV03(db);
      if (after.kind !== "v3-schema" || after.origin !== "v2-cutover" || after.legacyArchiveState !== archiveState || after.workerPair !== "absent") {
        throw new Error("v3 cutover schema postcondition failed");
      }
      const rowCheck = preflightContinuityV03Rows(db);
      if (rowCheck.kind === "refuse") throw new Error(`v3 cutover row postcondition failed: ${rowCheck.reason}`);
      const policyAfter = db.prepare(`SELECT session_id,project_id,CAST(generation AS TEXT) AS generation_text,allowed
        FROM main.continuity_policy`).all() as Array<{ session_id: string; project_id: string; generation_text: string; allowed: number }>;
      const policyAfterBySession = new Map(policyAfter.map(row => [row.session_id, row]));
      if (policyAfter.length !== policyBefore.length || policyBefore.some(row => {
        const current = policyAfterBySession.get(row.session_id);
        return !current || current.project_id !== row.project_id || current.allowed !== 0
          || BigInt(current.generation_text) !== BigInt(row.generation_text) + 1n;
      })) throw new Error("v3 cutover policy revocation postcondition failed");
      if (rowCheck.counts.archivedJobs !== preflight.counts.jobs
        || rowCheck.counts.archivedHandoffs !== preflight.counts.handoffs
        || rowCheck.counts.policies !== preflight.counts.policies) {
        throw new Error("v3 cutover row counts changed");
      }
      return {
        kind: "migrated-v2", archiveState,
        counts: { policies: preflight.counts.policies, jobs: preflight.counts.jobs, handoffs: preflight.counts.handoffs },
        summaryLedgersPresent: schema.summaryLedgersPresent, summaryLedgersValidated: false,
      };
    });
  } catch {
    return refuse("v3-owner-transaction-failed");
  }
}

/** Run exactly once with a parsed launcher capability; always close the sole store. */
export function runContinuityV03OfflineMigration(
  authorization: ContinuityV03OfflineAuthorization,
  openStore: (storeRoot: string) => ContinuityV03OfflineStore,
  z: typeof Zod,
): ContinuityV03OfflineMigrationResult {
  if (!authorization || typeof authorization !== "object" || authorization[OFFLINE_V03_CAPABILITY] !== true
    || consumedAuthorizations.has(authorization)) return refuse("offline-authorization-invalid");
  consumedAuthorizations.add(authorization);
  let store: ContinuityV03OfflineStore;
  try { store = openStore(authorization.storeRoot); } catch { return refuse("offline-store-open-failed"); }
  try { return migrateLegacyV2(store, z); }
  finally { store.close(); }
}
