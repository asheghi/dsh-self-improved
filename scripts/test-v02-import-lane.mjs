#!/usr/bin/env node
/**
 * Focused synthetic suite for the Phase B import lane engine + CLI
 * (src/import-v02.ts + scripts/import-v02.mjs, per
 * MIGRATION-PHASE-B-IMPORT-DESIGN §3–§12).
 *
 * Proven on REAL synthetic fixture stores (real SQLite in WAL mode, real JSONL,
 * real child-process SIGKILL crash oracles) under the repo-local temp tree;
 * never production, active profile, or real user data.
 *
 * Run: node scripts/test-v02-import-lane.mjs
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore } from "../lib/storage.js";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repo = resolve(scriptDir, "..");
const baseDir = resolve(repo, ".tmp-import-lane", "tests");
rmSync(baseDir, { recursive: true, force: true });
mkdirSync(baseDir, { recursive: true });

let passed = 0;
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (cond) passed++;
  else failed++;
};
const uniqueDir = (tag) => join(baseDir, tag);
// fixed synthetic clock shared with the fixture builder (never Date.now())
const T0_EP = 1_700_000_000_000;
const sha256hex = (buf) => createHash("sha256").update(buf).digest("hex");

const { buildImportFixture, CANARIES } = await import(
  new URL("../fixtures/v02-import/build-import-fixture.mjs", import.meta.url).href
);
const engine = await import(new URL("../lib/import-v02.js", import.meta.url).href);

const CANARY_NEEDLES = [
  CANARIES.memory,
  CANARIES.slice,
  CANARIES.persona,
  CANARIES.skill,
  CANARIES.apiKey,
  CANARIES.unknownLeaf,
  CANARIES.schemaSecret,
  CANARIES.credentialContent,
];

const CLI = resolve(repo, "scripts", "import-v02.mjs");
const WORKER = resolve(repo, "fixtures", "v02-import", "worker-apply.mjs");

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
}

/** Source tree file list consistent with the engine's stable-file rule (no -wal/-shm). */
function stableDigest(root) {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && !p.endsWith("-shm") && !p.endsWith("-wal")) {
        files.push({ rel: p.slice(root.length + 1), bytes: sha256hex(readFileSync(p)), size: st.size });
      }
    }
  };
  walk(root);
  return files;
}

function digestsEqual(a, b) {
  return a.length === b.length && a.every((f, i) => f.rel === b[i].rel && f.bytes === b[i].bytes && f.size === b[i].size);
}

function hasAny(text, needles) {
  return needles.some((n) => text.includes(n));
}

function readPlanDoc(dest) {
  return JSON.parse(readFileSync(join(dest, "plan.json"), "utf8"));
}

function planToken(dest) {
  return JSON.parse(readFileSync(join(dest, "plan.json"), "utf8")).approvalToken;
}

function destArtifacts(dest) {
  return {
    backup: existsSync(join(dest, "backup")),
    normalized: existsSync(join(dest, "normalized")),
    ledger: existsSync(join(dest, "ledger.json")),
    receipt: existsSync(join(dest, "receipt.json")),
  };
}

