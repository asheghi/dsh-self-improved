/**
 * Phase A migration increment — MIGRATION-V0.2.md § "Actual migration of existing data":
 * steps 1 (inventory, never auto-install) and 3 (dry-run proposal for an isolated
 * destination) for the legacy `self-improved` v0.1 memory store.
 *
 * Hard safety contract implemented here and asserted by scripts/test-migration-v02.mjs:
 * - The source is only ever READ: `node:sqlite` opened `readOnly` plus a
 *   transactionally consistent `VACUUM INTO` snapshot into a uniquely owned temp
 *   directory (WAL-inclusive). The legacy `MemoryStore` class is never
 *   instantiated against the source, so no schema DDL, no repair passes and no
 *   backup writers can touch the store.
 * - The dry-run writes nothing: not the source, not the destination, not the
 *   active profile, no extra config. The real import writer is Phase B work and
 *   does not exist yet.
 * - Reports contain counts, ids, scopes, timestamps, digests and statuses only.
 *   Memory raw content, slice text, persona prose and skill bodies never enter
 *   the report; secret-shaped settings leaves are reduced to `present: true`.
 * - Free-form SQLite metadata is bounded: schema_state marker VALUES and every
 *   unknown marker KEY are reported as opaque digests (never raw text), and
 *   free-string category metadata (status/kind/provenance/source) outside the
 *   legacy contract vocabulary is reduced to opaque digested identifiers plus
 *   counts. ids, scopes and timestamps are explicitly allowed preservation
 *   metadata and are carried verbatim. Error strings never quote source text.
 * - Source/destination overlap (identical, nested, or bound through the same
 *   symlink component) is rejected before any read, and a symlink anywhere
 *   inside the source tree or the skills root is refused before any audit read.
 * - Report files are written exclusively by the operator CLI after its own
 *   destination validation; this module never writes one.
 * - Source bytes and SQLite schema are digested before and re-verified after
 *   analysis; the report states explicitly whether they stayed unchanged.
 *
 * Determinism: no wall-clock or machine-path entropy enters the returned
 * report, so identical inputs produce byte-identical report JSON.
 */

import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

// ---------------- Report shapes ----------------

export interface InventoryOptions {
  /** Memory store root directory (contains memory.db, conversations/, persona/, vectors.db). */
  sourceRoot: string;
  /** Optional legacy settings patch file (YAML or JSON) containing the self-improved entry. */
  settingsPath?: string;
  /** Optional legacy skills filesystem root (the $DSH_HOME/skills equivalent). */
  skillsRoot?: string;
}

export interface DryRunOptions extends InventoryOptions {
  /** Destination candidate: validated only; the dry-run never writes there. */
  destinationRoot?: string;
}

export interface FileDigest {
  path: string;
  size: number;
  sha256: string;
}

/**
 * Status of one of the two REQUIRED schema migration markers ("v1", "v2").
 * The key strings are contract wire names, never source content. The stored
 * marker VALUE is free-form source text and is therefore only ever reported as
 * a digest; `applied_at` is a propagation timestamp (allowed preservation
 * metadata) and is kept verbatim.
 */
export interface SchemaMarkerStatus {
  key: "v1" | "v2";
  present: boolean;
  /** sha256 hex of the raw stored value; the value itself is never reported. */
  valueDigest?: string;
  /** allowed preservation timestamp from schema_state.applied_at */
  appliedAt?: number;
}

/** An arbitrary, non-contract schema_state row: reported only as an opaque digested identifier. */
export interface SchemaMarkerUnknown {
  /** digest-derived opaque identifier for the raw key; the key text is never reported */
  keyDigest: string;
  appliedAt: number | null;
}

export interface SchemaMarkers {
  known: SchemaMarkerStatus[]; // exactly the "v1" and "v2" slots, in that order
  unknown: SchemaMarkerUnknown[];
  unknownCount: number;
}

export interface SchemaFinding {
  userVersion: number;
  schemaMarkers: SchemaMarkers;
  knownTables: string[];
  unknownTables: string[];
  missingTables: string[];
  extraColumns: Array<{ table: string; columns: string[] }>;
  integrity: string;
}

export interface DestinationProjection {
  memoryRows: number;
  personalLaneEligible: number;
  reviewRequired: number;
  quarantinedProposed: number;
  taskHandoffCandidates: number;
  personaInactive: number;
  approxBytesOfProposedPersonalContent: number;
  extractionBacklogSessions: number;
  extractionBacklogValidSlices: number;
  heuristicCostNote: string;
}

export interface Counts {
  memories: {
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    byProvenance: Record<string, number>;
    bySource: Record<string, number>;
    byScope: Record<string, number>;
    missingMeta: number;
    total: number;
  };
  conversations: {
    fileCount: number;
    totalBytes: number;
    totalLines: number;
    validLines: number;
    malformedLines: number;
    duplicateSessionSeqLines: number;
    sessionsWithSeqZero: number;
    fileSessionsWithoutCursor: number;
    sessionsWithoutFile: number;
  };
  episodes: {
    byStatus: Record<string, number>;
    steps: number;
    unpairedSteps: number;
    reviewed: number;
    delegated: number;
  };
  persona: { versions: number; maxVer: number; files: Array<{ name: string; bytes: number }> };
  skills: { generatedPrefixedDirs: number; withSkillMd: number; names: string[]; nonPrefixedDirs: number };
  vectors: { available: boolean; embeddings?: number; note?: string };
  baseline: { pins: number };
  cursors: { sessions: number; processedAtZero: number; pendingSessions: number };
  projection?: DestinationProjection;
}

export type MappingAction = "carry" | "retire" | "secret" | "migrationOnly" | "defer" | "unmapped";

export interface MappingEntry {
  path: string;
  action: MappingAction;
  target?: string;
  equalsDefault?: boolean;
  /**
   * Present ONLY on `carry` leaves after the secret/credential guard: booleans,
   * numbers and innocuous configuration strings (providers, models, times).
   * Every other leaf class is presence-only.
   */
  value?: boolean | number | string;
  /** for secret / migrationOnly / unmapped / deferred leaves only presence is reported */
  present?: boolean;
  valueKind?: "boolean" | "number" | "string";
  note?: string;
}

export interface SettingsSection {
  entryId: string;
  found: boolean;
  leaves: number;
  mapped: MappingEntry[];
  deferred: MappingEntry[];
  secrets: MappingEntry[];
  unmapped: MappingEntry[];
  migrationOnly: MappingEntry[];
  retired: MappingEntry[];
  note: string;
  parseError?: string;
}

export interface Preservation {
  proposedMemoryRows: number;
  sampleIds: string[];
  idsPreserved: number;
  scopesPreserved: number;
  timestampsPreserved: number;
  supersessionChains: number;
  brokenSupersedes: number;
  evidenceEntries: number;
  evidenceUnverifiable: number;
  pastedDemotedOwnScopeOnly: number;
  quarantinedByLane: Record<string, number>;
}

export interface ConflictAudit {
  duplicateContentGroups: Array<{
    hash8: string;
    ids: string[];
    kind: string;
    scope: string;
    projectId: string;
    count: number;
  }>;
  conflictingPreferenceGroups: Array<{
    scope: string;
    projectId: string;
    options: Array<{ id: string; createdAt: number; hash8: string }>;
  }>;
  taskScopedCandidates: number;
}

export interface LaneStatus {
  persona: { recorded: boolean; versions: number; migrationActivation: "inactive" };
  skills: { recorded: boolean; generatedCount: number; migrationActivation: "inactive" };
  operational: {
    sourceConsent: {
      captureOn?: boolean;
      reviewOn?: boolean;
      captureArguments?: boolean;
      operationalRecallOn?: boolean;
    };
    proposal: { notExpanded: true; sameOrNarrower: true; reconfirmAtCutover: true };
  };
}

export interface MigrationReport {
  reportVersion: 1;
  phase: "A";
  mode: "inventory" | "dry-run";
  tool: {
    pluginId: string;
    legacyTarget: string;
    sourceReader: string;
  };
  source: { storeRoot: string; memoryDb: { exists: boolean; bytes?: number; sha256?: string } };
  supported: boolean;
  unsupportedReason: string[];
  schema: SchemaFinding;
  counts: Counts;
  preservation?: Preservation;
  conflicts?: ConflictAudit;
  lanes: LaneStatus;
  settings?: SettingsSection;
  safety: {
    sourceUnchanged: boolean;
    sourceFileCount: number;
    sourceSchemaUnchanged: boolean;
    snapshotIsolated: true;
    noMutationOnSource: true;
    destinationTouched: false;
    destinationValidated: boolean;
    rawContentInReport: false;
    onlineBackupContract: string;
    determinismNote: string;
  };
  gates: string[];
}

