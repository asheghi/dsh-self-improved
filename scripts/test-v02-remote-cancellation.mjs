#!/usr/bin/env node
/**
 * MIGRATION-REMOTE-CANCELLATION — Phase A focused cancellation suite for the
 * review lane of the typed business Remote. The mounted-UI report's remaining
 * gate D2 ("mid-flight cancellation of a long-running business call") was
 * unit-only because that fixture had no slow endpoint; this suite closes it
 * with a genuine Gateway dispatch over the genuine Loader-booted plugin plus
 * a delayed synthetic provider.
 *
 * Verified against real installed rc.2 runtime facts (read-only):
 *  - @dsh-api-gateway prepareInvocation pushes the carrier signal as the
 *    method's final argument when the SRC descriptor declares
 *    `cancellation.parameter === "signal"` (a trailing parameter literally
 *    named `signal`), and the same signal backs `this.ctx.invocation.signal`;
 *    the HTTP unary carrier is the connection's Fetch `request.signal`,
 *    passed verbatim through `dispatchRpc(endpoint, payload, signal, peer)` —
 *    the exact face a real POST /api/<ns>/<method> executes.
 *  - @dsh-llm stream adapters must honor `GenerateOptions.signal`.
 *
 * Fixtures:
 *   A. business-level forwarding (genuine built lib): a native cancellable
 *      delegate receives the caller's EXACT signal, stops mid-flight, and the
 *      call rejects with the same reason. The no-carrier command lane stays
 *      safe (deps observe an undefined signal; the call resolves).
 *   B. production composition: the genuine plugin booted through the genuine
 *      rc.2 Loader with a delayed synthetic provider, driven by a genuine
 *      TypertRegistry + TypertGatewayService: prepareMutation → dryReview
 *      under an abortable carrier → cancel midstream. Asserts:
 *      gateway/cancelled settlement; aux-transport quiescence (the SAME abort
 *      reason crossed carrier → runner → combine → provider signal, no delta
 *      after the abort, no finish chunk, stream unwound, exactly one provider
 *      request); no post-cancel result commit (episode watermark stays
 *      unreviewed, no new memory); token semantics (the cancelled token was
 *      consumed exactly once, a pre-aborted call burns NO token, fresh
 *      staging still authorizes); unrelated-call survival (a concurrent
 *      snapshot completes during the long call; after the cancel a forget
 *      mutation and a fresh dryReview pass both complete; the shared consent
 *      gate was never tripped by the per-call cancel).
 *
 * Hygiene: isolated owner-marked temp dirs with a real store and guarded
 * cleanup; no sockets bound (in-process genuine Gateway dispatch mirrors the
 * real Fetch-carrier signal pass); the installed profile, the production
 * store, and the GUI (3082 / the parent's own fixture server) are never
 * touched; no external model requests.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const repo = fileURLToPath(new URL("..", import.meta.url));
const RD = process.env.DSH_RUNTIME_RC2 ?? "/home/bahman/github/dsh-v0.2";

const PASS = [];
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

// ── Owner-marked temp run dirs (guarded cleanup) ────────────────────────────
const RUN_OWNER = "dsi-v02-remote-cancellation";
const runDirs = [];
function newRunDir(label) {
  const dir = join(tmpdir(), `${RUN_OWNER}-${label}-${Date.now()}-${process.pid}-${runDirs.length}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${RUN_OWNER}.owner`), JSON.stringify({ label, pid: process.pid, at: new Date().toISOString() }));
  runDirs.push(dir);
  return dir;
}
function cleanupRunDirs() {
  for (const dir of runDirs) {
    try {
      if (!existsSync(join(dir, `${RUN_OWNER}.owner`))) {
        console.warn(`cleanup refused (owner marker absent): ${dir}`);
        continue;
      }
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      console.warn(`cleanup failed for ${dir}: ${String(error)}`);
    }
  }
  runDirs.length = 0;
}
process.on("exit", cleanupRunDirs);

// ── Runtime pinned assertions ───────────────────────────────────────────────
for (const pkg of ["dsh-api-gateway", "dsh-typert-protocol", "dsh-typert-registry", "cordis", "cordis-plugin-loader", "dsh-llm"]) {
  const manifest = JSON.parse(readFileSync(join(RD, "node_modules", "@deepseek-ai", pkg, "package.json"), "utf8"));
  assert.ok(manifest.version, `runtime manifest readable: ${pkg}`);
}
const gatewayVersion = JSON.parse(readFileSync(join(RD, "node_modules/@deepseek-ai/dsh-api-gateway/package.json"), "utf8")).version;
const pluginPeer = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).peerDependencies["@deepseek-ai/dsh-typert-protocol"];
assert.ok(/0\.2\.0-rc\.2/.test(pluginPeer), `plugin targets rc.2 (peer ${pluginPeer})`);
assert.ok(/0\.2\.0-rc/.test(gatewayVersion), `the genuine Gateway under test is the rc.2 runtime (installed ${gatewayVersion})`);
// SRC cancellation selection in the installed gateway (read-only source facts
// the suite leans on): the descriptor declares `cancellation.parameter=
// 'signal'` for a trailing param named `signal`, and dispatch pushes it last.
const gatewaySrc = await (async () => import(`${RD}/node_modules/@deepseek-ai/dsh-api-gateway/lib/index.js`))();

const runtime = (pkg, file = "lib/index.js") => import(`${RD}/node_modules/@deepseek-ai/${pkg}/${file}`);
const lib = (file) => import(join(repo, "lib", file));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CALLER_CANCEL_REASON = new Error("synthetic client cancel: mid-flight");
const CALLER_CANCEL_REASON_PRE = new Error("synthetic client cancel: pre-aborted");

// ── Synthetic delayed provider (dsh-llm stream contract; honors signal) ─────
function makeSyntheticProvider() {
  const provider = {
    requests: [],
    /** Deterministic mid-flight latch: resolves on the FIRST streamed delta of
     *  the next (single) tracked request, so the fixture cancels at a real
     *  mid-stream point regardless of scheduling/jitter. */
    firstDelta: new Promise(() => {}),
    resetFirstDeltaLatch() { provider.firstDelta = new Promise((resolve) => { provider.firstDeltaResolve = resolve; }); },
    firstDeltaResolve: undefined,
    stream(options) {
      const req = {
        id: randomUUID(),
        route: options?.hint?.route ?? "unnamed",
        startedAt: Date.now(),
        signalPresent: options?.signal !== undefined,
        aborted: options?.signal?.aborted === true,
        abortedAt: undefined,
        seenAbortReason: undefined,
        deltas: 0,
        deltaAt: [],
        bytes: 0,
        finished: false,
        finishKind: undefined,
        endedAt: undefined,
      };
      provider.requests.push(req);
      const signal = options?.signal;
      if (signal) {
        signal.addEventListener("abort", () => {
          req.aborted = true;
          req.abortedAt ??= Date.now();
          req.seenAbortReason ??= String(signal.reason);
        }, { once: true });
      }
      const deltaDelayMs = options?.hint?.deltaDelayMs ?? 25;
      const text = options?.hint?.text ?? "";
      assert.equal(typeof text, "string");
      return (async function* () {
        try {
          signal?.throwIfAborted();
          yield { type: "block-start", index: 0, blockType: "text" };
          const tokens = text.match(/\S+\s*/g) ?? [];
          for (const token of tokens) {
            await sleep(deltaDelayMs);
            // dsh-llm adapter contract: implementations MUST honor the signal.
            signal?.throwIfAborted();
            req.deltas += 1;
            req.deltaAt.push(Date.now());
            req.bytes += token.length;
            // Deterministic mid-flight latch: two deltas streamed (one fully
            // emitted, one queued behind a sleep) when the fixture aborts.
            if (req.deltas === 2) provider.firstDeltaResolve?.(req);
            yield { type: "text-delta", index: 0, text: token };
          }
          req.finished = true;
          // An aborted request NEVER reaches a finish chunk — quiescence rule.
          yield { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } };
          yield { type: "finish", reason: { kind: "stop" } };
        } finally {
          req.endedAt = Date.now();
        }
      })();
    },
  };
  return provider;
}

