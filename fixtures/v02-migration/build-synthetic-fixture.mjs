/**
 * Synthetic legacy-store fixture builder for scripts/test-migration-v02.mjs.
 *
 * Everything this module writes is SYNTHETIC test data under a caller-provided
 * temporary directory (canonical names mirror the legacy v0.1 dsh-self-improved
 * store: memory.db with schema_state v1+v2, conversations/*.jsonl, persona/,
 * vectors.db, and a dsi-* prefixed skills repository). No production, live or
 * real user data is ever read.
 *
 * Variants:
 *  - "standard"       : complete, supported legacy store (golden counts in golden/expected-standard.json)
 *  - "unsupported"    : unknown side table + missing schema_state v2 marker (must be classified unsupported)
 *  - "pre-migration"  : no v1/v2 markers at all (legacy pre-Hermes store)
 *  - "missing"        : no memory.db at all
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

// Fixed synthetic clock (never Date.now(): fixture content is byte-deterministic)
const T0 = 1_700_000_000_000;

export const CANARIES = {
  memory: "MEMORY-CANARY-never-in-report",
  slice: "SLICE-TEXT-CANARY-never-in-report",
  persona: "PERSONA-PROSE-CANARY-never-in-report",
  skill: "SKILL-BODY-CANARY-never-in-report",
  apiKey: "sk-canary-apikey-never-leak-0000",
  unknownLeaf: "UNKNOWN-SETTINGS-VALUE-never-carry",
  // schema_state canaries (PRIVACY defect fix): an arbitrary UNKNOWN marker key
  // whose VALUE is a private secret must never appear raw in any report.
  schemaUnknownKey: "legacy-private-note",
  schemaSecret: "SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT",
  // adversarial category-metadata canaries (memory columns outside the legacy
  // contract vocabulary): never reportable verbatim.
  statusValue: "SYNTHETIC-STATUS-METACANARY-never-report",
  kindValue: "SYNTHETIC-KIND-METACANARY-never-report",
  provenanceValue: "SYNTHETIC-PROVENANCE-METACANARY-never-report",
  sourceValue: "SYNTHETIC-SOURCE-METACANARY-never-report",
  tableName: "secrettable_probe_never_report",
  columnName: "secretcolumn_probe_never_report",
  settingsLine: "secret private settings line never parseable",
};

function schemaDdl(db) {
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5, access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', supersedes TEXT
    ) STRICT;
    CREATE VIRTUAL TABLE memories_fts USING fts5(search_text, kind UNINDEXED, content_rowid UNINDEXED, tokenize='unicode61');
    CREATE TABLE memories_meta (
      memory_id TEXT PRIMARY KEY, provenance TEXT NOT NULL DEFAULT 'unknown',
      source TEXT NOT NULL DEFAULT 'legacy', scope TEXT NOT NULL DEFAULT 'global',
      project_id TEXT, session_id TEXT, confidence REAL NOT NULL DEFAULT 0.3,
      expires_at INTEGER, evidence TEXT NOT NULL DEFAULT '[]',
      read_count INTEGER NOT NULL DEFAULT 0, last_read_at INTEGER
    ) STRICT;
    CREATE TABLE memories_seq (memory_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT;
    CREATE TABLE baseline (slot INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE session_projects (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE extract_state (
      session_id TEXT PRIMARY KEY, processed_seq INTEGER NOT NULL DEFAULT 0,
      pending_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE scenes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, markdown TEXT NOT NULL,
      memory_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE persona_versions (ver INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at INTEGER NOT NULL, mem_watermark INTEGER) STRICT;
    CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
    CREATE TABLE episode_events (
      session_id TEXT NOT NULL, kind TEXT NOT NULL, call_id TEXT,
      turn INTEGER NOT NULL, step INTEGER, seq INTEGER NOT NULL, at INTEGER NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, episode_id TEXT,
      PRIMARY KEY (session_id, kind, call_id, seq)
    ) STRICT;
    CREATE TABLE episodes (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
      turn INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      started_at INTEGER NOT NULL, ended_at INTEGER, updated_at INTEGER NOT NULL,
      first_seq INTEGER, last_seq INTEGER, reviewed_at INTEGER, summary TEXT,
      confidence REAL, fingerprint TEXT, delegated INTEGER NOT NULL DEFAULT 0, reject_reason TEXT
    ) STRICT;
    CREATE TABLE episode_steps (
      episode_id TEXT NOT NULL, ordinal INTEGER NOT NULL, call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL, arguments_redacted TEXT NOT NULL, result_excerpt TEXT NOT NULL,
      is_error INTEGER NOT NULL, error_name TEXT, error_code TEXT,
      call_seq INTEGER, result_seq INTEGER, call_at INTEGER, result_at INTEGER,
      args_truncated INTEGER NOT NULL DEFAULT 0, result_truncated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (episode_id, ordinal), UNIQUE (episode_id, call_id)
    ) STRICT;
  `);
}

/**
 * Memory rows. All content is synthetic, carries the no-leak canary, and the
 * fixture README documents the exact expected classification of each row.
 */
