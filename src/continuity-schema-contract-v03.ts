import { createHash } from "node:crypto";
import { normalizeContinuityDdl, CONTINUITY_V02_DDL } from "./continuity-store-v02.js";
import { CONTINUITY_WORK_V02_DDL } from "./continuity-work-v02.js";
import { CONTINUITY_HANDOFF_V02_DDL } from "./continuity-handoff-v02.js";

const SHA256_HEX64_GLOB = "[0-9a-f]".repeat(64);
/** Exact v3 marker table contract. The schema-epoch owner still validates live objects and marker values. */
export const CONTINUITY_V03_MARKER_DDL = `CREATE TABLE continuity_schema_meta (
  id INTEGER PRIMARY KEY CHECK(id=1),
  marker_format INTEGER NOT NULL CHECK(marker_format=1),
  schema_epoch INTEGER NOT NULL CHECK(schema_epoch=3),
  origin TEXT NOT NULL CHECK(instr(CAST(origin AS BLOB),X'00')=0 AND origin IN('fresh','v2-cutover')),
  legacy_archive_state TEXT NOT NULL CHECK(instr(CAST(legacy_archive_state AS BLOB),X'00')=0 AND legacy_archive_state IN('none','jobs-only','jobs-and-handoffs','purged')),
  ddl_fingerprint TEXT NOT NULL CHECK(length(CAST(ddl_fingerprint AS BLOB))=64 AND instr(CAST(ddl_fingerprint AS BLOB),X'00')=0 AND ddl_fingerprint GLOB '${SHA256_HEX64_GLOB}'),
  CHECK((origin='fresh' AND legacy_archive_state='none') OR
    (origin='v2-cutover' AND legacy_archive_state IN('jobs-only','jobs-and-handoffs','purged')))
) STRICT`;

const PROJECT_ID_HEX32_GLOB = "[0-9a-f]".repeat(32);
/**
 * Proposed exact body-free capture ledger; this DDL remains unwired. SQLite's
 * TEXT length/GLOB functions are NUL-sensitive, so exact identifiers use BLOB
 * byte lengths plus positive fixed-width GLOBs. The row guard below enforces
 * the existing JS UTF-16 session-id bound. A current generation may equal
 * MAX_SAFE; the policy owner must reject any next increment.
 */
export const CONTINUITY_V03_HUMAN_BOUNDARY_DDL = `CREATE TABLE continuity_v3_human_boundary (
  session_id TEXT PRIMARY KEY CHECK(length(session_id) BETWEEN 1 AND 256 AND length(CAST(session_id AS BLOB)) BETWEEN 1 AND 768 AND instr(CAST(session_id AS BLOB),X'00')=0),
  project_id TEXT NOT NULL CHECK(length(CAST(project_id AS BLOB))=35 AND instr(CAST(project_id AS BLOB),X'00')=0 AND project_id GLOB 'pj-${PROJECT_ID_HEX32_GLOB}'),
  header_hash TEXT NOT NULL CHECK(length(CAST(header_hash AS BLOB))=64 AND instr(CAST(header_hash AS BLOB),X'00')=0 AND header_hash GLOB '${SHA256_HEX64_GLOB}'),
  inherited_event_count INTEGER NOT NULL CHECK(inherited_event_count BETWEEN 0 AND 9007199254740991),
  generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
  latest_live_human_seq INTEGER NOT NULL CHECK(latest_live_human_seq BETWEEN 0 AND 9007199254740991),
  last_enqueued_human_seq INTEGER NOT NULL CHECK(last_enqueued_human_seq BETWEEN -1 AND 9007199254740991),
  CHECK(latest_live_human_seq>=inherited_event_count),
  CHECK(last_enqueued_human_seq=-1 OR last_enqueued_human_seq>=inherited_event_count),
  CHECK(last_enqueued_human_seq<=latest_live_human_seq)
) STRICT`;

