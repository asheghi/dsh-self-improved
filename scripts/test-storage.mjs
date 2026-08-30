/**
 * M1 storage module unit tests: insert / FTS5 search / list / forget / delete / sqlite-vec extension loading.
 * Run: node scripts/test-storage.mjs
 */
import { rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";

const dir = join(process.env.TEST_DIR ?? "E:\\dshPro\\.dsh-test", "m1-unit");
rmSync(dir, { recursive: true, force: true });

const store = new MemoryStore(dir);
let failed = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? "  (" + extra + ")" : ""}`);
  if (!cond) failed++;
};

// 1) Files and database files
check("memory.db created", existsSync(join(dir, "memory.db")));
check("conversations directory logic available", typeof store.appendConversationSlice === "function");

// 2) Insert
const m1 = store.insertMemory({ kind: "preference", content: "User prefers PowerShell over cmd", importance: 8 });
const m2 = store.insertMemory({ kind: "fact", content: "Project E:\\dshPro manages dependencies with pnpm", importance: 7 });
const m3 = store.insertMemory({ kind: "event", content: "5/14 completed the payment module migration, took about 4 hours", importance: 6 });
check("inserting 3 memories returns ids", m1.id && m2.id && m3.id);

// 3) FTS5 search (BM25)
let hits = store.searchMemories("PowerShell", { limit: 5 });
check("FTS hits preference", hits.length === 1 && hits[0].kind === "preference", `got ${hits.length}`);
hits = store.searchMemories("pnpm dependencies", { limit: 5 });
check("FTS hits fact (multi-term)", hits.length >= 1 && hits[0].content.includes("pnpm"), `got ${hits.length}`);
hits = store.searchMemories("nonexistentwordxyzzy", { limit: 5 });
check("no match returns empty", hits.length === 0);

// 4) List / single lookup / forget / delete
check("listMemories returns 3", store.listMemories().length === 3);
check("getMemory hits", store.getMemory(m1.id)?.kind === "preference");
check("forgetMemory works", store.forgetMemory(m1.id) === true);
hits = store.searchMemories("PowerShell", { limit: 5 });
check("no hits after forget", hits.length === 0);
check("deleteMemory works", store.deleteMemory(m2.id) === true);
// listMemories is a browse view: forgotten records are kept for recovery, so m1(forgotten) + m3 = 2 records remain
check("list has 2 records left after delete (including forgotten)", store.listMemories().length === 2, `got ${store.listMemories().length}`);
check("listMemories includes the forgotten record", store.listMemories().some((m) => m.status === "forgotten"));

// 5) L0 slice persistence
store.appendConversationSlice("session-test-1", [
  { type: "user", seq: 1, ts: Date.now(), text: "Hello", sessionId: "session-test-1" },
  { type: "assistant", seq: 2, ts: Date.now(), text: "Hello, how can I help?", sessionId: "session-test-1" },
]);
const convDir = join(dir, "conversations");
check("conversations directory created", existsSync(convDir));
check("slices persisted to JSONL", readdirSync(convDir).length === 1);

// 6) sqlite-vec extension (whether vectors.db was created)
check("sqlite-vec loaded (vectors.db)", existsSync(join(dir, "vectors.db")), "if not created, vectors are disabled (does not block M1)");

store.close();
console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
