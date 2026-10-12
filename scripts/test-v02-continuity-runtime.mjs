#!/usr/bin/env node
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const repo = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Set an explicit validated DSH_RUNTIME_RC2 checkout; no machine-specific default');
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await native('cordis');
const { Loader } = await native('cordis-plugin-loader');
const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { SessionStore } = await native('dsh-session');
const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm');
const { CONTINUITY_PROJECTION_KEY: KEY } = await import('../lib/continuity-registry-v02.js');
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const dir = mkdtempSync(join(repo, '.tmp-import-lane/continuity-runtime-'));
const pkg = join(dir, 'plugin');
mkdirSync(join(pkg, 'node_modules/@deepseek-ai'), { recursive: true });
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true });
cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
for (const peer of Object.keys(manifest.peerDependencies)) symlinkSync(join(runtime, 'node_modules', peer), join(pkg, 'node_modules', peer));
for (const dep of Object.keys(manifest.dependencies)) {
  const from = dep === 'zod' ? join(runtime, 'node_modules', dep) : join(repo, 'node_modules', dep);
  mkdirSync(dirname(join(pkg, 'node_modules', dep)), { recursive: true });
  symlinkSync(from, join(pkg, 'node_modules', dep));
}
const config = {
  enabled: false, debug: false, storageRoot: join(dir, 'store'), searchLimit: 5,
  modules: { capture: true, extract: false, consolidate: false, evolve: false, recall: false, tools: false },
  extract: {},
  recall: { embedding: {} }, consolidate: {}, evolve: { decay: {}, skillSynthesis: {} },
  housekeeping: {}, review: { enabled: false }, episodeLearning: { enabled: false, reviewEnabled: false, operationalRecallEnabled: false },
};
let passes = 0;
const check = (label, fn) => { fn(); console.log(`PASS ${label}`); passes++; };
const root = new Context();
root.provide('settings', { configure: () => () => {} });
root.provide('systemPrompt', { section: () => {} });
const sessionsFiber = root.plugin(SessionStore); await sessionsFiber.await();
const queryFiber = root.plugin(SessionQueryEngine); await queryFiber.await();
let leasedDone;
const observeNative = root.sessionQuery.observeSession.bind(root.sessionQuery);
root.sessionQuery.observeSession = async (...args) => {
  const observation = await observeNative(...args);
  return { ...observation, [Symbol.dispose]() { observation[Symbol.dispose](); leasedDone?.(); } };
};
let providerCalls = 0;
root.provide('llm', { async *stream() { providerCalls++; throw new Error('unexpected continuity provider call'); } });
root.provide('tools', { register: () => () => {} });
root.provide('commands', { register: () => () => {} });
let loader;
let entryRemoved = false;
const registryFiber = root.plugin(SessionProjectionRegistry);
await registryFiber.await();
const loaderFiber = root.plugin({ name: 'continuity-runtime-loader', apply: ctx => {
  loader = new Loader(ctx, { baseUrl: pathToFileURL(join(pkg, 'lib') + '/').href });
} });
await loaderFiber.await();
// Event-driven startup observation, not polling/sleep. Captures the genuine
// optional inject fiber and awaits its public lifecycle completion.
const childReady = new Promise((resolve, reject) => {
  const deadline = setTimeout(() => { off(); reject(new Error('optional continuity fiber did not start')); }, 10_000);
  const off = root.on('internal/status', fiber => {
    if (Object.hasOwn(fiber.inject ?? {}, 'sessionProjections')) {
      clearTimeout(deadline); off(); resolve(fiber);
    }
  });
});
try {
  await loader.create({ id: 'self-improved', name: './index.js', config });
  await loader.await();
  await (await childReady).await();
  const registry = root.sessionProjections;
  const session = root.sessions.create('continuity-runtime-native', { meta: { cwd: '/synthetic/main-continuity-project' } });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic unfinished task' }] }), { surfaceOp: 'append' });
  check('actual Loader boot with master disabled does not register continuity', () => {
    assert.equal(registry.stateOf(session, KEY), undefined);
  });
  const entry = loader.resolve('self-improved');
  assert.ok(entry);
  const update = async patch => {
    const next = structuredClone(config); patch(next);
    // The genuine Loader method is awaited. Its volatile-update event is
    // owner-filtered to this entry; a root listener cannot observe its ack.
    await entry.update({ config: next });
    await loader.await();
    Object.assign(config, next);
  };
  await update(next => { next.enabled = true; });
  check('actual volatile master resume registers and reconstructs native human seq0', () => {
    assert.equal(registry.stateOf(session, KEY).lastHumanSeq, 0);
  });
  await update(next => { next.enabled = false; });
  check('master pause removes capability and cached cells', () => {
    assert.equal(registry.stateOf(session, KEY), undefined);
    assert.equal(Object.hasOwn(registry.checkpoint(session), KEY), false);
  });
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'new native input while plugin paused' }] }), { surfaceOp: 'append' });
  check('paused committed native event cannot recreate registration', () => { assert.equal(registry.stateOf(session, KEY), undefined); });
  await update(next => { next.enabled = true; });
  check('resume refolds canonical history without task-success inference or worker wake', () => {
    assert.equal(registry.stateOf(session, KEY).lastHumanSeq, 1);
    assert.equal(registry.stateOf(session, KEY).turnState, 'unknown');
    assert.equal(providerCalls, 0);
  });
  await update(next => { next.modules.capture = false; });
  check('capture-module disable independently drops continuity', () => { assert.equal(registry.stateOf(session, KEY), undefined); });
  await update(next => { next.modules.capture = true; });
  check('capture-module reenable re-registers exactly one owned unit', () => { assert.equal(registry.stateOf(session, KEY).lastHumanSeq, 1); });
  const db = new DatabaseSync(join(config.storageRoot, 'memory.db'), { readOnly: true });
  const pendingCount = () => Number(db.prepare("SELECT COUNT(*) AS n FROM continuity_jobs WHERE status='pending'").get().n);
  const boundary = async () => {
    let timer;
    const done = new Promise((resolve, reject) => {
      leasedDone = resolve; timer = setTimeout(() => reject(new Error('main continuity source lease did not settle')), 10_000);
    });
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    try { await done; } finally { clearTimeout(timer); leasedDone = undefined; }
  };
  check('main continuity source/body job consent defaults off despite structural capability', () => { assert.equal(pendingCount(), 0); });
  await update(next => { next.continuity = { enabled: true, excludedSessionIds: [], excludedProjectIds: [] }; });
  await boundary();
  check('explicit volatile continuity consent mounts actual native boundary owner and persists reference', () => {
    assert.equal(pendingCount(), 1); assert.equal(providerCalls, 0);
  });
  await update(next => { next.continuity.excludedSessionIds = [session.id]; });
  check('session exclusion immediately cancels prior work without another boundary', () => {
    assert.equal(pendingCount(), 0); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM continuity_checkpoint').get().n, 0);
  });
  await update(next => { next.continuity.excludedSessionIds = []; }); await boundary();
  const projectId = db.prepare('SELECT project_id FROM continuity_policy WHERE session_id=?').get(session.id).project_id;
  await update(next => { next.continuity.excludedProjectIds = [projectId]; });
  check('project exclusion immediately cancels prior work and checkpoint', () => { assert.equal(pendingCount(), 0); });
  await update(next => { next.continuity.excludedProjectIds = []; }); await boundary();
  check('explicit scope reenable needs fresh boundary and never resurrects cancelled identity', () => { assert.equal(pendingCount(), 1); });
  loader.remove('self-improved');
  entryRemoved = true;
  await loader.await();
  check('actual main-plugin unload drops capability and preserves committed continuity references', () => {
    assert.equal(registry.stateOf(session, KEY), undefined);
    assert.equal(providerCalls, 0); assert.equal(pendingCount(), 1);
  });
  db.close();
  const { loadContinuitySchema } = await import(pathToFileURL(join(pkg, 'lib/continuity-registry-v02.js')).href);
  const privateManifestPath = join(pkg, 'package.json');
  const privateManifest = JSON.parse(readFileSync(privateManifestPath, 'utf8'));
  privateManifest.dependencies.zod = '4.6.4';
  writeFileSync(privateManifestPath, JSON.stringify(privateManifest));
  await assert.rejects(loadContinuitySchema(), /exact declared Zod4/);
  passes++; console.log('PASS runtime schema loader rejects an incompatible PRIVATE declared dependency without an SDK fallback');
  console.log(`${passes} PASS / 0 FAIL; private fixture=${dir}`);
} finally {
  if (!entryRemoved) { loader.remove('self-improved'); await loader.await(); }
  await loaderFiber.dispose(); await registryFiber.dispose(); await queryFiber.dispose(); await sessionsFiber.dispose();
}
