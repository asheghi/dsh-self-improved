/**
 * M1 存储模块单元测试：插入 / FTS5 检索 / 列表 / 遗忘 / 删除 / sqlite-vec 扩展加载。
 * 运行：node scripts/test-storage.mjs
 */
import { rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m1-unit");
rmSync(dir, { recursive: true, force: true });

const store = new MemoryStore(dir);
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!cond) failed++;
};

// 1) 文件与库文件
check("memory.db 已创建", existsSync(join(dir, "memory.db")));
check("conversations 目录逻辑可用", typeof store.appendConversationSlice === "function");

// 2) 插入
const m1 = store.insertMemory({ kind: "preference", content: "用户偏好用 PowerShell 而非 cmd", importance: 8 });
const m2 = store.insertMemory({ kind: "fact", content: "项目 E:\\dshPro 使用 pnpm 管理依赖", importance: 7 });
const m3 = store.insertMemory({ kind: "event", content: "5/14 完成支付模块迁移，耗时约 4 小时", importance: 6 });
check("插入 3 条返回 id", m1.id && m2.id && m3.id);

// 3) FTS5 检索（BM25）
let hits = store.searchMemories("PowerShell", { limit: 5 });
check("FTS 命中 preference", hits.length === 1 && hits[0].kind === "preference", `got ${hits.length}`);
hits = store.searchMemories("pnpm 依赖", { limit: 5 });
check("FTS 命中 fact（多词）", hits.length >= 1 && hits[0].content.includes("pnpm"), `got ${hits.length}`);
hits = store.searchMemories("不存在的词xyzzy", { limit: 5 });
check("无匹配返回空", hits.length === 0);

// 4) 列表 / 单查 / 遗忘 / 删除
check("listMemories 3 条", store.listMemories().length === 3);
check("getMemory 命中", store.getMemory(m1.id)?.kind === "preference");
check("forgetMemory 生效", store.forgetMemory(m1.id) === true);
hits = store.searchMemories("PowerShell", { limit: 5 });
check("遗忘后不再命中", hits.length === 0);
check("deleteMemory 生效", store.deleteMemory(m2.id) === true);
// listMemories 为浏览视图：保留 forgotten 供恢复，故剩 m1(forgotten) + m3 = 2 条
check("删除后 list 剩 2 条（含 forgotten）", store.listMemories().length === 2, `got ${store.listMemories().length}`);
check("listMemories 含 forgotten 记录", store.listMemories().some((m) => m.status === "forgotten"));

// 5) L0 切片落盘
store.appendConversationSlice("session-test-1", [
  { type: "user", seq: 1, ts: Date.now(), text: "你好", sessionId: "session-test-1" },
  { type: "assistant", seq: 2, ts: Date.now(), text: "你好，有什么可以帮你？", sessionId: "session-test-1" },
]);
const convDir = join(dir, "conversations");
check("conversations 目录生成", existsSync(convDir));
check("切片 JSONL 落盘", readdirSync(convDir).length === 1);

// 6) sqlite-vec 扩展（vectors.db 是否生成）
check("sqlite-vec 加载（vectors.db）", existsSync(join(dir, "vectors.db")), "未生成则向量禁用（不阻塞 M1）");

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
