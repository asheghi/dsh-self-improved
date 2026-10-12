import type { DatabaseSync } from "node:sqlite";
import {
  matchesContinuityV02Schema,
  normalizeContinuityDdl,
  type ContinuityV02Table,
} from "./continuity-store-v02.js";
import { CONTINUITY_WORK_V02_DDL } from "./continuity-work-v02.js";
import { CONTINUITY_HANDOFF_V02_DDL } from "./continuity-handoff-v02.js";
import {
  CONTINUITY_V03_ACTIVE_DDL,
  CONTINUITY_V03_DDL_FINGERPRINT,
  CONTINUITY_V03_LEGACY_ARCHIVE_DDL,
  CONTINUITY_V03_MARKER_DDL,
} from "./continuity-schema-contract-v03.js";

/**
 * Read-only first-stage schema classification for the planned v3 lane.
 *
 * This recognizes Empty and exact v2 namespaces, and exact v3 active/marker
 * plus archive-sidecar DDL/state combinations. It remains read-only; v3 active
 * and retained-archive row validation are separate owner gates, and the actual
 * v2 cutover is available only through the offline migrator. Every attached schema is inspected
 * and any attached continuity object refuses. This classifier is not itself the
 * migration owner and must not perform schema/data writes.
 */
export type ContinuitySchemaV03Classification =
  | { kind: "empty"; summaryLedgersPresent: boolean }
  | { kind: "legacy-v2-schema"; workerPair: "absent" | "present"; summaryLedgersPresent: boolean }
  | { kind: "v3-schema"; workerPair: "absent" | "present"; origin: "fresh" | "v2-cutover"; legacyArchiveState: "none" | "jobs-only" | "jobs-and-handoffs" | "purged"; summaryLedgersPresent: boolean }
  | { kind: "refuse"; reason: ContinuitySchemaV03Refusal };

export type ContinuitySchemaV03Refusal =
  | "temp-continuity-object"
  | "unknown-or-attached-object"
  | "noncanonical-object-name"
  | "partial-v2-core"
  | "v2-core-schema-mismatch"
  | "split-v2-worker-pair"
  | "v2-worker-schema-mismatch"
  | "summary-index-mismatch"
  | "legacy-sidecar-present"
  | "not-exact-legacy-v2-schema"
  | "unsafe-v2-policy-row"
  | "unsafe-v2-job-row"
  | "unsafe-v2-work-row"
  | "unsafe-v2-handoff-row"
  | "unsafe-v2-handoff-payload"
  | "unsafe-v2-checkpoint-row"
  | "unsafe-v2-checkpoint-envelope"
  | "v3-required-table-missing"
  | "v3-active-schema-mismatch"
  | "v3-marker-invalid"
  | "v3-archive-schema-mismatch"
  | "unsafe-v2-archive-job-row"
  | "unsafe-v2-archive-handoff-row"
  | "unsafe-v2-archive-handoff-payload"
  | "v3-row-validation-not-finalized"
  | "legacy-v2-offline-authorization-required"
  | "v3-owner-transaction-failed"
  | "unsafe-v3-policy-row"
  | "unsafe-v3-boundary-row"
  | "unsafe-v3-checkpoint-row"
  | "unsafe-v3-checkpoint-envelope"
  | "unsafe-v3-job-row"
  | "unsafe-v3-work-row"
  | "unsafe-v3-handoff-row"
  | "unsafe-v3-handoff-payload"
  | "unsafe-v3-row";

const V2_CORE = ["continuity_policy", "continuity_checkpoint", "continuity_jobs"] as const;
const V2_WORKER_PAIR = ["continuity_work", "continuity_handoff"] as const;
const SUMMARY_TABLES = ["continuity_summary_policy", "continuity_summary_human"] as const;
const V3_TABLES = ["continuity_schema_meta", "continuity_v3_human_boundary"] as const;
const LEGACY_SIDECARS = ["continuity_jobs_legacy_v2", "continuity_handoff_legacy_v2"] as const;
const RECOGNIZED_TABLES = new Set<string>([
  ...V2_CORE,
  ...V2_WORKER_PAIR,
  ...SUMMARY_TABLES,
  ...V3_TABLES,
  ...LEGACY_SIDECARS,
]);

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}
interface ColumnShape { name: string; type: string; pk: number }
interface IndexShape { unique: number; origin: string; partial: number }