// ---------------- Legacy schema contract (mirrors src/storage.ts ensureSchema) ----------------

const KNOWN_TABLES = new Set([
  "memories",
  "memories_meta",
  "memories_seq",
  "baseline",
  "session_projects",
  "extract_state",
  "scenes",
  "persona_versions",
  "schema_state",
  "episode_events",
  "episodes",
  "episode_steps",
  "memories_fts",
  "memories_fts_data",
  "memories_fts_idx",
  "memories_fts_content",
  "memories_fts_docsize",
  "memories_fts_config",
  "sqlite_sequence",
]);

const REQUIRED_COLUMNS: Record<string, string[]> = {
  memories: ["id", "kind", "content", "importance", "access_count", "created_at", "updated_at", "status", "supersedes"],
  memories_meta: [
    "memory_id", "provenance", "source", "scope", "project_id", "session_id",
    "confidence", "expires_at", "evidence", "read_count", "last_read_at",
  ],
  memories_seq: ["memory_id", "seq"],
  baseline: ["slot", "memory_id", "updated_at"],
  session_projects: ["session_id", "project_id", "updated_at"],
  extract_state: ["session_id", "processed_seq", "pending_seq", "updated_at"],
  scenes: ["id", "title", "markdown", "memory_ids", "created_at", "updated_at"],
  persona_versions: ["ver", "content", "created_at"],
  schema_state: ["key", "value", "applied_at"],
  episodes: [
    "id", "session_id", "project_id", "turn", "status", "started_at", "ended_at",
    "updated_at", "first_seq", "last_seq", "reviewed_at", "summary", "confidence",
    "fingerprint", "delegated", "reject_reason",
  ],
  episode_events: [
    "session_id", "kind", "call_id", "turn", "step", "seq", "at", "payload",
    "created_at", "episode_id",
  ],
  episode_steps: [
    "episode_id", "ordinal", "call_id", "tool_name", "arguments_redacted", "result_excerpt",
    "is_error", "error_name", "error_code", "call_seq", "result_seq", "call_at", "result_at",
    "args_truncated", "result_truncated",
  ],
};

const OPTIONAL_COLUMNS: Record<string, Set<string>> = {
  persona_versions: new Set(["mem_watermark"]),
};

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");

/** Hard caps keep a hostile or huge store from detonating the report. */
const MAX_MEMORY_ROWS = 50_000;
const MAX_EPISODE_IDS = 200_000;
const SKILL_PREFIX = "dsi-";

// ---------------- Path safety ----------------

function assertNoSymlinkComponents(absolutePath: string): void {
  const segments = absolutePath.split(sep).filter((s) => s.length > 0);
  let acc = absolutePath.startsWith(sep) ? sep : segments[0];
  for (let i = 0; i < segments.length; i++) {
    acc = join(acc, segments[i]);
    let st;
    try {
      st = lstatSync(acc);
    } catch {
      return; // missing tail components are fine (e.g. not-yet-created destination)
    }
    if (st.isSymbolicLink()) {
      throw new Error(`migration-v02: refusing to operate on symlink path component: ${acc}`);
    }
  }
}

/**
 * Deep-walk refusal: `assertNoSymlinkComponents` only covers the path itself and
 * its ancestors. A symlink *inside* the source tree (e.g. conversations/ ->
 * some external directory) would otherwise be silently followed by the audit
 * readers while the digest comparison only sees real files — allowing reports
 * to be influenced by content the operator never named. Only plain files are
 * accepted anywhere under a read root.
 */
function refuseSymlinkedContent(root: string, role: string): void {
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable subtree surfaces through audits/digests; no retries
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(`migration-v02: refusing to read ${role}: a symlink is present inside the tree at ${p}; only plain files are accepted`);
      }
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
}

/**
 * Identity/containment validation shared by every invocation that names a
 * destination. Throws before any read or write when the roles could collide.
 */
export function validateSourceDestination(sourceRoot?: string, destinationRoot?: string): void {
  if (!destinationRoot || !sourceRoot) return;
  const src = resolve(sourceRoot);
  const dst = resolve(destinationRoot);
  assertNoSymlinkComponents(src);
  assertNoSymlinkComponents(dst);
  if (src === dst) {
    throw new Error(
      "migration-v02: source and destination are the same path; one tree would serve both roles of a migration",
    );
  }
  const srcInsideDst = isInSide(src, dst);
  const dstInsideSrc = isInSide(dst, src);
  if (srcInsideDst || dstInsideSrc) {
    throw new Error(
      "migration-v02: source and destination overlap (one contains the other); refusing to bind both roles to one tree",
    );
  }
}

function isInSide(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

// ---------------- Digest helpers ----------------

function sha256File(path: string): { size: number; sha256: string } | undefined {
  let st;
  try {
    st = statSync(path);
  } catch {
    return undefined;
  }
  if (!st.isFile()) return undefined;
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return { size: st.size, sha256: hash.digest("hex") };
}

export interface TreeDigest {
  files: FileDigest[];
  dirs: number;
  totalBytes: number;
}

export function digestDirectory(root: string): TreeDigest {
  const files: FileDigest[] = [];
  let dirs = 0;
  let totalBytes = 0;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        dirs++;
        walk(p);
      } else if (e.isFile()) {
        // SQLite's `*-shm` is a NON-DURABLE wal-index cache defined by SQLite to
        // be rebuilt from the WAL at need; readonly connections legitimately
        // maintain it while reading a live WAL store. Digesting it would flag
        // the tool's own transient reads as source mutations. `*.db` and
        // `*-wal` (data-bearing) remain fully digested.
        if (e.name.endsWith("-shm")) continue;
        const d = sha256File(p);
        if (d) {
          files.push({ path: relative(root, p), size: d.size, sha256: d.sha256 });
          totalBytes += d.size;
        }
      }
      // symlinks/other types: skipped for digests; symlink participation is rejected separately
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, dirs, totalBytes };
}

function digestsEqual(a: TreeDigest, b: TreeDigest): boolean {
  if (a.files.length !== b.files.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    if (
      a.files[i].path !== b.files[i].path ||
      a.files[i].size !== b.files[i].size ||
      a.files[i].sha256 !== b.files[i].sha256
    ) {
      return false;
    }
  }
  return true;
}

// ---------------- Snapshot lifecycle ----------------

interface OwnedSnapshot {
  db: DatabaseSync;
  memoryDbDigest: { bytes?: number; sha256?: string };
  snapRoot: string;
}

const SNAPSHOT_OWNER_MARKER = "OWNER.dsh-migration-v02";

function guardedRmSnapshot(dir: string): void {
  try {
    if (readFileSync(join(dir, SNAPSHOT_OWNER_MARKER), "utf8") !== "dsh-migration-v02-snapshot") return;
  } catch {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best effort: a leftover isolated snapshot directory is inert */
  }
}

/**
 * Open the source memory.db strictly read-only and materialize a WAL-inclusive
 * snapshot for analysis. `VACUUM INTO` reads the live WAL without mutating the
 * source database, and the analysis never touches the original connection.
 */
function takeSnapshot(sourceRoot: string): OwnedSnapshot {
  const dbPath = join(sourceRoot, "memory.db");
  if (!existsSync(dbPath)) {
    throw new Error("migration-v02: no memory.db under source root (missing-source)");
  }
  let header: Buffer;
  try {
    header = readFileSync(dbPath);
  } catch {
    throw new Error("migration-v02: memory.db exists but is unreadable (missing-source)");
  }
  if (header.length < SQLITE_HEADER.length || !header.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new Error("migration-v02: memory.db is not an SQLite 3 database (unsupported-source)");
  }
  const digested = sha256File(dbPath);
  const snapRoot = mkdtempSync(join(tmpdir(), "dsi-v02-migration-snap-"));
  try {
    writeFileSync(join(snapRoot, SNAPSHOT_OWNER_MARKER), "dsh-migration-v02-snapshot", "utf8");
    const quoted = join(snapRoot, "snapshot-memory.db").replace(/'/g, "''");
    const source = new DatabaseSync(dbPath, { readOnly: true });
    try {
      source.exec(`VACUUM INTO '${quoted}'`);
    } finally {
      try {
        source.close();
      } catch {
        /* noop */
      }
    }
    const db = new DatabaseSync(join(snapRoot, "snapshot-memory.db"), { readOnly: true });
    return { db, memoryDbDigest: digested ?? {}, snapRoot };
  } catch (e) {
    guardedRmSnapshot(snapRoot);
    const msg = e instanceof Error ? e.message : String(e);
    if (/readonly|READONLY/i.test(msg)) {
      throw new Error(
        "migration-v02: the source SQLite file could not be read read-only; if the legacy host was not shut down cleanly, run the online-backup contract (VACUUM INTO / quiesce all writers) and analyze the consistent snapshot instead of ever opening the store with a mutating handle",
      );
    }
    throw e instanceof Error ? e : new Error(msg);
  }
}

function closeSnapshot(snap: OwnedSnapshot): void {
  try {
    snap.db.close();
  } catch {
    /* noop */
  }
  guardedRmSnapshot(snap.snapRoot);
}

function digest(stream: string): string {
  return createHash("sha256").update(stream).digest("hex");
}

// ---------------- Snapshot-only query helpers ----------------

function tableNames(db: DatabaseSync): string[] {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: unknown }>;
  return rows.map((r) => String(r.name));
}