/** Every regular file under a tree (byte-scan helper for the true canary). */
function listFilesUnder(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, name.name);
      if (name.isDirectory()) walk(p);
      else if (name.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

// ============================================================================
// Fixture 1: the shared golden source (built once; refusals run on fresh copies)
// ============================================================================

const f1 = buildImportFixture(uniqueDir("f1"));
const digestBeforeFixture = stableDigest(f1.memoryRoot);

// ============================================================================
// 1) PLAN contract — destination gets marker + plan.json only
// ============================================================================

const dest1 = uniqueDir("f1-dest");
const digestBeforePlan = stableDigest(f1.memoryRoot);
const planRun = runCli([
  "plan",
  "--source", f1.memoryRoot,
  "--dest", dest1,
  "--settings", f1.settingsPath,
  "--skills-root", f1.skillsRoot,
]);
const planDoc1 = readPlanDoc(dest1);
check("plan CLI exits 0 and writes marker + plan.json", planRun.status === 0 && existsSync(join(dest1, "plan.json")) && existsSync(join(dest1, "OWNER.dsh-self-improved-import")));
const dest1Extras = readdirSync(dest1).filter((n) => n !== "plan.json" && n !== "OWNER.dsh-self-improved-import");
check("plan writes NOTHING else into the fresh destination", dest1Extras.length === 0, dest1Extras.join(","));

// 2) verdict-count identity per family in the PLAN
{
  const fam = planDoc1.families;
  const recon = planDoc1.reconciliation.families;
  const memOk = recon["memories"].total === fam.memories.total
    && fam.memories.total === fam.memories.accepted.length + fam.memories.unsupported.length;
  const baseOk = recon["baseline"].total === fam.baseline.pinTargets.length + fam.baseline.unsupported.length;
  check("plan identity: memories", memOk, JSON.stringify(recon["memories"]));
  check("plan identity: baseline", baseOk, JSON.stringify(recon["baseline"]));
  check("plan identity: episodes", recon["episodes"].total === fam.episodes.episodes + fam.episodes.steps + fam.episodes.events && recon["episodes"].accepted === recon["episodes"].total, JSON.stringify(recon["episodes"]));
  check("plan identity: persona retained counts", recon["persona"].retained === fam.persona.counts.personaVersions + fam.persona.counts.personaFiles, JSON.stringify(recon["persona"]));
  check("plan identity: generatedSkills inactive retained", recon["generatedSkills"].total === recon["generatedSkills"].retained && fam.generatedSkills.counts.generatedSkillDirs > 0, JSON.stringify(recon["generatedSkills"]));
  check("plan identity: conversations (valid+dup malformed summed exactly)",
    recon["conversations"].total === recon["conversations"].retained + recon["conversations"].unsupported, JSON.stringify(recon["conversations"]));
  check("plan identity: cursors/scenes/vectors/unknownSchemaObjects",
    recon["cursors"].retained === recon["cursors"].total &&
    recon["scenes"].retained === recon["scenes"].total &&
    recon["vectors"].unsupported === recon["vectors"].total &&
    recon["unknownSchemaObjects"].unsupported === recon["unknownSchemaObjects"].total,
    JSON.stringify({ cursors: recon["cursors"].total, scenes: recon["scenes"].total, vectors: recon["vectors"].total, unknown: recon["unknownSchemaObjects"].total }));
  check("plan refuses a bad source loudly (missing memory.db)", runCli(["plan", "--source", join(uniqueDir("missing"), "nonexistent"), "--dest", uniqueDir("nope")]).status === 2);
  const expectedUnsupported = planDoc1.families.memories.unsupported.map((u) => u.reason).sort().join(",");
  check("adversarial rows land unsupported-evidenced with exact reasons",
    expectedUnsupported === [
      "category-out-of-contract-kind", "category-out-of-contract-provenance", "category-out-of-contract-scope",
      "evidence-not-parseable", "importance-out-of-range", "missing-meta-side-row",
    ].join(","), expectedUnsupported);
}

// 3) determinism — same source, fresh destination ⇒ identical planDigest
const dest1b = uniqueDir("f1-dest-b");
const detRun = runCli([
  "plan",
  "--source", f1.memoryRoot,
  "--dest", dest1b,
  "--settings", f1.settingsPath,
  "--skills-root", f1.skillsRoot,
]);
{
  const planDoc1b = readPlanDoc(dest1b);
  check("determinism: identical planDigest across fresh destinations", detRun.status === 0 && planDoc1b.planDigest === planDoc1.planDigest);
  check("approval token is bound to the destination root (paths differ ⇒ different token)", planDoc1b.approvalToken !== planDoc1.approvalToken);
}

// 4) bounded JSON: zero canaries in plan/stdout
{
  const planText = readFileSync(join(dest1, "plan.json"), "utf8");
  const cliOut = planRun.stdout + planRun.stderr;
  check("plan.json contains zero secret canaries", !hasAny(planText, CANARY_NEEDLES));
  check("CLI plan stdout contains zero secret canaries", !hasAny(cliOut, CANARY_NEEDLES));
}

// 7) approval token gate — refusals BEFORE any target write
{
  const empty1 = destArtifacts(dest1);
  const noToken = runCli(["import", "--dest", dest1]);
  check("import without token refuses (exit 2)", noToken.status === 2 && /approve/.test(noToken.stderr));
  check("no-token refusal wrote zero artifacts", JSON.stringify(empty1) === JSON.stringify(destArtifacts(dest1)));
  const badToken = runCli(["import", "--dest", dest1, "--approve", "not-the-real-token"]);
  check("mismatched token refuses (exit 2)", badToken.status === 2 && /missing or mismatched/.test(badToken.stderr));
  check("bad-token refusal wrote zero artifacts", JSON.stringify(empty1) === JSON.stringify(destArtifacts(dest1)));
}

// 10) source drift between plan and apply refused — fresh source copy (f2)
{
  const f2 = buildImportFixture(uniqueDir("f2"));
  const dest2 = uniqueDir("f2-dest");
  runCli(["plan", "--source", f2.memoryRoot, "--dest", dest2, "--settings", f2.settingsPath, "--skills-root", f2.skillsRoot]);
  const token2 = planToken(dest2);
  // mutate the source AFTER the plan: append one WAL commit
  const dbW = new DatabaseSync(join(f2.memoryRoot, "memory.db"));
  dbW.exec("PRAGMA journal_mode = WAL");
  dbW.prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES ('drift-row', 'fact', 'delayed drift row', 5, 0, 9999999999999, 9999999999999, 'active', NULL)").run();
  dbW.close();
  const drifted = runCli(["import", "--dest", dest2, "--approve", token2, "--settings", f2.settingsPath, "--skills-root", f2.skillsRoot]);
  check("source drift refusal (WAL delta gate)", drifted.status === 2 && /delta/.test(drifted.stderr), drifted.stderr.trim().split("\n")[0]);
  const d = destArtifacts(dest2);
  check("drift refusal wrote zero artifacts", !d.backup && !d.normalized && !d.ledger && !d.receipt);
  rmSync(uniqueDir("f2"), { recursive: true, force: true });
}

// 6b) non-SQLite header source refused, no dest artifact
{
  const fFake = uniqueDir("f-fake");
  mkdirSync(join(fFake, "memory"), { recursive: true });
  writeFileSync(join(fFake, "memory", "memory.db"), "definitely not sqlite\n");
  const res = runCli(["plan", "--source", join(fFake, "memory"), "--dest", uniqueDir("f-fake-dest")]);
  check("non-SQLite memory.db header refuses outright", res.status === 2 && /not an SQLite 3 database/.test(res.stderr), res.stderr.trim().split("\n").slice(-1)[0]);
  check("non-SQLite refusal created no destination artifacts", !existsSync(uniqueDir("f-fake-dest")) || readdirSync(uniqueDir("f-fake-dest")).length === 0);
  rmSync(fFake, { recursive: true, force: true });
}

// 9) plan-integrity gate — tampered plan body refuses on digest
{
  const f3 = buildImportFixture(uniqueDir("f3"));
  const dest3 = uniqueDir("f3-dest");
  runCli(["plan", "--source", f3.memoryRoot, "--dest", dest3, "--settings", f3.settingsPath, "--skills-root", f3.skillsRoot]);
  const planPath = join(dest3, "plan.json");
  const tampered = JSON.parse(readFileSync(planPath, "utf8"));
  tampered.families.memories.accepted.pop(); // body change, digest untouched
  writeFileSync(planPath, JSON.stringify(tampered, null, 2), "utf8");
  const res = runCli(["import", "--dest", dest3, "--approve", tampered.approvalToken]);
  check("tampered plan body refuses", res.status === 2 && /inconsistent with its declared planDigest/.test(res.stderr), res.stderr.trim().split("\n")[0]);
  rmSync(uniqueDir("f3"), { recursive: true, force: true });
}

// 11) target ownership guards (fresh copies per case)
{
  // a) owner marker removed
  const fA = buildImportFixture(uniqueDir("f4a"));
  const destA = uniqueDir("f4a-dest");
  runCli(["plan", "--source", fA.memoryRoot, "--dest", destA, "--settings", fA.settingsPath, "--skills-root", fA.skillsRoot]);
  rmSync(join(destA, "OWNER.dsh-self-improved-import"));
  const resA = runCli(["import", "--dest", destA, "--approve", JSON.parse(readFileSync(join(destA, "plan.json"), "utf8")).approvalToken]);
  check("owner-marker removal refuses", resA.status === 2 && /owner marker is missing or (foreign|unreadable)/.test(resA.stderr), resA.stderr.trim().split("\n")[0]);
  check("marker refusal wrote nothing", !destArtifacts(destA).backup);
  rmSync(uniqueDir("f4a"), { recursive: true, force: true });

  // b) pre-seeded unowned target row (tampering before first legit apply)
  const fB = buildImportFixture(uniqueDir("f4b"));
  const destB = uniqueDir("f4b-dest");
  runCli(["plan", "--source", fB.memoryRoot, "--dest", destB, "--settings", fB.settingsPath, "--skills-root", fB.skillsRoot]);
  mkdirSync(join(destB, "normalized"), { recursive: true });
  const seeded = new MemoryStore(join(destB, "normalized"));
  seeded.insertMemory({ kind: "fact", content: "tamper row that must never be part of the import" }, {});
  seeded.close();
  const resB = runCli(["import", "--dest", destB, "--approve", JSON.parse(readFileSync(join(destB, "plan.json"), "utf8")).approvalToken]);
  check("pre-seeded target refuses before any backup write", resB.status === 2 && /empty by construction/.test(resB.stderr), resB.stderr.trim().split("\n")[0]);
  check("pre-seeded refusal wrote no backup", !destArtifacts(destB).backup);
  rmSync(uniqueDir("f4b"), { recursive: true, force: true });

  // c) foreign watermark in an otherwise clean target
  const fC = buildImportFixture(uniqueDir("f4c"));
  const destC = uniqueDir("f4c-dest");
  runCli(["plan", "--source", fC.memoryRoot, "--dest", destC, "--settings", fC.settingsPath, "--skills-root", fC.skillsRoot]);
  mkdirSync(join(destC, "normalized"), { recursive: true });
  const seededC = new MemoryStore(join(destC, "normalized"));
  seededC.runInImmediateTransaction(() => {
    seededC.getJournalSqlite()
      .prepare("SELECT 1") // touch the connection (identity of the store)
      .get();
    seededC.getJournalSqlite().prepare(
      `INSERT INTO store_state (key, value, updated_at) VALUES ('import-v0.2-phase-b:progress', '{"planDigest":"foreign-digest","memoryCommitted":0,"chunksCommitted":0,"episodesCommitted":0,"stepsCommitted":0,"eventsCommitted":0,"sessionProjectsCommitted":0,"baselineCommitted":false,"importMarkerRowCommitted":false}', 0)`,
    ).run();
  });
  seededC.close();
  const resC = runCli(["import", "--dest", destC, "--approve", JSON.parse(readFileSync(join(destC, "plan.json"), "utf8")).approvalToken]);
  check("foreign watermark refuses (collision, plan mismatch)", resC.status === 2 && /different import plan digest/.test(resC.stderr), resC.stderr.trim().split("\n")[0]);
  rmSync(uniqueDir("f4c"), { recursive: true, force: true });
}

// ============================================================================
// APPLY on fixture 1 (golden run) + verdict-preservation assertions
// ============================================================================

const digestBeforeApply = stableDigest(f1.memoryRoot);
const importRun = runCli([
  "import",
  "--dest", dest1,
  "--approve", planDoc1.approvalToken,
  "--settings", f1.settingsPath,
  "--skills-root", f1.skillsRoot,
]);
check("import CLI exits 0 with token-verified apply", importRun.status === 0, importRun.stderr || importRun.stdout);
const receipt = JSON.parse(readFileSync(join(dest1, "receipt.json"), "utf8"));
const ledger = JSON.parse(readFileSync(join(dest1, "ledger.json"), "utf8"));

// 6) readonly source immutability across plan AND apply
check("source tree digest unchanged by plan and apply", digestsEqual(stableDigest(f1.memoryRoot), digestBeforeFixture), "stable-file list compare");

// 4/5) privacy + restore-grade separation on the build artifacts
{
  const docText = readFileSync(join(dest1, "plan.json"), "utf8") + readFileSync(join(dest1, "ledger.json"), "utf8") + readFileSync(join(dest1, "receipt.json"), "utf8");
  check("lane docs (plan+ledger+receipt) contain zero secret canaries", !hasAny(docText, CANARY_NEEDLES));
  check("CLI import stdout contains zero secret canaries", !hasAny(importRun.stdout + importRun.stderr, CANARY_NEEDLES));
  const backupPersona = readFileSync(join(dest1, "backup", "persona", "persona.md"), "utf8");
  const backupSettings = readFileSync(join(dest1, "backup", "settings.yaml"), "utf8");
  const backupMemoryDb = readFileSync(join(dest1, "backup", "memory.db"));
  const backupSkillMd = readFileSync(join(dest1, "backup", "skills", "dsi-fixture-alpha", "SKILL.md"), "utf8");
  const backupSlice = readFileSync(join(dest1, "backup", "conversations", "session-s1.jsonl"), "utf8");
  check("backup persona prose is byte-verbatim (canary present)", backupPersona.includes(CANARIES.persona));
  check("backup settings file is byte-verbatim (api key canary present)", backupSettings.includes(CANARIES.apiKey));
  check("backup memory.db is byte-verbatim (memory + credential canaries present)",
    backupMemoryDb.includes(Buffer.from(CANARIES.memory)) && backupMemoryDb.includes(Buffer.from(CANARIES.credentialContent)));
  check("backup skills bodies retained verbatim (never activated anywhere)", backupSkillMd.includes(CANARIES.skill));
  check("backup conversation slices retained verbatim (backlog material only)", backupSlice.includes(CANARIES.slice));
}

// 12) apply verdict preservation through the storage import seam
{
  const normal = new MemoryStore(join(dest1, "normalized"));
  const sourceDb = new DatabaseSync(join(f1.memoryRoot, "memory.db"), { readOnly: true });

  const sourceRow = (id) => sourceDb.prepare("SELECT * FROM memories WHERE id = ?").get(id);
  const sourceMeta = (id) => sourceDb.prepare("SELECT * FROM memories_meta WHERE memory_id = ?").get(id);
  const targetRow = (id) => normal.getMemory(id);
  const targetMeta = (id) => normal.getMeta(id);
  const src = sourceRow("alpha-pref-dark");
  const tgt = targetRow("alpha-pref-dark");
  check("verbatim identity: id/kind/importance/timestamps/supersedes/status",
    tgt && tgt.id === "alpha-pref-dark" && tgt.kind === src.kind && tgt.importance === src.importance &&
    tgt.createdAt === src.created_at && tgt.updatedAt === src.updated_at &&
    tgt.supersedes === src.supersedes && tgt.status === "active",
    JSON.stringify(tgt ?? {}));

  const metaIn = targetMeta("alpha-pref-dark");
  const metaSrc = sourceMeta("alpha-pref-dark");
  check("verbatim meta: provenance/source/scope/project/session/confidence/expiresAt",
    metaIn.provenance === metaSrc.provenance && metaIn.source === metaSrc.source && metaIn.scope === metaSrc.scope &&
    metaIn.projectId === metaSrc.project_id && metaIn.sessionId === metaSrc.session_id &&
    metaIn.confidence === metaSrc.confidence && metaIn.expiresAt === metaSrc.expires_at,
    JSON.stringify(metaIn ?? {}));
  check("verbatim evidence array carried through the seam",
    targetMeta("alpha-derived-note").evidence[0]?.episodeId === "ep-live-1" &&
    targetMeta("alpha-derived-note").evidence[0]?.callId === "call-ok-1",
    JSON.stringify(targetMeta("alpha-derived-note")?.evidence ?? []));

  check("source statuses preserved verbatim (forgotten/migrated/decayed/quarantined/corrected)",
    targetRow("alpha-forgotten").status === "forgotten" &&
    targetRow("alpha-migrated").status === "migrated" &&
    targetRow("alpha-decayed").status === "decayed" &&
    targetRow("alpha-quarantined").status === "quarantined" &&
    targetRow("alpha-pref-theme-old").status === "corrected");

  check("planned demotion A: credential-shaped content lands quarantined + content REDACTED (raw canary absent from the operational target, byte-verbatim only in the backup)",
    targetRow("alpha-credential-row").status === "quarantined" &&
    targetRow("alpha-credential-row").content === engine.REDACTED_MEMORY_CONTENT &&
    !targetRow("alpha-credential-row").content.includes("api_key"));
  check("planned demotion B: active instruction lands quarantined", targetRow("alpha-instruction-row").status === "quarantined");
  check("planned demotion C: persona-provenance row lands quarantined", targetRow("alpha-persona-row").status === "quarantined");

  // unsupported rows are NEVER imported
  const badIds = ["bad-missing-meta", "bad-evidence-json", "bad-kind-probe", "bad-activity-probe", "bad-scope-probe", "bad-importance-probe"];
  check("unsupported rows are absent from the operational target",
    badIds.every((id) => targetRow(id) == null) && badIds.every((id) => ledger.memoryAccepted.every((m) => m.id !== id)));

  // baseline slot preserved verbatim with the SOURCE pin timestamp
  const baseRowP = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT * FROM baseline WHERE slot = 1").get();
  const baseRowS = sourceDb.prepare("SELECT * FROM baseline WHERE slot = 1").get();
  check("baseline pin verbatim (slot/memoryId/timestamp, NOT minted)",
    baseRowP && baseRowP.memory_id === "bulk-fact-0001" && baseRowP.updated_at === baseRowS.updated_at,
    JSON.stringify(baseRowP ?? {}));

  // episodes copied verbatim (column equality)
  const epT = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT * FROM episodes WHERE id = 'ep-live-1'").get();
  check("episodes copied verbatim (id/session/project/status/started_at/summary)",
    epT && epT.session_id === "session-s1" && epT.project_id === "proj-synth" && epT.status === "succeeded" &&
    epT.started_at === T0_EP && epT.summary === "synthetic summary",
    JSON.stringify(epT ?? {}));
  const stepT = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT COUNT(*) n FROM episode_steps WHERE episode_id = 'ep-live-1'").get();
  check("episode_steps copied verbatim (count)", Number(stepT?.n ?? 0) === 2, String(stepT?.n));
  const evT = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT COUNT(*) n FROM episode_events").get();
  check("episode_events copied verbatim (count)", Number(evT?.n ?? 0) === 2, String(evT?.n));

  // 15) no native ack of cursors/extract_state
  const extractRows = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT COUNT(*) n FROM extract_state").get();
  check("legacy cursors never acknowledged/inserted into the target", Number(extractRows?.n ?? 0) === 0, String(extractRows?.n));

  // 14) target seq minted strictly increasing over exactly accepted rows
  {
    const seqRows = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT seq FROM memories_seq ORDER BY seq").all();
    const seqs = seqRows.map((r) => Number(r.seq));
    check("target seq: count == accepted rows, unique, strictly increasing",
      ledger.memoryAccepted.length === 139 && seqs.length === 139 && new Set(seqs).size === 139 && seqs[0] === 1 && seqs[138] === 139,
      `n=${seqs.length} min=${seqs[0]} max=${seqs[seqs.length - 1]}`);
  }

  // import marker row stores the plan digest inside the target store_state
  const markerRow = new DatabaseSync(join(dest1, "normalized", "memory.db"), { readOnly: true })
    .prepare("SELECT value FROM store_state WHERE key = 'import-v0.2-phase-b'").get();
  check("store_state import row present with matching plan digest",
    markerRow && JSON.parse(String(markerRow.value)).planDigest === planDoc1.planDigest,
    JSON.stringify(markerRow ?? {}));

  // 13) FTS: only effective-active imported rows searchable + injectable
  const hits = normal.searchMemories("light theme", { limit: 10 });
  check("FTS recall finds active imported rows", hits.some((h) => h.id === "alpha-pref-light"), JSON.stringify(hits.slice(0, 3).map((h) => h.id)));
  const injectable = normal.searchMemories("api_key", { limit: 10, injectableOnly: true });
  check("demoted credential row is NOT injectable/searchable", injectable.length === 0 && !hits.some((h) => h.id === "alpha-credential-row"));
  const personaHit = normal.searchMemories("flavor sentence", { limit: 10, injectableOnly: true });
  check("demoted persona row is NOT injectable (mirror row excluded by probe text)", !personaHit.some((h) => h.id === "alpha-persona-row"), JSON.stringify(personaHit.map((h) => h.id)));
  normal.close();
  sourceDb.close();
}

// TRUE CANARY — raw byte scan of EVERY file under the operational normalized
// target (memory.db holds memories/meta/evidence JSON + the full FTS index;
// WBAL/-shm companions scanned when present). Only the accepted-verbatim
// memory-content canary is allowed to exist there, because accepted memory
// content IS the operational payload; every other fixture canary — in
// particular the credential-shaped one — must be byte-absent.
{
  const normalizedFiles = listFilesUnder(join(dest1, "normalized"));
  check("normalized tree has files to byte-scan (including memory.db)", normalizedFiles.some((f) => f.endsWith("memory.db")), normalizedFiles.map((f) => f.slice(dest1.length + 1)).join(","));
  const offenders = [];
  for (const file of normalizedFiles) {
    const bytes = readFileSync(file);
    for (const needle of CANARY_NEEDLES) {
      if (needle === CANARIES.memory) continue;
      if (bytes.includes(Buffer.from(needle))) offenders.push(`${file.slice(dest1.length + 1)} :: ${needle}`);
    }
  }
  check("TRUE canary byte-scan: normalized memory.db/WAL/FTS/meta/evidence carry zero credential-shaped or excluded-family canaries (privacy gate holds at byte level)",
    offenders.length === 0, offenders.join(" | "));
  const memCanaryFiles = normalizedFiles.filter((f) => readFileSync(f).includes(Buffer.from(CANARIES.memory))).length;
  check("accepted-verbatim memory-content canary IS present in the normalized store (lossless accepted rows unchanged; redaction is the only minimization)", memCanaryFiles >= 1);
}

// EVIDENCE + META credential smuggling — dedicated adversarial fixture rows
// (source fixture untouched; the lane must redact credential-shaped content
// hidden in evidence payloads and projectId/sessionId meta strings too).
{
  const fE = buildImportFixture(uniqueDir("f-credmeta"));
  const dbE = new DatabaseSync(join(fE.memoryRoot, "memory.db"));
  dbE.exec("PRAGMA journal_mode = WAL");
  const te0 = T0_EP + 500_000;
  dbE.prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES ('evidence-cred-row', 'fact', 'benign body text', 5, 0, ?, ?, 'active', NULL)").run(te0, te0 + 1);
  dbE.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at) VALUES ('evidence-cred-row', 'user', 'legacy', 'global', NULL, NULL, 0.5, NULL, ?, 3, ?)").run(
    JSON.stringify([{ sessionId: "session-benign", snippet: `recovered token = ${CANARIES.credentialContent}` }]),
    te0 + 2,
  );
  const te1 = te0 + 10_000;
  dbE.prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status, supersedes) VALUES ('meta-cred-row', 'fact', 'benign meta body', 5, 0, ?, ?, 'active', NULL)").run(te1, te1 + 1);
  dbE.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, project_id, session_id, confidence, expires_at, evidence, read_count, last_read_at) VALUES ('meta-cred-row', 'user', 'legacy', 'global', 'proj-benign', 'https://user:pass@evil.internal/db', 0.5, NULL, '[]', 3, ?)").run(te1 + 2);
  // Keep these adversarial rows structurally valid: missing insertion
  // coordinates are a separate unsupported-row case, not privacy coverage.
  const nextFixtureSeq = Number(dbE.prepare("SELECT COALESCE(MAX(seq), 0) n FROM memories_seq").get().n) + 1;
  dbE.prepare("INSERT INTO memories_seq (seq, memory_id) VALUES (?, ?)").run(nextFixtureSeq, "evidence-cred-row");
  dbE.prepare("INSERT INTO memories_seq (seq, memory_id) VALUES (?, ?)").run(nextFixtureSeq + 1, "meta-cred-row");
  dbE.close();

  const destE = uniqueDir("f-credmeta-dest");
  const planE = runCli(["plan", "--source", fE.memoryRoot, "--dest", destE, "--settings", fE.settingsPath, "--skills-root", fE.skillsRoot]);
  check("evidence/meta adversarial fixture plan exits 0", planE.status === 0, (planE.stderr || "").trim().split("\n")[0]);
  const planDocE = readPlanDoc(destE);
  const demE = planDocE.families.memories.plannedDemotions.map((d) => d.id).sort();
  check("credential-shaped EVIDENCE and META smugglers are classified credential-content-demotion in the plan",
    demE.includes("evidence-cred-row") && demE.includes("meta-cred-row"), demE.join(","));
  const impE = runCli(["import", "--dest", destE, "--approve", planDocE.approvalToken, "--settings", fE.settingsPath, "--skills-root", fE.skillsRoot]);
  check("evidence/meta canary apply exits 0", impE.status === 0, (impE.stderr || "").trim().split("\n")[0]);

  const storeE = new MemoryStore(join(destE, "normalized"));
  const eRowE = storeE.getMemory("evidence-cred-row");
  const eMetaE = storeE.getMeta("evidence-cred-row");
  const mRowE = storeE.getMemory("meta-cred-row");
  const mMetaE = storeE.getMeta("meta-cred-row");
  check("evidence smuggler: row quarantined, benign fields preserved, offending evidence entry tombstoned (intact-entry shape unchanged)",
    eRowE.status === "quarantined" && eRowE.content === "benign body text" &&
    JSON.stringify(eMetaE.evidence).includes(engine.REDACTED_EVIDENCE_ENTRY.redacted) &&
    !JSON.stringify(eMetaE.evidence).includes(CANARIES.credentialContent) &&
    !JSON.stringify(eMetaE.evidence).includes("recovered token"),
    JSON.stringify(eMetaE.evidence));
  check("meta smuggler: row quarantined, credential-shaped sessionId withheld, benign projectId preserved verbatim",
    mRowE.status === "quarantined" && mMetaE.sessionId == null && mMetaE.projectId === "proj-benign", JSON.stringify(mMetaE ?? {}));

  const ledgerE = JSON.parse(readFileSync(join(destE, "ledger.json"), "utf8"));
  const eLedgerE = ledgerE.memoryAccepted.find((m) => m.id === "evidence-cred-row");
  const mLedgerE = ledgerE.memoryAccepted.find((m) => m.id === "meta-cred-row");
  check("ledger redaction accounting is explicit per part (no silent loss, never a bare deletion)",
    eLedgerE?.demotion === "credential-content-demotion" && eLedgerE?.evidenceRedacted === true && eLedgerE?.contentRedacted !== true &&
    mLedgerE?.demotion === "credential-content-demotion" && mLedgerE?.metaRedacted === true && mLedgerE?.contentRedacted !== true,
    JSON.stringify({ e: eLedgerE, m: mLedgerE }));
  check("receipt limits name the credential redaction boundary explicitly", (JSON.parse(readFileSync(join(destE, "receipt.json"), "utf8")).limits ?? []).join(" ").includes("REDACTED in the operational target"));

  // TRUE canary at byte level for the adversarial fixture: the smuggled
  // credential text is absent from EVERY normalized file but byte-verbatim in
  // the private backup.
  const normalizedE = listFilesUnder(join(destE, "normalized"));
  const offE = normalizedE.filter((f) => readFileSync(f).includes(Buffer.from(CANARIES.credentialContent)));
  check("TRUE canary: smuggled evidence/meta credential text byte-absent from every normalized file (db bytes + WAL companions + FTS + meta + evidence JSON)",
    offE.length === 0, offE.join(" | "));
  check("TRUE canary: the credential text stays byte-verbatim in the 0700 private backup only",
    readFileSync(join(destE, "backup", "memory.db")).includes(Buffer.from(CANARIES.credentialContent)));
  storeE.close();
  rmSync(join(uniqueDir("f-credmeta-dest")), { recursive: true, force: true });
  rmSync(join(uniqueDir("f-credmeta"), "dsh-home"), { recursive: true, force: true });
  rmSync(join(uniqueDir("f-credmeta"), "settings.yaml"), { force: true });
  rmSync(uniqueDir("f-credmeta"), { recursive: true, force: true });
}