const V2_AUX_SCHEMA: Record<"continuity_work" | "continuity_handoff", {
  ddl: string;
  columns: readonly ColumnShape[];
  indexOrigins: readonly string[];
}> = {
  continuity_work: {
    ddl: CONTINUITY_WORK_V02_DDL,
    columns: [
      { name: "job_id", type: "TEXT", pk: 1 },
      { name: "token", type: "TEXT", pk: 0 },
      { name: "lease_deadline", type: "INTEGER", pk: 0 },
      { name: "attempts", type: "INTEGER", pk: 0 },
      { name: "status", type: "TEXT", pk: 0 },
    ],
    indexOrigins: ["pk", "u"],
  },
  continuity_handoff: {
    ddl: CONTINUITY_HANDOFF_V02_DDL,
    columns: [
      { name: "job_id", type: "TEXT", pk: 1 },
      { name: "session_id", type: "TEXT", pk: 0 },
      { name: "project_id", type: "TEXT", pk: 0 },
      { name: "generation", type: "INTEGER", pk: 0 },
      { name: "cut", type: "INTEGER", pk: 0 },
      { name: "source_hash", type: "TEXT", pk: 0 },
      { name: "payload", type: "TEXT", pk: 0 },
    ],
    indexOrigins: ["pk"],
  },
};

