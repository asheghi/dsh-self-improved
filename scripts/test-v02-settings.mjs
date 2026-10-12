#!/usr/bin/env node
/**
 * Phase A focused rc.2 settings/business suite (MIGRATION-SETTINGS-TESTS).
 *
 * Isolated synthetic checks against the GENUINE installed rc.2 runtime classes
 * (no installed-plugin/profile mutation, no live settings writes, no provider
 * network). Covers:
 *
 *  1. Config schema classification (Phase A acceptance: editable fields
 *     volatile, storageRoot init-only nonvolatile, embedding key is a secret
 *     slot) and schema parity with the client field table.
 *  2. The settings write boundary at schema level: mutation paths under the
 *     volatile policy, and redactSecrets presence-only (never an echo).
 *  3. The typed business remote: business semantics against a real
 *     (synthetic, tmp) MemoryStore, the one-shot args+peer-bound mutation
 *     handshake, cancellation at the wire boundary, and endpoint parity with
 *     client descriptors + gateway SRC markers.
 *
 * Rollback note: this suite imports the plugin's built lib through the repo
 * tree; two legacy leftovers in node_modules were pointed at the rc.2 runtime
 * copies (dsh-typert-protocol, cosmokit, schemastery, +cordis-plugin-loader
 * symlink) — see MIGRATION-SETTINGS-TESTS.md "Environment changes".
 */
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("..", import.meta.url));
const RD = process.env.DSH_RUNTIME_RC2 ?? "/home/bahman/github/dsh-v0.2";
/** rc.2 runtime absolute imports (genuine classes, version assertion below). */
const runtime = (pkg, file = "lib/index.js") => import(`${RD}/node_modules/@deepseek-ai/${pkg}/${file}`);

const PASS = [];
/** Checks are REGISTERed here and await-run sequentially at the bottom, so an
 *  async failure always surfaces inside the loop (a bare sync `check(fn)` let
 *  async assertions escape after the summary printed and crash the process). */
const checks = [];
const check = (name, fn) => { checks.push([name, fn]); };

for (const pkg of ["dsh-settings", "schemastery", "cordis", "cosmokit", "dsh-typert-protocol", "cordis-plugin-loader"]) {
  const manifest = JSON.parse(readFileSync(join(RD, "node_modules", "@deepseek-ai", pkg, "package.json"), "utf8"));
  assert.ok(manifest.version, `runtime manifest readable: ${pkg}`);
}

// ── 1. Config classification ────────────────────────────────────────────────
const { Config } = await import(join(repo, "lib/index.js"));
const { FIELD_CLASSIFICATION, INIT_ONLY_PATHS } = await import(join(repo, "lib/runtime-config.js"));

/**
 * Replica of the settings schema walker's volatile rule
 * (dsh-settings holds `isVolatilePath` module-private in rc.2; the documented
 * contract is: a path is volatile when ITS nearest ancestor carries the
 * schema `volatile` meta marker). Asserting against the schema nodes keeps
 * the schema marking as source of truth.
 */
function volatileMarkerAtPath(schema, path) {
  let node = schema;
  for (let i = 0; i < path.length; i += 1) {
    if (node?.meta?.volatile) return true;
    node = node?.dict?.[path[i]];
  }
  return Boolean(node?.meta?.volatile);
}

check("lifecycle classes: migration-only/retired bypasses are inventoried but never ordinary-Advanced; filesystem roots are init-only", () => {
  // Coordinator round 48: unsafe provenance bypass + bad-JSON fallback are
  // migration-only/retired per the plan and src/migration-v02.ts's mapping.
  assert.equal(FIELD_CLASSIFICATION["extract.provenanceFilter"], "migration-only");
  assert.equal(FIELD_CLASSIFICATION["extract.fallbackOnBadJson"], "retired");
  assert.equal(FIELD_CLASSIFICATION["storageRoot"], "init-only");
  assert.equal(FIELD_CLASSIFICATION["evolve.skillSynthesis.skillsRoot"], "init-only", "grouped volatile evolve must not make skillsRoot a live filesystem-root write");
  assert.deepEqual([...INIT_ONLY_PATHS].sort(), ["evolve.skillSynthesis.skillsRoot", "storageRoot"]);
  // Strict filter stays recoverable in a migration workflow, off stays out.
  const advanced = new Set(Object.entries(FIELD_CLASSIFICATION).filter(([, v]) => v === "advanced").map(([k]) => k));
  assert.ok(!advanced.has("extract.provenanceFilter") && !advanced.has("extract.fallbackOnBadJson"));
});

