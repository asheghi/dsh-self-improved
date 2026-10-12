const repo = new URL(".", import.meta.url).pathname;
const built = (m) => import(`${repo}../lib/${m}.js`);
const { installRecallInjection } = await built("inject");
const handlers = {};
const calls = [];
installRecallInjection(
  { on: (name, fn) => { handlers[name] = fn; } },
  { search: async (...a) => { calls.push(a); return [{ id: "h1", kind: "fact", content: "c", importance: 7, score: 1 }]; }, searchOperational: () => [] },
  { enabled: () => true, maxHits: 5, maxChars: 400, sessionIdOf: () => "ax", projectKeyOf: () => "px" },
);
const query = () => ({ kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "what is the secret project name" }], source: { kind: "user" } }] });
const first = await handlers["agent/pre-step"]({ agent: { id: "ax" }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, query);
const msgs = first.messages.map((m) => ({ role: m.role, kind: m.source?.kind, form: m.source?.form }));
console.log("search calls:", JSON.stringify(calls.map(([q, o]) => ({ q: q.slice(0, 30), o }))));
console.log("messages:", JSON.stringify(msgs));