/**
 * Pinned v3 active schema templates. Policy deliberately retains its exact v2
 * layout; all other current v2 job/checkpoint rows are retired at cutover.
 * `checkpoint_format`, `source_binding_version`, `selected_source_hash`, and
 * the lineage columns remain explicit: outer envelope format (2), composite
 * source binding version (3), historical-lineage format (2), lineage binding
 * version (3), and root/fork variant must never be conflated.
 * The optional worker/handoff templates are fingerprinted whether or not the
 * inseparable pair has been lazily created in a particular store. SQLite TEXT
 * checks impose byte/codepoint ceilings and NUL rejection, but cannot reproduce
 * JavaScript UTF-16 `.length`; a v3 owner must SQL-probe NUL before reading and
 * apply the strict JS row/JSON size guards before any use.
 */
const SESSION_ID_CHECK = "CHECK(length(session_id) BETWEEN 1 AND 256 AND length(CAST(session_id AS BLOB)) BETWEEN 1 AND 768 AND instr(CAST(session_id AS BLOB),X'00')=0)";
const PROJECT_ID_CHECK = `CHECK(length(CAST(project_id AS BLOB))=35 AND instr(CAST(project_id AS BLOB),X'00')=0 AND project_id GLOB 'pj-${PROJECT_ID_HEX32_GLOB}')`;
const HASH_CHECK = (column: string): string => `CHECK(length(CAST(${column} AS BLOB))=64 AND instr(CAST(${column} AS BLOB),X'00')=0 AND ${column} GLOB '${SHA256_HEX64_GLOB}')`;
const UUID_GLOB = [8, 4, 4, 4, 12].map(width => "[a-f0-9]".repeat(width)).join("-");
const BINDING_COLUMNS = `source_binding_version INTEGER NOT NULL CHECK(source_binding_version=3),
  selected_source_hash TEXT NOT NULL ${HASH_CHECK("selected_source_hash")},
  lineage_format INTEGER NOT NULL CHECK(lineage_format=2),
  lineage_binding_version INTEGER NOT NULL CHECK(lineage_binding_version=3),
  lineage_kind TEXT NOT NULL CHECK(instr(CAST(lineage_kind AS BLOB),X'00')=0 AND lineage_kind IN('root','fork')),
  lineage_hash TEXT NOT NULL CHECK(length(CAST(lineage_hash AS BLOB))=64 AND instr(CAST(lineage_hash AS BLOB),X'00')=0 AND lineage_hash GLOB '${SHA256_HEX64_GLOB}')`;

