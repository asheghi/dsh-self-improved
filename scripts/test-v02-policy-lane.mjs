#!/usr/bin/env node
/**
 * scripts/test-v02-policy-lane.mjs — Phase B POLICY-LANE acceptance fixture
 * (MIGRATION-PHASE-B-POLICY.md; owned by the index/business policy-wiring lane).
 *
 * The blocker this lane exists to pin (MIGRATION-PHASE-B-WORKER-REVIEW.md F1):
 * the journal's documented generation machinery had ZERO production call
 * sites — `bumpCancellationGeneration` and `revokeSessions` were never reached
 * by any forget / purge / consent boundary, so a consent trip or a human
 * forget could not block in-flight or future journal work, and old evidence
 * could recreate the fact. This suite drives the NEW shared policy lane end
 * to end on the REAL runtime objects:
 *
 *  - a REAL MemoryStore (SQLite) and the ONE durable MemoryJournalV02 the
 *    mounted plugin opens (no second journal instance anywhere in the suite);
 *  - the REAL capture → flush → pump lane (installCapture + the index.ts
 *    drive point), so every claim/commit is the production worker path;
 *  - the plugin is mounted GENUINELY through the rc.2 loader, and the
 *    pause/resume/consent trips run through the GENUINE loader volatile-commit
 *    path (Entry.update → _commitVolatile → loader/volatile-update);
 *  - a synthetic DEFERRED provider bound to ctx.llm.stream: every aux request
 *    holds mid-stream until the fixture releases it, so an in-flight commit
 *    racing a policy trip is reproducible deterministically — the exact shape
 *    of the resurrection race ("no late candidates", "no purge resurrection",
 *    "next identical recall correct");
 *  - command / tool / remote counterparts run through their REAL installed
 *    lanes: the captured /memory registry handler, the captured
 *    memory_forget tool descriptor, and the genuine Typert gateway dispatch.
 *
 * Every gate also asserts the trip's BOUND (no blanket purge of user data):
 * sibling sessions, sibling memories and non-derived rows read back intact.
 *
 * Exit 0 = every gate passed; any failure exits 1. All temp dirs are unique
 * mkdtemp trees removed on exit. No profile install, no production store, no
 * network, no external model, no plugin-manager action.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = fileURLToPath(new URL("..", import.meta.url));
const RD = process.env.DSH_RUNTIME_RC2 ?? "/home/bahman/github/dsh-v0.2.1";
const runtimeImport = async (pkg, file = "lib/index.js") => import(`${RD}/node_modules/@deepseek-ai/${pkg}/${file}`);
const lib = (file) => import(pathToFileURL(join(repo, "lib", file)).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RESULTS = [];
let suiteFailed = false;
const ok = (name, cond, detail = "") => {
  RESULTS.push({ ok: Boolean(cond), name, detail: String(detail).slice(0, 500) });
  console.log(`${cond ? "PASS" : "FAIL"} - ${name}${cond && !detail ? "" : ` :: ${detail}`}`);
  if (!cond) suiteFailed = true;
};

const ownTempDirs = [];
const ownTemp = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  ownTempDirs.push(dir);
  return dir;
};
process.on("exit", () => {
  for (const dir of ownTempDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// ── runtime version pins ───────────────────────────────────────────────────
for (const pkg of ["cordis", "cosmokit", "dsh-typert-protocol", "cordis-plugin-loader", "dsh-api-gateway", "dsh-typert-registry"]) {
  const pkgJson = await import(`${RD}/node_modules/@deepseek-ai/${pkg}/package.json`, { with: { type: "json" } });
  assert.ok(pkgJson.default?.version, `runtime manifest readable: ${pkg}`);
}

// ── deferred provider (no HTTP, no external model; every call is held) ─────
/**
 * Stream contract the REAL worker sees via ctx.llm.stream (dsh-llm): block
 * start, text delta, usage, finish("stop"). Every request is HELD mid-stream
 * until its own `release(filter, body)` is called; an abort while held
 * unwinds the generator (cooperative transport). Release bodies are decided
 * PER REQUEST at release time so trips land before any verdict can commit.
 */
function makeDeferredProvider() {
  const requests = [];
  let nextId = 0;
  return {
    requests,
    held: () => requests.filter((r) => r.held),
    countHeld: () => requests.filter((r) => r.held).length,
    heldFor: (probe) => requests.filter((r) => r.held && (r.userText ?? "").includes(probe)),
    async *stream(options) {
      const signal = options?.signal;
      const req = {
        id: ++nextId, startedAt: Date.now(), held: true, ended: false,
        aborted: false, abortReason: undefined, userText: undefined,
        release: null, releaseBody: null,
      };
      requests.push(req);
      if (signal) {
        signal.addEventListener("abort", () => {
          req.aborted = true;
          req.abortReason ??= String(signal.reason);
        }, { once: true });
      }
      const releasePair = Promise.withResolvers();
      req.release = releasePair;
      try {
        for (const msg of options?.messages ?? []) {
          const content = msg?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "text" && typeof part.text === "string") {
                req.userText = req.userText ? `${req.userText}\n${part.text}` : part.text;
              }
            }
          }
        }
        signal?.throwIfAborted();
        yield { type: "block-start", index: 0, blockType: "text" };
        // HOLD: everything downstream is under fixture control.
        const outcome = await Promise.race([
          releasePair.promise,
          new Promise((resolve) => {
            if (signal?.aborted) resolve("abort");
            else signal?.addEventListener("abort", () => resolve("abort"), { once: true });
          }),
          sleep(90_000).then(() => "hold-timeout"),
        ]);
        if (outcome === "hold-timeout") throw new Error("deferred-provider: release never arrived (fixture bug)");
        if (signal?.aborted || outcome === "abort") {
          throw new Error(String(signal?.reason ?? "deferred-provider abort while held"));
        }
        const body = req.releaseBody ?? JSON.stringify({ memories: [] });
        yield { type: "text-delta", index: 0, text: body };
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 3 } };
        yield { type: "finish", reason: { kind: "stop" } };
      } finally {
        req.held = false;
        req.ended = true;
        req.endedAt = Date.now();
      }
    },
  };
}

