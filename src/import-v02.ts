/**
 * Phase B import increment — MIGRATION-V0.2.md § "Actual migration of existing
 * data" steps 2 and 4: a reviewed, digest-bound, two-phase (dry-run plan →
 * approved apply) LOSSLESS importer of the legacy `self-improved` v0.1 memory
 * store into ONE operator-named isolation destination, writing through the
 * storage import seam (`MemoryStore.importMemoryInTx`,
 * MIGRATION-PHASE-B-IMPORT-SEAM.md) and the store's same-connection
 * transaction handle only — never raw out-of-transaction SQL, never a
 * replacement CLI for the Phase A inventory (`scripts/migrate-v02.mjs` stays
 * untouched; this is the Phase B lane with its own commands).
 *
 * Artifact layout inside the operator-named `--dest` directory (never a live
 * store, never mounted, never cutover-connected):
 *
 *   <dest>/
 *     OWNER.dsh-self-improved-import   fixed owner-marking FIRST LINE +, after
 *                                      it, the wx-created APPROVAL RECORD
 *                                      (one wx file; the record's contents and
 *                                      location are independent of plan.json)
 *     plan.json                        phase-1 digest-bound dry-run plan
 *     ledger.json                      phase-2 per-unit verdict ledger (bounded)
 *     receipt.json                     phase-2 final reconciliation receipt
 *     backup/                          restore-grade BYTE-FAITHFUL private backup
 *     normalized/                      OWNER-marked operational synthetic target
 *
 * Hard safety contract implemented here (each item adversarially asserted by
 * scripts/test-v02-import-lane.mjs on synthetic fixture stores only):
 * - The source is only ever READ: `node:sqlite` opened `readOnly` plus a
 *   transactionally consistent `VACUUM INTO` snapshot (WAL-inclusive). No
 *   mutating handle is ever opened against the source. The source tree CAS
 *   digest (sha256 over the canonical per-file digest list, `-shm` excluded as
 *   a non-durable wal-index cache exactly like Phase A) is verified BEFORE the
 *   first write and re-verified AFTER the last write; a mismatch refuses.
 * - `plan` is strictly a reader of any input role: it only creates the owner
 *   marker + wx approval record and plan.json inside the (validated, fresh)
 *   destination after the Phase A `validateSourceDestination` contract plus an
 *   extended destination containment walk (never inside any input, symlink
 *   components refused); it REFUSES a symlink anywhere inside the SOURCE tree
 *   before any source read, refuses a symlinked or hard-linked `memory.db`
 *   (containment), and re-mints the approval record bound to planDigest +
 *   source digests + the canonical destination root.
 * - `apply` is PLAN-, SOURCE- and APPROVAL-bound: missing/foreign plan,
 *   missing/foreign owner marker, a missing/malformed/foreign approval record
 *   (the wx-created record is verified against the presented plan AND the
 *   canonical current destination before anything is derived; plan.json's own
 *   token proves nothing on its own), plan verdicts that do not equal the
 *   canonical plan freshly RE-DERIVED from the authenticated read-only source
 *   and the lane's supported policy (exact accepted/quarantined/unsupported
 *   row sets + every reconciliation identity), pre-existing target data, a
 *   foreign watermark/plan digest in the target, a source digest delta before
 *   OR during apply, and any family that fails the verdict-count identity each
 *   refuse with the fail-closed semantics below. HONEST BOUND: the approval
 *   record is a binding artifact within the tool's own trust model — it is
 *   NOT proof of a human decision, and a writer with the same OS privileges
 *   as this tool can rewrite the destination (record included) or re-run
 *   `plan`; what the record + rederivation guarantee is that verdicts cannot
 *   be forged without re-planning against a real, authenticated source.
 *   A refusal or a crash can only leave: the committed chunks whose rows and
 *   their SAME-TRANSACTION progress ledger rows committed together, or a
 *   fully rolled-back chunk. The crash-resume watermark lives in store_state
 *   inside the same immediate transaction as the chunk's data rows (journal
 *   same-tx-ack rule); resume re-derives the full per-row ledger from the
 *   target and the plan, never re-imports committed rows (duplicates are
 *   impossible because the collision seam refuses identical ids too).
 * - Two guarantees, deliberately NOT the same one: `backup/` is byte-faithful
 *   restore-grade evidence and therefore contains secrets, quarantined and
 *   unsupported raw material; `normalized/` is the operational minimized
 *   target for the contract identity fields (id/timestamps/status/supersedes/
 *   scopes/confidence/expiresAt and every intact evidence/meta entry) with
 *   exactly one planned minimization — credential-shaped content, evidence
 *   entries or projectId/sessionId id strings are REDACTED BEFORE any
 *   operational write, the row demotes to `status='quarantined'` (row +
 *   identity preserved, unindexed, not injectable, never acknowledged), the
 *   ledger records which parts were redacted (explicit accounting, never a
 *   silent loss), and the raw byte-verbatim copy survives ONLY in the 0700
 *   private `backup/` — never in `normalized/`, its WAL companions, the FTS
 *   index or any lane JSON. A byte cannot be simultaneously lossless and
 *   secret-free when the secret IS the content; that split is the design,
 *   not a hidden limitation.
 * - Privacy-bounded JSON: plan/ledger/receipt carry ids, scopes, timestamps,
 *   contract-vocabulary values, opaque digests and counts only. Memory
 *   content, slice text, persona prose, skill bodies, settings values outside
 *   the conservative carry rule, unknown-marker/table NAMES and quick-check
 *   failure details never enter any emitted JSON.
 * - Determinism: no wall-clock entropy enters the emitted plan/ledger/receipt
 *   JSON — identical inputs produce byte-identical plans (timestamps in the
 *   applied target come only from preserved source data; only SQLite-side
 *   bookkeeping columns use the clock).
 * - Scopes never widened: persona prose, generated `dsi-*` skills and
 *   operational-learning material stay inactive in every artifact and are
 *   never copied into any live skill root or activated anywhere. Conversation
 *   backlog is NOT enqueued into the v0.2 journal (seq-zero / >200k canonical
 *   reread / pre-fix truncation honesty is owned by the journal lanes); legacy
 *   cursors are recorded for orientation, never acknowledged as consumed.
 * - `unsupported-evidenced` is an ACCOUNTING verdict, never an acknowledgment:
 *   nothing is marked consumed, nothing deleted; every item names its source
 *   coordinates and a bounded reason.
 */

import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { MemoryImportCollisionError, MemoryStore } from "./storage.js";
import type {
  MemoryEvidence,
  MemoryKind,
  MemoryMetaInput,
  MemoryProvenance,
  MemoryRecord,
  MemoryScope,
  MemorySource,
  MemoryStatus,
} from "./storage.js";
import { digestDirectory, validateSourceDestination } from "./migration-v02.js";
import type { TreeDigest } from "./migration-v02.js";

// ============================================================================
// Fixed vocabularies (contract wire names; never source text in JSON)
// ============================================================================

export type ImportVerdict =
  | "accepted-verbatim"
  | "retained-quarantined"
  | "unsupported-evidenced";

export type MemoryUnsupportedReason =
  | "missing-meta-side-row"
  | "evidence-not-parseable"
  | "category-out-of-contract-kind"
  | "category-out-of-contract-status"
  | "category-out-of-contract-provenance"
  | "category-out-of-contract-source"
  | "category-out-of-contract-scope"
  | "timestamp-not-preserved"
  | "importance-out-of-range"
  | "meta-field-not-preserved";

export type MemoryQuarantineReason =
  | "credential-content-demotion"
  | "instruction-conservative-demotion"
  | "persona-policy-demotion";

export type PinUnsupportedReason =
  | "dangling-pin-target"
  | "ineligible-pin-provenance";

const MEMORY_KINDS: ReadonlySet<string> = new Set(["fact", "preference", "event", "instruction", "persona"]);
const MEMORY_STATUSES: ReadonlySet<string> = new Set(["active", "decayed", "forgotten", "corrected", "quarantined", "migrated"]);
const MEMORY_PROVENANCES: ReadonlySet<string> = new Set(["user", "assistant", "derived", "system", "tool", "skill", "unknown", "persona", "coordinator"]);
const MEMORY_SOURCES: ReadonlySet<string> = new Set([
  "llm-extract", "llm-extract-pasted", "user-direct", "browser-correct", "tool-correct",
  "baseline-pin", "episode-review", "legacy", "persona",
]);
const MEMORY_SCOPES: ReadonlySet<string> = new Set(["global", "project", "session"]);

/** Same spirit as Phase A's secret scan: credential-shaped content never stays
 *  verbatim authority material in the operational target. */
const SECRET_CONTENT_PATTERN = /api_?key|password|secret|credential|token|bearer /i;
/** URL-with-userinfo or key=value credential smuggling. */
const SECRET_VALUE_PATTERN = /[a-z][a-z0-9+.-]*:\/\/[^/\s]*@/i;

function isCredentialShaped(text: string): boolean {
  return SECRET_CONTENT_PATTERN.test(text) || SECRET_VALUE_PATTERN.test(text);
}

/** Stable deterministic replacement CONTENT for credential-shaped memory
 *  content in the OPERATIONAL target. The raw content exists byte-verbatim
 *  ONLY in the explicit 0700 restore-grade private backup — never in
 *  normalized/, its WAL companions, the FTS index, or any lane JSON. */
export const REDACTED_MEMORY_CONTENT = "[redacted-import:credential-content-demotion]";

/** Stable deterministic tombstone for a credential-shaped evidence ENTRY
 *  (deliberately beyond the MemoryEvidence wire shape: a redaction marker is
 *  not source-derived evidence). */
export const REDACTED_EVIDENCE_ENTRY = { redacted: "credential-content-demotion" };

const CHUNK_ROWS = 100;
const DERIVED_CHUNK_ROWS = 1_000;
const MAX_MEMORY_ROWS = 50_000;
const MAX_EPISODE_IDS = 200_000;
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");

const OWNER_MARKER_NAME = "OWNER.dsh-self-improved-import";
const OWNER_MARKER_TEXT = "dsh-self-improved-import-isolation-owner";
const IMPORT_STATE_KEY = "import-v0.2-phase-b";
const IMPORT_PROGRESS_KEY = "import-v0.2-phase-b:progress";
const SKILL_PREFIX = "dsi-";
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ============================================================================
// Digest + canonicalization helpers
// ============================================================================

function canonJson(value: unknown): string {
  // Key-sorted recursive canonicalization; bounded acyclic docs only.
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = obj[k];
      return out;
    }
    return v;
  });
}

function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** sha256 of a file's raw bytes. */
function sha256Bytes(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Opaque irreversible identifier for source-derived free text. */
export function opaqueIdent(value: string): string {
  return `opaque:${digest(value).slice(0, 12)}`;
}

/**
 * Tree CAS digest: sha256 over the canonical JSON of the Phase A directory
 * digest (per-file path/size/byte-hash list; `-shm` excluded there by
 * definition as a rebuildable non-durable wal-index cache; `*.db` and
 * `*-wal` stay fully digested).
 */
/**
 * STABLE-file tree CAS digest: identical to the Phase A directory digest but
 * with the volatile WAL companions (`*-wal`, `*-shm`) excluded from the FILE
 * LIST. Rationale (documented, not hidden): opening a read-only source
 * connection to a WAL-mode store legitimately creates/deletes these files, so
 * their mere presence cannot be a mutation signal. WAL DATA-Loss safety is
 * instead guaranteed three ways: (a) every read runs on a fresh transactionally
 * consistent `VACUUM INTO` snapshot, (b) the exact WAL companion bytes are
 * CAS-digested separately by `sourceWalDigest`, and (c) a plan-bound content
 * fingerprint over every source row re-verified pre- and post-write.
 */
function digestTree(root: string): string {
  const tree: TreeDigest = digestDirectory(root);
  const stableFiles = tree.files.filter((f) => !f.path.endsWith("-wal") && !f.path.endsWith("-shm"));
  return digest(
    canonJson(stableFiles) +
      `|dirs=${tree.dirs}|bytes=${tree.files.filter((f) => !f.path.endsWith("-wal") && !f.path.endsWith("-shm")).reduce((a, b) => a + b.size, 0)}`,
  );
}

/** Byte digest of the volatile WAL companion, or "absent" when it does not exist. */
function sourceWalDigest(sourceRoot: string): string {
  const walPath = join(sourceRoot, "memory.db-wal");
  if (!existsSync(walPath)) return "absent";
  return sha256Bytes(walPath);
}

function fileSizeOf(path: string): number {
  const st = statSync(path);
  if (!st.isFile()) throw new Error(`import-v02: not a regular file: ${path}`);
  return st.size;
}

/**
 * Public wrapper of the same CAS digest used by plan/apply gates so test
 * suites and audit tooling can verify source immutability without duplicating
 * the digest definition.
 */
export function computeSourceTreeDigest(root: string): string {
  return digestTree(resolve(root));
}

// ============================================================================
// Path safety (Phase A contracts, extended to the destination role)
// ============================================================================

function assertNoSymlinkComponents(absolutePath: string): void {
  const segments = absolutePath.split(sep).filter((s) => s.length > 0);
  let acc = absolutePath.startsWith(sep) ? sep : segments[0];
  for (let i = 0; i < segments.length; i++) {
    acc = join(acc, segments[i]);
    let st;
    try {
      st = lstatSync(acc);
    } catch {
      return; // missing tails are the normal fresh-destination case
    }
    if (st.isSymbolicLink()) {
      throw new Error(`import-v02: refusing to operate on symlink path component: ${acc}`);
    }
    if (!st.isDirectory() && i < segments.length - 1) {
      throw new Error(`import-v02: path component ${acc} is not a directory`);
    }
  }
}

function refuseSymlinkedContent(root: string, role: string): void {
  if (!existsSync(root)) return;
  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        throw new Error(`import-v02: refusing to read ${role}: a symlink is present inside the tree at ${p}; only plain files are accepted`);
      }
      if (e.isDirectory()) walk(p);
    }
  };
  walk(root);
}

