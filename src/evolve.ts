/**
 * Self-evolution module (M4):
 * 1) Forgetting decay: importance × recency × access scoring; memories below the threshold are marked decayed; expired forgotten memories are purged;
 * 2) Skill synthesis: distills high-value memories (instructions/events) into reusable SOP skills, written to the dsh-skill filesystem repository
 *    ($DSH_HOME/skills/<name>/SKILL.md, YAML frontmatter; the dsh-skill-filesystem watcher auto-loads them).
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { MemoryStore } from "./storage.js";
import { tokenize as tokenizeImported } from "./storage.js";

export interface DecaySettings {
  enabled: boolean;
  /** Minimum age in days before a memory can be decayed */
  minAgeDays: number;
  /** Score threshold; below it a memory is marked decayed */
  threshold: number;
  /** Days after which forgotten memories are physically deleted (0 = never) */
  retentionDays: number;
  /** Cap on total active memories (0 = unlimited); over the cap, the lowest-scoring memories are demoted automatically */
  maxActiveMemories: number;
}

export interface SkillSynthesisSettings {
  enabled: boolean;
  /** Minimum importance for a memory to participate in synthesis */
  minImportance: number;
  /** Skills root directory; empty = $DSH_HOME/skills */
  skillsRoot: string;
  /** Name prefix for synthesized skills (marks the source, avoids clashing with system skills); empty = no prefix */
  prefix: string;
  /** Cap on the total number of synthesized skills (0 = unlimited); synthesis stops once reached */
  maxSkills: number;
}