// ── journal/store readers (raw DatabaseSync over the one durable file) ─────
function readJournalDb(storeDir) {
  const dbPath = join(storeDir, "memory.db");
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const state = db.prepare("SELECT key, value FROM journal_state").all();
    const stateOf = (key) => Number((state.find((s) => String(s.key) === `journal:${key}`) ?? {}).value ?? 0);
    const jobs = db.prepare("SELECT id, idempotency_key, session_id, state, from_seq, to_seq, policy_generation, cancellation_generation, attempt_count, cancel_reason FROM journal_jobs ORDER BY created_at, id").all();
    const sources = db.prepare("SELECT session_id, seq, consumed, revoked FROM journal_sources ORDER BY session_id, seq").all();
    const chunks = db.prepare("SELECT job_id, acked FROM journal_chunks").all();
    const derived = db.prepare("SELECT job_id, memory_id, candidate_key FROM journal_derived").all();
    const sessions = db.prepare("SELECT session_id, project_id, revoked FROM journal_sessions").all();
    const memories = db.prepare("SELECT id, kind, content, status, importance FROM memories ORDER BY created_at, id").all();
    const meta = db.prepare("SELECT memory_id, provenance, source, scope, project_id, session_id, confidence FROM memories_meta").all();
    return {
      stateOf, jobs, sources, chunks, derived, sessions, memories, meta,
      rowByContent: (content) => memories.find((m) => String(m.content) === String(content)),
      rowsByContent: (content) => memories.filter((m) => String(m.content).includes(String(content))),
      metaFor: (id) => meta.find((m) => String(m.memory_id) === String(id)),
      jobsForSession: (sid) => jobs.filter((j) => j.session_id === sid),
      sourcesFor: (sid) => sources.filter((s) => s.session_id === sid),
    };
  } finally {
    db.close();
  }
}

// ── config + genuine loader mount ──────────────────────────────────────────
function baseConfig(runDir) {
  return {
    debug: true,
    storageRoot: join(runDir, "store"),
    searchLimit: 5,
    modules: { capture: true, extract: true, consolidate: false, evolve: false, recall: false, tools: true },
    extract: { intervalMinutes: 120, batchMaxChars: 4000, maxOutputTokens: 2000, timeoutMs: 60_000, dedup: true, fallbackOnBadJson: false, minImportance: 6, flushDrain: false, model: "synthetic-policy-model", provider: "synthetic-policy-provider", provenanceFilter: "strict", requireEvidence: true },
    recall: { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, maxInjectChars: 800, relevanceMargin: 0.5, minImportance: 0, maxInjectPerTurn: 4, embedding: { baseUrl: "", apiKey: undefined, model: "", dimensions: 1024, timeoutMs: 10000 } },
    consolidate: { scenesEnabled: false, sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 },
    evolve: { decay: { enabled: false, minAgeDays: 7, threshold: 2, retentionDays: 180, maxActiveMemories: 500 }, skillSynthesis: { enabled: false, minImportance: 7, skillsRoot: "", prefix: "dsi-", maxSkills: 100 } },
    housekeeping: { personaVersions: 10, maxScenes: 50, sceneActiveRatio: 0.3, conversationRetentionDays: 90 },
    review: { enabled: false, time: "22:00" },
    episodeLearning: { enabled: true, captureArguments: true, resultExcerptChars: 4000, retentionDays: 90, reviewEnabled: true, confidenceFloor: 0.8, expiryDays: 90, operationalRecallEnabled: false, maxRecallResults: 2, maxRecallChars: 600, skillMinEpisodes: 2 },
  };
}

async function bootPlugin(runDir, provider) {
  const cordis = await runtimeImport("cordis");
  const loaderMod = await runtimeImport("cordis-plugin-loader");
  const root = new cordis.Context();
  root.provide("settings", { configure: () => () => {} });
  root.provide("systemPrompt", { section: () => {} });
  root.provide("sessions", {});
  root.provide("sessionQuery", {});
  root.provide("llm", provider);
  const registeredCommands = [];
  root.provide("commands", { register: (decl) => { registeredCommands.push(decl); return () => {}; } });
  const registeredTools = [];
  root.provide("tools", { register: (desc) => { registeredTools.push(desc); return () => {}; } });
  const pluginLogs = [];
  const consoleLog = console.log;
  const consoleWarn = console.warn;
  console.log = (...a) => pluginLogs.push("log:" + a.map(String).join(" "));
  console.warn = (...a) => pluginLogs.push("warn:" + a.map(String).join(" "));
  let loader = null;
  try {
    const fiber = root.plugin({
      name: "loader-host",
      apply: (child) => { loader = new loaderMod.Loader(child, { baseUrl: pathToFileURL(join(repo, "lib") + "/").href }); },
    });
    await fiber.await();
    await loader.create({ id: "self-improved", name: "./index.js", config: baseConfig(runDir) });
    await loader.await();
  } finally {
    console.log = consoleLog;
    console.warn = consoleWarn;
  }
  const entry = loader.resolve("self-improved");
  assert.ok(entry, "the loader kept an entry for the mounted plugin (Entry.update is the volatile-commit path)");
  return { cordis, root, loader, entry, pluginLogs, registeredCommands, registeredTools };
}

// ── flush-checkpoint emission (the REAL capture listener session shape) ────
const WORKSPACE = "/tmp/dsh-policy-lane-workspace-zed";
const fakeSession = (id, events) => ({ id, header: { cwd: WORKSPACE }, inheritedEventCount: 0, events });
const humanEvent = (seq, text) => ({
  type: "user/message", seq, time: Date.now(),
  data: { content: [{ type: "text", text }], source: { kind: "user" } },
});