function isInsidePath(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function validateDestRoles(destRoot: string, inputs: { sourceRoot: string; settingsPath?: string; skillsRoot?: string }): void {
  const dst = resolve(destRoot);
  assertNoSymlinkComponents(dst);
  const roles: Array<[string, string | undefined]> = [
    ["source store", resolve(inputs.sourceRoot)],
    ["settings input", inputs.settingsPath ? resolve(inputs.settingsPath) : undefined],
    ["skills root", inputs.skillsRoot ? resolve(inputs.skillsRoot) : undefined],
  ];
  for (const [role, p] of roles) {
    if (!p) continue;
    assertNoSymlinkComponents(p);
    if (dst === p || isInsidePath(dst, p) || isInsidePath(p, dst)) {
      throw new Error(`import-v02: destination ${dst} overlaps the ${role} ${p}; one tree cannot serve both roles`);
    }
  }
  refuseSymlinkedContent(dst, "the destination tree");
}

function refusePathInsideInputs(path: string, label: string, inputs: { sourceRoot: string; destRoot: string; settingsPath?: string; skillsRoot?: string }): void {
  const target = resolve(path);
  assertNoSymlinkComponents(target);
  const roles: Array<[string, string | undefined]> = [
    ["source store", resolve(inputs.sourceRoot)],
    ["destination", resolve(inputs.destRoot)],
    ["settings input", inputs.settingsPath ? resolve(inputs.settingsPath) : undefined],
    ["skills root", inputs.skillsRoot ? resolve(inputs.skillsRoot) : undefined],
  ];
  for (const [role, p] of roles) {
    if (!p) continue;
    if (target === p || isInsidePath(target, p)) {
      throw new Error(`import-v02: refusing ${label} ${target}: it names the ${role} or a path inside it; lane docs never land on any input`);
    }
  }
}

// ============================================================================
// Approval record (wx-created AT PLAN TIME; lives inside the owner-marker
// file as its record section — one wx file, location + contents independent of
// plan.json; implements MIGRATION-PHASE-B-IMPORT-DESIGN.md §10's token file)
// ============================================================================

/** The wx owner-marker file is EXACTLY: the fixed marker text line, then one
 *  canonical-JSON approval record line. plan.json is NOT the trust anchor for
 *  approval: the record is verified against BOTH the presented plan and the
 *  fresh canonical re-derived plan at apply (see applyImportPlan GATE 1/3b).
 *  HONEST LIMIT: the record binds plan/source/destination digests; it is not
 *  proof of human intent, and any writer with the same OS privileges as this
 *  tool can rewrite both the record and plan.json (then the ONLY line of
 *  defense is that verdicts must equal the freshly re-derived canonical plan
 *  for the CURRENT authenticated read-only source). */
export const APPROVAL_RECORD_MARKER_LINE = OWNER_MARKER_TEXT;

export interface ImportApprovalRecord {
  recordVersion: 1;
  lane: "import-v0.2-phase-b";
  planDigest: string;
  approvalToken: string;
  sourceMemoryDbSha256: string;
  sourceTreeDigest: string;
  sourceWalSha256: string;
  sourceContentFingerprint: string;
  /** canonical (resolved) destination root the record was minted for at plan
   *  time; the apply re-checks it against the CURRENT destination (a
   *  transplanted copy of a planned destination refuses) */
  destRoot: string;
}

function isApprovalRecord(v: unknown): v is ImportApprovalRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r.recordVersion === 1 &&
    r.lane === "import-v0.2-phase-b" &&
    typeof r.planDigest === "string" &&
    typeof r.approvalToken === "string" &&
    typeof r.sourceMemoryDbSha256 === "string" &&
    typeof r.sourceTreeDigest === "string" &&
    typeof r.sourceWalSha256 === "string" &&
    typeof r.sourceContentFingerprint === "string" &&
    typeof r.destRoot === "string"
  );
}

function approvalRecordOf(plan: ImportPlan, destRoot: string): ImportApprovalRecord {
  return {
    recordVersion: 1,
    lane: "import-v0.2-phase-b",
    planDigest: plan.planDigest,
    approvalToken: plan.approvalToken,
    sourceMemoryDbSha256: plan.source.memoryDb.sha256,
    sourceTreeDigest: plan.source.treeDigest,
    sourceWalSha256: plan.source.walSha256,
    sourceContentFingerprint: plan.source.contentFingerprint,
    destRoot: resolve(destRoot),
  };
}

/** wx exclusive-create of the owner marker WITH its embedded approval record;
 *  NEVER overwrites (marker exists already ⇒ refusal) and never partial. The
 *  CLI `plan` stage calls this INSTEAD of writing a plain owner marker text
 *  file. */
export function writeOwnerMarkerApprovalRecord(destRoot: string, plan: ImportPlan): void {
  const root = resolve(destRoot);
  const text = `${APPROVAL_RECORD_MARKER_LINE}\n${canonJson(approvalRecordOf(plan, root))}\n`;
  let fd: number;
  try {
    fd = openSync(join(root, OWNER_MARKER_NAME), "wx");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? ` (${(e as { code?: string }).code})` : "";
    throw new Error(`import-v02: exclusive owner marker + approval record open failed${code} for ${root}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let completed = false;
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    completed = true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* noop */
    }
    if (!completed) {
      try {
        rmSync(join(root, OWNER_MARKER_NAME), { force: true }); // our own partially created file only (wx proved nothing pre-existed)
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * GATE (apply): read the destination's owner marker and verify BOTH the marker
 * line and the embedded, wx-created approval record. The record must name the
 * presented plan's digests byte-exactly and the canonical CURRENT destination
 * root. Trust hierarchy note (honest): plan.json's own approvalToken is NOT
 * evidence of anything — the record is what binds token(planDigest ::
 * memoryDbSha :: treeDigest :: destRoot) to an artifact written at plan time
 * by this same tool; a same-privilege writer can still rewrite it, which the
 * canonical-re-derivation gate (GATE 3b) exists to constrain.
 */
function verifyOwnerMarkerApprovalRecord(plan: ImportPlan, destRoot: string, presentedToken: string): ImportApprovalRecord {
  const markerPath = join(destRoot, OWNER_MARKER_NAME);
  let markerText: string;
  try {
    markerText = readFileSync(markerPath, "utf8");
  } catch {
    throw new Error(`import-v02: destination owner marker is missing or unreadable at ${markerPath}; refusal`);
  }
  const lines = markerText.split("\n");
  const recordLine = lines[1] ?? "";
  if ((lines[0] ?? "").trim() !== APPROVAL_RECORD_MARKER_LINE || recordLine.trim() === "") {
    throw new Error(
      `import-v02: destination owner marker does not carry the approval record (foreign marker or pre-record layout) at ${destRoot}; re-run \`plan\` into a fresh destination; refusal`,
    );
  }
  let record: unknown;
  try {
    record = JSON.parse(recordLine.trim());
  } catch {
    throw new Error(`import-v02: the owner-marker approval record is malformed; refusal with zero writes; re-run \`plan\``);
  }
  if (!isApprovalRecord(record)) {
    throw new Error(`import-v02: the owner-marker approval record is malformed (wrong shape); refusal with zero writes; re-run \`plan\``);
  }
  if (presentedToken === "") {
    throw new Error("import-v02: approval token missing or mismatched; refusal with zero writes (pass the exact token printed by `plan`)");
  }
  if (record.approvalToken !== presentedToken) {
    throw new Error(
      "import-v02: approval token missing or mismatched against the destination's wx-created approval record; refusal with zero writes (pass the exact token printed by `plan`)",
    );
  }
  if (record.destRoot !== resolve(destRoot)) {
    throw new Error(
      `import-v02: the approval record names destination ${record.destRoot} but the apply runs against ${resolve(destRoot)}; a transplanted copy of a planned destination is refused (re-plan at the real destination); refusal with zero writes`,
    );
  }
  const bound: Array<[string, string, string]> = [
    ["planDigest", record.planDigest, plan.planDigest],
    ["sourceMemoryDbSha256", record.sourceMemoryDbSha256, plan.source.memoryDb.sha256],
    ["sourceTreeDigest", record.sourceTreeDigest, plan.source.treeDigest],
    ["sourceWalSha256", record.sourceWalSha256, plan.source.walSha256],
    ["sourceContentFingerprint", record.sourceContentFingerprint, plan.source.contentFingerprint],
  ];
  for (const [field, recordValue, planValue] of bound) {
    if (recordValue !== planValue) {
      throw new Error(
        `import-v02: the approval record's ${field} does not equal plan.json's ${field}; the plan and its approval record disagree; refusal with zero writes`,
      );
    }
  }
  return record;
}

// ============================================================================
// Source snapshot lifecycle (own owner-marked temp tree)
// ============================================================================

interface OwnedSnapshot {
  db: DatabaseSync;
  memoryDbDigest: { bytes: number; sha256: string };
  snapRoot: string;
}

const SNAPSHOT_MARKER = "OWNER.dsh-migration-v02-snapshot";
const SNAPSHOT_MARKER_TEXT = "dsh-migration-v02-snapshot";

function guardedRmSnapshot(dir: string): void {
  try {
    if (readFileSync(join(dir, SNAPSHOT_MARKER), "utf8") !== SNAPSHOT_MARKER_TEXT) return;
  } catch {
    return;
  }
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leftover under tmpdir is inert */
  }
}