/** Only our own REQUIRED_COLUMNS keys ever reach this: enforce simple identifiers defensively. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function columnsOf(db: DatabaseSync, table: string): string[] {
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`migration-v02: refusing non-identifier table name: ${table}`);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>;
  return rows.map((r) => String(r.name ?? ""));
}

function scalarCount(db: DatabaseSync, sql: string): number {
  try {
    const row = db.prepare(sql).get() as Record<string, unknown> | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

function groupCounts(db: DatabaseSync, sql: string, knownValues?: Set<string>): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const rows = db.prepare(sql).all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const raw = r.k == null ? "(missing)" : String(r.k);
      const key = knownValues == null ? raw : reportKey(raw, knownValues);
      const n = Number(r.n ?? 0);
      if (Number.isFinite(n)) out[key] = (out[key] ?? 0) + n;
    }
  } catch {
    /* absent table: surfaced through schema findings */
  }
  return out;
}

// ---------------- Privacy bounding of source-derived free strings ----------------

/**
 * Opaque digested identifier for a source-derived free-form string. Used for
 * every category/metadata value that is NOT part of the legacy contract
 * vocabulary: a hostile or drifted store can put arbitrary (private) text into
 * such columns, so the report never carries the raw string — only an
 * irreversible digest (irreversible even against the owner, who cannot guess a
 * preimage) plus the bucket counts.
 */
function opaqueIdent(value: string): string {
  return `opaque:${digest(value).slice(0, 12)}`;
}

/**
 * Report key for a tallied metadata value: verbatim only when it belongs to a
 * closed contract vocabulary fixed by the legacy schema (never attacker- or
 * drift-controlled), otherwise opaque digest.
 */
function reportKey(raw: string, knownValues: Set<string>): string {
  return knownValues.has(raw) ? raw : opaqueIdent(raw);
}

const KNOWN_MEMORY_STATUS = new Set([
  "active", "corrected", "forgotten", "migrated", "quarantined", "decayed",
]);
const KNOWN_MEMORY_KIND = new Set(["fact", "preference", "instruction", "persona", "event"]);
const KNOWN_MEMORY_PROVENANCE = new Set([
  "user", "assistant", "derived", "unknown", "system", "tool", "skill", "coordinator", "persona",
]);
const KNOWN_MEMORY_SOURCE = new Set(["llm-extract", "legacy", "llm-extract-pasted"]);
const KNOWN_EPISODE_STATUS = new Set(["pending", "succeeded", "failed", "rejected"]);

// ---------------- Schema classification ----------------

function classifySchema(db: DatabaseSync): { finding: SchemaFinding; reasons: string[] } {
  const names = tableNames(db);
  const reasons: string[] = [];
  const missing: string[] = [];
  const extraColumns: Array<{ table: string; columns: string[] }> = [];

  for (const table of Object.keys(REQUIRED_COLUMNS)) {
    if (!names.includes(table)) {
      missing.push(table);
      continue;
    }
    const actual = columnsOf(db, table);
    if (actual.length === 0) {
      missing.push(table);
      continue;
    }
    const absent = REQUIRED_COLUMNS[table].filter((c) => !actual.includes(c));
    if (absent.length > 0) {
      reasons.push(`table ${table} is missing required columns: ${absent.join(", ")}`);
    }
    const optional = OPTIONAL_COLUMNS[table] ?? new Set<string>();
    const extras = actual.filter((c) => c !== "" && !REQUIRED_COLUMNS[table].includes(c) && !optional.has(c)).sort();
    if (extras.length > 0) extraColumns.push({ table, columns: extras.map((c) => opaqueIdent(c)) });
  }
  if (!names.includes("memories_fts")) missing.push("memories_fts");
  if (missing.length > 0) reasons.push(`required legacy tables are absent: ${missing.sort().join(", ")}`);

  const unknownTablesRaw = names.filter((n) => !KNOWN_TABLES.has(n)).sort();
  // Unknown table NAMES are arbitrary source text (a drifted/hostile schema can
  // embed anything in an identifier): reported only as opaque digests.
  const unknownTables = unknownTablesRaw.map((n) => opaqueIdent(n));
  const knownTables = names.filter((n) => KNOWN_TABLES.has(n)).sort();

  let userVersion = 0;
  try {
    userVersion = Number((db.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version ?? 0);
  } catch {
    userVersion = 0;
  }

  // ---- schema_state markers ----
  // Support checks (below) run on the INTERNAL raw map; the returned finding
  // carries only presence + value digests for the contract markers (v1/v2) and
  // opaque digested identifiers for arbitrary unknown marker keys. Raw marker
  // values and unknown marker key text never enter the report (PRIVACY defect
  // fix: the raw map was previously copied into the returned finding verbatim,
  // leaking a private marker value through inventory --json).
  const schemaStateRaw: Record<string, string> = {};
  const unknownMarkerRows: Array<{ keyRaw: string; appliedAt: number | null }> = [];
  try {
    const rows = db
      .prepare("SELECT key, value, applied_at FROM schema_state")
      .all() as Array<{ key: unknown; value: unknown; applied_at: unknown }>;
    for (const r of rows) {
      const key = String(r.key);
      schemaStateRaw[key] = String(r.value);
      if (key !== "v1" && key !== "v2") {
        unknownMarkerRows.push({
          keyRaw: key,
          appliedAt: typeof r.applied_at === "number" ? r.applied_at : Number(r.applied_at ?? NaN),
        });
      }
    }
  } catch {
    reasons.push("schema_state table is not readable; the pre-Hermes migration markers cannot be verified");
  }
  const markerAppliedAt = (key: "v1" | "v2"): number | undefined => {
    try {
      const row = db.prepare("SELECT applied_at FROM schema_state WHERE key = ?").get(key) as { applied_at?: unknown } | undefined;
      const n = Number(row?.applied_at ?? NaN);
      return Number.isFinite(n) ? n : undefined;
    } catch {
      return undefined;
    }
  };
  const markerStatus = (key: "v1" | "v2"): SchemaMarkerStatus => {
    const raw = schemaStateRaw[key];
    const status: SchemaMarkerStatus = {
      key,
      present: raw !== undefined,
      valueDigest: raw !== undefined ? digest(String(raw)) : undefined,
      appliedAt: raw !== undefined ? markerAppliedAt(key) : undefined,
    };
    return status;
  };
  const schemaMarkers: SchemaMarkers = {
    known: [markerStatus("v1"), markerStatus("v2")],
    unknown: unknownMarkerRows
      .map((r) => ({ keyDigest: opaqueIdent(r.keyRaw), appliedAt: Number.isFinite(r.appliedAt) ? r.appliedAt : null }))
      .sort((a, b) => (a.keyDigest < b.keyDigest ? -1 : a.keyDigest > b.keyDigest ? 1 : 0)),
    unknownCount: unknownMarkerRows.length,
  };
  if (!schemaStateRaw.v1) {
    reasons.push("schema_state 'v1' provenance-backfill marker is absent: unsupported pre-migration legacy store for a migration proposal");
  }
  if (!schemaStateRaw.v2) {
    reasons.push("schema_state 'v2' episode-tables marker is absent");
  }
  if (schemaStateRaw.v1 && schemaStateRaw.v2 && userVersion !== 2 && userVersion !== 0) {
    reasons.push(`PRAGMA user_version=${userVersion} disagrees with schema_state v1+v2 markers`);
  }

  let integrity = "unknown";
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    const value = row ? String(Object.values(row)[0] ?? "") : "";
    // quick_check failure detail is free-form database text and is withheld;
    // integrity is reported as a structured status only.
    integrity = value === "ok" ? "ok" : "not-ok (detail withheld)";
    if (value !== "ok") reasons.push("sqlite quick_check reported a non-ok integrity status (detail withheld from the report)");
  } catch (e) {
    integrity = "not-ok (check failed)";
    reasons.push("sqlite quick_check failed; integrity could not be verified");
  }

  if (unknownTablesRaw.length > 0) {
    reasons.push(
      `unknown tables outside the v0.1 plugin schema will not be translated: ${unknownTablesRaw.length} table(s), reported as opaque digested identifiers`,
    );
  }

  return {
    finding: { userVersion, schemaMarkers, knownTables, unknownTables, missingTables: missing.sort(), extraColumns, integrity },
    reasons,
  };
}

