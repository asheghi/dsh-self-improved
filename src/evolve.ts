/**
 * 自进化模块（M4）：
 * 1) 遗忘衰减：importance × recency × access 评分，低于阈值标记 decayed；过期 forgotten 清理；
 * 2) 技能合成：把高价值记忆（指令/事件）提炼为可复用 SOP，写入 dsh-skill 文件系统仓库
 *    （$DSH_HOME/skills/<name>/SKILL.md，YAML frontmatter；dsh-skill-filesystem watch 自动加载）。
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { MemoryStore } from "./storage.js";

export interface DecaySettings {
  enabled: boolean;
  /** 记忆至少存在多少天才能被衰减 */
  minAgeDays: number;
  /** 评分阈值，低于即标记 decayed */
  threshold: number;
  /** forgotten 记忆超过多少天被物理清理（0 = 不清理） */
  retentionDays: number;
}

export interface SkillSynthesisSettings {
  enabled: boolean;
  /** 参与合成的记忆最低重要度 */
  minImportance: number;
  /** 技能根目录；留空 = $DSH_HOME/skills */
  skillsRoot: string;
}

export interface EvolveCallLlm {
  (input: { system: string; user: string; signal: AbortSignal }): Promise<string>;
}

export const SKILL_SYSTEM_PROMPT = `你是技能提炼器。基于用户与 AI 协作中沉淀的记忆，提炼一条可复用的标准操作流程（SOP）技能。
输出一个 Markdown 文件，格式严格如下：
---
name: 技能名（小写 kebab-case，如 bump-pnpm-deps）
description: 一句话说明（30 字内）
whenToUse: 什么场景下使用
---
技能正文：触发条件、操作步骤（1. 2. 3.）、注意事项、反例。
只输出这个 Markdown，不要额外文字。`;

/** 记忆评分：importance × recency × (1 + log(1+access)) */
export function memoryScore(record: {
  importance: number;
  accessCount: number;
  createdAt: number;
}, now: number): number {
  const ageDays = Math.max(0, (now - record.createdAt) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / 30); // 30 天半衰期
  return record.importance * recency * (1 + Math.log1p(record.accessCount));
}

/** 执行遗忘衰减与清理；返回衰减/清理计数 */
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
  return { decayed, deleted };
}

/** 技能合成：一次调用生成一条 SOP 并写入 dsh-skill 仓库；返回写入的技能数 */
export async function synthesizeSkills(
  store: MemoryStore,
  callLlm: EvolveCallLlm,
  settings: SkillSynthesisSettings,
  skillsRoot: string,
): Promise<number> {
  if (!settings.enabled) return 0;
  const memories = store.getActiveMemories(50, settings.minImportance);
  if (memories.length === 0) return 0;
  const root = skillsRoot.trim() || defaultSkillsDir();
  mkdirSync(root, { recursive: true });
  const input = memories.map((m) => `- [${m.kind}] ${m.content}`).join("\n");
  const signal = AbortSignal.timeout(180_000);
  const text = (await callLlm({ system: SKILL_SYSTEM_PROMPT, user: input, signal })).trim();
  const parsed = parseSkillMarkdown(text);
  if (!parsed || !parsed.name) {
    // 失败原因落盘，便于排查（web 控制台日志用户看不到）
    try {
      mkdirSync(join(store.dir, "skills-debug"), { recursive: true });
      writeFileSync(join(store.dir, "skills-debug", "rejected-latest.txt"), text, { encoding: "utf8" });
    } catch { /* noop */ }
    console.warn("[dsh-self-improved] skill synthesis rejected model output (see skills-debug/rejected-latest.txt):", text.slice(0, 120));
    return 0;
  }
  const dir = join(root, parsed.name);
  const file = join(dir, "SKILL.md");
  if (existsSync(file)) return 0; // 已存在不覆盖
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text.endsWith("\n") ? text : text + "\n", { encoding: "utf8" });
  return 1;
}

export function defaultSkillsDir(): string {
  return join(resolveDshHome(undefined, process.env), "skills");
}

/** 解析技能 Markdown：优先 frontmatter；无 frontmatter 时容错提取标题作为技能名 */
function parseSkillMarkdown(text: string): { name?: string } | null {
  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];
    const name = fm.match(/^name:\s*([a-z0-9]+(?:-[a-z0-9]+)*)/m)?.[1];
    const description = fm.match(/^description:\s*(.+)/m)?.[1];
    if (name && description) return { name };
  }
  // 容错：从一级标题提取技能名（转 kebab-case）
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