function takeSnapshot(sourceRoot: string): OwnedSnapshot {
  const dbPath = join(sourceRoot, "memory.db");
  if (!existsSync(dbPath)) throw new Error("import-v02: no memory.db under source root (missing-source)");
  // Containment guard (path methods): `memory.db` must be a PLAIN regular file
  // inside the source tree. A symlink would silently pull in foreign bytes
  // (every read follows the link), and a hard link could alias bytes outside
  // the source tree; both refuse before any read of the file's contents.
  const dbSt = lstatSync(dbPath);
  if (dbSt.isSymbolicLink() || !dbSt.isFile()) {
    throw new Error(`import-v02: refusing ${dbPath}: not a plain regular file (symlink/special memory.db containment refusal)`);
  }
  if (dbSt.nlink > 1) {
    throw new Error(`import-v02: refusing ${dbPath}: memory.db is a hard link (st_nlink > 1); the source store must not alias bytes under another path (containment refusal)`);
  }
  let header: Buffer;
  try {
    header = readFileSync(dbPath);
  } catch {
    throw new Error("import-v02: memory.db exists but is unreadable (missing-source)");
  }
  if (header.length < SQLITE_HEADER.length || !header.subarray(0, SQLITE_HEADER.length).equals(SQLITE_HEADER)) {
    throw new Error("import-v02: memory.db is not an SQLite 3 database (unsupported-source)");
  }
  const st = statSync(dbPath);
  const digested = { bytes: st.size, sha256: sha256Bytes(dbPath) };
  const snapRoot = mkdtempSync(join(tmpdir(), "dsi-v02-import-snap-"));
  try {
    writeFileSync(join(snapRoot, SNAPSHOT_MARKER), SNAPSHOT_MARKER_TEXT, "utf8");
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
    return { db, memoryDbDigest: digested, snapRoot };
  } catch (e) {
    guardedRmSnapshot(snapRoot);
    const msg = e instanceof Error ? e.message : String(e);
    if (/readonly|READONLY/i.test(msg)) {
      throw new Error(
        "import-v02: the source SQLite file could not be read read-only; run the online-backup contract (VACUUM INTO / quiesce all writers) and import the consistent snapshot instead of ever opening the store with a mutating handle",
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

function readOnlyTableCount(db: DatabaseSync, table: string): number {
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`import-v02: refusing non-identifier table name: ${table}`);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n?: unknown } | undefined;
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

// ============================================================================
// Bounded schema classification (plan-only view)
// ============================================================================

const KNOWN_TABLES = new Set([
  "memories", "memories_meta", "memories_seq", "baseline", "session_projects",
  "extract_state", "scenes", "persona_versions", "schema_state", "episode_events",
  "episodes", "episode_steps", "memories_fts", "memories_fts_data", "memories_fts_idx",
  "memories_fts_content", "memories_fts_docsize", "memories_fts_config",
  "sqlite_sequence", "journal_state", "store_state",
]);
const REQUIRED_LEGACY_TABLES = ["memories", "memories_meta", "memories_seq", "schema_state", "episodes", "episode_steps", "episode_events"];

export interface CompactSchemaFinding {
  schemaMarkers: { v1: boolean; v2: boolean };
  unknownMarkers: Array<{ keyDigest: string; appliedAt: number | null }>;
  unknownTableDigests: string[];
  missingTables: string[];
  quickCheckOk: boolean;
  userVersion: number;
}

function classifySnapshotSchema(db: DatabaseSync): CompactSchemaFinding {
  const names = (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: unknown }>)
    .map((r) => String(r.name));
  let v1 = false;
  let v2 = false;
  const unknownMarkers: Array<{ keyDigest: string; appliedAt: number | null }> = [];
  try {
    const rows = db.prepare("SELECT key, value, applied_at FROM schema_state").all() as Array<Record<string, unknown>>;
    for (const r of rows) {
      const key = String(r.key);
      if (key === "v1") v1 = true;
      else if (key === "v2") v2 = true;
      else {
        const n = Number(r.applied_at ?? NaN);
        unknownMarkers.push({ keyDigest: opaqueIdent(key), appliedAt: Number.isFinite(n) ? n : null });
      }
    }
  } catch {
    /* surfaced by missingTables below */
  }
  const known = new Set(KNOWN_TABLES);
  const unknownTableDigests = names.filter((n) => !known.has(n)).sort().map((n) => opaqueIdent(n));
  const missingTables = REQUIRED_LEGACY_TABLES.filter((t) => !names.includes(t));
  let quickCheckOk = false;
  try {
    const row = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    quickCheckOk = row != null && String(Object.values(row)[0] ?? "") === "ok";
  } catch {
    quickCheckOk = false;
  }
  let userVersion = 0;
  try {
    userVersion = Number((db.prepare("PRAGMA user_version").get() as Record<string, unknown>).user_version ?? 0);
  } catch {
    userVersion = 0;
  }
  unknownMarkers.sort((a, b) => (a.keyDigest < b.keyDigest ? -1 : 1));
  return { schemaMarkers: { v1, v2 }, unknownMarkers, unknownTableDigests, missingTables, quickCheckOk, userVersion };
}

// ============================================================================
// Plan / ledger / receipt shapes
// ============================================================================

export interface ImportOptions {
  /** Memory store root directory (contains memory.db, conversations/, persona/, vectors.db). */
  sourceRoot: string;
  /** Operator-named isolation destination (apply writes only inside it). */
  destinationRoot: string;
  settingsPath?: string;
  skillsRoot?: string;
}

export interface PlanMemoryRow {
  id: string;
  /** verbatim source insertion watermark for the legacySeq → targetSeq ledger map */
  legacySeq: number;
}

export interface PlanMemoryUnsupportedRow {
  id: string;
  reason: MemoryUnsupportedReason;
}

export interface PlanMemoryFamily {
  total: number;
  accepted: PlanMemoryRow[];
  unsupported: PlanMemoryUnsupportedRow[];
  plannedDemotions: Array<{ id: string; quarantinedReason: MemoryQuarantineReason }>;
  evidenceRefsUnverifiable: Array<{ id: string; episodeRefDigest: string }>;
}

export interface PlanBaselineFamily {
  pins: number;
  pinTargets: Array<{ slot: number; memoryId: string; updatedAt: number }>;
  unsupported: Array<{ slot: number; reason: PinUnsupportedReason }>;
}

export interface PlanEpisodeFamily {
  episodes: number;
  steps: number;
  events: number;
  retainedVerbatim: true;
  note: string;
}

export interface PlanRetainedFamily {
  verdict: "retained-quarantined";
  note: string;
  counts: Record<string, number>;
}

export interface PlanUnsupportedNotedFamily {
  verdict: "unsupported-evidenced";
  note: string;
  counts: Record<string, number>;
}

export interface PlanSettingsLeaf {
  path: string;
  action: "carry" | "presence-only" | "secret";
  target?: string;
  equalsDefault?: boolean;
  value?: boolean | number | string;
  valueKind?: "boolean" | "number" | "string";
}

export interface PlanSettingsFamily {
  found: boolean;
  leaves: number;
  carry: PlanSettingsLeaf[];
  presenceOnly: PlanSettingsLeaf[];
  secrets: PlanSettingsLeaf[];
  note: string;
}

interface PlanFamilyIdentity {
  total: number;
  accepted: number;
  retained: number;
  unsupported: number;
}

export interface ImportPlan {
  planVersion: 1;
  phase: "B";
  importId: "import-v0.2-phase-b";
  tool: { pluginId: string; target: string; sourceReader: string };
  /** input roles the plan consumed (canonical absolute paths); the apply's
   *  canonical re-derivation must use the SAME inputs (the operator may omit
   *  them at apply — the engine falls back to these recorded paths) */
  inputs: { settingsPath?: string; skillsRoot?: string };
  approvalToken: string;
  planDigest: string;
  source: {
    storeRoot: string;
    memoryDb: { bytes: number; sha256: string };
    treeDigest: string;
    /** byte digest of memory.db-wal at plan time, or "absent" */
    walSha256: string;
    /** plan-bound fingerprint over every source row tuple + family counts */
    contentFingerprint: string;
  };
  schema: CompactSchemaFinding;
  families: {
    memories: PlanMemoryFamily;
    baseline: PlanBaselineFamily;
    episodes: PlanEpisodeFamily;
    sessionProjects: { rows: number };
    persona: PlanRetainedFamily;
    generatedSkills: PlanRetainedFamily;
    conversations: PlanRetainedFamily & { invalidLines: Array<{ file: string; kind: "malformed" | "duplicateSeq" }> };
    cursors: PlanRetainedFamily;
    scenes: PlanRetainedFamily;
    vectors: PlanUnsupportedNotedFamily;
    unknownSchemaObjects: PlanUnsupportedNotedFamily;
  };
  settings?: PlanSettingsFamily;
  policy: {
    personaOrProseActive: false;
    generatedSkillsActivated: false;
    generatedSkillsCopiedIntoLiveSkillRoot: false;
    conversationBacklogEnqueued: false;
    legacyCursorAcknowledged: false;
    dedupAtImport: false;
    duplicateGroupsMerged: false;
    unsupportedAcknowledged: false;
    notes: string[];
  };
  reconciliation: {
    rule: string;
    families: Record<string, PlanFamilyIdentity>;
  };
}

export interface ImportLedger {
  ledgerVersion: 1;
  phase: "B";
  planDigest: string;
  sourceMemoryDbSha256: string;
  sourceTreeDigest: string;
  memoryAccepted: Array<{
    id: string;
    legacySeq: number;
    targetSeq: number;
    status: MemoryStatus;
    demotion?: MemoryQuarantineReason;
    /** Present when the operational target carries REDACTED content, not the
     *  source content (credential-content-demotion): explicit accounting, never
     *  a silent loss — the raw copy lives only in the 0700 private backup. */
    contentRedacted?: true;
    /** A credential-shaped evidence entry was tombstoned in the target meta. */
    evidenceRedacted?: true;
    /** A credential-shaped projectId/sessionId id string was withheld (nulled). */
    metaRedacted?: true;
    supersedes?: string | null;
    integrityNote?: string;
  }>;
  memoryUnsupported: PlanMemoryUnsupportedRow[];
  baselineAccepted: Array<{ slot: number; memoryId: string }>;
  baselineUnsupported: Array<{ slot: number; reason: PinUnsupportedReason }>;
  episodesAccepted: { episodes: number; steps: number; events: number };
  sessionProjectsAccepted: number;
  retained: {
    persona: { versions: number; files: number };
    generatedSkills: { dirs: number; names: string[] };
    conversations: { files: number; validLines: number; malformedLines: number; duplicateSeqLines: number };
    cursors: { sessions: number };
    scenes: { rows: number };
  };
  unsupportedFamilies: Array<{ family: string; counts: Record<string, number>; note: string }>;
  chunkWatermark: { committedChunks: number; memoryRowsCommitted: number };
}

export interface ImportResult {
  resultVersion: 1;
  phase: "B";
  mode: "apply";
  planDigest: string;
  approval: { tokenVerified: true };
  source: {
    storeRoot: string;
    memoryDbSha256: string;
    treeDigest: string;
    unchangedDuringApply: boolean;
  };
  target: {
    normalizedRoot: string;
    ownerMarkerVerified: true;
    schemaMarkers: { v1: boolean; v2: boolean };
    quickCheckOk: boolean;
    revisionBefore: number;
    revisionAfter: number;
    memoryRows: number;
    memoryByStatus: Record<string, number>;
    episodeRows: { episodes: number; steps: number; events: number };
    baselineRows: number;
    sessionProjects: number;
  };
  backup: {
    files: number;
    bytes: number;
    manifestVerified: boolean;
    restoreFidelityRule: string;
  };
  verdictTotals: Record<string, PlanFamilyIdentity>;
  reconciliation: { allReconciled: true; families: Record<string, PlanFamilyIdentity> };
  unfinishedFamilies: string[];
  limits: string[];
  safety: {
    zeroPartialWritesGuarantee: string;
    collisionsRefused: number;
    sameTxChunkProgressLedger: true;
    sourceOpenedReadOnly: true;
    noAcknowledgementOfUnsupported: true;
    personaAndGeneratedSkillsInactive: true;
  };
  determinismNote: string;
}

export interface ApplyOutcome {
  result: ImportResult;
  ledger: ImportLedger;
  plan: ImportPlan;
}


/**
 * Plan-bound source CONTENT fingerprint (re-verified pre-write at apply):
 * every memory row tuple plus every family counter. Any committed source
 * change (including WAL-only commits invisible to the main-file byte digest)
 * changes this fingerprint (TOCTOU / WAL-consistency gate).
 */

/**
 * Re-audit the non-memory retained counters from an OPEN SNAPSHOT (no second
 * file reads). Deliberately narrow: these counters only feed the
 * plan-bound content fingerprint.
 */
function auditRetainedQuick(db: DatabaseSync): RetainedAudit {
  return {
    personaVersions: readOnlyTableCount(db, "persona_versions"),
    personaFiles: 0,
    sceneRows: readOnlyTableCount(db, "scenes"),
    cursorSessions: readOnlyTableCount(db, "extract_state"),
    generatedSkillDirs: 0,
    generatedSkillNames: [],
    nonPrefixedSkillDirs: 0,
    vectorRows: 0,
    vectorsAvailable: false,
  };
}

function sourceContentFingerprint(db: DatabaseSync, retained: RetainedAudit, schema: CompactSchemaFinding): string {
  const rows = readSourceMemoryRows(db).map((r) => [
    r.id, r.kind, r.createdAt, r.updatedAt, r.status, r.importance, r.supersedes, r.legacySeq,
    r.provenance, r.source, r.scope, r.projectId, r.sessionId, r.confidence, r.expiresAt,
    r.evidence == null ? null : digest(String(r.evidence)).slice(0, 16),
  ]);
  const counts = {
    episodes: readOnlyTableCount(db, "episodes"),
    steps: readOnlyTableCount(db, "episode_steps"),
    events: readOnlyTableCount(db, "episode_events"),
    sessionProjects: readOnlyTableCount(db, "session_projects"),
    baseline: readOnlyTableCount(db, "baseline"),
    personaVersions: retained.personaVersions,
    scenes: retained.sceneRows,
    cursors: retained.cursorSessions,
    unknownMarkers: schema.unknownMarkers.length,
    unknownTables: schema.unknownTableDigests.length,
  };
  return digest(canonJson({ rows, counts }));
}

// ============================================================================
// Bounded audits of non-memory material
// ============================================================================

interface ConversationPlanAudit {
  files: number;
  validLines: number;
  malformedLines: number;
  duplicateSeqLines: number;
  invalidEntries: Array<{ file: string; kind: "malformed" | "duplicateSeq" }>;
}

function auditConversations(sourceRoot: string): ConversationPlanAudit {
  const dir = join(sourceRoot, "conversations");
  const out: ConversationPlanAudit = { files: 0, validLines: 0, malformedLines: 0, duplicateSeqLines: 0, invalidEntries: [] };
  if (!existsSync(dir)) return out;
  const names = readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort();
  for (const name of names) {
    const path = join(dir, name);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      out.malformedLines++;
      out.invalidEntries.push({ file: name, kind: "malformed" });
      continue;
    }
    out.files++;
    const seen = new Set<number>();
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        const rec = JSON.parse(trimmed) as { seq?: unknown };
        if (typeof rec.seq !== "number") throw new Error("no seq");
        if (seen.has(rec.seq)) {
          out.duplicateSeqLines++;
          out.invalidEntries.push({ file: name, kind: "duplicateSeq" });
        } else {
          seen.add(rec.seq);
        }
        out.validLines++;
      } catch {
        out.malformedLines++;
        out.invalidEntries.push({ file: name, kind: "malformed" });
      }
    }
  }
  return out;
}

interface RetainedAudit {
  personaVersions: number;
  personaFiles: number;
  sceneRows: number;
  cursorSessions: number;
  generatedSkillDirs: number;
  generatedSkillNames: string[];
  nonPrefixedSkillDirs: number;
  vectorRows: number;
  vectorsAvailable: boolean;
  vectorNote?: string;
}

function auditRetained(sourceRoot: string, db: DatabaseSync, skillsRoot?: string): RetainedAudit {
  const out: RetainedAudit = {
    personaVersions: readOnlyTableCount(db, "persona_versions"),
    personaFiles: 0,
    sceneRows: readOnlyTableCount(db, "scenes"),
    cursorSessions: readOnlyTableCount(db, "extract_state"),
    generatedSkillDirs: 0,
    generatedSkillNames: [],
    nonPrefixedSkillDirs: 0,
    vectorRows: 0,
    vectorsAvailable: false,
  };
  const personaDir = join(sourceRoot, "persona");
  if (existsSync(personaDir)) {
    for (const name of readdirSync(personaDir)) {
      try {
        if (statSync(join(personaDir, name)).isFile()) out.personaFiles++;
      } catch {
        continue;
      }
    }
  }
  if (skillsRoot && existsSync(skillsRoot)) {
    for (const entry of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(SKILL_PREFIX)) {
        out.generatedSkillDirs++;
        out.generatedSkillNames.push(entry.name);
      } else {
        out.nonPrefixedSkillDirs++;
      }
    }
    out.generatedSkillNames.sort();
  }
  const vectorsPath = join(sourceRoot, "vectors.db");
  if (existsSync(vectorsPath)) {
    let vdb: DatabaseSync | undefined;
    try {
      vdb = new DatabaseSync(vectorsPath, { readOnly: true });
      const hasVec = (vdb.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view')").all() as Array<{ name: unknown }>)
        .map((r) => String(r.name))
        .includes("memory_vec");
      out.vectorsAvailable = hasVec;
      out.vectorRows = hasVec ? readOnlyTableCount(vdb, "memory_vec") : 0;
    } catch (e) {
      out.vectorsAvailable = false;
      out.vectorRows = 0;
      out.vectorNote = "vectors.db exists but could not be read read-only; presence recorded, detail withheld";
      void e;
    } finally {
      try {
        vdb?.close();
      } catch {
        /* noop */
      }
    }
  }
  return out;
}

// ============================================================================
// Settings flattening — bounded PROPOSAL only (never a config write)
// ============================================================================

const SETTINGS_CARRY_RULES: Array<{ path: string; target: string }> = [
  { path: "enabled", target: "memoryAndLearning.rememberUsefulFacts" },
  { path: "searchLimit", target: "advanced.retrieval.toolSearchLimit" },
  { path: "extract.intervalMinutes", target: "advanced.extraction.cadenceMinutes" },
  { path: "extract.batchMaxChars", target: "advanced.extraction.batchCharsBudget" },
  { path: "recall.maxResults", target: "advanced.retrieval.maxResults" },
  { path: "recall.strategy", target: "advanced.retrieval.strategy" },
  { path: "episodeLearning.enabled", target: "operationalLearning.captureConsent" },
];

const SETTINGS_SECRET_PATTERNS = [/api_?key/i, /password/i, /secret/i, /credential/i, /token/i];

interface SettingLeaf {
  path: string;
  value: unknown;
  kind: "boolean" | "number" | "string";
}

function flattenSetting(prefix: string, value: unknown, out: SettingLeaf[]): void {
  if (value === null || value === undefined) {
    out.push({ path: prefix || "(root)", value: null, kind: "string" });
    return;
  }
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    out.push({ path: prefix, value, kind: typeof value as SettingLeaf["kind"] });
    return;
  }
  if (typeof value === "object") {
    for (const [k, child] of Object.entries(value as Record<string, unknown>)) {
      flattenSetting(prefix ? `${prefix}.${k}` : k, child, out);
    }
  }
}

/** Conservative subset of the Phase A legacy defaults, used only for equalsDefault. */
const LEGACY_DEFAULTS: Record<string, unknown> = {
  enabled: true,
  searchLimit: 5,
  extract: { intervalMinutes: 15, batchMaxChars: 12000 },
  recall: { maxResults: 5, strategy: "keyword" },
  episodeLearning: { enabled: false },
};

function equalsLegacyDefault(path: string, value: unknown): boolean {
  let cursor: unknown = LEGACY_DEFAULTS;
  for (const part of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return false;
    cursor = (cursor as Record<string, unknown>)[part];
  }
  if (value === null || value === undefined) return cursor === null || cursor === undefined;
  return cursor === value && typeof cursor === typeof value;
}

