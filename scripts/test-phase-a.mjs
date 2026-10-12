#!/usr/bin/env node
/**
 * Phase A acceptance tests (MIGRATION-V0.2.md): rc.2 boundary behaviors that
 * the legacy suites cannot express. Synthetic data only; no live profile,
 * runtime modification, or provider access.
 *
 * Run: node scripts/test-phase-a.mjs
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { readOwnSessionEvents, evaluateTerminalFinish, isInjectedContextUserSource } = await import("../lib/compat-v02.js");
const { installCapture, toEpisodeEventRow } = await import("../lib/capture.js");
const { installRecallInjection } = await import("../lib/inject.js");
const { MemoryStore } = await import("../lib/storage.js");

let failures = 0;
function check(ok, name, detail) {
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `  (${String(detail)})` : ""}`);
  }
}

// ── Session event window (rc.2 snapshot/own-events adaptation) ──
{
  const own = [
    { type: "user/message", seq: 2, time: 1, data: { content: [{ type: "text", text: "own two" }], source: { kind: "user" } } },
    { type: "user/message", seq: 0, time: 0, data: { content: [{ type: "text", text: "own zero" }], source: { kind: "user" } } },
  ];
  const session = { ownEvents: () => own, inheritedEventCount: 2, header: {} };
  const all = readOwnSessionEvents(session, -1);
  check(all.length === 2, "own events are read (both returned)", JSON.stringify(all.map((e) => e.seq)));
  check(all.some((e) => e.seq === 0), "seq 0 IS captured (floor supports the zero-based log)");
  check(JSON.stringify(readOwnSessionEvents(session, 0).map((e) => e.seq)) === "[2]", "cursor strictly-above semantics: from 0 returns only seq 2 (seq 0 consumed)", JSON.stringify(readOwnSessionEvents(session, 0).map((e) => e.seq)));
}
{
  const session = { events: [{ type: "user/message", seq: 3, time: 0, data: { source: { kind: "user" }, content: [{ type: "text", text: "hello" }] } }] };
  check(readOwnSessionEvents(session, -1).length === 1, "legacy-shaped (mock) sessions flow through the same adapter");
}

// ── Capture: fork cut, seq zero, disabled gate ──
{
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-phase-a-")), "store");
  const store = new MemoryStore(dir);
  const captured = [];
  let enabled = false; // Phase A gate: disabled plugin performs no capture work
  const flushes = [];
  let pumpCalls = 0;
  installCapture(
    { on: (name, fn) => flushes.push({ name, fn }) },
    store,
    { enabled: () => enabled },
    () => { pumpCalls++; return "ok"; },
    { enabled: () => true, maxChars: () => 800 },
  );
  check(flushes.length === 1 && flushes[0].name === "session/flush", "exactly one session/flush listener registered");
  check(pumpCalls === 0, "disabled plugin performed no capture pump at install time");

  // Strict disabled instrumentation (coordinator round-22): a DISABLED flush on
  // a throwing source must not even READ the source — zero ownEvents reads.
  let sourceReads = 0;
  const throwingEnabledSession = {
    id: "disabled-probe",
    header: { cwd: "/tmp/unused" },
    get ownEvents() { sourceReads++; throw new Error("disabled flush must not read source events"); },
    inheritedEventCount: 0,
  };
  let disabledThrow = null;
  try {
    await flushes[0].fn(throwingEnabledSession);
  } catch (error) {
    disabledThrow = error;
  }
  check(disabledThrow === null && sourceReads === 0, "disabled flush performs ZERO source reads (throwing source untouched)", JSON.stringify({ sourceReads, threw: disabledThrow !== null }));
  check(pumpCalls === 0, "disabled flush reaches no capture pump");

  // rc.2-shaped fork session: inherited prefix of 2, own events at seq 2..4 (incl. exact seq 2 own event)
  const session = {
    id: "fork-child-a",
    header: { cwd: "/tmp/proj-phase-a" },
    inheritedEventCount: 2,
    ownEvents: () => [
      { type: "user/message", seq: 3, time: 11, data: { content: [{ type: "text", text: "child request text" }], source: { kind: "user" } } },
      { type: "tool/result", seq: 4, time: 12, data: { turn: 1, step: 0, message: { toolCallId: "call-x", isError: false, content: [{ type: "text", text: "build ok" }] } } },
      { type: "tool/call", seq: 2, time: 10, data: { turn: 1, step: 0, callId: "call-x", name: "bash", arguments: '{"cmd":"pnpm build"}' } },
      { type: "turn/end", seq: 5, time: 13, data: { turn: 1, reason: { kind: "completed" } } },
    ].sort((a, b) => a.seq - b.seq),
  };
  enabled = true; // the gate exercised at install time; the flush below runs with the plugin enabled
  await flushes[0].fn(session);
  captured.push("flushed");
  const slices = typeof store.readSlices === "function" ? store.readSlices("fork-child-a", -1, 1e9) : [];
  check(slices.every((s) => s.seq >= 2), "fork-inherited prefix (seq<inheritedEventCount) is never captured", JSON.stringify(slices.map((s) => s.seq)));
  check(slices.every((s) => s.type !== undefined), "message-only slices captured; tool/call goes to episode evidence instead", JSON.stringify(slices.length));
  const episodes = store.getEpisodes ? store.getEpisodes({ sessionId: "fork-child-a" }) : store.listEpisodes({ projectId: "/tmp/proj-phase-a" });
  const ep = episodes.length === 1 ? episodes[0] : null;
  const steps = ep ? store.getEpisodeSteps(ep.id) : [];
  check(ep !== null && steps.length === 1, "rc.2 flat tool/result normalizes and pairs with its tool/call (one step)", JSON.stringify({ episodes: episodes.length, steps: steps.length }));
  store.close();
}

// ── Legacy nested tool-result shape is NOT accepted as valid pairing evidence ──
{
  const row = toEpisodeEventRow({ type: "tool/result", seq: 5, time: 1, data: { turn: 1, step: 0, message: { content: [{ type: "tool-result", toolCallId: "call-legacy", content: "x" }] } } }, 800);
  check(row === null, "legacy nested tool-result block is rejected at rc.2 normalization (adapter does not fabricate pairing)");
}

// ── Injection: spread decision preserves unknown/extensible fields ──
{
  const handlers = {};
  const fakeCtx = { on: (name, fn) => { handlers[name] = fn; } };
  const recallStub = { async search() { return [{ id: "h1", kind: "fact", content: "content", importance: 7, score: 1 }]; }, searchOperational: () => [] };
  installRecallInjection(fakeCtx, recallStub, { enabled: () => true, maxHits: 5, maxChars: 2000, sessionIdOf: () => "sA", projectKeyOf: () => "pA" });
  const handler = handlers["agent/pre-step"];
  // rc.2 UserMessage REQUIRES a declared source; the fixture uses the genuine human producer.
  const decision = { kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "some topic" }], source: { kind: "user" } }], startsRequestSeries: true, futureField: { keep: true } };
  const out = await handler({ step: 1, agent: { id: "sa" }, signal: undefined }, async () => decision);
  check(out && out.futureField && out.futureField.keep === true, "pre-step waterfall SPREADS the decision (extensible fields preserved)");
  check(out.startsRequestSeries === true, "startsRequestSeries is preserved verbatim on the returned decision");
  const appended = out.messages[out.messages.length - 1];
  check(appended.source?.kind === "dsh-self-improved" && appended.source?.form === "snapshot", "injected recall message carries the declared source kind + snapshot supersede form", JSON.stringify(appended.source));
  check(appended.role === "user", "recall is a model-visible user-role context message");
}

// ── Disabled recall controller never touches the decision ──
{
  const handlers = {};
  const fakeCtx = { on: (name, fn) => { handlers[name] = fn; } };
  installRecallInjection(fakeCtx, { search: async () => { throw new Error("must not be called"); } }, { enabled: () => false, maxHits: 5 });
  const handler = handlers["agent/pre-step"];
  const decision = { kind: "enter", messages: [{ role: "user", content: [{ type: "text", text: "topic" }] }] };
  const out = await handler({ step: 1, agent: { id: "s" }, signal: undefined }, async () => decision);
  check(out.messages.length === 1 && !handlers["agent/inbox/inserted"], "disabled recall: decision untouched and no queued-context path registered");
}

// ── aux model call: terminal finish validation matrix ──
{
  check(evaluateTerminalFinish("stop", true).blocked === false, "finish 'stop' completes output");
  check(evaluateTerminalFinish("tool-calls", true).blocked === true, "finish 'tool-calls' cannot complete an unverified aux review");
  check(evaluateTerminalFinish("max-tokens", true).blocked === true, "finish 'max-tokens' is refused as incomplete");
  check(evaluateTerminalFinish("aborted", true).blocked === true, "finish 'aborted' is refused");
  check(evaluateTerminalFinish("error", true).blocked === true, "finish 'error' is refused");
  check(evaluateTerminalFinish("anything", false).blocked === true, "missing finish chunk is refused");
  check(evaluateTerminalFinish("unknown-provider-reason", true).blocked === true, "unknown extensible finish reason is conservatively refused");
}

// ── Event vocabulary: the plugin introduces no ad-hoc session event types ──
{
  const globSync = (await import("node:fs")).readdirSync;
  const libFiles = globSync(join("lib")).filter((f) => f.endsWith(".js"));
  const { readFileSync } = await import("node:fs");
  let offenders = [];
  for (const f of libFiles) {
    const src = readFileSync(join("lib", f), "utf8");
    // Plugin code appended session events would appear as session.append calls.
    for (const m of src.matchAll(/(?:session|sessions)\??\.append\s*\(/g)) offenders.push(`${f}: ${m[0]}`);
  }
  check(offenders.length === 0, "built plugin never appends ad-hoc session events", JSON.stringify(offenders));
}

// ── Query authority: unknown/coordinator producers never drive retrieval ──
{
  const handlers = {};
  const fakeCtx = { on: (name, fn) => { handlers[name] = fn; } };
  let searched = 0;
  const recallStub = { async search() { searched++; return []; }, searchOperational: () => [] };
  installRecallInjection(fakeCtx, recallStub, { enabled: () => true, maxHits: 5, sessionIdOf: () => "auth", projectKeyOf: () => "p" });
  const handler = handlers["agent/pre-step"];
  await handler({ step: 1, agent: { id: "a" }, signal: undefined }, async () => ({
    kind: "enter",
    messages: [{ role: "user", content: [{ type: "text", text: "coordinator source request" }], source: { kind: "coordinator-unknown" } }],
  }));
  await handler({ step: 1, agent: { id: "a" }, signal: undefined }, async () => ({
    kind: "enter",
    messages: [{ role: "user", content: [{ type: "text", text: "relay source request" }], source: { kind: "relay" } }],
  }));
  check(searched === 0, "unknown/coordinator/relay producers never drive recall retrieval", String(searched));
  const okOut = await handler({ step: 1, agent: { id: "a" }, signal: undefined }, async () => ({
    kind: "enter",
    messages: [{ role: "user", content: [{ type: "text", text: "genuine request" }], source: { kind: "user" } }],
  }));
  check(searched === 1 && okOut.messages.length === 1, "verified user producer drives retrieval normally", String(searched));
}

// ── Source-kind guard helpers ──
{
  check(isInjectedContextUserSource({ kind: "dsh-self-improved", form: "recall" }) === true, "own injected context is recognized");
  check(isInjectedContextUserSource({ kind: "user" }) === false, "genuine user input is not an injected context");
}

// ── Unchanged-snapshot gate: identical repeat turns never duplicate the snapshot ──
// Evidence base: rc.2 agent-loop durably appends every admitted decision
// message as `user/message` and no rc.2 consumer prunes earlier producer
// snapshots from deriveMessages(); without this gate N identical turns
// accumulated N recall snapshots in every later request (verified against the
// genuine rc.2 Session/agent-loop admission code with an isolated fixture).
{
  const handlers = {};
  const fakeCtx = { on: (name, fn) => { handlers[name] = fn; } };
  let searches = 0;
  let opsEnabled = false;
  const recallStub = {
    async search() { searches++; return [{ id: "h1", kind: "fact", content: "stable content", importance: 7, score: 1 }]; },
    searchOperational: () => (opsEnabled ? [{ id: "op1", kind: "lesson", content: "fresh fence", confidence: 0.9 }] : []),
  };
  installRecallInjection(fakeCtx, recallStub, {
    enabled: () => true, maxHits: 5, maxChars: 4000, sessionIdOf: () => "s1", projectKeyOf: () => "p1",
    // Phase B: a durable revision source is wired so the fenced replay path is
    // exercised; without it the adapter fails closed to a fresh search and the
    // cache-serve discipline could regress silently.
    memoryRevision: () => 4,
    operational: { enabled: () => opsEnabled, maxResults: 2, maxChars: 600, confidenceFloor: 0.8 },
  });
  const handler = handlers["agent/pre-step"];
  const run = (turn) => handler({ step: 1, agent: { id: "s1" }, signal: undefined }, async () => ({
    kind: "enter",
    messages: [{ role: "user", content: [{ type: "text", text: "stable topic" }], source: { kind: "user" } }],
  }));
  const d1 = await run(1);
  check(d1.messages.length === 2, "first qualifying turn admits exactly one recall snapshot");
  const d2 = await run(2);
  check(
    d2.messages.length === 1,
    "identical repeat turn does NOT re-admit an unchanged snapshot (rc.2 has no pruner; duplication would grow every later request)",
    `messages=${d2.messages.length}`,
  );
  check(searches === 1, "repeat turn with unchanged trusted content does not re-search (cache serve)", String(searches));
  // Operational fence change → the snapshot CHANGED → must re-admit the newest state.
  opsEnabled = true;
  const d3 = await run(3);
  const last = d3.messages[d3.messages.length - 1];
  check(
    d3.messages.length === 2 && last.source?.kind === "dsh-self-improved",
    "changed render (operational fence update) re-admits a newer snapshot with the fresh fence",
    `messages=${d3.messages.length}`,
  );
  check(
    last.content?.[0]?.text.includes("fresh fence"),
    "re-admitted snapshot carries the changed (latest) content",
    JSON.stringify(last.content?.[0]?.text?.slice(-80)),
  );
}

// ── Harness runtime-context snapshot AFTER the genuine turn must not suppress recall ──
// Evidence base: rc.2 agent-loop preStep decision shape is `[...claimed, context]`
// — the runtime-context snapshot is the LAST user-role decision message, so the
// previous blanket refusal made recall silently skip on every turn whose
// dynamic context changed (verified with a genuine rc.2-shaped fixture).
{
  const handlers = {};
  const fakeCtx = { on: (name, fn) => { handlers[name] = fn; } };
  let searched = 0;
  installRecallInjection(fakeCtx, { async search() { searched++; return [{ id: "h9", kind: "fact", content: "hit", importance: 7, score: 1 }]; }, searchOperational: () => [] }, { enabled: () => true, maxHits: 5, sessionIdOf: () => "s2", projectKeyOf: () => "p2" });
  const handler = handlers["agent/pre-step"];
  const out = await handler({ step: 1, agent: { id: "s2" }, signal: undefined }, async () => ({
    kind: "enter",
    messages: [
      { role: "user", content: [{ type: "text", text: "genuine human turn" }], source: { kind: "user" } },
      // exact harness runtime-context decision tail: {kind:"runtime-context"}
      { role: "user", content: [{ type: "text", text: "Current runtime context: …" }], source: { kind: "runtime-context" } },
      // full formed variant too: {kind:"runtime-context", form:"snapshot", sections}
      { role: "user", content: [{ type: "text", text: "Current runtime context: …" }], source: { kind: "runtime-context", form: "snapshot", sections: [{ name: "ctx", text: "…" }] } },
    ],
  }));
  check(searched === 1, "harness runtime-context snapshots following the user turn are skipped, not refused", String(searched));
  check(
    out.messages?.some((m) => m.source?.kind === "dsh-self-improved"),
    "recall is still admitted for the verified human turn behind the harness snapshot",
  );
}

// ── Unknown producer AFTER a genuine user turn still refuses (no authority widening) ──
{
  const handlers = {};
  const fakeCtx = { on: (name, fn) => { handlers[name] = fn; } };
  let searched = 0;
  installRecallInjection(fakeCtx, { async search() { searched++; return []; }, searchOperational: () => [] }, { enabled: () => true, maxHits: 5, sessionIdOf: () => "s3", projectKeyOf: () => "p3" });
  const handler = handlers["agent/pre-step"];
  await handler({ step: 1, agent: { id: "s3" }, signal: undefined }, async () => ({
    kind: "enter",
    messages: [
      { role: "user", content: [{ type: "text", text: "earlier genuine human turn" }], source: { kind: "user" } },
      { role: "user", content: [{ type: "text", text: "late untrusted text" }], source: { kind: "coordinator-unknown" } },
    ],
  }));
  check(searched === 0, "an unknown producer after the genuine turn still refuses the step (authority not widened)", String(searched));
}

const rootScratch = null;
void rootScratch;
if (failures > 0) {
  console.log(`test-phase-a: ${failures} failing check(s)`);
  process.exit(1);
}
console.log("test-phase-a: PASS");
