/**
 * M4 self-evolution unit tests: scene consolidation / persona versioning / forgetting decay / skill synthesis (fake LLM).
 * Run: node scripts/test-evolve.mjs
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

// Seeds: one preference/fact/event/instruction each (including one high-importance instruction used for skill synthesis)
store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 });
store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 });
store.insertMemory({ kind: "event", content: "Completed joint debugging of the login module yesterday", importance: 5 });
store.insertMemory({ kind: "instruction", content: "Use pnpm when updating dependencies and keep the lockfile up to date", importance: 8 });

// ---------- 1) Scene consolidation ----------
// Fake LLM: distinguishes scene/persona calls by the system prompt
const branchedFakeLlm = async ({ system }) =>
  system.includes("scene block")
    ? JSON.stringify({ scenes: [{ title: "Toolchain collaboration", summary: "The user manages dependencies with pnpm and prefers PowerShell." }] })
    : `## Basic Info\n- Uses Windows and PowerShell\n\n## Preferences & Habits\n- Prefers pnpm for dependency management`;
const consolidator = new Consolidator(store, { sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 }, branchedFakeLlm);
const r1 = await consolidator.consolidate();
check("scene consolidation writes", r1.scenes === 1, JSON.stringify(r1));
check("scene is listable", store.listScenes().length === 1 && store.listScenes()[0].title === "Toolchain collaboration");
check("persona first generated ver=1", r1.personaVersion === 1, JSON.stringify(r1));

// ---------- 2) Persona versioning ----------
const personaFakeLlm = async () =>
  `## Basic Info\n- Uses Windows and PowerShell\n\n## Preferences & Habits\n- Prefers pnpm for dependency management`;
const c2 = new Consolidator(store, { sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 }, personaFakeLlm);
const r2 = await c2.consolidate();
check("persona second run bumps version to 2", r2.personaVersion === 2, JSON.stringify(r2));
const p1 = store.getPersona();
check("persona content persisted", p1?.content.includes("PowerShell") === true);
check("persona.md written to disk", existsSync(join(dir, "persona", "persona.md")));
const r3 = await c2.consolidate();
check("persona third run bumps version to 3", r3.personaVersion === 3, JSON.stringify(r3));
check("persona.md has a backup", existsSync(join(dir, "persona", "persona.md.bak1")));

// ---------- 3) Forgetting decay ----------
const now = Date.now();
const fresh = store.insertMemory({ kind: "fact", content: "a temporary detail just recorded", importance: 1 });
check("old low-score memory scores below threshold", memoryScore({ importance: 1, accessCount: 0, createdAt: now - 60 * 86_400_000 }, now) < 2);
const decayed = applyDecay(store, { enabled: true, minAgeDays: 30, threshold: 2, retentionDays: 0 }, now);
check("decay run returns counts", typeof decayed.decayed === "number" && typeof decayed.deleted === "number");
// High-importance memories must not be decayed
const activeAfter = store.getActiveMemories(100);
check("high-importance active memory survives decay", activeAfter.some((m) => m.content.includes("PowerShell")));
// Fresh memory has not reached the minimum age → must not be decayed (correct behavior)
check("new memory not decayed (below minimum age)", store.getMemory(fresh.id)?.status === "active");

// ---------- 4) Skill synthesis ----------
const skillFakeLlm = async () =>
  `---\nname: bump-pnpm-deps\ndescription: Safely update dependencies with pnpm\nwhenToUse: When project dependencies need updating\n---\n1. Check current dependency versions\n2. Run pnpm update\n3. Confirm the lockfile has been updated`;
const synthesized = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("skill file written", synthesized === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md")));
if (existsSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md"))) {
  const content = readFileSync(join(skillsRoot, "bump-pnpm-deps", "SKILL.md"), "utf8");
  check("skill contains frontmatter and steps", content.includes("name: bump-pnpm-deps") && content.includes("pnpm update"));
}
const synthesized2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("name collision creates suffixed copy (-2)", synthesized2 === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps-2", "SKILL.md")));
const synthesized3 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot }, skillsRoot);
check("continued collision creates -3", synthesized3 === 1 && existsSync(join(skillsRoot, "bump-pnpm-deps-3", "SKILL.md")));

// Prefix: synthesized skill names get the dsi- prefix; on collision the suffix applies to the prefixed name
const pfxRoot = join(dir, "skills-pfx");
rmSync(pfxRoot, { recursive: true, force: true });
const pfx1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: pfxRoot, prefix: "dsi-" }, pfxRoot);
check("synthesis with prefix (dsi-bump-pnpm-deps)", pfx1 === 1 && existsSync(join(pfxRoot, "dsi-bump-pnpm-deps", "SKILL.md")));
const pfxFile = join(pfxRoot, "dsi-bump-pnpm-deps", "SKILL.md");
if (existsSync(pfxFile)) {
  const content = readFileSync(pfxFile, "utf8");
  check("frontmatter name rewritten to the prefixed name", content.includes("name: dsi-bump-pnpm-deps"));
}
const pfx2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: pfxRoot, prefix: "dsi-" }, pfxRoot);
check("prefixed collision generates dsi-bump-pnpm-deps-2", pfx2 === 1 && existsSync(join(pfxRoot, "dsi-bump-pnpm-deps-2", "SKILL.md")));

// Delete skill: only dsi- prefixed, well-formed skill directories may be deleted
const d1 = deleteSkill("dsi-bump-pnpm-deps", pfxRoot);
check("prefixed skill deleted", d1 === true && !existsSync(join(pfxRoot, "dsi-bump-pnpm-deps")));
const d2 = deleteSkill("bump-pnpm-deps", pfxRoot);
check("unprefixed skill deletion rejected", d2 === false);
const d3 = deleteSkill("../evil", pfxRoot);
check("illegal name deletion rejected", d3 === false);

// Skill cap: synthesis stops once maxSkills is reached
const capRoot = join(dir, "skills-cap");
rmSync(capRoot, { recursive: true, force: true });
const cap1 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: capRoot, prefix: "dsi-", maxSkills: 1 }, capRoot);
check("synthesis allowed under the cap (1/1)", cap1 === 1 && existsSync(join(capRoot, "dsi-bump-pnpm-deps", "SKILL.md")));
const cap2 = await synthesizeSkills(store, skillFakeLlm, { enabled: true, minImportance: 7, skillsRoot: capRoot, prefix: "dsi-", maxSkills: 1 }, capRoot);
check("synthesis stops at the cap", cap2 === 0);

// Memory total cap: over the limit, the lowest-scoring memories are demoted automatically
const capMem = await import("../lib/storage.js").then((m) => new m.MemoryStore(join(dir, "cap-mem")));
for (let i = 0; i < 5; i++) capMem.insertMemory({ kind: "fact", content: `test memory ${i}`, importance: 5 });
const dc = applyDecay(capMem, { enabled: true, minAgeDays: 9999, threshold: 0, retentionDays: 0, maxActiveMemories: 3 });
check("memory cap demotes lowest scores (5→3)", dc.decayed === 2, "decayed=" + dc.decayed);
check("active count after demotion = 3", capMem.getActiveMemories(100).length === 3);
capMem.close();

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
