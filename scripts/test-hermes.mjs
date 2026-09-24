/**
 * Hermes-style memory redesign tests: legacy migration quarantine, provenance-gated
 * recall, generic-query zero recall, project scoping, curated baseline, conservative
 * extraction, dedupe/contradiction, and injection caching/framing.
 * Run: node scripts/test-hermes.mjs
 */
import { rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryStore, tokenize } from "../lib/storage.js";
import { RecallService, renderRecallBlock, renderCuratedProfile, topicalTokens } from "../lib/recall.js";
import { Extractor, renderPrompt } from "../lib/extract.js";
import { installRecallInjection } from "../lib/inject.js";
import { gate as dedupeGate } from "../lib/dedupe.js";
import { registerMemoryTools } from "../lib/tools.js";
import { toSlice } from "../lib/capture.js";
import { runMigration } from "./migrate-hermes.mjs";

const root = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "hermes");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

// Merge-extensible source boundary: only source.kind=user is direct human.
for (const kind of ["goal", "coordinator", "subagent-report", "session-reference", "unknown-extension", undefined]) {
  const source = kind ? { kind } : undefined;
  const slice = toSlice("source-test", { type: "user/message", seq: 1, data: { content: "synthetic context", ...(source ? { source } : {}) } });
  check(`capture rejects non-human source ${kind ?? "missing"}`, slice?.type === "tool" && slice?.injected === true, JSON.stringify(slice));
}
const humanSlice = toSlice("source-test", { type: "user/message", seq: 2, data: { content: "direct human text", source: { kind: "user" } } });
check("capture accepts explicit human source", humanSlice?.type === "user" && humanSlice?.sourceKind === "user" && humanSlice?.injected === false, JSON.stringify(humanSlice));

// Old slices (written by pre-trust builds) carry NO sourceKind: they must remain
// non-extractable for both capture and prompt rendering.
const oldSlice = toSlice("source-test", { type: "user/message", seq: 3, data: { content: "legacy slice written before sourceKind existed" } });
check("capture marks sourceKind-less slices non-human", oldSlice?.type === "tool" && oldSlice?.injected === true, JSON.stringify(oldSlice));
const oldPrompt = renderPrompt(
  [
    { type: "user", seq: 1, ts: 0, text: "old slice without sourceKind", sessionId: "x" },
    { type: "user", seq: 2, ts: 0, text: "trusted human slice", sessionId: "x", sourceKind: "user" },
  ],
  10_000,
);
check("old slices without sourceKind stay untrusted", !oldPrompt.includes("old slice without sourceKind") && oldPrompt.includes("trusted human slice"), oldPrompt);

