/**
 * Fixture tests for scripts/audit-generated-skills.mjs — synthetic skills roots
 * ONLY (never ~/.dsh). Verifies:
 *   - dry-run (default) makes no filesystem changes and classifies only
 *     dsi-prefixed skills (unrelated/system skills are never reported);
 *   - exact-name duplicates and high body-overlap duplicates are detected;
 *   - apply MOVES redundant skills into a timestamped archive under the root
 *     (never deletes) and is idempotent;
 *   - retained skills carry a frontmatter name matching their directory;
 *   - symlinked entries pointing outside the root are refused, never followed.
 * Run: node scripts/test-audit-skills.mjs
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { runAudit } from "./audit-generated-skills.mjs";

const root = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "audit-skills");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

function skill(dir, name, description, body) {
  mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
}

const BODY_A = [
  "1. Open the pnpm store config in the profile .npmrc",
  "2. Set store-dir to the directory shared with the host install",
  "3. Re-run the install so packages link from the shared store",
].join("\n");
const BODY_A2 = [
  "1. Open the pnpm store config in the profile .npmrc",
  "2. Set store-dir to the directory shared with the host install",
  "3. Re-run the install so packages link from the shared store here",
].join("\n");

const BODY_B = [
  "1. Run the dry-run migration command first to see the plan",
  "2. Compare the quarantine and duplicate counts in the report",
  "3. Apply only after the numbers look sane",
].join("\n");
const BODY_B2 = [
  "1. Run the dry-run migration command first to see the plan",
  "2. Compare the quarantine and duplicate counts in the report",
  "3. Apply only after the numbers look sane in the report",
].join("\n");
// Synthetic generated-skill pollution
skill("dsi-alpha", "dsi-alpha", "Fix pnpm store drift", BODY_A);
skill("dsi-alpha-2", "dsi-alpha", "Fix pnpm store drift (variant)", BODY_A2);      // exact-name duplicate
skill("dsi-beta", "dsi-beta", "Clear stale session cache", "Check the session id. Clear the stale cache entry. Retry the command.");
skill("dsi-beta-2", "dsi-beta", "Clear stale session cache", "Check the session id. Clear the stale cache entry. Retry the command again.");
// Retained suffixed skill with stale frontmatter name
skill("dsi-gamma-2", "dsi-gamma", "Gamma retained under suffix", "Gamma procedure: verify fixture, then report.");
// Different NAME but near-identical BODY → overlap-edge duplicate group
skill("dsi-delta", "dsi-delta", "Delta procedure", BODY_B);
skill("dsi-delta-two", "dsi-delta-two", "Delta procedure (mirror)", BODY_B2);
// Unrelated system skills — must never be classified
skill("obsidian", "obsidian", "Unrelated system skill", "Never classify me.");
skill("web-tester", "web-tester", "Unrelated system skill 2", "Never classify me either.");
// Non-skill noise
writeFileSync(join(root, "README.md"), "not a skill dir");

// Symlink escape fixture: a dsi-* symlink pointing OUTSIDE the root
const outside = join(root, "..", `audit-skills-outside-${Date.now()}`);
mkdirSync(idSafe(outside), { recursive: true });
writeFileSync(join(outside, "SKILL.md"), "---\nname: dsi-escape\ndescription: outside\n---\nbody");
symlinkSync(outside, join(root, "dsi-escape-link"), "dir");

function idSafe(p) { return p; }

const readSkill = (dir) => readFileSync(join(root, dir, "SKILL.md"), "utf8");

// ── 1) default dry-run: read-only, correct classification ──
const dry = await runAudit(root, {});
check("dry-run is default and apply=false in report", dry.mode === "dry-run" && dry.apply === false, JSON.stringify({ m: dry.mode }));
check("dry-run classifies only dsi skills", dry.generatedSkills === 7, String(dry.generatedSkills));
check("dry-run reports no filesystem writes", (dry.archived ?? []).length === 0 && !dry.archiveDir, JSON.stringify(dry.archived));
check("unrelated system skills are never classified", !JSON.stringify(dry).includes('"obsidian"') && !JSON.stringify(dry).includes("web-tester"), "reported payloads");
check("symlinked escape entry is refused", dry.refusedEntries.some((r) => r.includes("dsi-escape-link")), JSON.stringify(dry.refusedEntries));
check("dry-run detects exact-name group dsi-alpha", dry.duplicateGroups.some((g) => g.frontName === "dsi-alpha" && g.archive.includes("dsi-alpha-2")), JSON.stringify(dry.duplicateGroups));
check("dry-run detects exact-name group dsi-beta", dry.duplicateGroups.some((g) => g.frontName === "dsi-beta" && g.archive.includes("dsi-beta-2")), JSON.stringify(dry.duplicateGroups));
const alphaEdge = dry.duplicateGroups.find((g) => g.frontName === "dsi-delta")?.overlapEdges ?? [];
check("body-overlap edge is reported for a different-name near-duplicate", alphaEdge.some((o) => (o.a === "dsi-delta" && o.b === "dsi-delta-two") || (o.a === "dsi-delta-two" && o.b === "dsi-delta")), JSON.stringify(alphaEdge));
check("dry-run flags stale frontmatter on retained dsi-gamma-2", dry.pendingRenames.some((r) => r.dir === "dsi-gamma-2" && r.to === "dsi-gamma-2" && r.applied === false), JSON.stringify(dry.pendingRenames));

// Dry run must not have changed anything on disk
check("dry-run leaves all skill bodies intact", readSkill("dsi-gamma-2").includes("name: dsi-gamma"), readSkill("dsi-gamma-2"));
check("dry-run creates no archive dir", !existsSync(join(root, ".dsi-archive")), existsSync(join(root, ".dsi-archive")) ? "exists" : "");
check("dry-run leaves unrelated skills intact", readSkill("obsidian").includes("name: obsidian"));

// ── 2) apply: move into timestamped archive, never delete ──
const reportOut = await runAudit(root, { apply: true });
check("apply moves the redundant copies", (reportOut.archived ?? []).length === 3, JSON.stringify(reportOut.archived));
check("apply names the archive dir under the root", reportOut.archiveDir.startsWith(join(root, ".dsi-archive", "")) && existsSync(reportOut.archiveDir), reportOut.archiveDir);
check("archived copies still exist under the archive (move, not delete)",
  existsSync(join(reportOut.archiveDir, "dsi-alpha-2")) && existsSync(join(reportOut.archiveDir, "dsi-beta-2")) && existsSync(join(reportOut.archiveDir, "dsi-delta-two")),
  "archive contents");
check("applied report is stored with the archive", existsSync(join(reportOut.archiveDir, "report.json")), "report.json");
check("archive keeps its own audit copy readable", readFileSync(join(reportOut.archiveDir, "report.json"), "utf8").includes("dsi-delta-two"), "copy");

// Post-apply state
check("redundant dirs removed from the skills root",
  !existsSync(join(root, "dsi-alpha-2")) && !existsSync(join(root, "dsi-beta-2")),
  readdirSync(root).join(","));
check("keeper dsi-alpha still present", existsSync(join(root, "dsi-alpha")));
check("retained suffixed skill got its frontmatter name synced", readSkill("dsi-gamma-2").startsWith("---\nname: dsi-gamma-2"), readSkill("dsi-gamma-2"));
check("unrelated skills untouched after apply", readSkill("obsidian").includes("name: obsidian") && readSkill("web-tester").includes("name: web-tester"));
check("symlink never moved or followed", existsSync(join(root, "dsi-escape-link")) && existsSync(join(outside, "SKILL.md")), "symlink intact");

// ── 3) idempotency: a second apply run finds nothing and writes nothing ──
const second = await runAudit(root, { apply: true });
check("second apply reports no duplicate groups", second.duplicateGroups.length === 0, JSON.stringify(second.duplicateGroups));
check("second apply archives nothing", second.archived.length === 0 && !second.archiveDir, JSON.stringify(second.archived));
const archives = readdirSync(join(root, ".dsi-archive")).filter((d) => d !== "report.json");
check("no extra archive dirs created", archives.length === 1, archives.join(","));

// ── 4) refusal of paths outside the supplied root ──
const bad = await runAudit(join(root, "..", "..", "nonexistent-root"));
check("missing/explicit-bad root returns an error, not silent success", Boolean(bad.error), JSON.stringify(bad).slice(0, 120));

// ── 5) CLI safety: no --root on the CLI exits non-zero with usage ──
const { spawnSync } = await import("node:child_process");
const cli = spawnSync(process.execPath, ["scripts/audit-generated-skills.mjs"], { encoding: "utf8" });
check("CLI without --root fails with usage message", cli.status !== 0 && String(cli.stderr).includes("usage:"), cli.stderr.slice(0, 120));

const cliDry = spawnSync(process.execPath, ["scripts/audit-generated-skills.mjs", "--root", root], { encoding: "utf8" });
check("CLI default invocation is a dry-run (no apply flag needed)", cliDry.status === 0 && JSON.parse(cliDry.stdout).mode === "dry-run", cliDry.stdout.slice(0, 80));
const cliDryAfter = await runAudit(root, {});
check("CLI default invocation made no changes", cliDryAfter.duplicateGroups.length === 0 && cliDryAfter.pendingRenames.length === 0, "already clean");

// cleanup the outside fixture root too
rmSync(outside, { recursive: true, force: true });

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
