/**
 * Synthetic legacy store fixture builder for scripts/test-v02-import-lane.mjs
 * (Phase B import lane). Everything written here is SYNTHETIC test data under a
 * caller-provided temporary directory; canonical names mirror the legacy v0.1
 * dsh-self-improved store. No production, live or real user data is read.
 *
 * Adversarial coverage:
 *  - memory.db opened in WAL mode (a real -wal companion exists on disk);
 *  - secret canaries across every lane (memory content, slice text, persona
 *    prose, skill bodies, settings apiKey, unknown schema_state marker value);
 *  - an ACTIVE credential-shaped memory row (demoted to quarantined at apply,
 *    verbatim only in the backup), an active instruction-kind row and an
 *    active persona-provenance row (conservative demotions);
 *  - rows that CANNOT be imported through the import seam (missing meta,
 *    unparseable evidence, out-of-contract kind/provenance/scope, importance
 *    out of range, drifted non-integer timestamp) → unsupported-evidenced;
 *  - broken supersedes + parseable evidence referencing a missing episode;
 *  - duplicate + malformed conversation JSONL lines; cursors with a backlog
 *    (never acknowledged); persona_versions + persona/ prose files;
 *    generated dsi-* INACTIVE fake skills (never activated anywhere);
 *    a vectors.db lookalike; scenes rows; session_projects; baseline pins
 *    (eligible, dangling, ineligible-provenance); settings patch YAML.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Fixed synthetic clock (never Date.now(); fixture content is byte-deterministic)
const T0 = 1_700_000_000_000;

export const CANARIES = {
  memory: "MEMORY-CANARY-never-in-lane-docs",
  slice: "SLICE-TEXT-CANARY-never-in-lane-docs",
  persona: "PERSONA-PROSE-CANARY-never-in-lane-docs",
  skill: "SKILL-BODY-CANARY-never-in-lane-docs",
  apiKey: "sk-canary-apikey-never-leak-0000-import",
  unknownLeaf: "UNKNOWN-SETTINGS-VALUE-never-carry",
  schemaSecret: "SYNTHETIC_SCHEMA_SECRET_NEVER_IN_LANEDOCS",
  credentialContent: "my api_key is sk-canary-credential-content-0000 keep-out",
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
    CREATE UNIQUE INDEX idx_baseline_memory_id ON baseline(memory_id);
    CREATE TABLE session_projects (session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    CREATE TABLE extract_state (
      session_id TEXT PRIMARY KEY, processed_seq INTEGER NOT NULL DEFAULT 0,
      pending_seq INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE scenes (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, markdown TEXT NOT NULL,
      memory_ids TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE persona_versions (
      ver INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL,
      created_at INTEGER NOT NULL, mem_watermark INTEGER
    ) STRICT;
    CREATE TABLE schema_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, applied_at INTEGER NOT NULL) STRICT;
    CREATE TABLE probe_secrettable (note TEXT NOT NULL) STRICT;
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
      is_error INTEGER NOT NULL, error_name TEXT, error_code TEXT, call_seq INTEGER, result_seq INTEGER,
      call_at INTEGER, result_at INTEGER, args_truncated INTEGER NOT NULL DEFAULT 0,
      result_truncated INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (episode_id, ordinal), UNIQUE (episode_id, call_id)
    ) STRICT;
  `);
}

/**
 * Memory rows in insertion order; index+1 becomes the legacy insertion
 * watermark that memories_seq records. Expected classification is asserted by
 * the suite against these definitions:
 *  1..120 bulk-fact-*          → accepted (status preserved active)
 *  alpha-pref-* family         → accepted (corrected status preserved; supersedes chain intact)
 *  alpha-paste/derived/unknown/system/tool/coordinator/skill/forgotten/
 *    migrated/quarantined/decayed/supersedes-broken/persona-mirror → accepted verbatim
 *  alpha-credential-row        → accepted + planned demotion credential-content-demotion
 *  alpha-instruction-row       → accepted + planned demotion instruction-conservative-demotion
 *  alpha-persona-row           → accepted + planned demotion persona-policy-demotion
 *  bad-* rows                  → unsupported-evidenced (exact reasons in tests)
 */