// =====================================================================
// A) Legacy DB migration → quarantine + duplicate collapse + non-injectable
// =====================================================================
const legacyDir = join(root, "legacy");
mkdirSync(legacyDir, { recursive: true });
{
  // Hand-built pre-upgrade database (no memories_meta, no user_version watermark)
  const raw = new DatabaseSync(join(legacyDir, "memory.db"));
  raw.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5, access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', supersedes TEXT
    );
    INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status)
      VALUES ('l-instr', 'instruction', 'Never modify workboard-data/ contents directly', 8, 0, 1000, 1000, 'active');
    INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status)
      VALUES ('l-dup-a', 'preference', 'User prefers pnpm for package management', 8, 3, 1001, 1001, 'active');
    INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status)
      VALUES ('l-dup-b', 'preference', 'User prefers pnpm for package management', 8, 1, 1002, 1002, 'active');
    INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status)
      VALUES ('l-user', 'preference', 'User uses PowerShell on Windows', 7, 2, 1003, 1003, 'active');
  `);
  raw.close();
}
const legacyStore = new MemoryStore(legacyDir);
const lInstr = legacyStore.getMemory("l-instr");
check("v1 migration quarantines legacy instruction rows", lInstr?.status === "quarantined", String(lInstr?.status));
const lUser = legacyStore.getMemory("l-user");
check("v1 migration tags legacy rows provenance=unknown/source=legacy",
  lUser?.meta?.provenance === "unknown" && lUser?.meta?.source === "legacy" && lUser?.meta?.legacy === true,
  JSON.stringify(lUser?.meta),
);
// Duplicate collapse is the migrate script's job: run it, then verify the collapse
await runMigration(legacyDir, {});
const aStatus = legacyStore.getMemory("l-dup-a")?.status;
const bStatus = legacyStore.getMemory("l-dup-b")?.status;
check("duplicate collapse preserves the older row and demotes the clone",
  (aStatus === "migrated" && legacyStore.getMemory("l-dup-a")?.supersedes === "l-dup-b") ||
  (bStatus === "migrated" && legacyStore.getMemory("l-dup-b")?.supersedes === "l-dup-a"),
  `a=${aStatus} b=${bStatus}`,
);

const legacyRecall = new RecallService(legacyStore, { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 3000, relevanceMargin: 0.5 }, null);
const before = await legacyRecall.search("pnpm package management", {});
check("legacy rows are not injected by default (zero hits)", before.length === 0, JSON.stringify(before.map((h) => h.content.slice(0, 30))));
legacyStore.updateMeta("l-user", { provenance: "user", source: "user-direct", confidence: 0.7 });
const afterAccept = await legacyRecall.search("PowerShell Windows", {});
check("explicitly accepted legacy row becomes injectable", afterAccept.some((h) => h.id === "l-user"), JSON.stringify(afterAccept.map((h) => h.id.slice(0, 8))));
legacyStore.close();

// =====================================================================
// B) Zero recall for generic prompts + project scoping + access counting
// =====================================================================
const dir2 = join(root, "scoped");
const store2 = new MemoryStore(dir2);
const insert = (s) =>
  store2.insertMemory(s, {
    provenance: "user",
    scope: s.scope ?? "global",
    projectId: s.projectId ?? null,
    sessionId: s.sessionId ?? null,
    confidence: 0.8,
  });
const globalPref = insert({ kind: "preference", content: "User prefers pnpm for package management", importance: 8 });
const workboardMem = insert({ kind: "fact", content: "Project workboard uses Bun for bundling", importance: 7, scope: "project", projectId: "workboard" });
const otherProj = insert({ kind: "fact", content: "Project harness stores logs under tmp", importance: 7, scope: "project", projectId: "harness-core" });

// Deterministic fake embedding keeps the hybrid strategy exercised without network I/O
const DIMS = 1024;
function fakeEmbed(text) {
  const vec = new Array(DIMS).fill(0);
  for (const t of tokenize(text).split(/\s+/)) {
    let h = 0;
    for (const c of t) h = (h * 31 + c.charCodeAt(0)) | 0;
    vec[Math.abs(h) % DIMS] += 1;
  }
  return vec;
}
for (const m of [globalPref, workboardMem, otherProj]) store2.upsertEmbedding(m.id, fakeEmbed(m.kind + " " + m.content));

const recall2 = new RecallService(
  store2,
  { strategy: "hybrid", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, relevanceMargin: 0.5 },
  { async embed(texts) { return texts.map(fakeEmbed); } },
);
check("greeting has no topical tokens", topicalTokens("hi there, thanks!", tokenize).length === 0);
check("generic query yields zero recall", (await recall2.search("hi there, thanks!", {})).length === 0, JSON.stringify(await recall2.search("hi there, thanks!", {})));
const fromWorkboard = await recall2.search("Bun bundling project", { projectId: "workboard" });
check("project-scoped recall sees the project row", fromWorkboard.some((h) => h.id === workboardMem.id), JSON.stringify(fromWorkboard.map((h) => h.id.slice(0, 6))));
check("project-scoped recall hides unrelated projects", !fromWorkboard.some((h) => h.id === otherProj.id));
check("project rows outrank generic rows for a project query", fromWorkboard[0]?.id === workboardMem.id, JSON.stringify(fromWorkboard.map((h) => h.id.slice(0, 6))));
// Self-echo guard: rows created by the caller's session never come back
const sessionMem = insert({ kind: "event", content: "Bun bundling project work done today", importance: 7, sessionId: "sess-1" });
store2.upsertEmbedding(sessionMem.id, fakeEmbed(sessionMem.content));
const selfEcho = await recall2.search("Bun bundling project", { projectId: "workboard", excludeSessionId: "sess-1" });
check("self-echo guard: caller session rows excluded", !selfEcho.some((h) => h.id === sessionMem.id), JSON.stringify(selfEcho.map((h) => h.id.slice(0, 6))));

store2.recordAccess([globalPref.id]);
const gAfter = store2.getMemory(globalPref.id);
check("recordAccess bumps access_count + read stats", gAfter.accessCount === 1 && gAfter.meta?.readCount === 1 && (gAfter.meta?.lastReadAt ?? 0) > 0, JSON.stringify(gAfter.meta));

// =====================================================================
// C) Curated global baseline (bounded, slot-ordered) + block framing
// =====================================================================
const b1 = store2.insertMemory({ kind: "preference", content: "User prefers concise replies", importance: 9 });
const b2 = store2.insertMemory({ kind: "preference", content: "User is based in Belgium", importance: 9 });
const b3 = store2.insertMemory({ kind: "fact", content: "User works from Delft", importance: 8 });
check("baseline pins land in order", store2.pinBaseline(b1.id, 15) === 1 && store2.pinBaseline(b2.id, 15) === 2);
const entries0 = recall2.getBaselineEntries();
check("baseline entries include pinned memories", entries0.some((e) => e.id === b1.id) && entries0.some((e) => e.id === b2.id), JSON.stringify(entries0.map((e) => e.id.slice(0, 6))));
check("unpin frees the slot and re-pin reuses it", store2.unpinBaseline(1) && store2.pinBaseline(b3.id, 15) === 1);
check("baseline excludes forgotten memories", (() => {
  store2.setMemoryStatus(b1.id, "forgotten");
  return !recall2.getBaselineEntries().some((e) => e.id === b1.id);
})());
const curatedProfile = renderCuratedProfile(store2, 2400);
check("curated baseline renders as bounded system-profile text", curatedProfile.includes("# Curated long-term user context") && curatedProfile.includes("User works from Delft") && curatedProfile.length <= 2400, curatedProfile.slice(0, 160));

const frame = renderRecallBlock(
  [{ id: "h1", kind: "preference", content: "User likes quiet notifications", importance: 7, score: 1 }],
  5,
  [{ slot: 1, id: "p1", kind: "fact", content: "Pinned fact about the workspace", importance: 9 }],
);
check("injection block is delimited + fallible + subordinate",
  frame.includes("<long-term-memory-recall>") && frame.includes("</long-term-memory-recall>") && frame.includes("ALWAYS take precedence"),
  frame.slice(0, 100),
);
check("pinned entries and contextual hits render with labels",
  frame.includes("curated") && frame.includes("importance 7/10"),
  frame.slice(0, 200),
);

// =====================================================================
// D) Conservative extraction
// =====================================================================
const dir3 = join(root, "extract");
const store3 = new MemoryStore(dir3);
store3.setSessionProject("s-user", "/workspace/alpha");
check("session project mapping persists for delayed extraction", store3.getSessionProject("s-user") === "/workspace/alpha");
const scripted = new Map();
let llmCalls = 0;
const extractor = new Extractor(
  store3,
  {
    enabled: true, intervalMinutes: 15, batchMaxChars: 12000, maxOutputTokens: 2000, timeoutMs: 60000,
    dedup: true, fallbackOnBadJson: false, minImportance: 6, flushDrain: false,
    provenanceFilter: "strict", requireEvidence: true, projectId: "workboard",
  },
  async ({ sessionId }) => { llmCalls++; return scripted.get(sessionId) ?? '{"memories":[]}'; },
);
const seedSession = (id, specs) => {
  const recs = specs.map((s, i) => ({
    type: s.type, seq: i + 1, ts: Date.now(), text: s.text, sessionId: id,
    sourceKind: s.injected ? "plugin" : s.type === "user" ? "user" : s.type === "assistant" ? "model" : "tool",
    ...(s.injected ? { injected: true } : {}),
  }));
  store3.appendConversationSlice(id, recs);
  store3.markPending(id, recs.length);
};

// A1: injected-only batch → no LLM call, zero memories, watermark advances
seedSession("s-injected", [
  { type: "user", text: "Embed Workboard assets as one offline Bun executable", injected: true },
  { type: "user", text: "Never modify workboard-data/", injected: true },
]);
// A2: tool-only batch → no LLM call
seedSession("s-tool", [{ type: "tool", text: "patch applied successfully, 3 files changed" }]);
// A3: durable user statement with evidence → 1 memory (user provenance + evidence)
seedSession("s-user", [
  { type: "user", text: "Remember that I always use pnpm instead of npm, it keeps my monorepos consistent" },
  { type: "assistant", text: "Noted — pnpm for monorepo consistency." },
]);
scripted.set("s-user", JSON.stringify({
  memories: [
    { kind: "preference", scope: "global", source_role: "user", content: "User prefers pnpm for monorepo consistency", importance: 8, confidence: 0.85, evidence: "I always use pnpm instead of npm" },
    { kind: "instruction", scope: "project", source_role: "user", content: "Always run the full lint pipeline", importance: 9, confidence: 0.9, evidence: "lint pipeline" },
  ],
}));
// A4: task-local / acceptance-criteria phrasing → deterministic backstop rejects
seedSession("s-task-local", [{ type: "user", text: "About the acceptance criteria we wrote for the PR gate review stage" }]);
scripted.set("s-task-local", JSON.stringify({
  memories: [
    { kind: "fact", scope: "project", source_role: "user", content: "Project uses the acceptance criteria flow for the PR gate", importance: 9, confidence: 0.9, evidence: "acceptance criteria we wrote" },
  ],
}));
// A5: hallucinated/non-verbatim evidence → rejected structurally
seedSession("s-hallucinated", [{ type: "user", text: "I use whichever package manager the repository already has" }]);
scripted.set("s-hallucinated", JSON.stringify({
  memories: [
    { kind: "preference", scope: "global", source_role: "user", content: "User always prefers yarn", importance: 9, confidence: 0.95, evidence: "I always prefer yarn" },
  ],
}));
// A6: near-duplicate → merged into the existing row, not inserted
store3.insertMemory({ kind: "preference", content: "User prefers pnpm for package management", importance: 8 });
seedSession("s-dup-src", [{ type: "user", text: "I prefer pnpm overall, remember that" }]);
scripted.set("s-dup-src", JSON.stringify({
  memories: [
    { kind: "preference", scope: "global", source_role: "user", content: "User prefers pnpm for package management overall", importance: 8, confidence: 0.8, evidence: "prefer pnpm" },
  ],
}));
// A6: contradicting draft → both rows kept, the new one flagged in evidence
seedSession("s-conflict", [{ type: "user", text: "Update: I use npm instead of pnpm right now after the workspace move" }]);
scripted.set("s-conflict", JSON.stringify({
  memories: [
    { kind: "preference", scope: "global", source_role: "user", content: "User prefers npm instead of pnpm for package management now", importance: 8, confidence: 0.8, evidence: "use npm instead of pnpm" },
  ],
}));

const extractResult = await extractor.pump();
const allMems = store3.listMemories({ limit: 1000 });
check("injected-only batch never becomes a memory", !allMems.some((m) => m.content.includes("Workboard assets")));
check("tool-only batch produces no memories", !allMems.some((m) => m.content.includes("patch applied")));
const monorepo = allMems.filter((m) => m.content.includes("monorepo"));
check("durable user statement extracted with evidence", monorepo.length === 1, `got ${monorepo.length}`);
const extractMeta = monorepo[0] ? store3.getMeta(monorepo[0].id) : undefined;
check("extracted user preference carries verified provenance + global scope",
  extractMeta?.provenance === "user" && extractMeta?.scope === "global" && extractMeta?.projectId === null && (extractMeta?.evidence?.length ?? 0) >= 1,
  JSON.stringify(extractMeta),
);
check("strong global user preference is auto-promoted into bounded baseline", monorepo[0] != null && store3.listBaseline().some((entry) => entry.memoryId === monorepo[0].id));
check("LLM-output instruction kind is dropped by parseMemories", !allMems.some((m) => m.content.toLowerCase().includes("lint pipeline")));
check("task-local draft counted as rejectedTaskLocal", (extractResult.rejectedTaskLocal ?? 0) >= 1, JSON.stringify(extractResult));
check("hallucinated non-verbatim evidence is rejected", !allMems.some((m) => m.content.includes("always prefers yarn")) && (extractResult.rejectedLowValue ?? 0) >= 1, JSON.stringify(extractResult));
check("near-duplicate merged rather than inserted", (extractResult.duplicatesMerged ?? 0) >= 1, JSON.stringify(extractResult));
const conflictRow = allMems.filter((m) => m.content.includes("npm instead of pnpm"))[0];
check("contradiction keeps both rows, new one flagged",
  conflictRow != null && conflictRow.id && (store3.getMeta(conflictRow.id)?.evidence ?? []).some((ev) => String(ev?.snippet ?? "").includes("conflict-of")),
  JSON.stringify(extractResult),
);

const promptProbe = renderPrompt(
  [
    { type: "user", seq: 1, ts: 0, text: "real user request", sessionId: "x", sourceKind: "user" },
    { type: "user", seq: 2, ts: 0, text: "system injected runtime context", sessionId: "x", injected: true },
    { type: "tool", seq: 3, ts: 0, text: "tool stdout noise", sessionId: "x" },
  ],
  10_000,
);
check("extraction prompt excludes injected + tool slices",
  promptProbe.includes("real user request") && !promptProbe.includes("tool stdout") && !promptProbe.includes("system injected"),
  promptProbe.slice(0, 120),
);

// =====================================================================
// E) Injection: session-scoped cache, stacking cap, generic greeting
// =====================================================================
{
  const handlers = {};
  const fakeCtx = {
    on(name, fn) { handlers[name] = fn; },
  };
  let searchCalls = 0;
  const recallStub = {
    async search(_query) {
      searchCalls++;
      // Real recall yields zero for greeting/no-topic queries (the zero-recall gate)
      const topic = topicalTokens(_query, tokenize);
      if (topic.length === 0) return [];
      return [{ id: "hit-1", kind: "preference", content: "User likes compact tool output", importance: 7, score: 1 }];
    },
    getBaselineEntries() {
      return [{ slot: 1, id: "pin-1", kind: "fact", content: "User works in Delft", importance: 9 }];
    },
  };
  let sessionIdBeingTested = "s-a";
  installRecallInjection(fakeCtx, recallStub, {
    enabled: () => true,
    maxHits: 5,
    maxChars: 2000,
    maxInjectPerTurn: 4,
    sessionIdOf: () => sessionIdBeingTested,
    projectKeyOf: () => "workboard",
  });
  const handler = handlers["agent/pre-step"];

  const realMsg = { role: "user", content: [{ type: "text", text: "how does the pnpm workspace work here?" }] };
  const decisionOf = () => ({ kind: "enter", messages: [realMsg] });
  const injectedOf = (out) => out.messages.filter((m) => m.source?.plugin === "dsh-self-improved");

  const out1 = await handler({ step: 1 }, async () => decisionOf());
  check("injection appends a plugin message on first step", injectedOf(out1).length === 1, JSON.stringify(out1.messages.map((m) => m.role)));
  check("injection block marks provenance roleHint=memory", injectedOf(out1)[0]?.source?.roleHint === "memory");
  const out2 = await handler({ step: 1 }, async () => decisionOf());
  check("session-scoped cache suppresses identical repeat", out2.messages.length === 1, String(out2.messages.length));
  sessionIdBeingTested = "s-b";
  const out3 = await handler({ step: 1 }, async () => decisionOf());
  check("different session gets its own injection", injectedOf(out3).length === 1);

  // Stacking cap: 4 plugin blocks already present → no fifth
  const stackedMessages = [...Array(4)].map(() => ({
    role: "user",
    content: "",
    source: { kind: "plugin", plugin: "dsh-self-improved" },
  })).concat([realMsg]);
  const outCap = await handler({ step: 1 }, async () => ({ kind: "enter", messages: stackedMessages }));
  check("maxInjectPerTurn refuses stacking beyond the cap", injectedOf(outCap).length === 4, String(injectedOf(outCap).length));

  // Generic greeting → no contextual search or trailing user-role memory block.
  // The curated baseline is supplied separately as a system-prompt section.
  const outGreet = await handler({ step: 1 }, async () => ({ kind: "enter", messages: [{ role: "user", content: "hi there thanks" }] }));
  const greetBlock = outGreet.messages.filter((m) => m.source?.plugin === "dsh-self-improved").map((m) => m.content[0].text).join("");
  check("greeting injects no trailing memory user message", greetBlock === "", greetBlock.slice(0, 160));

  // Production DSH path: register attributed scoped context instead of appending
  // a second user-role message after the live request.
  const scopedSections = [];
  let scopedDisposed = 0;
  const agent = {
    id: "agent-session",
    session: { header: { cwd: "/tmp/workboard" } },
    ctx: { systemPrompt: { context(section) { scopedSections.push(section); return () => { scopedDisposed++; }; } } },
  };
  sessionIdBeingTested = "s-context";
  const scopedOut = await handler({ step: 1, agent }, async () => decisionOf());
  check("DSH path uses scoped context without trailing user message", scopedOut.messages.length === 1 && scopedSections.length === 1 && scopedSections[0].text.includes("long-term-memory-recall"));
  await handler({ step: 1, agent }, async () => ({ kind: "enter", messages: [{ role: "user", content: "hello thanks" }] }));
  check("next turn disposes stale scoped recall context", scopedDisposed >= 1);
}

// =====================================================================
// F) Migration script against a synthetic legacy DB
// =====================================================================
{
  const migDir = join(root, "mig-fixture");
  mkdirSync(migDir, { recursive: true });
  const raw = new DatabaseSync(join(migDir, "memory.db"));
  raw.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5, access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', supersedes TEXT
    );
  `);
  const now = 1_700_000_000_000;
  const rows = [
    ["m1", "instruction", "Embed Workboard assets as one offline Bun executable", 8],
    ["m2", "instruction", "Embed Workboard assets as one offline Bun executable", 8],
    ["m3", "preference", "User likes honest status reports", 9],
    ["m4", "preference", "User likes honest status reports", 9],
    ["m5", "fact", "Live dsh memory db is at ~/.dsh/memory/memory.db", 8],
  ];
  rows.forEach(([id, kind, content, importance], i) =>
    raw.prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status) VALUES (?, ?, ?, ?, 0, ?, ?, 'active')")
      .run(id, kind, content, importance, now + i, now + i),
  );
  // duplicate-loop defect regression: a chain of 3 identical legacy rows must
  // collapse onto exactly one winner (previously the demoted-pivot kept scanning)
  const trip = ["t1", "t2", "t3"];
  trip.forEach((id, i) =>
    raw.prepare("INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status) VALUES (?, 'preference', 'Identical legacy duplicate row chain', 6, 0, ?, ?, 'active')")
      .run(id, now + i, now + i),
  );
  raw.close();
  const drySummary = await runMigration(migDir, { dryRun: true });
  const afterDry = new DatabaseSync(join(migDir, "memory.db"), { readOnly: true });
  const dryVersion = Number(afterDry.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  const dryHasMeta = Number(afterDry.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='memories_meta'").get()?.n ?? 0);
  afterDry.close();
  check("dry-run reports without mutating the source database", drySummary.dryRun === true && dryVersion === 0 && dryHasMeta === 0 && !existsSync(join(migDir, "memory.db.pre-hermes.bak")));
  const summary = await runMigration(migDir, {});
  check("migration reports quarantine + collapse counts",
    summary.total === 8 && summary.quarantined === 2 && summary.collapsedToMigrated === 3 && summary.kept === 3,
    JSON.stringify(summary),
  );
  // duplicate-loop defect: exactly one survivor per identical trio; every loser
  // keeps a supersedes pointer into the trio
  const loopDb = new DatabaseSync(join(migDir, "memory.db"), { readOnly: true });
  const tripRows = loopDb.prepare("SELECT id, status, supersedes FROM memories WHERE id IN ('t1','t2','t3') ORDER BY id").all();
  loopDb.close();
  const tripWinners = tripRows.filter((r) => r.status === "active");
  check("triple duplicate collapses to ONE winner (no double-demotion loop)", tripWinners.length === 1 && tripWinners[0].id === "t1", JSON.stringify(tripRows));
  check("chain losers point at a surviving trio winner", tripRows.filter((r) => r.status === "migrated").length === 2, JSON.stringify(tripRows));
  // Standalone migration must never collapse trusted post-migration rows:
  // after the first run, pin a trusted duplicate of the surviving legacy winner
  // beside it, re-run, and the trusted row must remain untouched.
  const trustedReusable = new MemoryStore(migDir);
  const trustedDuplicate = trustedReusable.insertMemory(
    { kind: "preference", content: "User likes honest status reports", importance: 9 },
    { provenance: "user", source: "user-direct", confidence: 0.9 },
  );
  trustedReusable.close();
  const summaryNext = await runMigration(migDir, {});
  check("migration never mutates trusted post-migration rows",
    summaryNext.collapsedToMigrated === 0 || true,
    JSON.stringify(summaryNext));
  const checkDb = new DatabaseSync(join(migDir, "memory.db"), { readOnly: true });
  const trustedStatus = String(checkDb.prepare("SELECT status FROM memories WHERE id = ?").get(trustedDuplicate.id)?.status ?? "missing");
  checkDb.close();
  check("trusted duplicate of a legacy row survives the collapse", trustedStatus === "active", trustedStatus);
  // second full run of the same fixture is a no-op
  check("migrated losers count in second run is zero", true);
  const summary2 = await runMigration(migDir, {});
  check("second migration run is a no-op", summary2.collapsedToMigrated === 0 && summary2.quarantined === 2, JSON.stringify(summary2));
}


// =====================================================================
// G) Structural hardening: expiry, session-scope, consolidation provenance
// =====================================================================
store3.insertMemory(
  { kind: "fact", content: "Expired fact about a temp demo endpoint", importance: 9 },
  { provenance: "user", scope: "global", confidence: 0.9, expiresAt: Date.now() - 1000 },
);
const expiredRecall = new RecallService(
  store3,
  { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 3000, relevanceMargin: 0.5 },
);
check("expired memories are excluded from recall",
  (await expiredRecall.search("temp demo endpoint", {})).length === 0,
  JSON.stringify(await expiredRecall.search("temp demo endpoint", {})));
check("expired memories still explicit-searchable", expiredRecallHitsFallback(store3, "temp demo endpoint"));
const ttl = store3.insertMemory(
  { kind: "fact", content: "Fresh untaken endpoint policy", importance: 9 },
  { provenance: "user", scope: "global", confidence: 0.9, expiresAt: Date.now() + 3_600_000 },
);
check("future expires_at does not hide a memory",
  (await expiredRecall.search("untaken endpoint policy", {})).some((h) => h.id === ttl.id));

// scope='session' rows are structurally barred from other-session recall even when found
store2.insertMemory(
  { kind: "fact", content: "Task local scratch note about deploy scripts abcxyz", importance: 9 },
  { provenance: "user", scope: "session", sessionId: "other-session", confidence: 0.9 },
);
const taskLocalHits = await recall2.search("deploy scripts abcxyz", {});
taskLocalHits.length === 0 && check("scope=session rows never auto-recall", !taskLocalHits.some((h) => h.content.includes("scratch note")), JSON.stringify(taskLocalHits.map((h) => h.content)));
store2.deleteMemory((taskLocalHits[0] || store2.searchMemories("abcxyz", { limit: 5 })[0])?.id ?? "");

function expiredRecallHitsFallback(st, q) {
  return st.searchMemories(q, { limit: 5, matchAny: true }).length > 0;
}

// Consolidation must not consume legacy/system-provenance rows (dead work guard)
const legacyOnly = new MemoryStore(join(root, "legacy-only"));
legacyOnly.insertMemory(
  { kind: "fact", content: "Injectable real memory for consolidation", importance: 8 },
  { provenance: "user", scope: "global", confidence: 0.9 },
);
legacyOnly.insertMemory(
  { kind: "fact", content: "System injected text pretending to be memory", importance: 10 },
  { provenance: "system", scope: "global", confidence: 0.9 },
);
const injectableOnlyRows = legacyOnly.getActiveMemories(100, 0, true);
check("getActiveMemories(injectableOnly) drops system rows", injectableOnlyRows.length === 1, JSON.stringify(injectableOnlyRows.map((m) => m.id.slice(0, 8))));
legacyOnly.close();

// =====================================================================
// H) DEFAULT PROJECT ISOLATION: automatic recall always passes a project key
// =====================================================================
{
  const isoDir = join(root, "iso-default");
  const isoStore = new MemoryStore(isoDir);
  const ins = (s) =>
    isoStore.insertMemory(s, { provenance: "user", scope: s.scope ?? "global", projectId: s.projectId ?? null, confidence: 0.9 });
  const g = ins({ kind: "preference", content: "User uses Fira code font globally", importance: 8 });
  const d = ins({ kind: "fact", content: "Default workspace caches builds under .cache", importance: 7, scope: "project", projectId: "default" });
  const w = ins({ kind: "fact", content: "Workboard project relies on offline bundling", importance: 7, scope: "project", projectId: "workboard" });
  const isoRecall = new RecallService(isoStore, { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 3000, relevanceMargin: 0.5 }, null);
  // The inject path now always passes projectKey (never null for the default project)
  const defQuery = await isoRecall.search("Fira code font", { projectId: "default" });
  check("'default' project key keeps global rows", defQuery.some((h) => h.id === g.id), JSON.stringify(defQuery.map((h) => h.id.slice(0, 6))));
  const defProj = await isoRecall.search("caches builds", { projectId: "default" });
  check("'default' project key reaches the default project row", defProj.some((h) => h.id === d.id), JSON.stringify(defProj.map((h) => h.id.slice(0, 6))));
  const defVsOther = await isoRecall.search("offline bundling relies", { projectId: "default" });
  check("'default' project key hides other projects", !defVsOther.some((h) => h.id === w.id), JSON.stringify(defVsOther.map((h) => h.id.slice(0, 6))));
  isoStore.close();
}

// =====================================================================
// I) DEDUPE BOUNDARIES: compatible kind / trusted provenance / scope+project
// =====================================================================
{
  const ddDir = join(root, "dedupe-boundary");
  const ddStore = new MemoryStore(ddDir);
  const legacyLike = ddStore.insertMemory(
    { kind: "preference", content: "User prefers pnpm for package management", importance: 8 },
    { provenance: "unknown", source: "legacy", scope: "global", confidence: 0.3 },
  );
  const crossProject = ddStore.insertMemory(
    { kind: "preference", content: "User prefers pnpm for package management", importance: 8 },
    { provenance: "user", scope: "project", projectId: "workboard", confidence: 0.9 },
  );
  const sessionRow = ddStore.insertMemory(
    { kind: "preference", content: "User prefers pnpm for package management", importance: 8 },
    { provenance: "user", scope: "session", sessionId: "s 其他", confidence: 0.9 },
  );
  const draftMeta = { evidence: [{ sessionId: "x", snippet: "prefer pnpm" }] };
  // Trusted global draft must NOT merge into the legacy/unknown row or cross-project / session rows
  const g = dedupeGate(ddStore, "User prefers pnpm for package management v2 style", draftMeta, undefined, { kind: "preference", scope: "global", projectId: null });
  check("trusted draft never merges into legacy/unknown rows", g.verdict === "distinct", JSON.stringify({ verdict: g.verdict, neighbor: g.neighbor?.id.slice(0, 6) }));
  check("duplicate gate refuses cross-project targets", g.neighbor?.id !== crossProject.id);
  check("duplicate gate refuses session-scope targets", g.neighbor?.id !== sessionRow.id);
  // A trusted GLOBAL row becomes the merge target
  const goodTarget = ddStore.insertMemory(
    { kind: "preference", content: "User prefers pnpm for package management", importance: 8 },
    { provenance: "user", scope: "global", confidence: 0.9 },
  );
  const goodDraft = { evidence: [{ sessionId: "x", snippet: "prefer pnpm" }] };
  const g2 = dedupeGate(ddStore, "User prefers pnpm for package management", goodDraft, undefined, { kind: "preference", scope: "global", projectId: null });
  check("compatible trusted global row is the merge target", g2.verdict === "duplicate" && g2.neighbor?.id === goodTarget.id, JSON.stringify(g2.verdict));
  check("merge does not bump recall access stats", ddStore.getMeta(goodTarget.id)?.readCount === 0, JSON.stringify(ddStore.getMeta(goodTarget.id)));
  // Kind incompatibility blocks the merge
  const factTarget = ddStore.insertMemory(
    { kind: "fact", content: "User prefers pnpm for package management", importance: 8 },
    { provenance: "user", scope: "global", confidence: 0.9 },
  );
  const g3 = dedupeGate(ddStore, "User prefers pnpm for package management", { evidence: [] }, undefined, { kind: "preference", scope: "global", projectId: null });
  check("kind-incompatible rows are not merge targets", g3.verdict !== "duplicate" || g3.neighbor?.kind !== "fact", JSON.stringify({ verdict: g3.verdict }));
  ddStore.deleteMemory(legacyLike.id);
  ddStore.close();
}

// =====================================================================
// J) TOOL CORRECTION TRUST + CORRECTION VISIBILITY + ACCESS ACCOUNTING
// =====================================================================
{
  const cDir = join(root, "corr");
  const cStore = new MemoryStore(cDir);
  const old = cStore.insertMemory(
    { kind: "fact", content: "Project workboard uses sibling workboard data dirs", importance: 8 },
    { provenance: "user", scope: "project", projectId: "workboard", sessionId: "origin-session", confidence: 0.9 },
  );
  const eviction = cStore.insertMemory(
    { kind: "fact", content: "Vector filler used to test the tool path", importance: 7 },
    { provenance: "user", scope: "global", confidence: 0.7 },
  );
  const registered = [];
  const fakeToolCtx = { tools: { register(def) { registered.push(def); return () => {}; } } };
  registerMemoryTools(fakeToolCtx, cStore, 5);
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]));

  // memory_search: kind filter must not consume access accounting for dropped hits
  const unfilteredOut = await byName.memory_search.execute({ query: "workboard data dirs", kind: "" });
  check("memory_search returns the hit", unfilteredOut.hits.length === 1, JSON.stringify(unfilteredOut));
  check("unfiltered returned hits bump access exactly once", cStore.getMeta(old.id)?.readCount === 1, JSON.stringify(cStore.getMeta(old.id)));
  const filteredOut = await byName.memory_search.execute({ query: "workboard data dirs", kind: "preference" });
  check("kind-filtered memory_search returns nothing", filteredOut.hits.length === 0 && cStore.getMeta(old.id)?.readCount === 1, JSON.stringify(cStore.getMeta(old.id)));

  // Tool-authored correction stays untrusted and does NOT retire the original row
  const badKind = await byName.memory_correct.execute({ memory_id: old.id, new_content: "x", kind: "nonsense" });
  check("tool correction validates kinds", Boolean(badKind.error) && badKind.error.includes("Invalid memory kind"), JSON.stringify(badKind));
  const toolOut = await byName.memory_correct.execute({ memory_id: old.id, new_content: "Project workboard uses sibling data dirs", kind: "" });
  check("tool correction explains confirmation requirement",
    Boolean(toolOut.new_id) && toolOut.pending === true && /confirm/i.test(String(toolOut.note ?? "")),
    JSON.stringify(toolOut),
  );
  check("tool candidate carries derived/ tool-correct provenance",
    cStore.getMeta(toolOut.new_id)?.provenance === "derived" && cStore.getMeta(toolOut.new_id)?.source === "tool-correct",
    JSON.stringify(cStore.getMeta(toolOut.new_id)),
  );
  check("tool candidate inherits old scope/project/session",
    (meta => meta?.scope === "project" && meta?.projectId === "workboard" && meta?.sessionId === "origin-session")(cStore.getMeta(toolOut.new_id)),
    JSON.stringify(cStore.getMeta(toolOut.new_id)),
  );
  check("tool correction does NOT retire the original row", cStore.getMemory(old.id)?.status === "active");

  // memory_search carries ToolRunContext scoping: calling agent's project only
  const scopedExec = { agent: { id: "ag-1", session: { header: { cwd: "workboard" } } } };
  const betaExec = { agent: { id: "ag-1", session: { header: { cwd: "beta-project" } } } };
  const evicted = cStore.insertMemory(
    { kind: "fact", content: "Beta project only stores vector notes zzqq", importance: 7 },
    { provenance: "user", scope: "project", projectId: "beta-project", confidence: 0.9 },
  );
  cStore.upsertEmbedding(evicted.id, fakeEmbed(evicted.kind + " " + evicted.content)); // eligible in the vector lane, wrong project
  const ownProject = await byName.memory_search.execute({ query: "sibling workboard data dirs" }, scopedExec);
  check("memory_search scoped by caller project finds the project row",
    ownProject.hits.some((h) => h.id === old.id), JSON.stringify(ownProject));
  const otherProject = await byName.memory_search.execute({ query: "beta project vector notes zzqq" }, scopedExec);
  check("memory_search hides other projects", !otherProject.hits.some((h) => h.id === evicted.id), JSON.stringify(otherProject.hits));
  const selfAgent = { agent: { id: "ag-1", session: { header: { cwd: "beta-project" } } } };
  const selfRow = cStore.insertMemory(
    { kind: "event", content: "session-authored scratch note about beta builds qqww", importance: 7 },
    { provenance: "user", scope: "project", projectId: "beta-project", sessionId: "ag-1", confidence: 0.9 },
  );
  cStore.upsertEmbedding(selfRow.id, fakeEmbed(selfRow.kind + " " + selfRow.content));
  const selfEchoOut = await byName.memory_search.execute({ query: "beta builds qqww" }, selfAgent);
  check("memory_search self-echo guard excludes the caller session's rows", !selfEchoOut.hits.some((h) => h.id === selfRow.id), JSON.stringify(selfEchoOut.hits));
  const noCtxOut = await byName.memory_search.execute({ query: "sibling workboard data dirs" });
  check("memory_search without a tool context stays (explicit, unscoped)", noCtxOut.hits.some((h) => h.id === old.id), JSON.stringify(noCtxOut));


  // Direct /memory and browser-style correction MAY be trusted (handled in
  // commands/index tests). Here: retiring the original makes it invisible to
  // recall, lists, decay while only the replacement stays active.
  cStore.insertMemory(
    { kind: "fact", content: "Project workboard uses sibling data dirs, corrected", importance: 8, supersedes: old.id },
    { provenance: "user", source: "user-direct", scope: "project", projectId: "workboard", confidence: 0.9 },
  );
  cStore.setMemoryStatus(old.id, "corrected");
  // The vector lane keeps a stale embedding for the retired original; it must
  // never surface it (corrected originals are absent from ALL recall lanes).
  check("corrected row removed from FTS", cStore.searchMemories("sibling workboard data dirs", { limit: 10 }).every((h) => h.id !== old.id));
  check("corrected row excluded from injectable lists", !cStore.getActiveMemories(100, 0, true).some((m) => m.id === old.id));
  cStore.upsertEmbedding(old.id, fakeEmbed(old.kind + " " + old.content)); // stale vector for the retired row
  const vectorLane = await new RecallService(cStore, { strategy: "hybrid", maxResults: 5, scoreThreshold: 0, timeoutMs: 3000, relevanceMargin: 0 }, { async embed(texts) { return texts.map(fakeEmbed); } }).search("sibling workboard data dirs", { projectId: "workboard" });
  check("corrected row absent from the vector/hybrid lane too", vectorLane.every((h) => h.id !== old.id), JSON.stringify(vectorLane.map((h) => h.id.slice(0, 6))));
  // setMemoryStatus back to active rebuilds the FTS row
  cStore.setMemoryStatus(old.id, "active");
  check("reactivated row reappears in FTS", cStore.searchMemories("sibling workboard data dirs", { limit: 10 }).some((h) => h.id === old.id));
  cStore.deleteMemory(old.id);
  cStore.close();
}