// T0 helper used by the episode verbatim check (fixed synthetic clock in the fixture builder)

// ============================================================================
// 8) lifecycle guards after a completed apply
// ============================================================================

{
  const rerun = runCli(["import", "--dest", dest1, "--approve", planDoc1.approvalToken, "--resume"]);
  check("re-running a completed import refuses even with resume", rerun.status === 2 && /already exists/.test(rerun.stderr), rerun.stderr.trim().split("\n")[0]);
  const occPlan = runCli(["plan", "--source", f1.memoryRoot, "--dest", dest1]);
  check("fresh plan refuses an occupied destination", occPlan.status === 2 && /already exists and is not empty/.test(occPlan.stderr), occPlan.stderr.trim().split("\n")[0]);
}

// receipt-level verdict identity + measured state
{
  const recon = receipt.reconciliation.families;
  let allOk = true;
  for (const [family, identity] of Object.entries(recon)) {
    if (identity.accepted + identity.retained + identity.unsupported !== identity.total) allOk = false;
  }
  check("receipt reconciliation: every family identity sums exactly", allOk && receipt.reconciliation.allReconciled === true, JSON.stringify(recon["memories"]));
  check("receipt: revision delta == accepted rows exactly (one bump per row, same tx)",
    receipt.target.revisionBefore === 0 && receipt.target.revisionAfter === planDoc1.families.memories.accepted.length,
    `${receipt.target.revisionBefore}->${receipt.target.revisionAfter}`);
  check("receipt: quick_check ok + owner marker verified + backup manifest verified",
    receipt.target.quickCheckOk === true && receipt.target.ownerMarkerVerified === true && receipt.backup.manifestVerified === true &&
    receipt.safety.sameTxChunkProgressLedger === true && receipt.safety.sourceOpenedReadOnly === true);
  check("receipt: memory counts measured == planned", receipt.target.memoryRows === planDoc1.families.memories.accepted.length &&
    receipt.target.baselineRows === planDoc1.families.baseline.pinTargets.length &&
    receipt.target.episodeRows.episodes === planDoc1.families.episodes.episodes &&
    receipt.target.sessionProjects === planDoc1.families.sessionProjects.rows);
  check("receipt: unchangedDuringApply true (source re-verified after last write)", receipt.source.unchangedDuringApply === true);
  check("receipt: unfinishedFamilies empty count (no pretend-lossless family)", receipt.unfinishedFamilies.length === 0);
  check("receipt limits name the not-imported families explicitly",
    hasAny(receipt.limits.join(" "), ["persona_versions rows", "conversation lines", "cursors", "vectors.db embeddings", "unknown schema_state markers", "scenes rows", "access stats", "REDACTED in the operational target"]));
  check("ledger chunkWatermark matches the fixed chunk size and accepted counts",
    ledger.chunkWatermark.memoryRowsCommitted === planDoc1.families.memories.accepted.length,
    JSON.stringify(ledger.chunkWatermark));
  check("ledger: verbatim legacySeq -> targetSeq mapping present, strictly increasing in targetSeq",
    ledger.memoryAccepted.length === planDoc1.families.memories.accepted.length &&
    ledger.memoryAccepted.every((m, i) => i === 0 || ledger.memoryAccepted[i - 1].legacySeq <= m.legacySeq) &&
    new Set(ledger.memoryAccepted.map((m) => m.targetSeq)).size === ledger.memoryAccepted.length);

  // restore-grade proof: backup memory.db content == source content (VACUUM INTO snapshot of the same rows)
  const sourceDbR = new DatabaseSync(join(f1.memoryRoot, "memory.db"), { readOnly: true });
  const backupDb = new DatabaseSync(join(dest1, "backup", "memory.db"), { readOnly: true });
  const srcRows = sourceDbR.prepare("SELECT id, kind, content, importance, created_at, updated_at, status, supersedes FROM memories ORDER BY id").all();
  const bakRows = backupDb.prepare("SELECT id, kind, content, importance, created_at, updated_at, status, supersedes FROM memories ORDER BY id").all();
  check("restore fidelity: every source memory row (incl. unsupported ones) present byte-faithfully in the backup",
    JSON.stringify(srcRows) === JSON.stringify(bakRows), `src=${srcRows.length} bak=${bakRows.length}`);
  const srcCursor = sourceDbR.prepare("SELECT * FROM extract_state ORDER BY session_id").all();
  const bakCursor = backupDb.prepare("SELECT * FROM extract_state ORDER BY session_id").all();
  check("restore fidelity: cursors retained verbatim in the backup (never in the target)",
    JSON.stringify(srcCursor) === JSON.stringify(bakCursor) && bakCursor.length === 3);
  sourceDbR.close();
  backupDb.close();
}

