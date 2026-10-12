// ── Independent Phase A review probes ─────────────────────────────────────────
// Uses genuine rc.2 runtime classes + the built plugin artifact. README of
// results is printed; nothing is asserted here (findings stay evidence-based).
const repo = new URL(".", import.meta.url).pathname;
const built = (m) => import(`${repo}../lib/${m}.js`);

// rc.2 runtime (bare imports resolve through the rc.2 symlinks in scratch-review/node_modules)
const dshSession = await import("@deepseek-ai/dsh-session");
const dshLlm = await import("@deepseek-ai/dsh-llm");

const { installRecallInjection } = await built("inject");
const { installCapture, toSlice } = await built("capture");
const { createRecallContextMessage } = await built("compat-v02");

let n = 0;
const out = (name, value) => console.log(`[probe${++n}] ${name}:`, value);

// ── P1: repeat-turn re-admission — does it accumulate in derived history? ──
{
  const session = dshSession.Session.create("acc-session");
  const claimed = dshLlm.createUserMessage({
    content: [{ type: "text", text: "topic A" }],
    source: { kind: "user" },
  });
  // turn 1: loop admits decision.messages (+ the plugin's recall snapshot)
  for (const message of [claimed, createRecallContextMessage("RECALL v1")]) {
    session.append("user/message", message, { surfaceOp: "append" }); // exactly agent-loop line 1061
  }
  const after1 = session.deriveMessages().filter((m) => m.source?.kind === "dsh-self-improved").length;
  // turn 2 (identical query): cached trusted block → re-admitted as snapshot
  for (const message of [claimed, createRecallContextMessage("RECALL v1")]) {
    session.append("user/message", message, { surfaceOp: "append" });
  }
  const after2 = session.deriveMessages().filter((m) => m.source?.kind === "dsh-self-improved").length;
  out("P1 recall snapshots in derived history after turn 1 / turn 2 (identical repeats)", { after1, after2, total: session.deriveMessages().length });
}

// ── P2: harness runtime-context snapshot suppresses recall-query extraction ──
{
  const handlers = {};
  installRecallInjection(
    { on: (name, fn) => { handlers[name] = fn; } },
    { async search() { handlers.__searched = (handlers.__searched ?? 0) + 1; return [{ id: "h1", kind: "fact", content: "c", importance: 7, score: 1 }]; }, searchOperational: () => [] },
    { enabled: () => true, maxHits: 5, maxChars: 2000, sessionIdOf: () => "s", projectKeyOf: () => "p" },
  );
  const claimed = {
    role: "user",
    content: [{ type: "text", text: "genuine human request" }],
    source: { kind: "user" },
  };
  const runtimeContextSnapshot = {
    role: "user",
    content: [{ type: "text", text: "Current runtime context: …" }],
    source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "ctx", text: "…" }] },
  };
  // exact rc.2 decision shape: [...claimed, context?]  (agent-loop preStep)
  const decision = { kind: "enter", messages: [claimed, runtimeContextSnapshot] };
  const outDecision = await handlers["agent/pre-step"](
    { agent: { id: "a" }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => decision,
  );
  out("P2 searches when the harness runtime-context snapshot follows the user turn", {
    searches: handlers.__searched ?? 0,
    appendedPluginMessage: outDecision.messages.some((m) => m.source?.kind === "dsh-self-improved"),
  });
}

