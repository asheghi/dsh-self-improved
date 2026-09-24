#!/usr/bin/env node
/**
 * Generated-skill pollution auditor for dsh-self-improved (`dsi-` prefix skills).
 *
 * Scans a SUPPLIED skills root (never a default — you must pass --root) and reports:
 *   - exact-name duplicates: ≥2 generated skill directories whose frontmatter
 *     `name:` is identical (the synthesis loop can leave suffixed dirs, e.g.
 *     dsi-foo and dsi-foo-2 both carrying `name: dsi-foo`);
 *   - high body-overlap duplicates: ≥2 generated skills whose body tokens
 *     jaccard over the --overlap threshold (default 0.8, mirroring the
 *     synthesis-time content dedupe);
 *   - frontmatter name mismatches on retained skills (a suffixed directory
 *     whose frontmatter still says the unsuffixed name).
 *
 * Safety model:
 *   - Default invocation is a READ-ONLY dry run. Writing requires an explicit
 *     `--apply` flag.
 *   - Apply NEVER deletes anything: redundant skills are MOVED into a
 *     timestamped archive directory under the supplied skills root
 *     (<root>/.dsi-archive/<timestamp>/…), preserving content for manual
 *     review/restore.
 *   - Only directories whose name starts with the generated prefix AND that
 *     contain a SKILL.md are classified. Unrelated non-dsi / system skills are
 *     never touched or reported.
 *   - Every filesystem operation is containment-checked against the supplied
 *     root; symlinked skill directories are refused (excluded with a warning,
 *     never followed).
 *   - Idempotent: a second --apply run on the same root finds no duplicates and
 *     makes no changes (the archive dir is dot-prefixed and never classified).
 *
 * Usage:
 *   node scripts/audit-generated-skills.mjs --root ~/.dsh/skills            # dry run (default)
 *   node scripts/audit-generated-skills.mjs --root ~/.dsh/skills --apply    # archive redundant skills
 *   node scripts/audit-generated-skills.mjs --root <root> --overlap 0.9
 *
 * Output: a JSON report on stdout. With --apply the same report is also saved
 * inside the archive directory as report.json.
 *
 * Dry-run first; only apply to a root you have backed up. Fixture-tested by
 * scripts/test-audit-skills.mjs on synthetic roots — never run --apply against
 * live ~/.dsh data.
 */
import {
  existsSync, readdirSync, readFileSync, statSync, lstatSync, mkdirSync,
  renameSync, copyFileSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";

function parseArgs(argv) {
  const args = { root: "", prefix: "dsi-", overlap: 0.8, apply: false, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--root") args.root = argv[++i] ?? "";
    else if (a === "--prefix") args.prefix = argv[++i] ?? "dsi-";
    else if (a === "--overlap") args.overlap = Number(argv[++i]) || 0.8;
  }
  return args;
}

const USAGE = "usage: node scripts/audit-generated-skills.mjs --root <skillsRoot> [--apply] [--dry-run] [--prefix dsi-] [--overlap 0.8]";

// ── analysis helpers (standalone; no lib/ imports so the script stays safe standalone) ──

function parseSkillName(text) {
  // Mirror the evolver rules: only a kebab-case name inside a valid frontmatter counts.
  if (!/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/.test(text)) return null;
  const name = text.match(/^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)[ \t]*$/m)?.[1];
  return name ?? null;
}

function bodyTokens(text) {
  // Strip frontmatter and compare on the body only: frontmatter name lines
  // would inflate similarity between differently-named near-identical skills.
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "");
  const tokens = body.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  return new Set(tokens);
}

function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0;
}

/** Containment check: every path we touch must stay inside the supplied root. */
function assertInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (isAbsolute(rel) || rel === "" || rel.startsWith("..")) {
    throw new Error(`refusing path outside the supplied skills root: ${resolve(target)}`);
  }
}

function isSymlink(p) {
  try { lstatSync(p); return lstatSync(p).isSymbolicLink(); } catch { return true; }
}

// ── core audit ──

