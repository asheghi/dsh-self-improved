/**
 * Phase A migration increment regression suite (MIGRATION-IMPORT-TESTS.md owns
 * the durable report of what these tests prove).
 *
 * Everything here runs against SYNTHETIC fixtures built in a uniquely owned
 * temporary tree: no production store, no live profile, no provider, no real
 * user content is read. Cleanup removes only directories this script created
 * (guarded by ownership markers).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { tmpdir } from "node:os";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixturesDir = join(repo, "fixtures", "v02-migration");

// ---------- guarded temporary workspace ----------

const workspace = mkdtempSync(join(tmpdir(), "dsi-migration-v02-test-"));
const guardMarker = join(workspace, "OWNER.dsi-migration-v02-tests");
const guardTag = `test-migration-v02:${process.pid}:${workspace}`;
writeFileSync(guardMarker, guardTag, "utf8");

function guardedCleanup() {
  try {
    if (!existsSync(guardMarker) || readFileSync(guardMarker, "utf8") !== guardTag) return;
  } catch {
    return;
  }
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* leftover under tmpdir is inert */
  }
}
process.on("exit", guardedCleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));

// ---------- engine compile (isolated unique tree, same contract as the CLI) ----------

function compileEngine(compileRoot) {
  const outDir = join(compileRoot, "lib");
  const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      join(repo, "src", "migration-v02.ts"),
      "--outDir", outDir,
      "--target", "es2022",
      "--module", "nodenext",
      "--moduleResolution", "nodenext",
      "--strict", "--skipLibCheck", "--esModuleInterop",
      "--forceConsistentCasingInFileNames",
      "--types", "node",
      "--pretty", "false",
    ],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `isolated strict compilation failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return import(pathToFileURL(join(outDir, "migration-v02.js")).href);
}

const compileTree = mkdtempSync(join(tmpdir(), "dsi-migration-v02-compile-"));
writeFileSync(join(compileTree, "guard.txt"), "owned-by-test-migration-v02", "utf8");
process.on("exit", () => {
  try {
    if (readFileSync(join(compileTree, "guard.txt"), "utf8") === "owned-by-test-migration-v02") {
      rmSync(compileTree, { recursive: true, force: true });
    }
  } catch {
    /* inert leftover */
  }
});
const engine = await compileEngine(compileTree);

const { buildSyntheticHome, CANARIES } = await import(pathToFileURL(join(fixturesDir, "build-synthetic-fixture.mjs")).href);

// ---------- tiny harness ----------

let passed = 0;
let failed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log(`FAIL ${name}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function digestStore(dir) {
  const files = new Map();
  const walk = (root) => {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && !files.has(relative(dir, p))) files.set(relative(dir, p), sha256File(p));
    }
  };
  walk(dir);
  return files;
}

function expectGolden(got, expected, label) {
  // Subset match: every expected node must be present (exactly) inside got;
  // extra got fields are tolerated, expected fields must all match.
  const check = (exp, value, path) => {
    if (Array.isArray(exp)) {
      assert.ok(Array.isArray(value), `${label}: expected array at ${path}, got ${typeof value}`);
      // every expected item must find an exact-subset match inside value (order-insensitive)
      for (let i = 0; i < exp.length; i++) {
        const pool = [...value];
        for (const candidate of pool) {
          if (matchesSubset(exp[i], candidate)) {
            value.splice(value.indexOf(candidate), 1);
            break;
          }
        }
        if (exp[i] !== null && typeof exp[i] === "object" && !Array.isArray(exp[i])) {
          // matched above (or not) — verify by re-searching was not required
        } else {
          assert.deepEqual(value.some((candidate) => matchesSubset(exp[i], candidate)), true, `${label}: no match for array item ${i} at ${path}`);
        }
      }
      assert.ok(value.length === 0, `${label}: unmatched array items remain at ${path}: ${JSON.stringify(value)}`);
      assert.equal(value.length, 0, `${label}: matched count mismatch at ${path}`);
      return;
    }
    if (exp !== null && typeof exp === "object") {
      for (const [k, v] of Object.entries(exp)) check(v, value?.[k], `${path}.${k}`);
      return;
    }
    assert.deepEqual(value, exp, `${label}: scalar mismatch at ${path}`);
  };
  check(expected, jsonClone(got), label);
}

function matchesSubset(expectedItem, candidate) {
  if (expectedItem === null || typeof expectedItem !== "object") return false;
  if (candidate === null || typeof candidate !== "object") return false;
  for (const [k, v] of Object.entries(expectedItem)) {
    if (Array.isArray(v)) {
      // arrays compare element-wise against candidate[k]
      const cand = candidate?.[k];
      if (!Array.isArray(cand) || cand.length !== v.length) return false;
      for (let i = 0; i < v.length; i++) {
        if (!matchesSubset(v[i], cand[i]) && JSON.stringify(v[i]) !== JSON.stringify(cand[i])) return false;
      }
      continue;
    }
    if (v !== null && typeof v === "object") {
      if (!matchesSubset(v, candidate?.[k])) return false;
      continue;
    }
    if (JSON.stringify(candidate?.[k]) !== JSON.stringify(v)) return false;
  }
  return true;
}