function planSettingsLeaf(leaf: SettingLeaf): PlanSettingsLeaf {
  const secretLike = SETTINGS_SECRET_PATTERNS.some((re) => re.test(leaf.path));
  if (secretLike) {
    return {
      path: leaf.path,
      action: "secret",
      equalsDefault: equalsLegacyDefault(leaf.path, leaf.value),
      valueKind: leaf.kind,
    };
  }
  const rule = SETTINGS_CARRY_RULES.find((r) => r.path === leaf.path);
  if (rule) {
    // Carry only scalars that cannot smuggle credentials (same spirit as Phase
    // A's safeCarryValue); anything else falls through to presence-only.
    let carryValue: boolean | number | string | undefined;
    if (typeof leaf.value === "boolean" || typeof leaf.value === "number") {
      carryValue = leaf.value;
    } else if (
      typeof leaf.value === "string" &&
      !SECRET_VALUE_PATTERN.test(leaf.value) &&
      !/(key|token|secret|credential|sig)\s*=\s*[^&\s"']+/i.test(leaf.value)
    ) {
      carryValue = leaf.value;
    }
    if (carryValue !== undefined) {
      return {
        path: leaf.path,
        action: "carry",
        target: rule.target,
        equalsDefault: equalsLegacyDefault(leaf.path, leaf.value),
        value: carryValue,
        valueKind: leaf.kind,
      };
    }
    return { path: leaf.path, action: "presence-only", target: rule.target, equalsDefault: equalsLegacyDefault(leaf.path, leaf.value), valueKind: leaf.kind };
  }
  return { path: leaf.path, action: "presence-only", equalsDefault: equalsLegacyDefault(leaf.path, leaf.value), valueKind: leaf.kind };
}

/** Conservative block-map/JSON settings reader (same refusal spirit as Phase A). */
function readSettingsEntryDoc(settingsPath: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = readFileSync(resolve(settingsPath), "utf8");
  } catch {
    return undefined;
  }
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("settings JSON must be an object");
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; obj: Record<string, unknown> }> = [{ indent: -1, obj: root }];
  const lineTexts = text.split(/\r?\n/);
  for (let ordinal = 0; ordinal < lineTexts.length; ordinal++) {
    const rawLine = lineTexts[ordinal];
    const line = rawLine.replace(/(^|\s)#.*$/, "$1").replace(/\t/g, "  ").trimEnd();
    if (line.trim() === "") continue;
    if (/^\s*-\s/.test(line) || line.includes(" - ")) return undefined; // unsupported grammar refused
    const match = /^(\s*)([^:#]+):\s*(.*)$/.exec(line);
    if (!match) return undefined; // error strings never echo source text
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
    } else if (valueText === "true" || valueText === "false") parent[key] = valueText === "true";
    else if (valueText === "null" || valueText === "~") parent[key] = null;
    else if (/^-?\d+(\.\d+)?$/.test(valueText)) parent[key] = Number(valueText);
    else parent[key] = valueText;
  }
  return root;
}

function locateSettingsEntry(doc: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!doc) return undefined;
  const direct = doc["self-improved"];
  if (direct && typeof direct === "object" && !Array.isArray(direct)) return direct as Record<string, unknown>;
  const plugins = doc["plugins"];
  if (plugins && typeof plugins === "object" && !Array.isArray(plugins)) {
    const nested = (plugins as Record<string, unknown>)["self-improved"];
    if (nested && typeof nested === "object" && !Array.isArray(nested)) return nested as Record<string, unknown>;
  }
  return undefined;
}

function buildSettingsFamily(settingsPath?: string): PlanSettingsFamily | undefined {
  if (!settingsPath) return undefined;
  const entry = locateSettingsEntry(readSettingsEntryDoc(settingsPath));
  const leaves: SettingLeaf[] = [];
  if (entry) flattenSetting("", entry, leaves);
  const carry: PlanSettingsLeaf[] = [];
  const presenceOnly: PlanSettingsLeaf[] = [];
  const secrets: PlanSettingsLeaf[] = [];
  for (const leaf of leaves) {
    const planned = planSettingsLeaf(leaf);
    if (planned.action === "carry") carry.push(planned);
    else if (planned.action === "secret") secrets.push(planned);
    else presenceOnly.push(planned);
  }
  return {
    found: Boolean(entry),
    leaves: leaves.length,
    carry,
    presenceOnly,
    secrets,
    note:
      "mapping proposal only; every value outside the conservative carry subset (or any string that looks credential-bearing) is presence-only. " +
      "A byte-verbatim settings file is retained in the backup when one is provided; the plan never writes configuration.",
  };
}

// ============================================================================
// Memory row plan classification
// ============================================================================

interface SourceMemoryRow {
  id: string;
  kind: string | null;
  content: string;
  importance: number | null;
  createdAt: number | null;
  updatedAt: number | null;
  status: string | null;
  supersedes: string | null;
  legacySeq: number | null;
  provenance: string | null;
  source: string | null;
  scope: string | null;
  projectId: unknown;
  sessionId: unknown;
  confidence: unknown;
  expiresAt: unknown;
  evidence: string | null;
}

const asNum = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && String(n) === v.trim()) return n;
  }
  return null;
};

const asText = (v: unknown): string | null => (v == null ? null : String(v));

function readSourceMemoryRows(db: DatabaseSync): SourceMemoryRow[] {
  const rows = db
    .prepare(
      `SELECT m.id AS id, m.kind AS kind, m.content AS content, m.importance AS importance,
              m.created_at AS created_at, m.updated_at AS updated_at, m.status AS status,
              m.supersedes AS supersedes, ms.seq AS legacy_seq,
              mm.provenance AS provenance, mm.source AS source, mm.scope AS scope,
              mm.project_id AS project_id, mm.session_id AS session_id,
              mm.confidence AS confidence, mm.expires_at AS expires_at, mm.evidence AS evidence
       FROM memories m
       LEFT JOIN memories_meta mm ON mm.memory_id = m.id
       LEFT JOIN memories_seq ms ON ms.memory_id = m.id
       ORDER BY m.created_at, m.id
       LIMIT ?`,
    )
    .all(MAX_MEMORY_ROWS) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    kind: asText(r.kind),
    content: typeof r.content === "string" ? r.content : "",
    importance: asNum(r.importance),
    createdAt: asNum(r.created_at),
    updatedAt: asNum(r.updated_at),
    status: asText(r.status),
    supersedes: asText(r.supersedes),
    legacySeq: asNum(r.legacy_seq),
    provenance: asText(r.provenance),
    source: asText(r.source),
    scope: asText(r.scope),
    projectId: r.project_id,
    sessionId: r.session_id,
    confidence: r.confidence,
    expiresAt: r.expires_at,
    evidence: asText(r.evidence),
  }));
}

function isNonNegativeInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

interface RowVerdict {
  accepted: boolean;
  unsupportedReason?: MemoryUnsupportedReason;
  demotion?: MemoryQuarantineReason;
  evidenceUnverifiableRef?: string;
}

function classifyMemoryRow(row: SourceMemoryRow, episodeIds: ReadonlySet<string>): RowVerdict {
  if (row.kind == null || !MEMORY_KINDS.has(row.kind)) return { accepted: false, unsupportedReason: "category-out-of-contract-kind" };
  if (row.status == null || !MEMORY_STATUSES.has(row.status)) return { accepted: false, unsupportedReason: "category-out-of-contract-status" };
  if (row.provenance == null) return { accepted: false, unsupportedReason: "missing-meta-side-row" };
  if (!MEMORY_PROVENANCES.has(row.provenance)) return { accepted: false, unsupportedReason: "category-out-of-contract-provenance" };
  if (row.source == null || !MEMORY_SOURCES.has(row.source)) return { accepted: false, unsupportedReason: "category-out-of-contract-source" };
  if (row.scope == null || !MEMORY_SCOPES.has(row.scope)) return { accepted: false, unsupportedReason: "category-out-of-contract-scope" };
  if (!isNonNegativeInt(row.createdAt) || !isNonNegativeInt(row.updatedAt)) return { accepted: false, unsupportedReason: "timestamp-not-preserved" };
  if (!isNonNegativeInt(row.legacySeq)) return { accepted: false, unsupportedReason: "timestamp-not-preserved" };
  if (typeof row.importance !== "number" || !Number.isInteger(row.importance) || row.importance < 1 || row.importance > 10) {
    return { accepted: false, unsupportedReason: "importance-out-of-range" };
  }
  if (row.projectId != null && typeof row.projectId !== "string") return { accepted: false, unsupportedReason: "meta-field-not-preserved" };
  if (row.sessionId != null && typeof row.sessionId !== "string") return { accepted: false, unsupportedReason: "meta-field-not-preserved" };
  if (row.confidence != null && typeof row.confidence !== "number") return { accepted: false, unsupportedReason: "meta-field-not-preserved" };
  if (row.expiresAt != null && !isNonNegativeInt(row.expiresAt)) return { accepted: false, unsupportedReason: "meta-field-not-preserved" };
  let evidenceRefDigest: string | undefined;
  if (row.evidence != null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.evidence);
    } catch {
      return { accepted: false, unsupportedReason: "evidence-not-parseable" };
    }
    if (!Array.isArray(parsed)) return { accepted: false, unsupportedReason: "evidence-not-parseable" };
    for (const entry of parsed as Array<Record<string, unknown>>) {
      const ep = entry?.episodeId;
      if (ep != null && typeof ep === "string" && !episodeIds.has(ep)) evidenceRefDigest = opaqueIdent(ep);
    }
  }
  // Privacy minimization plan: credential-shaped material (memory content,
  // evidence payload text, or projectId/sessionId id strings) never lands
  // byte-verbatim in the operational target. The row stays accepted with its
  // identity intact and demotes to `status='quarantined'`; the apply-time
  // content/meta mapping redacts ONLY the matched parts before the seam write,
  // and the ledger records which parts were redacted (accounting, never a
  // silent loss).
  if (
    isCredentialShaped(row.content) ||
    (row.evidence != null && isCredentialShaped(row.evidence)) ||
    (typeof row.projectId === "string" && isCredentialShaped(row.projectId)) ||
    (typeof row.sessionId === "string" && isCredentialShaped(row.sessionId))
  ) {
    return { accepted: true, demotion: "credential-content-demotion", evidenceUnverifiableRef: evidenceRefDigest };
  }
  if (row.kind === "instruction" && row.status === "active") {
    return { accepted: true, demotion: "instruction-conservative-demotion", evidenceUnverifiableRef: evidenceRefDigest };
  }
  if (row.provenance === "persona" && row.status === "active") {
    return { accepted: true, demotion: "persona-policy-demotion", evidenceUnverifiableRef: evidenceRefDigest };
  }
  return { accepted: true, evidenceUnverifiableRef: evidenceRefDigest };
}

/** The apply-time (and ledger re-derivation) minimization map for one memory
 *  row. Only the credential-SHAPED parts are redacted: the content string,
 *  whole evidence entries whose JSON matches the credential patterns, and
 *  credential-shaped projectId/sessionId id strings — tombstoned or nulled,
 *  NEVER rewritten into other free text. Everything else, and every
 *  non-credential row, stays byte-verbatim; all stable ids/timestamps/scope/
 *  lineage fields are unchanged everywhere. Raw byte fidelity for redacted
 *  parts exists ONLY in the explicit 0700 private backup lane. */
interface CredentialRowMapping {
  content: string;
  evidenceJson: string;
  projectId: string | null;
  sessionId: string | null;
  redactions: { content: boolean; evidence: boolean; meta: boolean };
}

function mapCredentialDemotedRow(row: SourceMemoryRow): CredentialRowMapping {
  const contentRedacted = isCredentialShaped(row.content);
  const projectIdRedacted = typeof row.projectId === "string" && isCredentialShaped(row.projectId);
  const sessionIdRedacted = typeof row.sessionId === "string" && isCredentialShaped(row.sessionId);
  let evidenceRedacted = false;
  let evidenceJson = row.evidence ?? "[]";
  if (row.evidence != null && isCredentialShaped(row.evidence)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.evidence);
    } catch {
      // Accepted rows already passed the parseable-evidence verdict, so this is
      // unreachable defense-in-depth: withhold the whole payload, never echo it.
      parsed = undefined;
    }
    if (Array.isArray(parsed)) {
      const mapped = parsed.map((entry) => {
        const text = typeof entry === "object" && entry !== null ? JSON.stringify(entry) : null;
        if (text != null && isCredentialShaped(text)) {
          evidenceRedacted = true;
          return REDACTED_EVIDENCE_ENTRY;
        }
        return entry;
      });
      evidenceJson = canonJson(mapped);
    } else if (isCredentialShaped(row.evidence)) {
      evidenceRedacted = true;
      evidenceJson = canonJson([REDACTED_EVIDENCE_ENTRY]);
    }
  }
  return {
    content: contentRedacted ? REDACTED_MEMORY_CONTENT : row.content,
    evidenceJson,
    projectId: projectIdRedacted ? null : row.projectId == null ? null : String(row.projectId),
    sessionId: sessionIdRedacted ? null : row.sessionId == null ? null : String(row.sessionId),
    redactions: { content: contentRedacted, evidence: evidenceRedacted, meta: projectIdRedacted || sessionIdRedacted },
  };
}

// ============================================================================
// PLAN BUILDER — reads the source; writes ONLY owner marker + plan.json
// (caller writes plan.json via writePlanDocument to keep the role split clean;
// the engine validates that everything it needs is closed vocabulary)
// ============================================================================

export function buildImportPlan(options: ImportOptions): ImportPlan {
  const sourceRoot = resolve(options.sourceRoot);
  const destRoot = resolve(options.destinationRoot);
  validateSourceDestination(sourceRoot, destRoot);
  validateDestRoles(destRoot, { sourceRoot, settingsPath: options.settingsPath, skillsRoot: options.skillsRoot });
  if (existsSync(destRoot)) {
    let empty = false;
    try {
      empty = readdirSync(destRoot).length === 0;
    } catch {
      empty = false;
    }
    if (!empty) {
      throw new Error(
        "import-v02: destination already exists and is not empty; a plan writes the owner marker and plan.json exclusively into a fresh root",
      );
    }
  }
  return deriveCanonicalPlan(options);
}

/**
 * Canonical plan DERIVATION for the current read-only source and input roles —
 * the single source of truth for what this lane accepts. `buildImportPlan`
 * wraps this behind the Phase A source/destination contracts; the apply gate
 * calls it against the CURRENT source so presented plan.json verdicts are
 * never trusted (exact accepted/quarantined/unsupported rows + reconciliation
 * re-derived before the first write).
 */
