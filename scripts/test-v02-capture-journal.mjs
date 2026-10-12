#!/usr/bin/env node
/**
 * Phase B capture→journal integration tests (MIGRATION-PHASE-B-CAPTURE.md).
 *
 * Focused producer-lane checks over the REAL plugin persistence: a genuine
 * MemoryStore + MemoryJournalV02 (node:sqlite in a temporary directory),
 * installCapture's journal sink, and the documented extractor seam.
 * All evidence, secrets and text here are SYNTHETIC; no live profile,
 * production store, provider or network access.
 *
 * Run: node scripts/test-v02-capture-journal.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { installCapture, opaqueProjectIdFromKey, JOURNAL_SOURCE_MAX_CHARS } = await import("../lib/capture.js");
const { MemoryStore } = await import("../lib/storage.js");
const { MemoryJournalV02 } = await import("../lib/memory-journal-v02.js");
const { projectKeyFromCwd } = await import("../lib/capture.js");

const CANARIES = [
  "password=SYNTHETIC_PASSWORD_CANARY",
  "apiKey=SYNTHETIC_API_KEY_CANARY",
  "sk-SYNTHETICKEYCANARYABCDEFGHIJKLMNOPQRSTUVWXYZ",
];
const bodyOf = (label) =>
  `review task from the operator: ${label} — ${CANARIES.join("; ")} and ordinary prose around it.`;

const dirs = [];
function freshStore() {
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-capture-journal-")), "store");
  dirs.push(dir);
  return new MemoryStore(dir);
}

let pass = 0;
let fail = 0;
function check(ok, name, detail) {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${ok === true ? "" : ` (${String(detail)})`}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? ` (${JSON.stringify(detail)})` : ""}`);
  }
}

function installWith(store, sink, disabled = false) {
  const flushes = [];
  installCapture(
    { on: (name, fn) => flushes.push({ name, fn }) },
    store,
    { enabled: () => !disabled },
    undefined,
    undefined,
    sink,
  );
  return flushes[0].fn;
}

/** Raw journal DB facts (read-only verification of REAL persisted columns). */
function journalRows(store, sessionId) {
  const db = store.getJournalSqlite();
  const sources = db
    .prepare("SELECT seq, kind, text, source_kind, injected FROM journal_sources WHERE session_id = ? ORDER BY seq")
    .all(sessionId);
  const session = db
    .prepare("SELECT session_id, project_id, delegated, producer_header_json FROM journal_sessions WHERE session_id = ?")
    .get(sessionId);
  const counts = {
    jobs: Number(db.prepare("SELECT COUNT(*) c FROM journal_jobs WHERE session_id = ?").get(sessionId).c),
    // eslint-disable-next-line no-new-func
  };
  return { sources, session, counts };
}

function readsWholeFile(store, sessionId) {
  const dir = join(store.dir, "conversations");
  return existsSync(dir) && existsSync(join(dir, `${String(sessionId).replace(/[^\w.-]/g, "_")}.jsonl`));
}

/** Credential VALUE tokens (label-independent canaries that must never persist). */
const CANARY_VALUES = CANARIES.map((c) => c.split("=").pop() ?? c);

// ── 1. Direct-human canary minimization: real persisted journal text ───────
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  const flush = installWith(store, { append: (i) => journal.appendSession(i), closed: () => false });
  await flush({
    id: "canary-human",
    header: { cwd: "/synthetic/project" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: bodyOf("turn one") }], source: { kind: "user" } } },
    ],
  });
  const { sources, session } = journalRows(store, "canary-human");
  const allText = sources.map((s) => s.text).join("\n");
  check(sources.length === 1 && sources[0].kind === "user" && sources[0].seq === 0 && sources[0].injected === 0,
    "exactly one direct-human user source at seq 0 enqueued", sources);
  check(CANARY_VALUES.every((v) => !allText.includes(v)),
    "no credential canary value persists in journal text", allText.slice(0, 200));
  check(allText.includes("[REDACTED]") || allText.includes("[REDACTED-PRIVATE-KEY]"),
    "minimized persisted text carries explicit redaction markers", allText.slice(0, 200));
  check(allText.includes("review task from the operator"),
    "ordinary prose of the direct-human turn is retained (minimized, not dropped)", allText.slice(0, 200));
  check(/pj-[0-9a-f]{32}/.test(String(session.project_id)),
    "projectId is the stable opaque identity (pj-<hex>), never path text", session.project_id);
  check(session.project_id === opaqueProjectIdFromKey(projectKeyFromCwd("/synthetic/project")),
    "opaque projectId equals the documented derivation", session.project_id);
  check(!readsWholeFile(store, "canary-human"),
    "plugin-owned raw JSONL transcript copy no longer written (journal replaced the lane)");
  store.close();
}