export function memoryDefinitions() {
  const rows = [];
  const add = (id, kind, content, opts = {}) => {
    rows.push({
      id, kind, content,
      importance: opts.importance ?? 5,
      status: opts.status ?? "active",
      supersedes: opts.supersedes ?? null,
      provenance: opts.provenance ?? "user",
      source: opts.source ?? "legacy",
      scope: opts.scope ?? "global",
      projectId: opts.projectId ?? null,
      sessionId: opts.sessionId ?? null,
      evidence: opts.evidence ?? "[]",
      expiresAt: opts.expiresAt ?? null,
      withMeta: opts.withMeta ?? true,
      confidence: opts.confidence ?? 0.5,
      drift: opts.drift ?? null, // { kind } | { created_at } free-text probes
    });
  };
  for (let n = 1; n <= 120; n++) {
    add(`bulk-fact-${String(n).padStart(4, "0")}`, "fact", `${CANARIES.memory} bulk synthetic fact ${n}`, { provenance: "user" });
  }
  add("alpha-pref-light", "preference", `${CANARIES.memory} prefers light theme`, { provenance: "user", importance: 9 });
  add("alpha-pref-theme-old", "preference", `${CANARIES.memory} older theme preference`, { provenance: "user", status: "corrected" });
  add("alpha-pref-dark", "preference", `${CANARIES.memory} prefers dark theme now`, { provenance: "user", supersedes: "alpha-pref-theme-old" });
  add("alpha-paste-obs", "fact", `${CANARIES.memory} pasted-suspicious observation`, { provenance: "assistant", source: "llm-extract-pasted" });
  add("alpha-derived-note", "fact", `${CANARIES.memory} derived consolidation note`, {
    provenance: "derived",
    evidence: JSON.stringify([{ episodeId: "ep-live-1", callId: "call-ok-1" }]),
  });
  add("alpha-unknown-note", "fact", `${CANARIES.memory} unknown-provenance claim`, {
    provenance: "unknown",
    evidence: JSON.stringify([{ episodeId: "ep-never-exists", callId: "ghost" }]),
  });
  add("alpha-system-note", "fact", `${CANARIES.memory} captured system text`, { provenance: "system" });
  add("alpha-tool-note", "fact", `${CANARIES.memory} captured tool output`, { provenance: "tool" });
  add("alpha-coordinator-brief", "fact", `${CANARIES.memory} coordinator task brief`, { provenance: "coordinator", scope: "project", projectId: "proj-synth" });
  add("alpha-skill-note", "fact", `${CANARIES.memory} skill-authored note`, { provenance: "skill" });
  add("alpha-forgotten", "fact", `${CANARIES.memory} explicitly forgotten fact`, { provenance: "user", status: "forgotten" });
  add("alpha-migrated", "fact", `${CANARIES.memory} archived during previous lifecycle`, { provenance: "user", status: "migrated" });
  add("alpha-quarantined", "fact", `${CANARIES.memory} already quarantined row`, { provenance: "unknown", status: "quarantined" });
  add("alpha-decayed", "fact", `${CANARIES.memory} decayed during governance`, { provenance: "user", status: "decayed" });
  add("alpha-supersedes-broken", "fact", `${CANARIES.memory} supersession probe into the void`, { provenance: "user", supersedes: "id-never-existing-target" });
  add("alpha-credential-row", "fact", `${CANARIES.credentialContent} used for the extraction tool`, { provenance: "user", importance: 8 });
  add("alpha-instruction-row", "instruction", `${CANARIES.memory} leaked instruction-style row`, { provenance: "user" });
  add("alpha-persona-row", "persona", `${CANARIES.memory} persona flavor sentence`, { provenance: "persona" });
  add("alpha-persona-mirror", "persona", `${CANARIES.memory} persona flavor mirror`, { provenance: "user" });
  add("bad-missing-meta", "fact", `${CANARIES.memory} drifted row without meta side entry`, { withMeta: false });
  add("bad-evidence-json", "fact", `${CANARIES.memory} broken evidence JSON`, { evidence: "{not parseable at all" });
  add("bad-kind-probe", "fact", `${CANARIES.memory} out-of-contract kind probe`, { drift: { kind: "SYNTH-KIND-Secretprobe" }, provenance: "user" });
  add("bad-activity-probe", "fact", `${CANARIES.memory} out-of-contract provenance probe`, { provenance: "SYNTH-PROVENANCE-Secretprobe" });
  add("bad-scope-probe", "fact", `${CANARIES.memory} out-of-contract scope probe`, { provenance: "user", scope: "workspace-drift" });
  add("bad-importance-probe", "fact", `${CANARIES.memory} importance-42 probe`, { provenance: "user", importance: 42 });
  return rows;
}