export function deriveCanonicalPlan(options: ImportOptions): ImportPlan {
  const sourceRoot = resolve(options.sourceRoot);
  const destRoot = resolve(options.destinationRoot);
  // F4 gate (plan methods): refuse a symlink ANYWHERE inside the source tree
  // BEFORE ANY read or source plan — the digest walk silently skips symlinks
  // and the auditors follow links, so a late refusal would read outside-tree
  // content and plan blessed counts that cannot survive the apply.
  refuseSymlinkedContent(sourceRoot, "the source store tree");
  const treeDigestBefore = digestTree(sourceRoot);
  const snapshot = takeSnapshot(sourceRoot);
  try {
    const db = snapshot.db;
    const schema = classifySnapshotSchema(db);
    if (!schema.schemaMarkers.v1 || !schema.schemaMarkers.v2) {
      throw new Error("import-v02: refusing to build an import plan: schema_state v1+v2 markers are absent (unsupported pre-migration legacy store)");
    }
    if (schema.missingTables.length > 0) {
      throw new Error(`import-v02: refusing to build an import plan: required legacy tables are absent (${schema.missingTables.join(", ")})`);
    }
    if (!schema.quickCheckOk) {
      throw new Error("import-v02: refusing to build an import plan: sqlite quick_check reported non-ok integrity (detail withheld)");
    }

    const episodeIds = new Set<string>(
      (db.prepare("SELECT id FROM episodes LIMIT ?").all(MAX_EPISODE_IDS) as Array<{ id: unknown }>).map((r) => String(r.id)),
    );

    // ---- memories family ----
    const sourceRows = readSourceMemoryRows(db);
    if (sourceRows.length >= MAX_MEMORY_ROWS) {
      throw new Error(`import-v02: refusing to build an import plan: the memory store exceeds the bounded lane cap of ${MAX_MEMORY_ROWS} rows`);
    }
    const accepted: PlanMemoryRow[] = [];
    const unsupportedRows: PlanMemoryUnsupportedRow[] = [];
    const plannedDemotions: PlanMemoryFamily["plannedDemotions"] = [];
    const plannedEvidenceUnverifiable: PlanMemoryFamily["evidenceRefsUnverifiable"] = [];
    for (const row of sourceRows) {
      const verdict = classifyMemoryRow(row, episodeIds);
      if (!verdict.accepted) {
        unsupportedRows.push({ id: row.id, reason: verdict.unsupportedReason! });
        continue;
      }
      accepted.push({ id: row.id, legacySeq: row.legacySeq ?? 0 });
      if (verdict.demotion) plannedDemotions.push({ id: row.id, quarantinedReason: verdict.demotion });
      if (verdict.evidenceUnverifiableRef) plannedEvidenceUnverifiable.push({ id: row.id, episodeRefDigest: verdict.evidenceUnverifiableRef });
    }

    // ---- baseline family ----
    const pinTargets: PlanBaselineFamily["pinTargets"] = [];
    const pinUnsupported: PlanBaselineFamily["unsupported"] = [];
    let pinTotal = 0;
    try {
      const rows = db.prepare("SELECT slot, memory_id, updated_at FROM baseline ORDER BY slot").all() as Array<Record<string, unknown>>;
      pinTotal = rows.length;
      const acceptedIds = new Set(accepted.map((r) => r.id));
      for (const r of rows) {
        const slot = Number(r.slot);
        const memoryId = String(r.memory_id);
        const updatedAt = asNum(r.updated_at);
        if (!acceptedIds.has(memoryId) || !isNonNegativeInt(updatedAt)) {
          pinUnsupported.push({ slot, reason: "dangling-pin-target" });
          continue;
        }
        const meta = db.prepare("SELECT provenance FROM memories_meta WHERE memory_id = ?").get(memoryId) as { provenance?: unknown } | undefined;
        const provenance = meta ? String(meta.provenance ?? "") : "";
        if (provenance === "user" || provenance === "persona") {
          pinTargets.push({ slot, memoryId, updatedAt: updatedAt! });
        } else {
          pinUnsupported.push({ slot, reason: "ineligible-pin-provenance" });
        }
      }
    } catch {
      /* baseline absent → surfaced by schema classification; plan proceeds with 0 */
    }

    // ---- verbatim-copy families + retained counts ----
    const retained = auditRetained(sourceRoot, db, options.skillsRoot);
    const conversations = auditConversations(sourceRoot);
    const episodesCount = readOnlyTableCount(db, "episodes");
    const stepsCount = readOnlyTableCount(db, "episode_steps");
    const eventsCount = readOnlyTableCount(db, "episode_events");
    const sessionProjectsCount = readOnlyTableCount(db, "session_projects");

    const settings = buildSettingsFamily(options.settingsPath);
    const conversationInvalid = conversations.validLines - conversations.duplicateSeqLines;
    const planContent: Omit<ImportPlan, "planDigest" | "approvalToken"> = {
      planVersion: 1,
      phase: "B",
      importId: "import-v0.2-phase-b",
      tool: {
        pluginId: "self-improved",
        target: "OWNER-marked isolated synthetic v0.2 store (backup + normalized), never live and never cutover-connected",
        sourceReader: "node:sqlite readOnly + VACUUM INTO snapshot (WAL-inclusive); no mutating handles, no source mutation",
      },
      inputs: {
        settingsPath: options.settingsPath ? resolve(options.settingsPath) : undefined,
        skillsRoot: options.skillsRoot ? resolve(options.skillsRoot) : undefined,
      },
      source: {
        storeRoot: sourceRoot,
        memoryDb: snapshot.memoryDbDigest,
        treeDigest: treeDigestBefore,
        walSha256: sourceWalDigest(sourceRoot),
        contentFingerprint: "(computed after the frozen family audit below)",
      },
      schema,
      families: {
        memories: {
          total: sourceRows.length,
          accepted,
          unsupported: unsupportedRows,
          plannedDemotions,
          evidenceRefsUnverifiable: plannedEvidenceUnverifiable,
        },
        baseline: { pins: pinTotal, pinTargets, unsupported: pinUnsupported },
        episodes: {
          episodes: episodesCount,
          steps: stepsCount,
          events: eventsCount,
          retainedVerbatim: true,
          note: "episodes/episode_steps/episode_events copy verbatim in store same-connection immediate transactions (no memory FTS/seq/revision invariants apply to episode tables); columns must match this tree's storage schema exactly and any mismatch refuses",
        },
        sessionProjects: { rows: sessionProjectsCount },
        persona: {
          verdict: "retained-quarantined",
          note: "persona_versions rows and persona/ files are retained byte-verbatim in the restore-grade backup only; never activated, never rendered, never copied into any operational lane",
          counts: { personaVersions: retained.personaVersions, personaFiles: retained.personaFiles },
        },
        generatedSkills: {
          verdict: "retained-quarantined",
          note: "generated dsi-* skills are retained verbatim in the backup only and stay inactive; they are never copied into any live skill root and never activated",
          counts: { generatedSkillDirs: retained.generatedSkillDirs, nonPrefixedSkillDirs: retained.nonPrefixedSkillDirs },
        },
        conversations: {
          verdict: "retained-quarantined",
          note: "valid conversation lines stay in the backup as extraction-backlog material; they are NOT enqueued into the v0.2 journal here (seq-zero / >200k canonical-reread / pre-fix truncation honesty is owned by the journal lanes)",
          counts: { files: conversations.files, validLines: conversations.validLines },
          invalidLines: conversations.invalidEntries,
        },
        cursors: {
          verdict: "retained-quarantined",
          note: "extract_state cursors are recorded for orientation only; the backlog is re-plannable by a future explicit lane and nothing here is ever acknowledged as consumed",
          counts: { sessions: retained.cursorSessions },
        },
        scenes: {
          verdict: "retained-quarantined",
          note: "L2 scene aggregates are derived material; retained verbatim in the backup, not written into the operational target by this increment (explicitly unfinished here, not claimed lossless into normalized/)",
          counts: { rows: retained.sceneRows },
        },
        vectors: {
          verdict: "unsupported-evidenced",
          note: "disposable, rebuildable embedding index; counted and never acked, never imported into the operational target",
          counts: { vectorsAvailable: retained.vectorsAvailable ? 1 : 0, embeddings: retained.vectorRows },
        },
        unknownSchemaObjects: {
          verdict: "unsupported-evidenced",
          note: "unknown schema_state markers / unknown tables outside the v0.1 plugin schema are counted; identifiers appear only as opaque digests (never raw text)",
          counts: { unknownMarkers: schema.unknownMarkers.length, unknownTables: schema.unknownTableDigests.length },
        },
      },
      settings,
      policy: {
        personaOrProseActive: false,
        generatedSkillsActivated: false,
        generatedSkillsCopiedIntoLiveSkillRoot: false,
        conversationBacklogEnqueued: false,
        legacyCursorAcknowledged: false,
        dedupAtImport: false,
        duplicateGroupsMerged: false,
        unsupportedAcknowledged: false,
        notes: [
          "identity preservation: memory ids/timestamps/statuses/supersedes/scopes/confidence/expiresAt and intact evidence/meta entries are carried verbatim through the storage import seam; the only minimization: credential-shaped content, evidence entries and projectId/sessionId id strings are redacted in the operational target (per-part ledger flags; raw copies only in the private restore-grade backup); the target memories_seq is minted strictly increasing and the legacySeq→targetSeq map is written explicitly",
          "no dedup and no merge at import: duplicate/conflict groups carry verbatim as rows; merging is a policy decision reserved to later review, mechanics never merge",
          "unsupported-evidenced is accounting, never acknowledgment: no row is marked consumed, nothing deleted",
          "no live cutover, no active-profile change, no settings write: cutover/rollback remain separate gated work",
        ],
      },
      reconciliation: {
        rule: "for every family: accepted-verbatim + retained-quarantined + unsupported-evidenced == exact total; the apply refuses to finish if any identity fails",
        families: {
          memories: {
            total: sourceRows.length,
            accepted: accepted.length,
            retained: 0,
            unsupported: unsupportedRows.length,
          },
          baseline: { total: pinTotal, accepted: pinTargets.length, retained: 0, unsupported: pinUnsupported.length },
          episodes: { total: episodesCount + stepsCount + eventsCount, accepted: episodesCount + stepsCount + eventsCount, retained: 0, unsupported: 0 },
          sessionProjects: { total: sessionProjectsCount, accepted: sessionProjectsCount, retained: 0, unsupported: 0 },
          persona: {
            total: retained.personaVersions + retained.personaFiles,
            accepted: 0,
            retained: retained.personaVersions + retained.personaFiles,
            unsupported: 0,
          },
          generatedSkills: {
            total: retained.generatedSkillDirs,
            accepted: 0,
            retained: retained.generatedSkillDirs,
            unsupported: 0,
          },
          conversations: {
            total: conversations.validLines + conversations.malformedLines,
            accepted: 0,
            retained: conversationInvalid,
            unsupported: conversations.malformedLines + conversations.duplicateSeqLines,
          },
          cursors: { total: retained.cursorSessions, accepted: 0, retained: retained.cursorSessions, unsupported: 0 },
          scenes: { total: retained.sceneRows, accepted: 0, retained: retained.sceneRows, unsupported: 0 },
          vectors: { total: retained.vectorRows, accepted: 0, retained: 0, unsupported: retained.vectorRows },
          unknownSchemaObjects: {
            total: schema.unknownMarkers.length + schema.unknownTableDigests.length,
            accepted: 0,
            retained: 0,
            unsupported: schema.unknownMarkers.length + schema.unknownTableDigests.length,
          },
        },
      },
    };

    planContent.source.walSha256 = sourceWalDigest(sourceRoot);
    planContent.source.contentFingerprint = sourceContentFingerprint(db, retained, schema);
    const planDigest = digest(canonJson(planContent));
    const approvalToken = digest([planDigest, snapshot.memoryDbDigest.sha256, treeDigestBefore, destRoot].join("::"));
    return { ...planContent, planDigest, approvalToken };
  } finally {
    closeSnapshot(snapshot);
  }
}

// ============================================================================
// Exclusive JSON writer (wx + fsync; never overwrites; never partial)
// ============================================================================

