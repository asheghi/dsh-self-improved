/**
 * M3 recall service unit tests: keyword recall / vector search / hybrid RRF / rendering / degradation.
 * Run: node scripts/test-recall.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { RecallService, renderRecallBlock } from "../lib/recall.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m3-unit");
rmSync(dir, { recursive: true, force: true });
const store = new MemoryStore(dir);

const DIMS = 1024;
/** Deterministic fake embedding: hashes each token into a 1024-dim one-hot */
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

// Seed memories + vectors
const m1 = store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 });
const m2 = store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 });
const m3 = store.insertMemory({ kind: "event", content: "Finished the login module integration yesterday", importance: 5 });
for (const m of [m1, m2, m3]) {
  const ok = store.upsertEmbedding(m.id, fakeEmbed(m.content));
  if (!ok) console.log("WARN: vector write failed (sqlite-vec may not be loaded)");
}

const settings = { strategy: "hybrid", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000 };
const recall = new RecallService(store, settings, fakeProvider);

// 1) Keyword recall (jieba FTS5, OR semantics)
const kw = await recall.search("prefers PowerShell", { maxResults: 3 });
check("keyword recall hits the preference", kw.some((h) => h.id === m1.id), JSON.stringify(kw.map((h) => h.kind)));
// OR semantics: a colloquial query (with words absent from the memory) still hits
const kwOr = await recall.search("PowerShell or cmd and similar tools", { maxResults: 3 });
check("OR semantics: colloquial query still hits", kwOr.some((h) => h.id === m1.id), JSON.stringify(kwOr.map((h) => h.content.slice(0, 10))));
// Exact AND semantics (tool side) stays strict
const andHits = store.searchMemories("PowerShell or cmd and similar tools", { limit: 5, matchAny: false });
check("tool-side AND semantics stays strict", andHits.length === 0, `got ${andHits.length}`);

// 2) Vector search (store.vectorSearch direct test)
const vec = fakeEmbed("User prefers PowerShell over cmd");
const neighbors = store.vectorSearch(vec, 3);
check("vector neighbor hits the same content", neighbors.length > 0 && neighbors[0].memoryId === m1.id, JSON.stringify(neighbors.slice(0, 2)));

// 3) Hybrid recall (keyword + vector RRF)
const hy = await recall.search("pnpm manage dependencies", { maxResults: 3 });
check("hybrid recall hits the pnpm memory", hy.some((h) => h.id === m2.id), JSON.stringify(hy.map((h) => h.content.slice(0, 12))));

// 4) Keyword-only strategy (no embedding configured)
const recallKw = new RecallService(store, { ...settings, strategy: "keyword" }, null);
const kwOnly = await recallKw.search("PowerShell", { maxResults: 3 });
check("keyword-only strategy hits", kwOnly.some((h) => h.id === m1.id));

// 5) Rendered block
const block = renderRecallBlock([{ id: m1.id, kind: "preference", content: "User prefers PowerShell", importance: 8, score: 1 }]);
check("rendered block contains header and importance", block.includes("Relevant memories") && block.includes("importance 8/10"), block);

// 6) Degradation: embedding throws → return empty instead of throwing
const brokenProvider = { async embed() { throw new Error("embedding down"); } };
const recallBroken = new RecallService(store, settings, brokenProvider);
let degradedOk = false;
try {
  const r = await recallBroken.search("any query", { maxResults: 3 });
  degradedOk = Array.isArray(r);
} catch {
  degradedOk = false;
}
check("degrades to empty when embedding fails (no throw)", degradedOk);

// 7) Empty query
check("empty query returns empty", (await recall.search("  ", { maxResults: 3 })).length === 0);

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
