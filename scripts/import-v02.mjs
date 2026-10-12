#!/usr/bin/env node
/**
 * CLI for the Phase B import lane (MIGRATION-V0.2.md § "Actual migration of
 * existing data" steps 2 and 4 — reviewed digest-bound dry-run plan + approved
 * apply onto an OWNER-marked isolated synthetic target).
 *
 *   node scripts/import-v02.mjs plan   --source <storeDir> --dest <isolationDir> [--settings <file>] [--skills-root <dir>] [--report <file>] [--json]
 *   node scripts/import-v02.mjs import --dest <isolationDir> --approve <token> [--resume] [--report <file>] [--json]
 *
 * This lane does NOT replace the Phase A readonly inventory CLI
 * (`scripts/migrate-v02.mjs`, untouched and still compatible); it is the
 * separate, explicitly reviewed import writer of MIGRATION-PHASE-B-IMPORT-DESIGN
 * §3–§12 layered on the storage import seam
 * (MIGRATION-PHASE-B-IMPORT-SEAM.md).
 *
 * Safety (same discipline as the Phase A CLI, extended to every lane doc):
 * - `--dest` is mandatory and must be an operator-named FRESH isolation
 *   directory; the tool never defaults anywhere near a live production root,
 *   an active profile, or the plugin's own profileRoot.
 * - Every output path (operator --report, plan.json, ledger.json,
 *   receipt.json) is validated BEFORE the engine is compiled and BEFORE any
 *   source read: never on any input (source store, dest, settings, skills
 *   root), never through a symlink component, never an existing path — all
 *   outputs are exclusive-created (`wx`) + fsynced and never overwritten.
 * - `plan` reads the source strictly read-only (node:sqlite readOnly +
 *   transactionally consistent VACUUM INTO snapshot) and writes only the
 *   destination's owner marker + plan.json.
 * - `import` refuses with exit 2 and zero writes on a missing/stale/mismatched
 *   approval token, a missing/malformed/foreign wx approval record, a plan
 *   body that differs from the freshly re-derived canonical plan, a
 *   transplanted destination, a foreign plan digest, a missing/foreign owner
 *   marker, a source digest delta, or pre-existing unowned target rows. A
 *   mid-apply source change refuses completion and denies the receipt. Rollback means
 *   deleting the operator's OWN isolation destination — never an unverified
 *   path move or delete, never a process kill.
 * - Exit codes: 0 success; 2 refusal/usage/approval; 3 unsupported source or
 *   reconciliation failure (no or no-final artifacts, honest report).
 * - stdout/report JSON carry ids, counts, contract vocabulary and opaque
 *   digests only — never source content (secret canaries across every lane are
 *   asserted by scripts/test-v02-import-lane.mjs).
 * - The TypeScript engine compiles strict into a uniquely owned temp tree
 *   first (type gate), then into repo lib/ for import. No runtime patching,
 *   no dependency installs, no network, no profile writes, no skill activation.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXIT_OK = 0;
const EXIT_REFUSAL = 2;
const EXIT_UNSUPPORTED = 3;

function parseArgs(argv) {
  const args = {
    command: "",
    source: undefined,
    dest: undefined,
    settings: undefined,
    skillsRoot: undefined,
    report: undefined,
    approve: undefined,
    resume: false,
    json: false,
  };
  let i = 0;
  const value = (flag) => {
    const v = argv[++i];
    if (v == null || v.startsWith("--")) {
      console.error(`import-v02: option ${flag} requires an explicit value`);
      process.exit(EXIT_REFUSAL);
    }
    return v;
  };
  while (i < argv.length) {
    const a = argv[i];
    if (a === "plan" || a === "import") args.command = a;
    else if (a === "--source") args.source = value(a);
    else if (a === "--dest") args.dest = value(a);
    else if (a === "--settings") args.settings = value(a);
    else if (a === "--skills-root") args.skillsRoot = value(a);
    else if (a === "--report") args.report = value(a);
    else if (a === "--approve") args.approve = value(a);
    else if (a === "--resume") args.resume = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.command = "help";
    else {
      console.error(`import-v02: unknown argument ${a}`);
      process.exit(EXIT_REFUSAL);
    }
    i++;
  }
  return args;
}

// ---------------- lane-doc destination validation (before compile / IO) ----------------

function isInsidePath(child, parent) {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Lane-doc path safety, evaluated before ANY other tool work: no compilation,
 * no source read, no destination IO has happened yet. Every existing component
 * must be a real directory (symlink components refused), the final component
 * must not exist (exclusive-create discipline), and the path must never name
 * or live inside ANY input role: the source store tree, the destination
 * isolation root, the settings file and the skills root.
 */