export function writeJsonExclusive(path: string, value: unknown): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  let fd: number;
  try {
    fd = openSync(path, "wx");
  } catch (e) {
    const code = e instanceof Error && "code" in e ? ` (${(e as { code?: string }).code})` : "";
    throw new Error(`import-v02: exclusive ${labelOf(path)} open failed${code} for ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let completed = false;
  try {
    writeFileSync(fd, `${canonJson(value)}\n`, "utf8");
    fsyncSync(fd);
    completed = true;
  } finally {
    try {
      closeSync(fd);
    } catch {
      /* noop */
    }
    if (!completed) {
      try {
        rmSync(path, { force: true }); // our own partially created file only (wx proved nothing pre-existed)
      } catch {
        /* best effort */
      }
    }
  }
}

function labelOf(path: string): string {
  if (path.endsWith("plan.json")) return "plan";
  if (path.endsWith("ledger.json")) return "ledger";
  if (path.endsWith("receipt.json")) return "receipt";
  return "doc";
}

// ============================================================================
// APPLY
// ============================================================================

export interface ApplyOptions extends ImportOptions {
  /** Operator token printed by `plan` — must match BOTH the destination's
   *  wx-created approval record AND plan.approvalToken; additionally the whole
   *  presented plan must equal the freshly re-derived canonical plan (GATE 3b). */
  approvalToken: string;
  /** Explicit operator-declared resume of a plan whose target holds a matching watermark. */
  resume?: boolean;
  /**
   * TEST-ONLY crash points for adversarial SIGKILL suites (fixtures run a real
   * child process which self-kills at a named boundary mid-transaction or
   * right after a commit). Never set by the CLI; unset points are exact no-ops.
   */
  testCrashPoints?: ReadonlySet<string>;
}

interface ProgressMarker {
  planDigest: string;
  memoryCommitted: number;
  chunksCommitted: number;
  episodesCommitted: number;
  stepsCommitted: number;
  eventsCommitted: number;
  sessionProjectsCommitted: number;
  baselineCommitted: boolean;
  importMarkerRowCommitted: boolean;
}

function emptyProgress(planDigest: string): ProgressMarker {
  return {
    planDigest,
    memoryCommitted: 0,
    chunksCommitted: 0,
    episodesCommitted: 0,
    stepsCommitted: 0,
    eventsCommitted: 0,
    sessionProjectsCommitted: 0,
    baselineCommitted: false,
    importMarkerRowCommitted: false,
  };
}

function readProgress(handle: DatabaseSync): ProgressMarker | undefined {
  const raw = handle.prepare("SELECT value FROM store_state WHERE key = ?").get(IMPORT_PROGRESS_KEY) as { value?: string } | undefined;
  if (!raw?.value) return undefined;
  try {
    const parsed = JSON.parse(String(raw.value)) as ProgressMarker;
    if (typeof parsed.planDigest !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeProgressInTx(handle: DatabaseSync, progress: ProgressMarker): void {
  handle
    .prepare(
      `INSERT INTO store_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(IMPORT_PROGRESS_KEY, canonJson(progress), Date.now());
}

/**
 * Verbatim chunk copier inside the CALLER's open immediate transaction. Column
 * sets MUST match the target storage schema exactly (any mismatch is an honest
 * refusal, never a silent column drop). Row order runs by rowid (stable: the
 * source is digest-frozen for the apply's duration; the apply reads one
 * consistent snapshot built at apply start).
 */
function copyTableChunk(
  db: DatabaseSync,
  handle: DatabaseSync,
  table: "episode_steps" | "episode_events" | "session_projects",
  from: number,
  to: number,
): number {
  if (!SAFE_IDENTIFIER.test(table)) throw new Error(`import-v02: refusing non-identifier table name: ${table}`);
  const targetCols = (handle.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map((c) => String(c.name));
  const sourceCols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>).map((c) => String(c.name));
  if (targetCols.length === 0) throw new Error(`import-v02: target table ${table} is missing; the synthetic target must be built by this tree's storage code`);
  const equal = targetCols.length === sourceCols.length && targetCols.every((c, i) => c === sourceCols[i]);
  if (!equal) {
    throw new Error(`import-v02: source table ${table} columns do not match this tree's storage schema (verbatim copy impossible); refusal, nothing imported for this table`);
  }
  const colList = targetCols.map((c) => `"${c}"`).join(", ");
  const rows = db
    .prepare(`SELECT ${colList} FROM ${table} ORDER BY rowid LIMIT ?, ?`)
    .all(from, to - from) as Array<Record<string, unknown>>;
  let n = 0;
  for (const row of rows) {
    const values: unknown[] = targetCols.map((c) => {
      const v = row[c];
      if (v == null) return null;
      if (typeof v === "bigint") return Number(v);
      if (!isSqlizable(v)) {
        throw new Error(`import-v02: verbatim copy of episodes hit a non-scalar column value (type cannot be preserved verbatim); refusal`);
      }
      return v;
    });
    const sqlValues = values as unknown as SQLInputValue[];
    handle
      .prepare(`INSERT INTO ${table} (${colList}) VALUES (${targetCols.map(() => "?").join(", ")})`)
      .run(...sqlValues);
    n++;
  }
  return n;
}

function copyEpisodeRows(db: DatabaseSync, handle: DatabaseSync, from: number, to: number): number {
  const targetCols = (handle.prepare("PRAGMA table_info(episodes)").all() as Array<Record<string, unknown>>).map((c) => String(c.name));
  const sourceCols = (db.prepare("PRAGMA table_info(episodes)").all() as Array<Record<string, unknown>>).map((c) => String(c.name));
  const equal = targetCols.length === sourceCols.length && targetCols.every((c, i) => c === sourceCols[i]);
  if (!equal) {
    throw new Error("import-v02: source episodes columns do not match this tree's storage schema (verbatim copy impossible); refusal");
  }
  const colList = targetCols.map((c) => `"${c}"`).join(", ");
  const rows = db.prepare(`SELECT ${colList} FROM episodes ORDER BY id LIMIT ?, ?`).all(from, to - from) as Array<Record<string, unknown>>;
  let n = 0;
  for (const row of rows) {
    const values: unknown[] = targetCols.map((c) => {
      const v = row[c];
      if (v == null) return null;
      if (typeof v === "bigint") return Number(v);
      if (!isSqlizable(v)) {
        throw new Error(`import-v02: verbatim copy of episodes hit a non-scalar column value (type cannot be preserved verbatim); refusal`);
      }
      return v;
    });
    const sqlValues = values as unknown as SQLInputValue[];
    handle
      .prepare(`INSERT INTO episodes (${colList}) VALUES (${targetCols.map(() => "?").join(", ")})`)
      .run(...sqlValues);
    n++;
  }
  return n;
}

interface BackupVerification {
  files: number;
  bytes: number;
  ok: boolean;
}

function verifyBackupManifest(destRoot: string): BackupVerification {
  let files = 0;
  let bytes = 0;
  let ok = true;
  try {
    const lines = readFileSync(join(destRoot, "backup", "MANIFEST.sha256"), "utf8").split("\n").filter((l) => l.trim() !== "");
    for (const line of lines) {
      const sepIdx = line.indexOf("  ");
      const hash = line.slice(0, sepIdx);
      const rel = line.slice(sepIdx + 2);
      const path = join(destRoot, rel);
      try {
        const actual = sha256Bytes(path);
        bytes += fileSizeOf(path);
        files++;
        if (actual !== hash) ok = false;
      } catch {
        ok = false;
      }
    }
  } catch {
    return { files: 0, bytes: 0, ok: false };
  }
  return { files, bytes, ok };
}

// ---------------- backup builder (restore-grade byte-faithful tree) ----------------

function buildBackup(
  destRoot: string,
  sourceRoot: string,
  settingsPath?: string,
  skillsRoot?: string,
  crashPoints?: ReadonlySet<string>,
): void {
  const snapshot = takeSnapshot(sourceRoot);
  const tempRoot = mkdtempSync(join(destRoot, "wip-backup-"));
  try {
    writeFileSync(join(tempRoot, SNAPSHOT_MARKER), SNAPSHOT_MARKER_TEXT, "utf8");
    // The WIP ROOT IS the backup tree: after the rename it becomes dest/backup
    // with memory.db + companions at its root (no nested layout, no stray dirs).
    // 1) memory.db = transactionally consistent WAL-inclusive VACUUM INTO snapshot
    writeFileSync(join(tempRoot, "memory.db"), readFileSync(join(snapshot.snapRoot, "snapshot-memory.db")));
    // 2) companions byte-verbatim (plain files only; symlink-free already enforced)
    copySideEntries(join(sourceRoot, "conversations"), tempRoot, "conversations", "conversation slices");
    copySideEntries(join(sourceRoot, "persona"), tempRoot, "persona", "persona files");
    copySideEntry(join(sourceRoot, "vectors.db"), tempRoot, "vectors.db", "vectors index");
    if (skillsRoot && existsSync(resolve(skillsRoot))) {
      copySideEntries(resolve(skillsRoot), tempRoot, "skills", "legacy skills root");
    }
    if (settingsPath && existsSync(resolve(settingsPath))) {
      copySideEntry(resolve(settingsPath), tempRoot, "settings.yaml", "settings file");
    }
    if (crashPoints?.has("backup:before-manifest")) process.kill(process.pid, "SIGKILL");
    // 3) digests + manifest (sorted; itself and every file digest-verified later)
    const manifestLines: string[] = [];
    collectDigestFiles(tempRoot, "backup", manifestLines);
    manifestLines.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const manifestAbs = join(tempRoot, "MANIFEST.sha256");
    writeFileSync(manifestAbs, manifestLines.join("\n") + (manifestLines.length ? "\n" : ""), "utf8");
    if (crashPoints?.has("backup:before-rename")) process.kill(process.pid, "SIGKILL");
    const dst = join(destRoot, "backup");
    if (existsSync(dst)) throw new Error("import-v02: refusing backup rename: dest/backup already exists");
    renameSync(tempRoot, dst);
    try {
      chmodSync(dst, 0o700); // restore-grade private tree stays operator-only
    } catch {
      /* best effort */
    }
    if (crashPoints?.has("backup:after-rename")) process.kill(process.pid, "SIGKILL");
  } catch (e) {
    // Debris honesty (audited by SIGKILL at backup:before-manifest / :before-rename):
    // a crash on this backup-lane boundary can leave MORE than one piece:
    // (a) the owner-marked `wip-backup-*` temp dir (partially written; swept by
    //     the next apply's marker-checked sweep),
    // (b) an already-initialized but ROW-EMPTY normalized store — MemoryStore
    //     is opened BEFORE this lane runs, so its schema exists at crash time,
    // (c) possibly an orphaned `dsi-v02-import-snap-*` tmpdir: guardedRmSnapshot
    //     cannot run on SIGKILL.
    // All of it is inert (no memory row, no receipt, no backup at the dest
    // root); --resume sweeps exactly the owned pieces (marker-checked) and
    // completes. On an ORDINARY error (rare here), guardedRmSnapshot below
    // removes only the temp dir; (b) and (c) can still be left and remain inert.
    guardedRmSnapshot(tempRoot);
    throw e;
  } finally {
    closeSnapshot(snapshot);
  }
}

function collectDigestFiles(dir: string, relBase: string, lines: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = join(relBase, name);
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new Error(`import-v02: refusing to digest a symlink at ${abs}`);
    if (st.isDirectory()) collectDigestFiles(abs, rel, lines);
    else if (st.isFile()) {
      lines.push(`${sha256Bytes(abs)}  ${rel}`);
    }
  }
}

function copySideEntry(absFrom: string, tempRoot: string, relTo: string, role: string): void {
  if (!existsSync(absFrom)) return;
  const st = lstatSync(absFrom);
  if (st.isSymbolicLink()) throw new Error(`import-v02: refusing to copy ${role}: a symlink is present at ${absFrom}`);
  if (!st.isFile()) throw new Error(`import-v02: refusing to copy ${role}: not a regular file at ${absFrom}`);
  const to = join(tempRoot, relTo);
  mkdirSync(resolve(to, ".."), { recursive: true });
  writeFileSync(to, readFileSync(absFrom));
}

function copySideEntries(absDir: string, tempRoot: string, relTo: string, role: string): void {
  if (!existsSync(absDir)) return;
  const st = lstatSync(absDir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    if (st.isFile()) {
      copySideEntry(absDir, tempRoot, relTo, role);
      return;
    }
    throw new Error(`import-v02: refusing to copy ${role}: not a plain directory at ${absDir}`);
  }
  for (const name of readdirSync(absDir).sort()) {
    collectCopyFiles(join(absDir, name), name, join(tempRoot, relTo, name), role);
  }
}

function collectCopyFiles(absFrom: string, name: string, absTo: string, role: string): void {
  const st = lstatSync(absFrom);
  if (st.isSymbolicLink()) throw new Error(`import-v02: refusing to copy ${role}: a symlink is present at ${absFrom}`);
  if (st.isFile()) {
    mkdirSync(resolve(absTo, ".."), { recursive: true });
    writeFileSync(absTo, readFileSync(absFrom));
    return;
  }
  if (st.isDirectory()) {
    mkdirSync(absTo, { recursive: true });
    for (const child of readdirSync(absFrom).sort()) {
      collectCopyFiles(join(absFrom, child), child, join(absTo, child), role);
    }
    return;
  }
  throw new Error(`import-v02: refusing to copy ${role}: unsupported file type at ${absFrom}`);
}

// ---------------- crash-hook helper ----------------

function crashPoint(options: ApplyOptions, name: string): void {
  if (options.testCrashPoints?.has(name)) process.kill(process.pid, "SIGKILL");
}

// ---------------- canonical-re-derivation comparison (gate core) ----------------

/**
 * Exact comparison between the freshly RE-DERIVED canonical plan (from the
 * current authenticated read-only source + this lane's supported policy) and
 * the presented plan document. plan.json verdicts are never trusted: accepted,
 * quarantined (planned-demotion) and unsupported row sets, the baseline pin
 * families, the retained/unsupported family notes, the reconciliation
 * identities, the schema finding, the plan-time inputs and the source digests
 * must all match exactly. Every mismatch is returned as a bounded refusal
 * fragment (digest vocabulary only — no source content).
 */
function compareCanonicalPlans(derived: ImportPlan, presented: ImportPlan): string[] {
  const keyOf = (rows: Array<{ key: string }>): string => rows.map((r) => r.key).sort().join("|");
  const failures: string[] = [];
  const accKey = (p: ImportPlan) => keyOf(p.families.memories.accepted.map((r) => ({ key: `${r.id}@${r.legacySeq}` })));
  if (accKey(derived) !== accKey(presented)) {
    failures.push(`memories.accepted rows differ from the canonical re-derivation (presented=${accKey(presented)} derived=${accKey(derived)})`);
  }
  const unsKey = (p: ImportPlan) => keyOf(p.families.memories.unsupported.map((r) => ({ key: `${r.id}@${r.reason}` })));
  if (unsKey(derived) !== unsKey(presented)) {
    failures.push(`memories.unsupported rows differ from the canonical re-derivation (presented=${unsKey(presented)} derived=${unsKey(derived)})`);
  }
  const demKey = (p: ImportPlan) => keyOf(p.families.memories.plannedDemotions.map((r) => ({ key: `${r.id}@${r.quarantinedReason}` })));
  if (demKey(derived) !== demKey(presented)) {
    failures.push(`memories.plannedDemotions (quarantine rows) differ from the canonical re-derivation (presented=${demKey(presented)} derived=${demKey(derived)})`);
  }
  const evKey = (p: ImportPlan) => keyOf(p.families.memories.evidenceRefsUnverifiable.map((r) => ({ key: `${r.id}@${r.episodeRefDigest}` })));
  if (evKey(derived) !== evKey(presented)) {
    failures.push("memories.evidenceRefsUnverifiable differ from the canonical re-derivation");
  }
  const pinTargetKey = (p: ImportPlan) => keyOf(p.families.baseline.pinTargets.map((r) => ({ key: `${r.slot}@${r.memoryId}@${r.updatedAt}` })));
  if (pinTargetKey(derived) !== pinTargetKey(presented)) {
    failures.push("baseline pinTargets differ from the canonical re-derivation");
  }
  const pinUnsKey = (p: ImportPlan) => keyOf(p.families.baseline.unsupported.map((r) => ({ key: `${r.slot}@${r.reason}` })));
  if (pinUnsKey(derived) !== pinUnsKey(presented)) {
    failures.push("baseline unsupported pins differ from the canonical re-derivation");
  }
  if (derived.families.baseline.pins !== presented.families.baseline.pins) failures.push("baseline pin count differs from the canonical re-derivation");
  if (derived.families.episodes.episodes !== presented.families.episodes.episodes ||
      derived.families.episodes.steps !== presented.families.episodes.steps ||
      derived.families.episodes.events !== presented.families.episodes.events) {
    failures.push("episode family counters differ from the canonical re-derivation");
  }
  if (derived.families.sessionProjects.rows !== presented.families.sessionProjects.rows) {
    failures.push("sessionProjects row count differs from the canonical re-derivation");
  }
  for (const family of ["persona", "generatedSkills", "conversations", "cursors", "scenes", "vectors", "unknownSchemaObjects"] as const) {
    if (canonJson(derived.families[family]) !== canonJson(presented.families[family])) {
      failures.push(`${family} family differs from the canonical re-derivation`);
    }
  }
  if (canonJson(derived.settings ?? null) !== canonJson(presented.settings ?? null)) {
    failures.push("settings family differs from the canonical re-derivation (settings input changed, or apply inputs differ from plan-time inputs)");
  }
  if (canonJson(derived.schema) !== canonJson(presented.schema)) {
    failures.push("schema finding differs from the canonical re-derivation");
  }
  if (canonJson(derived.policy) !== canonJson(presented.policy)) {
    failures.push("policy block differs from the canonical re-derivation");
  }
  if (canonJson(derived.inputs) !== canonJson(presented.inputs)) {
    failures.push("plan inputs (settings/skills roots) differ from the canonical re-derivation");
  }
  if (canonJson(derived.source) !== canonJson(presented.source)) {
    failures.push("source digests/fingerprint differ from the canonical re-derivation");
  }
  for (const [family, identity] of Object.entries(derived.reconciliation.families)) {
    const presentedIdentity = presented.reconciliation.families[family];
    if (!presentedIdentity || presentedIdentity.accepted !== identity.accepted || presentedIdentity.retained !== identity.retained ||
        presentedIdentity.unsupported !== identity.unsupported || presentedIdentity.total !== identity.total) {
      failures.push(`reconciliation family ${family} differs from the canonical re-derivation`);
    }
  }
  for (const family of Object.keys(presented.reconciliation.families)) {
    if (derived.reconciliation.families[family] == null) failures.push(`reconciliation family ${family} is not part of the canonical plan`);
  }
  return failures;
}

// ---------------- apply orchestrator ----------------

