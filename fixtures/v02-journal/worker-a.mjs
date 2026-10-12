#!/usr/bin/env node
/**
 * Crash-boundary worker for scripts/test-v02-journal.mjs.
 *
 * Runs one durable-core scenario against a REAL SQLite MemoryStore and dies by
 * SIGKILL at the requested boundary (or exits 0 after an in-transaction
 * rollback drill). The PARENT reopens the same database file in a separate
 * process and asserts every durable invariant — genuine cross-process crash
 * evidence, not a same-process mock.
 *
 * Usage: node fixtures/v02-journal/worker-a.mjs <scenario.json>
 * scenario.json: { dir, boundary } with boundary in:
 *   after-enqueue | after-claim | mid-commit-rollback | after-commit
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { MemoryStore } = await import(join(repo, "lib/storage.js"));
const { MemoryJournalV02 } = await import(join(repo, "lib/memory-journal-v02.js"));

const scenario = JSON.parse(readFileSync(process.argv[2], "utf8"));
const { dir, boundary } = scenario;

const die = () => {
  try { process.stdout.write(""); } catch { /* ignore */ }
  process.kill(process.pid, "SIGKILL");
};

const store = new MemoryStore(dir);
const journal = new MemoryJournalV02(store, {
  defaultLeaseMs: 60_000,
  // Kill the actual child INSIDE the transaction, after candidate/ack writes
  // but before COMMIT; the parent must reopen and prove SQLite crash recovery.
  boundaryHook:
    boundary === "mid-commit-rollback"
      ? (name) => {
          if (name === "commit-chunk-pre-commit") {
            die();
          }
        }
      : undefined,
});

// Recovery is what a restarted host runs first.
journal.recoverStartup();

journal.appendSession({
  sessionId: "crash-session",
  projectId: "crash-project",
  producer: { delegated: false, inheritedEventCount: 0 },
  sourceMaxChars: 400,
  events: [
    { seq: 0, ts: 1, kind: "user", text: "CRASH_MARKER_0 remember the durable core", sourceKind: "user" },
    { seq: 1, ts: 2, kind: "user", text: "CRASH_MARKER_1 second fact", sourceKind: "user" },
    { seq: 2, ts: 3, kind: "assistant", text: "CRASH_MARKER_2 assistant note", sourceKind: "model" },
  ],
});

if (boundary === "after-enqueue") die();

const claim = journal.claimWork({ kind: "extract" });
if (!claim) {
  // Nothing claimable (e.g. rerun after full completion): report cleanly.
  process.stdout.write(JSON.stringify({ noClaim: true }));
  process.exit(0);
}

if (boundary === "after-claim") die();

if (boundary === "mid-commit-rollback") {
  try {
    journal.commitChunkResult(claim, 0, {
      kind: "consumed",
      candidates: [{ text: "SHOULD NEVER PERSIST", provenance: "user", scope: "global" }],
    });
    process.stdout.write(JSON.stringify({ unexpected: "commit-succeeded-despite-crash-hook" }));
    process.exit(3);
  } catch (error) {
    if (!String(error).includes("SIMULATED_CRASH_BEFORE_COMMIT")) {
      process.stdout.write(JSON.stringify({ unexpected: String(error) }));
      process.exit(4);
    }
    process.stdout.write(JSON.stringify({ rolledBack: true }));
    process.exit(0);
  }
}

const report = journal.commitChunkResult(claim, 0, {
  kind: "consumed",
  candidates: [{ text: "CRASH_DERIVED_MEMORY durable fact", provenance: "user", scope: "project" }],
});
if (!report.acked) {
  process.stdout.write(JSON.stringify({ unexpected: "commit-not-acked" }));
  process.exit(5);
}

if (boundary === "after-commit") die();

process.stdout.write(JSON.stringify({ completed: true }));
process.exit(0);