function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ---------- build fixtures ----------

const standard = buildSyntheticHome(join(workspace, "fixture-standard"), "standard");
const unsupported = buildSyntheticHome(join(workspace, "fixture-unsupported"), "unsupported");
const premigration = buildSyntheticHome(join(workspace, "fixture-premigration"), "pre-migration");
buildSyntheticHome(join(workspace, "fixture-missing"), "missing");

const golden = JSON.parse(readFileSync(join(fixturesDir, "golden", "expected-standard.json"), "utf8")).expected;

// ---------- module purity (isolated compilation, no legacy store code) ----------

const engineJs = readFileSync(join(compileTree, "lib", "migration-v02.js"), "utf8");
test("engine imports only node builtins and never touches the legacy MemoryStore", () => {
  assert.match(engineJs, /node:sqlite/);
  // Strip comments so documentation mentions do not defeat the code check.
  const code = engineJs
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`[^`]*`/g, "`string`");
  assert.doesNotMatch(code, /MemoryStore/);
  const imports = [...engineJs.matchAll(/from\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(imports.length > 0, true);
  for (const imp of imports) assert.match(imp, /^node:/, `unexpected non-builtin import: ${imp}`);
});

// ---------- inventory on the standard synthetic store ----------

const inventoryReport = engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, settingsPath: standard.settingsPath, skillsRoot: standard.skillsRoot }, "inventory");

test("inventory classifies the standard synthetic store as supported with exact schema findings", () => {
  assert.equal(inventoryReport.supported, true);
  assert.deepEqual(inventoryReport.unsupportedReason, []);
  expectGolden(inventoryReport.schema, golden.schema, "schema");
  assert.equal(inventoryReport.schema.userVersion, 2);
  assert.equal(inventoryReport.schema.integrity, "ok");
  // Marker support checks stay intact, but the report is privacy-bounded:
  // marker VALUES are digests only, keys are verbatim contract wire names, and
  // the allowed applied_at timestamp is preserved.
  const markerDigest = (v) => createHash("sha256").update(v).digest("hex");
  const v1 = inventoryReport.schema.schemaMarkers.known.find((m) => m.key === "v1");
  const v2 = inventoryReport.schema.schemaMarkers.known.find((m) => m.key === "v2");
  assert.equal(v1.present, true);
  assert.equal(v1.valueDigest, markerDigest("provenance/scope metadata backfill + legacy instruction quarantine"));
  assert.equal(v1.appliedAt, 1_700_000_000_000);
  assert.equal(v2.present, true);
  assert.equal(v2.valueDigest, markerDigest("episode learning tables (episodes/episode_steps/episode_events)"));
  assert.equal(v2.appliedAt, 1_700_000_000_000);
});

test("inventory golden counts (memories/conversations/episodes/derived lanes)", () => {
  expectGolden(inventoryReport.counts.memories, golden.counts.memories, "memories");
  expectGolden(inventoryReport.counts.conversations, golden.counts.conversations, "conversations");
  expectGolden(inventoryReport.counts.episodes, golden.counts.episodes, "episodes");
  assert.deepEqual(inventoryReport.counts.persona, { versions: 3, maxVer: 3, files: [{ name: "persona.md", bytes: statSync(join(standard.memoryRoot, "persona", "persona.md")).size }, { name: "persona.md.bak1", bytes: statSync(join(standard.memoryRoot, "persona", "persona.md.bak1")).size }] }, "persona");
  assert.deepEqual(inventoryReport.counts.skills, golden.counts.skills, "skills");
  assert.equal(inventoryReport.counts.vectors.available, false);
  assert.equal(inventoryReport.counts.baseline.pins, 1);
  assert.deepEqual(inventoryReport.counts.cursors, golden.counts.cursors, "cursors");
});

test("lane projection: personal eligible, review required, quarantine, handoff, persona inactive", () => {
  const projection = inventoryReport.counts.projection;
  assert.deepEqual(
    {
      memoryRows: projection.memoryRows,
      personalLaneEligible: projection.personalLaneEligible,
      reviewRequired: projection.reviewRequired,
      quarantinedProposed: projection.quarantinedProposed,
      taskHandoffCandidates: projection.taskHandoffCandidates,
      personaInactive: projection.personaInactive,
      extractionBacklogSessions: projection.extractionBacklogSessions,
      extractionBacklogValidSlices: projection.extractionBacklogValidSlices,
    },
    {
      memoryRows: 24,
      personalLaneEligible: 7,
      reviewRequired: 2,
      quarantinedProposed: 6,
      taskHandoffCandidates: 2,
      personaInactive: 2,
      extractionBacklogSessions: 1,
      extractionBacklogValidSlices: 11,
    },
  );
  assert.match(projection.heuristicCostNote, /upper bound/);
  assert.match(projection.heuristicCostNote, /no provider cost is asserted/);
});

test("conservative provenance: unknown/system/tool/skill/coordinator stay quarantined, direct-human goes to review lanes", () => {
  const lanes = inventoryReport.preservation.quarantinedByLane;
  assert.equal(lanes["quarantine-proposed"], 6);
  assert.equal(lanes["preserved-quarantined"], 1);
  assert.equal(inventoryReport.preservation.proposedMemoryRows, 13);
});

test("preservation bookkeeping keeps ids, scopes, timestamps, supersession and evidence linkage", () => {
  const p = inventoryReport.preservation;
  expectGolden(
    {
      idsPreserved: p.idsPreserved,
      scopesPreserved: p.scopesPreserved,
      timestampsPreserved: p.timestampsPreserved,
      supersessionChains: p.supersessionChains,
      brokenSupersedes: p.brokenSupersedes,
      evidenceEntries: p.evidenceEntries,
      evidenceUnverifiable: p.evidenceUnverifiable,
      pastedDemotedOwnScopeOnly: p.pastedDemotedOwnScopeOnly,
    },
    {
      idsPreserved: 24,
      scopesPreserved: 13,
      timestampsPreserved: 13,
      supersessionChains: 2,
      brokenSupersedes: 1,
      evidenceEntries: 2,
      evidenceUnverifiable: 1,
      pastedDemotedOwnScopeOnly: 2,
    },
    "preservation",
  );
  assert.equal(p.sampleIds.includes("dsi-fixture-01"), true);
});

test("conflicting duplicate audit lists duplicate contents and conflicting preferences without content", () => {
  const c = inventoryReport.conflicts;
  assert.equal(c.duplicateContentGroups.length, 1);
  assert.deepEqual([...c.duplicateContentGroups[0].ids].sort(), ["dsi-fixture-01", "dsi-fixture-04"]);
  assert.equal(c.duplicateContentGroups[0].count, 2);
  assert.equal(c.conflictingPreferenceGroups.length, 1);
  assert.deepEqual(
    c.conflictingPreferenceGroups[0].options.map((o) => o.id),
    ["dsi-fixture-02", "dsi-fixture-03", "dsi-fixture-03-old"],
  );
  assert.equal(c.taskScopedCandidates, 1);
  // report must not carry the content text itself
  const reportText = JSON.stringify(inventoryReport);
  assert.doesNotMatch(reportText, /canary-user-fact-alpha|prefers light theme|prefers dark theme/);
});

// ---------- persona/skills inactive; consent not expanded ----------

test("persona prose and generated skills are inventoried but stay inactive", () => {
  assert.equal(inventoryReport.lanes.persona.migrationActivation, "inactive");
  assert.equal(inventoryReport.lanes.skills.migrationActivation, "inactive");
  assert.equal(inventoryReport.lanes.persona.versions, 3);
  assert.equal(inventoryReport.lanes.skills.generatedCount, 2);
});

test("episode consent is carried unchanged and never expanded", () => {
  const op = inventoryReport.lanes.operational;
  assert.deepEqual(op.sourceConsent, { captureOn: true, reviewOn: true, captureArguments: false, operationalRecallOn: false });
  assert.equal(op.proposal.notExpanded, true);
  assert.equal(op.proposal.sameOrNarrower, true);
  assert.equal(op.proposal.reconfirmAtCutover, true);
});

// ---------- settings mapping proposal ----------

test("settings mapping: carry/retire/secret/migration-only/unmapped classification", () => {
  const s = inventoryReport.settings;
  assert.equal(s.found, true);
  assert.equal(s.leaves, 18);
  assert.equal(s.mapped.length, 14);
  const provider = s.mapped.find((m) => m.path === "extract.provider");
  assert.equal(provider?.value, "synthetic-provider");
  assert.equal(provider?.equalsDefault, false);
  const unknownFlag = s.unmapped.find((m) => m.path === "legacyUnknownFlag");
  assert.equal(unknownFlag?.present, true);
  assert.equal(unknownFlag?.value, undefined, "unknown leaves must be presence-only");
  assert.match(unknownFlag?.note ?? "", /presence-only/);
  const roots = s.migrationOnly;
  assert.deepEqual(roots.map((m) => m.path).sort(), ["extract.provenanceFilter", "storageRoot"]);
  assert.match(roots.find((m) => m.path === "extract.provenanceFilter")?.note ?? "", /migration-only/);
});

test("secrets are presence-only and values never enter the report", () => {
  const s = inventoryReport.settings;
  assert.equal(s.secrets.length, 1);
  assert.equal(s.secrets[0].path, "recall.embedding.apiKey");
  assert.equal(s.secrets[0].present, true);
  assert.equal(s.secrets[0].value, undefined);
  const reportText = JSON.stringify(inventoryReport);
  const allCanaries = { apiKey: CANARIES.apiKey, memory: CANARIES.memory, slice: CANARIES.slice, persona: CANARIES.persona, skill: CANARIES.skill, unknownLeaf: CANARIES.unknownLeaf, schemaSecret: CANARIES.schemaSecret, schemaUnknownKey: CANARIES.schemaUnknownKey };
  for (const [label, canary] of Object.entries(allCanaries)) {
    assert.doesNotMatch(reportText, new RegExp(canary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), `${label} canary leaked into the report`);
  }
});

test("report contains no raw memory or slice text beyond opaque ids/counts", () => {
  const reportText = JSON.stringify(inventoryReport);
  // memory ids may appear by explicit design; content canaries may not
  assert.doesNotMatch(reportText, /MEMORY-CANARY|SLICE-TEXT-CANARY|PERSONA-PROSE-CANARY|SKILL-BODY-CANARY/);
});

// ---------- report privacy: schema_state markers and free-string metadata bounding ----------

function metaDigest(value) {
  return `opaque:${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

test("schema_state marker values and unknown marker keys are opaque digests, never raw text (the reproduced privacy defect)", () => {
  const m = inventoryReport.schema.schemaMarkers;
  // known markers: presence + digest only; key names are contract wire names
  assert.deepEqual(m.known.map((k) => k.key), ["v1", "v2"]);
  assert.equal(m.known[0].present, true);
  assert.equal(m.known[1].present, true);
  assert.equal(m.known[0].valueDigest, createHash("sha256").update("provenance/scope metadata backfill + legacy instruction quarantine").digest("hex"));
  assert.equal(m.unknownCount, 1);
  assert.deepEqual(m.unknown, [{ keyDigest: metaDigest(CANARIES.schemaUnknownKey), appliedAt: 1_700_000_000_000 }]);
  const reportText = JSON.stringify(inventoryReport);
  assert.doesNotMatch(reportText, /SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT/, "the private marker VALUE leaked verbatim");
  assert.doesNotMatch(reportText, /legacy-private-note/, "the unknown marker KEY leaked verbatim");
});

test("reproduced CLI path: inventory --json exits 0 and its stdout hides the schema secret", () => {
  const run = spawnSync(
    process.execPath,
    [join(repo, "scripts", "migrate-v02.mjs"), "inventory", "--source", standard.memoryRoot, "--json"],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `cli should succeed on the supported store: ${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout, /SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT|legacy-private-note/, "CLI stdout leaked schema-state privacy canaries");
  const cliReport = JSON.parse(run.stdout);
  assert.equal(cliReport.schema.schemaMarkers.unknownCount, 1);
  assert.equal(cliReport.schema.schemaMarkers.unknown[0].keyDigest, metaDigest(CANARIES.schemaUnknownKey));
});

test("adversarial category metadata (status/kind/provenance/source) is reduced to opaque digests with counts", () => {
  const adv = buildSyntheticHome(join(workspace, "fixture-adversarial"), "standard");
  let db;
  try {
    db = new DatabaseSync(join(adv.memoryRoot, "memory.db"));
    const one = (seq, kind, status, provenance, source) => {
      db.prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES (?, ?, 'SYNTHETIC_SCHEMA_SECRET_NEVER_REPORT', 5, 0, ?, ?, ?, NULL)")
        .run(`dsi-adv-${seq}`, kind, 1_700_000_900_000, 1_700_000_900_001, status);
      db.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at) VALUES (?, ?, ?, 'global', NULL, NULL, 0.5, NULL, '[]', 0, NULL)")
        .run(`dsi-adv-${seq}`, provenance, source);
    };
    one(1, "fact", CANARIES.statusValue, "user", "llm-extract"); // unknown status
    one(2, CANARIES.kindValue, "active", "user", "llm-extract"); // unknown kind
    one(3, "fact", "active", CANARIES.provenanceValue, "llm-extract"); // unknown provenance
    one(4, "fact", "active", "user", CANARIES.sourceValue); // unknown source
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
  const before = digestStore(adv.memoryRoot);
  const report = engine.buildMigrationReport({ sourceRoot: adv.memoryRoot }, "inventory");
  const after = digestStore(adv.memoryRoot);
  assert.deepEqual(after, before, "the adversarial-metadata run mutated the source");
  assert.equal(report.supported, true, "unknown category VALUES classify conservatively, they never invalidate the schema");
  const memo = report.counts.memories;
  const digestOf = (v) => createHash("sha256").update(String(v)).digest("hex").slice(0, 12);
  for (const [tally, canary] of [[memo.byStatus, CANARIES.statusValue], [memo.byKind, CANARIES.kindValue], [memo.byProvenance, CANARIES.provenanceValue], [memo.bySource, CANARIES.sourceValue]]) {
    assert.equal(tally[`opaque:${digestOf(canary)}`], 1, `opaque bucket missing for canary lane ${canary}`);
  }
  const reportText = JSON.stringify(report);
  for (const canary of [CANARIES.statusValue, CANARIES.kindValue, CANARIES.provenanceValue, CANARIES.sourceValue, CANARIES.schemaSecret, CANARIES.schemaUnknownKey]) {
    assert.doesNotMatch(reportText, new RegExp(canary.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), "raw category metadata leaked into the report");
  }
});

test("unknown table and extra-column identifiers are reported as opaque digests, never their raw names", () => {
  const drift = buildSyntheticHome(join(workspace, "fixture-table-drift"), "standard");
  let db;
  try {
    db = new DatabaseSync(join(drift.memoryRoot, "memory.db"));
    db.exec(`CREATE TABLE "${CANARIES.tableName}" (note TEXT NOT NULL) STRICT`);
    db.exec(`ALTER TABLE memories ADD COLUMN "${CANARIES.columnName}" TEXT`);
  } finally {
    try { db?.close(); } catch { /* noop */ }
  }
  const before = digestStore(drift.memoryRoot);
  const report = engine.buildMigrationReport({ sourceRoot: drift.memoryRoot }, "inventory");
  const after = digestStore(drift.memoryRoot);
  assert.deepEqual(after, before, "the table-drift probe mutated the source");
  assert.equal(report.supported, false);
  assert.match(report.unsupportedReason.join(" | "), /unknown tables/);
  const tablePattern = new RegExp(CANARIES.tableName.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  assert.doesNotMatch(report.unsupportedReason.join(" | "), tablePattern, "the raw table name leaked into a reason");
  const reportText = JSON.stringify(report);
  assert.doesNotMatch(reportText, tablePattern);
  assert.deepEqual(report.schema.unknownTables, [metaDigest(CANARIES.tableName)]);
  const extra = report.schema.extraColumns.find((e) => e.table === "memories");
  assert.ok(extra, "the drifted column must be inventoried (digest-only)");
  assert.deepEqual(extra.columns, [metaDigest(CANARIES.columnName)]);
});

test("settings parse errors withhold the offending line content (error strings carry no source text)", () => {
  const hostileSettings = join(workspace, "hostile-settings.yaml");
  writeFileSync(
    hostileSettings,
    `self-improved:\n  enabled: true\n  ${CANARIES.settingsLine}\n`,
    "utf8",
  );
  const report = engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, settingsPath: hostileSettings }, "inventory");
  const parseError = report.settings?.parseError ?? "";
  assert.match(parseError, /unparseable settings line ordinal 3/);
  assert.match(parseError, /withheld/);
  assert.doesNotMatch(parseError, new RegExp(CANARIES.settingsLine.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), "parse error echoed private settings text");
  assert.equal(report.supported, true, "a settings parse refusal is a settings-note finding, not a schema reason");
  const run = cliRun(["inventory", "--source", standard.memoryRoot, "--settings", hostileSettings]);
  assert.equal(run.status, 0, `unexpected exit: ${run.stdout}\n${run.stderr}`);
  assert.doesNotMatch(run.stdout + run.stderr, new RegExp(CANARIES.settingsLine.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")), "CLI echoed private settings text");
});

// ---------- dry-run: writes nothing, source unchanged ----------

const dryRunDest = join(workspace, "dest-probe");
mkdirSync(dryRunDest, { recursive: true });
writeFileSync(join(dryRunDest, "preexisting.txt"), "untouched", "utf8");
const destBefore = digestStore(dryRunDest);
const srcBefore = digestStore(standard.memoryRoot);
const dryRunReport = engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, settingsPath: standard.settingsPath, skillsRoot: standard.skillsRoot, destinationRoot: dryRunDest }, "dry-run");
const destAfter = digestStore(dryRunDest);
const srcAfter = digestStore(standard.memoryRoot);

test("dry-run validates the destination candidate and never writes to it", () => {
  assert.equal(dryRunReport.safety.destinationValidated, true);
  assert.equal(dryRunReport.safety.destinationTouched, false);
  assert.deepEqual(destAfter, destBefore);
  assert.deepEqual([...destAfter.keys()], ["preexisting.txt"]);
});

test("dry-run leaves source bytes, file set, and SQLite schema unchanged around the analysis", () => {
  assert.equal(dryRunReport.safety.sourceUnchanged, true);
  assert.equal(dryRunReport.safety.sourceSchemaUnchanged, true);
  assert.deepEqual(srcAfter, srcBefore, "the dry-run wrote files into the source");
});

test("inventory/dry-run engine claims explicit no-mutation and snapshot isolation", () => {
  assert.equal(dryRunReport.safety.noMutationOnSource, true);
  assert.equal(dryRunReport.safety.snapshotIsolated, true);
  assert.equal(dryRunReport.safety.rawContentInReport, false);
  assert.match(dryRunReport.safety.onlineBackupContract, /WAL|online backup/);
});

test("dry-run result is deterministic (byte-identical report JSON across runs)", () => {
  const a = engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, settingsPath: standard.settingsPath, skillsRoot: standard.skillsRoot, destinationRoot: dryRunDest }, "dry-run");
  const b = engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, settingsPath: standard.settingsPath, skillsRoot: standard.skillsRoot, destinationRoot: dryRunDest }, "dry-run");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---------- unsupported / missing / pre-migration sources ----------

test("schema drift (unknown table + missing v2 marker) is classified unsupported", () => {
  const report = engine.buildMigrationReport({ sourceRoot: unsupported.memoryRoot }, "inventory");
  assert.equal(report.supported, false);
  const joined = report.unsupportedReason.join(" | ");
  assert.match(joined, /unknown tables/);
  assert.match(joined, /'v2'/);
  assert.equal(report.safety.sourceUnchanged, true);
});

test("pre-migration store (no schema_state markers) is unsupported, not guessed", () => {
  const report = engine.buildMigrationReport({ sourceRoot: premigration.memoryRoot }, "inventory");
  assert.equal(report.supported, false);
  assert.match(report.unsupportedReason.join(" | "), /'v1'/);
});

test("missing memory.db is reported, never improvised", () => {
  assert.throws(() => engine.buildMigrationReport({ sourceRoot: join(workspace, "fixture-missing", "dsh-home", "memory") }, "inventory"), /missing-source/);
});

test("a non-SQLite memory.db is refused as unsupported-source (CLI exit 2), never improvised", () => {
  const garbage = join(workspace, "fixture-garbage", "home");
  mkdirSync(garbage, { recursive: true });
  writeFileSync(join(garbage, "memory.db"), "GARBAGE-not-an-sqlite-header-bytes", "utf8");
  assert.throws(() => engine.buildMigrationReport({ sourceRoot: garbage }, "inventory"), /not an SQLite 3 database/);
  const run = spawnSync(process.execPath, [join(repo, "scripts", "migrate-v02.mjs"), "inventory", "--source", garbage], { cwd: repo, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /not an SQLite 3 database/);
});

test("a symlink inside the source tree or skills root is refused before any audit read", () => {
  const linked = buildSyntheticHome(join(workspace, "fixture-symlinked"), "standard");
  const external = join(linked.memoryRoot, "external-slices");
  mkdirSync(external, { recursive: true });
  symlinkSync(external, join(linked.memoryRoot, "conversations-link"), "dir");
  assert.throws(
    () => engine.buildMigrationReport({ sourceRoot: linked.memoryRoot, skillsRoot: linked.skillsRoot }, "inventory"),
    /symlink is present inside the tree at.*conversations-link/,
    "the source deep walk must refuse symlinked content before any read",
  );
  symlinkSync(external, join(linked.skillsRoot, "dsi-link"), "dir");
  assert.throws(
    () => engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, skillsRoot: linked.skillsRoot }, "inventory"),
    /refusing to read the skills root.*symlink/,
    "the skills-root deep walk must refuse symlinked content",
  );
});

test("VACUUM INTO snapshot sees uncheckpointed WAL content and leaves the live writer untouched", () => {
  const walHome = buildSyntheticHome(join(workspace, "fixture-wal"), "standard");
  const dbPath = join(walHome.memoryRoot, "memory.db");
  let writer;
  try {
    writer = new DatabaseSync(dbPath);
    writer.exec("PRAGMA journal_mode=WAL");
    // Committed frames now live in memory.db-wal; the writer stays open, so a
    // plain file copy of memory.db alone would MISS this row.
    writer
      .prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES ('dsi-wal-probe', 'fact', 'WAL-only probe row — must be included in counts if the snapshot is WAL-inclusive', 5, 0, ?, ?, 'active', NULL)")
      .run(1_700_000_999_999, 1_700_000_999_999);
    writer
      .prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at) VALUES ('dsi-wal-probe', 'user', 'llm-extract', 'global', NULL, NULL, 0.5, NULL, '[]', 0, NULL)")
      .run();
    const report = engine.buildMigrationReport({ sourceRoot: walHome.memoryRoot }, "inventory");
    assert.equal(report.safety.sourceUnchanged, true, "analysis must not modify the WAL-mode store");
    assert.equal(report.safety.sourceSchemaUnchanged, true);
    assert.equal(report.counts.memories.total, 25, "the recovery+counts path must include the uncheckpointed WAL row");
  } finally {
    try {
      writer?.close();
    } catch {
      /* noop */
    }
  }
});

// ---------- path safety ----------

test("validateSourceDestination rejects identical and nested source/destination", () => {
  assert.throws(() => engine.validateSourceDestination(standard.memoryRoot, standard.memoryRoot), /same path/);
  assert.throws(() => engine.validateSourceDestination(standard.memoryRoot, join(standard.memoryRoot, "sub")), /overlap/);
  assert.throws(() => engine.validateSourceDestination(standard.memoryRoot, join(workspace, "fixture-standard")), /overlap/);
  // unrelated paths are fine
  engine.validateSourceDestination(standard.memoryRoot, join(workspace, "elsewhere"));
});

test("symlink-bound roles are refused before any read", () => {
  const linkTargetHome = join(workspace, "fixture-link-target");
  const linkPath = join(workspace, "link-to-memory");
  rmSync(linkPath, { force: true });
  symlinkSync(linkTargetHome, linkPath, "dir");
  assert.throws(() => engine.validateSourceDestination(standard.memoryRoot, linkPath), /symlink/);
  assert.throws(() => engine.validateSourceDestination(linkPath, join(workspace, "elsewhere")), /symlink/);
  assert.throws(() => engine.buildMigrationReport({ sourceRoot: linkPath }, "inventory"), /symlink/);
});

test("buildMigrationReport refuses source==destination before reading", () => {
  assert.throws(() => engine.buildMigrationReport({ sourceRoot: standard.memoryRoot, destinationRoot: standard.memoryRoot }, "dry-run"), /same path/);
});

// ---------- CLI ----------

test("CLI inventory run produces the report file and exit 0 on a supported store", () => {
  const reportPath = join(workspace, "reports", "cli-inventory.json");
  const run = spawnSync(
    process.execPath,
    [join(repo, "scripts", "migrate-v02.mjs"), "inventory", "--source", standard.memoryRoot, "--settings", standard.settingsPath, "--skills-root", standard.skillsRoot, "--report", reportPath],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(run.status, 0, `cli failed: ${run.stdout}\n${run.stderr}`);
  const fileReport = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(fileReport.supported, true);
  assert.equal(fileReport.counts.memories.total, 24);
});

test("CLI dry-run refuses overlapping source/destination with exit 2", () => {
  const run = spawnSync(
    process.execPath,
    [join(repo, "scripts", "migrate-v02.mjs"), "dry-run", "--source", standard.memoryRoot, "--dest", standard.memoryRoot],
    { cwd: repo, encoding: "utf8" },
  );
  assert.equal(run.status, 2);
  assert.match(run.stderr, /same path/);
});

test("CLI without explicit --source refuses to run (no production defaults)", () => {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "migrate-v02.mjs"), "inventory"], { cwd: repo, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--source/);
});

test("CLI unsupported source exits 3", () => {
  const run = spawnSync(process.execPath, [join(repo, "scripts", "migrate-v02.mjs"), "inventory", "--source", unsupported.memoryRoot], { cwd: repo, encoding: "utf8" });
  assert.equal(run.status, 3);
  assert.match(run.stdout, /unsupported:/);
});

// ---------- CLI --report destination safety (adversarial; checksum before/after) ----------

function cliRun(extraArgs) {
  return spawnSync(process.execPath, [join(repo, "scripts", "migrate-v02.mjs"), ...extraArgs], { cwd: repo, encoding: "utf8" });
}

/** Runs the CLI expecting exit-2 refusal; asserts protected files/trees are byte-identical afterwards. */
function expectReportRefusal(extraArgs, expectPattern, protectedFiles = [], protectedTrees = []) {
  const fileBefore = protectedFiles.map((f) => [f, sha256File(f)]);
  const treeBefore = protectedTrees.map((d) => [d, digestStore(d)]);
  const run = cliRun(extraArgs);
  assert.equal(run.status, 2, `expected refusal exit 2, got ${run.status}\nstdout: ${run.stdout}\nstderr: ${run.stderr}`);
  assert.match(run.stderr, expectPattern);
  for (const [f, d] of fileBefore) assert.equal(sha256File(f), d, `protected input file was modified: ${f}`);
  for (const [d, m] of treeBefore) assert.deepEqual(digestStore(d), m, `protected input tree was modified: ${d}`);
  return run;
}

test("CLI validates --report before compilation or any source read (report refusal wins on a missing source)", () => {
  const missing = join(workspace, "fixture-missing", "dsh-home", "memory");
  const run = expectReportRefusal(["inventory", "--source", missing, "--report", join(missing, "memory.db")], /refusing report destination/);
  assert.doesNotMatch(run.stderr, /missing-source/, "the report refusal must precede any source read attempt");
  assert.equal(existsSync(join(missing, "memory.db")), false, "no file may be created while refusing");
});

test("CLI refuses a --report pointing at the source memory.db; source checksum identical before/after", () => {
  expectReportRefusal(
    ["inventory", "--source", standard.memoryRoot, "--settings", standard.settingsPath, "--skills-root", standard.skillsRoot, "--report", join(standard.memoryRoot, "memory.db")],
    /refusing report destination/,
    [join(standard.memoryRoot, "memory.db")],
    [standard.memoryRoot],
  );
});

test("CLI refuses fresh-name --report paths inside every input tree without creating anything", () => {
  if (!existsSync(join(standard.memoryRoot, "persona"))) throw new Error("fixture persona dir missing");
  const adversarial = [
    join(standard.memoryRoot, "conversations", "would-be-report.json"),
    join(standard.memoryRoot, "persona", "report.json"),
    join(standard.skillsRoot, "report.json"),
    join(standard.skillsRoot, "dsi-fixture-alpha", "report.json"),
  ];
  for (const reportPath of adversarial) {
    expectReportRefusal(
      ["inventory", "--source", standard.memoryRoot, "--skills-root", standard.skillsRoot, "--report", reportPath],
      /refusing report destination/,
    );
    assert.equal(existsSync(reportPath), false, "a refused run must not leave the report file behind");
  }
});

test("CLI refuses a --report on the settings input and on/inside the destination candidate", () => {
  expectReportRefusal(
    ["dry-run", "--source", standard.memoryRoot, "--dest", dryRunDest, "--settings", standard.settingsPath, "--report", standard.settingsPath],
    /refusing report destination/,
    [standard.settingsPath],
  );
  expectReportRefusal(
    ["dry-run", "--source", standard.memoryRoot, "--dest", dryRunDest, "--report", join(dryRunDest, "new-report.json")],
    /refusing report destination/,
  );
  assert.equal(existsSync(join(dryRunDest, "new-report.json")), false, "the destination candidate must gain no file");
  expectReportRefusal(
    ["dry-run", "--source", standard.memoryRoot, "--dest", dryRunDest, "--report", join(dryRunDest, "preexisting.txt")],
    /refusing report destination/,
    [join(dryRunDest, "preexisting.txt")],
  );
});

test("CLI refuses a --report on any existing unrelated path or an existing symlink (exclusive creation)", () => {
  const unrelated = join(workspace, "unrelated-existing.txt");
  writeFileSync(unrelated, "operator data that must never be replaced", "utf8");
  expectReportRefusal(["inventory", "--source", standard.memoryRoot, "--report", unrelated], /already exists/, [unrelated]);
  const linked = join(workspace, "existing-link.json");
  symlinkSync(join(standard.memoryRoot, "persona", "persona.md"), linked, "file");
  expectReportRefusal(
    ["inventory", "--source", standard.memoryRoot, "--report", linked],
    /already exists|symlink/,
    [join(standard.memoryRoot, "persona", "persona.md")],
  );
  assert.equal(existsSync(join(standard.memoryRoot, "persona", "persona.md")), true, "the symlink target must remain intact");
});

test("CLI refuses a --report through a symlinked parent directory", () => {
  const target = join(workspace, "link-parent-target");
  mkdirSync(target, { recursive: true });
  const link = join(workspace, "link-parent");
  symlinkSync(target, link, "dir");
  expectReportRefusal(
    ["inventory", "--source", standard.memoryRoot, "--report", join(link, "report.json")],
    /symlink/,
  );
  assert.equal(readdirSync(target).length === 0, true, "the symlink target directory must stay empty");
});

test("CLI writes a fresh report exclusively; an identical re-run refuses and never replaces it", () => {
  const exclusive = join(workspace, "reports", "exclusive-report.json");
  const first = cliRun([
    "inventory",
    "--source", standard.memoryRoot,
    "--settings", standard.settingsPath,
    "--skills-root", standard.skillsRoot,
    "--report", exclusive,
  ]);
  assert.equal(first.status, 0, `clean run failed: ${first.stdout}\n${first.stderr}`);
  assert.match(readFileSync(exclusive, "utf8"), /reportVersion/);
  const firstDigest = sha256File(exclusive);
  expectReportRefusal(
    ["inventory", "--source", standard.memoryRoot, "--settings", standard.settingsPath, "--skills-root", standard.skillsRoot, "--report", exclusive],
    /already exists/,
    [exclusive],
  );
  assert.equal(sha256File(exclusive), firstDigest, "the first report must survive a second run untouched");
});

test("CLI guarded open-failure leaves no partial report behind (unwritable parent directory)", () => {
  const locked = join(workspace, "locked-dir");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o500);
  try {
    const run = cliRun(["inventory", "--source", standard.memoryRoot, "--report", join(locked, "report.json")]);
    assert.equal(run.status, 2, `expected open failure exit 2, got ${run.status}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /exclusive report open failed/);
  } finally {
    chmodSync(locked, 0o700);
  }
  assert.deepEqual(readdirSync(locked), [], "no partial report file may survive a failed write");
});

test("snapshot temp trees are removed after every engine run (no dsi-v02-migration-snap-* leftovers)", () => {
  engine.buildMigrationReport({ sourceRoot: standard.memoryRoot }, "inventory");
  const leftovers = readdirSync(tmpdir()).filter((n) => n.startsWith("dsi-v02-migration-snap-"));
  assert.deepEqual(leftovers, [], "snapshot temp directories must not survive the run");
});

// ---------- guarded compile cleanup of the CLI ----------

test("CLI removed only its own unique compile tree", () => {
  // spawnSync already returned; run a tiny probe: leftover trees must be gone
  const tmpEntries = readdirSync(tmpdir()).filter((n) => n.startsWith("dsi-migrate-v02-build-"));
  assert.deepEqual(tmpEntries, [], "leftover compile trees in tmpdir");
});

// ---------- summary ----------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log(`failed: ${failures.join(", ")}`);
  process.exitCode = 1;
}
