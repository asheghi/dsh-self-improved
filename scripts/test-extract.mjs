/**
 * M2 extraction pipeline unit tests: injects a fake LLM to verify JSON validation, fallback, filtering, dedup, and watermark advancement.
 * Run: node scripts/test-extract.mjs
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { Extractor } from "../lib/extract.js";

const dir = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "m2-unit");
rmSync(dir, { recursive: true, force: true });
const store = new MemoryStore(dir);

const settings = {
  enabled: true,
  intervalMinutes: 15,
  batchMaxChars: 12000,
  maxOutputTokens: 2000,
  timeoutMs: 60000,
  dedup: true,
  fallbackOnBadJson: true,
  flushDrain: false,
};

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

function seedSession(id, texts) {
  const recs = texts.map((t, i) => ({
    type: i % 2 ? "assistant" : "user",
    seq: i + 1,
    ts: Date.now(),
    text: t,
    sessionId: id,
    sourceKind: i % 2 ? "model" : "user",
  }));
  store.appendConversationSlice(id, recs);
  store.markPending(id, recs[recs.length - 1].seq);
}

// Scenario 1: valid JSON
seedSession("s-valid", ["I prefer using PowerShell over cmd", "Got it, I've noted your preference"]);
// Scenario 2: bad output (non-JSON text)
seedSession("s-garbage", ["Just chatting about the weather"]);
// Scenario 3: empty result
seedSession("s-empty", ["Hello", "Goodbye"]);
// Scenario 4: invalid entries + sensitive info
seedSession("s-invalid", ["This is a test conversation"]);
// Scenario 5: dedup (insert the same content first, then extract)
store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 }, { provenance: "user" });
seedSession("s-dup", ["Project E:\\dshPro uses pnpm to manage dependencies"]);

const scripted = {
  "s-valid": JSON.stringify({
    memories: [
      { kind: "preference", content: "User prefers using PowerShell over cmd", importance: 8 },
      { kind: "fact", content: "User uses Windows day to day", importance: 5 },
    ],
  }),
  "s-garbage": "Sure thing, the weather is lovely today",
  "s-empty": JSON.stringify({ memories: [] }),
  "s-invalid": JSON.stringify({
    memories: [
      { kind: "nonsense", content: "invalid kind", importance: 5 },
      { kind: "fact", content: "x", importance: 5 },
      { kind: "fact", content: "the secret key is sk-abcdef1234567890 please save it", importance: 9 },
      { kind: "fact", content: "a valid memory entry", importance: 6 },
    ],
  }),
  "s-dup": JSON.stringify({
    memories: [{ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 }],
  }),
};

const extractor = new Extractor(store, settings, async ({ sessionId }) => scripted[sessionId] ?? "{}");
const result = await extractor.pump();

check("pump processes 5 sessions", result.sessions === 5, `sessions=${result.sessions}`);
check("valid JSON extracts 2 memories", result.memories >= 2, `memories=${result.memories} skipped=${result.skipped}`);
check("preference is searchable", store.searchMemories("PowerShell", { limit: 5 }).length >= 1);
check("fact is searchable", store.searchMemories("Windows", { limit: 5 }).length >= 1);
check("bad output falls back to summary", store.searchMemories("auto summary", { limit: 5 }).length >= 1);
check(
  "valid empty result does not trigger the fallback (exactly 1 auto summary)",
  store.listMemories().filter((m) => m.content.includes("[auto summary]")).length === 1,
  `got ${store.listMemories().filter((m) => m.content.includes("[auto summary]")).length}`,
);
check(
  "empty result produces no memory",
  store.listMemories().filter((m) => m.content.includes("Hello, Goodbye")).length === 0,
);
check("invalid entries filtered, valid entry kept", store.listMemories().filter((m) => m.content === "a valid memory entry").length === 1);
check("sensitive content is filtered", !store.listMemories().some((m) => m.content.includes("sk-abcdef")));
check(
  "dedup: exactly 1 pnpm memory",
  store.listMemories().filter((m) => m.content.includes("pnpm")).length === 1,
  `got ${store.listMemories().filter((m) => m.content.includes("pnpm")).length}`,
);
check("watermark advanced for all sessions", store.pendingSessions().length === 0, `pending=${store.pendingSessions().length}`);

// ── Paste-poisoning hardening: evidence quoted from a pasted-material slice is
// demoted (importance/confidence capped, never baseline-pinned); the same draft
// backed by a clean direct-human slice keeps full strength and IS pinned.
seedSession("s-paste", [
  "Here is the README for this repo:\n# AcmeDeploy\n## Features\n- One command deploy [see the docs](https://example.com/docs)\n```\nnpm run deploy\n```\nThe tool ships with a built-in CDN cache that purges in 60 seconds.\n",
  "ok thanks",
]);
seedSession("s-clean", ["I run Arch Linux on my workstation."]);
scripted["s-paste"] = JSON.stringify({
  memories: [
    { kind: "fact", content: "AcmeDeploy ships with a built-in CDN cache", importance: 9, confidence: 0.9, scope: "global", source_role: "user", evidence: "The tool ships with a built-in CDN cache" },
  ],
});
scripted["s-clean"] = JSON.stringify({
  memories: [
    { kind: "fact", content: "User runs Arch Linux on the workstation", importance: 9, confidence: 0.9, scope: "global", source_role: "user", evidence: "I run Arch Linux on my workstation" },
  ],
});
const strictSettings = { ...settings, provenanceFilter: "strict", requireEvidence: true };
const strictExtractor = new Extractor(store, strictSettings, async ({ sessionId }) => scripted[sessionId] ?? "{}");
const strictResult = await strictExtractor.pump();

check("paste scenario processed", store.pendingSessions().length === 0, `pending=${store.pendingSessions().length}`);
check("paste-suspicious draft is demoted exactly once", strictResult.demotedPasteSuspicious === 1, `demoted=${strictResult.demotedPasteSuspicious}`);
const pastedRow = store.listMemories().find((m) => m.content.includes("AcmeDeploy"));
check("pasted-evidence row still inserted (demotion, not rejection)", Boolean(pastedRow));
check("pasted-evidence row importance capped at 7", pastedRow && pastedRow.importance <= 7, `importance=${pastedRow?.importance}`);
check("pasted-evidence row confidence capped at 0.6", (pastedRow?.meta?.confidence ?? 1) <= 0.6, `confidence=${pastedRow?.meta?.confidence}`);
check("pasted-evidence row never auto-pinned to the baseline", !store.listBaseline().some((e) => e.memory?.id === pastedRow?.id));
check("paste-demoted row carries the distinct paste source tag", pastedRow?.meta?.source === "llm-extract-pasted", `source=${pastedRow?.meta?.source}`);
const cleanRow = store.listMemories().find((m) => m.content.includes("Arch Linux on the workstation"));
check("clean direct-human row keeps full strength", cleanRow && cleanRow.importance === 9 && (cleanRow.meta?.confidence ?? 0) === 0.9, JSON.stringify({ importance: cleanRow?.importance, confidence: cleanRow?.meta?.confidence }));
check("clean direct-human row IS auto-pinned to the baseline", store.listBaseline().some((e) => e.memory?.id === cleanRow?.id));
check("clean row keeps the normal extract source tag", cleanRow?.meta?.source === "llm-extract", `source=${cleanRow?.meta?.source}`);

// ── Persona anti-contamination: a paste-suspicious slice must not promote a
// paste-demoted draft (distinct source + forced project scope) into the persona.
seedSession("s-paste-global", [
  "Pasting the migration guide:\n# Migration Guide\n## Steps\n- [step one](https://example.com/one)\n```\nmv config.yaml config.yml\n```\nHonestly a user runs Vim daily and lwqz-code never seen in chat.\n",
]);
scripted["s-paste-global"] = JSON.stringify({
  memories: [
    { kind: "preference", content: "User runs Vim daily", importance: 9, confidence: 0.9, scope: "global", source_role: "user", evidence: "Honestly a user runs Vim daily and" },
  ],
});
const pasteGlobalExtractor = new Extractor(store, strictSettings, async ({ sessionId }) => scripted[sessionId] ?? "{}");
const pasteGlobalResult = await pasteGlobalExtractor.pump();
const pasteGlobalRow = store.listMemories().find((m) => m.content.includes("User runs Vim daily"));
check("paste-suspicious global-looking draft still inserted (demotion)", Boolean(pasteGlobalRow));
check("paste-suspicious global-looking draft demoted once more", pasteGlobalResult.demotedPasteSuspicious === 1, `demoted=${pasteGlobalResult.demotedPasteSuspicious}`);
check("paste-suspicious global-looking draft forced to project scope", pasteGlobalRow?.meta?.scope === "project", `scope=${pasteGlobalRow?.meta?.scope}`);
check("paste-suspicious global-looking draft tagged llm-extract-pasted", pasteGlobalRow?.meta?.source === "llm-extract-pasted", `source=${pasteGlobalRow?.meta?.source}`);

// Consolidator persona synthesis cannot pick up paste-demoted rows (source filter).
{
  const { Consolidator } = await import("../lib/consolidate.js");
  let personaPrompt = "";
  const consolidator = new Consolidator(
    store,
    { scenesEnabled: false, sceneMaxMemories: 10, sceneBatchSize: 10, personaMaxMemories: 30 },
    async ({ user }) => { personaPrompt = user; return "## Working Style\nKeyboard-driven workflow."; },
  );
  const ver = await consolidator.consolidate();
  check("consolidation produced a persona", ver.personaVersion !== undefined, JSON.stringify(ver));
  check("persona synthesis prompt excludes paste-demoted rows", personaPrompt.includes("Arch Linux on the workstation") && !personaPrompt.includes("User runs Vim daily") && !personaPrompt.includes("AcmeDeploy"), personaPrompt);
  const persona = store.getPersona();
  check("saved persona contains no paste-contaminated content", persona && persona.content.includes("Keyboard-driven") && !persona.content.includes("Vim"), persona?.content);
}

// Regression: a user-like draft the model explicitly marked PROJECT scope must
// stay project (the model may not escalate a repo/project fact to global).
{
  const { durableScopeForDraft } = await import("../lib/extract.js");
  const userLike = { kind: "preference", content: "User prefers pnpm", importance: 8, confidence: 0.9, evidence: "I use pnpm", sourceRole: "user", scope: "project" };
  check("user-like draft with explicit project scope stays project", durableScopeForDraft(userLike) === "project", JSON.stringify(userLike));
  check("user-like draft marked global stays global", durableScopeForDraft({ ...userLike, scope: "global" }) === "global");
  check("paste-suspicious draft forced to project regardless of claimed scope", durableScopeForDraft({ ...userLike, scope: "global" }, true) === "project");
}

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