// ---------------- Memory lane classification ----------------

type LaneTag =
  | "personal-eligible"
  | "persona-lane-inactive"
  | "review-required"
  | "quarantine-proposed"
  | "preserved-forgotten"
  | "preserved-migrated"
  | "preserved-quarantined"
  | "preserved-decayed"
  | "task-handoff-candidate"
  | "missing-meta";

const INJECTABLE_PROVENANCES = new Set(["user", "persona"]);

function classifyMemory(kind: string, status: string, provenance: string | null): LaneTag {
  if (provenance == null) return "missing-meta";
  if (status === "forgotten") return "preserved-forgotten";
  if (status === "migrated") return "preserved-migrated";
  if (status === "quarantined") return "preserved-quarantined";
  if (status === "decayed") return "preserved-decayed";
  if (kind === "instruction") return "quarantine-proposed"; // v1 rule re-asserted conservatively
  if (!INJECTABLE_PROVENANCES.has(provenance)) {
    if (provenance === "assistant" || provenance === "derived") return "review-required";
    return "quarantine-proposed"; // unknown/system/tool/skill/coordinator producers never become personal authority
  }
  if (kind === "persona") return "persona-lane-inactive"; // prose stays reviewable, never activated here
  if (kind === "event") return "task-handoff-candidate"; // Phase C handoff lane with explicit source
  if (status !== "active" && status !== "corrected") return "quarantine-proposed";
  return "personal-eligible";
}

const REMAINING_GATES = [
  "Phase B: the real import writer (seq-zero-safe cursors, transactional acknowledgment, source dedup by identity) does not exist; this increment is inventory + projection only",
  "Phase B: crash-boundary guarantee (every enqueue/commit boundary — no data loss, no duplicate evidence) is unproven",
  "Cutover: one-writer switch, checksummed backup manifest (WAL-inclusive snapshot, settings/patch layers, skill revisions) and v0.2 one-time settings-import outcome inspection are pending",
  "Phase C: handoff lane and Sessions UX pending; task-scoped rows are counted, not converted",
  "Phase D: operational-learning consent is proposed unchanged; activation remains gated until verified",
];

// ---------------- Settings mapping ----------------

const LEGACY_DEFAULTS: Record<string, unknown> = {
  enabled: true,
  debug: false,
  storageRoot: "",
  searchLimit: 5,
  modules: { capture: true, extract: true, consolidate: true, evolve: true, recall: true, tools: true },
  extract: {
    intervalMinutes: 15, batchMaxChars: 12000, maxOutputTokens: 2000, timeoutMs: 60000, dedup: true,
    fallbackOnBadJson: false, minImportance: 6, flushDrain: false, model: "", provider: "",
    provenanceFilter: "strict", requireEvidence: true,
  },
  recall: {
    strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, maxInjectChars: 800,
    relevanceMargin: 0.5, minImportance: 0, maxInjectPerTurn: 4,
    embedding: { baseUrl: "", apiKey: "", model: "", dimensions: 1024, timeoutMs: 10000 },
  },
  consolidate: { scenesEnabled: false, sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 },
  evolve: {
    decay: { enabled: true, minAgeDays: 7, threshold: 2, retentionDays: 180, maxActiveMemories: 500 },
    skillSynthesis: { enabled: false, minImportance: 7, skillsRoot: "", prefix: "dsi-", maxSkills: 100 },
  },
  housekeeping: { personaVersions: 10, maxScenes: 50, sceneActiveRatio: 0.3, conversationRetentionDays: 90 },
  review: { enabled: true, time: "22:00" },
  episodeLearning: {
    enabled: false, captureArguments: true, resultExcerptChars: 4000, retentionDays: 90,
    reviewEnabled: true, confidenceFloor: 0.8, expiryDays: 90, operationalRecallEnabled: false,
    maxRecallResults: 2, maxRecallChars: 600, skillMinEpisodes: 2, skillDraftsEnabled: false,
  },
};

interface MapRule {
  /** legacy path, or an ancestor prefix ending in ".*" */
  path: string;
  action: MappingAction;
  target?: string;
  note?: string;
}

const SETTINGS_MAP: MapRule[] = [
  { path: "modules.*", action: "retire", target: "laneSwitches", note: "replaced by consented v0.2 lanes; bare module off-switches are not carried into a broader-surface config" },
  { path: "enabled", action: "carry", target: "memoryAndLearning.rememberUsefulFacts", note: "off keeps saved data (same contract as legacy)" },
  { path: "debug", action: "carry", target: "advanced.diagnostics.debug" },
  { path: "searchLimit", action: "carry", target: "advanced.retrieval.toolSearchLimit" },
  { path: "storageRoot", action: "migrationOnly", note: "a storage-root change is an explicit migration workflow, never a live config-field write; the value is not carried automatically" },
  { path: "extract.intervalMinutes", action: "carry", target: "advanced.extraction.cadenceMinutes" },
  { path: "extract.batchMaxChars", action: "carry", target: "advanced.extraction.batchCharsBudget" },
  { path: "extract.maxOutputTokens", action: "carry", target: "advanced.extraction.maxOutputTokens" },
  { path: "extract.timeoutMs", action: "carry", target: "advanced.extraction.timeoutMs" },
  { path: "extract.dedup", action: "carry", target: "advanced.extraction.deduplicate" },
  { path: "extract.fallbackOnBadJson", action: "retire", target: "advanced.extraction.fallbackOnBadJson", note: "not a safe default; malformed model output must remain failed/retryable rather than be recovered blindly" },
  { path: "extract.minImportance", action: "carry", target: "advanced.extraction.importanceFloor" },
  { path: "extract.flushDrain", action: "retire", target: "worker.flushDrain", note: "Phase B's durable job ledger replaces flush drains; not carried" },
  { path: "extract.model", action: "carry", target: "advanced.extraction.modelRoute.model" },
  { path: "extract.provider", action: "carry", target: "advanced.extraction.modelRoute.provider" },
  { path: "extract.provenanceFilter", action: "migrationOnly", note: "only 'strict' is supported; unsafe provenance bypass is migration-only, never an ordinary advanced toggle" },
  { path: "extract.requireEvidence", action: "carry", target: "advanced.extraction.requireEvidence" },
  { path: "recall.strategy", action: "carry", target: "advanced.retrieval.strategy" },
  { path: "recall.maxResults", action: "carry", target: "advanced.retrieval.maxResults" },
  { path: "recall.scoreThreshold", action: "carry", target: "advanced.retrieval.scoreThreshold" },
  { path: "recall.timeoutMs", action: "carry", target: "advanced.retrieval.timeoutMs" },
  { path: "recall.maxInjectChars", action: "carry", target: "advanced.retrieval.maxInjectChars" },
  { path: "recall.relevanceMargin", action: "carry", target: "advanced.retrieval.relevanceMargin" },
  { path: "recall.minImportance", action: "carry", target: "advanced.retrieval.importanceFloor" },
  { path: "recall.maxInjectPerTurn", action: "carry", target: "advanced.retrieval.maxInjectPerTurn" },
  { path: "recall.embedding.dimensions", action: "defer", target: "advanced.retrieval.vectorDimensions", note: "vectors are disposable indexes; keyword recall must work without them" },
  { path: "recall.embedding.baseUrl", action: "carry", target: "advanced.retrieval.embeddingConnection.baseUrl" },
  { path: "recall.embedding.model", action: "carry", target: "advanced.retrieval.embeddingConnection.model" },
  { path: "recall.embedding.timeoutMs", action: "carry", target: "advanced.retrieval.embeddingConnection.timeoutMs" },
  { path: "recall.embedding.apiKey", action: "secret", note: "presence-only carry; a credential reference must be re-established and served credentials are never copied into reports or form drafts" },
  { path: "consolidate.scenesEnabled", action: "defer", target: "experimental.sceneGrouping", note: "L2 scene grouping stays an optional off-by-default experiment" },
  { path: "consolidate.sceneMaxMemories", action: "defer", target: "experimental.sceneGrouping" },
  { path: "consolidate.sceneBatchSize", action: "defer", target: "experimental.sceneGrouping" },
  { path: "consolidate.personaMaxMemories", action: "carry", target: "profile.renderBudget", note: "deterministic profile rendering from structured facts replaces recurring generated prose" },
  { path: "evolve.decay.enabled", action: "retire", target: "governance.timeDecay", note: "no silent time-based decay of protected confirmed preferences; retirement stays evidence-based" },
  { path: "evolve.decay.minAgeDays", action: "retire", target: "governance.timeDecay" },
  { path: "evolve.decay.threshold", action: "retire", target: "governance.timeDecay" },
  { path: "evolve.decay.retentionDays", action: "carry", target: "governance.retentionDays" },
  { path: "evolve.decay.maxActiveMemories", action: "carry", target: "governance.maxActiveMemories" },
  { path: "evolve.skillSynthesis.*", action: "retire", target: "skills.automaticSynthesis", note: "the v0.2 skill lane is draft → evaluation → human activation; automatic synthesis gates are not carried and generated skills stay inactive" },
  { path: "evolve.skillSynthesis.skillsRoot", action: "migrationOnly", note: "source skill repo location; generated skills remain reviewable-but-inactive and the path itself is not carried into live config" },
  { path: "housekeeping.personaVersions", action: "carry", target: "governance.profileVersions" },
  { path: "housekeeping.maxScenes", action: "defer", target: "experimental.sceneGrouping" },
  { path: "housekeeping.sceneActiveRatio", action: "defer", target: "experimental.sceneGrouping" },
  { path: "housekeeping.conversationRetentionDays", action: "carry", target: "retention.rawSliceDays" },
  { path: "review.enabled", action: "carry", target: "backgroundReview.mode", note: "maps to off / when-idle / scheduled; proposed conservatively as the equal mode" },
  { path: "review.time", action: "carry", target: "backgroundReview.scheduledTime" },
  { path: "episodeLearning.enabled", action: "carry", target: "operationalLearning.captureConsent", note: "carried unchanged: old consent never silently enables a broader new capture policy" },
  { path: "episodeLearning.captureArguments", action: "carry", target: "operationalLearning.redactionScope" },
  { path: "episodeLearning.resultExcerptChars", action: "carry", target: "operationalLearning.redactedExcerptCap" },
  { path: "episodeLearning.retentionDays", action: "carry", target: "retention.episodeDays" },
  { path: "episodeLearning.reviewEnabled", action: "carry", target: "operationalLearning.reviewEnabled" },
  { path: "episodeLearning.confidenceFloor", action: "carry", target: "operationalLearning.confidenceFloor" },
  { path: "episodeLearning.expiryDays", action: "carry", target: "operationalLearning.lessonExpiryDays" },
  { path: "episodeLearning.operationalRecallEnabled", action: "carry", target: "operationalLearning.recallEnabled" },
  { path: "episodeLearning.maxRecallResults", action: "carry", target: "operationalLearning.recallMaxResults" },
  { path: "episodeLearning.maxRecallChars", action: "carry", target: "operationalLearning.recallMaxChars" },
  { path: "episodeLearning.skillMinEpisodes", action: "carry", target: "operationalLearning.minIndependentSupport" },
];