function validateDocDestination(docPath, inputs) {
  if (!docPath) return;
  const target = resolve(docPath);
  const refuse = (why) => {
    throw new Error(`import-v02: refusing doc destination ${target}: ${why}`);
  };
  const segments = target.split("/").filter(Boolean);
  let acc = "";
  for (let i = 0; i < segments.length; i++) {
    acc = `${acc}/${segments[i]}`;
    const isLast = i === segments.length - 1;
    let st;
    try {
      st = lstatSync(acc);
    } catch {
      continue; // not-yet-created components are the normal fresh-doc case
    }
    if (isLast) refuse("that path already exists and is never replaced (lane docs are exclusive-created; remove it explicitly first)");
    if (st.isSymbolicLink()) refuse(`path component ${acc} is a symlink, so the write could land on someone else's file`);
    if (!st.isDirectory()) refuse(`parent component ${acc} is not a directory`);
  }
  const protectedRoots = [
    ["source store", inputs.source ? resolve(inputs.source) : null],
    ["destination isolation root", inputs.dest ? resolve(inputs.dest) : null],
    ["settings input", inputs.settings ? resolve(inputs.settings) : null],
    ["skills root", inputs.skillsRoot ? resolve(inputs.skillsRoot) : null],
  ];
  for (const [role, rootPath] of protectedRoots) {
    if (!rootPath) continue;
    if (target === rootPath || isInsidePath(target, rootPath)) {
      refuse(`it names the ${role} or a path inside it (${rootPath}); lane docs never land on any input`);
    }
  }
}