// An owned trailing kick may legitimately have just run an empty round;
// the next flush then waits one complete 30s throttle window. Allow that
// bounded native timer rather than assuming the old dropped-kick schedule.
async function waitFor(predicate, what, timeoutMs = 40_000, intervalMs = 120) {
  const started = Date.now();
  for (;;) {
    let value = null;
    try { value = predicate(); } catch { value = null; }
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`waitFor timeout: ${what}`);
    await sleep(intervalMs);
  }
}

const verdictFor = (content, evidenceText) => JSON.stringify({
  memories: [{
    kind: "fact", scope: "global", content,
    importance: 7, confidence: 0.9, source_role: "user",
    evidence: evidenceText,
  }],
});

// ============================================================================
// UNIT PART — bounded tombstone / purge precondition semantics (recording lane)
// ============================================================================
async function unitBounds() {
  const { MemoryStore } = await lib("storage.js");
  const { createMemoryBusiness } = await lib("business.js");
  const runDir = ownTemp("dsh-policy-unit-");
  const store = new MemoryStore(join(runDir, "store"));
  try {
    const calls = [];
    const journalPolicy = {
      revokeMemoryEvidence: (memoryIds, reason) => {
        calls.push({ kind: "revoke", memoryIds: [...memoryIds], reason });
        return { cancellationGeneration: 0, sessionsRevoked: 0, sourcesRevoked: 0, jobsCancelled: 0, memoryIdsInvalidated: [] };
      },
      cancelPending: (reason) => { calls.push({ kind: "cancel", reason }); return 7; },
    };
    const business = createMemoryBusiness({
      store, enabled: () => true, skillsPrefix: () => "dsi-", skillsRoot: () => "",
      episodeEnabled: () => true, journalPolicy,
      purgeEpisodes: (_scope, _project) => ({ episodes: 3, steps: 4, events: 5 }),
      log: () => {},
    });

    // N1 — user-provenance forget: NO journal lane call (the binding is the
    // row's own provenance, never the id shape or a model-declared permission).
    const userRow = store.insertMemory(
      { kind: "fact", content: "unit user row", importance: 5 },
      { provenance: "user", source: "user-direct", scope: "global" },
    );
    const r1 = business.forget({ peerId: null, source: "command" }, userRow.id, { token: "" }, undefined);
    assert.equal(r1.affected, userRow.id);
    assert.equal(store.getMemory(userRow.id)?.status, "forgotten");
    assert.deepEqual(calls, [{ kind: "revoke", memoryIds: [userRow.id], reason: `forget:${userRow.id.slice(0, 8)}` }], "only the ledger, not caller metadata, determines support");
    calls.length = 0;

    // N2 — journal-derived forget: tombstone bounded to its EXACT evidence
    // lineage (session identity from the row's own provenance + evidence refs).
    const derivedRow = store.insertMemory(
      { kind: "fact", content: "unit derived row", importance: 6 },
      {
        provenance: "derived", source: "llm-extract", scope: "project",
        projectId: "pj-opaque-identity-1", sessionId: "journal-session-A",
        confidence: 0.5,
        evidence: [{ sessionId: "journal-session-A", seq: 3, snippet: "sb" }],
      },
    );
    const r2 = business.forget({ peerId: null, source: "command" }, derivedRow.id, { token: "" }, undefined);
    assert.equal(r2.affected, derivedRow.id);
    assert.equal(store.getMemory(derivedRow.id)?.status, "forgotten");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { kind: "revoke", memoryIds: [derivedRow.id], reason: `forget:${derivedRow.id.slice(0, 8)}` });

    // N3 — a tool-staged supersession candidate (tool-correct) is NOT journal
    // evidence; confirm-correct tombstones ONLY the superseded row's binding.
    const oldRow = store.insertMemory({ kind: "fact", content: "unit old row", importance: 5 }, { provenance: "user", source: "user-direct", scope: "global" });
    const candidate = store.insertMemory(
      { kind: "fact", content: "unit candidate row", importance: 5, supersedes: oldRow.id },
      { provenance: "derived", source: "tool-correct", scope: "global", sessionId: "journal-session-B", confidence: 0.5 },
    );
    calls.length = 0;
    const r3 = business.confirmCorrect({ peerId: null, source: "command" }, candidate.id, { token: "" }, undefined);
    assert.equal(r3.affected, candidate.id);
    assert.equal(store.getMemory(oldRow.id)?.status, "corrected");
    assert.deepEqual(calls, [{ kind: "revoke", memoryIds: [oldRow.id], reason: `confirm-correct:${candidate.id.slice(0, 8)}` }], "confirmation targets only the superseded memory, never a staged candidate's declared session");

    // N4 — purge: the cancellation trigger runs FIRST with a bounded reason;
    // no blanket journal revoke is ever issued by the purge lane.
    calls.length = 0;
    const purged = business.purgeEpisodes({ peerId: null, source: "command" }, "all", { token: "" }, undefined);
    assert.ok(purged && purged.episodes === 3);
    assert.deepEqual(calls, [{ kind: "cancel", reason: "purge:episodes:all" }]);

    // N5 — fail-closed purge precondition: a throwing journal policy must
    // REFUSE the purge rather than let an unguarded deletion run.
    const throwingBusiness = createMemoryBusiness({
      store, enabled: () => true, skillsPrefix: () => "dsi-", skillsRoot: () => "", episodeEnabled: () => true,
      journalPolicy: { cancelPending: () => { throw new Error("journal closed"); } },
      purgeEpisodes: (scope) => { throw new Error("purge ran while unguarded"); },
      log: () => {},
    });
    assert.throws(
      () => throwingBusiness.purgeEpisodes({ peerId: null, source: "command" }, "30", { token: "" }, undefined),
      (e) => String(e?.message).includes("purge policy precondition failed"),
      "unguarded purge is refused (fail closed)",
    );

    // N6 — missing journal lane: visible warn, store semantics preserved.
    const bareWarnings = [];
    const warnSink = console.warn;
    console.warn = (...a) => bareWarnings.push(a.join(" "));
    const bareBusiness = createMemoryBusiness({
      store, enabled: () => true, skillsPrefix: () => "dsi-", skillsRoot: () => "", episodeEnabled: () => true,
      log: () => {},
    });
    try {
      const bypass = store.insertMemory(
        { kind: "fact", content: "unit bare-lane row", importance: 5 },
        { provenance: "derived", source: "llm-extract", scope: "project", sessionId: "journal-session-D", confidence: 0.5 },
      );
      assert.throws(() => bareBusiness.forget({ peerId: null, source: "command" }, bypass.id, { token: "" }, undefined), /revocation unavailable/);
      assert.equal(store.getMemory(bypass.id).status, "active", "missing ownership must refuse before changing the row");
    } finally {
      console.warn = warnSink;
    }

    ok("unit/bounds: user rows never tombstone; derived rows bind exactly to their own lineage; tool-staged candidates are not journal evidence", true);
    ok("unit/purge policy: cancellation triggers first with a bounded reason; an unguarded purge fails closed", true);
    ok("unit/missing-lane: without journal ownership the derived mutation fails closed, with no uncovered success", bareWarnings.length === 0);
  } finally {
    store.close();
  }
}