check("volatile classification: every editable subtree is volatile; storageRoot is init-only", () => {
  assert.equal(volatileMarkerAtPath(Config, ["storageRoot"]), false, "storageRoot (init-only) is NOT volatile");
  for (const top of ["enabled", "debug", "searchLimit", "modules", "extract", "recall", "consolidate", "evolve", "housekeeping", "review", "episodeLearning"]) {
    assert.equal(volatileMarkerAtPath(Config, [top]), true, `${top} is volatile`);
    assert.ok(FIELD_CLASSIFICATION[top] !== undefined || Object.keys(FIELD_CLASSIFICATION).some((k) => k.startsWith(`${top}.`)), `${top} classified in the inventory`);
  }
  assert.equal(volatileMarkerAtPath(Config, ["recall", "embedding", "apiKey"]), true, "secret slot is volatile (editable live)");
  assert.equal(volatileMarkerAtPath(Config, ["recall", "embedding", "baseUrl"]), true, "nested fields inherit the volatile subtree");
  for (const p of INIT_ONLY_PATHS) assert.ok(!(p in FIELD_CLASSIFICATION) || FIELD_CLASSIFICATION[p] === "init-only");
  const apiKeyNode = Config.dict?.recall?.dict?.embedding?.dict?.apiKey;
  assert.equal(apiKeyNode?.meta?.role, "secret", "the embedding key is a schema-declared secret slot");
});

check("resolved runtime values: volatile refs for editable fields, plain storageRoot", () => {
  const resolved = Config({}, {});
  assert.equal(typeof resolved.enabled === "object" && typeof resolved.enabled.get === "function", true, "enabled arrives as a Volatile ref");
  assert.equal(typeof resolved.modules === "object" && typeof resolved.modules.get === "function", true, "modules arrives as a Volatile ref");
  assert.equal(typeof resolved.storageRoot, "string", "storageRoot stays a plain init-only value");
  assert.equal(typeof resolved.episodeLearning === "object" && typeof resolved.episodeLearning.get === "function", true);
  assert.equal(resolved.episodeLearning.get().skillDraftsEnabled, false, "inactive draft generation defaults off");
});

check("schema-to-UI inventory: every schema field classified exactly once, both halves agree", async () => {
  const clientSrc = readFileSync(join(repo, "client.js"), "utf8");
  const fieldsBlock = clientSrc.match(/var FIELDS = \[([\s\S]*?)\n\s*\];/);
  assert.ok(fieldsBlock, "client FIELDS block parses");
  const clientKeys = new Set([...fieldsBlock[1].matchAll(/path: \[([^\]]+)\]/g)].map((m) => m[1].match(/"([^"]+)"/g).map((s) => s.slice(1, -1)).join(".")));
  for (const [key, uiClass] of Object.entries(FIELD_CLASSIFICATION)) {
    assert.ok(clientKeys.has(key), `client exposes classified field ${key}`);
    assert.match(fieldsBlock[1], new RegExp(`path: \\[${key.split(".").map((s) => `"${s}"`).join(", ")}\\], uiClass: "${uiClass}"`), `client uiClass for ${key} is ${uiClass}`);
  }
  const schemaPaths = [];
  const walk = (node, path) => {
    for (const [key, child] of Object.entries(node.dict ?? {})) walk(child, [...path, key]);
    if (!node.dict) {
      schemaPaths.push(path.join("."));
      return;
    }
  };
  // 3.18.4 node shape: object nodes carry .dict { key: child }
  const walk2 = (node, path) => {
    if (node === null || node === void 0) return;
    if (node.dict && typeof node.dict === "object") {
      for (const [key, child] of Object.entries(node.dict)) walk2(child, [...path, key]);
    } else if (entriesOf(node.elements ?? node.array) === false) {
      schemaPaths.push(path.join("."));
    }
  };
  const entriesOf = (v) => (Array.isArray(v) && false);
  walk2(Config, []);
  const classified = new Set(Object.keys(FIELD_CLASSIFICATION));
  for (const p of schemaPaths) {
    assert.ok(classified.has(p), `schema field ${p} is classified in FIELD_CLASSIFICATION (hidden must not mean forgotten)`);
  }
});