const SECRET_KEY_PATTERN = /api_?key|password|secret|credential|token/i;
const ENTRY_ID = "self-improved";

function findRule(path: string): MapRule | undefined {
  const exact = SETTINGS_MAP.find((r) => r.path === path);
  if (exact) return exact;
  const parts = path.split(".");
  for (let cut = parts.length - 1; cut >= 1; cut--) {
    const prefix = parts.slice(0, cut).join(".") + ".*";
    const rule = SETTINGS_MAP.find((r) => r.path === prefix);
    if (rule) return rule;
  }
  return undefined;
}

interface SettingsLeaf {
  path: string;
  value: unknown;
  kind: "boolean" | "number" | "string";
}

function flattenValue(prefix: string, value: unknown, out: SettingsLeaf[]): void {
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    out.push({ path: prefix, value, kind: typeof value as SettingsLeaf["kind"] });
    return;
  }
  if (value === null || value === undefined || Array.isArray(value)) {
    // nulls and sequences cannot be mapped conservatively; a presence-only leaf is safer
    out.push({ path: prefix, value: null, kind: "string" });
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      flattenValue(prefix ? `${prefix}.${key}` : key, child, out);
    }
  }
}

function equalsLegacyDefault(path: string, value: unknown): boolean {
  let cursor: unknown = LEGACY_DEFAULTS;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (value === null || value === undefined) return cursor === null || cursor === undefined;
  return cursor === value && typeof cursor === typeof value;
}