// ── P3: rc.2 subagent delegation prompts are typed kind:"user" ──
{
  const handlers = {};
  installRecallInjection(
    { on: (name, fn) => { handlers[name] = fn; } },
    { async search() { handlers.__searched = (handlers.__searched ?? 0) + 1; return []; }, searchOperational: () => [] },
    { enabled: () => true, maxHits: 5, sessionIdOf: () => "s", projectKeyOf: () => "p" },
  );
  // exact shape dsh-subagent/lib/index.js:1739 admits for a model-authored delegation prompt
  const delegationPrompt = {
    role: "user",
    content: [{ type: "text", text: "model-authored delegation task" }],
    source: { kind: "user" },
  };
  await handlers["agent/pre-step"](
    { agent: { id: "a" }, messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    async () => ({ kind: "enter", messages: [delegationPrompt] }),
  );
  out("P3 recall searches triggered by a model-authored delegation prompt (kind user)", handlers.__searched ?? 0);
}

// ── P4: stale trusted cache replays after a forget between identical queries ──
{
  const { MemoryStore } = await built("storage");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-review-")), "store");
  const store = new MemoryStore(dir);
  const rec = store.insertMemory({ kind: "fact", content: "the secret project name is quokka", importance: 8 }, { provenance: "user" });
  const { RecallService } = await built("recall");
  const recallSvc = new RecallService(store, { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, relevanceMargin: 1, minImportance: 0 }, null);
  const handlers = {};
  const injected = [];
  installRecallInjection(
    { on: (name, fn) => { handlers[name] = fn; } },
    { async search() { return recallSvc.search(...arguments); }, searchOperational: () => [] },
    { enabled: () => true, maxHits: 5, maxChars: 400, sessionIdOf: () => "sx", projectKeyOf: () => "px", onInjected: (ids) => injected.push(...ids) },
  );
  const query = () => ({
    kind: "enter",
    messages: [{ role: "user", content: [{ type: "text", text: "what is the secret project name" }], source: { kind: "user" } }],
  });
  const first = await handlers["agent/pre-step"]({ agent: { id: "a" }, messages: [], turn: 1, step: 1, signal: new AbortController().signal }, query);
  const firstBlock = first.messages.find((m) => m.source?.kind === "dsh-self-improved")?.content?.[0]?.text ?? "(none)";
  store.forgetMemory(rec.id);
  const second = await handlers["agent/pre-step"]({ agent: { id: "a" }, messages: [], turn: 2, step: 1, signal: new AbortController().signal }, query);
  const secondBlock = second.messages.find((m) => m.source?.kind === "dsh-self-improved")?.content?.[0]?.text ?? "(none)";
  out("P4 trusted block after forget on the identical repeat query (cachedChained or cleaned?)", { same: firstBlock === secondBlock, block: secondBlock.slice(0, 120) });
  rmSync(dir, { recursive: true, force: true });
}

// ── P5: genuine rc.2 Session + capture flush (fork-cut, seq zero, real event envelope) ──
{
  const { MemoryStore } = await built("storage");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-review-")), "store");
  const store = new MemoryStore(dir);

  const mkMsg = (text, kind) => ({ content: [{ type: "text", text }], source: { kind } });
  // fork child with an inherited prefix of 2 events
  const seed = [
    { type: "turn/start", seq: 0, time: 1, data: { turn: 0 } },
    { type: "user/message", seq: 1, time: 2, data: mkMsg("inherited parent request", "user"), surfaceOp: "append" },
  ];
  let session;
  try {
    session = dshSession.Session.create("fork-child", seed, { id: "fork-child", cwd: "/tmp/proj-x", formatVersion: 3, lineage: {}, inheritedCount: 2 }, 2);
  } catch (error) {
    out("P5.Session.create(header) shape rejected", String(error).slice(0, 300));
    process.exit(0);
  }
  // append own events on the genuine_CLASS session
  for (const message of [mkMsg("own child request", "user")]) {
    session.append("user/message", message, { surfaceOp: "append" });
  }
  const flushes = [];
  installCapture(
    { on: (name, fn) => flushes.push(fn) },
    store,
    { enabled: () => true },
    null,
    { enabled: () => true, maxChars: () => 800 },
  );
  await flushes[0](session);
  const slices = store.readSlices("fork-child", -1, 1e9);
  out("P5 captured slices on a genuine forked rc.2 Session", {
    inherited: session.inheritedEventCount,
    sliceSeqs: slices.map((s) => s.seq),
    texts: slices.map((s) => s.text.slice(0, 40)),
  });
  rmSync(dir, { recursive: true, force: true });
}