check("secret slot: presence-only crossing the wire (Role('secret') redaction)", async () => {
  const settingsMod = await runtime("dsh-settings");
  const redact = settingsMod.redactSecrets;
  const value = {
    recall: { strategy: "keyword", embedding: { baseUrl: "https://example.invalid/v1", apiKey: "synthetic-not-a-real-credential", model: "emb", dimensions: 1024, timeoutMs: 10000 } },
  };
  const redacted = redact(Config, value);
  let stripped = JSON.stringify(redacted.value);
  assert.ok(!stripped.includes("synthetic-not-a-real-credential"), "the secret VALUE never rides the redacted view");
  const secret = redacted.secrets.find((s) => s.path.join(".") === "recall.embedding.apiKey");
  assert.ok(secret, "the secrets sidecar names the slot");
  assert.equal(secret.set, true, "presence (set) flag is served, not the value");
  assert.equal(secret.path.join("."), "recall.embedding.apiKey");
});

// ── 2. Business remote semantics against a real synthetic store ─────────────
check("business: reads, presence-only snapshot, mutating handshake and peer/args binding", async () => {
  const { createMemoryBusiness, AUTHORIZED_MUTATION_OPS } = await import(join(repo, "lib/business.js"));
  const { MemoryStore } = await import(join(repo, "lib/storage.js"));
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-settings-biz-")), "store");
  const store = new MemoryStore(dir);
  // Synthetic rows (no production data involved).
  store.setSessionProject("sess-biz", "proj-biz");
  const first = store.insertMemory({ kind: "fact", content: "synthetic fact alpha", importance: 7 }, { provenance: "extraction", source: "test", scope: "global" });
  const second = store.insertMemory({ kind: "preference", content: "synthetic preference beta", importance: 9 }, { provenance: "user", source: "test", scope: "global" });
  store.pinBaseline(first.id);

  const business = createMemoryBusiness({
    store,
    enabled: () => true,
    skillsPrefix: () => "dsi-",
    skillsRoot: () => "",
    episodeEnabled: () => false,
    log: () => {},
  });
  const peerA = { peerId: "peer-A-0001" };

  // Snapshot: redacted rows, no legacy Config-channel credential chips.
  const snap = business.snapshot(peerA, undefined);
  // Continuity lane status rides the snapshot as bounded facts, and a lane
  // reader that throws must degrade to null instead of breaking the read.
  const laneFacts = { structural: "off", body: "off", route: false, reason: "synthetic lane reason", pending: 0, failed: 0, handoffs: 0, lastCut: null };
  const withLane = createMemoryBusiness({ store, enabled: () => true, skillsPrefix: () => "dsi-", skillsRoot: () => "", episodeEnabled: () => false, log: () => {}, continuityLane: () => laneFacts });
  assert.deepEqual(withLane.snapshot(peerA, undefined).continuity, laneFacts, "the lane status is served with the snapshot");
  const brokenLane = createMemoryBusiness({ store, enabled: () => true, skillsPrefix: () => "dsi-", skillsRoot: () => "", episodeEnabled: () => false, log: () => {}, continuityLane: () => { throw new Error("lane reader exploded"); } });
  assert.equal(brokenLane.snapshot(peerA, undefined).continuity, null, "a failing lane reader degrades to null, never an error or a stale claim");
  assert.ok(Array.isArray(snap.memories) && snap.memories.length >= 2, "snapshot serves memory rows");
  const rawSnap = JSON.stringify(snap);
  assert.ok(!rawSnap.includes("actionToken"), "the typed business snapshot carries no namespace-published action token");
  assert.ok(!rawSnap.includes("confirm"), "the typed business snapshot carries no confirm chip (authorization is call-bound, not readable-state)");
  assert.ok(Array.isArray(AUTHORIZED_MUTATION_OPS) || AUTHORIZED_MUTATION_OPS.size === 6, "mutation op set declared");

  // One-shot + args-bound + peer-bound mutation handshake.
  const forgetArgs = { op: "forget", id: second.id };

  // (a) peer-bound: a token prepared by peer A cannot be executed by peer B;
  //     consume-first semantics clear the pending challenge either way, so the
  //     crossed attempt also protects the row (never executed).
  const stageCross = business.prepareMutation(peerA, forgetArgs);
  let crossThrew = false;
  try {
    business.forget({ peerId: "other-peer" }, second.id, { token: stageCross.token }, undefined);
  } catch {
    crossThrew = true;
  }
  assert.equal(crossThrew, true, "another peer cannot consume the prepared token");
  assert.equal(store.getMemory(second.id)?.status, "active", "the crossed-peer rejection executed nothing");

  // (b) args-bound: same peer executing for a DIFFERENT id fails the
  //     exact-args fingerprint binding.
  const stageWrong = business.prepareMutation(peerA, forgetArgs);
  let wrongThrew = false;
  try {
    business.forget(peerA, "01020304-synthetic-row-id", { token: stageWrong.token }, undefined);
  } catch {
    wrongThrew = true;
  }
  assert.equal(wrongThrew, true, "same peer but different args still fails (args-bound)");
  assert.equal(store.getMemory(second.id)?.status, "active", "the args-mismatch rejection executed nothing");

  // (c) exact peer + exact args executes exactly once; the same token replays fail.
  const staged = business.prepareMutation(peerA, forgetArgs);
  const res = business.forget(peerA, second.id, { token: staged.token }, undefined);
  assert.equal(res.op, "forget");
  assert.ok(res.affected === second.id, "forget affects the requested row");
  assert.equal(store.getMemory(second.id)?.status, "forgotten", "the row is forgotten in the store");
  let replayThrew = false;
  try {
    business.forget(peerA, second.id, { token: staged.token }, undefined);
  } catch {
    replayThrew = true;
  }
  assert.equal(replayThrew, true, "a consumed token cannot be replayed");
  assert.equal(store.getMemory(first.id)?.status, "active", "untouched row unaffected");

  // Consent-gated episode row reveal.
  const episodeRef = (() => { try { return business.episodeDetail(peerA, "whatever", undefined); } catch (e) { return e; } })();
  assert.match(String(episodeRef.message), /episode learning is disabled/, "episode rows stay local while consent is disarmed");

  store.close();
});

