import type { DatabaseSync } from "node:sqlite";
import { normalizeContinuityDdl } from "./continuity-store-v02.js";
import {
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03SessionId,
  isSafeContinuityV03Sha256,
} from "./continuity-schema-contract-v03.js";

const POLICY_TABLE = "continuity_summary_policy";
const HUMAN_TABLE = "continuity_summary_human";
const SUMMARY_TABLES = new Set([POLICY_TABLE, HUMAN_TABLE]);

export const CONTINUITY_SUMMARY_POLICY_DDL = `CREATE TABLE continuity_summary_policy (
  id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(generation>=0),
  allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
) STRICT`;

export const CONTINUITY_SUMMARY_HUMAN_DDL = `CREATE TABLE continuity_summary_human (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, header_hash TEXT NOT NULL,
  inherited_floor INTEGER NOT NULL, human_seq INTEGER NOT NULL
) STRICT`;

export interface ContinuitySummaryPolicyFingerprintInputV02 {
  allowed: boolean;
  route: { provider: string; model: string } | null;
  excludedSessionIds: readonly string[];
  excludedProjectIds: readonly string[];
}

/** Canonicalize the exact settings inputs whose changes advance the durable body-policy epoch. */
export function continuitySummaryPolicyFingerprintV02(input: ContinuitySummaryPolicyFingerprintInputV02): string {
  return JSON.stringify({
    allowed: input.allowed,
    route: input.route,
    sessions: [...input.excludedSessionIds].sort(),
    projects: [...input.excludedProjectIds].sort(),
  });
}