const policyDdl = CONTINUITY_V02_DDL.continuity_policy.replace(/^CREATE TABLE IF NOT EXISTS /, "CREATE TABLE ");
const checkpointDdl = `CREATE TABLE continuity_checkpoint (
  session_id TEXT PRIMARY KEY ${SESSION_ID_CHECK},
  project_id TEXT NOT NULL ${PROJECT_ID_CHECK},
  generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
  cut INTEGER NOT NULL CHECK(cut BETWEEN -1 AND 9007199254740991),
  source_hash TEXT NOT NULL ${HASH_CHECK("source_hash")},
  checkpoint_format INTEGER NOT NULL CHECK(checkpoint_format=2),
  ${BINDING_COLUMNS},
  envelope TEXT NOT NULL CHECK(length(envelope)<=24000 AND length(CAST(envelope AS BLOB))<=48000 AND instr(CAST(envelope AS BLOB),X'00')=0)
) STRICT`;
const jobsDdl = `CREATE TABLE continuity_jobs (
  id TEXT PRIMARY KEY CHECK(length(CAST(id AS BLOB))=36 AND instr(CAST(id AS BLOB),X'00')=0 AND id GLOB '${UUID_GLOB}'),
  session_id TEXT NOT NULL ${SESSION_ID_CHECK},
  project_id TEXT NOT NULL ${PROJECT_ID_CHECK},
  generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
  cut INTEGER NOT NULL CHECK(cut BETWEEN -1 AND 9007199254740991),
  source_hash TEXT NOT NULL ${HASH_CHECK("source_hash")},
  checkpoint_format INTEGER NOT NULL CHECK(checkpoint_format=2),
  ${BINDING_COLUMNS},
  trigger TEXT NOT NULL CHECK(instr(CAST(trigger AS BLOB),X'00')=0 AND trigger IN('turn-end','pause','finish')),
  status TEXT NOT NULL CHECK(instr(CAST(status AS BLOB),X'00')=0 AND status IN('pending','cancelled')),
  UNIQUE(session_id,generation,cut,source_hash,checkpoint_format,source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,trigger)
) STRICT`;
const workDdl = CONTINUITY_WORK_V02_DDL.replace(/^CREATE TABLE IF NOT EXISTS /, "CREATE TABLE ").replace(
  "job_id TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE,",
  `job_id TEXT PRIMARY KEY CHECK(length(CAST(job_id AS BLOB))=36 AND instr(CAST(job_id AS BLOB),X'00')=0 AND job_id GLOB '${UUID_GLOB}'),\n  token TEXT NOT NULL UNIQUE CHECK(length(CAST(token AS BLOB))=36 AND instr(CAST(token AS BLOB),X'00')=0 AND token GLOB '${UUID_GLOB}'),`,
).replace("lease_deadline INTEGER NOT NULL CHECK(lease_deadline>=0),", "lease_deadline INTEGER NOT NULL CHECK(lease_deadline BETWEEN 0 AND 9007199254740991),").replace(
  "status TEXT NOT NULL CHECK(status IN('running','completed','failed'))",
  "status TEXT NOT NULL CHECK(instr(CAST(status AS BLOB),X'00')=0 AND status IN('running','completed','failed'))",
);
const handoffDdl = `CREATE TABLE continuity_handoff (
  job_id TEXT PRIMARY KEY CHECK(length(CAST(job_id AS BLOB))=36 AND instr(CAST(job_id AS BLOB),X'00')=0 AND job_id GLOB '${UUID_GLOB}'),
  session_id TEXT NOT NULL ${SESSION_ID_CHECK},
  project_id TEXT NOT NULL ${PROJECT_ID_CHECK},
  generation INTEGER NOT NULL CHECK(generation BETWEEN 0 AND 9007199254740991),
  cut INTEGER NOT NULL CHECK(cut BETWEEN -1 AND 9007199254740991),
  source_hash TEXT NOT NULL ${HASH_CHECK("source_hash")},
  checkpoint_format INTEGER NOT NULL CHECK(checkpoint_format=2),
  ${BINDING_COLUMNS},
  payload TEXT NOT NULL CHECK(length(payload)<=4000 AND length(CAST(payload AS BLOB))<=8000 AND instr(CAST(payload AS BLOB),X'00')=0)
) STRICT`;

export const CONTINUITY_V03_ACTIVE_DDL = Object.freeze({
  continuity_checkpoint: checkpointDdl,
  continuity_handoff: handoffDdl,
  continuity_jobs: jobsDdl,
  continuity_policy: policyDdl,
  continuity_v3_human_boundary: CONTINUITY_V03_HUMAN_BOUNDARY_DDL,
  continuity_work: workDdl,
});

function renamedLegacyDdl(source: string, from: string, to: string): string {
  const prefix = `CREATE TABLE IF NOT EXISTS ${from}`;
  if (!source.startsWith(prefix)) throw new Error(`unexpected legacy DDL prefix for ${from}`);
  return `CREATE TABLE ${to}${source.slice(prefix.length)}`;
}

/** Exact inert archive tables; excluded from the active v3 fingerprint. */
export const CONTINUITY_V03_LEGACY_ARCHIVE_DDL = Object.freeze({
  continuity_jobs_legacy_v2: renamedLegacyDdl(CONTINUITY_V02_DDL.continuity_jobs, "continuity_jobs", "continuity_jobs_legacy_v2"),
  continuity_handoff_legacy_v2: renamedLegacyDdl(CONTINUITY_HANDOFF_V02_DDL, "continuity_handoff", "continuity_handoff_legacy_v2"),
});

