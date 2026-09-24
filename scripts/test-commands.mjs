/**
 * M5 command handler unit tests: /memory search/list/forget/correct/status/help.
 * Run: node scripts/test-commands.mjs
 */
import { rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { handleMemoryCommand, listSkills } from "../lib/commands.js";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "m5-unit");
rmSync(dir, { recursive: true, force: true });
const store = new MemoryStore(dir);

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// Seed
const m1 = store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 });
store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 });

// help
const help = handleMemoryCommand(store, "");
check("help lists subcommands", help.kind === "success" && help.text.includes("/memory search"));

// search
const s1 = handleMemoryCommand(store, "search PowerShell");
check("search hit", s1.kind === "success" && s1.text.includes("PowerShell"), s1.text.slice(0, 40));
const s2 = handleMemoryCommand(store, "search nonexistentxyz");
check("search no hit", s2.text.includes("No relevant memories found"));
const s3 = handleMemoryCommand(store, "search");
check("search errors when missing argument", s3.kind === "error");

// list
const l1 = handleMemoryCommand(store, "list");
check("list outputs memories", l1.text.includes("preference") && l1.text.includes("fact"));

// forget
const f1 = handleMemoryCommand(store, `forget ${m1.id}`);
check("forget works", f1.text.includes("Forgotten"));
check("not found after forget", handleMemoryCommand(store, "search PowerShell").text.includes("No relevant memories found"));

// correct
const c1 = handleMemoryCommand(store, `correct ${m1.id} User prefers PowerShell or pwsh`);
check("correct creates a new memory", c1.kind === "success" && c1.text.includes("new id"));
const corrected = handleMemoryCommand(store, "search pwsh");
check("new content is searchable after correct", corrected.text.includes("pwsh"), corrected.text.slice(0, 40));

// Direct command correction inherits the old row's scope/project/session
const scopedOld = store.insertMemory(
  { kind: "fact", content: "Project workboard builds with Bun offline", importance: 8 },
  { provenance: "user", source: "user-direct", scope: "project", projectId: "workboard", sessionId: "sess-42", confidence: 0.8 },
);
const c2 = handleMemoryCommand(store, `correct ${scopedOld.id} Project workboard builds with Bun in offline mode`);
check("direct correction succeeds", c2.kind === "success", c2.text);
const scopedNew = store.listMemories({ limit: 50 }).find((m) => m.content.includes("offline mode") || m.supersedes === scopedOld.id);
const scopedNewMeta = scopedNew ? store.getMeta(scopedNew.id) : undefined;
check("corrected replacement inherits scope/project/session",
  scopedNewMeta?.scope === "project" && scopedNewMeta?.projectId === "workboard" && scopedNewMeta?.sessionId === "sess-42",
  JSON.stringify(scopedNewMeta),
);
check("old row retired with corrected status", store.getMemory(scopedOld.id)?.status === "corrected");
check("corrected old row excluded from FTS", store.searchMemories("Bun offline", { limit: 5 }).every((h) => h.id !== scopedOld.id));

// status
const st = handleMemoryCommand(store, "status");
check("status outputs statistics", st.text.includes("Memories") && st.text.includes("persona v"));

// listSkills: the synthesized flag follows the CONFIGURED prefix, not hardcoded dsi-
const skillsRootFake = join(dir, "skills-fake");
mkdirSync(join(skillsRootFake, "dsi-foo"), { recursive: true });
mkdirSync(join(skillsRootFake, "mem-bar"), { recursive: true });
writeFileSync(join(skillsRootFake, "dsi-foo", "SKILL.md"), "---\nname: dsi-foo\ndescription: dsi skill body\n---\nbody");
writeFileSync(join(skillsRootFake, "mem-bar", "SKILL.md"), "---\nname: mem-bar\ndescription: mem skill body\n---\nbody");
const withDsi = listSkills(100, "dsi-", skillsRootFake);
const dsiFlag = withDsi.find((s) => s.name.startsWith("dsi-"));
const memFlag = withDsi.find((s) => s.name.startsWith("mem-"));
check("listSkills marks configured-prefixed skills synthesized", dsiFlag?.synthesized === true, JSON.stringify(withDsi.map((s) => s.name)));
const withMem = listSkills(100, "mem-", skillsRootFake);
const memFlag2 = withMem.find((s) => s.name.startsWith("mem-"));
const dsiFlag2 = withMem.find((s) => s.name.startsWith("dsi-"));
check("custom prefix marks its own skills and not foreign ones",
  memFlag2?.synthesized === true && dsiFlag2?.synthesized === false,
  JSON.stringify(withMem));

// unknown subcommand → help
const u = handleMemoryCommand(store, "bogus");
check("unknown subcommand shows help", u.text.includes("/memory search"));

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