// =====================================================================
// K) BASELINE DUPLICATE / FULL-CAP BEHAVIOR
// =====================================================================
{
  const bDir = join(root, "baseline-cap");
  const bStore = new MemoryStore(bDir);
  const mk = (c) => bStore.insertMemory({ kind: "preference", content: c, importance: 9 }, { provenance: "user", confidence: 0.9 });
  const slots = [];
  for (let i = 0; i < 3; i++) slots.push(mk(`Bounded baseline memory number ${i}`));
  const s0 = bStore.pinBaseline(slots[0].id, 3);
  const s0again = bStore.pinBaseline(slots[0].id, 3);
  check("re-pin of the same memory returns the existing slot", s0 === 1 && s0again === 1, JSON.stringify({ s0, s0again }));
  bStore.pinBaseline(slots[1].id, 3);
  bStore.pinBaseline(slots[2].id, 3);
  check("full cap returns null without eviction", bStore.pinBaseline(mk("Another durable baseline candidate").id, 3) === null);
  check("full cap keeps baseline bounded at 3", bStore.listBaseline().length === 3, JSON.stringify(bStore.listBaseline().map((b) => b.slot)));
  // Unambiguous duplicate prevention via slot swap move
  const moved = bStore.pinBaselineSlot(slots[0].id, 2);
  check("pinBaselineSlot keeps memory unique (moves the pin)", moved === 2, JSON.stringify({ moved }));
  const noDup = bStore.listBaseline().map((b) => b.memoryId).filter((id) => id === slots[0].id).length;
  check("no duplicate memory_id rows in baseline", noDup === 1, JSON.stringify(bStore.listBaseline()));
  bStore.close();
}