export interface EvolveCallLlm {
  (input: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export const SKILL_SYSTEM_PROMPT = `You are a skill distiller. Based on memories accumulated from user-AI collaboration, distill one reusable standard operating procedure (SOP) skill.
Output a Markdown file in exactly the following format:
---
name: skill name (lowercase kebab-case, e.g. bump-pnpm-deps)
description: one-sentence summary (max ~30 words)
whenToUse: when to use this skill
---
Skill body: trigger conditions, operation steps (1. 2. 3.), caveats, and counterexamples.
Output only this Markdown, with no extra text.`;

/** Memory score: importance × recency × (1 + log(1+access)) */
export function memoryScore(record: {
  importance: number;
  accessCount: number;
  createdAt: number;
}, now: number): number {
  const ageDays = Math.max(0, (now - record.createdAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / 30); // 30-day half-life
  return record.importance * recency * (1 + Math.log1p(record.accessCount));
}

/** Applies forgetting decay and cleanup; returns decay/deletion counts */
export function applyDecay(store: MemoryStore, settings: DecaySettings, now = Date.now()): { decayed: number; deleted: number } {
  if (!settings.enabled) return { decayed: 0, deleted: 0 };
  const memories = store.getActiveMemories(10_000);
  let decayed = 0;
  const minAgeMs = settings.minAgeDays * 86_400_000;
  for (const m of memories) {
    if (now - m.createdAt < minAgeMs) continue;
    if (memoryScore(m, now) < settings.threshold) {
      if (store.setMemoryStatus(m.id, "decayed")) decayed++;
    }
  }
  let deleted = 0;
  if (settings.retentionDays > 0) {
    deleted = store.deleteForgottenOlderThan(now - settings.retentionDays * 86_400_000);
  }
  // Total cap: while over the cap, demote the lowest-scoring *injectable* active memories until back under it
  // (legacy/system-provenance rows are invisible to recall, so they must not crowd real memories out of the cap)
  if (settings.maxActiveMemories > 0) {
    const active = store.getActiveMemories(100_000, 0, true);
    const overflow = active.length - settings.maxActiveMemories;
    if (overflow > 0) {
      const sorted = [...active].sort((a, b) => memoryScore(a, now) - memoryScore(b, now));
      for (let i = 0; i < overflow; i++) {
        if (store.setMemoryStatus(sorted[i].id, "decayed")) decayed++;
      }
    }
  }
  return { decayed, deleted };
}

/**
 * Deletes a synthesized skill directory. Only names carrying the CONFIGURED prefix
 * (ownership marker of this plugin's own products) may be deleted; prevents path
 * traversal. The prefix comes from the synthesis config so a repo that retargets
 * the prefix also retargets its deletion boundary.
 */
export function deleteSkill(name: string, skillsRoot = "", prefix = "dsi-"): boolean {
  const trimmed = name.trim();
  const pfx = (prefix || "").trim();
  if (!pfx || !trimmed.startsWith(pfx)) return false;
  if (!new RegExp(`^${pfx.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[a-z0-9-]+$`).test(trimmed)) return false;
  const root = skillsRoot.trim() || defaultSkillsDir();
  const dir = join(root, trimmed);
  if (!existsSync(join(dir, "SKILL.md"))) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Counts synthesized skills (directories carrying the prefix). When the prefix is
 * empty the cap counts ALL skill directories, so maxSkills is enforced without a
 * prefix too (an unprefixed deployment can still hit its configured cap).
 */
export function countSynthesizedSkills(prefix: string, skillsRoot = ""): number {
  const root = skillsRoot.trim() || defaultSkillsDir();
  const pfx = (prefix || "").trim();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && (!pfx || d.name.startsWith(pfx)))
      .length;
  } catch {
    return 0;
  }
}

/** Normalized token set for skill-content comparison (frontmatter stripped to focus on the body) */
function skillTokens(text: string): Set<string> {
  const body = text.replace(/^---\s*\n[\s\S]*?\n---\s*/m, "").trim();
  return new Set(tokenizeImported(body).split(/\s+/).filter(Boolean));
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = new Set([...a, ...b]).size;
  return union > 0 ? inter / union : 0;
}

/** Existing synthesized skills (name + tokenized content) in the skills root */
function existingSkills(root: string): Array<{ name: string; text: string }> {
  let dirs: string[] = [];
  try {
    dirs = readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out: Array<{ name: string; text: string }> = [];
  for (const name of dirs) {
    try {
      out.push({ name, text: readFileSync(join(root, name, "SKILL.md"), "utf8") });
    } catch {
      /* unreadable skills are skipped */
    }
  }
  return out;
}

/** Kills stale skill-debug artifacts (max 3 rotating files) */
function rotateSkillDebug(storeDir: string): void {
  try {
    const dir = join(storeDir, "skills-debug");
    const files = readdirSync(dir).filter((f) => f.startsWith("rejected-")).sort().reverse();
    for (const old of files.slice(3)) unlinkSync(join(dir, old));
  } catch { /* noop */ }
}

/**
 * Skill synthesis: one call generates one SOP and writes it to the dsh-skill repository; returns the number of skills written.
 * M7 gating: requires ≥5 active memories from one project/global cluster (no synthesis off thin evidence) and
 * skips content-duplicate output (same-theme re-synthesis no longer spawns near-duplicate
 * directories with identical frontmatter names).
 */
export async function synthesizeSkills(
  store: MemoryStore,
  callLlm: EvolveCallLlm,
  settings: SkillSynthesisSettings,
  skillsRoot: string,
): Promise<number> {
  if (!settings.enabled) return 0;
  // Gate: synthesis needs a coherent evidence cluster, not unrelated global facts.
  const candidates = store.getActiveMemories(200, settings.minImportance, true);
  const groups = new Map<string, typeof candidates>();
  for (const memory of candidates) {
    const key = memory.meta?.scope === "project" ? memory.meta.projectId ?? "project:unknown" : "global";
    const group = groups.get(key) ?? [];
    group.push(memory);
    groups.set(key, group);
  }
  const candidateMemories = [...groups.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  if (candidateMemories.length < 5) return 0;
  // Skill cap: skip when the synthesized dsi-* skills have reached the limit
  const prefix = (settings.prefix ?? "").trim();
  const root = skillsRoot.trim() || defaultSkillsDir();
  if (settings.maxSkills > 0) {
    if (countSynthesizedSkills(prefix, root) >= settings.maxSkills) {
      console.warn(`[dsh-self-improved] skill synthesis skipped: reached maxSkills=${settings.maxSkills}`);
      return 0;
    }
  }
  const memories = candidateMemories;
  mkdirSync(root, { recursive: true });
  const input = memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  const signal = AbortSignal.timeout(180_000);
  const text = (await callLlm({ system: SKILL_SYSTEM_PROMPT, user: input, signal })).trim();
  const parsed = parseSkillMarkdown(text);
  if (!parsed) {
    // Write the failure reason to disk for debugging (rotating, max 3 files, so it cannot accumulate)
    try {
      mkdirSync(join(store.dir, "skills-debug"), { recursive: true });
      writeFileSync(join(store.dir, "skills-debug", `rejected-${Date.now()}.txt`), text, { encoding: "utf8" });
    } catch { /* noop */ }
    rotateSkillDebug(store.dir);
    console.warn("[dsh-self-improved] skill synthesis rejected model output (see skills-debug):", text.slice(0, 120));
    return 0;
  }
  // Content dedupe: compare body tokens against every existing skill; same-theme re-synthesis must not write.
  const newTokens = skillTokens(text);
  for (const existing of existingSkills(root)) {
    if (overlap(newTokens, skillTokens(existing.text)) >= 0.8) {
      console.warn(`[dsh-self-improved] skill synthesis skipped: duplicate of existing skill ${existing.name}`);
      return 0;
    }
  }
  // Prefix the name (marks the source / avoids clashing with system skills) and rewrite the frontmatter name to match
  const baseName = prefix && !parsed.name.startsWith(prefix) ? `${prefix}${parsed.name}` : parsed.name;
  let finalText = text;
  if (baseName !== parsed.name) {
    finalText = text.replace(/^(name:\s*).*$/m, `name: ${baseName}`);
  }
  // Duplicate output with an unchanged frontmatter name: never suffix-duplicate unchanged content.
  // If the existing skill differs meaningfully, a -N suffixed variant is allowed; otherwise skip.
  let finalName = baseName;
  let dir = join(root, finalName);
  let suffix = 2;
  while (existsSync(join(dir, "SKILL.md")) && suffix < 20) {
    const currentText = readFileSyncSafe(join(dir, "SKILL.md"));
    if (currentText && overlap(newTokens, skillTokens(currentText)) >= 0.8) {
      console.warn(`[dsh-self-improved] skill synthesis skipped: ${baseName} already carries this content`);
      return 0;
    }
    finalName = `${baseName}-${suffix}`;
    dir = join(root, finalName);
    suffix += 1;
  }
  if (finalName !== baseName) {
    finalText = finalText.replace(/^(name:\s*).*$/m, `name: ${finalName}`);
  }
  const file = join(dir, "SKILL.md");
  if (existsSync(file)) return 0; // all 20 suffixes collided, give up
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, finalText.endsWith("\n") ? finalText : finalText + "\n", { encoding: "utf8" });
  return 1;
}

function readFileSyncSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function defaultSkillsDir(): string {
  return join(resolveDshHome(undefined, process.env), "skills");
}

/**
 * Parses skill Markdown. ONLY a valid frontmatter block carrying both a kebab-case
 * name and a description is accepted — a heading-only fallback was removed because
 * it produced skills whose frontmatter lied about (or lacked) their name/description,
 * which dsh-skill would register with the wrong metadata.
 */
function parseSkillMarkdown(text: string): { name: string } | null {
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const name = fm.match(/^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)/m)?.[1];
  const description = fm.match(/^description:\s*(.+)/m)?.[1];
  if (name && description) return { name };
  return null;
}
