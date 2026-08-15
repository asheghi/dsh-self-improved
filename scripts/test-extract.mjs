/**
 * M2 提取管线单元测试：用假 LLM 注入，验证 JSON 校验、兜底、过滤、去重、水位推进。
 * 运行：node scripts/test-extract.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { Extractor } from "../lib/extract.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m2-unit");
rmSync(dir, { recursive: true, force: true });
const store = new MemoryStore(dir);

const settings = {
  enabled: true,
  intervalMinutes: 15,
  batchMaxChars: 12000,
  maxOutputTokens: 2000,
  timeoutMs: 60000,
  dedup: true,
  fallbackOnBadJson: true,
  flushDrain: false,
};

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

function seedSession(id, texts) {
  const recs = texts.map((t, i) => ({
    type: i % 2 ? "assistant" : "user",
    seq: i + 1,
    ts: Date.now(),
    text: t,
    sessionId: id,
  }));
  store.appendConversationSlice(id, recs);
  store.markPending(id, recs[recs.length - 1].seq);
}

// 场景 1：合法 JSON
seedSession("s-valid", ["我喜欢用 PowerShell 而不是 cmd", "好的，已记住你的偏好"]);
// 场景 2：坏输出（非 JSON 文本）
seedSession("s-garbage", ["随便聊聊天气"]);
// 场景 3：空结果
seedSession("s-empty", ["你好", "再见"]);
// 场景 4：非法条目 + 敏感信息
seedSession("s-invalid", ["这是测试对话"]);
// 场景 5：去重（先入库同内容，再提取）
store.insertMemory({ kind: "fact", content: "项目 E:\\dshPro 使用 pnpm 管理依赖", importance: 7 });
seedSession("s-dup", ["项目 E:\\dshPro 使用 pnpm 管理依赖"]);

const scripted = {
  "s-valid": JSON.stringify({
    memories: [
      { kind: "preference", content: "用户偏好使用 PowerShell 而非 cmd", importance: 8 },
      { kind: "fact", content: "用户日常使用 Windows 系统", importance: 5 },
    ],
  }),
  "s-garbage": "好的呢，今天天气不错",
  "s-empty": JSON.stringify({ memories: [] }),
  "s-invalid": JSON.stringify({
    memories: [
      { kind: "nonsense", content: "类型非法", importance: 5 },
      { kind: "fact", content: "x", importance: 5 },
      { kind: "fact", content: "密钥是 sk-abcdef1234567890 请保存", importance: 9 },
      { kind: "fact", content: "合法的记忆条目", importance: 6 },
    ],
  }),
  "s-dup": JSON.stringify({
    memories: [{ kind: "fact", content: "项目 E:\\dshPro 使用 pnpm 管理依赖", importance: 7 }],
  }),
};

const extractor = new Extractor(store, settings, async ({ sessionId }) => scripted[sessionId] ?? "{}");
const result = await extractor.pump();

check("pump 处理 5 个会话", result.sessions === 5, `sessions=${result.sessions}`);
check("合法 JSON 提取 2 条", result.memories >= 2, `memories=${result.memories} skipped=${result.skipped}`);
check("偏好可检索", store.searchMemories("PowerShell", { limit: 5 }).length >= 1);
check("事实可检索", store.searchMemories("Windows", { limit: 5 }).length >= 1);
check("坏输出兜底摘要", store.searchMemories("自动摘要", { limit: 5 }).length >= 1);
check(
  "合法空结果不触发兜底（自动摘要仅 1 条）",
  store.listMemories().filter((m) => m.content.includes("[自动摘要]")).length === 1,
  `got ${store.listMemories().filter((m) => m.content.includes("[自动摘要]")).length}`,
);
check(
  "空结果不产生记忆",
  store.listMemories().filter((m) => m.content.includes("你好，再见")).length === 0,
);
check("非法条目过滤、合法条目保留", store.listMemories().filter((m) => m.content === "合法的记忆条目").length === 1);
check("敏感内容被过滤", !store.listMemories().some((m) => m.content.includes("sk-abcdef")));
check(
  "去重：仅 1 条 pnpm 记忆",
  store.listMemories().filter((m) => m.content.includes("pnpm")).length === 1,
  `got ${store.listMemories().filter((m) => m.content.includes("pnpm")).length}`,
);
check("全部会话水位推进", store.pendingSessions().length === 0, `pending=${store.pendingSessions().length}`);

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