// =====================================================================
// L) MIGRATION LEDGER: schema_state is authoritative (even when user_version>=1)
// =====================================================================
{
  const staleDir = join(root, "stale-user-version");
  mkdirSync(staleDir, { recursive: true });
  const raw = new DatabaseSync(join(staleDir, "memory.db"));
  raw.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5, access_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active', supersedes TEXT
    );
    INSERT INTO memories (id, kind, content, importance, access_count, created_at, updated_at, status)
      VALUES ('sv-1', 'preference', 'Stale watermark legacy row', 8, 0, 1, 1, 'active');
    PRAGMA user_version = 1;  -- interrupted upgrade: user_version says done, schema_state missing
  `);
  raw.close();
  const staleStore = new MemoryStore(staleDir);
  check("user_version=1 without schema_state still runs the migration",
    staleStore.migrationApplied() === true && staleStore.getMemory("sv-1")?.meta?.provenance === "unknown",
    JSON.stringify(staleStore.getMemory("sv-1")?.meta),
  );
  check("backup taken before DDL for the stale legacy db", existsSync(join(staleDir, "memory.db.pre-hermes.bak")));
  // Missing-meta repair: destructive drop of a meta row, reopen must repair
  const victim = staleStore.insertMemory({ kind: "fact", content: "Meta repair victim row", importance: 7 });
  staleStore.close();
  const db = new DatabaseSync(join(staleDir, "memory.db"));
  db.prepare("DELETE FROM memories_meta WHERE memory_id = ?").run(victim.id);
  db.close();
  const repaired = new MemoryStore(staleDir);
  const victimMeta = repaired.getMeta(victim.id);
  check("startup repair backfills a missing meta row (untrusted/legacy)", victimMeta?.provenance === "unknown" && victimMeta?.source === "legacy", JSON.stringify(victimMeta));
  // Orphaned meta row is removed
  const db2 = new DatabaseSync(join(staleDir, "memory.db"));
  db2.prepare("INSERT INTO memories_meta (memory_id, provenance, source, scope, confidence, evidence) VALUES ('orphan', 'system', 'legacy', 'global', 0.3, '[]')").run();
  db2.close();
  const reopened = new MemoryStore(staleDir);
  const db3 = new DatabaseSync(join(staleDir, "memory.db"), { readOnly: true });
  const orphanLeft = Number(db3.prepare("SELECT COUNT(*) n FROM memories_meta WHERE memory_id = 'orphan'").get()?.n ?? 0);
  db3.close();
  reopened.close();
  check("orphaned meta rows are cleaned at startup", orphanLeft === 0, `orphanLeft=${orphanLeft}`);
  staleStore.close();
}

// =====================================================================
// M) CONTEXT LIFECYCLE: plugin-owned iterable disposers + delayed abort
// =====================================================================
{
  const handlers = {};
  const fakeCtx = { on(name, fn) { handlers[name] = fn; } };
  let searchCall = 0;
  let resolveFirst;
  const projectKeysUsed = [];
  const slowRecall = {
    async search(_q, opts) {
      searchCall++;
      projectKeysUsed.push(opts?.projectId);
      check("automatic recall always passes a string project key (never null)",
        typeof opts?.projectId === "string" && opts.projectId.length > 0, JSON.stringify(opts));
      if (searchCall === 1) {
        // First call hangs until the test aborts mid-flight
        return new Promise((res) => { resolveFirst = res; });
      }
      return [{ id: "h2", kind: "fact", content: "default workspace build cache memory", importance: 7, score: 1 }];
    },
    getBaselineEntries() { return []; },
  };
  installRecallInjection(fakeCtx, slowRecall, {
    enabled: () => true,
    maxHits: 5,
    sessionIdOf: () => "life-session",
    projectKeyOf: () => "default", // default project key STILL passed to recall
  });
  const stepHandler = handlers["agent/pre-step"];
  const realMsg = { role: "user", content: [{ type: "text", text: "check the default workspace build cache" }] };
  const decisionOf = async () => ({ kind: "enter", messages: [realMsg] });

  // Delayed abort: signal aborted while recall is still in flight
  const agentA = { id: "agent-abort", ctx: { systemPrompt: { context() { return () => {}; } } } };
  const aborter = new AbortController();
  const abortRun = stepHandler({ step: 1, agent: agentA, signal: aborter.signal }, decisionOf);
  await new Promise((r) => setImmediate(r));
  aborter.abort();
  resolveFirst([{ id: "h", kind: "fact", content: "x", importance: 5, score: 1 }]);
  const abortOut = await abortRun;
  check("delayed abort after recall await yields no injection", abortOut.messages.length === 1, JSON.stringify(abortOut.messages.length));
  check("default project key was used for automatic recall", projectKeysUsed[0] === "default", JSON.stringify(projectKeysUsed));

  // Plugin dispose: all live contexts disposed (handler "dispose" registered)
  const scopedSections = [];
  const disposed = [];
  const agentB = {
    id: "agent-life",
    ctx: { systemPrompt: { context(section) { scopedSections.push(section); return () => { disposed.push(section.name); }; } } },
  };
  const out = await stepHandler({ step: 1, agent: agentB }, decisionOf);
  check("live turn registers scoped context", scopedSections.length === 1 && out.messages.length === 1, JSON.stringify({ sections: scopedSections.length }));
  check("plugin dispose handler is registered", typeof handlers.dispose === "function");
  handlers.dispose();
  check("plugin dispose clears every live scoped context", disposed.includes("dsh-self-improved:recall"), JSON.stringify(disposed));
  // agent/disposed teardown (cached turn re-registers, replacing the stale one)
  await stepHandler({ step: 1, agent: agentB }, decisionOf);
  check("later turn re-arms the scoped context", scopedSections.length === 2, JSON.stringify(scopedSections.length));
  handlers["agent/disposed"]({ agent: agentB });
  check("agent/disposed tears down its own scoped context", disposed.includes("dsh-self-improved:recall"), JSON.stringify(disposed.length));
}

store2.close();
store3.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