function insertMemoryRows(db) {
  const defs = memoryDefinitions();
  const insertMemory = db.prepare(
    "INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)",
  );
  const insertMeta = db.prepare(
    `INSERT INTO memories_meta
       (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?)`,
  );
  const insertSeq = db.prepare("INSERT INTO memories_seq (memory_id, seq) VALUES (?, ?)");
  defs.forEach((row, index) => {
    const createdAt = row.drift?.["created_at"] ?? T0 + index * 1_000;
    const kind = row.drift?.["kind"] ?? row.kind;
    insertMemory.run(row.id, kind, row.content, row.importance, createdAt, createdAt + 500, row.status, row.supersedes);
    if (row.withMeta) {
      insertMeta.run(
        row.id,
        row.provenance ?? "unknown",
        row.source ?? "legacy",
        row.scope ?? "global",
        row.projectId,
        row.sessionId,
        row.confidence,
        row.expiresAt,
        row.evidence ?? "[]",
        createdAt + 1,
      );
    }
    insertSeq.run(row.id, index + 1);
  });
  return defs;
}

function buildConversations(memoryRoot) {
  const dir = join(memoryRoot, "conversations");
  mkdirSync(dir, { recursive: true });
  const rec = (type, seq, text) => ({ type, seq, ts: T0 + seq * 100, text });
  const s1 = [];
  for (let seq = 0; seq < 12; seq++) {
    s1.push(rec(seq % 2 === 0 ? "user" : "assistant", seq, `${CANARIES.slice} synthetic s1 ${seq}`));
  }
  const s2 = [];
  for (let seq = 1; seq <= 8; seq++) {
    s2.push(rec(seq % 2 === 0 ? "user" : "assistant", seq, `${CANARIES.slice} synthetic s2 ${seq}`));
  }
  // deliberate DUPLICATE seq line (counted, never absorbed) + malformed lines
  const s2File = s2.map((r) => JSON.stringify(r)).join("\n")
    + "\n" + JSON.stringify({ type: "assistant", seq: 5, ts: T0 + 15100, text: `${CANARIES.slice} synthetic s2 duplicate-5` })
    + "\n{not valid json malformed one}\n{neither is this\n";
  writeFileSync(join(dir, "session-s1.jsonl"), s1.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  writeFileSync(join(dir, "session-s2.jsonl"), s2File, "utf8");
  return {
    files: 2,
    validLines: 20, // 12 + 8
    duplicateSeqLines: 1,
    malformedLines: 2,
  };
}

function buildEpisodes(db) {
  const insertEpisode = db.prepare(
    `INSERT INTO episodes (id, session_id, project_id, turn, status, started_at, ended_at, updated_at,
      first_seq, last_seq, reviewed_at, summary, confidence, fingerprint, delegated, reject_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const nowish = T0 + 99_000;
  insertEpisode.run("ep-live-1", "session-s1", "proj-synth", 1, "succeeded", T0, nowish, nowish, 0, 11, nowish, "synthetic summary", 0.9, "fp-1", 0, null);
  insertEpisode.run("ep-live-2", "session-s1", "proj-synth", 2, "pending", T0, null, nowish, 1, 4, null, null, null, "fp-2", 1, null);
  insertEpisode.run("ep-live-3", "session-s2", "proj-synth", 1, "failed", T0, nowish, nowish, 2, 3, null, null, null, "fp-3", 0, "tool-exit");
  const insertStep = db.prepare(
    `INSERT INTO episode_steps (episode_id, ordinal, call_id, tool_name, arguments_redacted, result_excerpt,
      is_error, error_name, error_code, call_seq, result_seq, call_at, result_at, args_truncated, result_truncated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertStep.run("ep-live-1", 1, "call-ok-1", "bash", "{}", "ok excerpt", 0, null, null, 1, 2, T0, T0 + 10, 0, 0);
  insertStep.run("ep-live-1", 2, "call-ok-2", "read", "{}", "ok excerpt 2", 0, null, null, 3, 4, T0, T0 + 20, 0, 0);
  insertStep.run("ep-live-2", 1, "call-pend-1", "bash", "{}", "pending excerpt", 0, null, null, 7, null, T0, null, 0, 0);
  insertStep.run("ep-live-3", 1, "call-fail-1", "bash", "{}", "failed excerpt", 1, "Error", "E1", 9, null, T0, null, 0, 0);
  db.prepare("INSERT INTO episode_events (session_id, kind, call_id, turn, step, seq, at, payload, created_at, episode_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("session-s1", "coordinator", "coord-1", 1, 0, 1, T0, "{}", nowish, "ep-live-2");
  db.prepare("INSERT INTO episode_events (session_id, kind, call_id, turn, step, seq, at, payload, created_at, episode_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("session-s2", "tool", "call-fail-1", 1, 1, 2, T0 + 1, "{}", nowish, "ep-live-3");
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
  // Legacy ran without the sqlite-vec extension: an ordinary sidecar DB whose
  // table NAMED memory_vec imitates the layout (counts-only accounting applies).
  const db = new DatabaseSync(join(memoryRoot, "vectors.db"));
  try {
    db.exec("CREATE TABLE memory_vec (memory_id TEXT PRIMARY KEY, dims INTEGER NOT NULL) STRICT");
    const ins = db.prepare("INSERT INTO memory_vec (memory_id, dims) VALUES (?, ?)");
    for (let n = 1; n <= 7; n++) ins.run(`bulk-fact-${String(n).padStart(4, "0")}`, 1024);
  } finally {
    db.close();
  }
}

function buildSkillsRoot(homeRoot) {
  const root = join(homeRoot, "skills");
  mkdirSync(join(root, "dsi-fixture-alpha"), { recursive: true });
  mkdirSync(join(root, "dsi-fixture-beta"), { recursive: true });
  mkdirSync(join(root, "other-user-skill"), { recursive: true });
  writeFileSync(join(root, "dsi-fixture-alpha", "SKILL.md"), `# dsi-fixture-alpha\n${CANARIES.skill}\nnever activated\n`, "utf8");
  writeFileSync(join(root, "dsi-fixture-beta", "SKILL.md"), `# dsi-fixture-beta\n${CANARIES.skill}\nnever activated\n`, "utf8");
  writeFileSync(join(root, "other-user-skill", "SKILL.md"), "# user authored skill, untouched by the import lane\n", "utf8");
  return root;
}

export const SETTINGS_FIXTURE_YAML = `# synthetic settings patch; for import-v02 tests only
plugins:
  other-plugin:
    unrelated: keep-out
  self-improved:
    enabled: false
    debug: true
    searchLimit: 5
    extract:
      intervalMinutes: 30
      batchMaxChars: 4200
      provider: synthetic-provider
      model: synthetic-model
    recall:
      maxResults: 5
      embedding:
        apiKey: ${CANARIES.apiKey}
    episodeLearning:
      enabled: true
      operationalRecallEnabled: false
    legacyUnknownFlag: ${CANARIES.unknownLeaf}
`;

export function buildImportFixture(rootDir) {
  const homeRoot = join(rootDir, "dsh-home");
  const memoryRoot = join(homeRoot, "memory");
  mkdirSync(memoryRoot, { recursive: true });
  const dbPath = join(memoryRoot, "memory.db");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA journal_mode = WAL"); // real WAL companion on disk
    schemaDdl(db);
    db.prepare("INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)").run("v1", "provenance/scope metadata backfill + legacy instruction quarantine", T0);
    db.prepare("INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)").run("v2", "episode learning tables", T0);
    db.exec("PRAGMA user_version = 2");
    // arbitrary NON-contract schema_state row whose VALUE is a private secret:
    // lane docs may carry only a presence digest, never this text.
    db.prepare("INSERT INTO schema_state (key, value, applied_at) VALUES (?, ?, ?)").run("legacy-private-note", CANARIES.schemaSecret, T0);
    const defs = insertMemoryRows(db);
    const conversations = buildConversations(memoryRoot);
    buildEpisodes(db);
    db.prepare("INSERT INTO session_projects (session_id, project_id, updated_at) VALUES (?, ?, ?)").run("session-s1", "proj-synth", T0);
    db.prepare("INSERT INTO session_projects (session_id, project_id, updated_at) VALUES (?, ?, ?)").run("session-s2", "proj-other", T0);
    const insertCursor = db.prepare("INSERT INTO extract_state (session_id, processed_seq, pending_seq, updated_at) VALUES (?, ?, ?, ?)");
    insertCursor.run("session-s1", 0, 12, T0); // backlog (never acked)
    insertCursor.run("session-s2", 8, 8, T0); // clean
    insertCursor.run("session-s4-GHOST", 4, 4, T0); // cursor without slice file
    db.prepare("INSERT INTO scenes (id, title, markdown, memory_ids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("scene-1", "synthetic scene", `${CANARIES.persona} scene prose`, "[]", T0, T0);
    // baseline pins: eligible, dangling (id with no importable row),
    // ineligible provenance (assistant row cannot gain baseline authority)
    db.prepare("INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)").run(1, "bulk-fact-0001", T0);
    db.prepare("INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)").run(2, "id-never-existing", T0);
    db.prepare("INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)").run(3, "alpha-paste-obs", T0);
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