// ── Genuine rc.2 Loader boot (verified pattern from the settings suite) ─────
async function bootPluginWithLoader(opts) {
  const cordis = await runtime("cordis");
  const loaderMod = await runtime("cordis-plugin-loader");
  const root = new cordis.Context();
  root.provide("settings", { configure: () => () => {} });
  root.provide("systemPrompt", { section: () => {} });
  root.provide("sessions", {});
  root.provide("sessionQuery", {});
  root.provide("llm", opts.provider);
  root.provide("tools", { register: () => () => {} });
  const consoleLog = console.log;
  const consoleWarn = console.warn;
  const pluginLogs = [];
  console.log = (...args) => { pluginLogs.push(args.map(String).join(" ")); };
  console.warn = (...args) => { pluginLogs.push("[warn] " + args.map(String).join(" ")); };
  try {
    let captured = null;
    const fiber = root.plugin({ name: "loader-host", apply: (child) => {
      captured = new loaderMod.Loader(child, { baseUrl: new URL("file://" + join(repo, "lib/")).href });
    } });
    await fiber.await();
    const config = {
      // debug ON: the fixture reads the plugin's own log lines as boot
      // evidence (they are emitted from apply(); the boot mutes the console
      // and captures them, so no noise leaks).
      debug: true,
      storageRoot: join(opts.runDir, "store"),
      searchLimit: 5,
      modules: { capture: false, extract: false, consolidate: false, evolve: false, recall: false, tools: false },
      extract: { intervalMinutes: 1, batchMaxChars: 4000, maxOutputTokens: 2000, timeoutMs: 60000, dedup: true, fallbackOnBadJson: false, minImportance: 6, flushDrain: false, model: "synthetic-review-model", provider: "synthetic-loopback-stub", provenanceFilter: "strict", requireEvidence: true },
      recall: { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, maxInjectChars: 800, relevanceMargin: 0.5, minImportance: 0, maxInjectPerTurn: 4, embedding: { baseUrl: "", apiKey: undefined, model: "", dimensions: 1024, timeoutMs: 10000 } },
      consolidate: { scenesEnabled: false, sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 },
      evolve: { decay: { enabled: false, minAgeDays: 7, threshold: 2, retentionDays: 180, maxActiveMemories: 500 }, skillSynthesis: { enabled: false, minImportance: 7, skillsRoot: "", prefix: "dsi-", maxSkills: 100 } },
      housekeeping: { personaVersions: 10, maxScenes: 50, sceneActiveRatio: 0.3, conversationRetentionDays: 90 },
      review: { enabled: false, time: "22:00" },
      episodeLearning: {
        enabled: opts.episodeEnabled,
        captureArguments: true,
        resultExcerptChars: 4000,
        retentionDays: 90,
        reviewEnabled: opts.reviewEnabled,
        confidenceFloor: 0.8,
        expiryDays: 90,
        operationalRecallEnabled: false,
        maxRecallResults: 2,
        maxRecallChars: 600,
        skillMinEpisodes: 2,
      },
    };
    await captured.create({ name: "./index.js", id: "self-improved", config });
    await captured.await();
    return { cordis, root, loader: captured, pluginLogs };
  } catch (error) {
    for (const line of pluginLogs) process.stderr.write(line + "\n");
    throw error;
  } finally {
    console.log = consoleLog;
    console.warn = consoleWarn;
  }
}