/** Minimal YAML block-map reader; JSON is accepted first. Unsupported grammar is refused loudly, never guessed. */
export function parseSettingsDocument(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("settings JSON must be an object");
  }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];
  for (const rawLine of text.split(/\r?\n/)) {
    const withoutComment = rawLine.replace(/(^|\s)#.*$/, "$1");
    const line = withoutComment.replace(/\t/g, "  ").trimEnd();
    if (line.trim() === "") continue;
    if (/^\s*-\s/.test(line) || line.includes(" - ")) {
      throw new Error("YAML sequences are not supported by the conservative settings reader");
    }
    const match = /^(\s*)([^:#]+):\s*(.*)$/.exec(line);
    if (!match) {
      // Adversarial/error-string privacy: the raw settings line can contain
      // arbitrary private text, so the error names the 1-based line ordinal
      // only and never echoes the offending content.
      throw new Error(`unparseable settings line ordinal ${text.split(/\r?\n/).indexOf(rawLine) + 1} (line content withheld; only key: value block-map lines are supported)`);
    }
    const indent = match[1].length;
    const key = match[2].trim();
    const valueText = match[3].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].obj;
    if (valueText === "") {
      const child: Record<string, unknown> = {};
      parent[key] = child;
      stack.push({ indent, obj: child });
      continue;
    }
    if (valueText.length >= 2 && ((valueText.startsWith('"') && valueText.endsWith('"')) || (valueText.startsWith("'") && valueText.endsWith("'")))) {
      parent[key] = valueText.slice(1, -1);
    } else if (valueText === "true" || valueText === "false") {
      parent[key] = valueText === "true";
    } else if (valueText === "null" || valueText === "~") {
      parent[key] = null;
    } else if (/^-?\d+(\.\d+)?$/.test(valueText)) {
      parent[key] = Number(valueText);
    } else {
      parent[key] = valueText;
    }
  }
  return root;
}

function readSettingsEntry(settingsPath: string): { doc?: Record<string, unknown>; error?: string } {
  let text: string;
  try {
    text = readFileSync(settingsPath, "utf8");
  } catch (e) {
    return { error: `settings file unreadable: ${(e as Error).message}` };
  }
  try {
    return { doc: parseSettingsDocument(text) };
  } catch (e) {
    return { error: `settings parse failed (conservative refusal): ${(e as Error).message}` };
  }
}

function locateEntryId(doc: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = doc[ENTRY_ID];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const plugins = doc.plugins;
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    const nested = (plugins as Record<string, unknown>)[ENTRY_ID];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return undefined;
}

function buildSettingsSection(doc: Record<string, unknown> | undefined, parseError?: string): SettingsSection {
  if (!doc) {
    return {
      entryId: ENTRY_ID,
      found: false,
      leaves: 0,
      mapped: [], deferred: [], secrets: [], unmapped: [], migrationOnly: [], retired: [],
      note: "no self-improved settings entry located; nothing is proposed from it",
      parseError,
    };
  }
  const entry = locateEntryId(doc);
  if (!entry) {
    return {
      entryId: ENTRY_ID,
      found: false,
      leaves: 0,
      mapped: [], deferred: [], secrets: [], unmapped: [], migrationOnly: [], retired: [],
      note: `no "${ENTRY_ID}" entry found in the provided document; propose nothing without it`,
    };
  }
  const leaves: SettingsLeaf[] = [];
  flattenValue("", entry, leaves);
  const mapped: MappingEntry[] = [];
  const deferred: MappingEntry[] = [];
  const secrets: MappingEntry[] = [];
  const unmapped: MappingEntry[] = [];
  const migrationOnly: MappingEntry[] = [];
  const retired: MappingEntry[] = [];
  for (const leaf of leaves) {
    const secretLike = SECRET_KEY_PATTERN.test(leaf.path) || leaf.path.endsWith(".apiKey");
    if (secretLike) {
      secrets.push({
        path: leaf.path,
        action: "secret",
        equalsDefault: equalsLegacyDefault(leaf.path, leaf.value),
        present: true,
        valueKind: leaf.kind,
        note: "presence-only; the value itself is never reported, exported or carried",
      });
      continue;
    }
    const rule = findRule(leaf.path);
    const entry0: MappingEntry = {
      path: leaf.path,
      action: rule?.action ?? "unmapped",
      target: rule?.target,
      equalsDefault: equalsLegacyDefault(leaf.path, leaf.value),
      valueKind: leaf.kind,
      note: rule?.note ?? "unknown settings leaf: reported presence-only; values may be anything and are never transferred",
    };
    switch (entry0.action) {
      case "carry": {
        if (typeof leaf.value === "boolean" || typeof leaf.value === "number" || (typeof leaf.value === "string" && safeCarryValue(leaf.value))) {
          entry0.value = leaf.value;
        } else {
          entry0.present = true; // value withheld, presence-only even on a mapped carry leaf
        }
        mapped.push(entry0);
        break;
      }
      case "defer":
        entry0.present = true;
        deferred.push(entry0);
        break;
      case "migrationOnly":
        entry0.present = true;
        migrationOnly.push(entry0);
        break;
      case "retire":
        entry0.present = true;
        retired.push(entry0);
        break;
      default:
        entry0.action = "unmapped";
        entry0.present = true;
        unmapped.push(entry0);
    }
  }
  return {
    entryId: ENTRY_ID,
    found: true,
    leaves: leaves.length,
    mapped,
    deferred,
    secrets,
    unmapped,
    migrationOnly,
    retired,
    note: "mapping proposal only; v0.2's one-time legacy settings import outcome must be inspected at cutover rather than assumed. Only mapped non-secret carry values appear here; every other leaf is presence-only",
  };
}

function consentFromCarried(section: SettingsSection, path: string): boolean | undefined {
  const hit = section.mapped.find((m) => m.path === path);
  if (!hit) return undefined;
  return typeof hit.value === "boolean" ? hit.value : undefined;
}

/** A string value is carried only when it cannot smuggle credentials or URLs with userinfo. */
function safeCarryValue(value: unknown): boolean {
  if (typeof value !== "string") return true;
  return !/[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i.test(value) && !/(key|token|secret|credential|sig)\s*=\s*[^&\s"']+/i.test(value);
}

// ---------------- Conversation slices (counts only; never text) ----------------

interface ConversationAudit {
  fileCount: number;
  totalBytes: number;
  totalLines: number;
  validLines: number;
  malformedLines: number;
  duplicateSessionSeqLines: number;
  sessionsWithSeqZero: number;
  fileSessionsWithoutCursor: number;
  sessionsWithoutFile: number;
  backlogValidSlices: number;
}

function auditConversations(sourceRoot: string, cursors: Map<string, { processed: number; pending: number }>): ConversationAudit {
  const dir = join(sourceRoot, "conversations");
  const audit: ConversationAudit = {
    fileCount: 0, totalBytes: 0, totalLines: 0, validLines: 0, malformedLines: 0,
    duplicateSessionSeqLines: 0, sessionsWithSeqZero: 0,
    fileSessionsWithoutCursor: 0, sessionsWithoutFile: 0, backlogValidSlices: 0,
  };
  if (!existsSync(dir)) return audit;
  const stems = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      audit.malformedLines++; // vanished/raced entry: acknowledged as unevaluable, never silently skipped as valid
      continue;
    }
    if (!st.isFile()) continue;
    audit.fileCount++;
    audit.totalBytes += st.size;
    const stem = name.slice(0, -".jsonl".length);
    stems.add(stem);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      audit.malformedLines++;
      continue;
    }
    const cursor = cursors.get(stem);
    const isBacklog = cursor != null && cursor.pending > cursor.processed;
    const seen = new Set<number>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      audit.totalLines++;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rec = JSON.parse(trimmed) as { seq?: unknown };
        if (typeof rec.seq !== "number") throw new Error("no seq");
        if (seen.has(rec.seq)) audit.duplicateSessionSeqLines++;
        seen.add(rec.seq);
        audit.validLines++;
        if (rec.seq === 0) audit.sessionsWithSeqZero++;
        if (isBacklog && cursor != null && rec.seq > cursor.processed) audit.backlogValidSlices++;
      } catch {
        audit.malformedLines++;
      }
    }
  }
  for (const sessionId of cursors.keys()) {
    if (!stems.has(sessionId)) audit.sessionsWithoutFile++;
  }
  for (const stem of stems) {
    if (!cursors.has(stem)) audit.fileSessionsWithoutCursor++;
  }
  return audit;
}

// ---------------- Derived-material audits ----------------

function auditSkills(skillsRoot: string | undefined): Counts["skills"] {
  const out: Counts["skills"] = { generatedPrefixedDirs: 0, withSkillMd: 0, names: [], nonPrefixedDirs: 0 };
  if (!skillsRoot || !existsSync(skillsRoot)) return out;
  for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(SKILL_PREFIX)) {
      out.generatedPrefixedDirs++;
      out.names.push(entry.name);
      if (existsSync(join(skillsRoot, entry.name, "SKILL.md"))) out.withSkillMd++;
    } else {
      out.nonPrefixedDirs++;
    }
  }
  out.names.sort();
  return out;
}

function auditPersona(sourceRoot: string, db: DatabaseSync): Counts["persona"] {
  const versions = scalarCount(db, "SELECT COUNT(*) AS n FROM persona_versions");
  const maxVer = scalarCount(db, "SELECT COALESCE(MAX(ver), 0) AS n FROM persona_versions");
  const files: Array<{ name: string; bytes: number }> = [];
  const dir = join(sourceRoot, "persona");
  if (existsSync(dir)) {
    for (const name of readdirSync(dir)) {
      let st;
      try {
        st = statSync(join(dir, name));
      } catch {
        continue; // raced entry: not counted as a persona artifact
      }
      if (st.isFile()) files.push({ name, bytes: st.size });
    }
  }
  files.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { versions, maxVer, files };
}

