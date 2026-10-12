const repo = new URL(".", import.meta.url).pathname;
const built = (m) => import(`${repo}../lib/${m}.js`);
const { MemoryStore } = await built("storage");
const { RecallService } = await built("recall");
const { installRecallInjection } = await built("inject");
const { mkdtempSync, rmSync } = await import("node:fs");
const { join } = await import("node:path");
const { tmpdir } = await import("node:os");
const dir = join(mkdtempSync(join(tmpdir(), "dsi-review-")), "store");
const store = new MemoryStore(dir);
store.insertMemory({ kind: "fact", content: "the secret project name is quokka", importance: 8 }, { provenance: "user" });
const svc = new RecallService(store, { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, relevanceMargin: 1, minImportance: 0 }, null);
const handlers = {};
installRecallInjection(
  { on: (name, fn) => { handlers[name] = fn; } },
  { search: (q, o) => svc.search(q, o), searchOperational: () => [] },
  { enabled: () => true, maxHits: 5, maxChars: 400, sessionIdOf: () => "ax", projectKeyOf: () => "px" },
);
const query = () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "what is the secret project name" }], source: { kind: "user" } }] });
try {
  const first = await handlers["agent/pre-step"]({ agent: { id: "ax" }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, query);
  const firstMsg = first.messages.find((m) => m.source?.kind === "dsh-self-improved");
  const firstBlock = firstMsg?.content?.[0]?.text ?? "(none)";
  console.log("first block present:", firstBlock !== "(none)");
  const mems = store.listMemories({ limit: 5 });
  const memId = mems[0].id;
  store.forgetMemory(memId);
  const second = await handlers["agent/pre-step"]({ agent: { id: "ax" }, messages: [], turn: 2, step: 1, signal: new AbortController().signal }, query);
  const secondMsg = second.messages.find((m) => m.source?.kind === "dsh-self-improved");
  const secondBlock = secondMsg?.content?.[0]?.text ?? "(none)";
  console.log("after forget, identical repeat query block:", secondBlock === "(none)" ? "NOT re-injected (fresh)" : "STALE/CACHED replay", "| same as first:", secondBlock === firstBlock, "|", secondBlock.slice(0, 100));
  const freshSessionDecisionMirror = second; void freshSessionDecisionMirror;
} catch (e) {
  console.log("handler error:", String(e));
}
rmSync(dir, { recursive: true, force: true });
