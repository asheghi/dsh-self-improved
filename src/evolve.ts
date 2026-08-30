/**
 * Self-evolution module (M4):
 * 1) Forgetting decay: importance × recency × access scoring; memories below the threshold are marked decayed; expired forgotten memories are purged;
 * 2) Skill synthesis: distills high-value memories (instructions/events) into reusable SOP skills, written to the dsh-skill filesystem repository
 *    ($DSH_HOME/skills/<name>/SKILL.md, YAML frontmatter; the dsh-skill-filesystem watcher auto-loads them).
 */
import { mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { MemoryStore } from "./storage.js";

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
  // Total cap: while over the cap, demote the lowest-scoring active memories until back under it
  if (settings.maxActiveMemories > 0) {
    const active = store.getActiveMemories(100_000);
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

/** Deletes a synthesized skill directory (only dsi- prefixed or explicitly authorized names are allowed; prevents path traversal) */
export function deleteSkill(name: string, skillsRoot = ""): boolean {
  const trimmed = name.trim();
  // Only prefixed synthesized skills (this plugin's own products) may be deleted
  const prefix = "dsi-";
  if (!trimmed.startsWith(prefix)) return false;
  if (!/^dsi-[a-z0-9-]+$/.test(trimmed)) return false;
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

/** Counts synthesized skills (directories carrying the prefix) */
export function countSynthesizedSkills(prefix: string, skillsRoot = ""): number {
  const root = skillsRoot.trim() || defaultSkillsDir();
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith(prefix))
      .length;
  } catch {
    return 0;
  }
}

/** Skill synthesis: one call generates one SOP and writes it to the dsh-skill repository; returns the number of skills written */
export async function synthesizeSkills(
  store: MemoryStore,
  callLlm: EvolveCallLlm,
  settings: SkillSynthesisSettings,
  skillsRoot: string,
): Promise<number> {
  if (!settings.enabled) return 0;
  // Skill cap: skip when the synthesized dsi-* skills have reached the limit
  const prefix = (settings.prefix ?? "").trim();
  if (settings.maxSkills > 0 && prefix) {
    const root0 = skillsRoot.trim() || defaultSkillsDir();
    if (countSynthesizedSkills(prefix, root0) >= settings.maxSkills) {
      console.warn(`[dsh-self-improved] skill synthesis skipped: reached maxSkills=${settings.maxSkills}`);
      return 0;
    }
  }
  const memories = store.getActiveMemories(50, settings.minImportance);
  if (memories.length === 0) return 0;
  const root = skillsRoot.trim() || defaultSkillsDir();
  mkdirSync(root, { recursive: true });
  const input = memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  const signal = AbortSignal.timeout(180_000);
  const text = (await callLlm({ system: SKILL_SYSTEM_PROMPT, user: input, signal })).trim();
  const parsed = parseSkillMarkdown(text);
  if (!parsed || !parsed.name) {
    // Write the failure reason to disk for debugging (the user cannot see web console logs)
    try {
      mkdirSync(join(store.dir, "skills-debug"), { recursive: true });
      writeFileSync(join(store.dir, "skills-debug", "rejected-latest.txt"), text, { encoding: "utf8" });
    } catch { /* noop */ }
    console.warn("[dsh-self-improved] skill synthesis rejected model output (see skills-debug/rejected-latest.txt):", text.slice(0, 120));
    return 0;
  }
  // Prefix the name (marks the source / avoids clashing with system skills) and rewrite the frontmatter name to match
  const baseName = prefix && !parsed.name.startsWith(prefix) ? `${prefix}${parsed.name}` : parsed.name;
  let finalText = text;
  if (baseName !== parsed.name) {
    finalText = text.replace(/^(name:\s*).*$/m, `name: ${baseName}`);
  }
  // Name-collision tolerance: when the directory already exists, append a numeric suffix (-2, -3…) instead of giving up
  let dir = join(root, baseName);
  let suffix = 2;
  while (existsSync(join(dir, "SKILL.md")) && suffix < 20) {
    dir = join(root, `${baseName}-${suffix}`);
    suffix += 1;
  }
  const file = join(dir, "SKILL.md");
  if (existsSync(file)) return 0; // all 20 suffixes collided, give up
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, finalText.endsWith("\n") ? finalText : finalText + "\n", { encoding: "utf8" });
  return 1;
}

export function defaultSkillsDir(): string {
  return join(resolveDshHome(undefined, process.env), "skills");
}

/** Parses skill Markdown: prefers frontmatter; without frontmatter, falls back to extracting the heading as the skill name */
function parseSkillMarkdown(text: string): { name?: string } | null {
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const name = fm.match(/^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)/m)?.[1];
    const description = fm.match(/^description:\s*(.+)/m)?.[1];
    if (name && description) return { name };
  }
  // Fallback: extract the skill name from a top-level heading (converted to kebab-case)
  const heading = text.match(/^#\s+([^\n]+)/m)?.[1]?.trim();
  if (heading && text.length > 80) {
    const name = heading
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40);
    if (name) return { name };
  }
  return null;
}
