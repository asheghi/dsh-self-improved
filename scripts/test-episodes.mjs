/**
 * Episode-learning tests (Phases 1+2): capture/redaction/pairing/assembly/classification,
 * replay idempotency, restart survival, stale closure, purge, and v2 schema behavior.
 * Run: node scripts/test-episodes.mjs
 */
import { rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../lib/storage.js";
import { installCapture } from "../lib/capture.js";
import {
  assembleSessionEpisodes,
  classifyTrajectory,
  fingerprintOf,
  closeStalePendingEpisodes,
  repairEpisodeConsistency,
} from "../lib/episodes.js";
import { redactFreeText } from "../lib/redact.js";

const root = join(process.env.TEST_DIR ?? "/tmp/dsh-mem-test", "episodes");
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

let failed = 0;
const check = (n, c, e = "") => {
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${e ? "  (" + e + ")" : ""}`);
  if (!c) failed++;
};

const newStore = (name) => {
  const dir = join(root, name);
  rmSync(dir, { recursive: true, force: true });
  return new MemoryStore(dir);
};

/** Install capture with a fake ctx that records the session/flush handler registration. */
function fakeCapture(store, opts = {}) {
  const registrations = [];
  const ctx = {
    on: (type, fn) => registrations.push({ type, fn }),
  };
  installCapture(
    ctx,
    store,
    { enabled: () => true },
    undefined,
    {
      enabled: () => (opts.episodes === undefined ? true : opts.episodes),
      maxChars: () => (opts.maxChars === undefined ? 4000 : opts.maxChars),
    },
  );
  const flush = registrations[0];
  check("installCapture registers session/flush handler", flush && flush.type === "session/flush");
  return async (session) => flush.fn(session);
}

const callEvent = (seq, turn, step, callId, name, args, time = 1000) => ({
  type: "tool/call",
  seq,
  time,
  data: { turn, step, callId, name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
});
const resultEvent = (seq, turn, step, callId, text, opts = {}, time = 2000) => ({
  type: "tool/result",
  seq,
  time,
  data: {
    turn,
    step,
    message: {
      content: [{ type: "tool-result", toolCallId: callId, content: text, ...(opts.blockError ? { isError: true } : {}) }],
      ...(opts.messageError ? { isError: true } : {}),
    },
    ...(opts.error ? { error: opts.error } : {}),
  },
});
const turnEndEvent = (seq, turn, time = 3000, reason) => ({
  type: "turn/end",
  seq,
  time,
  // Default: a completed turn-end (completion proof). Tests that exercise
  // non-completion pass an explicit reason (string → unknown kind, or {kind}).
  data: { turn, ...(reason !== undefined ? { reason } : { reason: { kind: "completed" } }) },
});

// ---------------------------------------------------------------------
// installCapture registration smoke test (fake ctx, no live Cordis)
// ---------------------------------------------------------------------
{
  const store = newStore("flush-ctl");
  const flush = fakeCapture(store);
  const session = {
    id: "s-ctl",
    header: { cwd: "/tmp/proj-ctl" },
    events: [
      callEvent(1, 1, 0, "c-1", "bash", { cmd: "ls" }),
      resultEvent(2, 1, 0, "c-1", "ok"),
      turnEndEvent(3, 1),
    ],
  };
  await flush(session);
  const episodes = store.listEpisodes({ projectId: "/tmp/proj-ctl" });
  check("installCapture flush path produces episode", episodes.length === 1 && episodes[0].status === "succeeded", JSON.stringify(store.episodeCounts()));
}

// ---------------------------------------------------------------------
// 1) Paired call/result → succeeded, 1 step, evidence linkage, no review fields
// ---------------------------------------------------------------------
{
  const store = newStore("paired");
  const flush = fakeCapture(store);
  await flush({
    id: "s1",
    header: { cwd: "/tmp/proj-a" },
    events: [
      callEvent(1, 1, 0, "call-a", "bash", { cmd: "pnpm -v" }),
      resultEvent(2, 1, 0, "call-a", "9.0.0"),
      turnEndEvent(3, 1),
    ],
  });
  const episodes = store.listEpisodes({ projectId: "/tmp/proj-a" });
  check("paired episode exists", episodes.length === 1, JSON.stringify(episodes.map((e) => e.status)));
  const ep = episodes[0];
  check("paired episode succeeded", ep.status === "succeeded");
  const steps = store.getEpisodeSteps(ep.id);
  check("single step", steps.length === 1);
  check("evidence linkage call_id", steps[0]?.callId === "call-a");
  check("no review fields on assembled episode", ep.reviewedAt === null && ep.summary === null && ep.confidence === null);
}

// ---------------------------------------------------------------------
// 2) Out-of-order results still pair by toolCallId
// ---------------------------------------------------------------------
{
  const store = newStore("out-of-order");
  const flush = fakeCapture(store);
  await flush({
    id: "s2",
    header: { cwd: "/tmp/proj-a" },
    events: [
      // result event seq LOWER than call event seq, same turn
      resultEvent(5, 1, 0, "call-b", "done"),
      callEvent(6, 1, 0, "call-b", "write", { f: "x.txt" }),
      turnEndEvent(7, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-a" })[0];
  const steps = store.getEpisodeSteps(ep.id);
  check("out-of-order result paired", ep.status === "succeeded" && steps.length === 1 && steps[0].resultSeq === 5 && steps[0].callSeq === 6);
}

// ---------------------------------------------------------------------
// 3) Missing result + later turn closes it → ambiguous, call claimed w/o step
// ---------------------------------------------------------------------
{
  const store = newStore("missing-result");
  const flush = fakeCapture(store);
  const session = { id: "s3", header: { cwd: "/tmp/proj-x" }, events: [] };
  session.events = [callEvent(1, 1, 0, "call-orphan", "bash", { cmd: "flaky" })];
  await flush(session);
  session.events = [
    callEvent(2, 2, 0, "cell-2", "bash", { cmd: "ok" }),
    resultEvent(3, 2, 0, "cell-2", "ok"),
    turnEndEvent(4, 2),
  ];
  await flush(session);
  const counts = store.episodeCounts("/tmp/proj-x");
  check("missing result → ambiguous", counts.ambiguous === 1, JSON.stringify(counts));
  const ep = store.listEpisodes({ projectId: "/tmp/proj-x" }).find((e) => e.turn === 1);
  check("unpaired audit claimed", ep !== undefined && store.getEpisodeSteps(ep.id).length === 0 && store.lastEpisodeSeq("s3") >= 1);
  // claimed rows must have episode_id set (full turnover stored)
  const claimedPending = store.getPendingEpisodeEvents("s3").filter((r) => r.turn === 1);
  check("no leftover unclaimed turn-1 rows", claimedPending.length === 0, JSON.stringify(claimedPending.length));
}

// ---------------------------------------------------------------------
// 4) Duplicate flush replay → identical counts
// ---------------------------------------------------------------------
{
  const store = newStore("replay");
  const flush = fakeCapture(store);
  const session = {
    id: "s4",
    header: { cwd: "/tmp/proj-a" },
    events: [
      callEvent(1, 1, 0, "c-r1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-r1", "y"),
      turnEndEvent(3, 1),
    ],
  };
  await flush(session);
  await flush(session); // determinstic replay: same events re-delivered
  const eps = store.listEpisodes({ projectId: "/tmp/proj-a" });
  const counts = store.episodeCounts("/tmp/proj-a");
  check("replay keeps single episode", eps.length === 1 && counts.succeeded === 1, JSON.stringify(counts));
  check("replay keeps single step", store.getEpisodeSteps(eps[0].id).length === 1);
  // Direct API-level replay idempotency (append + assemble twice with same rows)
  const rows = [
    { kind: "call", callId: "c-dup", turn: 2, step: 0, seq: 10, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-dup" }) },
    { kind: "result", callId: "c-dup", turn: 2, step: 0, seq: 11, at: 1001, payload: JSON.stringify({ toolCallId: "c-dup", resultExcerpt: "r", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: null, turn: 2, step: null, seq: 12, at: 1002, payload: JSON.stringify({ reason: "none" }) },
  ];
  store.appendEpisodeEvents("s4", "/tmp/proj-a", false, rows);
  assembleSessionEpisodes(store, "s4");
  const before = { eps: store.listEpisodes({ projectId: "/tmp/proj-a" }).length, steps: store.getEpisodeSteps(store.listEpisodes({ projectId: "/tmp/proj-a" })[0].id).length };
  store.appendEpisodeEvents("s4", "/tmp/proj-a", false, rows);
  assembleSessionEpisodes(store, "s4");
  const afterEps = store.listEpisodes({ projectId: "/tmp/proj-a" });
  check("direct replay idempotent", before.eps === afterEps.length && store.getEpisodeSteps(afterEps[0].id).length === before.steps, `before=${JSON.stringify(before)} after=${afterEps.length}`);
}

// ---------------------------------------------------------------------
// 5) Malformed arguments JSON → text-redacted string, no throw
// ---------------------------------------------------------------------
try {
  const store = newStore("malformed");
  const flush = fakeCapture(store);
  await flush({
    id: "s5",
    header: { cwd: "/tmp/proj-a" },
    events: [
      callEvent(1, 1, 0, "c-m", "bash", "not-json {oops"),
      resultEvent(2, 1, 0, "c-m", "ok"),
      turnEndEvent(3, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-a" })[0];
  const step = store.getEpisodeSteps(ep.id)[0];
  check("malformed JSON arguments fall back to text redaction", step.argumentsRedacted === redactFreeText("not-json {oops"), step.argumentsRedacted);
} catch (e) {
  check("malformed arguments do not throw", false, String(e));
}

// ---------------------------------------------------------------------
// 6) Nested secret keys redacted; 7) credential-shaped strings redacted
// ---------------------------------------------------------------------
{
  const store = newStore("secrets");
  const flush = fakeCapture(store);
  await flush({
    id: "s6",
    header: { cwd: "/tmp/proj-sec" },
    events: [
      callEvent(1, 1, 0, "c-s1", "config-write", { config: { password: "hunter2" } }),
      resultEvent(2, 1, 0, "c-s1", "Authorization: Bearer abc123supersecret"),
      turnEndEvent(3, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-sec" })[0];
  const step = store.getEpisodeSteps(ep.id)[0];
  check("nested secret key redacted before persistence", step.argumentsRedacted.includes("[REDACTED]") && !step.argumentsRedacted.includes("hunter2"), step.argumentsRedacted);
  check("Bearer credential redacted in result excerpt", step.resultExcerpt.includes("[REDACTED]") && !step.resultExcerpt.includes("abc123supersecret"), step.resultExcerpt);
}

// ---------------------------------------------------------------------
// 8) Oversized payload bounded (12000 chars vs maxChars 4000)
// ---------------------------------------------------------------------
{
  const store = newStore("oversized");
  const flush = fakeCapture(store, { maxChars: 4000 });
  const big = JSON.stringify({ data: "a".repeat(12000) });
  await flush({
    id: "s7",
    header: { cwd: "/tmp/proj-sec" },
    events: [
      callEvent(1, 1, 0, "c-big", "bash", big),
      resultEvent(2, 1, 0, "c-big", "b".repeat(9000)),
      turnEndEvent(3, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-sec" })[0];
  const step = store.getEpisodeSteps(ep.id)[0];
  check("oversized args truncated", step.argsTruncated === 1 && step.argumentsRedacted.length === 4000, `${step.argsTruncated},${step.argumentsRedacted.length}`);
  check("oversized result truncated", step.resultTruncated === 1 && step.resultExcerpt.length === 4000, `${step.resultTruncated},${step.resultExcerpt.length}`);
}

// ---------------------------------------------------------------------
// 9) Delegated session → delegated=1
// ---------------------------------------------------------------------
{
  const store = newStore("delegated");
  const flush = fakeCapture(store);
  await flush({
    id: "s8",
    header: { cwd: "/tmp/proj-deleg", origin: "subagent" },
    events: [
      callEvent(1, 1, 0, "c-dl", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-dl", "done"),
      turnEndEvent(3, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-deleg" })[0];
  check("delegated session flags episode", ep.delegated === true, JSON.stringify(ep.delegated));
}

// ---------------------------------------------------------------------
// 10/11) Failure-then-retry-then-success vs all-failure
// ---------------------------------------------------------------------
{
  const store = newStore("retry");
  const flush = fakeCapture(store);
  await flush({
    id: "s9",
    header: { cwd: "/tmp/proj-a" },
    events: [
      callEvent(1, 1, 0, "c-e1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-e1", "command not found", { messageError: true }),
      callEvent(3, 1, 1, "c-ok1", "bash", { cmd: "y" }),
      resultEvent(4, 1, 1, "c-ok1", "ok"),
      callEvent(5, 1, 2, "c-ok2", "grep", { cmd: "z" }),
      resultEvent(6, 1, 2, "c-ok2", "match"),
      turnEndEvent(7, 1),
    ],
  });
  const epA = store.listEpisodes({ projectId: "/tmp/proj-a" }).find((e) => e.turn === 1);
  const stepsA = store.getEpisodeSteps(epA.id);
  check("same-tool retry last attempt ok → succeeded", epA.status === "succeeded" && stepsA.length === 3, JSON.stringify(stepsA.map((s) => [s.toolName, s.isError])));
  check("ordinal sequence", stepsA.map((s) => s.ordinal).join(",") === "1,2,3");
}
{
  const store = newStore("all-fail");
  const flush = fakeCapture(store);
  await flush({
    id: "s10",
    header: { cwd: "/tmp/proj-a" },
    events: [
      callEvent(1, 1, 0, "c-f1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-f1", "err", { blockError: true, error: { name: "ToolError", code: "E1" } }),
      turnEndEvent(3, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-a" })[0];
  const steps = store.getEpisodeSteps(ep.id);
  check("all failure → failed", ep.status === "failed" && steps.length === 1 && steps[0].isError === 1);
  check("error metadata stored", steps[0].errorName === "ToolError" && steps[0].errorCode === "E1");
}

// ---------------------------------------------------------------------
// 11) Interrupted turn-end with unpaired calls → ambiguous
// ---------------------------------------------------------------------
{
  const store = newStore("interrupted");
  const flush = fakeCapture(store);
  await flush({
    id: "s11",
    header: { cwd: "/tmp/proj-i" },
    events: [
      callEvent(1, 1, 0, "c-i1", "bash", { cmd: "x" }),
      turnEndEvent(2, 1, 3000, "cancelled"),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-i" })[0];
  check("interrupted turn → ambiguous", ep.status === "ambiguous" && store.getEpisodeSteps(ep.id).length === 0, JSON.stringify(ep));
  // A plain-string reason carries no kind → categorical reasonKind 'unknown' (not-completed)
  const rows = store.getTurnEpisodeEvents("s11", 1).filter((r) => r.kind === "turn-end");
  check("turn-end reasonKind recorded", JSON.parse(rows[0].payload).reasonKind === "unknown", rows[0].payload);
}

// ---------------------------------------------------------------------
// 11b) Explicit aborted kind → ambiguous; no completed proof → ambiguous
// ---------------------------------------------------------------------
{
  const store = newStore("aborted");
  const flush = fakeCapture(store);
  await flush({
    id: "s-ab",
    header: { cwd: "/tmp/proj-i" },
    events: [
      callEvent(1, 1, 0, "c-ab1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-ab1", "ok"),
      turnEndEvent(3, 1, 3000, { kind: "aborted" }),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-i" })[0];
  check("completed pairs but aborted reasonKind → ambiguous", ep.status === "ambiguous" && store.getEpisodeSteps(ep.id).length === 1, JSON.stringify(ep));
  const ok = newStore("blocked-kind");
  const flush2 = fakeCapture(ok);
  await flush2({
    id: "s-bk",
    header: { cwd: "/tmp/proj-i" },
    events: [
      callEvent(1, 1, 0, "c-bk1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-bk1", "ok"),
      turnEndEvent(3, 1, 3000, { kind: "blocked" }),
    ],
  });
  check("blocked reasonKind → ambiguous", ok.listEpisodes({ projectId: "/tmp/proj-i" })[0].status === "ambiguous");
}

// ---------------------------------------------------------------------
// 11c) No own turn-end, closed only by a later turn → ambiguous (even fully paired)
// ---------------------------------------------------------------------
{
  const store = newStore("no-turn-end-later");
  const flush = fakeCapture(store);
  await flush({
    id: "s-n1",
    header: { cwd: "/tmp/proj-n1" },
    events: [
      callEvent(1, 1, 0, "c-n1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-n1", "ok"),
    ],
  });
  await flush({
    id: "s-n1",
    header: { cwd: "/tmp/proj-n1" },
    events: [
      callEvent(3, 2, 0, "c-n2", "bash", { cmd: "y" }),
      resultEvent(4, 2, 0, "c-n2", "ok"),
      turnEndEvent(5, 2),
    ],
  });
  const ep1 = store.listEpisodes({ projectId: "/tmp/proj-n1" }).find((e) => e.turn === 1);
  check("no own turn-end but later turn → ambiguous", ep1.status === "ambiguous", JSON.stringify(ep1));
}

// ---------------------------------------------------------------------
// 12) Restart survival: reopen the same dir and re-assemble → same episodes
// ---------------------------------------------------------------------
{
  const dir = join(root, "restart");
  rmSync(dir, { recursive: true, force: true });
  const store1 = new MemoryStore(dir);
  const flush = fakeCapture(store1);
  const session = {
    id: "s12",
    header: { cwd: "/tmp/proj-re" },
    events: [
      callEvent(1, 1, 0, "c-r1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-r1", "ok"),
      turnEndEvent(3, 1),
    ],
  };
  await flush(session);
  const before = store1.listEpisodes({ projectId: "/tmp/proj-re" });
  store1.close();
  const store2 = new MemoryStore(dir);
  const eps2 = store2.listEpisodes({ projectId: "/tmp/proj-re" });
  check("episodes survive restart", eps2.length === before.length && eps2.length === 1 && eps2[0].status === "succeeded");
  // Replay after restart must be a no-op
  const flush2 = fakeCapture(store2);
  await flush2(session);
  check("post-restart replay idempotent", store2.listEpisodes({ projectId: "/tmp/proj-re" }).length === 1);
  store2.close();
}

// ---------------------------------------------------------------------
// 13) Stale pending closure
// ---------------------------------------------------------------------
{
  const store = newStore("stale");
  const flush = fakeCapture(store, { episodes: true });
  // turn 1 never closes (no later turn, no turn-end within this batch) → pending probe
  await flush({
    id: "s13",
    header: { cwd: "/tmp/proj-stale" },
    events: [callEvent(1, 1, 0, "c-st", "bash", { cmd: "x" })],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-stale" })[0];
  check("open turn leaves pending probe", ep && ep.status === "pending", JSON.stringify(ep?.status));
  // stale closure needs an older updated_at: wait past a clock tick first
  await new Promise((r) => setTimeout(r, 5));
  const closed = closeStalePendingEpisodes(store, 0); // olderThanMs=0 → everything stale
  check("stale pending closed", closed === 1 && store.getEpisode(ep.id).status === "ambiguous" && store.getEpisode(ep.id).endedAt !== null, JSON.stringify(closed));
}

// ---------------------------------------------------------------------
// 14) Purge removes episodes + steps + claims with correct counts
// ---------------------------------------------------------------------
{
  const store = newStore("purge");
  const flush = fakeCapture(store);
  await flush({
    id: "s14",
    header: { cwd: "/tmp/proj-purge" },
    events: [
      callEvent(1, 1, 0, "c-p1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-p1", "ok"),
      turnEndEvent(3, 1),
    ],
  });
  const totalBefore = store.totalEpisodeEventCount();
  check("purge prep rows exist", totalBefore >= 3, String(totalBefore));
  const counts = store.purgeEpisodes({ projectId: "/tmp/proj-purge" });
  check("purge counts correct", counts.episodes === 1 && counts.steps === 1 && counts.events === totalBefore, JSON.stringify({ ...counts, totalBefore }));
  check("purge emptied project", store.listEpisodes({ projectId: "/tmp/proj-purge" }).length === 0 && store.getPendingEpisodeEvents("s14").length === 0);
}

// ---------------------------------------------------------------------
// 14b) Consistency repair: no-op safety + reviewed rows are never reclassified
// ---------------------------------------------------------------------
{
  const store = newStore("repair");
  const flush = fakeCapture(store);
  await flush({
    id: "s15",
    header: { cwd: "/tmp/proj-rep" },
    events: [
      callEvent(1, 1, 0, "c-rp", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-rp", "ok"),
      turnEndEvent(3, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-rep" })[0];
  store.setEpisodeReview(ep.id, { summary: "saw pnpm work", confidence: 0.9, status: "reviewed" });
  // Assembly after review must NOT touch the reviewed episode (would-be replay rows are only audit claims)
  try {
    assembleSessionEpisodes(store, "s15");
    check("repair re-assembly does not throw", true);
  } catch (e) {
    check("repair re-assembly does not throw", false, String(e));
  }
  const reviewed = store.getEpisode(ep.id);
  check("reviewed row frozen", reviewed.status === "reviewed" && reviewed.summary === "saw pnpm work" && reviewed.confidence === 0.9);
  const updated = store.getEpisode(ep.id);
  check("review fields intact after repair", updated.reviewedAt !== null && updated.summary === "saw pnpm work");
  repairEpisodeConsistency(store);
  check("repair no-op on healthy store", store.episodeCounts("/tmp/proj-rep").reviewed === 1);
}

// ---------------------------------------------------------------------
// 15) Pure helpers: classifyTrajectory + fingerprintOf
// ---------------------------------------------------------------------
check("classify: unpaired → ambiguous", classifyTrajectory([{ tool_name: "bash", is_error: 0 }], 1) === "ambiguous");
check("classify: failure then retry → succeeded", classifyTrajectory([{ tool_name: "bash", is_error: 1 }, { tool_name: "bash", is_error: 0 }], 0) === "succeeded");
check("classify: last attempt fails → failed", classifyTrajectory([{ tool_name: "bash", is_error: 0 }, { tool_name: "bash", is_error: 1 }], 0) === "failed");
check("classify: all failure → failed", classifyTrajectory([{ tool_name: "bash", is_error: 1 }, { tool_name: "grep", is_error: 1 }], 0) === "failed");
check("classify: empty steps → ambiguous", classifyTrajectory([], 0) === "ambiguous");
check("fingerprint deterministic 16 hex chars", fingerprintOf(["bash", "grep"]) === fingerprintOf(["bash", "grep"]) && /^[0-9a-f]{16}$/.test(fingerprintOf(["bash", "grep"])));
check("fingerprint order-sensitive", fingerprintOf(["grep", "bash"]) !== fingerprintOf(["bash", "grep"]));

// ---------------------------------------------------------------------
// 15b) Ownership trust limits: duplicate callId / duplicate toolCallId / malformed result
// ---------------------------------------------------------------------
{
  const store = newStore("dup-callid");
  const flush = fakeCapture(store);
  await flush({
    id: "s-dup",
    header: { cwd: "/tmp/proj-dup" },
    events: [
      callEvent(1, 1, 0, "c-dc", "bash", { cmd: "x" }),
      callEvent(2, 1, 1, "c-dc", "bash", { cmd: "y" }), // two calls share one callId
      resultEvent(3, 1, 0, "c-dc", "ok"),
      turnEndEvent(4, 1),
    ],
  });
  const ep = store.listEpisodes({ projectId: "/tmp/proj-dup" })[0];
  check("duplicate callId → ambiguous", ep.status === "ambiguous", JSON.stringify(ep));
  check("duplicate callId → no steps", store.getEpisodeSteps(ep.id).length === 0);
  check("duplicate callId rows claimed", store.getPendingEpisodeEvents("s-dup").length === 0);
}
{
  const store = newStore("dup-result");
  store.appendEpisodeEvents("s-dr", "/tmp/proj-dup", false, [
    { kind: "call", callId: "c-dr", turn: 1, step: 0, seq: 1, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-dr" }) },
    { kind: "result", callId: "c-dr", turn: 1, step: 0, seq: 2, at: 1001, payload: JSON.stringify({ toolCallId: "c-dr", resultExcerpt: "r1", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "result", callId: "c-dr", turn: 1, step: 1, seq: 3, at: 1002, payload: JSON.stringify({ toolCallId: "c-dr", resultExcerpt: "r2", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn: 1, step: null, seq: 4, at: 1003, payload: JSON.stringify({ reasonKind: "completed" }) },
  ]);
  assembleSessionEpisodes(store, "s-dr");
  const ep = store.listEpisodes({ projectId: "/tmp/proj-dup" })[0];
  check("two results sharing toolCallId → ambiguous no steps", ep.status === "ambiguous" && store.getEpisodeSteps(ep.id).length === 0, JSON.stringify(ep));
}
{
  const store = newStore("malformed-result");
  store.appendEpisodeEvents("s-mr", "/tmp/proj-mr", false, [
    { kind: "call", callId: "c-mr", turn: 1, step: 0, seq: 1, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-mr" }) },
    { kind: "result", callId: "c-mr", turn: 1, step: 0, seq: 2, at: 1001, payload: "{oops not json" },
    { kind: "turn-end", callId: "", turn: 1, step: null, seq: 3, at: 1002, payload: JSON.stringify({ reasonKind: "completed" }) },
  ]);
  assembleSessionEpisodes(store, "s-mr");
  const ep = store.listEpisodes({ projectId: "/tmp/proj-mr" })[0];
  check("malformed result → ambiguous", ep.status === "ambiguous" && store.getEpisodeSteps(ep.id).length === 0 && store.getPendingEpisodeEvents("s-mr").length === 0, JSON.stringify(ep));
}

// ---------------------------------------------------------------------
// 15c) Late evidence: succeeded + new unclaimed rows → ambiguous ('late-evidence')
// ---------------------------------------------------------------------
{
  const store = newStore("late-evidence");
  const flush = fakeCapture(store);
  await flush({
    id: "s-lv",
    header: { cwd: "/tmp/proj-lv" },
    events: [
      callEvent(1, 1, 0, "c-lv1", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-lv1", "ok"),
      turnEndEvent(3, 1),
    ],
  });
  const ep1 = store.listEpisodes({ projectId: "/tmp/proj-lv" })[0];
  check("pre-state succeeded", ep1.status === "succeeded");
  await new Promise((r) => setTimeout(r, 5));
  store.appendEpisodeEvents("s-lv", "/tmp/proj-lv", false, [
    { kind: "call", callId: "c-lv2", turn: 1, step: 1, seq: 90, at: 4000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-lv2" }) },
  ]);
  assembleSessionEpisodes(store, "s-lv");
  const demoted = store.getEpisode(ep1.id);
  check("late evidence → ambiguous + late-evidence", demoted.status === "ambiguous" && demoted.summary === null && demoted.confidence === null && demoted.reviewedAt === null && demoted.rejectReason === "late-evidence", JSON.stringify(demoted));
  check("late evidence rows claimed", store.getPendingEpisodeEvents("s-lv").length === 0);
  // Protected: a REVIEWED terminal episode is never demoted. Fresh session/turn:
  // build succeeded, review it, then late rows arrive.
  const store2 = newStore("late-evidence-reviewed");
  const flush2 = fakeCapture(store2);
  await flush2({
    id: "s-lv2",
    header: { cwd: "/tmp/proj-lv" },
    events: [
      callEvent(1, 1, 0, "c-lv2a", "bash", { cmd: "x" }),
      resultEvent(2, 1, 0, "c-lv2a", "ok"),
      turnEndEvent(3, 1),
    ],
  });
  const reviewedEp = store2.listEpisodes({ projectId: "/tmp/proj-lv" })[0];
  store2.setEpisodeReview(reviewedEp.id, { summary: "keep", confidence: 0.9, status: "reviewed" });
  store2.appendEpisodeEvents("s-lv2", "/tmp/proj-lv", false, [
    { kind: "call", callId: "c-lv2b", turn: 1, step: 2, seq: 91, at: 4001, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-lv2b" }) },
  ]);
  assembleSessionEpisodes(store2, "s-lv2");
  const frozen = store2.getEpisode(reviewedEp.id);
  check("reviewed episode never touched by late evidence", frozen.status === "reviewed" && frozen.summary === "keep", JSON.stringify(frozen));
}

// ---------------------------------------------------------------------
// 15d) Pending-event recovery: stranded rows assembled by the recovery path
// ---------------------------------------------------------------------
{
  const store = newStore("pending-recovery");
  store.appendEpisodeEvents("s-pr", "/tmp/proj-pr", false, [
    { kind: "call", callId: "c-pr1", turn: 1, step: 0, seq: 1, at: 1000, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-pr1" }) },
    { kind: "result", callId: "c-pr1", turn: 1, step: 0, seq: 2, at: 1001, payload: JSON.stringify({ toolCallId: "c-pr1", resultExcerpt: "ok", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn: 1, step: null, seq: 3, at: 1002, payload: JSON.stringify({ reasonKind: "completed" }) },
  ]);
  check("sessionsWithPendingEpisodeEvents sees the stranded session", store.sessionsWithPendingEpisodeEvents(100).includes("s-pr"));
  // Startup-recovery helper path: assemble directly, no flush involved.
  assembleSessionEpisodes(store, "s-pr");
  const eps = store.listEpisodes({ projectId: "/tmp/proj-pr" });
  check("pending rows recovered into episode", eps.length === 1 && eps[0].status === "succeeded", JSON.stringify(eps.map((e) => e.status)));
  check("recovery drains pending rows", store.sessionsWithPendingEpisodeEvents(100).includes("s-pr") === false);
}

// ---------------------------------------------------------------------
// 15e) Starvation: a 2000-event open turn must not starve a later closed turn
// ---------------------------------------------------------------------
{
  const store = newStore("starvation");
  const bigOpenRows = [];
  for (let i = 1; i <= 2000; i++) {
    bigOpenRows.push({ kind: "call", callId: `c-open-${i}`, turn: 1, step: null, seq: i, at: 1000 + i, payload: JSON.stringify({ toolName: "bash", argumentsRedacted: "{}", argsTruncated: 0, callId: `c-open-${i}` }) });
  }
  bigOpenRows.push(
    { kind: "call", callId: "c-t2", turn: 2, step: 0, seq: 2001, at: 5000, payload: JSON.stringify({ toolName: "sed", argumentsRedacted: "{}", argsTruncated: 0, callId: "c-t2" }) },
    { kind: "result", callId: "c-t2", turn: 2, step: 0, seq: 2002, at: 5001, payload: JSON.stringify({ toolCallId: "c-t2", resultExcerpt: "ok", resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: "turn-end", callId: "", turn: 2, step: null, seq: 2003, at: 5002, payload: JSON.stringify({ reasonKind: "completed" }) },
  );
  store.appendEpisodeEvents("s-st2", "/tmp/proj-st2", false, bigOpenRows);
  assembleSessionEpisodes(store, "s-st2");
  const ep1 = store.getEpisodeBySessionTurn("s-st2", 1);
  const ep2 = store.getEpisodeBySessionTurn("s-st2", 2);
  check("open turn closed via full-ledger closure", ep1 && ep1.status === "ambiguous", JSON.stringify(ep1?.status));
  check("later closed turn assembled behind big open turn", ep2 && ep2.status === "succeeded" && store.getEpisodeSteps(ep2.id).length === 1, JSON.stringify(ep2?.status));
}

// ---------------------------------------------------------------------
// 15f) Staleness: pending episode refreshed on later activity (stale closure
//      measures from updated_at, so an active long turn is not killed)
// ---------------------------------------------------------------------
{
  const store = newStore("touch-pending");
  const flush = fakeCapture(store);
  await flush({
    id: "s-tp",
    header: { cwd: "/tmp/proj-tp" },
    events: [callEvent(1, 1, 0, "c-tp1", "bash", { cmd: "x" })],
  });
  const ep = store.getEpisodeBySessionTurn("s-tp", 1);
  check("open turn pending probe", ep && ep.status === "pending");
  const before = ep.updatedAt;
  await new Promise((r) => setTimeout(r, 10));
  await flush({
    id: "s-tp",
    header: { cwd: "/tmp/proj-tp" },
    events: [callEvent(2, 1, 1, "c-tp2", "bash", { cmd: "y" })],
  });
  const after = store.getEpisodeBySessionTurn("s-tp", 1);
  check("pending episode touched by later activity", after.updatedAt > before, `${before} -> ${after.updatedAt}`);
  // Measured from refreshed updated_at: the episode is not 5ms old yet.
  const closed = closeStalePendingEpisodes(store, 5);
  check("stale closure does not close a recently active turn", closed === 0 && store.getEpisode(ep.id).status === "pending", JSON.stringify(closed));
  // Control: the same threshold must still close genuinely stale probes
  await new Promise((r) => setTimeout(r, 10));
  const closedLate = closeStalePendingEpisodes(store, 5);
  check("stale closure still fires for inactive probes", closedLate === 1, JSON.stringify(closedLate));
}

// ---------------------------------------------------------------------
// 16) Router keys and no-push feature gates: episode events NOT captured when disabled
// ---------------------------------------------------------------------
{
  const store = newStore("disabled");
  const flush = fakeCapture(store, { episodes: false });
  await flush({
    id: "s16",
    header: { cwd: "/tmp/proj-off" },
    events: [
      callEvent(1, 1, 0, "c-off", "bash", { cmd: "x" }),
      turnEndEvent(2, 1),
    ],
  });
  check("disabled capture stores nothing", store.totalEpisodeEventCount() === 0 && store.listEpisodes({ projectId: "/tmp/proj-off" }).length === 0);
}

console.log(failed === 0 ? "\nALL PASS ✅" : `\n${failed} FAILED ❌`);
process.exit(failed === 0 ? 0 : 1);