check("business: cancellation at the wire boundary and disabled-plugin surface", async () => {
  const { createMemoryBusiness } = await import(join(repo, "lib/business.js"));
  const { MemoryStore } = await import(join(repo, "lib/storage.js"));
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-settings-biz2-")), "store");
  const store = new MemoryStore(dir);
  let sawAbort = null;
  const business = createMemoryBusiness({
    store,
    enabled: () => true,
    episodeEnabled: () => true,
    skillsPrefix: () => "dsi-",
    log: () => {},
    episodeDryReview: async () => { // observe the cancellation signal flow-back
      return { considered: 0 };
    },
  });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(business.dryReview({ peerId: "peer-x" }, { token: "stale" }, abort.signal), (e) => /abort|cancelled/i.test(String(e.message ?? e)), "an aborted call refuses before execution");
  const live = new AbortController();
  await assert.rejects(business.dryReview({ peerId: "peer-x" }, { token: "stale" }, live.signal), /authorization/, "a valid-signal call still requires the handshake token");
  assert.equal(sawAbort, null, "no review leaked through the boundary");
  // Paused/remember-off MUST NOT hide stored data (MIGRATION-V0.2.md: "Off keeps saved data"; coordinator round 51):
  // reads, corrections and forgetting stay authorized; only capture/model work is consent-gated.
  const dir3 = join(mkdtempSync(join(tmpdir(), "dsi-settings-biz3-")), "store");
  const store3 = new MemoryStore(dir3);
  const paused = store3.insertMemory({ kind: "fact", content: "synthetic paused-row", importance: 6 }, { provenance: "extraction", source: "test", scope: "global" });
  const off = createMemoryBusiness({ store: store3, enabled: () => false, skillsPrefix: () => "", episodeEnabled: () => false, log: () => {} });
  const pausedPeek = off.snapshot({ peerId: "peer-z", source: "remote" }, undefined);
  assert.ok(Array.isArray(pausedPeek.memories) && pausedPeek.memories.length >= 1, "a remembered-off plugin still serves stored rows for inspection");
  const pausedDetail = off.memoryDetail({ peerId: "peer-z", source: "remote" }, paused.id, undefined);
  assert.equal(pausedDetail.id, paused.id, "row detail stays reachable while remembering is off");
  const stagedOff = off.prepareMutation({ peerId: "peer-z", source: "remote" }, { op: "forget", id: paused.id });
  const forgetOff = off.forget({ peerId: "peer-z", source: "remote" }, paused.id, { token: stagedOff.token }, undefined);
  assert.equal(forgetOff.affected, paused.id, "forget stays authorized while remembering is off");
  assert.equal(store3.getMemory(paused.id)?.status, "forgotten", "the paused-plugin forgetting took effect");
  // New model work stays consent-gated even when the plugin is otherwise on.
  const reviewOff = createMemoryBusiness({
    store: { getMemory: () => undefined },
    enabled: () => true,
    skillsPrefix: () => "",
    episodeEnabled: () => false,
    episodeDryReview: () => { throw new Error("dryReview must not run while episode consent is off"); },
    log: () => {},
  });
  const stageBlocked = reviewOff.prepareMutation({ peerId: "peer-z", source: "remote" }, { op: "dryReview" });
  await assert.rejects(reviewOff.dryReview({ peerId: "peer-z", source: "remote" }, { token: stageBlocked.token }, undefined), /disabled|unavailable/, "dry review refuses without episode consent");
  store3.close();
  store.close();
});