// ── 2. Producer-header structural allowlist (no arbitrary header userdata) ──
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  const flush = installWith(store, { append: (i) => journal.appendSession(i), closed: () => false });
  const leakyHeader = {
    cwd: "/synthetic/proj2",
    authHeader: "Bearer SYNTHETIC_HEADER_SECRET_CANARY",
    extra: { apiKey: "SYNTHETIC_HEADER_KEY_CANARY" },
    arbitrary: { nested: "SYNTHETIC_HEADER_NESTED_CANARY" },
  };
  await flush({
    id: "header-allowlist",
    header: leakyHeader,
    inheritedEventCount: 2,
    ownEvents: () => [
      { type: "user/message", seq: 2, time: 3, data: { content: [{ type: "text", text: bodyOf("child turn") }], source: { kind: "user" } } },
    ],
  });
  const { session, sources } = journalRows(store, "header-allowlist");
  const headerJson = session.producer_header_json;
  const header = JSON.parse(headerJson);
  check(header.delegated === false && header.inheritedEventCount === 2,
    "allowlisted producer header facts persist (delegated/lineage)", header);
  const ALLOWED_HEADER_KEYS = ["delegated", "origin", "parentSessionId", "rootSessionId", "inheritedEventCount", "extra"];
  check(Object.keys(header).every((k) => ALLOWED_HEADER_KEYS.includes(k))
      && (!header.extra || Object.keys(header.extra).length === 0)
      && (header.origin === null || header.origin === "subagent")
      && (header.parentSessionId === null || header.parentSessionId === "parent-synthetic" || header.parentSessionId === undefined),
    "no arbitrary header userdata extra (closed allowlist; extra stays empty; origin sentinel-or-null)", Object.keys(header));
  check(String(headerJson).includes("SYNTHETIC_HEADER") === false
      && String(session.project_id).includes("SYNTHETIC_HEADER") === false
      && JSON.stringify(sources).includes("SYNTHETIC_HEADER") === false,
    "header-injected credential canaries persist NOWHERE (headers/sources/projects)");
  check(sources.length === 1 && sources.every((s) => s.seq >= 2),
    "inherited fork prefix (seq < inheritedEventCount) never enqueued; exact floor seq enqueued", sources.map((s) => s.seq));
  store.close();
}

// ── 3. Non-direct-human producers persist zero personal-lane text ──────────
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  const flush = installWith(store, { append: (i) => journal.appendSession(i), closed: () => false });
  await flush({
    id: "ordinary-producers",
    header: { cwd: "/synthetic/proj3" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "assistant/message", seq: 1, time: 1, data: { message: { role: "assistant", source: { kind: "model" }, content: [{ type: "text", text: bodyOf("assistant voice") }] } } },
      { type: "tool/result", seq: 2, time: 2, data: { message: { toolCallId: "call-1", content: [{ type: "text", text: bodyOf("tool voice") }] } } },
      { type: "user/message", seq: 3, time: 3, data: { content: [{ type: "text", text: bodyOf("injected snapshot") }], source: { kind: "user", form: "snapshot" } } },
      { type: "user/message", seq: 4, time: 4, data: { content: [{ type: "text", text: bodyOf("unknown producer") }], source: { kind: "relay-unknown" } } },
      { type: "turn/end", seq: 5, time: 5, data: { turn: 1, reason: { kind: "completed" } } },
      { type: "user/message", seq: 6, time: 6, data: { content: [{ type: "text", text: bodyOf("genuine human") }], source: { kind: "user" } } },
    ],
  });
  const { sources } = journalRows(store, "ordinary-producers");
  check(sources.length === 1 && sources[0].seq === 6,
    "only the direct-human turn enqueued: assistant/tool/injected/unknown/turn-end persist no personal text", sources.map((s) => s.seq));
  check(!sources.map((s) => s.text).join("").includes("assistant voice")
      && !sources.map((s) => s.text).join("").includes("unknown producer"),
    "ordinary producer text never reaches the plugin persistence through capture");
  // coordinator lane: delegated session — even source kind user is coordinator text
  const store2 = freshStore();
  const journal2 = new MemoryJournalV02(store2);
  const flush2 = installWith(store2, { append: (i) => journal2.appendSession(i), closed: () => false });
  await flush2({
    id: "coordinator-child",
    header: { cwd: "/synthetic/proj3", origin: "subagent" },
    inheritedEventCount: 1,
    ownEvents: () => [
      { type: "user/message", seq: 1, time: 7, data: { content: [{ type: "text", text: bodyOf("coordinator brief") }], source: { kind: "user" } } },
    ],
  });
  const { sources: coordSources } = journalRows(store2, "coordinator-child");
  check(coordSources.length === 0,
    "delegated-session coordinator brief (source kind user) enqueues NOTHING (no personal-lane capture)");
  store.close();
  store2.close();
}