function seedSucceededEpisode(store, sessionId, turn = 1) {
  const { id } = store.commitEpisode(
    { sessionId, projectId: "proj-cancel-fixture", turn, status: "succeeded", startedAt: 1, endedAt: 2, firstSeq: 0, lastSeq: 2, fingerprint: "fx", delegated: false },
    [
      { episodeId: "", ordinal: 0, callId: "call-cancel-1", toolName: "bash", argumentsRedacted: "seeded-probe-args", resultExcerpt: "seeded-probe-ok", isError: 0, errorName: null, errorCode: null, callSeq: 0, resultSeq: 1, callAt: 3, resultAt: 4, argsTruncated: 0, resultTruncated: 0 },
      { episodeId: "", ordinal: 1, callId: "call-cancel-2", toolName: "read", argumentsRedacted: "seeded-probe-args-2", resultExcerpt: "seeded-probe-ok-2", isError: 0, errorName: null, errorCode: null, callSeq: 2, resultSeq: 3, callAt: 5, resultAt: 6, argsTruncated: 0, resultTruncated: 0 },
    ],
    [],
  );
  return id;
}

// ─── A. business-level signal forwarding (+ safe no-carrier command lane) ───
check("business: deps.episodeDryReview receives the caller's EXACT signal; a mid-flight cancel stops the aux delegate; the token was burned exactly once", async () => {
  const { createMemoryBusiness } = await lib("business.js");
  const { MemoryStore } = await lib("storage.js");
  const runDir = newRunDir("business-fwd");
  const store = new MemoryStore(join(runDir, "store"));
  store.insertMemory({ kind: "fact", content: "synthetic cancellation row", importance: 6 }, { provenance: "test", source: "test", scope: "global" });

  const aux = { receivedSignal: null, stopped: false, settled: false };
  const business = createMemoryBusiness({
    store,
    enabled: () => true,
    skillsPrefix: () => "dsi-",
    skillsRoot: () => "",
    episodeEnabled: () => true,
    log: () => {},
    // Same contract src/index.ts now wires: a genuine cancellable aux delegate
    // that MUST obey the forwarded call signal.
    episodeDryReview: async (signal) => {
      aux.receivedSignal = signal ?? null;
      if (!signal) {
        aux.settled = true;
        return { considered: 0 };
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          aux.settled = true;
          resolve({ considered: 0, long: true });
        }, 10_000);
        timer.unref?.();
        signal.addEventListener("abort", () => {
          aux.stopped = true;
          clearTimeout(timer);
          reject(signal.reason ?? new Error("aborted"));
        }, { once: true });
      });
    },
  });
  const caller = { peerId: "peer-cancel-A", source: "remote" };
  const stage = business.prepareMutation(caller, { op: "dryReview" });

  const carrier = new AbortController(); // the would-be Fetch request.signal
  const pending = business.dryReview(caller, { token: stage.token }, carrier.signal);
  await sleep(5);
  assert.ok(Object.is(aux.receivedSignal, carrier.signal), "the aux delegate received the caller's EXACT signal object (identity, not a copy)");

  carrier.abort(CALLER_CANCEL_REASON);
  const outcome = await pending.then((v) => ({ resolved: v, rejected: null }), (e) => ({ resolved: null, rejected: e }));
  assert.ok(outcome.rejected, "the cancelled call rejected instead of settling a result");
  assert.equal(String(outcome.rejected.message ?? ""), CALLER_CANCEL_REASON.message, "the per-call cancel reached the delegate with the SAME reason through the chain");
  assert.equal(aux.stopped, true, "the aux delegate stopped mid-flight");
  assert.equal(aux.settled, false, "the cancelled aux work never produced a settle");

  // Token semantics: the one-shot token was consumed even for a cancelled call.
  const verdict = await business.dryReview(caller, { token: stage.token }, new AbortController().signal).then(
    () => "resolved",
    (e) => String(e?.code ?? e?.message ?? e),
  );
  assert.match(verdict, /rejected|authorization/, "a replayed (already-consumed) token is refused: cancellation consumed it exactly once");
  await store.close();
});

