#!/usr/bin/env node
// Actual rc.2 Loader main plugin, real native observation + SQLite, ONLY synthetic adapter.
// Explicit isolated admission stub below exercises lifecycle/policy, NOT genuine
// Host HTTP authorization. Genuine ingress is tested by the separate core-candidate suite.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2;
const missingCapability = process.argv.includes('--summary-fence-missing-capability');
const incompatibleSummary = process.argv.includes('--summary-fence-incompatible');
const extraSummaryIndex = process.argv.includes('--summary-fence-extra-index');
const reorderedHumanWatermark = process.argv.includes('--watermark-reordered-schema');
const settingsRouteUpdate = process.argv.includes('--settings-route-update');
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no runtime install/patch/profile/fallback');
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection', 'dsh-llm']) assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.1-rc.2');
if (settingsRouteUpdate) for (const name of ['dsh-agent-default-model', 'dsh-settings']) assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.1-rc.2');
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true }); const dir = mkdtempSync(join(repo, '.tmp-import-lane/continuity-main-worker-'));
const pkg = join(dir, 'plugin'); mkdirSync(pkg, { recursive: true }); cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await native('cordis'), { Loader } = await native('cordis-plugin-loader');
const { SessionStore } = await native('dsh-session'), { SessionQueryEngine } = await native('dsh-session-query');
const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { LlmRuntime, LlmAdapter, createUserMessage } = await native('dsh-llm');
const { MemoryStore } = await import(pathToFileURL(join(pkg, 'lib/storage.js')).href);
const root = new Context(), fibers = [];
// 0.2.1 Peer-model marker only. Authority comes from the native owner prompt
// source `{kind:'user',rpcId}` on the appended message itself.
let fixturePrompt = 0;
root.provide('connection', { createPeer() { throw new Error('fixture connection mints no Peers'); } });
if (!settingsRouteUpdate) root.provide('settings', { configure: () => () => {} });
root.provide('systemPrompt', { section: () => {} });
root.provide('tools', { register: () => () => {} }); root.provide('commands', { register: () => () => {} });
for (const plugin of [SessionStore, SessionQueryEngine, ...(missingCapability ? [] : [SessionProjectionRegistry]), LlmRuntime]) { const fiber = root.plugin(plugin); await fiber.await(); fibers.push(fiber); }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const observed = new Map(), dropped = new Map(); let dropWatch, heldObservation;
const observe = root.sessionQuery.observeSession.bind(root.sessionQuery);
root.sessionQuery.observeSession = async (id, options) => {
  const lease = await observe(id, options); observed.set(id, (observed.get(id) ?? 0) + 1);
  if (heldObservation?.id === id) { heldObservation.signal = options.signal; heldObservation.ready.resolve(); await heldObservation.release.promise; }
  return { ...lease, [Symbol.dispose]() { lease[Symbol.dispose](); dropped.set(id, (dropped.get(id) ?? 0) + 1); dropWatch?.(id); } };
};
let handler, providerCalls = 0, providerHeld = false, closed = false, closedWhileHeld = false;
const requests = [];
class SyntheticAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic main fixture' }; }
  async *stream(options) { providerCalls++; requests.push(options); yield* handler(options); }
}
const registration = root.llm.registerAdapter(['synthetic-main-continuity'], new SyntheticAdapter());
const originalClose = MemoryStore.prototype.close; let closeDone = deferred();
MemoryStore.prototype.close = function() { closed = true; if (providerHeld) closedWhileHeld = true; const result = originalClose.call(this); closeDone.resolve(); return result; };
const config = {
  enabled: false, debug: false, storageRoot: join(dir, 'store'), searchLimit: 5,
  continuity: { enabled: true, summaryEnabled: false, excludedSessionIds: [], excludedProjectIds: [] },
  modules: { capture: true, extract: false, consolidate: false, evolve: false, recall: false, tools: false },
  extract: { provider: settingsRouteUpdate ? '' : 'synthetic-main-continuity', model: settingsRouteUpdate ? '' : 'fixture' }, recall: { embedding: {} },
  consolidate: {}, evolve: { decay: {}, skillSynthesis: {} }, housekeeping: {}, review: { enabled: false },
  episodeLearning: { enabled: false, reviewEnabled: false, operationalRecallEnabled: false },
};
if (missingCapability || incompatibleSummary || extraSummaryIndex || reorderedHumanWatermark) {
  mkdirSync(config.storageRoot, { recursive: true }); const prior = new DatabaseSync(join(config.storageRoot, 'memory.db'));
  try {
    if (incompatibleSummary) prior.exec('CREATE TABLE continuity_summary_policy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL) STRICT; INSERT INTO continuity_summary_policy VALUES(1,9)');
    else if (missingCapability) prior.exec(`CREATE TABLE continuity_summary_policy (
      id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(generation>=0),
      allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
    ) STRICT; INSERT INTO continuity_summary_policy VALUES(1,9,1)`);
    else if (extraSummaryIndex) prior.exec(`CREATE TABLE continuity_summary_policy (
      id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(generation>=0),
      allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
    ) STRICT; INSERT INTO continuity_summary_policy VALUES(1,8,1);
    CREATE INDEX bad_summary_policy_idx ON continuity_summary_policy(generation)`);
    else prior.exec(`CREATE TABLE continuity_summary_human (
      project_id TEXT NOT NULL,session_id TEXT PRIMARY KEY,header_hash TEXT NOT NULL,
      inherited_floor INTEGER NOT NULL,human_seq INTEGER NOT NULL
    ) STRICT`);
  } finally { prior.close(); }
  if (incompatibleSummary || extraSummaryIndex || reorderedHumanWatermark) { config.enabled = true; config.continuity.summaryEnabled = true; }
}
let loader, entryRemoved = false, db, entry, passes = 0, serial = 0, settingsFormFiber, defaultModelEntry;
const loaderFiber = root.plugin({ name: 'main-worker-fixture-loader', apply: ctx => { loader = new Loader(ctx, { baseUrl: pathToFileURL(join(pkg, 'lib') + '/').href }); } }); await loaderFiber.await();
if (settingsRouteUpdate) {
  const settingsHome = join(dir, 'settings-home'); mkdirSync(settingsHome, { recursive: true });
  root.provide('profileContext', { home: settingsHome, name: 'private-settings-route-update' });
  root.provide('configEditor', {
    documentPath: join(settingsHome, 'profile.yaml'),
    entries: () => [...loader.entries()],
    configuration: () => [...loader.entries()].map(entry => ({ entry, inherited: {}, override: structuredClone(entry.options.config ?? {}) })),
    async edit(entry, change) {
      const next = change(structuredClone(entry.options.config ?? {}), {});
      await entry.update({ config: next }); await loader.await();
    },
  });
  const { default: SettingsForms } = await native('dsh-settings');
  settingsFormFiber = root.plugin(SettingsForms); await settingsFormFiber.await(); fibers.push(settingsFormFiber);
  await loader.create({ id: 'agent-default-model-fixture', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'synthetic-main-continuity', model: 'fixture' } });
  await loader.await(); defaultModelEntry = loader.resolve('agent-default-model-fixture'); assert.ok(defaultModelEntry?.fiber);
}
const childReady = missingCapability ? Promise.resolve({ await: async () => {} }) : new Promise((resolve, reject) => {
  const timer = setTimeout(() => { off(); reject(new Error('optional native continuity fiber unavailable')); }, 10000);
  const off = root.on('internal/status', fiber => { if (Object.hasOwn(fiber.inject ?? {}, 'sessionProjections')) { clearTimeout(timer); off(); resolve(fiber); } });
});
const check = async (name, fn) => { await fn(); passes++; console.log('PASS ' + name); };
const newSession = name => root.sessions.create('main-worker-' + ++serial + '-' + name, { meta: { cwd: '/synthetic/main-worker/' + serial } });
const user = (s, text = 'Continue the unfinished synthetic parser.') => {
  const requestId = `synthetic-isolated-admission-${++fixturePrompt}`;
  const message = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] });
  return s.append('user/message', message, { surfaceOp: 'append' });
};
const update = async patch => { const next = structuredClone(config); patch(next); await entry.update({ config: next }); await loader.await(); Object.assign(config, next); };
const boundary = s => s.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
const waitDrops = (s, extra) => {
  const target = (dropped.get(s.id) ?? 0) + extra; let timer;
  const done = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('native lease disposal did not reach expected boundary count')), 10000); dropWatch = id => { if (id === s.id && (dropped.get(id) ?? 0) >= target) resolve(); }; });
  return async () => { try { await done; await new Promise(resolve => setImmediate(resolve)); } finally { clearTimeout(timer); dropWatch = undefined; } };
};
const successful = async function*(o) {
  const body = JSON.parse(o.messages[0].content[0].text); assert.equal(body.partial, true); assert.equal(body.unverified, true);
  yield { type: 'text-delta', index: 0, text: JSON.stringify({ excerpts: body.excerpts.length ? [{ seq: body.excerpts[0].seq, quote: body.excerpts[0].text.slice(0, 80) }] : [] }) };
  yield { type: 'finish', reason: { kind: 'stop' } };
};
const hasTable = name => db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
const pendingFor = s => hasTable('continuity_jobs') ? Number(db.prepare("SELECT COUNT(*) AS n FROM continuity_jobs WHERE session_id=? AND status='pending'").get(s.id).n) : 0;
const completedFor = s => hasTable('continuity_work') ? Number(db.prepare("SELECT COUNT(*) AS n FROM continuity_work w JOIN continuity_jobs j ON j.id=w.job_id WHERE j.session_id=? AND w.status='completed'").get(s.id).n) : 0;
const handoffsFor = s => hasTable('continuity_handoff') ? Number(db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff WHERE session_id=?').get(s.id).n) : 0;
try {
  await loader.create({ id: 'self-improved', name: './index.js', config }); await loader.await(); await (await childReady).await(); entry = loader.resolve('self-improved'); assert.ok(entry);
  db = new DatabaseSync(join(config.storageRoot, 'memory.db'), { readOnly: true });
  if (missingCapability) {
    await check('existing summary provider generation is denied on default-off boot even with optional projection SDK absent', async () => {
      const row = db.prepare('SELECT generation,allowed FROM continuity_summary_policy WHERE id=1').get(); assert.equal(row.allowed, 0); assert.equal(row.generation, 10);
      const s = newSession('no-capability'); user(s); boundary(s); assert.equal(observed.get(s.id) ?? 0, 0); assert.equal(providerCalls, 0);
      loader.remove('self-improved'); entryRemoved = true; await closeDone.promise; assert.equal(closed, true);
    });
  } else if (incompatibleSummary) {
    await check('incompatible prior summary schema refuses before writes/body provider while structural capture remains independent', async () => {
      const s = newSession('incompatible'); user(s); const settled = waitDrops(s, 1); boundary(s); await settled();
      assert.equal(db.prepare('SELECT generation FROM continuity_summary_policy WHERE id=1').get().generation, 9);
      assert.equal(providerCalls, 0); assert.equal(observed.get(s.id), 1); assert.equal(pendingFor(s), 1);
      loader.remove('self-improved'); entryRemoved = true; await closeDone.promise; assert.equal(closed, true);
    });
  } else if (extraSummaryIndex) {
    await check('extra summary policy index refuses before consent update/provider while structural capture remains independent', async () => {
      const s = newSession('extra-summary-index'); user(s); const settled = waitDrops(s, 1); boundary(s); await settled();
      const row = db.prepare('SELECT generation,allowed FROM main.continuity_summary_policy WHERE id=1').get();
      assert.equal(row.generation, 8); assert.equal(row.allowed, 1);
      assert.equal(providerCalls, 0); assert.equal(observed.get(s.id), 1); assert.equal(pendingFor(s), 1);
      loader.remove('self-improved'); entryRemoved = true; await closeDone.promise; assert.equal(closed, true);
    });
  } else if (reorderedHumanWatermark) {
    await check('reordered strict human ledger refuses before claim/provider/work mutation while structural capture remains independent', async () => {
      const beforeRows = db.prepare('SELECT * FROM continuity_summary_human').all();
      const beforeShape = db.prepare("PRAGMA table_xinfo('continuity_summary_human')").all();
      const s = newSession('reordered-human-watermark'); user(s);
      const settled = waitDrops(s, 1); boundary(s); await settled();
      for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(db.prepare('SELECT * FROM continuity_summary_human').all(), beforeRows);
      assert.deepEqual(db.prepare("PRAGMA table_xinfo('continuity_summary_human')").all(), beforeShape);
      assert.equal(providerCalls, 0); assert.equal(observed.get(s.id), 1, 'no body-worker observation lease');
      assert.equal(pendingFor(s), 1, 'structural capture remains independently pending');
      assert.equal(completedFor(s), 0); assert.equal(handoffsFor(s), 0);
      loader.remove('self-improved'); entryRemoved = true; await closeDone.promise; assert.equal(closed, true);
    });
  } else {
  await check('disabled native Loader main has zero canonical observations/provider calls and no body policy namespace', async () => {
    const s = newSession('disabled'); user(s); boundary(s); assert.equal(observed.get(s.id) ?? 0, 0); assert.equal(providerCalls, 0);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='continuity_summary_policy'").get(), undefined);
  });
  await update(next => { next.enabled = true; });
  const structural = newSession('structural'); user(structural);
  await check('structural opt-in defaults provider/body off; own boundary captures only one native structural lease', async () => {
    const settled = waitDrops(structural, 1); boundary(structural); await settled(); assert.equal(pendingFor(structural), 1); assert.equal(providerCalls, 0);
    assert.equal(observed.get(structural.id), 1); assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='continuity_summary_policy'").get(), undefined);
  });
  if (process.argv.includes('--default-off-shutdown')) {
    await check('default-off unload retains accepted noncooperative native structural lease before closing; zero body/provider work', async () => {
      const s = newSession('default-off-held-source'); user(s);
      heldObservation = { id: s.id, ready: deferred(), release: deferred(), signal: undefined };
      const settled = waitDrops(s, 1); boundary(s); await heldObservation.ready.promise;
      const aborted = deferred(); heldObservation.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      loader.remove('self-improved'); entryRemoved = true; await aborted.promise;
      assert.equal(closed, false); assert.equal(providerCalls, 0); assert.equal(heldObservation.signal.aborted, true);
      heldObservation.release.resolve(); await settled();
      let timer; try { await Promise.race([closeDone.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('default-off shared-store close did not settle')), 10000); })]); } finally { clearTimeout(timer); }
      assert.equal(closed, true); assert.equal(pendingFor(s), 0, 'disposed source cannot late enqueue'); assert.equal(pendingFor(structural), 1);
      assert.equal(providerCalls, 0); assert.equal(closedWhileHeld, false);
    });
  } else {
  await update(next => { next.continuity.summaryEnabled = true; }); handler = successful;
  // A settings epoch change invalidates prior admission; explicitly admit a
  // fresh fixture prompt rather than treating saved history as authority.
  user(structural);
  await check('separate explicit body consent runs ONE pass after durable owner capture, exact partial handoff no session binding', async () => {
    const settled = waitDrops(structural, 2); boundary(structural); await settled(); assert.equal(providerCalls, 1); assert.equal(completedFor(structural), 1); assert.equal(handoffsFor(structural), 1);
    assert.equal(pendingFor(structural), 2, 'bounded pass does NOT drain all references');
    const request = requests.at(-1); for (const key of ['sessionId', 'purpose', 'tools', 'toolHistory']) assert.equal(Object.hasOwn(request, key), false);
    const saved = JSON.parse(db.prepare('SELECT payload FROM continuity_handoff WHERE session_id=?').get(structural.id).payload); assert.equal(saved.uncertain, true); assert.match(saved.notes[0], /^Partial unverified excerpt/);
  });
  await check('repeated boundary without fresh own human coordinate never drives a second provider pass', async () => {
    const settled = waitDrops(structural, 1); boundary(structural); await settled(); assert.equal(providerCalls, 1);
  });
  if (settingsRouteUpdate) {
    await check('real rc.2 SettingsForms edit changes AgentDefaultModel route and aborts held main-worker output', async () => {
      const s = newSession('settings-default-route'); user(s);
      const ready = deferred(), release = deferred(); let signal;
      handler = async function*(o) { signal = o.signal; providerHeld = true; ready.resolve(); try { await release.promise; yield* successful(o); } finally { providerHeld = false; } };
      const settled = waitDrops(s, 2); boundary(s); await ready.promise;
      assert.equal(requests.at(-1).provider, 'synthetic-main-continuity'); assert.equal(requests.at(-1).model, 'fixture');
      const before = db.prepare('SELECT generation,allowed FROM continuity_summary_policy WHERE id=1').get(); assert.equal(before.allowed, 1);
      const descriptor = root.settings.describe().find(row => row.ns === 'agent-default-model-fixture'); assert.ok(descriptor);
      await root.settings.update(descriptor.ns, { model: 'new-default-model' }, descriptor.revision);
      assert.equal(root.agentDefaultModel.currentSelection().model, 'new-default-model');
      assert.equal(signal.aborted, true); assert.equal(pendingFor(s), 1);
      const after = db.prepare('SELECT generation,allowed FROM continuity_summary_policy WHERE id=1').get(); assert.ok(after.generation > before.generation); assert.equal(after.allowed, 1);
      release.resolve(); await settled(); assert.equal(completedFor(s), 0); assert.equal(handoffsFor(s), 0); assert.equal(providerHeld, false);
      const latest = root.settings.describe().find(row => row.ns === 'agent-default-model-fixture'); assert.ok(latest);
      await root.settings.update(latest.ns, { model: 'fixture' }, latest.revision);
      assert.equal(root.agentDefaultModel.currentSelection().model, 'fixture'); handler = successful;
    });
  }
  if (process.argv.includes('--watermark-restart')) {
    await check('129-session pressure cannot evict old own-human authority; newer direct-human coordinate is admitted exactly once', async () => {
      for (let i = 0; i < 128; i++) {
        const s = newSession('watermark-pressure-' + i); user(s); const settled = waitDrops(s, 2); boundary(s); await settled();
      }
      assert.equal(providerCalls, 129); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM continuity_summary_human').get().n, 129);
      const unchanged = waitDrops(structural, 1); boundary(structural); await unchanged(); assert.equal(providerCalls, 129, 'unchanged model-only old session cannot regain authority');
      user(structural, 'New own human instruction: inspect parser delta.'); const fresh = waitDrops(structural, 2); boundary(structural); await fresh(); assert.equal(providerCalls, 130);
      const repeat = waitDrops(structural, 1); boundary(structural); await repeat(); assert.equal(providerCalls, 130);
    });
    await check('actual main unload/recreate on the same durable store retains original native-header/project human watermark', async () => {
      const before = db.prepare('SELECT * FROM continuity_summary_human WHERE session_id=?').get(structural.id);
      loader.remove('self-improved'); entryRemoved = true; await closeDone.promise; assert.equal(closed, true);
      closed = false; closeDone = deferred();
      const nextChild = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('recreated native continuity fiber unavailable')); }, 10000);
        const off = root.on('internal/status', fiber => { if (Object.hasOwn(fiber.inject ?? {}, 'sessionProjections')) { clearTimeout(timer); off(); resolve(fiber); } });
      });
      await loader.create({ id: 'self-improved', name: './index.js', config }); entryRemoved = false; await loader.await(); await (await nextChild).await(); entry = loader.resolve('self-improved');
      assert.equal(providerCalls, 130, 'main reconstruction itself never drives provider');
      assert.deepEqual(db.prepare('SELECT * FROM continuity_summary_human WHERE session_id=?').get(structural.id), before);
      const priorObservations = observed.get(structural.id) ?? 0; boundary(structural);
      for (let turn = 0; turn < 4; turn++) await new Promise(resolve => setImmediate(resolve));
      assert.equal(observed.get(structural.id) ?? 0, priorObservations, 'restart requires fresh admission even for structural source reads');
      assert.equal(providerCalls, 130, 'map/process-local lifecycle reset cannot regain old authority');
      user(structural, 'Another new own human instruction after reconstruction.'); const fresh = waitDrops(structural, 2); boundary(structural); await fresh(); assert.equal(providerCalls, 131);
      const repeat = waitDrops(structural, 1); boundary(structural); await repeat(); assert.equal(providerCalls, 131);
      loader.remove('self-improved'); entryRemoved = true; await closeDone.promise; assert.equal(closed, true);
    });
  } else {
  async function heldCase(name, patch, assertFence) {
    const s = newSession(name); user(s); const ready = deferred(), release = deferred(); let signal;
    handler = async function*(o) { signal = o.signal; providerHeld = true; ready.resolve(); try { await release.promise; yield* successful(o); } finally { providerHeld = false; } };
    const settled = waitDrops(s, 2); boundary(s); await ready.promise; const oldGeneration = db.prepare('SELECT generation FROM continuity_summary_policy WHERE id=1').get().generation;
    await update(next => patch(next, s)); assert.equal(signal.aborted, true); assert.ok(db.prepare('SELECT generation FROM continuity_summary_policy WHERE id=1').get().generation > oldGeneration);
    assertFence(s); release.resolve(); await settled(); assert.equal(completedFor(s), 0); assert.equal(handoffsFor(s), 0); assert.equal(closed, false);
    return s;
  }
  await check('summary-only pause synchronously cancels held provider/durable body epoch while structural progress stays intact', async () => {
    await heldCase('body-pause', next => { next.continuity.summaryEnabled = false; }, s => { assert.equal(pendingFor(s), 1); assert.ok(db.prepare('SELECT envelope FROM continuity_checkpoint WHERE session_id=?').get(s.id)); assert.equal(db.prepare('SELECT allowed FROM continuity_summary_policy WHERE id=1').get().allowed, 0); });
    await update(next => { next.continuity.summaryEnabled = true; });
  });
  await check('session exclusion synchronously cancels held provider and structural source admission; no late summary commit', async () => {
    await heldCase('excluded', (next, s) => { next.continuity.excludedSessionIds = [s.id]; }, s => { assert.equal(pendingFor(s), 0); });
    await update(next => { next.continuity.excludedSessionIds = []; });
  });
  await check('project exclusion synchronously cancels held provider and revokes the matching durable policy epoch', async () => {
    await heldCase('excluded-project', (next, s) => {
      const row = db.prepare('SELECT project_id FROM continuity_policy WHERE session_id=?').get(s.id);
      assert.ok(row && typeof row.project_id === 'string', 'captured target has a current project policy row');
      next.continuity.excludedProjectIds = [row.project_id];
    }, s => { assert.equal(pendingFor(s), 0); });
    await update(next => { next.continuity.excludedProjectIds = []; });
  });
  await check('reordering project exclusions preserves the durable policy epoch while actual set changes advance it', async () => {
    const generation = () => db.prepare('SELECT generation,allowed FROM continuity_summary_policy WHERE id=1').get();
    const before = generation(); assert.equal(before.allowed, 1);
    const ids = ['pj-' + 'a'.repeat(32), 'pj-' + 'b'.repeat(32)];
    await update(next => { next.continuity.excludedProjectIds = ids; });
    const changed = generation(); assert.ok(changed.generation > before.generation);
    await update(next => { next.continuity.excludedProjectIds = [...ids].reverse(); });
    assert.deepEqual(generation(), changed, 'order-only edits must not increment the consent epoch');
    await update(next => { next.continuity.excludedProjectIds = []; });
    assert.ok(generation().generation > changed.generation, 'removing exclusions changes the policy fingerprint');
  });
  await check('route hot-update aborts old-route accepted provider and cannot acknowledge its late output', async () => {
    await heldCase('route', next => { next.extract.model = 'new-fixture-model'; }, s => { assert.equal(pendingFor(s), 1); });
    await update(next => { next.extract.model = 'fixture'; });
  });
  await check('master pause owns body abort and immediately revokes structural rows without new source reads', async () => {
    await heldCase('master-pause', next => { next.enabled = false; }, s => { assert.equal(pendingFor(s), 0); });
    await update(next => { next.enabled = true; });
  });
  await check('actual Loader unload aborts held provider but retains shared MemoryStore until noncooperative settlement', async () => {
    const s = newSession('unload'); user(s); const ready = deferred(), release = deferred(), aborted = deferred(); let signal;
    handler = async function*(o) { signal = o.signal; providerHeld = true; signal.addEventListener('abort', () => aborted.resolve(), { once: true }); ready.resolve(); try { await release.promise; yield* successful(o); } finally { providerHeld = false; } };
    const settled = waitDrops(s, 2); boundary(s); await ready.promise; loader.remove('self-improved'); entryRemoved = true;
    const disposal = loader.await(); await aborted.promise; assert.equal(signal.aborted, true); assert.equal(closed, false); assert.equal(providerHeld, true);
    release.resolve(); await settled(); await disposal;
    // Loader.await covers entry reconciliation, not every removed-fiber async
    // disposer. Observe the actual close rather than assuming that barrier.
    let closeTimer;
    try { await Promise.race([closeDone.promise, new Promise((_, reject) => { closeTimer = setTimeout(() => reject(new Error('owned shared-store close did not settle')), 10000); })]); }
    finally { clearTimeout(closeTimer); }
    assert.equal(closed, true); assert.equal(closedWhileHeld, false); assert.equal(completedFor(s), 0); assert.equal(handoffsFor(s), 0); assert.equal(pendingFor(s), 1, 'unload preserves structural progress');
  });
  }
  }
  }
  for (const [id, n] of observed) assert.equal(dropped.get(id), n, 'every acquired native lease disposed exactly once');
  console.log(`${passes} PASS / 0 FAIL; actual Loader/native observations/SQLite; synthetic adapter AND explicit isolated admission stub; NOT authenticated Host ingress evidence; fixture=${dir}`);
} finally {
  if (!entryRemoved && loader?.resolve('self-improved')) { loader.remove('self-improved'); await loader.await(); }
  db?.close(); MemoryStore.prototype.close = originalClose; registration(); await loaderFiber.dispose(); for (const fiber of fibers.reverse()) await fiber.dispose();
}