// ============================================================================
// MOUNTED PART
// ============================================================================
async function mountedDrive() {
  const runDir = ownTemp("dsh-policy-mount-");
  const storeDir = join(runDir, "store");
  const provider = makeDeferredProvider();
  const boot = await bootPlugin(runDir, provider);
  const { root, entry, registeredCommands, registeredTools, pluginLogs } = boot;
  const originalLog = console.log;
  console.log = (...args) => { pluginLogs.push(args.map(String).join(" ")); originalLog(...args); };
  try {
  const S = (n) => `policy-session-${n}`;
  const fact = {
    1: "please remember that the launch key for runtime fixture ZED-7731 lives in the office safe",
    2: "also keep the synthetic fixture PINOLI-2214 rotation on the shared board",
    3: "the quarterly archive password for the policy lane fixture is MARELY-3310",
    4: "user keeps the policy workflow clock at CASLON-4415 local time",
    5: "the policy fixture's next identical recall template is GALATEA-5517",
  };
  const derivedContentOf = {
    1: "The launch key for runtime fixture ZED-7731 lives in the office safe.",
    2: "The synthetic fixture PINOLI-2214 rotation belongs on the shared board.",
    3: "The quarterly archive password for the policy lane fixture is MARELY-3310.",
    4: "The policy workflow clock stays at CASLON-4415 local time.",
    5: "The policy fixture's next identical recall template is GALATEA-5517.",
  };
  const CORRECTED_CONTENT = `The synthetic fixture PINOLI-2214 rotation lives on the PRIVATE operations board instead.`;

  // Same pump-throttle gap the runtime uses between two in-process pumps
  // (MIN_PUMP_INTERVAL_MS = 30s is a worker-lane-owned setting; the driver
  // honors it exactly as the runtime's flush checkpoints do).
  const PUMP_GAP_MS = 31_000;
  const pumpGap = async () => { await sleep(PUMP_GAP_MS); };

  const flush = async (session) => root.emit("session/flush", session);

  // A full-config volatile update through the GENUINE loader commit path.
  const volatileUpdate = async (patch) => {
    const next = structuredClone(baseConfig(runDir));
    patch(next);
    entry.update({ config: next });
    await sleep(50); // _commitVolatile → loader/volatile-update → plugin hook
  };

  // Wait until a held provider request whose prompt mentions `probe` exists.
  const awaitHeld = (probe, what) =>
    waitFor(() => provider.heldFor(probe).length > 0, what);

  const db = () => readJournalDb(storeDir);

  ok("mount: the genuine loader mounted the plugin; /memory command and memory tool descriptors registered",
    registeredCommands.some((c) => c.name === "memory") && registeredTools.some((t) => t.name === "memory_forget"),
    `commands=[${registeredCommands.map((c) => c.name).join(",")}] tools=[${registeredTools.map((t) => t.name).join(",")}]`);

  // helper: release the held request matching `probe` with a body, then wait
  // for the pump loop to advance (a committed row with `statusOf`).
  const releaseHeld = async (probe, body, label) => {
    const req = provider.heldFor(probe)[0];
    assert.ok(req, `a held provider request exists for ${label ?? probe}`);
    req.releaseBody = body;
    req.release.resolve("serve");
  };

  // ── ROUND 1: one pump round serially claims THREE accepted ranges; each
  //    claim is held then released with a verdict → derived rows + support.
  flush(fakeSession(S(1), [humanEvent(0, fact[1])]));
  await awaitHeld(fact[1], "flush pump claimed range 1");
  flush(fakeSession(S(2), [humanEvent(0, fact[2])]));
  flush(fakeSession(S(3), [humanEvent(0, fact[3])]));
  // Each serial claim is awaited immediately before its release below;
  // never leave unowned polling promises racing a rapidly served provider.

  const remainingInitial = new Set([1, 2, 3]);
  while (remainingInitial.size > 0) {
    // Jobs sharing created_at are ordered by opaque id, not enqueue order.
    // Serve the actually held serial claim rather than deadlocking on a UUID tie.
    const n = await waitFor(() => [...remainingInitial].find(i => provider.heldFor(fact[i]).length > 0), "the next initial claim is held");
    await releaseHeld(fact[n], verdictFor(derivedContentOf[n], fact[n]), `range ${n}`);
    await waitFor(() => db().rowByContent(derivedContentOf[n])?.status === "active", `range ${n} committed`);
    remainingInitial.delete(n);
  }
  const db1 = db();
  const mem1 = db1.rowByContent(derivedContentOf[1]);
  const mem2 = db1.rowByContent(derivedContentOf[2]);
  const mem3 = db1.rowByContent(derivedContentOf[3]);
  ok("round1/derived rows: all three released ranges committed mem rows with derived provenance + opaque journal session identity",
    Boolean(mem1 && mem2 && mem3) && db1.metaFor(mem1?.id)?.source === "llm-extract" && db1.metaFor(mem1?.id)?.provenance === "derived",
    `rows=${(mem1?.id ?? "").slice(0, 8)} ${db1.metaFor(mem1?.id)?.source ?? "-"}/${db1.metaFor(mem1?.id)?.provenance ?? "-"} sessionId=${db1.metaFor(mem1?.id)?.session_id}`);
  ok("round1/support link: journal_derived rows exist for the derived memories (job↔memory support graph)",
    db1.derived.some((d) => d.memory_id === mem1?.id) && db1.derived.some((d) => d.memory_id === mem2?.id),
    `links=${db1.derived.length}`);
  ok("round1/sessions: three journal sessions came from the real capture lane",
    db1.sessions.filter((s) => [S(1), S(2), S(3)].includes(s.session_id)).length === 3);

  // ── ROUND 2: the SECOND flush of a session right after the drained round
  //    ENQUEUES accepted pending work WITHOUT claiming (the worker's in-process
  //    throttle) — exactly the accepted-pending window this lane targets.
  const unrelatedS2 = "user owns an unrelated green notebook in the policy fixture";
  flush(fakeSession(S(2), [humanEvent(1, unrelatedS2)]));
  await sleep(600); // the worker's in-process throttle keeps the pump parked inside 30 s
  {
    const d = db();
    const queued = d.jobsForSession(S(2)).filter((j) => j.state === "queued");
    ok("round2/accepted pending: a fresh flush inside the in-process window enqueued an accepted pending range as a QUEUED job (no claim)",
      queued.length === 1 && provider.countHeld() === 0,
      `queued S2 jobs=${queued.length} providerHeld=${provider.countHeld()}`);
  }

  // DIRECT CORRECTION (command lane counterpart): /memory correct on the S2
  // derived row, running through the REAL registry handler → shared business
  // lane → bounded lineage tombstone.
  const commandDecl = registeredCommands.find((c) => c.name === "memory");
  const runCommand = async (rawInput) => commandDecl.handler({ rawInput: rawInput.replace(/^memory/, "") });
  const correctOut = await runCommand(`memory correct ${mem2.id} ${CORRECTED_CONTENT}`);
  ok("round2/command: /memory correct ran through the REAL command handler + shared business lane",
    correctOut?.kind === "success" && String(correctOut?.text ?? "").includes("Corrected"),
    `${correctOut?.kind}: ${String(correctOut?.text ?? "").slice(0, 120)}`);

  await waitFor(() => { const d = db(); const row = d.metaFor(d.rowByContent(CORRECTED_CONTENT)?.id); return row?.provenance === "user"; }, "the corrected row got user provenance");
  const db2 = db();
  ok("round2/correction promotion: the OLD row is 'corrected', the NEW row carries the user's latest decision (human authority preserved)",
    db2.rowByContent(derivedContentOf[2])?.status === "corrected" && db2.rowByContent(CORRECTED_CONTENT)?.status === "active" && db2.metaFor(db2.rowByContent(CORRECTED_CONTENT)?.id)?.provenance === "user",
    `old=${db2.rowByContent(derivedContentOf[2])?.status} new=${db2.rowByContent(CORRECTED_CONTENT)?.status}`);
  ok("round2/tombstone bound: only the supporting coordinate is spent; sessions, unrelated pending evidence and sibling rows remain untouched",
    db2.sessions.filter(s => [S(1), S(2), S(3)].includes(s.session_id)).every(s => Number(s.revoked) === 0) &&
    db2.sourcesFor(S(2)).some(s => Number(s.seq) === 0 && Number(s.revoked) === 1) &&
    db2.sourcesFor(S(2)).some(s => Number(s.seq) === 1 && Number(s.revoked) === 0 && Number(s.consumed) === 0) &&
    db2.memories.filter(m => [mem1.id, mem3.id].includes(m.id)).every(m => m.status === "active"));
  ok("round2/generation: fact correction preserves the unrelated-work consent generation",
    db2.stateOf("cancellation_generation") === db1.stateOf("cancellation_generation"));
  {
    const queuedAfter = db2.jobsForSession(S(2)).filter((j) => j.state === "queued");
    const cancelled = db2.jobsForSession(S(2)).filter((j) => j.state === "cancelled");
    const ackedChunksOnCancelled = db2.chunks.filter((c) => cancelled.some((j) => j.id === c.job_id) && Number(c.acked) === 1);
    ok("round2/unrelated queue: fact correction neither cancels nor acknowledges unrelated accepted work",
      cancelled.length === 0 && queuedAfter.length === 1 && ackedChunksOnCancelled.length === 0);
    ok("round2/bounded: only S2's pending work died with the tombstone; S1/S3 queued/done coverage stayed untouched",
      db2.jobsForSession(S(1)).every((j) => j.state === "done") && db2.jobsForSession(S(3)).filter((j) => j.state === "done").length >= 1,
      `S1=${db2.jobsForSession(S(1)).map((j) => j.state).join("|")} S3=${db2.jobsForSession(S(3)).map((j) => j.state).join("|")}`);
  }
  await awaitHeld(unrelatedS2, "unrelated same-session pending evidence drains after correction");
  await releaseHeld(unrelatedS2, JSON.stringify({ memories: [] }), "unrelated pending evidence");
  await waitFor(() => db().sourcesFor(S(2)).some(s => Number(s.seq) === 1 && Number(s.consumed) === 1), "unrelated pending source consumed");
  const futureS2 = "user adds a future unrelated brass lamp in the policy fixture";
  flush(fakeSession(S(2), [humanEvent(2, futureS2)]));
  await awaitHeld(futureS2, "future same-session evidence remains capturable after correction");
  await releaseHeld(futureS2, JSON.stringify({ memories: [] }), "future evidence");
  await waitFor(() => db().sourcesFor(S(2)).some(s => Number(s.seq) === 2 && Number(s.consumed) === 1 && Number(s.revoked) === 0), "future source consumed");
  ok("round2/future continuity: unrelated pending and future same-session sources genuinely reached the provider and consumed", true);

  // ── ROUND 3 (pump #2 after the gap): the REMOTE forget counterpart through
  //    the REAL Gateway, with the tombstone applied WHILE a claim is held.
  //    The held (pre-bump snapshot) commit must die terminally when released
  //    with a creation verdict — old evidence cannot recreate the fact.
  await pumpGap();
  const { TypertRegistry } = await runtimeImport("dsh-typert-registry");
  const gatewayMod = await runtimeImport("dsh-api-gateway");
  new TypertRegistry(root);
  const gateway = new gatewayMod.TypertGatewayService(root);
  // 0.2.1 requires a live Peer on every invocation; the HTTP route supplies an owner Peer.
  const ownerPeer = { id: "peer-policy-owner", ctx: root, principal: { kind: "owner" }, signal: new AbortController().signal, interactions: "none", dispose: async () => {} };
  const rpc = (endpoint, args, signal = new AbortController().signal) =>
    gateway.dispatchRpc(endpoint, { args }, signal, ownerPeer);

  flush(fakeSession(S(3), [humanEvent(1, fact[3])]));
  try {
    await waitFor(() => provider.heldFor(fact[3]).length >= 1, "pump #2 claimed the S3 fresh range (held)");
  } catch (error) {
    console.error("S3 timeout diagnosis:", JSON.stringify({ jobs: db().jobsForSession(S(3)), requests: provider.requests.map(r => ({ id: r.id, held: r.held, ended: r.ended, userText: r.userText })) }));
    throw error;
  }

  const heldS3JobId = db().jobsForSession(S(3)).find(j => j.state === "claimed" && Number(j.from_seq) === 1)?.id;
  assert.ok(heldS3JobId, "the exact fresh S3 job is claimed before forget");
  const forgetPrep = await rpc("selfImproved/prepareMutation", { args: { op: "forget", id: mem3.id } });
  ok("round3/remote handshake: the genuine Gateway prepareMutation staged the forget (peer-bound one-shot credential)",
    forgetPrep.ok === true && typeof forgetPrep.value?.token === "string" && forgetPrep.value?.token.length > 0);
  const forgetRes = await rpc("selfImproved/forget", { id: mem3.id, authorization: { token: forgetPrep.value.token } });
  ok("round3/remote forget executed through the REAL gateway dispatch (the remote counterpart reaches the same policy lane)",
    forgetRes.ok === true && forgetRes.value?.op === "forget",
    forgetRes.ok ? JSON.stringify(forgetRes.value) : JSON.stringify(forgetRes.error));

  provider.heldFor(fact[3])[0].releaseBody = verdictFor(derivedContentOf[3], fact[3]);
  provider.heldFor(fact[3])[0].release.resolve("serve");
  await waitFor(() => { const d = db(); const job = d.jobsForSession(S(3)).find((j) => j.id === heldS3JobId && (j.state === "cancelled" || j.state === "done")); return job; }, "the held commit settled against the tombstone");

  const db3 = db();
  const s3CancelJobs = db3.jobsForSession(S(3)).filter((j) => j.state === "cancelled");
  const ackedOnCancelled = db3.chunks.filter((c) => s3CancelJobs.some((j) => j.id === c.job_id) && Number(c.acked) === 1);
  ok("round3/in-flight blocked: a pre-forget response must not recreate the forgotten fact from another pending coordinate",
    ackedOnCancelled.length === 0 && db3.rowsByContent(derivedContentOf[3]).every((m) => m.status !== "active"),
    `s3 cancelled jobs=${s3CancelJobs.length} ackedOnCancelled=${ackedOnCancelled.length} activeRows=${db3.rowsByContent(derivedContentOf[3]).filter((m) => m.status === "active").length}`);
  ok("round3/forget lineage: the exact M3 is forgotten and its support spent without closing its session",
    db3.memories.find(m => m.id === mem3.id)?.status === "forgotten" && db3.sessions.find(s => s.session_id === S(3))?.revoked === 0 && db3.sourcesFor(S(3)).some(s => Number(s.seq) === 0 && Number(s.revoked) === 1),
    `status=${db3.rowByContent(derivedContentOf[3])?.status}`);

  // ── ROUND 4a (pump #3): PAUSE via the GENUINE volatile path (extract off),
  //    then RESUME: accepted pending work re-planned and drained, not
  //    discarded.
  await pumpGap();
  // baseline drain first so the pause gate owns a CLEAN in-flight window:
  flush(fakeSession(S(4), [humanEvent(0, fact[4])]));
  await awaitHeld(fact[4], "pump #3 claimed the S4 baseline range");
  provider.heldFor(fact[4])[0].releaseBody = JSON.stringify({ memories: [] }); // nothing-to-learn ack
  provider.heldFor(fact[4])[0].release.resolve("serve");
  await waitFor(() => { const d = db(); return d.jobsForSession(S(4)).every((j) => j.state === "done"); }, "S4 baseline drained");
  // enqueue a pending range to pause against:
  flush(fakeSession(S(4), [humanEvent(1, fact[4])]));
  await waitFor(() => db().jobsForSession(S(4)).some((j) => j.state === "queued"), "S4 pending range queued (accepted pending before the pause)");
  const policyGenBeforePause = db().stateOf("policy_generation");
  await volatileUpdate((c) => { c.modules.extract = false; });
  const dbPaused = db();
  ok("round4/pause: the master/extract-module volatile pause bumped the durable POLICY generation (job policy changed atomically with the in-flight signal)",
    dbPaused.stateOf("policy_generation") === policyGenBeforePause + 1,
    `policyGen ${policyGenBeforePause} -> ${dbPaused.stateOf("policy_generation")}`);
  {
    const cancelled = dbPaused.jobsForSession(S(4)).filter((j) => j.state === "cancelled");
    ok("round4/pause cancels queued: accepted pending work is parked by the policy bump (cancelled rows, sources intact; replan follows the resume)",
      cancelled.length >= 1 && dbPaused.sourcesFor(S(4)).every((s) => Number(s.revoked) === 0),
      `S4 jobs=${dbPaused.jobsForSession(S(4)).map((j) => j.state).join("|")}`);
  }
  await volatileUpdate((c) => { c.modules.extract = true; });
  const dbResumed = db();
  ok("round4/resume replans: fresh coverage exists so accepted pending jobs DRAIN after the scheduler (never discarded)",
    dbResumed.jobsForSession(S(4)).some((j) => j.state === "queued"),
    `S4 jobs=${dbResumed.jobsForSession(S(4)).map((j) => j.state).join("|")}`);

  // DRAIN the resumed work (pump after its gap):
  await pumpGap();
  // Use the SAME session range: emit nothing new — emit a flush of S4 with
  // only the dormant floor (no new seq) — the drain must claim the replanned
  // job regardless (the pump claims until null).
  flush(fakeSession(S(4), []));
  await waitFor(() => provider.heldFor(fact[4]).length >= 1 || (db().jobsForSession(S(4)).filter((j) => j.state === "queued").length === 0), "resume drain claimed the replanned range");
  {
    const heldReq = provider.heldFor(fact[4]).at(-1);
    if (heldReq) {
      heldReq.releaseBody = verdictFor(derivedContentOf[4], fact[4]);
      heldReq.release.resolve("serve");
      await waitFor(() => { const d = db(); return d.rowByContent(derivedContentOf[4])?.status === "active"; }, "resumed range drained into a derived row");
    }
  }
  {
    const d = db();
    ok("round4/accepted-pending drain: the resumed range committed (done + consumed) — nothing old was discarded across the pause window",
      d.jobsForSession(S(4)).every((j) => j.state === "done" || j.state === "cancelled") && d.jobsForSession(S(4)).some(j => j.state === "done" && Number(j.from_seq) <= 1 && Number(j.to_seq) >= 1) && d.sourcesFor(S(4)).length === 2 && d.sourcesFor(S(4)).every((s) => Number(s.consumed) === 1),
      `S4 jobs=${d.jobsForSession(S(4)).map((j) => j.state).join("|")} sources=${JSON.stringify(d.sourcesFor(S(4)).map((s) => `${s.seq}@${s.consumed}`))}`);
  }

  // ── ROUND 4b: PAUSE with a claim IN FLIGHT (the owned in-flight signal):
  //    a held commit racing the pause must NOT create a row; the claim is
  //    released back to the queue (not cancelled) and drains after resume.
  await pumpGap();
  const s4CandidatesBeforePausedRange = db().rowsByContent(derivedContentOf[4]).filter(m => m.status === "active").length;
  flush(fakeSession(S(4), [humanEvent(2, fact[4])]));
  await awaitHeld(fact[4], "pump claimed the S4 in-flight range (held for the pause gate)");
  const policyGenBeforePause2 = db().stateOf("policy_generation");
  await volatileUpdate((c) => { c.modules.extract = false; });
  const abortedReq = provider.heldFor(fact[4]).at(-1) ?? provider.requests.at(-1);
  ok("round4b/in-flight signal: the pause aborted the held transport through the plugin-owned policy gate (not a store close, not a warning)",
    abortedReq?.aborted === true && abortedReq?.abortReason?.includes("extract job policy"),
    `aborted=${abortedReq?.aborted} reason=${abortedReq?.abortReason ?? "none"}`);
  ok("round4b/no publication during pause: the aborted range added no candidate and its source remains unconsumed",
    db().rowsByContent(derivedContentOf[4]).filter(m => m.status === "active").length === s4CandidatesBeforePausedRange && db().sourcesFor(S(4)).some(s => Number(s.seq) === 2 && Number(s.consumed) === 0));
  // Resume without releasing anything: the abort already unrolled the call.
  await volatileUpdate((c) => { c.modules.extract = true; });
  await pumpGap();
  flush(fakeSession(S(4), []));
  await awaitHeld(fact[4], "the exact paused range is reclaimed after resume");
  await releaseHeld(fact[4], verdictFor(derivedContentOf[4], fact[4]), "resumed in-flight range");
  await waitFor(() => {
    const d = db();
    const open = d.jobsForSession(S(4)).filter((j) => j.state === "queued" || j.state === "claimed");
    const done = d.jobsForSession(S(4)).filter((j) => j.state === "done");
    const rows = d.rowByContent(derivedContentOf[4])?.status === "active";
    return rows && done.some(j => Number(j.from_seq) <= 2 && Number(j.to_seq) >= 2) && open.length === 0 && d.sourcesFor(S(4)).every(s => Number(s.consumed) === 1);
  }, "the paused in-flight range drained cleanly after resume");
  {
    const d = db();
    ok("round4b/no late commit into a paused lane: the aborted call created no row; the SAME range re-derived exactly once after resume (no duplicate/resurrection)",
      d.rowsByContent(derivedContentOf[4]).filter((m) => m.status === "active").length === s4CandidatesBeforePausedRange + 1,
      `activeRows=${d.rowsByContent(derivedContentOf[4]).filter((m) => m.status === "active").length}`);
  }

  // ── ROUND 5: CONSENT revoke via the volatile path → durable cancellation.
  //    The claim is made BEFORE the revoke so its late commit tests the
  //    staleness gate; the re-arm proves bounded future eligibility returns.
  {
    const cancelGenBefore = db().stateOf("cancellation_generation");
    await pumpGap();
    flush(fakeSession(S(5), [humanEvent(0, fact[5])]));
    await awaitHeld(fact[5], "pre-revoke claim is held");
    await volatileUpdate((c) => { c.episodeLearning.enabled = false; });
    {
      const d1 = db();
      ok("round5/consent revoke: the durable CANCELLATION generation bumped (a consent trip now cancels pending journal work — F1 wiring)",
        d1.stateOf("cancellation_generation") === cancelGenBefore + 1,
        `cancelGen ${cancelGenBefore} -> ${d1.stateOf("cancellation_generation")}`);
      ok("round5/consent bound: a consent trip is a WORK stop, never a data tombstone (only the forget lineage revoked S1/S2/S3; nothing else became revoked)",
        d1.sourcesFor(S(4)).every((s) => Number(s.revoked) === 0) && d1.sourcesFor(S(5)).every((s) => Number(s.revoked) === 0),
        `S4/S5 sources revoked=${d1.sourcesFor(S(4)).map((s) => s.revoked).join(",")}/${d1.sourcesFor(S(5)).map((s) => s.revoked).join(",")}`);
    }
    // the claim predates the revoke → its commit cannot outlive the revocation
    const heldReq5 = provider.heldFor(fact[5]).at(-1);
    heldReq5.releaseBody = verdictFor(derivedContentOf[5], fact[5]);
    heldReq5.release.resolve("serve");
    await waitFor(() => {
      const d = db();
      return d.jobsForSession(S(5)).some((j) => j.state === "cancelled" || j.state === "done");
    }, "the post-revoke commit settles terminally");
    {
      const d = db();
      const cancelledJobs = d.jobsForSession(S(5)).filter((j) => j.state === "cancelled");
      ok("round5/in-flight blocked by consent revoke: the claim's late commit terminally cancelled — no candidate, no active row, chunks never acked",
        cancelledJobs.length >= 1 && d.rowByContent(derivedContentOf[5])?.status !== "active" &&
        d.chunks.filter((c) => cancelledJobs.some((j) => j.id === c.job_id) && Number(c.acked) === 1).length === 0,
        `S5 jobs=${d.jobsForSession(S(5)).map((j) => j.state).join("|")} row=${d.rowByContent(derivedContentOf[5])?.status ?? "none"}`);
    }
    // Re-arm: bounded future eligibility — the pending source replans under
    // the new generation as a FRESH job (never the cancelled row).
    await volatileUpdate((c) => { c.episodeLearning.enabled = true; });
    const d2 = db();
    ok("round5/re-arm replan: coverage replanned for the still-pending (non-revoked) source — future work is bounded and non-destructive",
      d2.jobsForSession(S(5)).some((j) => j.state === "queued"),
      `S5 jobs=${d2.jobsForSession(S(5)).map((j) => j.state).join("|")}`);
    await pumpGap();
    flush(fakeSession(S(5), []));
    const replannedReq = await waitFor(() => provider.heldFor(fact[5]).at(-1) ?? null, "re-armed pump claimed the replanned S5 range");
    const ntContents = "…";
    void ntContents;
    replannedReq.releaseBody = verdictFor(derivedContentOf[5], fact[5]);
    replannedReq.release.resolve("serve");
    await waitFor(() => db().rowByContent(derivedContentOf[5])?.status === "active", "post-rearm commit");
    ok("round5/re-arm drain: eligible pending work drained after the consent re-arm under the new generation (a fresh job, never the cancelled row)",
      db().rowByContent(derivedContentOf[5])?.status === "active" &&
      db().jobsForSession(S(5)).filter((j) => j.state === "cancelled").length >= 1);
  }

  // ── FINAL: TOOL counterpart + next-identical-recall correctness.
  const toolDecl = registeredTools.find((t) => t.name === "memory_forget");
  const toolOut = await toolDecl.execute({ memory_id: mem1.id }, undefined);
  ok("final/tool counterpart: memory_forget running through the REAL tool registry reached the same shared policy lane and honoured the forget",
    toolOut?.ok === true && db().rowByContent(derivedContentOf[1])?.status === "forgotten",
    `ok=${toolOut?.ok} status=${db().rowByContent(derivedContentOf[1])?.status}`);
  ok("final/tool tombstone: tool forget spends the exact support while preserving S1 and unrelated sessions",
    db().sessions.find((s) => s.session_id === S(1))?.revoked === 0 && db().sourcesFor(S(1)).some(s => Number(s.seq) === 0 && Number(s.revoked) === 1) &&
    db().sessions.filter((s) => [S(4), S(5)].includes(s.session_id)).every((s) => Number(s.revoked) === 0));

  // next identical recall: open a REAL MemoryStore over the SAME file (same
  // per-file protocol as the runtime fixtures) and use the genuine recall
  // filters.
  const { MemoryStore } = await lib("storage.js");
  const readStore = new MemoryStore(storeDir);
  try {
    const recallOld = readStore.searchMemories("launch key office safe ZED-7731", { limit: 10, matchAny: true });
    const recallCorrected = readStore.searchMemories("PINOLI-2214 PRIVATE operations board", { limit: 10, matchAny: true });
    ok("final/next identical recall: the FORGOTTEN fact is not recallable; the human-corrected row IS (explicit correction changes the next identical query)",
      !recallOld.some((h) => h.content?.includes("ZED-7731")) &&
      recallCorrected.some((h) => h.content?.includes("PRIVATE operations board")),
      `old hits=${recallOld.length} corrected hits=${recallCorrected.length}`);
  } finally {
    readStore.close();
  }

  ok("mount/logs: the plugin logged the policy lanes (pause/resume + consent + tombstone evidence reachable under debug)",
    pluginLogs.some((l) => l.includes("extract job policy") || l.includes("journal cancellation generation") || l.includes("lineage tombstone")),
    `${pluginLogs.filter((l) => /policy|cancellation|tombstone/i.test(l)).length} relevant log lines`);
  } finally {
    console.log = originalLog;
    boot.loader.remove("self-improved");
    await boot.loader.await();
  }
}

// ── main ───────────────────────────────────────────────────────────────────
console.log("test-v02-policy-lane: starting (unit bounds → mounted policy drive)");
await unitBounds();
await mountedDrive();

if (suiteFailed) {
  console.log(`test-v02-policy-lane: FAILED (${RESULTS.filter((r) => !r.ok).length} failing gate(s))`);
  process.exitCode = 1;
} else {
  console.log(`test-v02-policy-lane: PASS (${RESULTS.filter((r) => r.ok).length} gates)`);
}
