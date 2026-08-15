/**
 * M5 命令处理器单元测试：/memory search/list/forget/correct/status/help。
 * 运行：node scripts/test-commands.mjs
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

// 种子
const m1 = store.insertMemory({ kind: "preference", content: "用户偏好使用 PowerShell 而非 cmd", importance: 8 });
store.insertMemory({ kind: "fact", content: "项目 E:\\dshPro 使用 pnpm 管理依赖", importance: 7 });

// help
const help = handleMemoryCommand(store, "");
check("help 列出子命令", help.kind === "success" && help.text.includes("/memory search"));

// search
const s1 = handleMemoryCommand(store, "search PowerShell");
check("search 命中", s1.kind === "success" && s1.text.includes("PowerShell"), s1.text.slice(0, 40));
const s2 = handleMemoryCommand(store, "search 不存在的xyz");
check("search 无命中", s2.text.includes("没有"));
const s3 = handleMemoryCommand(store, "search");
check("search 缺参数报错", s3.kind === "error");

// list
const l1 = handleMemoryCommand(store, "list");
check("list 输出记忆", l1.text.includes("preference") && l1.text.includes("fact"));

// forget
const f1 = handleMemoryCommand(store, `forget ${m1.id}`);
check("forget 生效", f1.text.includes("已遗忘"));
check("forget 后检索不到", handleMemoryCommand(store, "search PowerShell").text.includes("没有"));

// correct
const c1 = handleMemoryCommand(store, `correct ${m1.id} 用户偏好使用 PowerShell 或 pwsh`);
check("correct 生成新记忆", c1.kind === "success" && c1.text.includes("新 id"));
const corrected = handleMemoryCommand(store, "search pwsh");
check("correct 后新内容可检索", corrected.text.includes("pwsh"), corrected.text.slice(0, 40));

// status
const st = handleMemoryCommand(store, "status");
check("status 输出统计", st.text.includes("记忆") && st.text.includes("画像 v"));

// 未知子命令 → help
const u = handleMemoryCommand(store, "bogus");
check("未知子命令给帮助", u.text.includes("/memory search"));

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