function memoryDefinitions() {
  const rows = [];
  const add = (id, kind, content, { provenance, source = "llm-extract", scope = "global", projectId = null, sessionId = null, status = "active", supersedes = null, importance = 5, evidence = "[]", withMeta = true }) => {
    rows.push({ id, kind, content, importance, status, supersedes, provenance, source, scope, projectId, sessionId, evidence, withMeta });
  };
  add("dsi-fixture-01", "fact", `${CANARIES.memory} user fact alpha`, { provenance: "user", evidence: JSON.stringify([{ episodeId: "ep-fixture-1", callId: "call-ok-1" }]) });
  add("dsi-fixture-02", "preference", `${CANARIES.memory} prefers light theme`, { provenance: "user" });
  add("dsi-fixture-03", "preference", `${CANARIES.memory} prefers dark theme now`, { provenance: "user", supersedes: "dsi-fixture-03-old" });
  add("dsi-fixture-04", "fact", `${CANARIES.memory} user fact alpha`, { provenance: "user" });
  add("dsi-fixture-05", "fact", `${CANARIES.memory} assistant observation`, { provenance: "assistant", source: "llm-extract-pasted" });
  add("dsi-fixture-06", "fact", `${CANARIES.memory} derived consolidation note`, { provenance: "derived" });
  add("dsi-fixture-07", "fact", `${CANARIES.memory} unknown-provenance claim`, { provenance: "unknown", source: "legacy", evidence: JSON.stringify([{ episodeId: "ep-missing", callId: "call-lost" }]) });
  add("dsi-fixture-08", "fact", `${CANARIES.memory} captured system text`, { provenance: "system", source: "legacy" });
  add("dsi-fixture-09", "fact", `${CANARIES.memory} captured tool output`, { provenance: "tool", source: "legacy" });
  add("dsi-fixture-10", "fact", `${CANARIES.memory} coordinator task brief`, { provenance: "coordinator", source: "legacy" });
  add("dsi-fixture-11", "fact", `${CANARIES.memory} skill-authored note`, { provenance: "skill", source: "legacy" });
  add("dsi-fixture-12", "instruction", `${CANARIES.memory} leaked instruction row`, { provenance: "user" });
  add("dsi-fixture-13", "persona", `${CANARIES.memory} persona flavor sentence`, { provenance: "persona" });
  add("dsi-fixture-14", "persona", `${CANARIES.memory} persona flavor sentence two`, { provenance: "user" });
  add("dsi-fixture-15", "event", `${CANARIES.memory} task-local progress note`, { provenance: "user", scope: "project", projectId: "proj-synth", sessionId: "session-synth" });
  add("dsi-fixture-16", "event", `${CANARIES.memory} session-scoped step`, { provenance: "user", scope: "session", sessionId: "session-synth" });
  add("dsi-fixture-17", "fact", `${CANARIES.memory} pasted demoted draft`, { provenance: "user", source: "llm-extract-pasted" });
  add("dsi-fixture-18", "fact", `${CANARIES.memory} explicitly forgotten fact`, { provenance: "user", status: "forgotten" });
  add("dsi-fixture-19", "fact", `${CANARIES.memory} archived during previous migration`, { provenance: "user", status: "migrated" });
  add("dsi-fixture-20", "fact", `${CANARIES.memory} already quarantined row`, { provenance: "unknown", status: "quarantined" });
  add("dsi-fixture-21", "fact", `${CANARIES.memory} decayed during governance`, { provenance: "user", status: "decayed" });
  add("dsi-fixture-22", "fact", `${CANARIES.memory} broken supersession probe`, { provenance: "user", supersedes: "dsi-fixture-nonexistent" });
  add("dsi-fixture-23", "fact", `${CANARIES.memory} drifted row without meta side entry`, { provenance: null, source: null, scope: null, withMeta: false, evidence: null });
  // Chain anchor for the valid supersession in dsi-fixture-03
  add("dsi-fixture-03-old", "preference", `${CANARIES.memory} older theme preference`, { provenance: "user", status: "corrected" });
  return rows;
}

