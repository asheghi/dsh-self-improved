/**
 * M3 recall service unit tests: keyword recall / vector search / hybrid RRF / rendering / degradation.
 * Run: node scripts/test-recall.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { RecallService, createOpenAiEmbedding, renderRecallBlock } from "../lib/recall.js";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "m3-unit");
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
const m1 = store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 }, { provenance: "user" });
const m2 = store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 }, { provenance: "user" });
const m3 = store.insertMemory({ kind: "event", content: "Finished the login module integration yesterday", importance: 5 }, { provenance: "user" });
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

// 6) Degradation: embedding throws → keyword results must survive (no keyword loss)
const brokenProvider = { async embed() { throw new Error("embedding down"); } };
const recallBroken = new RecallService(store, settings, brokenProvider);
let degradedOk = false;
try {
  const r = await recallBroken.search("pnpm manage dependencies unpackaged widgets", { maxResults: 3 });
  degradedOk = Array.isArray(r) && r.some((h) => h.id === m2.id);
} catch {
  degradedOk = false;
}
check("degrades to keyword-only hits when embedding fails (no throw)", degradedOk);
// Unconfigured provider (embed throws "not configured") likewise keeps keyword hits
const recallUnconfigured = new RecallService(store, { ...settings, strategy: "hybrid" }, createOpenAiEmbedding({}));
const unconfiguredHits = await recallUnconfigured.search("pnpm manage dependencies unpackaged widgets", { maxResults: 3 });
check("unconfigured embedding provider still returns the keyword hit", unconfiguredHits.some((h) => h.id === m2.id), JSON.stringify(unconfiguredHits.map((h) => h.id)));

// 7) Empty query
check("empty query returns empty", (await recall.search("  ", { maxResults: 3 })).length === 0);

// 8) scoreThreshold applied compatibly with BM25 direction (negative allowed)
// Direction: bm25 is negative for matches; smaller (more negative) = stronger.
// A negative threshold acts as an upper bound: keep hits with score <= threshold.
const kwScoped = new RecallService(
  store,
  { ...settings, strategy: "keyword", scoreThreshold: -0.001 },
  null,
);
const thrHit = await kwScoped.search("prefers PowerShell", { maxResults: 3 });
check("lenient negative threshold keeps strong BM25 hits", thrHit.some((h) => h.id === m1.id), JSON.stringify(thrHit.map((h) => h.score)));
const cutoffStore = new MemoryStore(join(dir, "cutoff"));
cutoffStore.insertMemory({ kind: "fact", content: "Alpha beta gamma distinct tokens xqz", importance: 9 }, { provenance: "user" });
const thrStrict = new RecallService(
  cutoffStore,
  { strategy: "keyword", maxResults: 5, scoreThreshold: -999_999, timeoutMs: 3000, relevanceMargin: 0 },
  null,
);
const strictBelow = await thrStrict.search("alpha beta gamma distinct tokens xqz", {});
check("negative threshold drops rows above the bm25 bound (direction preserved)", strictBelow.length === 0, JSON.stringify(strictBelow.map((h) => h.score)));
const thrStrength = new RecallService(
  cutoffStore,
  { strategy: "keyword", maxResults: 5, scoreThreshold: 9_999_999, timeoutMs: 3000, relevanceMargin: 0 },
  null,
);
check("positive legacy threshold = strength floor (drops everything here)", (await thrStrength.search("alpha beta", {})).length === 0);
cutoffStore.close();

// ── 9) Live transition: unconfigured → configured embedding (per-call config reads) ──
{
  // Shared config object exactly like the plugin one: the provider reads it per embed() call.
  // START with keys that are NOT baseUrl/model so the object exists but stays unconfigured,
  // proving the factory is not construction-gated.
  const liveConfig = { baseUrl: "", apiKey: "", model: "", dimensions: DIMS, timeoutMs: 4000 };
  const delegatingConfig = { ...liveConfig };
  const liveRecall = new RecallService(store, { ...settings, strategy: "hybrid" }, createOpenAiEmbedding(delegatingConfig));
  const before = await liveRecall.search("pnpm manage dependencies unpackaged widgets", { maxResults: 3 });
  check("live unconfigured provider still returns keyword hits", before.some((h) => h.id === m2.id));
  check("live unconfigured embed degenerates with a clear error", await createOpenAiEmbedding(delegatingConfig).embed(["x"]).then(() => false, () => true));

  // Local one-shot embedding endpoint: verifies the request, then closes.
  let embeddingCalls = 0;
  let forwardedModel = "";
  const server = import("node:http").then((http) => new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        embeddingCalls += 1;
        try { forwardedModel = JSON.parse(body).model ?? ""; } catch { forwardedModel = ""; }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ data: [{ embedding: fakeEmbed("pnpm") }] }));
      });
    });
    srv.listen(0, "127.0.0.1", () => resolve({ srv, port: srv.address().port }));
    srv.on("error", reject);
  }));
  const { srv, port } = await server;
  // HOT-APPLY: mutate the SHARED config between embed calls (plugin settings/updated equivalent)
  delegatingConfig.baseUrl = `http://127.0.0.1:${port}/v1`;
  delegatingConfig.model = "test-embed";
  const after = await liveRecall.search("pnpm manage dependencies unpackaged widgets", { maxResults: 3 });
  check("configured endpoint is hit within one refresh (no restart)", embeddingCalls >= 1, "calls=" + embeddingCalls);
  check("hot-applied model flows into the request", forwardedModel === "test-embed", forwardedModel);
  check("hybrid path still returns the memory after the live transition", after.some((h) => h.id === m2.id));
  srv.close();
}

// ── 10) Per-call maxTokens: hot-applied settings reach each LLM call ──
{
  const { makeLlmCall } = await import("../lib/index.js");
  const maxTokensCalls = { settingsMaxTokens: 256 };
  const seen = [];
  const fakeCtx = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    get: undefined,
    llm: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async *stream(options) {
        seen.push({ maxTokens: options.maxTokens, purpose: options.purpose, provider: options.provider, model: options.model });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        yield { type: "text-delta", index: 0, text: "{}" };
      },
    },
  };
  const fakeConfig = { extract: { provider: "p", model: "m" } };
  const call = makeLlmCall(fakeCtx, fakeConfig, "memory-extract", () => maxTokensCalls.settingsMaxTokens);
  await call({ system: "s", user: "u", signal: AbortSignal.timeout(1000) });
  maxTokensCalls.settingsMaxTokens = 4096; // hot-apply between calls
  await call({ system: "s", user: "u", signal: AbortSignal.timeout(1000) });
  check("hot-applied maxTokens observed per call", seen[0]?.maxTokens === 256, JSON.stringify(seen[0]));
  check("second LLM call picks up the hot-applied maxTokens", seen[1]?.maxTokens === 4096, JSON.stringify(seen[1]));
  check("configured provider/model forwarded to every LLM call", seen.length === 2 && seen.every((s) => s.provider === "p" && s.model === "m"), JSON.stringify(seen[0]));
}

// ── 11) Deadline-bound vector lane: a slow-but-not-throwing embedding provider
// must not exceed the overall recall deadline, and existing keyword hits must
// survive (keyword-only fallback instead of an empty result). ──
{
  const slowProvider = {
    async embed(texts) {
      await new Promise((resolve) => setTimeout(resolve, 4000)); // hangs past a 600ms deadline
      return texts.map(fakeEmbed);
    },
  };
  const slowRecall = new RecallService(store, { ...settings, timeoutMs: 600 }, slowProvider);
  const t0 = Date.now();
  const slowHits = await slowRecall.search("pnpm manage dependencies unpackaged widgets", { maxResults: 3 });
  const elapsed = Date.now() - t0;
  check("slow embedding returns within the recall deadline", elapsed < 1500, `elapsed=${elapsed}ms`);
  check("slow embedding keeps the successful keyword hit", slowHits.some((h) => h.id === m2.id), JSON.stringify(slowHits.map((h) => h.id)));
  check("slow embedding returns non-empty results", slowHits.length > 0);
}

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
