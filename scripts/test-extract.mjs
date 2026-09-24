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
store.insertMemory({ kind: "fact", content: "Project E:\\dshPro uses pnpm to manage dependencies", importance: 7 });
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

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
