#!/usr/bin/env node
/**
 * CLI for the Phase A migration increment (MIGRATION-V0.2.md steps 1 and 3).
 *
 *   node scripts/migrate-v02.mjs inventory --source <storeDir> [--settings <file>] [--skills-root <dir>] [--report <file>] [--json]
 *   node scripts/migrate-v02.mjs dry-run   --source <storeDir> [--dest <dir>]   [--settings <file>] [--skills-root <dir>] [--report <file>] [--json]
 *
 * Safety:
 * - `--source` is mandatory and must point at an explicit store directory; the
 *   tool never defaults to the live DSH home and never reads production data
 *   without the operator naming the path explicitly.
 * - Source and destination overlap (equal, nested, or joined through a symlink
 *   component) is refused before anything is read.
 * - `--report` is validated BEFORE the engine is compiled and BEFORE anything
 *   reads the source: the report destination must not collide with, or be
 *   written through, any input (source store, destination candidate, settings
 *   file, skills root), must not go through a symlink component, and must not
 *   name an existing path at all. The report file is created exclusively
 *   (`open("wx")`); a previous report is never overwritten — the operator
 *   removes it explicitly. A failed write leaves no partial report behind.
 * - The dry-run performs no import and writes nothing except the operator's
 *   explicit `--report` file / stdout. The real import writer is Phase B and
 *   does not exist.
 * - The TypeScript engine in src/migration-v02.ts is compiled into a uniquely
 *   owned temporary tree; cleanup removes only that tree and only while its
 *   ownership marker still names this process creation.
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
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const args = { command: "", source: "", dest: undefined, settings: undefined, skillsRoot: undefined, report: "", json: false };
  const value = (flag) => {
    const v = argv[++i];
    if (v == null || v.startsWith("--")) {
      console.error(`migrate-v02: option ${flag} requires an explicit value`);
      process.exit(2);
    }
    return v;
  };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "inventory" || a === "dry-run") args.command = a;
    else if (a === "--source") args.source = value(a);
    else if (a === "--dest") args.dest = value(a);
    else if (a === "--settings") args.settings = value(a);
    else if (a === "--skills-root") args.skillsRoot = value(a);
    else if (a === "--report") args.report = value(a);
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") args.command = "help";
    else {
      console.error(`migrate-v02: unknown argument ${a}`);
      process.exit(2);
    }
    i++;
  }
  return args;
}

// ---------------- report destination validation (runs before compilation/source reads) ----------------

function isInsidePath(child, parent) {
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Report-path safety, evaluated before ANY other tool work (no compilation,
 * no source read, no input IO has happened yet when this runs):
 *
 * 1. Structural walk of every path component with lstat: an existing symlink
 *    component anywhere means writes could be redirected at a protected file —
 *    refused. Every existing parent must be a real directory. The final
 *    component must not exist at all (existing file, symlink or directory): the
 *    tool exclusively creates report files and never replaces anything.
 * 2. Containment: the resolved report target must not be equal to or inside any
 *    named role — the source store tree (contains memory.db, conversations/,
 *    persona/, vectors.db), the `--dest` candidate, the `--settings` file and
 *    the `--skills-root` tree. Reports never enter an input by any path,
 *    direct or nested. Checks are lexical over already-symlink-free paths, so
 *    containment cannot be escaped by redirecting a component.
 *
 * Throws with a specific operator-facing message; main() maps it to exit 2.
 */
function validateReportDestination(reportPath, inputs) {
  if (!reportPath) return;
  const target = resolve(reportPath);
  const refuse = (why) => {
    throw new Error(`migrate-v02: refusing report destination ${target}: ${why}`);
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
      continue; // not-yet-created components are the normal fresh-report case
    }
    if (isLast) {
      refuse("that path already exists and is never replaced (reports are exclusive-created; remove it explicitly first)");
    }
    if (st.isSymbolicLink()) {
      refuse(`path component ${acc} is a symlink, so the write could land on someone else's file`);
    }
    if (!st.isDirectory()) {
      refuse(`parent component ${acc} is not a directory`);
    }
  }

  const protectedRoots = [
    ["source store", resolve(inputs.source)],
    inputs.settings ? ["settings input", resolve(inputs.settings)] : null,
    inputs.skillsRoot ? ["skills root", resolve(inputs.skillsRoot)] : null,
    inputs.dest ? ["destination candidate", resolve(inputs.dest)] : null,
  ].filter(Boolean);
  for (const [role, rootPath] of protectedRoots) {
    if (target === rootPath || isInsidePath(target, rootPath)) {
      refuse(`it names the ${role} or a path inside it (${rootPath}); report files never land on any input`);
    }
  }
}

/**
 * Exclusive-create report write: `wx` is the authoritative final guard against
 * creation races, writes go through an owned fd so a mid-write failure can be
 * cleaned up (the partially created file is removed, the operator's previous
 * content was never touched because nothing existed), and the report is
 * flushed before success.
 */