check("business: no-carrier command lane stays safe — deps receive an undefined signal and the call resolves without staging", async () => {
  const { createMemoryBusiness } = await lib("business.js");
  const { MemoryStore } = await lib("storage.js");
  const runDir = newRunDir("business-command");
  const store = new MemoryStore(join(runDir, "store"));
  const auxSignals = [];
  const business = createMemoryBusiness({
    store,
    enabled: () => true,
    skillsPrefix: () => "dsi-",
    episodeEnabled: () => true,
    log: () => {},
    episodeDryReview: async (signal) => {
      auxSignals.push(signal);
      return { considered: 0 };
    },
  });
  const commandCaller = { peerId: null, source: "command" };
  const summary = await business.dryReview(commandCaller, { token: "" }, undefined);
  assert.deepEqual(summary, { considered: 0 }, "the command path still resolves normally (shared command/no-carrier path safe)");
  assert.equal(auxSignals.length, 1, "the runner was entered exactly once");
  assert.equal(auxSignals[0], undefined, "the command lane forwarded NO carrier signal (consent/shutdown still bind runner-side)");
  await store.close();
});

// ─── B. GENUINE Gateway mid-flight cancel on the genuine plugin build ───────
check("gateway: genuine Loader+plugin mid-flight carrier cancel aborts the invocation, quiesces the aux provider stream, commits nothing post-cancel, keeps unrelated calls alive", async () => {
  const { TypertRegistry } = await runtime("dsh-typert-registry");
  const gatewayMod = gatewaySrc; // real TypertGatewayService (verified export)
  const { MemoryStore } = await lib("storage.js");

  const runDir = newRunDir("gateway-cancel");
  // ① Seed BEFORE the plugin boots: one succeeded episode + one editable row.
  const seedStore = new MemoryStore(join(runDir, "store"));
  const episodeId = seedSucceededEpisode(seedStore, "sess-cancel-fixture", 1);
  const forgetRow = seedStore.insertMemory(
    { kind: "fact", content: "synthetic unrelated forget row for cancel survival", importance: 5 },
    { provenance: "test", source: "test", scope: "global" },
  );
  await seedStore.close();

  // ② Per-pass routing: each review pass chooses text + pace through the
  //    mutable lane config. The provider is useful only as the casualty.
  const SLOW_TEXT = '{"operational_memories":[{"content":"synthetic slow pass must never commit","confidence":0.9,"evidence_call_ids":["call-0"]}],"skill_candidate":null,"rejection_reason":null}';
  const FAST_TEXT = '{"operational_memories":[],"skill_candidate":null,"rejection_reason":"synthetic fast pass: nothing evidence-backed qualifies"}';
  const lane = {
    current: { route: "slow-review", deltaDelayMs: 25, text: SLOW_TEXT },
  };
  const provider = makeSyntheticProvider();
  const baseStream = provider.stream.bind(provider);
  provider.stream = (options) => baseStream({ ...options, hint: { ...(options?.hint ?? {}), ...lane.current } });

  // ③ Boot the GENUINE plugin through the GENUINE rc.2 Loader.
  const boot = await bootPluginWithLoader({ runDir, provider, episodeEnabled: true, reviewEnabled: true });
  assert.ok(boot.pluginLogs.some((l) => l.includes("memory business remote registered")), "the genuine plugin registered the typed business remote");

  // ④ Genuine TypertRegistry + TypertGatewayService over the same root tree.
  new TypertRegistry(boot.root);
  const gateway = new gatewayMod.TypertGatewayService(boot.root, { websocketHeartbeatIntervalMs: 2000, streamInboxBytes: 262144 });
  const neverAborted = new AbortController().signal;
  const rpc = (endpoint, args, control) => gateway.dispatchRpc(endpoint, { args }, control?.signal ?? neverAborted, undefined);

  // ⑤ prepareMutation over the REAL gateway.
  const prep = await rpc("selfImproved/prepareMutation", { args: { op: "dryReview" } });
  assert.equal(prep.ok, true, `prepareMutation dispatched: ${JSON.stringify(prep.error ?? null)}`);
  assert.equal(prep.value.op, "dryReview");
  assert.equal(typeof prep.value.token, "string");
  assert.ok(prep.value.token.length > 0, "the staged token is a non-empty credential");
  assert.equal(prep.value.ttlMs, 120_000, "the request-binding TTL is reported to the client as before");
  const cancelToken = prep.value.token;

  // ⑥ Dispatch the LONG dryReview with an abortable carrier, and fire an
  //    unrelated concurrent snapshot WHILE the stream runs.
  provider.resetFirstDeltaLatch();
  lane.current = { route: "slow-review", deltaDelayMs: 25, text: SLOW_TEXT };
  const carrier = new AbortController();
  const cancelDispatch = rpc("selfImproved/dryReview", { authorization: { token: cancelToken } }, carrier);
  const concurrentSnapshot = rpc("selfImproved/snapshot", {});
  const snapshotDuringRun = await concurrentSnapshot;
  assert.equal(snapshotDuringRun.ok, true, "an unrelated concurrent call completes WHILE the long aux call runs");
  assert.ok(Array.isArray(snapshotDuringRun.value.memories), "the concurrent snapshot is genuine row data");

  // Deterministic mid-flight cancel: wait for the second streamed delta
  // (one fully emitted, the next still sleeping), then cancel the carrier.
  const latch = await Promise.race([
    provider.firstDelta.then((r) => r),
    sleep(5_000).then(() => "latch-timeout"),
  ]);
  assert.ok(latch !== "latch-timeout", "the fixture latched on the live mid-stream provider request (long call running)");
  carrier.abort(CALLER_CANCEL_REASON);
  const cancelOutcome = await cancelDispatch.then((r) => r, (e) => ({ ok: false, transport_threw: String(e), error: { code: "transport-threw" } }));
  assert.equal(cancelOutcome.ok, false, "the mid-flight cancelled call does not settle ok");
  assert.equal(cancelOutcome.error?.code, "gateway/cancelled", `invocation abort surfaces as gateway/cancelled (got ${cancelOutcome.error?.code}; msg ${cancelOutcome.error?.message})`);

  // ⑦ Aux transport quiescence.
  await sleep(150); // let any post-cancel provider activity (if any) surface
  const reviewRequests = provider.requests.filter((r) => r.route === "slow-review");
  assert.equal(provider.requests.length, 1, "exactly ONE synthetic provider request ran (no retry storm, no stray aux call)");
  const req = provider.requests[0];
  assert.equal(req.signalPresent, true, "the aux transport carried a real GenerateOptions.signal");
  assert.equal(req.aborted, true, "the provider request observed the abort through the real signal chain");
  assert.match(String(req.seenAbortReason ?? ""), /synthetic client cancel: mid-flight/, "the SAME caller-cancel reason crossed carrier → runner → combine → provider signal");
  assert.ok(req.deltas >= 1, "the call was genuinely mid-flight: at least one delta streamed before the cancel");
  // Postcancel quiescence, ms-granularity safe: (a) no delta recorded at a
  // millisecond STRICTLY AFTER the abort (the latch's own delta shares the
  // abort ms by bookkeeping order — it is a pre-abort delta); (b) the delta
  // count is STABLE after the aborted call has settled.
  const lateDeltas = req.deltaAt.filter((at) => req.abortedAt !== undefined && at > req.abortedAt);
  assert.equal(lateDeltas.length, 0, "no text delta streamed after the abort (transport went quiescent)");
  const deltasAtSettle = req.deltas;
  await sleep(150);
  assert.equal(req.deltas, deltasAtSettle, "the delta count is frozen after the aborted call settled: the aux transport is quiescent");
  assert.equal(req.finished, false, "the aborted request never produced a finish chunk");
  assert.ok(req.endedAt !== undefined && req.endedAt >= Date.now() - 60_000, "the stream iterator unwound after the cancel");
  assert.equal(provider.requests.length, 1, "still exactly one provider request after settle: the cancel spawned no replacement stream");

  // ⑧ No post-cancel result commit: dry runs persist nothing, ever.
  const readStore = new MemoryStore(join(runDir, "store"));
  try {
    const episode = readStore.getEpisode(episodeId);
    assert.equal(episode.status, "succeeded", "the episode row state is untouched by the cancelled call");
    assert.equal(episode.reviewedAt, null, "the episode watermark stays unreviewed (no post-cancel commit)");
    assert.equal(readStore.getEpisodeSteps(episodeId).length, 2, "evidence rows untouched");
    assert.equal(readStore.listMemories({ limit: 100 }).filter((m) => m.content.includes("must never commit")).length, 0, "no derived memory for the cancelled slow pass");
  } finally {
    readStore.close();
  }

  // ⑨ Token semantics over the real gateway.
  //  ⑨a the cancelled call's token was consumed exactly once:
  const replay = await rpc("selfImproved/dryReview", { authorization: { token: cancelToken } });
  assert.equal(replay.ok, false, "a replayed token from the cancelled call is refused");
  assert.equal(replay.error?.code, "self-improved/rejected", `replay surfaces the business rejection (got ${replay.error?.code})`);

  //  ⑨b a pre-aborted call burns NO token (mounted-UI ledger A9, gateway level);
  const preStage = await rpc("selfImproved/prepareMutation", { args: { op: "dryReview" } });
  assert.equal(preStage.ok, true);
  const preAbortCarrier = new AbortController();
  preAbortCarrier.abort(CALLER_CANCEL_REASON_PRE);
  const preAborted = await rpc("selfImproved/dryReview", { authorization: { token: preStage.value.token } }, preAbortCarrier);
  assert.equal(preAborted.ok, false, "a pre-aborted carrier is refused at the wire");
  assert.equal(preAborted.error?.code, "gateway/cancelled", `pre-aborted call surfaces gateway/cancelled (got ${preAborted.error?.code})`);
  //  ⑨c therefore the SAME (unused) token still authorizes a live retry:
  lane.current = { route: "fast-retry", deltaDelayMs: 2, text: FAST_TEXT };
  const retry = await rpc("selfImproved/dryReview", { authorization: { token: preStage.value.token } });
  assert.equal(retry.ok, true, `the same token the pre-aborted call refused to burn still authorizes a live call (${JSON.stringify(retry.error ?? null)})`);
  assert.ok(retry.value && typeof retry.value === "object" && "rejected" in retry.value, "the live retry returns a genuine dry-run summary envelope");

  // ⑩ Unrelated calls after the cancel: forget mutation completes, and the
  //    consent gate was never tripped (the fresh pass above ran).
  const forgetPrep = await rpc("selfImproved/prepareMutation", { args: { op: "forget", id: forgetRow.id } });
  assert.equal(forgetPrep.ok, true);
  const forget = await rpc("selfImproved/forget", { id: forgetRow.id, authorization: { token: forgetPrep.value.token } });
  assert.equal(forget.ok, true, `an unrelated authorized mutation completes after the cancel (${JSON.stringify(forget.error ?? null)})`);
  assert.equal(forget.value?.op, "forget");
  const readStore2 = new MemoryStore(join(runDir, "store"));
  try {
    assert.equal(readStore2.getMemory(forgetRow.id)?.status, "forgotten", "the post-cancel forget mutation committed");
    const wouldReview = readStore2.getEpisode(episodeId);
    assert.equal(wouldReview.reviewedAt, null, "even after the later VALID pass the dry-run watermark rule still persisted NOTHING");
  } finally {
    readStore2.close();
  }

  // ⑪ Unmount the plugin through the loader; the owned shutdown drain joins
  //    every accepted job (the cancelled and completed passes) before close.
  await boot.loader.remove("self-improved");
  await boot.loader.await();
});

// ── runner ──────────────────────────────────────────────────────────────────
(function printPlan() {
  console.log(`test-v02-remote-cancellation: ${checks.length} check(s) planned`);
})();

for (const [name, fn] of checks) {
  process.stderr.write(`RUN   ${name}\n`);
  await fn();
  PASS.push(name);
  console.log(`PASS  ${name}`);
}
console.log(`test-v02-remote-cancellation: ${PASS.length}/${PASS.length} PASS`);