export function applyImportPlan(planDoc: ImportPlan, options: ApplyOptions): ApplyOutcome {
  const destRoot = resolve(options.destinationRoot);
  const plan = isImportPlan(planDoc);
  const sourceRoot = resolve(plan.source.storeRoot);

  // ---------- GATE 1: wx approval record + token (before ANY write) ----------
  // plan.json's own approvalToken is never sufficient: the token must match
  // the destination's wx-created approval record, the record must match the
  // presented plan's digests, and the record's canonical destination root must
  // equal the CURRENT destination (transplanted copies refuse).
  if (!options.approvalToken || options.approvalToken === "") {
    throw new Error("import-v02: approval token missing or mismatched; refusal with zero writes (pass the exact token printed by `plan`)");
  }

  // ---------- GATE 2: destination roles, owner marker + record, plan integrity ----------
  validateSourceDestination(sourceRoot, destRoot);
  validateDestRoles(destRoot, { sourceRoot, settingsPath: options.settingsPath, skillsRoot: options.skillsRoot });
  if (!existsSync(destRoot)) throw new Error("import-v02: destination root missing; run `plan` first");
  const approvalRecord = verifyOwnerMarkerApprovalRecord(plan, destRoot, options.approvalToken);
  if (options.approvalToken !== plan.approvalToken) {
    throw new Error("import-v02: approval token missing or mismatched against the presented plan's token; refusal with zero writes");
  }
  if (plan.source.storeRoot !== sourceRoot) throw new Error("import-v02: plan source root does not resolve to itself; refusal");
  const planDocContent = stripPlanDigestFields(planDoc);
  if (plan.planDigest !== digest(canonJson(planDocContent))) {
    throw new Error("import-v02: plan.json is inconsistent with its declared planDigest; refusal with zero writes");
  }

  // ---------- GATE 2b: source-side containment re-check (before source reads) ----------
  refuseSymlinkedContent(sourceRoot, "the source store tree");

  // ---------- GATE 3: source digest CAS pre-check ----------
  if (digestTree(sourceRoot) !== plan.source.treeDigest) {
    throw new Error(
      "import-v02: the source tree changed since the plan was written (treeDigest delta); nothing is written. Refresh the plan or investigate the legacy store first",
    );
  }
  const dbPath = join(sourceRoot, "memory.db");
  if (!existsSync(dbPath)) throw new Error("import-v02: memory.db disappeared from the source root");
  if (sha256Bytes(dbPath) !== plan.source.memoryDb.sha256) {
    throw new Error("import-v02: memory.db bytes changed since the plan was written (main-file sha delta); refusal with zero writes");
  }
  const appliedWalDigestBefore = sourceWalDigest(sourceRoot);
  if (plan.source.walSha256 !== appliedWalDigestBefore) {
    throw new Error(
      "import-v02: memory.db-wal bytes changed since the plan was written (WAL companion delta; a writer may have committed checkpointed or WAL-only rows); refusal with zero writes — refresh the plan",
    );
  }
  // memory.db containment (symlink/hard-link refusal) is enforced inside
  // `takeSnapshot`, re-checked on the fresh apply snapshot below.

  // ---------- GATE 3b: plan verdicts are RE-DERIVED, never trusted ----------
  // Fight the forged-plan class head-on: re-derive the canonical plan from the
  // CURRENT authenticated read-only source + this lane's supported policy and
  // require exact equality of the accepted / quarantined / unsupported row
  // sets, every family identity, the schema finding, the plan inputs and the
  // source digests. A mutated verdict, a silently dropped accepted row or a
  // pulled-unsupported row can no longer pass; the only way to change what is
  // imported is to re-plan against the real source.
  const applySettingsPath = options.settingsPath ?? plan.inputs?.settingsPath;
  const applySkillsRoot = options.skillsRoot ?? plan.inputs?.skillsRoot;
  let derived: ImportPlan;
  try {
    derived = deriveCanonicalPlan({
      sourceRoot,
      destinationRoot: destRoot,
      settingsPath: applySettingsPath,
      skillsRoot: applySkillsRoot,
    });
  } catch (e) {
    throw new Error(
      `import-v02: canonical plan re-derivation refused before any write: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (derived.planDigest !== plan.planDigest || compareCanonicalPlans(derived, plan).length > 0) {
    const details = compareCanonicalPlans(derived, plan);
    throw new Error(
      "import-v02: plan.json does not equal the canonical plan freshly re-derived from the current authenticated read-only source; " +
        "verdict forgeries (pulled-unsupported / dropped-accepted rows, mutated counts, replayed verdicts) are refused with zero writes; " +
        "re-run `plan` and approve the fresh output" +
        (details.length > 0 ? `; details: ${details.join("; ")}` : ""),
    );
  }
  if (derived.approvalToken !== approvalRecord.approvalToken) {
    throw new Error("import-v02: the re-derived plan's token does not match the wx approval record; refusal with zero writes");
  }

  // ---------- GATE 4: fresh target / explicit resume / no re-run ----------
  const normalizedDir = join(destRoot, "normalized");
  const backupDir = join(destRoot, "backup");

  // Sweep OUR OWN stale crash debris: only directories named wip-backup-*
  // whose owner marker inside still names this tool's snapshot contract, and
  // never anything else. Any foreign file refuses the apply outright.
  for (const entry of readdirSync(destRoot).sort()) {
    if (!entry.startsWith("wip-backup-")) continue;
    const dir = join(destRoot, entry);
    if (!lstatSync(dir).isDirectory()) {
      throw new Error(`import-v02: unexpected non-directory debris at ${dir}; refusal`);
    }
    let marker = "";
    try {
      marker = readFileSync(join(dir, SNAPSHOT_MARKER), "utf8");
    } catch {
      /* markerPath missing below */
    }
    if (marker !== SNAPSHOT_MARKER_TEXT) {
      throw new Error(`import-v02: unexpected debris at ${dir} (owner marker missing or foreign); refusal`);
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      throw new Error(`import-v02: illegible stale temp dir ${dir} could not be swept; refusal`);
    }
  }

    if (existsSync(join(destRoot, "receipt.json"))) {
    throw new Error("import-v02: receipt.json already exists in the destination; a completed import is never re-run (remove the destination explicitly to redo)");
  }
  // resume requires either a matching watermark or a clean empty target
  // (checked after the store opens; a zero-coverage crash is legal there).

  let store: MemoryStore | undefined;
  try {
    store = new MemoryStore(normalizedDir);
    try {
      chmodSync(normalizedDir, 0o700);
    } catch {
      /* best effort */
    }
    const handle = store.getJournalSqlite();

    // watermark contract
    const priorProgress = readProgress(handle);
    if (priorProgress && priorProgress.planDigest !== plan.planDigest) {
      throw new Error("import-v02: the target store already holds a different import plan digest; collision refusal (create a fresh destination instead)");
    }
    if (priorProgress && !options.resume) {
      throw new Error("import-v02: the target holds an import progress watermark; re-run only under the explicit --resume contract (or remove the destination)");
    }
    const importRow = readStateRow(handle, IMPORT_STATE_KEY);
    if (importRow) {
      try {
        const parsed = JSON.parse(importRow) as Record<string, unknown>;
        if (parsed.planDigest !== plan.planDigest) {
          throw new Error("import-v02: the target store_state import row names a foreign plan digest; refusal");
        }
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("import-v02: the target store_state")) throw e;
        throw new Error("import-v02: the target store_state import row is corrupt; refusal");
      }
    }
    // empty-by-construction target: zero pre-existing data rows on a fresh apply
    const memoryCount = readOnlyTableCount(handle, "memories");
    if (priorProgress && memoryCount !== priorProgress.memoryCommitted) {
      throw new Error(
        `import-v02: the target watermark claims ${priorProgress.memoryCommitted} committed memory rows but the target holds ${memoryCount}; the watermark and the target disagree; refusal`,
      );
    }
    if (!priorProgress && memoryCount !== 0) {
      throw new Error(`import-v02: the synthetic target must be empty by construction; ${memoryCount} pre-existing memory row(s) is a collision refusal`);
    }
    if (!priorProgress && options.resume) {
      // A crash with nothing committed (no watermark, empty target) is exactly
      // the zero-coverage resume case: the empty-by-construction check above
      // already proved the target is clean, so continue as the first run.
    }
    let progressStart: ProgressMarker | undefined = priorProgress;
    const revisionBefore = store.getMemoryRevision();

    // ---------- consistent apply-time snapshot + digest bounds ----------
    const snapshot = takeSnapshot(sourceRoot);
    try {
      const db = snapshot.db;

      // ---------- GATE: schema identity re-check on the apply snapshot ----------
      const schemaAtApply = classifySnapshotSchema(db);
      if (canonJson(schemaAtApply) !== canonJson(plan.schema)) {
        throw new Error(
          "import-v02: source schema state drifted since the plan was written (schema-finding delta including unknown markers/tables); refusal with zero writes — refresh the plan",
        );
      }

      // ---------- GATE: plan-bound content fingerprint (TOCTOU / WAL-only commits) ----
      const fingerprint = sourceContentFingerprint(db, auditRetainedQuick(db), plan.schema);
      if (fingerprint !== plan.source.contentFingerprint) {
        throw new Error(
          "import-v02: source content drifted since the plan was written (content-fingerprint delta over rows/counts; a writer committed changes even if the main-file sha stayed equal); refusal with zero writes — refresh the plan",
        );
      }

      const progress: ProgressMarker = { ...(progressStart ?? emptyProgress(plan.planDigest)) };

      // ---------- backup lane (restore-grade, byte-faithful) ----------
      if (!existsSync(backupDir)) {
        crashPoint(options, "apply:backup-before");
        try {
          buildBackup(destRoot, sourceRoot, applySettingsPath, applySkillsRoot, options.testCrashPoints);
        } catch (e) {
          throw new Error(`import-v02: backup lane failed; apply refuses (nothing operational is written): ${e instanceof Error ? e.message : String(e)}`);
        }
        crashPoint(options, "apply:backup-after");
      }

      crashPoint(options, "apply:chunks-begin");

      // ---------- memory chunks ----------
      const acceptedRows = new Map<string, SourceMemoryRow>();
      for (const row of readSourceMemoryRows(db)) acceptedRows.set(row.id, row);
      const demotions = new Map<string, MemoryQuarantineReason>();
      for (const d of plan.families.memories.plannedDemotions) demotions.set(d.id, d.quarantinedReason);
      const planAccepted = plan.families.memories.accepted;
      let chunkIndex = 0;
      while (progress.memoryCommitted < planAccepted.length) {
        const chunk = planAccepted.slice(progress.memoryCommitted, progress.memoryCommitted + CHUNK_ROWS);
        if (chunk.length === 0) break;
        chunkIndex++;
        store.runInImmediateTransaction(() => {
          crashPoint(options, `memory-chunk:${chunkIndex}:begin`);
          for (const entry of chunk) {
            const row = acceptedRows.get(entry.id);
            if (!row) throw new Error(`import-v02: plan row ${entry.id} disappeared from the re-read source snapshot; refusal`);
            // Minimization before ANY operational write: ONLY a plan-demoted
            // credential-shaped row maps through the redaction contract;
            // every other row (including other demotions) stays byte-verbatim.
            const mapping = demotions.get(entry.id) === "credential-content-demotion" ? mapCredentialDemotedRow(row) : undefined;
            const meta: MemoryMetaInput = {
              provenance: row.provenance as MemoryProvenance,
              source: row.source as MemorySource,
              scope: row.scope as MemoryScope,
              projectId: mapping ? mapping.projectId : row.projectId == null ? null : String(row.projectId),
              sessionId: mapping ? mapping.sessionId : row.sessionId == null ? null : String(row.sessionId),
              confidence: row.confidence == null ? undefined : Number(row.confidence),
              expiresAt: row.expiresAt == null ? null : Number(row.expiresAt),
              evidence: parseEvidence(mapping ? mapping.evidenceJson : row.evidence ?? "[]"),
            };
            crashPoint(options, `memory-chunk:${chunkIndex}:mid`);
            try {
              store!.importMemoryInTx(
                {
                  id: entry.id,
                  kind: row.kind as MemoryKind,
                  content: mapping ? mapping.content : row.content,
                  createdAt: row.createdAt ?? 0,
                  updatedAt: row.updatedAt ?? 0,
                  importance: row.importance ?? undefined,
                  status: (demotions.has(entry.id) ? "quarantined" : (row.status ?? "active")) as MemoryStatus,
                  supersedes: row.supersedes ?? undefined,
                },
                meta,
              );
            } catch (e) {
              if (e instanceof MemoryImportCollisionError) {
                throw new Error(`import-v02: memory id '${entry.id}' collide-refused by the seam (identical duplicates refuse too; no overwrite, no dedup): ${e.message}`);
              }
              throw e;
            }
          }
          progress.memoryCommitted += chunk.length;
          progress.chunksCommitted += 1;
          // SAME-TX progress ledger: the watermark commits with the rows, so no
          // boundary exists where data exists without its verdict.
          writeProgressInTx(handle, progress);
        });
        crashPoint(options, `memory-chunk:${chunkIndex}:committed`);
      }

      // ---------- episode family (verbatim, same-connection immediate txs) ----------
      while (progress.episodesCommitted < plan.families.episodes.episodes) {
        const from = progress.episodesCommitted;
        const to = Math.min(from + CHUNK_ROWS, plan.families.episodes.episodes);
        store.runInImmediateTransaction(() => {
          copyEpisodeRows(db, handle, from, to);
          progress.episodesCommitted = to;
          writeProgressInTx(handle, progress);
        });
        crashPoint(options, `episode-chunk:${progress.episodesCommitted}:committed`);
      }
      const derivedTables: Array<{ key: "stepsCommitted" | "eventsCommitted" | "sessionProjectsCommitted"; table: "episode_steps" | "episode_events" | "session_projects"; planned: number }> = [
        { key: "stepsCommitted", table: "episode_steps", planned: plan.families.episodes.steps },
        { key: "eventsCommitted", table: "episode_events", planned: plan.families.episodes.events },
        { key: "sessionProjectsCommitted", table: "session_projects", planned: plan.families.sessionProjects.rows },
      ];
      for (const spec of derivedTables) {
        while (progress[spec.key] < spec.planned) {
          const from = progress[spec.key];
          const to = Math.min(from + DERIVED_CHUNK_ROWS, spec.planned);
          store.runInImmediateTransaction(() => {
            copyTableChunk(db, handle, spec.table, from, to);
            progress[spec.key] = to;
            writeProgressInTx(handle, progress);
          });
          crashPoint(options, `derived:${spec.table}:${progress[spec.key]}:committed`);
        }
      }

      // ---------- final transaction: verbatim baseline pins + import marker row ----------
      if (!progress.baselineCommitted || !progress.importMarkerRowCommitted) {
        store.runInImmediateTransaction(() => {
          if (!progress.baselineCommitted) {
            for (const pin of plan.families.baseline.pinTargets) {
              try {
                // Preserved timestamps: the baseline row carries the SOURCE
                // pin's updated_at (allowed preservation metadata), never a clock.
                handle
                  .prepare(
                    `INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)
                     ON CONFLICT(memory_id) DO UPDATE SET slot = excluded.slot, updated_at = baseline.updated_at`,
                  )
                  .run(pin.slot, pin.memoryId, pin.updatedAt);
              } catch (e) {
                throw new Error(`import-v02: baseline pin slot ${pin.slot} (memoryId ${pin.memoryId}) refused: ${e instanceof Error ? e.message : String(e)}`);
              }
            }
            progress.baselineCommitted = true;
          }
          if (!handle.prepare("SELECT value FROM store_state WHERE key = ?").get(IMPORT_STATE_KEY)) {
            const importRowValue = {
              planDigest: plan.planDigest,
              lane: "phase-b",
              sourceMemoryDbSha256: plan.source.memoryDb.sha256,
              sourceTreeDigest: plan.source.treeDigest,
              families: plan.reconciliation.families,
            };
            handle
              .prepare(`INSERT INTO store_state (key, value, updated_at) VALUES (?, ?, ?)`)
              .run(IMPORT_STATE_KEY, canonJson(importRowValue), Date.now());
          }
          progress.importMarkerRowCommitted = true;
          writeProgressInTx(handle, progress);
          crashPoint(options, "final-tx:inside");
        });
        crashPoint(options, "final-tx:committed");
      }

      // ---------- post-write source digest re-verification ----------
      let unchangedDuringApply = digestTree(sourceRoot) === plan.source.treeDigest;
      if (unchangedDuringApply) {
        try {
          unchangedDuringApply = sha256Bytes(dbPath) === plan.source.memoryDb.sha256;
        } catch {
          unchangedDuringApply = false;
        }
      }
      if (unchangedDuringApply) {
        unchangedDuringApply = sourceWalDigest(sourceRoot) === appliedWalDigestBefore;
      }
      if (unchangedDuringApply) {
        const fingerprintAfter = sourceContentFingerprint(snapshot.db, auditRetainedQuick(snapshot.db), plan.schema);
        unchangedDuringApply = fingerprintAfter === plan.source.contentFingerprint;
      }
      if (!unchangedDuringApply) {
        throw new Error(
          "import-v02: the source changed during apply (tree/sha delta); completion refused and receipt denied. The target keeps its watermark; resume only after the operator re-verifies the source",
        );
      }

      // ---------- measured target state ----------
      const memoryByStatus: Record<string, number> = {};
      for (const r of handle.prepare("SELECT status AS k, COUNT(*) AS n FROM memories GROUP BY status").all() as Array<Record<string, unknown>>) {
        memoryByStatus[String(r.k)] = Number(r.n ?? 0);
      }
      const memoryRows = readOnlyTableCount(handle, "memories");
      const episodesN = readOnlyTableCount(handle, "episodes");
      const stepsN = readOnlyTableCount(handle, "episode_steps");
      const eventsN = readOnlyTableCount(handle, "episode_events");
      const sessionProjectsN = readOnlyTableCount(handle, "session_projects");
      const baselineN = readOnlyTableCount(handle, "baseline");
      const revisionAfter = store.getMemoryRevision();

      // ---------- per-unit ledger (re-derived from plan + target: resume-safe) ----------
      const acceptedIds = new Set(planAccepted.map((r) => r.id));
      const memoryAccepted = plan.families.memories.accepted.map((entry) => {
        const seqRow = handle.prepare("SELECT seq FROM memories_seq WHERE memory_id = ?").get(entry.id) as { seq?: unknown } | undefined;
        if (seqRow == null || typeof seqRow.seq !== "number") {
          throw new Error(`import-v02: reconciliation failure: memory id ${entry.id} is not present in the target memories_seq`);
        }
        const rec: MemoryRecord | undefined = store!.getMemory(entry.id);
        if (!rec) throw new Error(`import-v02: reconciliation failure: memory id ${entry.id} is not present in the target`);
        const sourceRow = acceptedRows.get(entry.id);
        const supersedes = sourceRow?.supersedes ?? null;
        // Deterministic redaction accounting re-derivation (resume-safe): the
        // SAME pure mapping that wrote the target decides which parts were
        // redacted / tombstoned / nulled in the operational artifact.
        const ledgerDemotion = demotions.get(entry.id);
        let mappedRedactions: CredentialRowMapping["redactions"] | undefined;
        if (ledgerDemotion === "credential-content-demotion" && sourceRow) {
          mappedRedactions = mapCredentialDemotedRow(sourceRow).redactions;
        }
        const redactionFlags: { contentRedacted?: true; evidenceRedacted?: true; metaRedacted?: true } = {};
        if (mappedRedactions?.content) redactionFlags.contentRedacted = true;
        if (mappedRedactions?.evidence) redactionFlags.evidenceRedacted = true;
        if (mappedRedactions?.meta) redactionFlags.metaRedacted = true;
        return {
          id: entry.id,
          legacySeq: entry.legacySeq,
          targetSeq: Number(seqRow.seq),
          status: rec.status,
          ...(demotions.has(entry.id) ? { demotion: demotions.get(entry.id) } : {}),
          ...redactionFlags,
          ...(supersedes != null ? { supersedes } : {}),
          ...(supersedes != null && !acceptedIds.has(supersedes) ? { integrityNote: "supersedes-target-absent" } : {}),
        };
      });
      memoryAccepted.sort((a, b) => a.legacySeq - b.legacySeq || (a.id < b.id ? -1 : 1));

      // ---------- reconciliation (exact identity per family, measured) ----------
      const reconciliation = plan.reconciliation.families;
      const reconciliationFailures: string[] = [];
      if (memoryRows !== reconciliation["memories"].accepted) {
        reconciliationFailures.push(`memories target=${memoryRows} planned=${reconciliation["memories"].accepted}`);
      }
      if (episodesN !== plan.families.episodes.episodes || stepsN !== plan.families.episodes.steps || eventsN !== plan.families.episodes.events) {
        reconciliationFailures.push(`episodes target=${episodesN}/${plan.families.episodes.episodes} steps=${stepsN}/${plan.families.episodes.steps} events=${eventsN}/${plan.families.episodes.events}`);
      }
      if (sessionProjectsN !== reconciliation["sessionProjects"].accepted) {
        reconciliationFailures.push(`sessionProjects target=${sessionProjectsN} planned=${reconciliation["sessionProjects"].accepted}`);
      }
      if (baselineN !== reconciliation["baseline"].accepted) {
        reconciliationFailures.push(`baseline target=${baselineN} planned=${reconciliation["baseline"].accepted}`);
      }
      const quarantinedN = Number((handle.prepare("SELECT COUNT(*) AS n FROM memories WHERE status = 'quarantined'").get() as { n?: unknown }).n ?? 0);
      if (quarantinedN < plan.families.memories.plannedDemotions.length) {
        reconciliationFailures.push(`demoted-quarantine rows target=${quarantinedN} planned>=${plan.families.memories.plannedDemotions.length}`);
      }
      for (const demotion of plan.families.memories.plannedDemotions) {
        const row = memoryAccepted.find((m) => m.id === demotion.id);
        if (!row) {
          reconciliationFailures.push(`planned demotion row ${demotion.id} is absent from the applied target`);
        } else if (row.status !== "quarantined") {
          reconciliationFailures.push(`planned demotion row ${demotion.id} did not land as quarantined (status ${row.status})`);
        }
      }
      for (const [family, identity] of Object.entries(reconciliation)) {
        if (identity.accepted + identity.retained + identity.unsupported !== identity.total) {
          reconciliationFailures.push(`${family} plan identity accepts ${identity.accepted} + retained ${identity.retained} + unsupported ${identity.unsupported} != total ${identity.total}`);
        }
      }
      if (reconciliationFailures.length > 0) {
        throw new Error(`import-v02: verdict-count reconciliation failed; apply refuses to finish (no receipt): ${reconciliationFailures.join("; ")}`);
      }

      // ---------- restore-grade backup verification ----------
      const backupCheck = verifyBackupManifest(destRoot);
      if (!backupCheck.ok) {
        throw new Error("import-v02: the backup manifest digest verification failed; the restore-grade claim is false and the receipt is refused");
      }

      crashPoint(options, "apply:before-docs");

      const quickCheckOk = runTargetQuickCheck(handle);
      const unfinishedFamilies: string[] = [];
      for (const [family, identity] of Object.entries(reconciliation)) {
        if (identity.accepted + identity.retained + identity.unsupported !== identity.total) unfinishedFamilies.push(family);
      }

      // ledger disposition for unsupported families (ids/coordinates)
      const ledger: ImportLedger = {
        ledgerVersion: 1,
        phase: "B",
        planDigest: plan.planDigest,
        sourceMemoryDbSha256: plan.source.memoryDb.sha256,
        sourceTreeDigest: plan.source.treeDigest,
        memoryAccepted,
        memoryUnsupported: [...plan.families.memories.unsupported],
        baselineAccepted: plan.families.baseline.pinTargets.map((p) => ({ slot: p.slot, memoryId: p.memoryId })),
        baselineUnsupported: [...plan.families.baseline.unsupported],
        episodesAccepted: { episodes: episodesN, steps: stepsN, events: eventsN },
        sessionProjectsAccepted: sessionProjectsN,
        retained: {
          persona: {
            versions: plan.families.persona.counts.personaVersions ?? 0,
            files: plan.families.persona.counts.personaFiles ?? 0,
          },
          generatedSkills: {
            dirs: plan.families.generatedSkills.counts.generatedSkillDirs ?? 0,
            names: listsSkillNames({ skillsRoot: applySkillsRoot }),
          },
          conversations: {
            files: plan.families.conversations.counts.files ?? 0,
            validLines: plan.families.conversations.counts.validLines ?? 0,
            malformedLines: plan.families.conversations.invalidLines.filter((e) => e.kind === "malformed").length,
            duplicateSeqLines: plan.families.conversations.invalidLines.filter((e) => e.kind === "duplicateSeq").length,
          },
          cursors: { sessions: plan.families.cursors.counts.sessions ?? 0 },
          scenes: { rows: plan.families.scenes.counts.rows ?? 0 },
        },
        unsupportedFamilies: [
          { family: "vectors", counts: plan.families.vectors.counts, note: plan.families.vectors.note },
          { family: "unknownSchemaObjects", counts: plan.families.unknownSchemaObjects.counts, note: plan.families.unknownSchemaObjects.note },
        ],
        chunkWatermark: { committedChunks: progress.chunksCommitted, memoryRowsCommitted: progress.memoryCommitted },
      };

      const result: ImportResult = {
        resultVersion: 1,
        phase: "B",
        mode: "apply",
        planDigest: plan.planDigest,
        approval: { tokenVerified: true },
        source: {
          storeRoot: sourceRoot,
          memoryDbSha256: plan.source.memoryDb.sha256,
          treeDigest: plan.source.treeDigest,
          unchangedDuringApply: true,
        },
        target: {
          normalizedRoot: normalizedDir,
          ownerMarkerVerified: true,
          schemaMarkers: { v1: true, v2: true },
          quickCheckOk,
          revisionBefore,
          revisionAfter,
          memoryRows,
          memoryByStatus,
          episodeRows: { episodes: episodesN, steps: stepsN, events: eventsN },
          baselineRows: baselineN,
          sessionProjects: sessionProjectsN,
        },
        backup: {
          files: backupCheck.files,
          bytes: backupCheck.bytes,
          manifestVerified: backupCheck.ok,
          restoreFidelityRule:
            "backup/ is a byte-faithful restore-grade tree whose memory.db is a VACUUM INTO consistency snapshot (WAL-inclusive) with byte-verbatim companions (conversations/, persona/, vectors.db, skills root, settings file) and a sorted digested MANIFEST.sha256; it is private restore evidence, never an operational export",
        },
        verdictTotals: reconciliation,
        reconciliation: { allReconciled: true, families: reconciliation },
        unfinishedFamilies,
        limits: [
          "credential-shaped memory content, evidence entries and projectId/sessionId id strings are REDACTED in the operational target before any write (row demoted to status='quarantined', never FTS-indexed, injectable or acknowledged; ledger records which parts were redacted); the raw verbatim copy lives only in the private 0700 restore-grade backup",
          "persona_versions rows, persona/ files and generated dsi-* skills are retained verbatim in the backup only (inactive by lane contract) and are NOT imported into the operational target",
          "valid conversation lines stay as extraction-backlog material in the backup; the v0.2 journal is NOT enqueued here (seq-zero / >200k canonical-reread / pre-fix truncation honesty is owned by the journal lanes)",
          "extract_state legacy cursors are recorded for orientation only and are never acknowledged as consumed",
          "vectors.db embeddings are counted as unsupported-evidenced (rebuildable disposable index), never imported or acked",
          "unknown schema_state markers and unknown tables are counted with opaque digested identifiers only",
          "scenes rows (derived L2 aggregates) are retained in the backup only — this family is explicitly NOT manually materialized into the operational target",
          "runtime access stats (access_count/read_count/last_read_at) reset to 0 in the operational target; the backup preserves them byte-verbatim",
          "legacy memory-importance out-of-range (non-1..10) rows and meta fields whose types cannot be preserved cannot be written through the seam and land in unsupported-evidenced accounting with their coordinates",
        ],
        safety: {
          zeroPartialWritesGuarantee:
            "every memory row-set and its same-tx progress ledger row commit together via the storage import seam; a refusal or SIGKILL rolls back the open chunk entirely (no partial row, no FTS/meta/seq/revision orphan)",
          collisionsRefused: 0,
          sameTxChunkProgressLedger: true,
          sourceOpenedReadOnly: true,
          noAcknowledgementOfUnsupported: true,
          personaAndGeneratedSkillsInactive: true,
        },
        determinismNote:
          "plan/ledger/receipt JSON are byte-deterministic (no wall-clock entropy); SQLite-side bookkeeping columns only use the clock; timestamps in the target come only from preserved source data",
      };


      if (!existsSync(join(destRoot, "ledger.json"))) {
        writeJsonExclusive(join(destRoot, "ledger.json"), ledger);
      }
      crashPoint(options, "apply:after-ledger-write");
      writeJsonExclusive(join(destRoot, "receipt.json"), result);
      crashPoint(options, "apply:after-receipt-write");

      return { result, ledger, plan };
    } finally {
      closeSnapshot(snapshot);
    }
  } finally {
    try {
      store?.close();
    } catch {
      /* noop */
    }
  }
}

function readStateRow(handle: DatabaseSync, key: string): string | undefined {
  const row = handle.prepare("SELECT value FROM store_state WHERE key = ?").get(key) as { value?: unknown } | undefined;
  return row == null ? undefined : String(row.value);
}

function runTargetQuickCheck(handle: DatabaseSync): boolean {
  try {
    const row = handle.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
    return row != null && String(Object.values(row)[0] ?? "") === "ok";
  } catch {
    return false;
  }
}


/** node:sqlite bindable scalar guard (including ArrayBufferView inputs). */
function isSqlizable(v: unknown): v is SQLInputValue {
  return v == null || typeof v === "number" || typeof v === "string" || typeof v === "bigint" || ArrayBuffer.isView(v);
}

function parseEvidence(evidenceText: string): MemoryEvidence[] {
  const parsed = JSON.parse(evidenceText) as unknown;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((e): e is MemoryEvidence => typeof e === "object" && e !== null);
}

function listsSkillNames(options: { skillsRoot?: string }): string[] {
  if (!options.skillsRoot || !existsSync(options.skillsRoot)) return [];
  return readdirSync(options.skillsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(SKILL_PREFIX))
    .map((e) => e.name)
    .sort();
}

function stripPlanDigestFields(plan: ImportPlan): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(plan as unknown as Record<string, unknown>) };
  delete copy["planDigest"];
  delete copy["approvalToken"];
  return copy;
}

function isImportPlan(planDoc: ImportPlan): ImportPlan {
  if (!planDoc || typeof planDoc !== "object") throw new Error("import-v02: the provided plan document is not a Phase B import plan (document withheld)");
  if (planDoc.planVersion !== 1 || planDoc.phase !== "B" || !planDoc.source || !planDoc.families || !planDoc.reconciliation) {
    throw new Error("import-v02: the provided plan document is not a Phase B import plan; refusal with zero writes");
  }
  return planDoc;
}