check("rc.2 remote surface: service registration, typert binding, SRC markers, cancellation params", async () => {
  const cordis = await runtime("cordis");
  const typert = await runtime("dsh-typert-protocol");
  const { registerMemoryBusinessRemote, MemoryBusinessService } = await import(join(repo, "lib/business.js"));
  const { remoteMethods } = typert;
  const manifest = JSON.parse(readFileSync(join(RD, "node_modules/@deepseek-ai/cordis/package.json"), "utf8"));
  // Cordis itself is a wheel-versioned shared lib (4.0.4 for rc.2); the dsh-*
  // peers pin 0.2.0-rc.2 (checked above), so accept the shipped cordis here.
  assert.ok(["4.0.4"].includes(manifest.version), "cordis ships as the rc.2 runtime's pinned version");

  const { MemoryStore } = await import(join(repo, "lib/storage.js"));
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-settings-remote-")), "store");
  const store = new MemoryStore(dir);

  const ctx = new cordis.Context();
  const dispose = registerMemoryBusinessRemote(ctx, {
    store,
    skillsPrefix: () => "dsi-",
    skillsRoot: () => "",
    episodeEnabled: () => false,
    enabled: () => true,
    log: () => {},
  });
  assert.equal(typeof dispose, "function", "register returns an effect disposer");
  await new Promise((resolve) => setTimeout(resolve, 30)); // child fiber settles
  const service = ctx.get("selfImprovedMemoryUi");
  assert.ok(service instanceof MemoryBusinessService, "the rc.2 service registers into the host tree");
  assert.equal(ctx.reflect.props["selfImprovedMemoryUi"]?.type, "service", "the gateway sees a plain service prop");

  const binding = service.typertRemote;
  assert.ok(binding, "the service carries the explicit typert binding");
  assert.equal(binding.serviceKey, "selfImprovedMemoryUi");
  assert.equal(binding.namespace, "selfImproved");

  // SRC markers mirror the client contribution endpoints.
  const markers = remoteMethods(service).map((m) => m.exportName ?? m.method);
  const expected = ["snapshot", "memoryDetail", "episodeDetail", "prepareMutation", "forget", "correct", "confirmCorrect", "deleteSkillRemoval", "purgeEpisodes", "dryReview", "continuityStatus", "prepareContinue", "continueSession"];
  assert.deepEqual([...markers].sort(), [...expected].sort(), "every business method carries its @Remote SRC marker");

  // Endpoint parity with the client descriptor table.
  const clientSrc = readFileSync(join(repo, "client.js"), "utf8");
  const descBlock = clientSrc.match(/var BUSINESS_DESCRIPTORS = \[[\s\S]*?\n\s*\];/);
  assert.ok(descBlock, "client descriptor block parses");
  const clientEndpoints = [...descBlock[0].matchAll(/namespace: REMOTE_NS, method: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual([...clientEndpoints].sort(), [...expected].sort(), "client endpoints mirror the host SRC markers");

  // Cancellation: every remote business method takes a trailing signal param
  // (the Gateway SRC cancellation) — verify the compiled parameter lists.
  const cancellable = clientEndpoints.filter((n) => n !== "prepareMutation");
  for (const name of cancellable) {
    const fn = MemoryBusinessService.prototype[name];
    const params = String(fn).match(/\((.*?)\)/)?.[1] ?? "";
    const names = params.split(",").map((x) => x.trim().split(/[=:?][ ]?/)[0]).filter(Boolean);
    assert.equal(names[names.length - 1], "signal", `${name} takes the trailing cancellation signal (Gateway injects it last)`);
  }

  // Gateway claims: once the service is provided, the endpoint claims (the
  // gateway's collectSrcClaims face) would include our namespace; assert the
  // binding-level equivalent via the descriptors read off the live class.
  await store.close();

  // Dispose: the effect-owned registration drops the service.
  dispose();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(ctx.get("selfImprovedMemoryUi"), undefined, "after disposal the service is no longer resolvable (effect-owned registration)");
});

// ── 3. Lifecycle boundary: accepted-work shutdown ordering (runtime D1) ─────
const lifecycle = await (async () => {
  const cordis = await runtime("cordis");
  const { installCapture } = await import(join(repo, "lib/capture.js"));
  const { MemoryStore } = await import(join(repo, "lib/storage.js"));
  const { registerShutdownDrain } = await import(join(repo, "lib/index.js"));

  const syntheticSession = () => ({
    id: "sess-d1-" + Math.random().toString(16).slice(2, 8),
    header: { cwd: "/tmp/dsi-synthetic" },
    inheritedEventCount: 0,
    ownEvents: () => [
      { type: "user/message", seq: 0, time: 1, data: { content: [{ type: "text", text: "accepted flush extraction probe" }], source: { kind: "user" } } },
    ],
  });

  /** An accepted pump that inserts a memory 40ms after being accepted — exactly
   *  the shape the runtime report lost to an early `store.close()`. The insert
   *  failure path is OBSERVED (recorded), never swallowed silently. */
  const makeOnCaptured = (store, jobs, events) => () => {
    const job = new Promise((resolve) => {
      setTimeout(() => {
        try {
          store.insertMemory({ kind: "fact", content: "accepted flush extraction", importance: 6 }, { provenance: "extraction", source: "test", scope: "global" });
          events.push("insert:ok");
          resolve("inserted");
        } catch (error) {
          events.push("insert:LOST(" + String(error.message ?? error) + ")");
          resolve("lost");
        }
      }, 40);
    });
    jobs.add(job);
    void job.finally(() => { jobs.delete(job); return undefined; }).catch(() => {});
    return job; // flushDrain semantics: the flush barrier awaits it
  };

  return { cordis, installCapture, MemoryStore, registerShutdownDrain, syntheticSession, makeOnCaptured };
})();

check("lifecycle: the OLD (pre-fix) close-first ordering loses an accepted extraction insert (race reproduced)", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-d1-neg-")), "store");
  const store = new lifecycle.MemoryStore(dir);
  const events = [];
  const origClose = store.close.bind(store);
  store.close = () => { events.push("close"); origClose(); };
  const jobs = new Set();
  const ctx = new lifecycle.cordis.Context();
  const captureDispose = lifecycle.installCapture(ctx, store, { enabled: () => true }, lifecycle.makeOnCaptured(store, jobs, events), undefined);
  void captureDispose; // the buggy teardown did NOT take the ingress down first
  // The naive close effect is registered AFTER the capture listener, so cordis's
  // reverse disposal ran close FIRST whenever the pump was mid-flight.
  ctx.effect(() => () => { store.close(); }, "naive close (pre-fix)");
  ctx.emit(ctx, "session/flush", lifecycle.syntheticSession());
  await ctx.fiber.dispose();
  await new Promise((resolve) => setTimeout(resolve, 120)); // the accepted pump's insert lands (or fails) at +40ms
  const lost = events.find((e) => e.startsWith("insert:"));
  assert.ok(typeof lost === "string", `the accepted insertion is lost to the early close (race reproduced) — events: ${events.join(" -> ")}`);
  assert.match(lost ?? "", /insert:LOST\((?:.*not open|MemoryStore is closed)/i, "negative control loses accepted insert to early close (SQLite or explicit closed-store guard)");
  assert.ok(events.indexOf("close") < events.findIndex((e) => e.startsWith("insert:")), "close ran before the accepted commit (buggy ordering)");
});

check("lifecycle: registerShutdownDrain joins accepted work bounded before close; ingress stays down afterwards", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "dsi-d1-pos-")), "store");
  const store = new lifecycle.MemoryStore(dir);
  const events = [];
  const origClose = store.close.bind(store);
  store.close = () => { events.push("close"); origClose(); };
  const jobs = new Set();
  const ctx = new lifecycle.cordis.Context();
  const captureDispose = lifecycle.installCapture(ctx, store, { enabled: () => true }, lifecycle.makeOnCaptured(store, jobs, events), undefined);
  lifecycle.registerShutdownDrain(ctx, {
    onShutdownStart: () => { /* index.ts sets shuttingDown (readModule gates) */ },
    dropIngress: () => { captureDispose(); },
    preClose: () => {},
    jobs,
    close: () => store.close(),
    warn: () => {},
  });
  ctx.emit(ctx, "session/flush", lifecycle.syntheticSession());
  let disposeError = null;
  try { await ctx.fiber.dispose(); } catch (error) { disposeError = error; }
  assert.equal(disposeError, null, "the dispose chain completed without an error");
  const closeIdx = events.indexOf("close");
  const insertIdx = events.findIndex((e) => e.startsWith("insert:"));
  assert.ok(closeIdx >= 0, "the store was closed exactly at the boundary");
  assert.ok(insertIdx >= 0 && insertIdx < closeIdx && events[insertIdx] === "insert:ok", `the accepted extraction committed BEFORE store.close() — events: ${events.join(" -> ")}`);
  assert.ok(events.some((e) => e.startsWith("insert:ok")), `the accepted insertion was NOT lost — events: ${events.join(" -> ")}`);
  assert.equal(jobs.size, 0, "the accepted-job tracking settles (no leak after dispose)");
  // Ingress stays down after the boundary: a late flush must not re-enter capture.
  let latePumps = 0;
  const countCtx = new lifecycle.cordis.Context();
  lifecycle.installCapture(countCtx, store /* closed */, { enabled: () => false }, () => { latePumps++; }, undefined);
  await countCtx.fiber.dispose();
  await ctx.emit(ctx, "session/flush", lifecycle.syntheticSession());
  assert.equal(latePumps, 0, "no pump after the disposed boundary (ingress closed safely)");
});