function isContinuityName(value: string): boolean {
  return /^continuity_/i.test(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function readSchemaObjects(db: DatabaseSync, schema: string): SchemaObject[] {
  const table = `${quoteIdentifier(schema)}.sqlite_schema`;
  return db.prepare(`SELECT type,name,tbl_name,sql FROM ${table}`).all() as unknown as SchemaObject[];
}

function hasExactIndexOrigins(db: DatabaseSync, table: string, expected: readonly string[]): boolean {
  const indexes = db.prepare(`PRAGMA main.index_list('${table}')`).all() as unknown as IndexShape[];
  return indexes.length === expected.length
    && indexes.every(index => index.unique === 1 && index.partial === 0 && expected.includes(index.origin))
    && expected.every(origin => indexes.filter(index => index.origin === origin).length === 1);
}

const V2_ARCHIVE_SCHEMA: Record<keyof typeof CONTINUITY_V03_LEGACY_ARCHIVE_DDL, {
  ddl: string; columns: readonly ColumnShape[]; indexOrigins: readonly string[];
}> = {
  continuity_jobs_legacy_v2: {
    ddl: CONTINUITY_V03_LEGACY_ARCHIVE_DDL.continuity_jobs_legacy_v2,
    columns: [
      { name: "id", type: "TEXT", pk: 1 }, { name: "session_id", type: "TEXT", pk: 0 },
      { name: "project_id", type: "TEXT", pk: 0 }, { name: "generation", type: "INTEGER", pk: 0 },
      { name: "cut", type: "INTEGER", pk: 0 }, { name: "source_hash", type: "TEXT", pk: 0 },
      { name: "trigger", type: "TEXT", pk: 0 }, { name: "status", type: "TEXT", pk: 0 },
    ],
    indexOrigins: ["pk", "u"],
  },
  continuity_handoff_legacy_v2: {
    ddl: CONTINUITY_V03_LEGACY_ARCHIVE_DDL.continuity_handoff_legacy_v2,
    columns: V2_AUX_SCHEMA.continuity_handoff.columns,
    indexOrigins: ["pk"],
  },
};

function matchesExactV2Table(
  db: DatabaseSync,
  table: string,
  expected: { ddl: string; columns: readonly ColumnShape[]; indexOrigins: readonly string[] },
): boolean {
  if (!/^continuity_[a-z0-9_]+$/.test(table)) return false;
  const stored = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string | null } | undefined;
  if (!stored?.sql || normalizeContinuityDdl(stored.sql) !== normalizeContinuityDdl(expected.ddl)) return false;
  const metadata = db.prepare("SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name=?").get(table) as
    { type: string; strict: number } | undefined;
  if (metadata?.type !== "table" || metadata.strict !== 1) return false;
  const columns = db.prepare(`PRAGMA main.table_xinfo(${quoteIdentifier(table)})`).all() as Array<{
    cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number;
  }>;
  if (columns.length !== expected.columns.length || !expected.columns.every((field, index) => {
    const column = columns[index];
    return column.cid === index && column.hidden === 0 && column.name === field.name && column.type === field.type
      && column.notnull === 1 && column.dflt_value === null && column.pk === field.pk;
  })) return false;
  return hasExactIndexOrigins(db, table, expected.indexOrigins);
}

function matchesExactV2AuxTable(db: DatabaseSync, table: "continuity_work" | "continuity_handoff"): boolean {
  return matchesExactV2Table(db, table, V2_AUX_SCHEMA[table]);
}

function censusContinuityObjects(db: DatabaseSync):
  | { ok: true; tables: Set<string> }
  | { ok: false; reason: "temp-continuity-object" | "unknown-or-attached-object" | "noncanonical-object-name" } {
  const tables = new Set<string>();
  const schemas = db.prepare("PRAGMA database_list").all() as Array<{ name: string }>;
  for (const { name: schema } of schemas) {
    if (typeof schema !== "string" || !schema) return { ok: false, reason: "unknown-or-attached-object" };
    for (const object of readSchemaObjects(db, schema)) {
      const nameRelevant = isContinuityName(object.name);
      const tableRelevant = isContinuityName(object.tbl_name);
      if (!nameRelevant && !tableRelevant) continue;
      if (schema === "temp") return { ok: false, reason: "temp-continuity-object" };
      if (schema !== "main") return { ok: false, reason: "unknown-or-attached-object" };

      // SQLite's implicit indexes have no SQL text. They are allowed only as
      // attachments to a recognized main table; each admitted table's exact
      // expected index origins are checked separately below.
      if (object.type === "index" && object.sql === null && /^sqlite_autoindex_/i.test(object.name)) {
        const owner = object.tbl_name.toLowerCase();
        if (!RECOGNIZED_TABLES.has(owner) || object.tbl_name !== owner) {
          return { ok: false, reason: "unknown-or-attached-object" };
        }
        continue;
      }

      if (object.type !== "table" || !nameRelevant || !RECOGNIZED_TABLES.has(object.name.toLowerCase())) {
        return { ok: false, reason: "unknown-or-attached-object" };
      }
      const canonical = object.name.toLowerCase();
      if (object.name !== canonical || object.tbl_name !== object.name || !object.sql) {
        return { ok: false, reason: "noncanonical-object-name" };
      }
      tables.add(object.name);
    }
  }
  return { ok: true, tables };
}

function summaryIndexShapesMatch(db: DatabaseSync, tables: ReadonlySet<string>): boolean {
  // The body-consent owner remains responsible for full summary-ledger DDL and
  // main-qualified reads/writes. The census still refuses added indexes.
  if (tables.has("continuity_summary_policy")
    && !hasExactIndexOrigins(db, "continuity_summary_policy", [])) return false;
  if (tables.has("continuity_summary_human")
    && !hasExactIndexOrigins(db, "continuity_summary_human", ["pk"])) return false;
  return true;
}

const V3_REQUIRED_ACTIVE = ["continuity_policy", "continuity_checkpoint", "continuity_jobs", "continuity_v3_human_boundary"] as const;
const V3_ACTIVE_NAMES = new Set<string>(Object.keys(CONTINUITY_V03_ACTIVE_DDL));
const V3_ACTIVE_COLUMNS: Record<keyof typeof CONTINUITY_V03_ACTIVE_DDL, readonly [name: string, type: string, pk: number][]> = {
  continuity_checkpoint: [["session_id", "TEXT", 1], ["project_id", "TEXT", 0], ["generation", "INTEGER", 0], ["cut", "INTEGER", 0], ["source_hash", "TEXT", 0], ["checkpoint_format", "INTEGER", 0], ["source_binding_version", "INTEGER", 0], ["selected_source_hash", "TEXT", 0], ["lineage_format", "INTEGER", 0], ["lineage_binding_version", "INTEGER", 0], ["lineage_kind", "TEXT", 0], ["lineage_hash", "TEXT", 0], ["envelope", "TEXT", 0]],
  continuity_handoff: [["job_id", "TEXT", 1], ["session_id", "TEXT", 0], ["project_id", "TEXT", 0], ["generation", "INTEGER", 0], ["cut", "INTEGER", 0], ["source_hash", "TEXT", 0], ["checkpoint_format", "INTEGER", 0], ["source_binding_version", "INTEGER", 0], ["selected_source_hash", "TEXT", 0], ["lineage_format", "INTEGER", 0], ["lineage_binding_version", "INTEGER", 0], ["lineage_kind", "TEXT", 0], ["lineage_hash", "TEXT", 0], ["payload", "TEXT", 0]],
  continuity_jobs: [["id", "TEXT", 1], ["session_id", "TEXT", 0], ["project_id", "TEXT", 0], ["generation", "INTEGER", 0], ["cut", "INTEGER", 0], ["source_hash", "TEXT", 0], ["checkpoint_format", "INTEGER", 0], ["source_binding_version", "INTEGER", 0], ["selected_source_hash", "TEXT", 0], ["lineage_format", "INTEGER", 0], ["lineage_binding_version", "INTEGER", 0], ["lineage_kind", "TEXT", 0], ["lineage_hash", "TEXT", 0], ["trigger", "TEXT", 0], ["status", "TEXT", 0]],
  continuity_policy: [["session_id", "TEXT", 1], ["project_id", "TEXT", 0], ["generation", "INTEGER", 0], ["allowed", "INTEGER", 0]],
  continuity_v3_human_boundary: [["session_id", "TEXT", 1], ["project_id", "TEXT", 0], ["header_hash", "TEXT", 0], ["inherited_event_count", "INTEGER", 0], ["generation", "INTEGER", 0], ["latest_live_human_seq", "INTEGER", 0], ["last_enqueued_human_seq", "INTEGER", 0]],
  continuity_work: [["job_id", "TEXT", 1], ["token", "TEXT", 0], ["lease_deadline", "INTEGER", 0], ["attempts", "INTEGER", 0], ["status", "TEXT", 0]],
};
interface V3MarkerRow { id: number; marker_format: number; schema_epoch: number; origin: string; legacy_archive_state: string; ddl_fingerprint: string }
function matchesExactV03ActiveTable(db: DatabaseSync, table: string): boolean {
  if (!V3_ACTIVE_NAMES.has(table)) return false;
  const expected = CONTINUITY_V03_ACTIVE_DDL[table as keyof typeof CONTINUITY_V03_ACTIVE_DDL];
  const stored = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?").get(table) as { sql: string | null } | undefined;
  if (!stored?.sql || normalizeContinuityDdl(stored.sql) !== normalizeContinuityDdl(expected)) return false;
  const metadata = db.prepare("SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name=?").get(table) as
    { type: string; strict: number } | undefined;
  if (metadata?.type !== "table" || metadata.strict !== 1) return false;
  const columns = db.prepare(`PRAGMA main.table_xinfo(${quoteIdentifier(table)})`).all() as Array<{
    cid: number; hidden: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const expectedColumns = V3_ACTIVE_COLUMNS[table as keyof typeof CONTINUITY_V03_ACTIVE_DDL];
  if (columns.length !== expectedColumns.length || !expectedColumns.every(([name, type, pk], index) => {
    const column = columns[index];
    return column.cid === index && column.hidden === 0 && column.name === name && column.type === type
      && column.notnull === 1 && column.dflt_value === null && column.pk === pk;
  })) return false;
  const origins = table === "continuity_jobs" || table === "continuity_work" ? ["pk", "u"] : ["pk"];
  return hasExactIndexOrigins(db, table, origins);
}
function matchesExactV03Marker(db: DatabaseSync): boolean {
  const stored = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='continuity_schema_meta'").get() as
    { sql: string | null } | undefined;
  if (!stored?.sql || normalizeContinuityDdl(stored.sql) !== normalizeContinuityDdl(CONTINUITY_V03_MARKER_DDL)) return false;
  const metadata = db.prepare("SELECT type,strict FROM pragma_table_list WHERE schema='main' AND name='continuity_schema_meta'").get() as
    { type: string; strict: number } | undefined;
  if (metadata?.type !== "table" || metadata.strict !== 1) return false;
  const columns = db.prepare("PRAGMA main.table_xinfo('continuity_schema_meta')").all() as Array<{
    cid: number; hidden: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number;
  }>;
  const expected: Array<[string, string, number, number]> = [
    ["id", "INTEGER", 0, 1], ["marker_format", "INTEGER", 1, 0], ["schema_epoch", "INTEGER", 1, 0],
    ["origin", "TEXT", 1, 0], ["legacy_archive_state", "TEXT", 1, 0], ["ddl_fingerprint", "TEXT", 1, 0],
  ];
  return columns.length === expected.length && expected.every(([name, type, notnull, pk], index) => {
    const column = columns[index];
    return column.cid === index && column.hidden === 0 && column.name === name && column.type === type
      && column.notnull === notnull && column.dflt_value === null && column.pk === pk;
  }) && hasExactIndexOrigins(db, "continuity_schema_meta", []);
}
function classifyV03(db: DatabaseSync, tables: ReadonlySet<string>): ContinuitySchemaV03Classification {
  if (!tables.has("continuity_schema_meta") || !tables.has("continuity_v3_human_boundary")) {
    return { kind: "refuse", reason: "v3-required-table-missing" };
  }
  if (!V3_REQUIRED_ACTIVE.every(name => tables.has(name))) return { kind: "refuse", reason: "v3-required-table-missing" };
  const workerCount = V2_WORKER_PAIR.filter(name => tables.has(name)).length;
  if (workerCount === 1) return { kind: "refuse", reason: "split-v2-worker-pair" };
  for (const table of [...V3_REQUIRED_ACTIVE, "continuity_v3_human_boundary", ...(workerCount === 2 ? V2_WORKER_PAIR : [])]) {
    if (!matchesExactV03ActiveTable(db, table)) return { kind: "refuse", reason: "v3-active-schema-mismatch" };
  }
  if (!matchesExactV03Marker(db)) return { kind: "refuse", reason: "v3-marker-invalid" };
  if (db.prepare("SELECT 1 FROM main.continuity_schema_meta WHERE instr(CAST(origin AS BLOB),X'00')>0 OR instr(CAST(legacy_archive_state AS BLOB),X'00')>0 OR instr(CAST(ddl_fingerprint AS BLOB),X'00')>0 LIMIT 1").get()) {
    return { kind: "refuse", reason: "v3-marker-invalid" };
  }
  const markers = db.prepare("SELECT id,marker_format,schema_epoch,origin,legacy_archive_state,ddl_fingerprint FROM main.continuity_schema_meta").all() as unknown as V3MarkerRow[];
  if (markers.length !== 1) return { kind: "refuse", reason: "v3-marker-invalid" };
  const marker = markers[0]!;
  if (marker.id !== 1 || marker.marker_format !== 1 || marker.schema_epoch !== 3
    || marker.ddl_fingerprint !== CONTINUITY_V03_DDL_FINGERPRINT
    || !["fresh", "v2-cutover"].includes(marker.origin)
    || !["none", "jobs-only", "jobs-and-handoffs", "purged"].includes(marker.legacy_archive_state)) {
    return { kind: "refuse", reason: "v3-marker-invalid" };
  }
  const sidecars = LEGACY_SIDECARS.filter(name => tables.has(name));
  if (marker.origin === "fresh" && (marker.legacy_archive_state !== "none" || sidecars.length !== 0)) {
    return { kind: "refuse", reason: "v3-marker-invalid" };
  }
  if (marker.origin === "v2-cutover") {
    if (marker.legacy_archive_state === "purged") {
      if (sidecars.length !== 0) return { kind: "refuse", reason: "v3-marker-invalid" };
    } else if (marker.legacy_archive_state === "jobs-only") {
      if (sidecars.length !== 1 || !tables.has("continuity_jobs_legacy_v2")
        || !matchesExactV2Table(db, "continuity_jobs_legacy_v2", V2_ARCHIVE_SCHEMA.continuity_jobs_legacy_v2)) {
        return { kind: "refuse", reason: "v3-archive-schema-mismatch" };
      }
    } else if (marker.legacy_archive_state === "jobs-and-handoffs") {
      if (sidecars.length !== 2 || !tables.has("continuity_jobs_legacy_v2") || !tables.has("continuity_handoff_legacy_v2")
        || !matchesExactV2Table(db, "continuity_jobs_legacy_v2", V2_ARCHIVE_SCHEMA.continuity_jobs_legacy_v2)
        || !matchesExactV2Table(db, "continuity_handoff_legacy_v2", V2_ARCHIVE_SCHEMA.continuity_handoff_legacy_v2)) {
        return { kind: "refuse", reason: "v3-archive-schema-mismatch" };
      }
    } else return { kind: "refuse", reason: "v3-marker-invalid" };
    return {
      kind: "v3-schema", workerPair: workerCount === 2 ? "present" : "absent",
      origin: "v2-cutover", legacyArchiveState: marker.legacy_archive_state as "jobs-only" | "jobs-and-handoffs" | "purged",
      summaryLedgersPresent: SUMMARY_TABLES.some(name => tables.has(name)),
    };
  }
  return { kind: "v3-schema", workerPair: workerCount === 2 ? "present" : "absent", origin: "fresh", legacyArchiveState: "none", summaryLedgersPresent: SUMMARY_TABLES.some(name => tables.has(name)) };
}

/**
 * Read-only schema classification. The owner must wrap it in an IMMEDIATE
 * transaction on the same MemoryStore connection before acting. A v3-schema
 * result confirms the exact DDL and marker only; row/summary-ledger validation
 * remains the owner's separate mandatory gate.
 */
export function classifyContinuitySchemaV03(db: DatabaseSync): ContinuitySchemaV03Classification {
  const census = censusContinuityObjects(db);
  if (!census.ok) return { kind: "refuse", reason: census.reason };
  const { tables } = census;
  if (!summaryIndexShapesMatch(db, tables)) return { kind: "refuse", reason: "summary-index-mismatch" };

  if (tables.has("continuity_schema_meta") || tables.has("continuity_v3_human_boundary")) return classifyV03(db, tables);
  if (LEGACY_SIDECARS.some(name => tables.has(name))) return { kind: "refuse", reason: "legacy-sidecar-present" };

  const corePresent = V2_CORE.filter(name => tables.has(name)).length;
  const workerPresent = V2_WORKER_PAIR.filter(name => tables.has(name)).length;
  const summaryLedgersPresent = SUMMARY_TABLES.some(name => tables.has(name));
  if (corePresent === 0 && workerPresent === 0) return { kind: "empty", summaryLedgersPresent };
  if (corePresent !== V2_CORE.length) return { kind: "refuse", reason: "partial-v2-core" };
  if (workerPresent === 1) return { kind: "refuse", reason: "split-v2-worker-pair" };

  if (!V2_CORE.every(name => matchesContinuityV02Schema(db, name as ContinuityV02Table))) {
    return { kind: "refuse", reason: "v2-core-schema-mismatch" };
  }
  if (workerPresent === V2_WORKER_PAIR.length
    && !V2_WORKER_PAIR.every(name => matchesExactV2AuxTable(db, name))) {
    return { kind: "refuse", reason: "v2-worker-schema-mismatch" };
  }
  return { kind: "legacy-v2-schema", workerPair: workerPresent === 0 ? "absent" : "present", summaryLedgersPresent };
}
