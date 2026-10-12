#!/usr/bin/env node
/**
 * Phase A safety regressions (workflow-4, MIGRATION-COORDINATOR-REVIEW.md).
 * Independent of the Phase A worker's suites: this file only READS the current
 * built artifact in lib/ and never edits plugin source, manifest, other tests,
 * scratch/, or MIGRATION-PROGRESS.md.
 *
 * Three scenario families, all against REAL built-code behavior (no source
 * patterns, no mocks of the code under test):
 *   1. Capture stays fully inert at FLUSH time while the master gate is off
 *      (throwing storage/source proxies + pump counter; episode controller is
 *      ENABLED to prove the master switch dominates consent lanes).
 *   2. Auxiliary model calls reject every terminal finish except a verified
 *      text-only `stop` completion (tool-calls must never complete a review
 *      without an implemented, verified tool round-trip).
 *   3. Only the direct human producer drives recall retrieval: unknown,
 *      coordinator/relay, model/tool/system-prompt, injected, malformed, and
 *      MISSING provenance must never trigger a search or an injection.
 *
 * Synthetic data only: no production store, live profile setting, provider
 * call, dependency patch, or version exemption. The only filesystem write is
 * one uniquely created temporary store directory for the enabled-run positive
 * control, verified by this process's mkdtemp ownership before guarded removal.
 *
 * Run: node scripts/test-v02-safety.mjs
 *
 * Build-freshness caveat: against the lib/ wasm built artifact at the time of
 * this run; after any worker rebuild the suite must be re-run for the results
 * to describe the latest tree.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";

const { evaluateTerminalFinish } = await import("../lib/compat-v02.js");
const { installCapture } = await import("../lib/capture.js");
const { installRecallInjection } = await import("../lib/inject.js");
const { MemoryStore } = await import("../lib/storage.js");

let failures = 0;
let checks = 0;
function check(ok, name, detail) {
  checks++;
  if (ok) {
    console.log(`PASS  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? `  (${String(detail)})` : ""}`);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Group 1 — disabled capture is inert during the session/flush barrier.
 * The probe failures below double as positive controls: they prove the
 * throwing proxies are genuinely in the enabled code path, so every inert
 * assertion in the disabled run reflects the master gate and not a vacuous
 * wire-up.
 * ──────────────────────────────────────────────────────────────────────── */
{
  // Storage proxy: ANY property interaction is recorded then throws.
  const storeTouched = [];
  const throwingStore = new Proxy(
    {},
    {
      get(_t, p) {
        storeTouched.push(`get:${String(p)}`);
        throw new Error("storage probe accessed");
      },
      set(_t, p) {
        storeTouched.push(`set:${String(p)}`);
        throw new Error("storage probe accessed");
      },
      has(_t, p) {
        storeTouched.push(`has:${String(p)}`);
        throw new Error("storage probe accessed");
      },
      deleteProperty(_t, p) {
        storeTouched.push(`del:${String(p)}`);
        throw new Error("storage probe accessed");
      },
    },
  );

  // Source proxy: the session itself is the throwing object, so reads of
  // ownEvents(), events, header, or inheritedEventCount all trip the probe.
  let sourceReads = 0;
  const throwingSession = new Proxy(
    {},
    {
      get(_t, p) {
        sourceReads++;
        throw new Error("source probe accessed");
      },
    },
  );

  let pumpCalls = 0;
  let episodeEnabledChecks = 0;
  const handlers = [];
  installCapture(
    { on: (name, fn) => handlers.push({ name, fn }) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    /** @type {any} */ (throwingStore),
    { enabled: () => false },
    () => {
      pumpCalls++;
      return "queued";
    },
    // Episode consent lane stays ENABLED: only the master switch may stop work.
    {
      enabled: () => {
        episodeEnabledChecks++;
        return true;
      },
      maxChars: () => 800,
    },
  );
  check(
    handlers.length === 1 && handlers[0].name === "session/flush",
    "capture registers exactly one session/flush listener",
    JSON.stringify(handlers.map((h) => h.name)),
  );

  // Flush WITH EVENTS PENDING while disabled: nothing may be read, written, or pumped.
  const rc2Session = {
    id: "s-disabled",
    inheritedEventCount: 2,
    header: { cwd: "/tmp/proj-safety" },
    ownEvents: () => [
      { type: "user/message", seq: 3, time: 11, data: { content: [{ type: "text", text: "pending evidence" }], source: { kind: "user" } } },
      { type: "tool/result", seq: 4, time: 12, data: { turn: 1, step: 0, message: { toolCallId: "c1", content: [{ type: "text", text: "out" }] } } },
      { type: "turn/end", seq: 5, time: 13, data: { turn: 1, reason: { kind: "completed" } } },
    ],
  };
  let disabledFlushRan = false;
  try {
    await handlers[0].fn(rc2Session);
    // Instrument this disabled run with the source proxy, not just the
    // separate enabled positive control.
    await handlers[0].fn(throwingSession);
    disabledFlushRan = true;
  } catch (error) {
    disabledFlushRan = false;
  }
  check(disabledFlushRan, "disabled capture: session/flush resolves without error");
  check(sourceReads === 0, "disabled capture at flush time performs ZERO source reads", `reads=${sourceReads}`);
  check(storeTouched.length === 0, "disabled capture at flush time performs ZERO storage accesses", JSON.stringify(storeTouched));
  check(pumpCalls === 0, "disabled capture at flush time never invokes the capture pump", `pump=${pumpCalls}`);
  check(
    episodeEnabledChecks === 0,
    "episode consent lane is never even consulted while the master switch is off (no lane runs without the master)",
    `episodeGateChecks=${episodeEnabledChecks}`,
  );

  // Positive control A: enabled master + throwing session → the handler tries
  // to read source evidence and trips the session probe.
  let gateProbe = { enabled: true };
  const enabledOnly = installCaptureProbeSubscribers();
  function installCaptureProbeSubscribers() {
    const hs = [];
    installCapture(
      { on: (name, fn) => hs.push({ name, fn }) },
      throwingStore,
      { enabled: () => gateProbe.enabled },
      () => {
        gateProbe.pump++;
        return "queued";
      },
      { enabled: () => true, maxChars: () => 800 },
    );
    return hs;
  }
  gateProbe.pump = 0;
  let sourceTouchedWhenEnabled = "";
  try {
    await enabledOnly[0].fn(throwingSession);
  } catch (error) {
    sourceTouchedWhenEnabled = String(error);
  }
  check(
    sourceTouchedWhenEnabled.includes("source probe accessed"),
    "positive control: with the master ON the flush path reads source evidence (probe is real, not unwired)",
    sourceTouchedWhenEnabled,
  );
  check(gateProbe.pump === 0, "positive control: flush never reaches the pump when source reading fails", `pump=${gateProbe.pump}`);

  // Positive control B: enabled master + readable session + throwing store →
  // the handler reads source fine and THEN trips the storage probe.
  gateProbe = { enabled: true, pump: 0 };
  let storeTouchedWhenEnabled = "";
  try {
    await enabledOnly[0].fn(rc2Session);
  } catch (error) {
    storeTouchedWhenEnabled = String(error);
  }
  check(
    storeTouchedWhenEnabled.includes("storage probe accessed"),
    "positive control: with the master ON and readable evidence the flush path reaches storage (probe is real, not unwired)",
    storeTouchedWhenEnabled,
  );

  // Positive control C: enabled master + REAL synthetic store in a uniquely
  // created temp directory → pending evidence is actually captured (and the
  // disabled controls above would have hidden this fact otherwise).
  const dirRoot = mkdtempSync(join(tmpdir(), "dsi-v02-safety-"));
  assert.match(basename(dirRoot), /^dsi-v02-safety-/, "temp root ownership: mkdtemp prefix");
  const storeDir = join(dirRoot, "store");
  const realStore = new MemoryStore(storeDir);
  const realHandlers = [];
  installCapture(
    { on: (name, fn) => realHandlers.push({ name, fn }) },
    realStore,
    { enabled: () => false },
    undefined,
    { enabled: () => true, maxChars: () => 800 },
  );
  const offSession = {
    id: "s-master-off",
    inheritedEventCount: 0,
    header: { cwd: "/tmp/proj-safety" },
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "off-session evidence" }], source: { kind: "user" } } },
    ],
  };
  await realHandlers[0].fn(offSession);
  const offSlices = getStoreSlices(realStore, "s-master-off");
  check(offSlices.length === 0, "real-store control: a flush with the master OFF leaves ZERO slices", JSON.stringify(offSlices));

  realHandlers.length = 0;
  // Phase B replacement lane (MIGRATION-PHASE-B-CAPTURE.md): the raw JSONL
  // slice write is gone; a REAL journal over the same store is the plugin's
  // owned persistence for direct-human evidence, so the enabled control
  // observes capture exactly-once there.
  const { MemoryJournalV02 } = await import("../lib/memory-journal-v02.js");
  const realJournal = new MemoryJournalV02(realStore);
  installCapture(
    { on: (name, fn) => realHandlers.push({ name, fn }) },
    realStore,
    { enabled: () => true },
    undefined,
    { enabled: () => true, maxChars: () => 800 },
    { append: (input) => realJournal.appendSession(input), closed: () => false },
  );
  const onSession = {
    id: "s-master-on",
    inheritedEventCount: 0,
    header: { cwd: "/tmp/proj-safety" },
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "on-session evidence" }], source: { kind: "user" } } },
    ],
  };
  await realHandlers[0].fn(onSession);
  await realHandlers[0].fn(onSession); // re-flush must be lifecycle-deduped
  const onSources = getStoreJournalSources(realStore, "s-master-on");
  const onSlices = getStoreSlices(realStore, "s-master-on");
  check(
    onSources.length === 1 && onSources[0].seq === 0 && onSources[0].kind === "user"
      && String(onSources[0].text).includes("on-session evidence") && onSlices.length === 0,
    "real-store control: with the master ON the identical evidence is captured exactly once in the journal lane (incl. seq 0); the raw slice copy is gone",
    JSON.stringify({ sources: onSources.map((s) => ({ seq: s.seq, kind: s.kind })), slices: onSlices.length }),
  );
  realStore.close();
  // Guarded cleanup: only the directory this process just created is removed.
  rmSync(dirRoot, { recursive: true, force: true });
}
function getStoreSlices(store, sessionId) {
  return typeof store.readSlices === "function" ? store.readSlices(sessionId, -1, 1e9) : [];
}
function getStoreJournalSources(store, sessionId) {
  try {
    return store.getJournalSqlite()
      .prepare("SELECT seq, kind, text FROM journal_sources WHERE session_id = ? ORDER BY seq")
      .all(sessionId);
  } catch {
    return [];
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Group 2 — auxiliary calls accept ONLY a text-only `stop` finish.
 * ──────────────────────────────────────────────────────────────────────── */
{
  const toolCalls = evaluateTerminalFinish("tool-calls", true);
  check(
    toolCalls.blocked === true && toolCalls.complete === false,
    `tool-calls finish is REJECTED as a completed auxiliary review (got ${JSON.stringify(toolCalls)})`,
    JSON.stringify(toolCalls),
  );
  check(toolCalls.kind === "tool-calls", "tool-calls rejection keeps the finish kind for the error path", JSON.stringify(toolCalls));
  const stop = evaluateTerminalFinish("stop", true);
  check(stop.complete === true && stop.blocked === false && stop.kind === "stop", "stop finish completes a text-only review", JSON.stringify(stop));
  for (const reason of ["max-tokens", "aborted", "error"]) {
    const r = evaluateTerminalFinish(reason, true);
    check(r.complete === false && r.blocked === true, `${reason} finish is refused as incomplete`, JSON.stringify(r));
  }
  const noChunk = evaluateTerminalFinish("stop", false);
  check(noChunk.complete === false && noChunk.blocked === true, "a missing finish chunk is refused even for known reasons", JSON.stringify(noChunk));
  const unknown = evaluateTerminalFinish("provider-novel-reason", true);
  check(unknown.complete === false && unknown.blocked === true, "unknown extensible finish reason is refused conservatively", JSON.stringify(unknown));
}

/* ────────────────────────────────────────────────────────────────────────────
 * Group 3 — only the direct human producer drives recall retrieval.
 * rc.2 fact: UserMessage REQUIRES source (dsh-llm message.d.ts MessageBase);
 * `kind:'user'` is the ONLY direct-human producer. Everything else — unknown
 * plugin kinds, coordinator/relay forms, model/tool/system-prompt kinds,
 * injected-context self-kinds, and absent/malformed provenance — must neither
 * trigger a search nor append an injection.
 * ──────────────────────────────────────────────────────────────────────── */
const untrustedScenarios = [
  ["absent source (provenance entirely missing)", undefined],
  ["unknown merge-extensible producer kind", { kind: "relay" }],
  ["coordinator producer kind", { kind: "coordinator" }],
  ["model source kind fabricated on a user message", { kind: "model" }],
  ["tool source kind fabricated on a user message", { kind: "tool" }],
  ["system-prompt source kind fabricated on a user message", { kind: "system-prompt" }],
  ["own injected context kind", { kind: "dsh-self-improved", form: "snapshot", sections: [] }],
  ["legacy plugin injected kind", { kind: "plugin" }],
  ["agent-instructions injected kind", { kind: "agent-instructions" }],
  ["skill-catalog injected kind", { kind: "skill-catalog" }],
  ["null source (malformed, not merely undefined)", null],
  ["empty object source (no kind at all)", {}],
];
for (const [label, source] of untrustedScenarios) {
  const { searched, decision, inputMessages, threw } = await recallPreStep(label, source);
  check(!threw, `malformed provenance never crashes the pre-step waterfall (${label})`, threw);
  check(searched === 0, `recall search is NOT driven by an untrusted producer: ${label}`, `searches=${searched}`);
  check(
    decision === null || decision.messages?.length === inputMessages,
    `no recall message is appended for an untrusted producer: ${label}`,
    `messages=${decision?.messages?.length}`,
  );
}
{
  // Positive control: the genuine human producer drives exactly one search.
  const { searched, decision, threw } = await recallPreStep("genuine-op", { kind: "user" }, {
    async search() {
      return [{ id: "m1", kind: "fact", content: "confirmed memory content", importance: 7, score: 1 }];
    },
  });
  check(!threw, "genuine user producer does not break the waterfall", threw);
  check(searched === 1, "genuine user producer drives exactly one recall search", `searches=${searched}`);
  const injected = decision?.messages?.find((m) => m?.source?.kind === "dsh-self-improved");
  check(
    !!injected && injected.source.form === "snapshot",
    "genuine user producer gets a recall injection attributed with the declared kind + snapshot form",
    JSON.stringify(injected?.source),
  );
}
{
  // Ordering safety: automatic recall must fire only when the LAST user
  // message of the step is verified direct-human. An earlier genuine user
  // message must not lend authority to a later coordinator/relay turn.
  const handlers = {};
  let searched = 0;
  installRecallInjection(
    { on: (n, fn) => { handlers[n] = fn; } },
    { async search() { searched++; return []; }, searchOperational: () => [] },
    { enabled: () => true, maxHits: 5, sessionIdOf: () => "order-safety", projectKeyOf: () => "p" },
  );
  const decision = {
    kind: "enter",
    messages: [
      { role: "user", content: [{ type: "text", text: "first genuine typed request" }], source: { kind: "user" } },
      { role: "user", content: [{ type: "text", text: "later coordinator relayed turn" }], source: { kind: "coordinator" } },
    ],
  };
  const out = await handlers["agent/pre-step"]({ step: 1, agent: { id: "o" }, signal: undefined }, async () => decision);
  check(
    searched === 0,
    `automatic recall does not fire when the LAST user message of the step is untrusted (searches=${searched})`,
    `searches=${searched}`,
  );
  check(out.messages.length === decision.messages.length, "no injection message is appended for an untrusted last producer");
}

/** Run the built pre-step handler once with one user message of given provenance. */
async function recallPreStep(label, source, searchStub) {
  const handlers = {};
  let searched = 0;
  installRecallInjection(
    { on: (n, fn) => { handlers[n] = fn; } },
    {
      async search() {
        searched++;
        return (searchStub && (await searchStub.search())) || [];
      },
      searchOperational: () => [],
    },
    { enabled: () => true, maxHits: 5, sessionIdOf: () => label, projectKeyOf: () => "safety" },
  );
  const decision = {
    kind: "enter",
    startsRequestSeries: true,
    futureField: { sentinel: true },
    messages: [
      { role: "user", content: [{ type: "text", text: `safety probe ${label}` }], ...(source === undefined ? {} : { source }) },
    ],
  };
  try {
    const out = await handlers["agent/pre-step"](
      { step: 1, agent: { id: label }, signal: undefined },
      async () => decision,
    );
    return { searched, decision: out, inputMessages: decision.messages.length, threw: "" };
  } catch (error) {
    return { searched, decision: null, inputMessages: decision.messages.length, threw: String(error) };
  }
}

/* ── meta sanity used by the report ── */
for (const f of ["compat-v02.js", "inject.js", "capture.js"]) {
  try {
    void statSync(join(import.meta.dirname, "..", "lib", f)).mtime.toISOString();
  } catch {
    check(false, `built artifact present: lib/${f}`);
  }
}

console.log(`test-v02-safety: ${checks - failures}/${checks} checks passed${failures > 0 ? ` — ${failures} FAILING` : " — ALL PASS"}`);
if (failures > 0) {
  console.log("test-v02-safety: failures above are real behavior of the CURRENT built artifact; do not weaken the suite to pass them.");
  process.exit(1);
}