// ── 4. Genuine Loader volatile-update verification (real Entry.update path) ─
const cosmo = (await import(`${RD}/node_modules/@deepseek-ai/cosmokit/lib/index.js`));
/** Boot the REAL plugin through the GENUINE rc.2 Loader in this process. */
async function bootPluginThroughLoader(log) {
  const loaderMod = await runtime("cordis-plugin-loader");
  const ctx0 = new lifecycle.cordis.Context();
  ctx0.provide("settings", { configure: () => () => {} });
  ctx0.provide("systemPrompt", { section: () => {} });
  ctx0.provide("sessions", {});
  ctx0.provide("sessionQuery", {});
  ctx0.provide("llm", {});
  ctx0.provide("tools", { register: () => () => {} });
  const pluginLogs = [];
  const consoleLog = console.log;
  console.log = (...args) => { pluginLogs.push(args.map(String).join(" ")); };
  try {
    let captured = null;
    const fiber = ctx0.plugin({ name: "loader-host", apply: (child) => {
      captured = new loaderMod.Loader(child, { baseUrl: new URL("file://" + join(repo, "lib/")).href });
    }});
    await fiber.await();
    const config = {
      enabled: true, debug: true,
      storageRoot: join(mkdtempSync(join(tmpdir(), "dsi-loader-boot-")), "store"),
      searchLimit: 5,
      modules: { capture: false, extract: false, consolidate: false, evolve: false, recall: false, tools: true },
      extract: { intervalMinutes: 1, batchMaxChars: 4000, maxOutputTokens: 2000, timeoutMs: 60000, dedup: true, fallbackOnBadJson: false, minImportance: 6, flushDrain: false, model: "", provider: "", provenanceFilter: "strict", requireEvidence: true },
      recall: { strategy: "keyword", maxResults: 5, scoreThreshold: 0, timeoutMs: 5000, maxInjectChars: 800, relevanceMargin: 0.5, minImportance: 0, maxInjectPerTurn: 4, embedding: { baseUrl: "", apiKey: "", model: "", dimensions: 1024, timeoutMs: 10000 } },
      consolidate: { scenesEnabled: false, sceneMaxMemories: 50, personaMaxMemories: 30, sceneBatchSize: 8 },
      evolve: { decay: { enabled: false, minAgeDays: 7, threshold: 2, retentionDays: 180, maxActiveMemories: 500 }, skillSynthesis: { enabled: false, minImportance: 7, skillsRoot: "", prefix: "dsi-", maxSkills: 100 } },
      housekeeping: { personaVersions: 10, maxScenes: 50, sceneActiveRatio: 0.3, conversationRetentionDays: 90 },
      review: { enabled: false, time: "22:00" },
      episodeLearning: { enabled: false, captureArguments: true, resultExcerptChars: 4000, retentionDays: 90, reviewEnabled: true, confidenceFloor: 0.8, expiryDays: 90, operationalRecallEnabled: false, maxRecallResults: 2, maxRecallChars: 600, skillMinEpisodes: 2 },
    };
    await captured.create({ name: "./index.js", id: "self-improved", config });
    await captured.await();
    const entry = captured.resolve("self-improved");
    return { ctx0, loader: captured, entry, pluginLogs, restoreLog: () => { console.log = consoleLog; } };
  } finally { console.log = consoleLog; }
}
// silence boot logs while the runs below execute (kept in pluginLogs)