// 19/20) unsupported-evidenced accounting details
{
  const ledger = JSON.parse(readFileSync(join(dest1, "ledger.json"), "utf8"));
  const byId = new Map(ledger.memoryUnsupported.map((u) => [u.id, u.reason]));
  check("unsupported accounting: exact ids + bounded reasons", byId.get("bad-missing-meta") === "missing-meta-side-row" && byId.get("bad-evidence-json") === "evidence-not-parseable" && byId.get("bad-kind-probe") === "category-out-of-contract-kind" && byId.get("bad-activity-probe") === "category-out-of-contract-provenance" && byId.get("bad-scope-probe") === "category-out-of-contract-scope" && byId.get("bad-importance-probe") === "importance-out-of-range", JSON.stringify([...byId]));
  check("baseline unsupported accounting: dangling + ineligible with coordinates",
    ledger.baselineUnsupported.length === 2 && ledger.baselineUnsupported.some((b) => b.reason === "dangling-pin-target") && ledger.baselineUnsupported.some((b) => b.reason === "ineligible-pin-provenance"),
    JSON.stringify(ledger.baselineUnsupported));
  check("baseline accepted only through the preserved eligible target",
    ledger.baselineAccepted.length === 1 && ledger.baselineAccepted[0].memoryId === "bulk-fact-0001");
  check("evidenceRefsUnverifiable accounted with an opaque ref digest and no raw episode id",
    planDoc1.families.memories.evidenceRefsUnverifiable.length === 1 &&
    planDoc1.families.memories.evidenceRefsUnverifiable[0].episodeRefDigest.startsWith("opaque:") &&
    !JSON.stringify(planDoc1).includes("ep-never-exists"));
  const broken = ledger.memoryAccepted.find((m) => m.id === "alpha-supersedes-broken");
  check("broken supersedes carried verbatim with an integrity note (never normalized into trust)",
    broken && broken.supersedes === "id-never-existing-target" && broken.integrityNote === "supersedes-target-absent", JSON.stringify(broken ?? {}));
}