export async function runAudit(rootIn, { prefix = "dsi-", overlap = 0.8, apply = false } = {}) {
  const report = {
    root: resolve(String(rootIn ?? "").trim()),
    prefix,
    apply: Boolean(apply),
    mode: apply ? "apply" : "dry-run",
    generatedSkills: 0,
    refusedEntries: [],
    duplicateGroups: [],
    pendingRenames: [],
    archived: [],
    archiveDir: "",
    guard: "nothing is deleted; redundant skills are moved into .dsi-archive/<timestamp>",
    updatedAt: "",
  };
  if (!rootIn || !String(rootIn).trim()) return { error: USAGE };
  const root = report.root;
  const st = existsSync(root) ? statSync(root, { throwIfNoEntry: false }) : null;
  if (!st || !st.isDirectory()) return { error: `root is not a directory: ${root}` };

  // Collect generated-skill dirs only. Anything that does not start with the
  // prefix (system skills, user skills, non-skill files) is unclassified.
  let entries;
  try { entries = readdirSync(root, { encoding: "utf8" }); } catch (e) { return { error: String(e.message || e) }; }
  const skills = [];
  for (const name of entries) {
    if (!name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
    if (name.startsWith(".")) continue; // the archive dir itself stays invisible → idempotent apply
    const entryPath = join(root, name);
    // Containment guard: a pathological name must never escape the root.
    const rel = relative(root, resolve(entryPath));
    if (isAbsolute(rel) || rel === "" || rel.startsWith("..")) { report.refusedEntries.push(name); continue; }
    if (isSymlink(entryPath)) { report.refusedEntries.push(name + " (symlink refused)"); continue; }
    let st2;
    try { st2 = statSync(entryPath, { throwIfNoEntry: false }); } catch { st2 = null; }
    if (!st2 || !st2.isDirectory()) continue; // stray files are ignored
    let text;
    try { text = readFileSync(join(entryPath, "SKILL.md"), "utf8"); } catch { continue; } // SKILL.md required
    skills.push({ dir: name, path: entryPath, text, frontName: parseSkillName(text), tokens: bodyTokens(text) });
  }
  report.generatedSkills = skills.length;

  // ── duplicate grouping (union-find over name-equality + overlap edges) ──
  const parent = skills.map((_, i) => i);
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[rb] = ra; };
  const overlaps = [];
  for (let i = 0; i < skills.length; i += 1) {
    for (let j = i + 1; j < skills.length; j += 1) {
      const a = skills[i], b = skills[j];
      if (!a.frontName || !b.frontName) continue;
      if (a.frontName === b.frontName) union(i, j);
      else {
        const sim = jaccard(a.tokens, b.tokens);
        if (sim >= overlap) { union(i, j); overlaps.push({ a: a.dir, b: b.dir, similarity: Number(sim.toFixed(4)) }); }
      }
    }
  }

  const groups = new Map();
  for (let i = 0; i < skills.length; i += 1) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(skills[i]);
  }

  // ── per-group decision: canonical keeper vs redundant copies ──
  const moves = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    // Keeper: (1) dir name === frontmatter name, then (2) simplest dir name.
    const ordered = [...group].sort((a, b) => {
      const am = a.dir === a.frontName ? 0 : 1, bm = b.dir === b.frontName ? 0 : 1;
      if (am !== bm) return am - bm;
      return a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0;
    });
    report.duplicateGroups.push({
      frontName: ordered[0].frontName,
      keep: ordered[0].dir,
      archive: ordered.slice(1).map((s) => s.dir),
      overlapEdges: overlaps.filter((o) => ordered.some((s) => s.dir === o.a || s.dir === o.b)),
    });
    for (const s of ordered.slice(1)) moves.push(s);
  }
  const kept = skills.filter((s) => !moves.some((mv) => mv.dir === s.dir));
  // Retained skills whose frontmatter name disagrees with their directory are
  // renamed in place on --apply (reported as pending in dry-run). Non-destructive.
  for (const s of kept) {
    if (s.frontName && s.dir !== s.frontName) {
      report.pendingRenames.push({ dir: s.dir, from: s.frontName, to: s.dir, applied: false });
    }
  }

  if (apply) {
    for (const r of report.pendingRenames) {
      const skill = kept.find((s) => s.dir === r.dir);
      if (!skill) continue;
      assertInside(root, skill.path);
      const next = skill.text.replace(
        new RegExp("(^|\\n)name:[ \\t]*" + r.from + "[ \\t]*($|\\n)"),
        `$1name: ${r.to}$2`,
      );
      if (next !== skill.text) {
        writeFileSync(join(skill.path, "SKILL.md"), next);
        r.applied = true;
      }
    }
    if (moves.length > 0) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const archiveRoot = join(root, ".dsi-archive");
      const archiveDir = join(archiveRoot, stamp);
      assertInside(root, archiveRoot);
      assertInside(root, archiveDir);
      mkdirSync(archiveDir, { recursive: true });
      for (const s of moves) {
        const dest = join(archiveDir, s.dir);
        assertInside(root, s.path);
        assertInside(root, dest);
        moveToArchive(s.path, dest);
        report.archived.push({ dir: s.dir, to: dest });
      }
      report.archiveDir = archiveDir;
      // A copy of the report travels with the archive so it stays auditable/reversible.
      try { writeFileSync(join(archiveDir, "report.json"), JSON.stringify(report, null, 2)); } catch { /* noop */ }
      assertInside(root, join(archiveDir, "report.json"));
    }
  }
  if (apply || moves.length === 0) report.updatedAt = new Date().toISOString();
  return report;
}

/** Move (never delete): rename into the archive; fall back to copy+remove on cross-device. */
function moveToArchive(src, dest) {
  try { renameSync(src, dest); }
  catch (e) {
    if (e && e.code === "EXDEV") {
      mkdirSync(dest, { recursive: true });
      for (const f of readdirSync(src)) copyFileSync(join(src, f), join(dest, f));
      rmSync(src, { recursive: true, force: true });
    } else throw e;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.dryRun && args.apply) {
    console.error(JSON.stringify({ error: "--dry-run and --apply are mutually exclusive" }));
    process.exit(1);
  }
  if (!args.apply) args.dryRun = true; // default invocation is read-only
  if (!args.root) {
    console.error(JSON.stringify({ error: USAGE }));
    process.exit(1);
  }
  const report = await runAudit(args.root, { prefix: args.prefix, overlap: args.overlap, apply: args.apply });
  const out = JSON.stringify(report, null, 2);
  if (report.error) { console.error(out); process.exit(1); }
  console.log(out);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) await main();