const ZERO = String.fromCharCode(0);
export function isSafeContinuityV03SessionId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && !value.includes(ZERO);
}
export function isSafeContinuityV03ProjectId(value: unknown): value is string {
  return typeof value === "string" && value.length === 35 && /^pj-[a-f0-9]{32}$/.test(value);
}
export function isSafeContinuityV03Sha256(value: unknown): value is string {
  return typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
}

function readExactOwnDataRow(value: unknown, keys: readonly string[], keySet: ReadonlySet<string>): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { return null; }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keySet.has(key))) return null;
  const row: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    row[key] = descriptor.value;
  }
  return row;
}

export interface ContinuityV03PolicyDbRow {
  session_id: string;
  project_id: string;
  generation: number;
  allowed: number;
}
const POLICY_ROW_KEYS = ["session_id", "project_id", "generation", "allowed"] as const;
const POLICY_ROW_KEY_SET = new Set<string>(POLICY_ROW_KEYS);
/**
 * Structural v3 policy guard. The policy table intentionally retains exact v2
 * DDL; a v3 owner must SQL-probe raw TEXT for NUL before calling this guard, as
 * node:sqlite truncates returned TEXT at embedded NUL.
 */
export function isSafeContinuityV03PolicyDbRow(value: unknown): value is ContinuityV03PolicyDbRow {
  const row = readExactOwnDataRow(value, POLICY_ROW_KEYS, POLICY_ROW_KEY_SET);
  return row !== null && isSafeContinuityV03SessionId(row.session_id) && isSafeContinuityV03ProjectId(row.project_id)
    && typeof row.generation === "number" && Number.isSafeInteger(row.generation) && row.generation >= 0
    && (row.allowed === 0 || row.allowed === 1);
}

export interface ContinuityV03HumanBoundaryDbRow {
  session_id: string;
  project_id: string;
  header_hash: string;
  inherited_event_count: number;
  generation: number;
  latest_live_human_seq: number;
  last_enqueued_human_seq: number;
}
const BOUNDARY_ROW_KEYS = ["session_id", "project_id", "header_hash", "inherited_event_count",
  "generation", "latest_live_human_seq", "last_enqueued_human_seq"] as const;
const BOUNDARY_ROW_KEY_SET = new Set<string>(BOUNDARY_ROW_KEYS);
/** Structural field check only; a future owner must call this on every row and also verify current policy/source anchors before use. */
export function isSafeContinuityV03HumanBoundaryDbRow(value: unknown): value is ContinuityV03HumanBoundaryDbRow {
  const row = readExactOwnDataRow(value, BOUNDARY_ROW_KEYS, BOUNDARY_ROW_KEY_SET);
  if (!row) return false;
  const floor = row.inherited_event_count;
  const latest = row.latest_live_human_seq;
  const consumed = row.last_enqueued_human_seq;
  return isSafeContinuityV03SessionId(row.session_id) && isSafeContinuityV03ProjectId(row.project_id)
    && isSafeContinuityV03Sha256(row.header_hash)
    && typeof floor === "number" && Number.isSafeInteger(floor) && floor >= 0
    && typeof row.generation === "number" && Number.isSafeInteger(row.generation) && row.generation >= 0
    && typeof latest === "number" && Number.isSafeInteger(latest) && latest >= floor
    && typeof consumed === "number" && Number.isSafeInteger(consumed)
    && consumed >= -1 && (consumed === -1 || consumed >= floor) && consumed <= latest;
}

/**
 * All six fingerprinted v3 active-table templates, including the lazy optional
 * worker/handoff pair, always participate even while that pair is physically
 * absent. Kept in ASCII table-name order; the self-referential marker is out.
 * No dedicated action ledger is approved; if added, revise this set, the closed
 * schema allowlist, and marker epoch/fingerprint before any v3 admission.
 */
export const CONTINUITY_V03_FINGERPRINT_TABLES = Object.freeze([
  "continuity_checkpoint",
  "continuity_handoff",
  "continuity_jobs",
  "continuity_policy",
  "continuity_v3_human_boundary",
  "continuity_work",
] as const);

