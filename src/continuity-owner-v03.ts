import type { DatabaseSync } from "node:sqlite";
import {
  CONTINUITY_V03_ACTIVE_DDL,
  CONTINUITY_V03_DDL_FINGERPRINT,
  CONTINUITY_V03_FINGERPRINT_TABLES,
  CONTINUITY_V03_MARKER_DDL,
} from "./continuity-schema-contract-v03.js";
import {
  classifyContinuitySchemaV03,
  type ContinuitySchemaV03Refusal,
} from "./continuity-schema-v03.js";
import { preflightContinuityV03Rows } from "./continuity-v03-row-preflight.js";

/** The exact subset of MemoryStore required by this isolated schema owner. */
export interface ContinuityV03SchemaStore {
  getJournalSqlite(): DatabaseSync;
  isInsideTransaction(): boolean;
  runInImmediateTransaction<T>(operation: () => T): T;
}

export type EnsureContinuitySchemaV03Result =
  | { kind: "created-fresh"; workerPair: "absent"; summaryLedgersPresent: boolean; summaryLedgersValidated: false }
  | { kind: "already-v3"; workerPair: "absent" | "present"; summaryLedgersPresent: boolean; summaryLedgersValidated: false }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal };

export type EnsureContinuityWorkerPairV03Result =
  | { kind: "created-worker-pair"; summaryLedgersPresent: boolean; summaryLedgersValidated: false }
  | { kind: "already-present"; summaryLedgersPresent: boolean; summaryLedgersValidated: false }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal };

const WORKER_PAIR = new Set(["continuity_work", "continuity_handoff"]);
const FRESH_CORE_TABLES = CONTINUITY_V03_FINGERPRINT_TABLES.filter(name => !WORKER_PAIR.has(name));

function refuse(reason: ContinuitySchemaV03Refusal): { kind: "refuse"; reason: ContinuitySchemaV03Refusal } {
  return { kind: "refuse", reason };
}

function requireSafeRows(db: DatabaseSync): ContinuitySchemaV03Refusal | null {
  const rows = preflightContinuityV03Rows(db);
  return rows.kind === "safe-v3-row-preflight" ? null : rows.reason;
}

/**
 * Fresh-only startup owner. It deliberately does not migrate Legacy v2; only
 * the one-shot offline migrator may invoke the reviewed cutover path.
 * Classification, bootstrap, marker insert, and post-write validation all run
 * on the store's same connection under one IMMEDIATE transaction. Summary
 * ledgers are never read/written here; results expose their presence and mark
 * them unvalidated so callers keep body-worker admission separate.
 */
export function ensureContinuitySchemaV03(store: ContinuityV03SchemaStore): EnsureContinuitySchemaV03Result {
  if (store.isInsideTransaction()) return refuse("v3-owner-transaction-failed");
  const db = store.getJournalSqlite();
  try {
    return store.runInImmediateTransaction(() => {
      const initial = classifyContinuitySchemaV03(db);
      if (initial.kind === "refuse") return refuse(initial.reason);
      if (initial.kind === "legacy-v2-schema") return refuse("legacy-v2-offline-authorization-required");
      if (initial.kind === "v3-schema") {
        const unsafe = requireSafeRows(db);
        return unsafe ? refuse(unsafe) : {
          kind: "already-v3", workerPair: initial.workerPair,
          summaryLedgersPresent: initial.summaryLedgersPresent, summaryLedgersValidated: false,
        };
      }

      for (const tableName of FRESH_CORE_TABLES) db.exec(CONTINUITY_V03_ACTIVE_DDL[tableName]);
      db.exec(CONTINUITY_V03_MARKER_DDL);
      db.prepare(`INSERT INTO main.continuity_schema_meta
        (id,marker_format,schema_epoch,origin,legacy_archive_state,ddl_fingerprint) VALUES(1,1,3,'fresh','none',?)`)
        .run(CONTINUITY_V03_DDL_FINGERPRINT);

      const after = classifyContinuitySchemaV03(db);
      if (after.kind !== "v3-schema" || after.origin !== "fresh" || after.workerPair !== "absent") {
        throw new Error("fresh v3 schema postcondition failed");
      }
      const unsafe = requireSafeRows(db);
      if (unsafe) throw new Error(`fresh v3 row preflight failed: ${unsafe}`);
      return {
        kind: "created-fresh", workerPair: "absent",
        summaryLedgersPresent: after.summaryLedgersPresent, summaryLedgersValidated: false,
      };
    });
  } catch {
    // Includes DDL errors and postcondition failures. The store transaction must
    // roll back before this fail-closed result is returned.
    return refuse("v3-owner-transaction-failed");
  }
}

/** Create the optional pair atomically, or accept both exact tables as a no-op. */
export function ensureContinuityWorkerPairV03(store: ContinuityV03SchemaStore): EnsureContinuityWorkerPairV03Result {
  if (store.isInsideTransaction()) return refuse("v3-owner-transaction-failed");
  const db = store.getJournalSqlite();
  try {
    return store.runInImmediateTransaction(() => {
      const current = classifyContinuitySchemaV03(db);
      if (current.kind !== "v3-schema") return refuse(current.kind === "refuse" ? current.reason : "v3-required-table-missing");
      const unsafe = requireSafeRows(db);
      if (unsafe) return refuse(unsafe);
      if (current.workerPair === "present") return {
        kind: "already-present", summaryLedgersPresent: current.summaryLedgersPresent, summaryLedgersValidated: false,
      };

      db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_work);
      db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_handoff);
      const after = classifyContinuitySchemaV03(db);
      if (after.kind !== "v3-schema" || after.workerPair !== "present") {
        throw new Error("v3 worker-pair postcondition failed");
      }
      const afterRows = requireSafeRows(db);
      if (afterRows) throw new Error(`v3 worker-pair row preflight failed: ${afterRows}`);
      return {
        kind: "created-worker-pair", summaryLedgersPresent: after.summaryLedgersPresent, summaryLedgersValidated: false,
      };
    });
  } catch {
    return refuse("v3-owner-transaction-failed");
  }
}