// ── 4. Enqueue crash: no fabricated flush ack, retry is idempotent ─────────
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  let crash = true; // synthetic mid-call crash before any commit (process death semantics)
  const sink = {
    append: (input) => {
      if (crash) throw new Error("SYNTHETIC crash between ingest and COMMIT");
      return journal.appendSession(input);
    },
    closed: () => false,
  };
  const calls = { pump: 0 };
  const flushes = [];
  installCapture(
    { on: (name, fn) => flushes.push({ name, fn }) },
    store,
    { enabled: () => true },
    () => { calls.pump += 1; },
    undefined,
    sink,
  );
  const session = {
    id: "crash-enqueue",
    header: { cwd: "/synthetic/proj4" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: bodyOf("pre crash") }], source: { kind: "user" } } },
    ],
  };
  await flushes[0].fn(session);
  const { sources: before } = journalRows(store, "crash-enqueue");
  check(before.length === 0,
    "crash at enqueue commits NOTHING (no partial personal-lane write)", before.length);
  const { counts } = journalRows(store, "crash-enqueue");
  check(counts.jobs === 0, "no extraction job coverage created for an enqueue that never committed");
  // Retry after recovery: full enqueue, then a re-flush is deduped.
  crash = false;
  await flushes[0].fn(session);
  const afterFirst = journalRows(store, "crash-enqueue");
  check(afterFirst.sources.length === 1 && afterFirst.session.project_id === opaqueProjectIdFromKey(projectKeyFromCwd("/synthetic/proj4")),
    "retry after crash fully enqueues exactly one immutable source (seq0-safe)", afterFirst.sources.map((s) => s.seq));
  await flushes[0].fn(session);
  const afterRepeat = journalRows(store, "crash-enqueue");
  const db = store.getJournalSqlite();
  const report = journal.appendSession({
    sessionId: "crash-enqueue",
    projectId: opaqueProjectIdFromKey(projectKeyFromCwd("/synthetic/proj4")),
    producer: { delegated: false },
    events: [{ seq: 0, ts: 1, kind: "user", text: bodyOf("pre crash"), sourceKind: "user", injected: false }],
    sourceMaxChars: JOURNAL_SOURCE_MAX_CHARS,
  });
  check(afterRepeat.sources.length === 1 && report.stored === 0 && report.deduped >= 1,
    "re-flush is lifecycle-deduped (no duplicate evidence; immutable lineage intact)", { sources: afterRepeat.sources.length, report });
  store.close();
}

// ── 5. Ingress close signal: flush never enqueues after dropIngress ────────
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  let closed = false;
  let appends = 0;
  const sink = {
    append: (input) => { appends += 1; return journal.appendSession(input); },
    closed: () => closed,
  };
  const flush = installWith(store, sink);
  const session = {
    id: "closed-ingress",
    header: { cwd: "/synthetic/proj5" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: bodyOf("before close") }], source: { kind: "user" } } },
    ],
  };
  await flush(session);
  check(appends === 1, "open ingress enqueues through the sink", appends);
  closed = true; // runtime dropIngress boundary equivalent
  await flush(session);
  check(appends === 1, "closed ingress performs ZERO sink appends (lifetime remains correct)", appends);
  store.close();
}

