/**
 * M3 召回服务单元测试：关键词召回 / 向量检索 / 混合 RRF / 渲染 / 降级。
 * 运行：node scripts/test-recall.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { RecallService, renderRecallBlock } from "../lib/recall.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m3-unit");
rmSync(dir, { recursive: true, force: true });
const store = new MemoryStore(dir);

const DIMS = 1024;
/** 确定性假 embedding：按 token 哈希到 1024 维 one-hot */
function fakeEmbed(text) {
  const vec = new Array(DIMS).fill(0);
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}_]+/gu).filter(Boolean);
  for (const t of tokens) {
    let h = 0;
    for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0;
    vec[Math.abs(h) % DIMS] += 1;
  }
  return vec;
}
const fakeProvider = {
  async embed(texts) {
    return texts.map(fakeEmbed);
  },
};

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// 种子记忆 + 向量
const m1 = store.insertMemory({ kind: "preference", content: "用户偏好使用 PowerShell 而非 cmd", importance: 8 });
const m2 = store.insertMemory({ kind: "fact", content: "项目 E:\\dshPro 使用 pnpm 管理依赖", importance: 7 });
const m3 = store.insertMemory({ kind: "event", content: "昨天完成了登录模块的联调", importance: 5 });
for (const m of [m1, m2, m3]) {
  const ok = store.upsertEmbedding(m.id, fakeEmbed(m.content));
  if (!ok) console.log("WARN: 向量写入失败（可能 sqlite-vec 未加载）");
}

const settings = { strategy: "hybrid", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000 };
const recall = new RecallService(store, settings, fakeProvider);

// 1) 关键词召回（jieba FTS5，OR 语义）
const kw = await recall.search("PowerShell 偏好", { maxResults: 3 });
check("关键词召回命中偏好", kw.some((h) => h.id === m1.id), JSON.stringify(kw.map((h) => h.kind)));
// OR 语义：口语化查询（含不在记忆中的词）也能命中
const kwOr = await recall.search("PowerShell 还是 cmd 之类", { maxResults: 3 });
check("OR 语义：口语查询仍命中", kwOr.some((h) => h.id === m1.id), JSON.stringify(kwOr.map((h) => h.content.slice(0, 10))));
// 精确 AND 语义（工具侧）仍严格
const andHits = store.searchMemories("PowerShell 还是 cmd 之类", { limit: 5, matchAny: false });
check("工具侧 AND 语义保持严格", andHits.length === 0, `got ${andHits.length}`);

// 2) 向量检索（store.vectorSearch 直测）
const vec = fakeEmbed("用户偏好使用 PowerShell 而非 cmd");
const neighbors = store.vectorSearch(vec, 3);
check("向量近邻命中同内容", neighbors.length > 0 && neighbors[0].memoryId === m1.id, JSON.stringify(neighbors.slice(0, 2)));

// 3) 混合召回（keyword + vector RRF）
const hy = await recall.search("pnpm 管理依赖", { maxResults: 3 });
check("混合召回命中 pnpm 记忆", hy.some((h) => h.id === m2.id), JSON.stringify(hy.map((h) => h.content.slice(0, 12))));

// 4) 纯关键词策略（未配置 embedding 时）
const recallKw = new RecallService(store, { ...settings, strategy: "keyword" }, null);
const kwOnly = await recallKw.search("PowerShell", { maxResults: 3 });
check("纯关键词策略命中", kwOnly.some((h) => h.id === m1.id));

// 5) 渲染块
const block = renderRecallBlock([{ id: m1.id, kind: "preference", content: "用户偏好使用 PowerShell", importance: 8, score: 1 }]);
check("渲染块含标记与重要度", block.includes("【相关记忆】") && block.includes("重要度 8/10"), block);

// 6) 降级：embedding 抛错 → 返回空不抛
const brokenProvider = { async embed() { throw new Error("embedding down"); } };
const recallBroken = new RecallService(store, settings, brokenProvider);
let degradedOk = false;
try {
  const r = await recallBroken.search("任何查询", { maxResults: 3 });
  degradedOk = Array.isArray(r);
} catch {
  degradedOk = false;
}
check("embedding 故障时降级为空（不抛错）", degradedOk);

// 7) 空查询
check("空查询返回空", (await recall.search("  ", { maxResults: 3 })).length === 0);

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