function auditVectors(sourceRoot: string): Counts["vectors"] {
  const path = join(sourceRoot, "vectors.db");
  if (!existsSync(path)) {
    return { available: false, note: "no vectors.db (sqlite-vec disabled or embeddings never produced)" };
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(path, { readOnly: true });
    if (!tableNames(db).includes("memory_vec")) {
      return { available: false, note: "vectors.db exists but has no memory_vec table; the legacy runtime ran without sqlite-vec" };
    }
    return { available: true, embeddings: scalarCount(db, "SELECT COUNT(*) AS n FROM memory_vec") };
  } catch (e) {
    return { available: false, note: `vectors.db could not be read read-only: ${(e as Error).message}` };
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}

// ---------------- Memory analysis ----------------

interface MemoryAnalysis {
  tallies: {
    byStatus: Record<string, number>;
    byKind: Record<string, number>;
    byProvenance: Record<string, number>;
    bySource: Record<string, number>;
    byScope: Record<string, number>;
    lanes: Record<string, number>;
    missingMeta: number;
    total: number;
  };
  eligibleRows: Array<{ id: string; scope: string; projectId: string | null; createdAt: number; updatedAt: number; supersedes: string | null }>;
  supersessionChains: number;
  brokenSupersedes: number;
  evidenceEntries: number;
  evidenceUnverifiable: number;
  pastedDemoted: number;
  quarantinedByLane: Record<string, number>;
  approxPersonalContentBytes: number;
}

function analyzeMemories(db: DatabaseSync): MemoryAnalysis {
  const episodeIds = new Set<string>();
  try {
    const rows = db.prepare("SELECT id FROM episodes LIMIT ?").all(MAX_EPISODE_IDS) as Array<{ id: unknown }>;
    for (const r of rows) episodeIds.add(String(r.id));
  } catch {
    /* episodes table absent → also surfaced by schema classification */
  }
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.kind AS kind, m.status AS status, m.created_at AS created_at,
              m.updated_at AS updated_at, m.supersedes AS supersedes, length(m.content) AS content_bytes,
              mm.provenance AS provenance, mm.source AS source, mm.scope AS scope,
              mm.project_id AS project_id, mm.evidence AS evidence
       FROM memories m LEFT JOIN memories_meta mm ON mm.memory_id = m.id
       ORDER BY m.created_at, m.id LIMIT ?`,
    )
    .all(MAX_MEMORY_ROWS) as Array<Record<string, unknown>>;

  const analysis: MemoryAnalysis = {
    tallies: { byStatus: {}, byKind: {}, byProvenance: {}, bySource: {}, byScope: {}, lanes: {}, missingMeta: 0, total: 0 },
    eligibleRows: [],
    supersessionChains: 0,
    brokenSupersedes: 0,
    evidenceEntries: 0,
    evidenceUnverifiable: 0,
    pastedDemoted: 0,
    quarantinedByLane: {},
    approxPersonalContentBytes: 0,
  };
  const ids = new Set(rows.map((r) => String(r.id)));
  for (const r of rows) {
    analysis.tallies.total++;
    // Free-string category columns are bounded: values inside the legacy
    // contract vocabulary are reported verbatim; anything else is a digested
    // opaque identifier (a drifted store can store arbitrary text here).
    const kind = reportKey(String(r.kind ?? "(missing)"), KNOWN_MEMORY_KIND);
    const status = reportKey(String(r.status ?? "(missing)"), KNOWN_MEMORY_STATUS);
    const provenance = r.provenance == null
      ? null
      : reportKey(String(r.provenance), KNOWN_MEMORY_PROVENANCE);
    const source = r.source == null
      ? "(missing-meta)"
      : reportKey(String(r.source), KNOWN_MEMORY_SOURCE);
    // scope is explicitly allowed preservation metadata and stays verbatim.
    const scope = r.scope == null ? "(missing-meta)" : String(r.scope);
    // lane classification uses the RAW values to stay byte-faithful to the store
    const kindRaw = String(r.kind ?? "(missing)");
    const statusRaw = String(r.status ?? "(missing)");
    const provenanceRaw = r.provenance == null ? null : String(r.provenance);
    if (r.provenance == null) analysis.tallies.missingMeta++;
    analysis.tallies.byStatus[status] = (analysis.tallies.byStatus[status] ?? 0) + 1;
    analysis.tallies.byKind[kind] = (analysis.tallies.byKind[kind] ?? 0) + 1;
    analysis.tallies.byProvenance[provenance ?? "(missing-meta)"] = (analysis.tallies.byProvenance[provenance ?? "(missing-meta)"] ?? 0) + 1;
    analysis.tallies.bySource[source] = (analysis.tallies.bySource[source] ?? 0) + 1;
    analysis.tallies.byScope[scope] = (analysis.tallies.byScope[scope] ?? 0) + 1;

    const lane = classifyMemory(kindRaw, statusRaw, provenanceRaw);
    analysis.tallies.lanes[lane] = (analysis.tallies.lanes[lane] ?? 0) + 1;

    const supersedes = r.supersedes == null ? null : String(r.supersedes);
    if (supersedes !== null) {
      analysis.supersessionChains++;
      if (!ids.has(supersedes)) analysis.brokenSupersedes++;
    }
    if (r.evidence != null) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entries = JSON.parse(String(r.evidence)) as Array<any>;
        for (const entry of entries) {
          analysis.evidenceEntries++;
          const episodeRef = entry?.episodeId != null ? String(entry.episodeId) : null;
          if (episodeRef !== null && !episodeIds.has(episodeRef)) analysis.evidenceUnverifiable++;
        }
      } catch {
        analysis.evidenceUnverifiable++;
      }
    }
    if (source === "llm-extract-pasted") analysis.pastedDemoted++;

    if (
      lane === "personal-eligible" ||
      lane === "task-handoff-candidate" ||
      lane === "persona-lane-inactive" ||
      lane === "review-required"
    ) {
      analysis.eligibleRows.push({
        id: String(r.id),
        scope,
        projectId: r.project_id == null ? null : String(r.project_id),
        createdAt: Number(r.created_at ?? 0),
        updatedAt: Number(r.updated_at ?? 0),
        supersedes,
      });
    } else {
      analysis.quarantinedByLane[lane] = (analysis.quarantinedByLane[lane] ?? 0) + 1;
    }
    if (lane === "personal-eligible") {
      const bytes = Number(r.content_bytes ?? 0);
      if (Number.isFinite(bytes)) analysis.approxPersonalContentBytes += bytes;
    }
  }
  return analysis;
}

function conflictAudit(db: DatabaseSync): ConflictAudit {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.kind AS kind, m.created_at AS created_at, m.content AS content,
              mm.scope AS scope, mm.project_id AS project_id
       FROM memories m JOIN memories_meta mm ON mm.memory_id = m.id
       WHERE m.status IN ('active','corrected') AND mm.provenance IN ('user','persona')
       LIMIT ?`,
    )
    .all(MAX_MEMORY_ROWS) as Array<Record<string, unknown>>;

  interface Bucket {
    id: string;
    kind: string;
    scope: string;
    projectId: string;
    createdAt: number;
    hash: string;
  }
  const groups = new Map<string, Bucket[]>();
  const idToBucket = new Map<string, Bucket>();
  for (const r of rows) {
    // kind/scope enter the report (conflict group entries): kind is bounded to
    // the contract vocabulary, scope is allowed preservation metadata.
    const kind = reportKey(String(r.kind ?? "(missing)"), KNOWN_MEMORY_KIND);
    const scope = r.scope == null ? "(missing)" : String(r.scope);
    const projectId = r.project_id == null ? "" : String(r.project_id);
    const hash = digest(String(r.content ?? "")).slice(0, 8);
    const bucket: Bucket = { id: String(r.id), kind, scope, projectId, createdAt: Number(r.created_at ?? 0), hash };
    const key = `${kind}|${scope}|${projectId}|${hash}`;
    const list = groups.get(key) ?? [];
    list.push(bucket);
    groups.set(key, list);
    idToBucket.set(bucket.id, bucket);
  }

  const duplicateContentGroups: ConflictAudit["duplicateContentGroups"] = [];
  for (const list of groups.values()) {
    if (list.length <= 1) continue;
    duplicateContentGroups.push({
      hash8: list[0].hash,
      ids: list.map((b) => b.id).sort(),
      kind: list[0].kind,
      scope: list[0].scope,
      projectId: list[0].projectId,
      count: list.length,
    });
  }
  duplicateContentGroups.sort((a, b) => b.count - a.count || (a.hash8 < b.hash8 ? -1 : 1));

  // Conflict groups: same preference scope holding different content hashes
  const prefScopes = new Map<string, Bucket[]>();
  for (const bucket of idToBucket.values()) {
    if (bucket.kind !== "preference") continue;
    const key = `${bucket.scope}|${bucket.projectId}`;
    const list = prefScopes.get(key) ?? [];
    if (!list.some((b) => b.id === bucket.id)) list.push(bucket);
    prefScopes.set(key, list);
  }
  const conflictingPreferenceGroups: ConflictAudit["conflictingPreferenceGroups"] = [];
  for (const [key, options] of prefScopes) {
    if (options.length <= 1) continue;
    if (new Set(options.map((o) => o.hash)).size <= 1) continue;
    const [scope, projectId] = key.split("|");
    conflictingPreferenceGroups.push({
      scope,
      projectId,
      options: options
        .map((o) => ({ id: o.id, createdAt: o.createdAt, hash8: o.hash }))
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
    });
  }
  conflictingPreferenceGroups.sort((a, b) => (a.scope < b.scope ? -1 : a.scope > b.scope ? 1 : 0));

  let taskScopedCandidates = 0;
  try {
    // Aliases follow the joined table (mem -> memories, meta -> memories_meta);
    // scope lives on memories_meta, status lives on memories.
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM memories mem JOIN memories_meta meta ON meta.memory_id = mem.id
         WHERE meta.scope = 'session' AND mem.status IN ('active','corrected')`,
      )
      .get() as { n?: unknown } | undefined;
    taskScopedCandidates = Number(row?.n ?? 0);
  } catch {
    taskScopedCandidates = 0;
  }
  return { duplicateContentGroups, conflictingPreferenceGroups, taskScopedCandidates };
}

function auditEpisodes(db: DatabaseSync): Counts["episodes"] {
  const byStatus = groupCounts(db, "SELECT status AS k, COUNT(*) AS n FROM episodes GROUP BY status", KNOWN_EPISODE_STATUS);
  const steps = scalarCount(db, "SELECT COUNT(*) AS n FROM episode_steps");
  const unpairedSteps = scalarCount(db, "SELECT COUNT(*) AS n FROM episode_steps WHERE result_seq IS NULL OR call_seq IS NULL");
  const reviewed = scalarCount(db, "SELECT COUNT(*) AS n FROM episodes WHERE reviewed_at IS NOT NULL");
  const delegatedCount = scalarCount(db, "SELECT COUNT(*) AS n FROM episodes WHERE delegated = 1");
  return { byStatus, steps, unpairedSteps, reviewed, delegated: delegatedCount };
}

function readCursors(db: DatabaseSync): Map<string, { processed: number; pending: number }> {
  const out = new Map<string, { processed: number; pending: number }>();
  try {
    const rows = db.prepare("SELECT session_id, processed_seq, pending_seq FROM extract_state").all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      out.set(String(r.session_id), { processed: Number(r.processed_seq ?? 0), pending: Number(r.pending_seq ?? 0) });
    }
  } catch {
    /* schema findings cover it */
  }
  return out;
}

// ---------------- Projection ----------------

function buildDestinationProjection(
  analysis: MemoryAnalysis,
  cursors: Map<string, { processed: number; pending: number }>,
  conversations: ConversationAudit,
): DestinationProjection {
  const lanes = analysis.tallies.lanes;
  return {
    memoryRows: analysis.tallies.total,
    personalLaneEligible: lanes["personal-eligible"] ?? 0,
    reviewRequired: lanes["review-required"] ?? 0,
    quarantinedProposed: lanes["quarantine-proposed"] ?? 0,
    taskHandoffCandidates: lanes["task-handoff-candidate"] ?? 0,
    personaInactive: lanes["persona-lane-inactive"] ?? 0,
    approxBytesOfProposedPersonalContent: analysis.approxPersonalContentBytes,
    extractionBacklogSessions: [...cursors.values()].filter((c) => c.pending > c.processed).length,
    extractionBacklogValidSlices: conversations.backlogValidSlices,
    heuristicCostNote:
      "backlog figures count source slices, not proven candidates; v0.2 consumes bounded ranges with deterministic acceptance, so this is an upper bound and no provider cost is asserted",
  };
}

// ---------------- Orchestrator ----------------

export function buildMigrationReport(options: DryRunOptions, mode: "inventory" | "dry-run"): MigrationReport {
  const sourceRoot = resolve(options.sourceRoot);
  validateSourceDestination(sourceRoot, options.destinationRoot);
  if (options.settingsPath) assertNoSymlinkComponents(resolve(options.settingsPath));
  if (options.skillsRoot) {
    const skillsRoot = resolve(options.skillsRoot);
    assertNoSymlinkComponents(skillsRoot);
    refuseSymlinkedContent(skillsRoot, "the skills root");
  }
  assertNoSymlinkComponents(sourceRoot);
  refuseSymlinkedContent(sourceRoot, "the source store tree");

  const before = digestDirectory(sourceRoot);
  const snapshot = takeSnapshot(sourceRoot);
  try {
    const db = snapshot.db;
    const { finding, reasons } = classifySchema(db);
    const supported = reasons.length === 0;
    const cursors = readCursors(db);
    const conversations = auditConversations(sourceRoot, cursors);
    const analysis = analyzeMemories(db);
    const episodes = auditEpisodes(db);
    const persona = auditPersona(sourceRoot, db);
    const skills = auditSkills(options.skillsRoot);
    const vectors = auditVectors(sourceRoot);

    const settingsBlock: SettingsSection | undefined = options.settingsPath
      ? (() => {
          const parsed = readSettingsEntry(options.settingsPath as string);
          return buildSettingsSection(parsed.doc, parsed.error);
        })()
      : undefined;

    const preservation: Preservation = {
      proposedMemoryRows: analysis.eligibleRows.length,
      sampleIds: analysis.eligibleRows.slice(0, 50).map((r) => r.id),
      idsPreserved: analysis.tallies.total,
      scopesPreserved: analysis.eligibleRows.filter((r) => r.scope !== "(missing-meta)").length,
      timestampsPreserved: analysis.eligibleRows.length,
      supersessionChains: analysis.supersessionChains,
      brokenSupersedes: analysis.brokenSupersedes,
      evidenceEntries: analysis.evidenceEntries,
      evidenceUnverifiable: analysis.evidenceUnverifiable,
      pastedDemotedOwnScopeOnly: analysis.pastedDemoted,
      quarantinedByLane: analysis.quarantinedByLane,
    };

    const projected = buildDestinationProjection(analysis, cursors, conversations);

    const operationalConsent: LaneStatus["operational"]["sourceConsent"] = settingsBlock
      ? {
          captureOn: consentFromCarried(settingsBlock, "episodeLearning.enabled"),
          reviewOn: consentFromCarried(settingsBlock, "episodeLearning.reviewEnabled"),
          captureArguments: consentFromCarried(settingsBlock, "episodeLearning.captureArguments"),
          operationalRecallOn: consentFromCarried(settingsBlock, "episodeLearning.operationalRecallEnabled"),
        }
      : {};

    const counts: Counts = {
      memories: {
        byStatus: analysis.tallies.byStatus,
        byKind: analysis.tallies.byKind,
        byProvenance: analysis.tallies.byProvenance,
        bySource: analysis.tallies.bySource,
        byScope: analysis.tallies.byScope,
        missingMeta: analysis.tallies.missingMeta,
        total: analysis.tallies.total,
      },
      conversations: {
        fileCount: conversations.fileCount,
        totalBytes: conversations.totalBytes,
        totalLines: conversations.totalLines,
        validLines: conversations.validLines,
        malformedLines: conversations.malformedLines,
        duplicateSessionSeqLines: conversations.duplicateSessionSeqLines,
        sessionsWithSeqZero: conversations.sessionsWithSeqZero,
        fileSessionsWithoutCursor: conversations.fileSessionsWithoutCursor,
        sessionsWithoutFile: conversations.sessionsWithoutFile,
      },
      episodes,
      persona,
      skills,
      vectors,
      baseline: { pins: scalarCount(db, "SELECT COUNT(*) AS n FROM baseline") },
      cursors: {
        sessions: cursors.size,
        processedAtZero: [...cursors.values()].filter((c) => c.processed === 0).length,
        pendingSessions: [...cursors.values()].filter((c) => c.pending > c.processed).length,
      },
      projection: projected,
    };

    const after = digestDirectory(sourceRoot);
    const schemaRecheck = recheckSourceSchema(sourceRoot);
    const schemaUnchanged =
      schemaRecheck !== undefined && JSON.stringify(schemaRecheck.finding) === JSON.stringify(finding);

    const report: MigrationReport = {
      reportVersion: 1,
      phase: "A",
      mode,
      tool: {
        pluginId: ENTRY_ID,
        legacyTarget: "v0.1 dsh-self-improved store (schema_state v1+v2, STRICT tables)",
        sourceReader: "node:sqlite readOnly + VACUUM INTO snapshot (WAL-inclusive); no mutating handles",
      },
      source: {
        storeRoot: sourceRoot,
        memoryDb: { exists: true, bytes: snapshot.memoryDbDigest.bytes, sha256: snapshot.memoryDbDigest.sha256 },
      },
      supported,
      unsupportedReason: reasons,
      schema: finding,
      counts,
      preservation,
      conflicts: conflictAudit(db),
      lanes: {
        persona: { recorded: persona.versions > 0, versions: persona.versions, migrationActivation: "inactive" },
        skills: { recorded: skills.generatedPrefixedDirs > 0, generatedCount: skills.generatedPrefixedDirs, migrationActivation: "inactive" },
        operational: {
          sourceConsent: operationalConsent,
          proposal: { notExpanded: true, sameOrNarrower: true, reconfirmAtCutover: true },
        },
      },
      settings: settingsBlock,
      safety: {
        sourceUnchanged: digestsEqual(before, after),
        sourceFileCount: before.files.length,
        sourceSchemaUnchanged: schemaUnchanged,
        snapshotIsolated: true,
        noMutationOnSource: true,
        destinationTouched: false,
        destinationValidated: options.destinationRoot != null,
        rawContentInReport: false,
        onlineBackupContract:
          "Cut-over backup must come from a transactionally consistent snapshot (VACUUM INTO over a quiesced/checkpointed writer set, or a real SQLite online backup); copying a live database file alone can miss WAL frames and is not accepted",
        determinismNote: "No wall-clock or temp-path entropy enters the report; identical inputs give identical bytes.",
      },
      gates: REMAINING_GATES,
    };

    if (!digestsEqual(before, after)) {
      reasons.push("source files changed during analysis; the inventory is not trustworthy for a proposal");
      report.supported = false;
      report.unsupportedReason = reasons;
    } else if (!schemaUnchanged) {
      reasons.push("source SQLite schema changed during analysis; the inventory is not trustworthy for a proposal");
      report.supported = false;
      report.unsupportedReason = reasons;
    }
    return report;
  } finally {
    closeSnapshot(snapshot);
  }
}

/**
 * Second read-only schema classification straight against the source memory.db
 * (not the snapshot) after all analysis finished. This is the "schema unchanged
 * around the dry-run" verification; snapshot-only checks could not see a source
 * schema swap between snapshot creation and the end of analysis.
 */
function recheckSourceSchema(sourceRoot: string): { finding: SchemaFinding } | undefined {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(sourceRoot, "memory.db"), { readOnly: true });
    const { finding } = classifySchema(db);
    return { finding };
  } catch {
    return undefined; // surfaced as schemaUnchanged=false, i.e. non-trustable
  } finally {
    try {
      db?.close();
    } catch {
      /* noop */
    }
  }
}