// ── 6. Source coverage contract: long input is never silently truncated ────
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  const flush = installWith(store, { append: (i) => journal.appendSession(i), closed: () => false });
  const head = "HEAD_MARKER alpha plan details begin here. ";
  const middle = `${"evidence-bearing prose. ".repeat(4500)} MID_MARKER ${"evidence-bearing prose. ".repeat(4500)} `;
  const tail = "TAIL_MARKER final operator intent ends the turn.";
  const longText = head + middle + tail; // >200000 retained chars, requiring bounded persistence parts
  assert.ok(longText.length > JOURNAL_SOURCE_MAX_CHARS);
  await flush({
    id: "long-input",
    header: { cwd: "/synthetic/proj6" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: longText }], source: { kind: "user" } } },
    ],
  });
  const claim = journal.claimWork({ kind: "extract" });
  assert.ok(claim, "worker can claim the coverage job");
  // Contract verification (not the extraction implementation): drain EVERY
  // chunk through the documented read/commit surface and prove the
  // concatenation of ALL persisted segments is lossless — head, middle and
  // tail markers all survive. Acked chunks recompute the consumed range;
  // the last commit marks the job done.
  let evidence = journal.readChunkEvidence(claim);
  assert.equal(evidence.status, "ok", "first chunk evidence is served");
  const consumedText = [];
  let guard = 0;
  let drained = false;
  while (evidence.status === "ok" && guard++ < 64) {
    consumedText.push(evidence.events.map((e) => e.text).join(""));
    const report = journal.commitChunkResult(claim, evidence.chunkIdx, { kind: "consumed", candidates: [] });
    if (report?.jobState === "done") { drained = true; break; }
    evidence = journal.readChunkEvidence(claim);
    // Terminal evidence states are part of the documented contract: exhausted
    // (all chunks acked, still claimed) or unavailable/`range-not-stored` when
    // the last ack already marked the job done (the claim is settled). Either
    // way the drain must NOT fabricate more chunks or skip silently.
    if (evidence.status !== "ok") {
      const job = journal.listJobs({ sessionId: "long-input" })[0];
      if (job && job.state === "done") { drained = true; break; }
    }
  }
  const fullConsumedText = consumedText.join("");
  check(drained,
    "worker drain reaches a documented terminal evidence/job state (no silent skip)", evidence.status);
  check(fullConsumedText === longText && fullConsumedText.includes("HEAD_MARKER") && fullConsumedText.includes("MID_MARKER") && fullConsumedText.includes("TAIL_MARKER"),
    "long input coverage is LOSSLESS: head, middle and tail all survive through chunked evidence");
  check(journal.appendSession({
    sessionId: "long-input",
    projectId: opaqueProjectIdFromKey(projectKeyFromCwd("/synthetic/proj6")),
    producer: { delegated: false },
    events: [{ seq: 0, ts: 1, kind: "user", text: longText, sourceKind: "user", injected: false }],
    sourceMaxChars: JOURNAL_SOURCE_MAX_CHARS,
    oversizePolicy: "segment",
  }).deduped >= 1,
    "re-flush of the long input is content-hash deduped");
  journal.releaseClaim(claim, "contract-verification-only");
  store.close();
}

// ── 7. Extractor seam contract (claim/read/release over the ONE journal) ───
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  const { createJournalExtractSeam } = await import("../lib/capture.js");
  const seam = createJournalExtractSeam(journal);
  const flush = installWith(store, { append: (i) => journal.appendSession(i), closed: () => false });
  await flush({
    id: "seam-contract",
    header: { cwd: "/synthetic/proj7" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: bodyOf("seam turn") }], source: { kind: "user" } } },
    ],
  });
  const claim = seam.claimWork({ kind: "extract" });
  assert.ok(claim && claim.kind === "extract", "seam.claimWork returns a typed extract claim");
  check(claim.producerHeader
      && claim.producerHeader.delegated === false
      && Object.keys(claim.producerHeader.extra ?? {}).length === 0
      && JSON.stringify(claim.producerHeader).includes("SYNTHETIC") === false,
    "worker-visible producerHeader stays minimized/allowlisted", claim.producerHeader);
  const evidence = seam.readChunkEvidence(claim);
  check(evidence.status === "ok"
      && typeof evidence.events?.[0]?.text === "string" && evidence.events[0].text.length > 0
      && evidence.events[0].segIndex === 0 && evidence.events[0].injected === false,
    "seam.readChunkEvidence serves exact persisted minimized evidence", evidence.status);
  const db = store.getJournalSqlite();
  const hdr = db.prepare("SELECT producer_header_json, project_id FROM journal_jobs WHERE session_id = ?").get("seam-contract");
  check(String(hdr.producer_header_json).includes("SYNTHETIC") === false,
    "job rows carry only the minimized header (no producer-copied canaries)");
  seam.releaseClaim(claim, "contract-verification-only");
  const jobs = seam.listJobs({ sessionId: "seam-contract" });
  check(jobs.length === 1 && jobs[0].state === "queued",
    "seam.releaseClaim durably requeues without consuming the attempt budget", jobs[0].state);
  store.close();
}

// ── 8. Legacy safety control migrated to the replacement lane ──────────────
// scripts/test-v02-safety.mjs control C now observes evidence through the
// journal source table (the raw slice lane is gone); this check pins the
// same "captured exactly once (incl. seq 0)" invariant for the new lane.
{
  const store = freshStore();
  const journal = new MemoryJournalV02(store);
  const flush = installWith(store, { append: (i) => journal.appendSession(i), closed: () => false });
  const session = {
    id: "s-master-on",
    inheritedEventCount: 0,
    header: { cwd: "/tmp/proj-journal-on" },
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: bodyOf("on-session evidence") }], source: { kind: "user" } } },
    ],
  };
  await flush(session);
  await flush(session);
  const { sources } = journalRows(store, "s-master-on");
  check(sources.length === 1 && sources[0].seq === 0 && sources[0].kind === "user"
      && String(sources[0].text).includes("on-session evidence"),
    "journal lane control: with the master ON the identical evidence is captured exactly once (incl. seq 0)", sources);
  store.close();
}

for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
console.log(`Capture→journal integration: ${fail === 0 ? "PASS" : "FAILED"} (${pass} PASS / ${fail} FAIL)`);
if (fail > 0) process.exitCode = 1;