function writeReportFile(reportPath, content) {
  const target = resolve(reportPath);
  mkdirSync(dirname(target), { recursive: true });
  let fd;
  try {
    fd = openSync(target, "wx");
  } catch (e) {
    const code = e && e.code ? ` (${e.code})` : "";
    throw new Error(`migrate-v02: exclusive report open failed${code} for ${target}: ${e instanceof Error ? e.message : String(e)}`);
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

/** Unique guarded compile tree: removed only if the ownership marker still matches. */
function compileEngineModule() {
  const tree = mkdtempSync(join(tmpdir(), "dsi-migrate-v02-build-"));
  const ownerTag = `migrate-v02:${process.pid}`;
  const marker = resolve(tree, "OWNER.dsh-migrate-v02");
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
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      resolve(repo, "src", "migration-v02.ts"),
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
  if (result.status !== 0) {
    throw new Error(`migrate-v02: isolated compilation failed:\n${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  }
  return pathToFileURL(resolve(outDir, "migration-v02.js")).href;
}

function usage() {
  console.log(`Usage:
  node scripts/migrate-v02.mjs inventory --source <storeDir> [options]
  node scripts/migrate-v02.mjs dry-run   --source <storeDir> [--dest <dir>] [options]

Options:
  --settings <file>    legacy settings patch file (YAML or JSON) containing the self-improved entry
  --skills-root <dir>  legacy skills filesystem root (dsi-* generated skills)
  --report <file>      fresh path; the full report JSON is written there with
                       exclusive creation (an existing path is refused, never
                       overwritten; the path may not touch any input or go
                       through a symlink)
  --json               print the full report JSON to stdout

The source directory is never modified; the dry-run never imports and never writes
the destination. Reading production data requires explicitly passing its path.`);
  return 0;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "" || args.command === "help") return usage();
  if (!args.source) {
    console.error("migrate-v02: refusing to run without an explicit --source directory (no production defaults)");
    return 2;
  }
  if (args.report && args.report.trim() === "") {
    console.error("migrate-v02: --report requires a destination path");
    return 2;
  }
  // Report destination validation runs BEFORE compilation and BEFORE any source
  // read: a hostile report path must never get far enough to touch an input.
  try {
    validateReportDestination(args.report, {
      source: args.source,
      settings: args.settings,
      skillsRoot: args.skillsRoot,
      dest: args.dest,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  let engine;
  try {
    engine = await import(compileEngineModule());
  } catch (error) {
    console.error(`migrate-v02: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const mode = args.command === "dry-run" ? "dry-run" : "inventory";
  let report;
  try {
    report = engine.buildMigrationReport(
      {
        sourceRoot: args.source,
        destinationRoot: args.dest,
        settingsPath: args.settings,
        skillsRoot: args.skillsRoot,
      },
      mode,
    );
  } catch (error) {
    console.error(`migrate-v02: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const json = JSON.stringify(report, null, 2);
  if (args.report) {
    try {
      writeReportFile(args.report, `${json}\n`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      return 2;
    }
  }
  if (args.json) console.log(json);
  else {
    console.log(`mode=${report.mode} supported=${report.supported} source=${report.source.storeRoot}`);
    console.log(`memories total=${report.counts.memories.total} missingMeta=${report.counts.memories.missingMeta}`);
    console.log(`byStatus: ${JSON.stringify(report.counts.memories.byStatus)}`);
    console.log(`byProvenance: ${JSON.stringify(report.counts.memories.byProvenance)}`);
    console.log(
      `lanes: personal=${report.counts.projection?.personalLaneEligible ?? 0} review=${report.counts.projection?.reviewRequired ?? 0} quarantine=${report.counts.projection?.quarantinedProposed ?? 0} handoff=${report.counts.projection?.taskHandoffCandidates ?? 0} personaInactive=${report.counts.projection?.personaInactive ?? 0}`,
    );
    console.log(`conversations files=${report.counts.conversations.fileCount} valid=${report.counts.conversations.validLines} malformed=${report.counts.conversations.malformedLines} duplicates=${report.counts.conversations.duplicateSessionSeqLines}`);
    console.log(`episodes statuses=${JSON.stringify(report.counts.episodes.byStatus)} steps=${report.counts.episodes.steps} unpaired=${report.counts.episodes.unpairedSteps}`);
    console.log(`persona versions=${report.counts.persona.versions} skills generated=${report.counts.skills.generatedPrefixedDirs} (inactive)`);
    console.log(`settings found=${report.settings?.found ? "yes" : "no"} leaves=${report.settings?.leaves ?? 0} mapped=${report.settings?.mapped.length ?? 0} secrets=${report.settings?.secrets.length ?? 0} unmapped=${report.settings?.unmapped.length ?? 0} retired=${report.settings?.retired.length ?? 0}`);
    console.log(`safety: sourceUnchanged=${report.safety.sourceUnchanged} sourceSchemaUnchanged=${report.safety.sourceSchemaUnchanged} destinationTouched=${report.safety.destinationTouched}`);
    if (!report.supported) for (const r of report.unsupportedReason) console.log(`unsupported: ${r}`);
  }
  return report.supported ? 0 : 3;
}

process.exitCode = await main();
