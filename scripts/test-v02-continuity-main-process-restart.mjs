#!/usr/bin/env node
// Actual main plugin + native Session services across two private OS processes.
// Lifecycle/persistence evidence only; explicit synthetic admission below is
// NOT genuine Host HTTP authentication. Production default-deny is unchanged.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no runtime install/profile/fallback');
for (const name of ['dsh-session', 'dsh-session-persistence-jsonl', 'dsh-session-query', 'dsh-session-projection', 'dsh-llm']) {
  assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.0-rc.2');
}
const script = fileURLToPath(import.meta.url);
const repo = resolve(dirname(script), '..');
const mode = process.argv[2];
const fixture = process.argv[3];

if (!mode) {
  mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
  const root = mkdtempSync(join(repo, '.tmp-import-lane/continuity-main-process-restart-'));
  const pkg = join(root, 'plugin'); mkdirSync(pkg, { recursive: true });
  cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
  const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
  for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
    const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
    const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
  }
  const run = phase => {
    const child = spawnSync(process.execPath, [script, phase, root], {
      cwd: root, env: { ...process.env, DSH_RUNTIME_RC2: runtime }, encoding: 'utf8', timeout: 120000,
    });
    process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '');
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, `${phase} main-plugin child failed`);
    return child.pid;
  };
  const seedPid = run('seed');
  const verifyPid = run('verify');
  assert.notEqual(seedPid, verifyPid); assert.notEqual(seedPid, process.pid); assert.notEqual(verifyPid, process.pid);
  console.log(`PASS actual main-plugin structural state survives distinct OS processes (${seedPid}, ${verifyPid}); explicit synthetic admission only, NOT Host-authenticated ingress evidence; fixture=${root}`);
} else {
  assert.ok(['seed', 'verify'].includes(mode));
  const absoluteFixture = resolve(fixture);
  assert.ok(absoluteFixture.startsWith(join(repo, '.tmp-import-lane') + sep), 'fixture must stay under the private workspace lane');
  const pkg = join(absoluteFixture, 'plugin');
  const storageRoot = join(absoluteFixture, 'memory');
  const nativeRoot = join(absoluteFixture, 'native-source');
  mkdirSync(nativeRoot, { recursive: true });
  const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
  const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
  const { Context } = await native('cordis');
  const { Loader } = await native('cordis-plugin-loader');
  const { SessionStore } = await native('dsh-session');
  const { default: JsonlPersistence } = await native('dsh-session-persistence-jsonl');
  const { SessionQueryEngine } = await native('dsh-session-query');
  const { SessionProjectionRegistry } = await native('dsh-session-projection');
  const { LlmRuntime, LlmAdapter, createUserMessage } = await native('dsh-llm');
  const { MemoryStore } = await own('storage');

  const context = new Context(), fibers = [];
  // Deliberately isolated test admission, never a production verifier. Authority
  // is genuine-object/finalized/one-use and intentionally lost across processes.
  const fixtureReceipts = new WeakMap();
  const fixtureConnection = {
    consumeFinalizedPromptReceipt(receipt) {
      if (fixtureReceipts.get(receipt) !== 'finalized') return undefined;
      fixtureReceipts.delete(receipt); return receipt;
    },
    readAuthenticatedInvocationAdmission() { return undefined; },
  };
  context.provide('connection', fixtureConnection);
  const admitFixturePrompt = (session, text) => {
    const requestId = 'synthetic-main-process-restart-admission';
    const message = createUserMessage({ source: { kind: 'user', rpcId: requestId }, content: [{ type: 'text', text }] });
    const receipt = Object.freeze({ sessionId: session.id, messageId: message.id, requestId });
    fixtureReceipts.set(receipt, 'provisional'); context.emit('session/prompt-admission', { phase: 'provisional', receipt });
    session.append('user/message', message, { surfaceOp: 'append' });
    fixtureReceipts.set(receipt, 'finalized'); context.emit('session/prompt-admission', { phase: 'finalized', receipt });
    return receipt;
  };
  context.provide('settings', { configure: () => () => {} });
  context.provide('systemPrompt', { section: () => {} });
  context.provide('tools', { register: () => () => {} });
  context.provide('commands', { register: () => () => {} });
  const mount = async (plugin, config) => { const fiber = context.plugin(plugin, config); await fiber.await(); fibers.push(fiber); };
  await mount(SessionStore);
  if (mode === 'seed') {
    // Match the actual Loader integration order for live capture; native JSONL
    // is mounted after the event so the same source can be cold-read in verify.
    await mount(SessionQueryEngine); await mount(SessionProjectionRegistry); await mount(LlmRuntime);
  } else {
    await mount(SessionProjectionRegistry); await mount(JsonlPersistence, { root: nativeRoot, compression: 'none' });
    await mount(SessionQueryEngine); await mount(LlmRuntime);
  }

  let providerCalls = 0;
  class TripwireAdapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: 'Private restart tripwire' }; }
    async *stream() { providerCalls++; throw new Error('summary/provider call is forbidden in the restart fixture'); }
  }
  const adapter = context.llm.registerAdapter(['synthetic-main-process-restart'], new TripwireAdapter());
  const attempted = new Map(), observed = new Map(), dropped = new Map(); let dropWatch;
  const originalObserve = context.sessionQuery.observeSession.bind(context.sessionQuery);
  context.sessionQuery.observeSession = async (id, options) => {
    attempted.set(id, (attempted.get(id) ?? 0) + 1);
    const lease = await originalObserve(id, options); observed.set(id, (observed.get(id) ?? 0) + 1);
    return { ...lease, [Symbol.dispose]() {
      lease[Symbol.dispose](); dropped.set(id, (dropped.get(id) ?? 0) + 1); dropWatch?.(id);
    } };
  };
  const deferred = () => { let resolvePromise; const promise = new Promise(resolve => { resolvePromise = resolve; }); return { promise, resolve: resolvePromise }; };
  const waitDrops = (id, count) => {
    const target = (dropped.get(id) ?? 0) + count; let timer;
    const done = new Promise((resolvePromise, reject) => {
      timer = setTimeout(() => reject(new Error(`native source lease did not settle for ${id}; attempted=${attempted.get(id) ?? 0}, observed=${observed.get(id) ?? 0}, dropped=${dropped.get(id) ?? 0}, target=${target}`)), 10000);
      dropWatch = current => { if (current === id && (dropped.get(id) ?? 0) >= target) resolvePromise(); };
    });
    return async () => { try { await done; await new Promise(resolvePromise => setImmediate(resolvePromise)); } finally { clearTimeout(timer); dropWatch = undefined; } };
  };
  const persistNative = async id => {
    const observation = await context.sessionQuery.observeSession(id, { projectionMode: 'none' });
    let handle;
    try {
      handle = await context.sessionPersistence.create(observation.header, { inheritedEventCount: observation.inheritedEventCount });
      await handle.append(observation.events); await handle.flush();
      return { header: observation.header, events: observation.events };
    } finally { await handle?.close(); observation[Symbol.dispose](); }
  };
  const config = {
    enabled: true, debug: false, storageRoot, searchLimit: 5,
    continuity: { enabled: true, summaryEnabled: false, excludedSessionIds: [], excludedProjectIds: [] },
    modules: { capture: true, extract: false, consolidate: false, evolve: false, recall: false, tools: false },
    extract: { provider: 'synthetic-main-process-restart', model: 'fixture' }, recall: { embedding: {} },
    consolidate: {}, evolve: { decay: {}, skillSynthesis: {} }, housekeeping: {}, review: { enabled: false },
    episodeLearning: { enabled: false, reviewEnabled: false, operationalRecallEnabled: false },
  };

  let loader, loaderFiber, entry, db, entryRemoved = false, mainLoaded = false, storeClosed = false;
  const closeDone = deferred();
  const originalClose = MemoryStore.prototype.close;
  MemoryStore.prototype.close = function() {
    const result = originalClose.call(this); storeClosed = true; closeDone.resolve(); return result;
  };
  try {
    loaderFiber = context.plugin({ name: 'main-process-restart-loader', apply: ctx => { loader = new Loader(ctx, { baseUrl: pathToFileURL(join(pkg, 'lib') + '/').href }); } });
    await loaderFiber.await();
    const loadMainPlugin = async () => {
      const childReady = new Promise((resolvePromise, reject) => {
        const timer = setTimeout(() => { off(); reject(new Error('main-plugin continuity child was not ready')); }, 10000);
        const off = context.on('internal/status', fiber => {
          if (Object.hasOwn(fiber.inject ?? {}, 'sessionProjections')) { clearTimeout(timer); off(); resolvePromise(fiber); }
        });
      });
      await loader.create({ id: 'self-improved', name: './index.js', config }); await loader.await();
      await (await childReady).await(); entry = loader.resolve('self-improved'); assert.ok(entry?.fiber); mainLoaded = true;
    };
    const hasTable = name => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
    const policyFor = id => db.prepare('SELECT session_id,project_id,generation,allowed FROM continuity_policy WHERE session_id=?').get(id);
    const checkpointFor = id => db.prepare('SELECT session_id,project_id,generation,cut,source_hash,envelope FROM continuity_checkpoint WHERE session_id=?').get(id);
    const jobFor = id => db.prepare('SELECT id,session_id,project_id,generation,cut,source_hash,trigger,status FROM continuity_jobs WHERE session_id=?').get(id);
    const pendingFor = id => Number(db.prepare("SELECT COUNT(*) AS n FROM continuity_jobs WHERE session_id=? AND status='pending'").get(id).n);
    const check = (name, ok) => { assert.ok(ok, name); console.log(`PASS ${name}`); };

    const sessionId = 'main-process-restart-fixture';
    if (mode === 'seed') {
      await loadMainPlugin(); db = new DatabaseSync(join(storageRoot, 'memory.db'), { readOnly: true });
      const session = context.sessions.create(sessionId, { meta: { cwd: '/synthetic/main-process-restart' } });
      // A plain user-shaped append cannot authenticate this fixture session.
      session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Unauthenticated fixture history.' }] }), { surfaceOp: 'append' });
      session.append('turn/start', { turn: 1 });
      session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
      for (let turn = 0; turn < 4; turn++) await new Promise(resolvePromise => setImmediate(resolvePromise));
      check('user-shaped append without explicit fixture admission performs zero source reads/jobs',
        (attempted.get(sessionId) ?? 0) === 0 && pendingFor(sessionId) === 0);
      const receipt = admitFixturePrompt(session, 'Fixture-only unfinished task across a process restart.');
      session.append('turn/start', { turn: 2 });
      const settled = waitDrops(sessionId, 1);
      session.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } });
      await settled();
      await mount(JsonlPersistence, { root: nativeRoot, compression: 'none' });
      const native = await persistNative(sessionId);
      const policy = policyFor(sessionId), checkpoint = checkpointFor(sessionId), job = jobFor(sessionId);
      check('actual main plugin captures one structural checkpoint/job with summary off', !!policy && policy.allowed === 1 && !!checkpoint && job?.status === 'pending' && pendingFor(sessionId) === 1);
      check('private native JSONL source flushes and provider tripwire stays unused', native.events.length >= 2 && providerCalls === 0 && !hasTable('continuity_summary_policy'));
      writeFileSync(join(absoluteFixture, 'main-seed.json'), JSON.stringify({ sessionId, native, policy, checkpoint, job, receipt }));
      db.close(); db = undefined;
    } else {
      const saved = JSON.parse(readFileSync(join(absoluteFixture, 'main-seed.json'), 'utf8'));
      assert.equal(saved.sessionId, sessionId);
      const cold = await context.sessionQuery.observeSession(sessionId, { projectionMode: 'none' });
      try {
        const normalizedHeader = { ...saved.native.header, delegationDepth: saved.native.header.delegationDepth ?? 0 };
        const sameHeader = JSON.stringify(cold.header) === JSON.stringify(normalizedHeader);
        const sameEvents = JSON.stringify(cold.events) === JSON.stringify(saved.native.events);
        const liveCount = context.sessions.list().length;
        check('fresh process cold-observes the same header (including rc.2 default hydration) and events without publishing a live session',
          sameHeader && sameEvents && liveCount === 0);
      } finally { cold[Symbol.dispose](); }
      const readsBeforePluginBoot = observed.get(sessionId) ?? 0;
      await loadMainPlugin(); db = new DatabaseSync(join(storageRoot, 'memory.db'), { readOnly: true });
      check('main plugin boot does not scan/re-capture a cold session without a live event',
        (observed.get(sessionId) ?? 0) === readsBeforePluginBoot);
      check('serialized prior-process admission proof cannot authenticate after restart',
        fixtureConnection.consumeFinalizedPromptReceipt(saved.receipt) === undefined
        && fixtureConnection.readAuthenticatedInvocationAdmission(saved.receipt) === undefined);
      context.emit('session/prompt-admission', { phase: 'provisional', receipt: saved.receipt });
      context.emit('session/prompt-admission', { phase: 'finalized', receipt: saved.receipt });
      for (let turn = 0; turn < 4; turn++) await new Promise(resolvePromise => setImmediate(resolvePromise));
      check('replayed serialized proof never observes or re-captures cold source', (observed.get(sessionId) ?? 0) === readsBeforePluginBoot);
      const policy = policyFor(sessionId), checkpoint = checkpointFor(sessionId), job = jobFor(sessionId);
      check('main-plugin process restart preserves exact structural policy/checkpoint/pending job',
        JSON.stringify(policy) === JSON.stringify(saved.policy)
        && JSON.stringify(checkpoint) === JSON.stringify(saved.checkpoint)
        && JSON.stringify(job) === JSON.stringify(saved.job) && pendingFor(sessionId) === 1 && providerCalls === 0);
      const next = structuredClone(config); next.continuity.enabled = false;
      await entry.update({ config: next }); await loader.await();
      const denied = policyFor(sessionId), revokedJob = jobFor(sessionId);
      check('post-restart consent-off through actual main Loader denies policy and cancels queued source',
        denied.allowed === 0 && denied.generation > saved.policy.generation && revokedJob.status === 'cancelled'
        && pendingFor(sessionId) === 0 && checkpointFor(sessionId) === undefined && providerCalls === 0);
      db.close(); db = undefined;
    }
  } finally {
    db?.close();
    if (loader && entry && !entryRemoved) { loader.remove('self-improved'); entryRemoved = true; await loader.await(); }
    if (loader && mainLoaded && !storeClosed) {
      let timer;
      try { await Promise.race([closeDone.promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('main plugin store did not close under private Loader teardown')), 10000); })]); }
      finally { clearTimeout(timer); }
    }
    MemoryStore.prototype.close = originalClose; adapter();
    if (loaderFiber) await loaderFiber.dispose();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}