function insertMemoryRows(db, variant) {
  const defs = memoryDefinitions();
  const insertMemory = db.prepare(
    "INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
  );
  const insertMeta = db.prepare(
    "INSERT INTO memories_meta (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at) VALUES (?, ?, ?, ?, ?, ?, 0.5, NULL, ?, 0, NULL)",
  );
  const insertSeq = db.prepare("INSERT INTO memories_seq (memory_id, seq) VALUES (?, ?)");
  defs.forEach((row, index) => {
    const createdAt = T0 + index * 1_000;
    insertMemory.run(row.id, row.kind, row.content, row.importance, createdAt, createdAt + 500, row.status, row.supersedes);
    if (row.withMeta && row.provenance != null) {
      insertMeta.run(row.id, row.provenance, row.source, row.scope, row.projectId, row.sessionId, row.evidence ?? "[]");
    }
    insertSeq.run(row.id, index + 1);
  });
}

function sliceFile(sessionId, records) {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

function buildConversations(memoryRoot) {
  const dir = join(memoryRoot, "conversations");
  mkdirSync(dir, { recursive: true });
  const s1 = [];
  for (let seq = 0; seq < 12; seq++) {
    s1.push({ type: seq % 2 === 0 ? "user" : "assistant", seq, ts: T0 + seq * 100, text: `${CANARIES.slice} synthetic ${seq}` });
  }
  const s2 = [];
  for (let seq = 1; seq <= 8; seq++) {
    s2.push({ type: seq % 2 === 0 ? "user" : "assistant", seq, ts: T0 + seq * 100, text: `${CANARIES.slice} beta synthetic ${seq}` });
  }
  // deliberate duplicate seq line (unacknowledged duplicate evidence — audit case)
  s2.splice(6, 0, { type: "assistant", seq: 5, ts: T0 + 5_100, text: `${CANARIES.slice} beta duplicate 5` });
  const s5 = [];
  for (let seq = 0; seq < 3; seq++) {
    s5.push({ type: "user", seq, ts: T0 + seq * 100, text: `${CANARIES.slice} gamma synthetic ${seq}` });
  }
  writeFileSync(join(dir, "dsi-session-s1.jsonl"), sliceFile("s1", s1), "utf8");
  writeFileSync(join(dir, "dsi-session-s2.jsonl"), sliceFile("s2", [
    ...s2,
    "{not valid json malformed one}",
    "{neither is this",
  ]), "utf8");
  writeFileSync(join(dir, "dsi-session-s5.jsonl"), sliceFile("s5", s5), "utf8");
}

function buildEpisodes(db) {
  const insertEpisode = db.prepare(
    "INSERT INTO episodes (id, session_id, project_id, turn, status, started_at, ended_at, updated_at, first_seq, last_seq, reviewed_at, summary, confidence, fingerprint, delegated, reject_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  const nowish = T0 + 99_000;
  insertEpisode.run("ep-fixture-1", "dsi-session-s1", "proj-synth", 1, "succeeded", T0, nowish, nowish, 0, 11, nowish, "synthetic summary", 0.9, "fp-1", 0, null);
  insertEpisode.run("ep-fixture-2", "dsi-session-s1", "proj-synth", 2, "pending", T0, null, nowish, 1, 4, null, null, null, "fp-2", 1, null);
  insertEpisode.run("ep-fixture-3", "dsi-session-s2", "proj-synth", 1, "failed", T0, nowish, nowish, 2, 3, null, null, null, "fp-3", 0, "tool-exit");
  insertEpisode.run("ep-fixture-4", "dsi-session-s2", "proj-synth", 2, "rejected", T0, nowish, nowish, 3, 5, nowish, null, null, "fp-4", 0, "review-reject");
  const insertStep = db.prepare(
    "INSERT INTO episode_steps (episode_id, ordinal, call_id, tool_name, arguments_redacted, result_excerpt, is_error, error_name, error_code, call_seq, result_seq, call_at, result_at, args_truncated, result_truncated) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  insertStep.run("ep-fixture-1", 1, "call-ok-1", "bash", "{}", "ok excerpt", 0, null, null, 1, 2, T0, T0 + 10, 0, 0);
  insertStep.run("ep-fixture-1", 2, "call-ok-2", "read", "{}", "ok excerpt 2", 0, null, null, 3, 4, T0, T0 + 20, 0, 0);
  insertStep.run("ep-fixture-1", 3, "call-ok-3", "edit", "{}", "ok excerpt 3", 0, null, null, 5, 6, T0, T0 + 30, 0, 0);
  // e2: one unpaired call (no result_seq)
  insertStep.run("ep-fixture-2", 1, "call-pend-1", "bash", "{}", "pending excerpt", 0, null, null, 7, null, T0, null, 0, 0);
  insertStep.run("ep-fixture-2", 2, "call-pend-2", "read", "{}", "pending excerpt 2", 0, null, null, 8, 9, T0, T0 + 5, 0, 0);
  // e3: failed step, unpaired
  insertStep.run("ep-fixture-3", 1, "call-fail-1", "bash", "{}", "failed excerpt", 1, "Error", "E1", 9, null, T0, null, 0, 0);
  // episode_events bookkeeping (delegated evidence for ep-fixture-2)
  db.prepare("INSERT INTO episode_events (session_id, kind, call_id, turn, step, seq, at, payload, created_at, episode_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("dsi-session-s1", "coordinator", "coord-1", 1, 0, 1, T0, "{}", nowish, "ep-fixture-2");
}

function buildPersona(memoryRoot, db) {
  for (let ver = 1; ver <= 3; ver++) {
    db.prepare("INSERT INTO persona_versions (content, created_at, mem_watermark) VALUES (?, ?, ?)")
      .run(`${CANARIES.persona} synthetic persona version ${ver}`, T0 + ver * 1_000, ver * 10);
  }
  const dir = join(memoryRoot, "persona");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "persona.md"), `${CANARIES.persona} synthetic persona mirror\n`, "utf8");
  writeFileSync(join(dir, "persona.md.bak1"), `${CANARIES.persona} synthetic persona backup\n`, "utf8");
}

function buildVectorDb(memoryRoot) {
  // Legacy runtime had no sqlite-vec: a plain sidecar db without memory_vec tables.
  const db = new DatabaseSync(join(memoryRoot, "vectors.db"));
  try {
    db.exec("CREATE TABLE embedding_notes (memory_id TEXT PRIMARY KEY, dims INTEGER NOT NULL) STRICT");
    db.prepare("INSERT INTO embedding_notes (memory_id, dims) VALUES (?, ?)").run("dsi-fixture-01", 1024);
  } finally {
    db.close();
  }
}

function buildSkillsRoot(homeRoot) {
  const root = join(homeRoot, "skills");
  mkdirSync(join(root, "dsi-fixture-alpha"), { recursive: true });
  mkdirSync(join(root, "dsi-fixture-beta"), { recursive: true });
  mkdirSync(join(root, "other-user-skill"), { recursive: true });
  writeFileSync(join(root, "dsi-fixture-alpha", "SKILL.md"), `# dsi-fixture-alpha\n${CANARIES.skill}\n`, "utf8");
  writeFileSync(join(root, "dsi-fixture-beta", "SKILL.md"), `# dsi-fixture-beta\n${CANARIES.skill}\n`, "utf8");
  writeFileSync(join(root, "other-user-skill", "SKILL.md"), "# user authored skill, untouched by migration\n", "utf8");
  return root;
}

export const SETTINGS_FIXTURE_YAML = `# synthetic settings patch; for migration-v02 tests only
plugins:
  other-plugin:
    unrelated: keep-out
    nested:
      deep: value
  self-improved:
    enabled: false
    debug: true
    storageRoot: /opt/synthetic/storage-root
    searchLimit: 5
    extract:
      intervalMinutes: 30
      batchMaxChars: 4200
      provider: synthetic-provider
      model: synthetic-model
      minImportance: 7
      provenanceFilter: relaxed
    recall:
      embedding:
        baseUrl: https://embed.synth.invalid/v1
        apiKey: ${CANARIES.apiKey}
        model: synthetic-embed-model
    episodeLearning:
      enabled: true
      captureArguments: false
      reviewEnabled: true
      operationalRecallEnabled: false
    legacyUnknownFlag: ${CANARIES.unknownLeaf}
`;

export function buildSyntheticHome(rootDir, variant = "standard") {
  const homeRoot = join(rootDir, "dsh-home");
  const memoryRoot = join(homeRoot, "memory");
  mkdirSync(memoryRoot, { recursive: true });
  if (variant === "missing") {
    rmSync(memoryRoot, { recursive: true, force: true });
    mkdirSync(join(rootDir, "dsh-home"), { recursive: true });
    const skillsRoot = buildSkillsRoot(homeRoot);
    const settingsPath = join(rootDir, "settings.yaml");
    writeFileSync(settingsPath, SETTINGS_FIXTURE_YAML, "utf8");
    return { homeRoot, memoryRoot, skillsRoot, settingsPath };
  }
  const dbPath = join(memoryRoot, "memory.db");
  const db = new DatabaseSync(dbPath);
  try {
    schemaDdl(db);
    if (variant !== "pre-migration") {
      db.prepare("INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)").run("v1", "provenance/scope metadata backfill + legacy instruction quarantine", T0);
      if (variant !== "unsupported") {
        db.prepare("INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)").run("v2", "episode learning tables (episodes/episode_steps/episode_events)", T0);
      }
      // The legacy store marks user_version as a courtesy mirror of its markers.
      db.exec("PRAGMA user_version = 2");
      // An arbitrary NON-contract schema_state row whose key and value are
      // private free-form text: the inventory must report presence/counts as
      // opaque digests only, never this content (see MIGRATION-IMPORT-PRIVACY.md).
      db.prepare("INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)")
        .run(CANARIES.schemaUnknownKey, CANARIES.schemaSecret, T0);
    }
    if (variant === "unsupported") {
      // Schema drift that the inventory must refuse rather than guess about:
      const drift = new DatabaseSync(dbPath);
      drift.exec("CREATE TABLE mystery_side_table (note TEXT NOT NULL) STRICT");
      drift.close();
    }
    insertMemoryRows(db, variant);
    buildConversations(memoryRoot);
    buildEpisodes(db);
    db.prepare("INSERT INTO session_projects (session_id, project_id, updated_at) VALUES (?, ?, ?)").run("dsi-session-s1", "proj-synth", T0);
    db.prepare("INSERT INTO session_projects (session_id, project_id, updated_at) VALUES (?, ?, ?)").run("dsi-session-s2", "proj-other", T0);
    // extract_state: s1 backlog (processed 0 of 12), s2 clean, s4 cursor without slice file
    const insertCursor = db.prepare("INSERT INTO extract_state (session_id, processed_seq, pending_seq, updated_at) VALUES (?, ?, ?, ?)");
    insertCursor.run("dsi-session-s1", 0, 12, T0);
    insertCursor.run("dsi-session-s2", 8, 8, T0);
    insertCursor.run("dsi-session-s4", 4, 4, T0);
    db.prepare("INSERT INTO scenes (id, title, markdown, memory_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("scene-1", "synthetic scene", `${CANARIES.persona} scene`, "[]", T0, T0);
    db.prepare("INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)").run(1, "dsi-fixture-01", T0);
    buildPersona(memoryRoot, db);
  } finally {
    db.close();
  }
  buildVectorDb(memoryRoot);
  const skillsRoot = buildSkillsRoot(homeRoot);
  const settingsPath = join(rootDir, "settings.yaml");
  writeFileSync(settingsPath, SETTINGS_FIXTURE_YAML, "utf8");
  return { homeRoot, memoryRoot, skillsRoot, settingsPath };
}
