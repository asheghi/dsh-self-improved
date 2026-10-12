/**
 * Crash-support worker for scripts/test-v02-import-seam.mjs (plain JS .mjs).
 *
 * Runs one import chunk against the store directory named by the scenario JSON
 * file and dies by REAL SIGKILL at the requested boundary — the parent suite
 * then reopens the same SQLite file from a fresh process and asserts every
 * durability invariant cross-process (same standard as fixtures/v02-journal).
 *
 * Boundaries:
 * - "mid":  inside the importer transaction, after the import row-set writes
 *           AND the same-tx ledger row, BEFORE COMMIT.
 * - "post": AFTER the chunk COMMIT returns.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "../../lib/storage.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { dir, boundary } = scenario;

const die = () => process.kill(process.pid, "SIGKILL");

const store = new MemoryStore(dir);
const rowA = {
  id: "legacy-crash-0001",
  kind: "fact",
  content: "import crash boundary row A",
  createdAt: 1_700_000_000_111,
  updatedAt: 1_700_000_000_222,
  importance: 7,
};
const meta = { provenance: "user", source: "legacy", scope: "global", confidence: 0.8 };
const rowB = {
  id: "legacy-crash-0002",
  kind: "preference",
  content: "import crash boundary row B",
  createdAt: 1_700_000_000_333,
  updatedAt: 1_700_000_000_444,
};

store.runInImmediateTransaction(() => {
  // Row-set writes (row + seq + FTS + meta + recall revision bump) — no commit
  // of their own; everything rides the caller's immediate transaction.
  store.importMemoryInTx(rowA, meta);
  // Same-tx importer ledger row (store_state, "data row and its verdict commit
  // in the SAME transaction" — the journal §4.2 rule the import lane mirrors).
  store
    .getJournalSqlite()
    .prepare("INSERT INTO store_state (key, value, updated_at) VALUES ('import:test:ledger', 'boundary-ok', 42)")
    .run();
  if (boundary === "mid") die();
  store.importMemoryInTx(rowB, meta);
});

if (boundary === "post") die();

// Unreachable; a clean run (%o of scenarios is asserted by the parent to die)
console.log(JSON.stringify({ unwantedCleanExit: true }));
