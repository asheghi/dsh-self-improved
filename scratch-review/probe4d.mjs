const repo = new URL(".", import.meta.url).pathname;
const built = (m) => import(`${repo}../lib/${m}.js`);
const { MemoryStore } = await built("storage");
const { RecallService, renderRecallBlock } = await built("recall");
const { installRecallInjection } = await built("inject");
const { mkdtempSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const dir = join(mkdtempSync(join(tmpdir(), "dsi-review-")), "store");
const store = new MemoryStore(dir);
store.insertMemory({ kind: "fact", content: "the secret project name is quokka", importance: 8 }, { provenance: "user" });
const svc = new RecallService(store, { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, relevanceMargin: 1, minImportance: 0 }, null);
const hits = await svc.search("what is the secret project name", { maxResults: 5, projectId: "px", excludeSessionId: "ax" });
console.log("direct hits:", hits.length, hits[0]?.score, JSON.stringify(hits[0]?.content?.slice(0, 30)));
const block = renderRecallBlock(hits, 5);
console.log("direct rendered block len:", block.length, "|", JSON.stringify(block.slice(0, 80)));
const handlers = {};
const calls = [];
installRecallInjection(
  { on: (name, fn) => { handlers[name] = fn; } },
  { search: (q, o) => { calls.push(o); return svc.search(q, o); }, searchOperational: () => [] },
  { enabled: () => true, maxHits: 5, maxChars: 400, sessionIdOf: () => "ax", projectKeyOf: () => "px" },
);
const query = () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "what is the secret project name" }], source: { kind: "user" } }] });
const first = await handlers["agent/pre-step"]({ agent: { id: "ax" }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, query);
console.log("inject search opts:", JSON.stringify(calls));
console.log("injected msgs:", JSON.stringify(first.messages.map((m) => m.source?.kind)));
rmSync(dir, { recursive: true, force: true });