export interface ContinuityV03FingerprintTemplate {
  tableName: string;
  ddl: string;
}

function canonicalTemplate(tableName: string, ddl: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) throw new Error("invalid v3 fingerprint table name");
  if (typeof ddl !== "string" || ddl.length === 0) throw new Error("missing v3 fingerprint DDL");
  const canonical = normalizeContinuityDdl(ddl);
  if (!canonical.startsWith(`CREATE TABLE ${tableName}(`)) throw new Error("v3 fingerprint DDL/table name mismatch");

  let inLiteral = false;
  for (let index = 0; index < canonical.length; index++) {
    const char = canonical[index]!;
    if (inLiteral) {
      if (char === "'") {
        if (canonical[index + 1] === "'") index++;
        else inLiteral = false;
      }
      continue;
    }
    if (char === "'") { inLiteral = true; continue; }
    if (char.charCodeAt(0) > 0x7f || char === '"' || char === "`" || char === "[" || char === "]"
      || char === ";" || (char === "-" && canonical[index + 1] === "-")
      || (char === "/" && canonical[index + 1] === "*")) {
      throw new Error("unsupported v3 fingerprint DDL form");
    }
  }
  if (inLiteral) throw new Error("unterminated v3 fingerprint DDL literal");
  return canonical;
}

function appendFrame(hash: ReturnType<typeof createHash>, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength > 0xffff_ffff) throw new Error("v3 fingerprint frame exceeds uint32 length");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(bytes.byteLength, 0);
  hash.update(length);
  hash.update(bytes);
}

/**
 * Compute the schema-epoch fingerprint from the exact active templates. The
 * static pin below binds the current epoch-3 DDL; the fingerprint proves DDL
 * identity only, never active-row safety, native-source truth, or authorization.
 */
export function continuitySchemaFingerprintV03(templates: readonly ContinuityV03FingerprintTemplate[]): string {
  if (!Array.isArray(templates) || templates.length !== CONTINUITY_V03_FINGERPRINT_TABLES.length) {
    throw new Error("v3 fingerprint requires every mandatory and optional active-table template");
  }
  const expected = new Set<string>(CONTINUITY_V03_FINGERPRINT_TABLES);
  const byName = new Map<string, string>();
  for (const template of templates) {
    if (!template || typeof template.tableName !== "string" || !expected.has(template.tableName) || byName.has(template.tableName)) {
      throw new Error("v3 fingerprint template set is unknown or duplicated");
    }
    byName.set(template.tableName, canonicalTemplate(template.tableName, template.ddl));
  }
  if (byName.size !== expected.size || CONTINUITY_V03_FINGERPRINT_TABLES.some(name => !byName.has(name))) {
    throw new Error("v3 fingerprint template set is incomplete");
  }

  const hash = createHash("sha256");
  for (const name of CONTINUITY_V03_FINGERPRINT_TABLES) {
    appendFrame(hash, name);
    appendFrame(hash, byName.get(name)!);
  }
  return hash.digest("hex");
}

/** Immutable exact templates consumed by the future schema owner. */
export const CONTINUITY_V03_FINGERPRINT_TEMPLATES = Object.freeze(
  CONTINUITY_V03_FINGERPRINT_TABLES.map(tableName => Object.freeze({
    tableName,
    ddl: CONTINUITY_V03_ACTIVE_DDL[tableName],
  })),
);
const CONTINUITY_V03_COMPUTED_FINGERPRINT = continuitySchemaFingerprintV03(CONTINUITY_V03_FINGERPRINT_TEMPLATES);
/** Static epoch-3 pin: any template change requires an explicit schema-epoch review. */
export const CONTINUITY_V03_DDL_FINGERPRINT = "40321ffa5ac44864535b1a2db66ffc44dacdb389fe87d579cf0c1a24fcc291c0";
if (CONTINUITY_V03_COMPUTED_FINGERPRINT !== CONTINUITY_V03_DDL_FINGERPRINT) {
  throw new Error("v3 active DDL changed without a schema-epoch fingerprint update");
}
