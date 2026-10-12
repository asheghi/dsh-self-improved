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
console.log("sanity block len (500 cap fits?):", renderRecallBlock([{}] && (await svc.search("what is the secret project name", { maxResults: 5, projectId: "px", excludeSessionId: "ax" })), 5).length);
const handlers = {};
installRecallInjection(
  { on: (name, fn) => { handlers[name] = fn; } },
  { search: (q, o) => svc.search(q, o), searchOperational: () => [] },
  { enabled: () => true, maxHits: 5, maxChars: 1000, sessionIdOf: () => "ax", projectKeyOf: () => "px" },
);
const query = () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "what is the secret project name" }], source: { kind: "user" } }] });
const run = (turn) => handlers["agent/pre-step"]({ agent: { id: "ax" }, messages: [], turn, step: 1, signal: new AbortController().signal }, query);
const first = await run(1);
const firstBlock = first.messages.find((m) => m.source?.kind === "dsh-self-improved")?.content?.[0]?.text ?? "(none)";
store.forgetMemory(store.listMemories({ limit: 5 })[0].id);
const second = await run(2);
const secondBlock = second.messages.find((m) => m.source?.kind === "dsh-self-improved")?.content?.[0]?.text ?? "(none)";
console.log("first injected:", firstBlock !== "(none)", "| verdict:", secondBlock === "(none)" ? "fresh recompute (correct)" : "STALE cached replay after forget", secondBlock === firstBlock ? "" : "(but different text)");
rmSync(dir, { recursive: true, force: true });