interface SummaryColumn {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface SummaryIndex {
  name: string;
  unique: number;
  origin: string;
  partial: number;
}

interface SummaryTableSpec {
  name: string;
  ddl: string;
  columns: readonly SummaryColumn[];
  indexOrigins: readonly string[];
  indexKeyColumns: readonly (readonly string[])[];
}

const TABLE_SPECS: readonly SummaryTableSpec[] = [
  {
    name: POLICY_TABLE,
    ddl: CONTINUITY_SUMMARY_POLICY_DDL,
    columns: [
      { name: "id", type: "INTEGER", notnull: 0, pk: 1 },
      { name: "generation", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "allowed", type: "INTEGER", notnull: 1, pk: 0 },
    ],
    indexOrigins: [],
    indexKeyColumns: [],
  },
  {
    name: HUMAN_TABLE,
    ddl: CONTINUITY_SUMMARY_HUMAN_DDL,
    columns: [
      { name: "session_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "project_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "header_hash", type: "TEXT", notnull: 1, pk: 0 },
      { name: "inherited_floor", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "human_seq", type: "INTEGER", notnull: 1, pk: 0 },
    ],
    indexOrigins: ["pk"],
    indexKeyColumns: [["session_id"]],
  },
];

interface DatabaseListRow { name: string }
interface SchemaObject { type: string; name: string; tbl_name: string; sql: string | null }

function quoteIdentifier(value: string): string {
  if (typeof value !== "string" || value.length < 1 || value.includes("\0")) throw new Error("invalid SQLite schema name");
  return `"${value.replaceAll('"', '""')}"`;
}

function mentionsSummaryLedger(sql: string | null): boolean {
  return typeof sql === "string" && /\bcontinuity_summary_(?:policy|human)\b/i.test(sql);
}

/** Inventory every attached schema; any non-main summary object is a refusal. */
function inventorySummaryTables(db: DatabaseSync): Map<string, boolean> {
  const present = new Map<string, boolean>([[POLICY_TABLE, false], [HUMAN_TABLE, false]]);
  const databases = db.prepare("PRAGMA database_list").all() as unknown as DatabaseListRow[];
  if (!databases.some(database => database.name === "main")) throw new Error("main database is unavailable");
  for (const database of databases) {
    if (typeof database.name !== "string") throw new Error("invalid SQLite database list");
    const schema = quoteIdentifier(database.name);
    const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema`).all() as unknown as SchemaObject[];
    for (const object of objects) {
      if (typeof object.name !== "string" || typeof object.tbl_name !== "string") throw new Error("invalid SQLite schema object");
      const lowerName = object.name.toLowerCase();
      const lowerTable = object.tbl_name.toLowerCase();
      const namedSummary = SUMMARY_TABLES.has(lowerName);
      const attachedToSummary = SUMMARY_TABLES.has(lowerTable);
      const summaryTrigger = object.type === "trigger" && mentionsSummaryLedger(object.sql);
      if (!namedSummary && !attachedToSummary && !summaryTrigger) continue;
      if (database.name !== "main") throw new Error("summary ledger shadow or trigger outside main schema");
      if (summaryTrigger) throw new Error("custom trigger references a summary ledger");
      if (namedSummary) {
        if (object.type !== "table" || object.name !== lowerName || object.tbl_name !== object.name) {
          throw new Error("summary ledger name is not its exact main table");
        }
        present.set(object.name, true);
        continue;
      }
      // SQLite represents the TEXT PRIMARY KEY as one implicit autoindex with
      // NULL SQL. Its exact shape is checked against PRAGMA index_list/xinfo.
      if (object.type !== "index" || object.sql !== null || object.tbl_name !== HUMAN_TABLE) {
        throw new Error("custom summary-ledger index or trigger");
      }
    }
  }
  return present;
}

function exactTableExists(db: DatabaseSync, spec: SummaryTableSpec): boolean {
  const stored = db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?").get(spec.name) as { sql: string | null } | undefined;
  if (!stored) return false;
  if (!stored.sql || normalizeContinuityDdl(stored.sql) !== normalizeContinuityDdl(spec.ddl)) {
    throw new Error("incompatible summary-ledger DDL");
  }
  const columns = db.prepare(`PRAGMA main.table_xinfo('${spec.name}')`).all() as Array<{
    cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number; hidden: number;
  }>;
  if (columns.length !== spec.columns.length || !spec.columns.every((field, index) => {
    const column = columns[index];
    return column.cid === index && column.hidden === 0 && column.name === field.name && column.type === field.type
      && column.notnull === field.notnull && column.dflt_value === null && column.pk === field.pk;
  })) throw new Error("incompatible summary-ledger columns");
  const indexes = db.prepare(`PRAGMA main.index_list('${spec.name}')`).all() as unknown as SummaryIndex[];
  if (indexes.length !== spec.indexOrigins.length || indexes.some(index => index.unique !== 1 || index.partial !== 0
    || !spec.indexOrigins.includes(index.origin))
    || spec.indexOrigins.some(origin => indexes.filter(index => index.origin === origin).length !== 1)) {
    throw new Error("incompatible summary-ledger indexes");
  }
  if (indexes.some((index, indexPosition) => {
    const keyColumns = db.prepare(`PRAGMA main.index_xinfo(${quoteIdentifier(index.name)})`).all() as Array<{ name: string | null; key: number }>;
    return keyColumns.filter(column => column.key === 1).map(column => column.name)
      .join("\0") !== spec.indexKeyColumns[indexPosition]?.join("\0");
  })) throw new Error("incompatible summary-ledger index columns");
  return true;
}

/** Exact, main-only DDL/row-shape gate shared by policy sync and human claims. */
function assertSummaryLedgersReady(db: DatabaseSync): Map<string, boolean> {
  const present = inventorySummaryTables(db);
  for (const spec of TABLE_SPECS) {
    const exists = exactTableExists(db, spec);
    if (present.get(spec.name) !== exists) throw new Error("summary-ledger inventory mismatch");
  }
  return present;
}

/** Read-only schema gate for repeated provider consent checks. */
export function continuitySummaryLedgersReadyV02(db: DatabaseSync): boolean {
  try { assertSummaryLedgersReady(db); return true; }
  catch { return false; }
}

function safePolicyRow(row: { id: number; generation: number; allowed: number }): boolean {
  return row.id === 1 && Number.isSafeInteger(row.generation) && row.generation >= 0 && (row.allowed === 0 || row.allowed === 1);
}

function readPolicyRows(db: DatabaseSync): Array<{ id: number; generation: number; allowed: number }> {
  const rows = db.prepare("SELECT id,generation,allowed FROM main.continuity_summary_policy").all() as
    Array<{ id: number; generation: number; allowed: number }>;
  if (rows.length > 1 || rows.some(row => !safePolicyRow(row))) throw new Error("invalid continuity summary policy rows");
  return rows;
}

/**
 * Read the durable body/privacy-policy epoch without DDL or writes. The current
 * summary policy must be exactly schema-valid and allowed; missing, disabled,
 * or malformed state returns null. The trusted settings owner advances this
 * generation when consent, route, or exclusion fingerprints change. This is a
 * policy freshness fence, not UI intent or authorization by itself.
 */
export function readContinuitySummaryPolicyEpochV02(db: DatabaseSync): number | null {
  try {
    const present = assertSummaryLedgersReady(db);
    if (!present.get(POLICY_TABLE)) return null;
    const row = readPolicyRows(db)[0];
    return row?.allowed === 1 ? row.generation : null;
  } catch { return null; }
}

/**
 * Increment the body-consent epoch in the caller's existing IMMEDIATE store
 * transaction. All reads/writes are main-qualified. If disabled and absent, no
 * summary namespace is created. A true result never proves human intent.
 */
export function syncContinuitySummaryPolicyV02(db: DatabaseSync, allowed: boolean): number {
  if (typeof allowed !== "boolean") throw new TypeError("summary policy requires an explicit boolean");
  let present = assertSummaryLedgersReady(db);
  if (!present.get(POLICY_TABLE) && !allowed) return -1;
  if (!present.get(POLICY_TABLE)) {
    db.exec(`${CONTINUITY_SUMMARY_POLICY_DDL.replace("CREATE TABLE ", "CREATE TABLE main.")}`);
    present = assertSummaryLedgersReady(db);
  }
  const rows = readPolicyRows(db);
  const generation = (rows[0]?.generation ?? -1) + 1;
  if (!Number.isSafeInteger(generation)) throw new Error("continuity summary generation overflow");
  db.prepare(`INSERT INTO main.continuity_summary_policy (id,generation,allowed) VALUES(1,?,?)
    ON CONFLICT(id) DO UPDATE SET generation=excluded.generation,allowed=excluded.allowed`)
    .run(generation, allowed ? 1 : 0);
  return generation;
}

export interface ContinuitySummaryHumanClaimV02 {
  sessionId: string;
  projectId: string;
  headerHash: string;
  inheritedFloor: number;
  humanSeq: number;
  generation: number;
}

function safeHumanRow(row: {
  session_id: string; project_id: string; header_hash: string; inherited_floor: number; human_seq: number;
}): boolean {
  return isSafeContinuityV03SessionId(row.session_id)
    && isSafeContinuityV03ProjectId(row.project_id)
    && isSafeContinuityV03Sha256(row.header_hash)
    && Number.isSafeInteger(row.inherited_floor) && row.inherited_floor >= 0
    && Number.isSafeInteger(row.human_seq) && row.human_seq >= row.inherited_floor;
}

/** Claim a fresh own-human coordinate in the caller's IMMEDIATE store transaction. */
export function claimContinuitySummaryHumanV02(db: DatabaseSync, claim: ContinuitySummaryHumanClaimV02): boolean {
  if (!isSafeContinuityV03SessionId(claim.sessionId) || !isSafeContinuityV03ProjectId(claim.projectId)
    || !isSafeContinuityV03Sha256(claim.headerHash)
    || !Number.isSafeInteger(claim.inheritedFloor) || claim.inheritedFloor < 0
    || !Number.isSafeInteger(claim.humanSeq) || claim.humanSeq < claim.inheritedFloor
    || !Number.isSafeInteger(claim.generation) || claim.generation < 0) return false;
  let present = assertSummaryLedgersReady(db);
  if (!present.get(POLICY_TABLE)) return false;
  const policyRows = readPolicyRows(db);
  const policy = policyRows[0];
  if (!policy || policy.allowed !== 1 || policy.generation !== claim.generation) return false;
  if (!present.get(HUMAN_TABLE)) {
    db.exec(`${CONTINUITY_SUMMARY_HUMAN_DDL.replace("CREATE TABLE ", "CREATE TABLE main.")}`);
    present = assertSummaryLedgersReady(db);
  }
  if (!present.get(HUMAN_TABLE)) throw new Error("summary human ledger creation failed");
  const prior = db.prepare(`SELECT session_id,project_id,header_hash,inherited_floor,human_seq
    FROM main.continuity_summary_human WHERE session_id=?`).get(claim.sessionId) as
    { session_id: string; project_id: string; header_hash: string; inherited_floor: number; human_seq: number } | undefined;
  if (prior && (!safeHumanRow(prior) || prior.project_id !== claim.projectId || prior.header_hash !== claim.headerHash
    || prior.inherited_floor !== claim.inheritedFloor)) throw new Error("summary human watermark ownership mismatch");
  if (prior && claim.humanSeq <= prior.human_seq) return false;
  db.prepare(`INSERT INTO main.continuity_summary_human (session_id,project_id,header_hash,inherited_floor,human_seq)
    VALUES(?,?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET human_seq=excluded.human_seq`)
    .run(claim.sessionId, claim.projectId, claim.headerHash, claim.inheritedFloor, claim.humanSeq);
  return true;
}