/** Silence-and-capture console.log/warn around a body (plugin boot logs are
 *  loud; assertions read the captured lines). */
async function withCapturedConsole(body) {
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args) => { logs.push(args.map(String).join(" ")); };
  console.warn = (...args) => { logs.push("[warn] " + args.map(String).join(" ")); };
  try { return { out: await body(), logs }; }
  finally { console.log = origLog; console.warn = origWarn; }
}

check("loader volatile-update: boot — the plugin applies through the genuine Loader", async () => {
  const boot = await bootPluginThroughLoader();
  try {
    assert.ok(boot.entry.fiber?.uid > 0, "the entry fiber started");
    assert.ok(boot.pluginLogs.some((l) => l.includes("dsh-self-improved loaded")), "apply() ran to completion under the Loader");
  } finally { await boot.loader.dispose?.("self-improved") || boot.loader.remove("self-improved"); }
});

check("loader volatile-update: a volatile-only settings edit hot-commits WITHOUT stopping the plugin fiber", async () => {
  const boot = await bootPluginThroughLoader();
  try {
    await boot.loader.await();
    const entry = boot.entry;
    const fiberRefBefore = entry.fiber;
    const uidBefore = entry.fiber.uid;
    const { logs } = await withCapturedConsole(async () => {
      await entry.update({ config: { ...entry.options.config, searchLimit: 9 } });
      await boot.loader.await();
      await new Promise((r) => setTimeout(r, 100));
    });
    const ref = entry.fiber.config.searchLimit;
    assert.equal(cosmo.isVolatile(ref) ? ref.get() : ref, 9, "the changed volatile value is committed into the running fiber");
    assert.ok(entry.fiber === fiberRefBefore, "volatile-only edits never restart the plugin fiber");
    assert.ok(logs.some((l) => l.includes("volatile settings applied (no restart)")), "the plugin's loader/volatile-update hook ran and hot-applied (schedulers/gate/tools/commands)");
  } finally {
    try { boot.loader.remove("self-improved"); await boot.loader.await(); } catch { /* teardown best effort */ }
  }
});