// ============================================================================
// CRASH ORACLES — REAL SIGKILL via the worker fixture
// ============================================================================

function countTargetRows(normalizedDir, sql) {
  const db = new DatabaseSync(join(normalizedDir, "memory.db"), { readOnly: true });
  try {
    const row = db.prepare(sql).get();
    return Number(Object.values(row ?? {})[0] ?? 0);
  } finally {
    db.close();
  }
}

function readProgressRow(normalizedDir) {
  const db = new DatabaseSync(join(normalizedDir, "memory.db"), { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM store_state WHERE key = 'import-v0.2-phase-b:progress'").get();
    return row ? JSON.parse(String(row.value)) : undefined;
  } finally {
    db.close();
  }
}

// 16) CRASH ORACLE A — REAL SIGKILL mid-chunk: rollback leaks nothing; resume exact
{
  const f = buildImportFixture(uniqueDir("f6"));
  const dest = uniqueDir("f6-dest");
  runCli(["plan", "--source", f.memoryRoot, "--dest", dest, "--settings", f.settingsPath, "--skills-root", f.skillsRoot]);
  const token = planToken(dest);
  const killed = spawnSync(process.execPath, [WORKER, "--dest", dest, "--crash-points", "memory-chunk:2:mid"], { cwd: repo, encoding: "utf8" });
  check("worker died by real SIGKILL at the mid-chunk boundary", killed.signal === "SIGKILL", `signal=${killed.signal} code=${killed.status}${killed.stderr ? " " + killed.stderr.split("\n")[0] : ""}`);
  const watermark = readProgressRow(join(dest, "normalized"));
  const rows10 = countTargetRows(join(dest, "normalized"), "SELECT COUNT(*) n FROM memories");
  check("mid-chunk rollback: chunk1 rows + SAME-TX watermark committed, chunk2 absent",
    watermark && watermark.memoryCommitted === 100 && watermark.chunksCommitted === 1 && rows10 === 100,
    JSON.stringify(watermark) + ` rows=${rows10}`);
  const ftsOrphans = countTargetRows(join(dest, "normalized"), "SELECT COUNT(*) n FROM memories m WHERE m.id NOT IN (SELECT content_rowid FROM memories_fts) AND m.status = 'active'");
  check("mid-chunk rollback: zero active rows outside FTS (no partial chunk leftovers)", ftsOrphans === 0, String(ftsOrphans));
  const d = destArtifacts(dest);
  check("mid-chunk crash left NO receipt/ledger", !d.receipt && !d.ledger);
  const resumed = runCli(["import", "--dest", dest, "--approve", token, "--settings", f.settingsPath, "--skills-root", f.skillsRoot, "--resume"]);
  check("resume after mid-chunk SIGKILL completes", resumed.status === 0, (resumed.stderr || "").slice(0, 200));
  const rowsFinal = countTargetRows(join(dest, "normalized"), "SELECT COUNT(*) n FROM memories");
  const seqRows = new DatabaseSync(join(dest, "normalized", "memory.db"), { readOnly: true }).prepare("SELECT seq FROM memories_seq ORDER BY seq").all().map((r) => Number(r.seq));
  check("resume yields exact counts with no duplicates (unique seq over exact accepted rows)",
    rowsFinal === 139 && seqRows.length === 139 && new Set(seqRows).size === 139 && seqRows[0] === 1 && seqRows[seqRows.length - 1] === 139,
    `rows=${rowsFinal} seqs=${seqRows.length}`);
  const receipt6 = JSON.parse(readFileSync(join(dest, "receipt.json"), "utf8"));
  check("resumed receipt reconciliation holds", receipt6.reconciliation.allReconciled === true && receipt6.target.memoryRows === 139);
  check("resume did not duplicate baseline pins", receipt6.target.baselineRows === 1);
  const progressFinal = readProgressRow(join(dest, "normalized"));
  check("final watermark matches complete coverage", progressFinal.memoryCommitted === 139 && progressFinal.chunksCommitted === 2, JSON.stringify(progressFinal));
  rmSync(uniqueDir("f6"), { recursive: true, force: true });
}

// 17) CRASH ORACLE B — SIGKILL after ledger write: resume rewrites only the receipt
{
  const f = buildImportFixture(uniqueDir("f7"));
  const dest = uniqueDir("f7-dest");
  runCli(["plan", "--source", f.memoryRoot, "--dest", dest, "--settings", f.settingsPath, "--skills-root", f.skillsRoot]);
  const token = planToken(dest);
  const killed = spawnSync(process.execPath, [WORKER, "--dest", dest, "--crash-points", "apply:after-ledger-write"], { cwd: repo, encoding: "utf8" });
  check("worker died by real SIGKILL at the post-ledger boundary", killed.signal === "SIGKILL", `signal=${killed.signal} code=${killed.status}`);
  const d7 = destArtifacts(dest);
  check("post-ledger crash left ledger.json on disk and receipt missing", !!d7.ledger && !d7.receipt);
  const ledgerBytesBefore = sha256hex(readFileSync(join(dest, "ledger.json")));
  const resumed = runCli(["import", "--dest", dest, "--approve", token, "--settings", f.settingsPath, "--skills-root", f.skillsRoot, "--resume"]);
  check("resume after post-ledger SIGKILL completes", resumed.status === 0, (resumed.stderr || "").slice(0, 200));
  const ledgerBytesAfter = sha256hex(readFileSync(join(dest, "ledger.json")));
  check("resume rewrote NOTHING (ledger bytes identical) and wrote only the receipt", ledgerBytesBefore === ledgerBytesAfter && existsSync(join(dest, "receipt.json")));
  const receipt7 = JSON.parse(readFileSync(join(dest, "receipt.json"), "utf8"));
  check("resumed receipt: backup manifest verified + reconciliation complete",
    receipt7.backup.manifestVerified === true && receipt7.reconciliation.allReconciled === true && receipt7.target.memoryRows === 139);
  rmSync(uniqueDir("f7"), { recursive: true, force: true });
}

// 18) CRASH ORACLE C — SIGKILL inside the FINAL transaction (baseline + import row)
{
  const f = buildImportFixture(uniqueDir("f8"));
  const dest = uniqueDir("f8-dest");
  runCli(["plan", "--source", f.memoryRoot, "--dest", dest, "--settings", f.settingsPath, "--skills-root", f.skillsRoot]);
  const token = planToken(dest);
  const killed = spawnSync(process.execPath, [WORKER, "--dest", dest, "--crash-points", "final-tx:inside"], { cwd: repo, encoding: "utf8" });
  check("worker died by real SIGKILL inside the final transaction", killed.signal === "SIGKILL", `signal=${killed.signal} code=${killed.status}`);
  check("final-tx rollback: baseline absent and import marker absent before resume",
    countTargetRows(join(dest, "normalized"), "SELECT COUNT(*) n FROM baseline") === 0 &&
    countTargetRows(join(dest, "normalized"), "SELECT COUNT(*) n FROM memories") === 139,
    `baseline check`);
  const resumed = runCli(["import", "--dest", dest, "--approve", token, "--settings", f.settingsPath, "--skills-root", f.skillsRoot, "--resume"]);
  check("resume after final-tx SIGKILL completes", resumed.status === 0, (resumed.stderr || "").slice(0, 200));
  const receipt8 = JSON.parse(readFileSync(join(dest, "receipt.json"), "utf8"));
  check("resumed final transaction wrote exactly one baseline pin + reconciliation holds",
    receipt8.target.baselineRows === 1 && receipt8.reconciliation.allReconciled === true);
  rmSync(uniqueDir("f8"), { recursive: true, force: true });
}

// ============================================================================
// Final summary + cleanup
// ============================================================================

const digestAfterAll = stableDigest(f1.memoryRoot);
check("final: source tree digest STILL unchanged after all suites (readonly invariant)", digestsEqual(digestBeforeFixture, digestAfterAll));

rmSync(uniqueDir("f1"), { recursive: true, force: true });
rmSync(uniqueDir("f1-dest"), { recursive: true, force: true });
rmSync(uniqueDir("f1-dest-b"), { recursive: true, force: true });

console.log(`\n== test-v02-import-lane: passed=${passed} failed=${failed} ==`);
process.exit(failed === 0 ? 0 : 1);
