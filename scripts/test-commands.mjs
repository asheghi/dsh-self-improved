/**
 * M5 command handler unit tests: /memory search/list/forget/correct/status/help.
 * Run: node scripts/test-commands.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { handleMemoryCommand } from "../lib/commands.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m5-unit");
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

// status
const st = handleMemoryCommand(store, "status");
check("status outputs statistics", st.text.includes("Memories") && st.text.includes("persona v"));

// unknown subcommand → help
const u = handleMemoryCommand(store, "bogus");
check("unknown subcommand shows help", u.text.includes("/memory search"));

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
