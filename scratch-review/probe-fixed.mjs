// P1-fixed: run the REAL injection handler for two identical turns, admit each
// decision into a GENUINE rc.2 Session the way dsh-agent-loop step() does, then
// count plugin snapshots in deriveMessages().
const repo = new URL(".", import.meta.url).pathname;
const built = (m) => import(`${repo}../lib/${m}.js`);
const { Session } = await import("@deepseek-ai/dsh-session");
const { installRecallInjection } = await built("inject");
const handlers = {};
let opsEnabled = false;
installRecallInjection(
  { on: (name, fn) => { handlers[name] = fn; } },
  {
    async search() { return [{ id: "h1", kind: "fact", content: "stable content", importance: 7, score: 1 }]; },
    searchOperational: () => (opsEnabled ? [{ id: "op1", kind: "lesson", content: "updated fence", confidence: 0.9 }] : []),
  },
  { enabled: () => true, maxHits: 5, maxChars: 4000, sessionIdOf: () => "sx", projectKeyOf: () => "px",
    operational: { enabled: () => opsEnabled, maxResults: 2, maxChars: 600, confidenceFloor: 0.8 } },
);
const session = Session.create("acc-fixed");
const claimed = { id: "m", role: "user", content: [{ type: "text", text: "topic A" }], source: { kind: "user" } };
const runTurn = async (turn) => {
  const decision = await handlers["agent/pre-step"](
    { agent: { id: "sx" }, messages: [claimed], turn, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [claimed] }),
  );
  for (const message of decision.messages) session.append("user/message", message, { surfaceOp: "append" }); // agent-loop step()
};
await runTurn(1);
await runTurn(2);
const after2 = session.deriveMessages().filter((m) => m.source?.kind === "dsh-self-improved").length;
opsEnabled = true;
await runTurn(3);
const after3 = session.deriveMessages().filter((m) => m.source?.kind === "dsh-self-improved").length;
console.log("[P1-fixed] plugin snapshots in derived history after 2 identical turns / after a fence change:", { after2, after3, expected: "1 then 2" });
