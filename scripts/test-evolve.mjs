/**
 * M4 自进化单元测试：场景归纳 / 画像版本化 / 遗忘衰减 / 技能合成（假 LLM）。
 * 运行：node scripts/test-evolve.mjs
 */
import { rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { Consolidator } from "../lib/consolidate.js";
import { applyDecay, memoryScore, synthesizeSkills, deleteSkill } from "../lib/evolve.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m4-unit");
rmSync(dir, { recursive: true, force: true });
const skillsRoot = join(dir, "skills");
rmSync(skillsRoot, { recursive: true, force: true });
const store = new MemoryStore(dir);

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// 种子：偏好/事实/事件/指令各一条（含一条高重要度指令用于技能合成）
store.insertMemory({ kind: "preference", content: "用户偏好用 PowerShell 而非 cmd", importance: 8 });
store.insertMemory({ kind: "fact", content: "项目 E:\\dshPro 使用 pnpm 管理依赖", importance: 7 });
store.insertMemory({ kind: "event", content: "昨天完成了登录模块联调", importance: 5 });
store.insertMemory({ kind: "instruction", content: "更新依赖时用 pnpm 并保持 lockfile 更新", importance: 8 });

// ---------- 1) 场景归纳 ----------
// 假 LLM：按 system 提示词区分场景/画像调用
const branchedFakeLlm = async ({ system }) =>
  system.includes("场景块")
    ? JSON.stringify({ scenes: [{ title: "工具链协作", summary: "用户用 pnpm 管理依赖，偏好 PowerShell。" }] })
    : `## 基本信息\n- 使用 Windows 与 PowerShell\n\n## 偏好与习惯\n- 偏好 pnpm 管理依赖`;
const consolidator = new Consolidator(store, { sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 }, branchedFakeLlm);
const r1 = await consolidator.consolidate();
check("场景归纳写入", r1.scenes === 1, JSON.stringify(r1));
check("场景可列出", store.listScenes().length === 1 && store.listScenes()[0].title === "工具链协作");
check("画像首次生成 ver=1", r1.personaVersion === 1, JSON.stringify(r1));

// ---------- 2) 画像版本化 ----------
const personaFakeLlm = async () =>
  `## 基本信息\n- 使用 Windows 与 PowerShell\n\n## 偏好与习惯\n- 偏好 pnpm 管理依赖`;
const c2 = new Consolidator(store, { sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 }, personaFakeLlm);
const r2 = await c2.consolidate();
check("画像二次生成版本+1", r2.personaVersion === 2, JSON.stringify(r2));
const p1 = store.getPersona();
check("画像内容落库", p1?.content.includes("PowerShell") === true);
check("persona.md 落盘", existsSync(join(dir, "persona", "persona.md")));
const r3 = await c2.consolidate();
check("画像三次生成版本+1", r3.personaVersion === 3, JSON.stringify(r3));
check("persona.md 有备份", existsSync(join(dir, "persona", "persona.md.bak1")));

// ---------- 3) 遗忘衰减 ----------
const now = Date.now();
const fresh = store.insertMemory({ kind: "fact", content: "刚记录的临时细节", importance: 1 });
check("旧低分记忆评分 < 阈值", memoryScore({ importance: 1, accessCount: 0, createdAt: now - 60 * 86_400_000 }, now) < 2);
const decayed = applyDecay(store, { enabled: true, minAgeDays: 30, threshold: 2, retentionDays: 0 }, now);
check("衰减执行返回计数", typeof decayed.decayed === "number" && typeof decayed.deleted === "number");
// 高重要度记忆不应被衰减
const activeAfter = store.getActiveMemories(100);
check("衰减后仍有高重要度活跃记忆", activeAfter.some((m) => m.content.includes("PowerShell")));
// 新建记忆未达最小年龄 → 不应被衰减（正确行为）
check("新记忆不被衰减（未达最小年龄）", store.getMemory(fresh.id)?.status === "active");

// ---------- 4) 技能合成 ----------
const skillFakeLlm = async () =>
  `---\nname: bump-pnpm-deps\ndescription: 用 pnpm 安全更新依赖\nwhenToUse: 需要更新项目依赖时\n---\n1. 检查当前依赖版本\n2. 使用 pnpm update\n3. 确认 lockfile 已更新`;
const synthesized = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("技能文件写入", synthesized === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md")));
if (existsSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md"))) {
  const content = readFileSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md"), "utf8");
  check("技能含 frontmatter 与步骤", content.includes("name: bump-pnpm-deps") && content.includes("pnpm update"));
}
const synthesized2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("撞名时生成后缀副本（-2）", synthesized2 === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md")));
const synthesized3 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("继续撞名生成 -3", synthesized3 === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps-3", "SKILL.md")));

// 前缀：合成技能名加 dsi- 前缀，撞名时后缀作用于带前缀名
const pfxRoot = join(dir, "skills-pfx");
rmSync(pfxRoot, { recursive: true, force: true });
const pfx1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: pfxRoot, prefix: "dsi-" }, pfxRoot);
check("带前缀合成（dsi-bump-pnpm-deps）", pfx1 === 1 && existsSync(join(pfxRoot, "dsi-bump-pnpm-deps", "SKILL.md")));
const pfxFile = join(pfxRoot, "dsi-bump-pnpm-deps", "SKILL.md");
if (existsSync(pfxFile)) {
  const content = readFileSync(pfxFile, "utf8");
  check("frontmatter name 同步为带前缀名", content.includes("name: dsi-bump-pnpm-deps"));
}
const pfx2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: pfxRoot, prefix: "dsi-" }, pfxRoot);
check("带前缀撞名生成 dsi-bump-pnpm-deps-2", pfx2 === 1 && existsSync(join(pfxRoot, "dsi-bump-pnpm-deps-2", "SKILL.md")));

// 删除技能：仅允许删 dsi- 前缀、格式合法的技能目录
const d1 = deleteSkill("dsi-bump-pnpm-deps", pfxRoot);
check("删除带前缀技能", d1 === true && !existsSync(join(pfxRoot, "dsi-bump-pnpm-deps")));
const d2 = deleteSkill("bump-pnpm-deps", pfxRoot);
check("无前缀技能拒绝删除", d2 === false);
const d3 = deleteSkill("../evil", pfxRoot);
check("非法名拒绝删除", d3 === false);

// 技能上限：达到 maxSkills 后停止合成
const capRoot = join(dir, "skills-cap");
rmSync(capRoot, { recursive: true, force: true });
const cap1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: capRoot, prefix: "dsi-", maxSkills: 1 }, capRoot);
check("上限内可合成（1/1）", cap1 === 1 && existsSync(join(capRoot, "dsi-bump-pnpm-deps", "SKILL.md")));
const cap2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: capRoot, prefix: "dsi-", maxSkills: 1 }, capRoot);
check("达到上限停止合成", cap2 === 0);

// 记忆总量上限：超限时自动降级最低分记忆
const capMem = await import("../lib/storage.js").then((m) => new m.MemoryStore(join(dir, "cap-mem")));
for (let i = 0; i < 5; i++) capMem.insertMemory({ kind: "fact", content: `第 ${i} 条测试记忆`, importance: 5 });
const dc = applyDecay(capMem, { enabled: true, minAgeDays: 9999, threshold: 0, retentionDays: 0, maxActiveMemories: 3 });
check("记忆上限降级最低分（5→3）", dc.decayed === 2, "decayed=" + dc.decayed);
check("降级后活跃数=3", capMem.getActiveMemories(100).length === 3);
capMem.close();

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