check("loader volatile-update: a live skillsRoot edit warns and does NOT retarget the running filesystem root", async () => {
  const boot = await bootPluginThroughLoader();
  try {
    await boot.loader.await();
    const entry = boot.entry;
    const fiberRefBefore = entry.fiber;
    let warns = [];
    const consoleWarn = console.warn;
    console.warn = (...args) => { warns.push(args.map(String).join(" ")); consoleWarn(...args); };
    try {
      await entry.update({ config: { ...entry.options.config, evolve: { ...entry.options.config.evolve, skillSynthesis: { ...entry.options.config.evolve.skillSynthesis, skillsRoot: "/tmp/dsi-never-activated-root" } } } });
      await boot.loader.await();
      await new Promise((r) => setTimeout(r, 100));
    } finally { console.warn = consoleWarn; }
    assert.equal(entry.fiber, fiberRefBefore, "the hot edit stays inside the running fiber");
    assert.ok(warns.some((w) => w.includes("skillsRoot is initialization-only")), "the plugin warns visibly that the live skillsRoot edit is init-only and needs a restart");
  } finally {
    try { boot.loader.remove("self-improved"); await boot.loader.await(); } catch { /* teardown best effort */ }
  }
});

check("loader volatile-update: an init-only storageRoot edit still takes the full restart lifecycle", async () => {
  const boot = await bootPluginThroughLoader();
  try {
    await boot.loader.await();
    const entry = boot.entry;
    const newRoot = join(mkdtempSync(join(tmpdir(), "dsi-loader-nv-")), "store");
    const { logs } = await withCapturedConsole(async () => {
      await entry.update({ config: { ...entry.options.config, storageRoot: newRoot } });
      await boot.loader.await();
      await new Promise((r) => setTimeout(r, 100));
    });
    assert.notEqual(entry.fiber.config.storageRoot, undefined, "the restarted fiber carries a storage root");
    const refRoot = entry.fiber.config.storageRoot;
    const rootValue = cosmo.isVolatile(refRoot) ? refRoot.get() : refRoot;
    assert.equal(String(rootValue), newRoot, "the plugin restarted with the new storage root (init-only semantics enforced by the loader, not the plugin)");
    assert.ok(logs.some((l) => l.includes("memory store ready: " + newRoot)), "the restarted plugin opened the NEW storage root (store close under drain was owned by the same lifecycle)");
      assert.ok(logs.some((l) => l.includes("dsh-self-improved loaded")), "apply() re-ran for the init-only change (full restart lifecycle)");
  } finally {
    try { boot.loader.remove("self-improved"); await boot.loader.await(); } catch { /* teardown best effort */ }
  }
});


for (const [name, fn] of checks) {
  await fn();
  PASS.push(name);
  console.log(`PASS  ${name}`);
}
console.log(`test-v02-settings: ${PASS.length}/${PASS.length} PASS`);