/** Exclusive-create write of a lane doc through an owned fd, fsynced. */
function writeDocFile(docPath, content, label) {
  const target = resolve(docPath);
  mkdirSync(dirname(target), { recursive: true });
  let fd;
  try {
    fd = openSync(target, "wx");
  } catch (e) {
    const code = e && e.code ? ` (${e.code})` : "";
    throw new Error(`import-v02: exclusive ${label} open failed${code} for ${target}: ${e instanceof Error ? e.message : String(e)}`);
  }
  let completed = false;
  try {
    writeFileSync(fd, content, "utf8");
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
        unlinkSync(target); // our own partially created file only (wx proved nothing pre-existed)
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

/** Unique guarded compile tree: removed only while its ownership marker matches. */
function compileAndLoadEngine() {
  const tree = mkdtempSync(join(tmpdir(), "dsi-import-v02-build-"));
  const ownerTag = `import-v02:${process.pid}`;
  const marker = resolve(tree, "OWNER.dsh-import-v02");
  writeFileSync(marker, ownerTag, "utf8");
  process.on("exit", () => {
    try {
      if (!existsSync(marker) || readFileSync(marker, "utf8") !== ownerTag) return;
    } catch {
      return;
    }
    try {
      rmSync(tree, { recursive: true, force: true });
    } catch {
      /* leftover under os.tmpdir() is inert */
    }
  });
  const outDir = resolve(tree, "lib");
  const tsc = resolve(repo, "node_modules", "typescript", "bin", "tsc");
  const common = [
    resolve(repo, "src", "import-v02.ts"),
    "--target", "es2022",
    "--module", "nodenext",
    "--moduleResolution", "nodenext",
    "--strict", "--skipLibCheck", "--esModuleInterop",
    "--forceConsistentCasingInFileNames",
    "--types", "node",
    "--pretty", "false",
    "--declaration", "false",
  ];
  const typeGate = spawnSync(process.execPath, [tsc, ...common, "--noEmit"], { cwd: repo, encoding: "utf8" });
  if (typeGate.status !== 0) {
    throw new Error(`import-v02: isolated strict type gate failed:\n${typeGate.stdout ?? ""}\n${typeGate.stderr ?? ""}`);
  }
  // Emit the engine's build artifacts into the repo's own lib/ (exactly what
  // `npm run prepare` / --emit-lib does) so the storage module's own package
  // dependencies resolve. Nothing outside repo lib/ is written.
  const emitLib = spawnSync(process.execPath, [tsc, ...common, "--outDir", resolve(repo, "lib")], { cwd: repo, encoding: "utf8" });
  if (emitLib.status !== 0) {
    throw new Error(`import-v02: lib artifact refresh failed (type gate already proved clean):\n${emitLib.stdout ?? ""}\n${emitLib.stderr ?? ""}`);
  }
  return import(pathToFileURL(resolve(repo, "lib", "import-v02.js")).href);
}

function usage() {
  console.log(`Usage:
  node scripts/import-v02.mjs plan   --source <storeDir> --dest <isolationDir> [--settings <file>] [--skills-root <dir>] [--report <file>] [--json]
  node scripts/import-v02.mjs import --dest <isolationDir> --approve <token> [--resume] [--report <file>] [--json]

Two-phase Phase B import (digest-bound, honest):
  1. plan    reads the source strictly read-only and writes the destination
             owner marker + wx approval record + plan.json only (verdict rows
             per family, counts, digests; no content, no secrets, no skill
             bodies). It prints an approval token bound to sourceDigest +
             planDigest + destRoot; the wx approval record with the same
             binding is written at plan time (independent of plan.json).
             Honest bound: the record binds digests, not human intent — a
             writer with this tool's same OS privileges can rewrite the
             destination or re-run plan; the import stage additionally
             re-derives the canonical plan from the current read-only source
             and refuses any verdict mismatch.
  2. import  refuses (zero writes) without the exact approval token plus a
             plan body that exactly equals the freshly re-derived canonical
             plan (accepted/quarantined/unsupported rows + every
             reconciliation identity; a transplanted destination also
             refuses), then applies the plan: backup/ = restore-grade
             byte-faithful private copy; normalized/ = OWNER-marked synthetic
             v0.2 target built through the storage import seam with same-tx
             chunk ledger; ledger.json + receipt.json finish only when every
             family's accepted + retained-quarantined + unsupported-evidenced
             counts sum to the exact plan total.

The source directory is never modified. The destination is never a live store,
never mounted, never cutover-connected; cutover/rollback remain separate gated
work. Production/live profiles are never named by default.`);
  return EXIT_OK;
}

function summarizePlan(plan) {
  const families = plan.families;
  const m = families.memories;
  console.log(`plan=${plan.planDigest.slice(0, 12)} source=${plan.source.storeRoot}`);
  console.log(`  memories total=${m.total} accepted=${m.accepted.length} unsupported=${m.unsupported.length} plannedDemotions=${m.plannedDemotions.length} evidenceRefsUnverifiable=${m.evidenceRefsUnverifiable.length}`);
  console.log(`  baseline pins=${families.baseline.pins} pinTargets=${families.baseline.pinTargets.length} unsupported=${families.baseline.unsupported.length}`);
  console.log(`  episodes episodes=${families.episodes.episodes} steps=${families.episodes.steps} events=${families.episodes.events} (verbatim copy)`);
  console.log(`  sessionProjects=${families.sessionProjects.rows} persona retained=${plan.reconciliation.families.persona.retained} skills retained=${plan.reconciliation.families.generatedSkills.retained}`);
  console.log(`  conversations retainedValid=${plan.reconciliation.families.conversations.retained} unsupportedLines=${plan.reconciliation.families.conversations.unsupported} cursors=${families.cursors.counts.sessions} scenes=${families.scenes.counts.rows}`);
  console.log(`  vectors(${families.vectors.verdict})=${plan.reconciliation.families.vectors.unsupported} unknownSchemaObjects=${plan.reconciliation.families.unknownSchemaObjects.unsupported}`);
  if (plan.settings) {
    console.log(`  settings found=${plan.settings.found} leaves=${plan.settings.leaves} carry=${plan.settings.carry.length} presenceOnly=${plan.settings.presenceOnly.length} secrets=${plan.settings.secrets.length}`);
  }
  console.log(`  approval: pass the token below to \`import\` verbatim:`);
  console.log(`  --approve ${plan.approvalToken}`);
  console.log(`  node scripts/import-v02.mjs import --dest <dest> --approve ${plan.approvalToken}`);
  console.log(`  approval record: wx-written into the destination's owner marker (planDigest + source digests + canonical dest root; independent of plan.json — binds digests, not human intent; the apply re-derives the canonical plan)`);
  console.log(`  policy: persona/skills inactive; conversations NOT enqueued to the v0.2 journal; cursors never acked; no dedup/merge; lifecycle: never cutover here`);
  if (plan.settings?.note) console.log(`  settings note: ${plan.settings.note}`);
}

function summarizeResult(result) {
  console.log(`apply result planDigest=${result.planDigest.slice(0, 12)} approval=token-verified`);
  console.log(`  target=${result.target.normalizedRoot} quickCheckOk=${result.target.quickCheckOk} revision ${result.target.revisionBefore} -> ${result.target.revisionAfter}`);
  console.log(`  memories=${result.target.memoryRows} byStatus=${JSON.stringify(result.target.memoryByStatus)}`);
  console.log(`  episodes=${result.target.episodeRows.episodes} steps=${result.target.episodeRows.steps} events=${result.target.episodeRows.events} baseline=${result.target.baselineRows} sessionProjects=${result.target.sessionProjects}`);
  console.log(`  backup files=${result.backup.files} bytes=${result.backup.bytes} manifestVerified=${result.backup.manifestVerified}`);
  for (const [family, identity] of Object.entries(result.reconciliation.families)) {
    console.log(`  family ${family}: accepted=${identity.accepted} retained=${identity.retained} unsupported=${identity.unsupported} total=${identity.total}`);
  }
  console.log(`  safety: unchangedDuringApply=${result.source.unchangedDuringApply} same-tx-chunk-ledger=${result.safety.sameTxChunkProgressLedger} noAck=${result.safety.noAcknowledgementOfUnsupported}`);
  for (const limit of result.limits) console.log(`  limit: ${limit}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "" || args.command === "help") return usage();
  if (!args.dest) {
    console.error("import-v02: refusing to run without an explicit --dest isolation directory (no production defaults)");
    return EXIT_REFUSAL;
  }
  if (args.command === "plan" && !args.source) {
    console.error("import-v02: plan requires an explicit --source store directory (never a guessed/production path)");
    return EXIT_REFUSAL;
  }
  for (const [flag, v] of [["--source", args.source], ["--dest", args.dest], ["--skills-root", args.skillsRoot]]) {
    if (typeof v === "string" && v.trim() === "") {
      console.error(`import-v02: ${flag} requires a destination path`);
      return EXIT_REFUSAL;
    }
  }
  // doc-destination validation runs BEFORE compilation and BEFORE any IO
  try {
    validateDocDestination(args.report, {
      source: args.source,
      dest: args.dest,
      settings: args.settings,
      skillsRoot: args.skillsRoot,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT_REFUSAL;
  }
  let engine;
  try {
    engine = await compileAndLoadEngine();
  } catch (error) {
    console.error(`import-v02: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_REFUSAL;
  }

  if (args.command === "plan") {
    let plan;
    try {
      plan = engine.buildImportPlan({
        sourceRoot: args.source,
        destinationRoot: args.dest,
        settingsPath: args.settings,
        skillsRoot: args.skillsRoot,
      });
    } catch (error) {
      console.error(`import-v02: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_REFUSAL;
    }
    // Engine validates destination roles; the approval record (wx, bound to
    // planDigest + source digests + the canonical dest root, inside the owner
    // marker file) and plan.json are wx-gated and never overwritten:
    try {
      const dest = resolve(args.dest);
      mkdirSync(dest, { recursive: true });
      engine.writeOwnerMarkerApprovalRecord(dest, plan);
      writeDocFile(join(dest, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "plan");
    } catch (error) {
      console.error(`import-v02: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_REFUSAL;
    }
    const full = JSON.stringify(plan, null, 2);
    if (args.report) {
      try {
        writeDocFile(args.report, `${full}\n`, "report");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return EXIT_REFUSAL;
      }
    }
    if (args.json) console.log(full);
    else summarizePlan(plan);
    return EXIT_OK;
  }

  if (args.command === "import") {
    if (!args.approve) {
      console.error("import-v02: import requires --approve <token> (the exact token printed by `plan`); refusal otherwise");
      return EXIT_REFUSAL;
    }
    const dest = resolve(args.dest);
    const planPath = join(dest, "plan.json");
    let planDoc;
    try {
      planDoc = JSON.parse(readFileSync(planPath, "utf8"));
    } catch {
      console.error(`import-v02: cannot read a valid plan.json at ${planPath}; run \`plan\` first`);
      return EXIT_REFUSAL;
    }
    let outcome;
    try {
      outcome = engine.applyImportPlan(planDoc, {
        sourceRoot: args.source ?? String(planDoc?.source?.storeRoot ?? ""),
        destinationRoot: dest,
        settingsPath: args.settings,
        skillsRoot: args.skillsRoot,
        approvalToken: args.approve,
        resume: args.resume === true,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`import-v02: ${msg}`);
      return /reconciliation/.test(msg) ? EXIT_UNSUPPORTED : EXIT_REFUSAL;
    }
    if (args.report) {
      try {
        writeDocFile(args.report, `${JSON.stringify(outcome.result, null, 2)}\n`, "report");
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        return EXIT_REFUSAL;
      }
    }
    if (args.json) console.log(JSON.stringify(outcome.result, null, 2));
    else summarizeResult(outcome.result);
    return EXIT_OK;
  }

  return usage();
}

process.exitCode = await main();
