// Focused actual Loader/main/SQLite/provider/Continue gate for the staged core.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, cp, symlink, readFile } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
export async function runAuthReceiptLoaderCandidate({ ctx, gateway, agent, prompt, request, runtime, nativeSession }) {
 const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
 const { Loader } = await native('cordis-plugin-loader');
 const { LlmRuntime, LlmAdapter, createUserMessage } = await native('dsh-llm');
 const dir = await mkdtemp(resolve('.tmp-import-lane/auth-receipt-loader-'));
 const pkg = join(dir, 'plugin'); await mkdir(pkg); await cp(resolve('lib'), join(pkg, 'lib'), { recursive: true }); await cp(resolve('package.json'), join(pkg, 'package.json'));
 const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8'));
 for (const name of new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)])) {
  const target = join(pkg, 'node_modules', name); await mkdir(dirname(target), { recursive: true });
  await symlink(join(name.startsWith('@deepseek-ai/') || name === 'zod' ? runtime : process.cwd(), 'node_modules', name), target);
 }
 ctx.provide('settings', { configure: () => () => {} }); ctx.provide('systemPrompt', { section: () => () => {} });
 ctx.provide('tools', { register: () => () => {} }); ctx.provide('commands', { register: () => () => {} });
 const llmFiber = ctx.plugin(LlmRuntime); await llmFiber.await();
 let calls = 0;
 class FixtureAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: 'Auth Loader fixture' }; }
  async *stream(options) { calls++; const body = JSON.parse(options.messages[0].content[0].text);
   assert(body.excerpts.every(excerpt => !excerpt.text.includes('unauthenticated automation')), 'provider must never receive prior forged user-shaped event');
   assert.equal(body.excerpts.length, 1, 'mounted provider input contains only exact authenticated human coordinate');
   yield { type: 'text-delta', index: 0, text: JSON.stringify({ excerpts: body.excerpts.length ? [{ seq: body.excerpts.at(-1).seq, quote: body.excerpts.at(-1).text.slice(0, 80) }] : [] }) };
   yield { type: 'finish', reason: { kind: 'stop' } };
  }
 }
 const unregister = ctx.llm.registerAdapter(['auth-loader-provider'], new FixtureAdapter());
 let loader;
 const loaderFiber = ctx.plugin({ name: 'auth-receipt-loader', apply(child) { loader = new Loader(child, { baseUrl: pathToFileURL(join(pkg, 'lib') + '/').href }); } }); await loaderFiber.await();
 const config = { enabled: true, debug: false, storageRoot: join(dir, 'store'), searchLimit: 5,
  continuity: { enabled: true, summaryEnabled: true, excludedSessionIds: [], excludedProjectIds: [] },
  modules: { capture: true, extract: false, consolidate: false, evolve: false, recall: false, tools: false },
  extract: { provider: 'auth-loader-provider', model: 'fixture' }, recall: { embedding: {} },
  consolidate: {}, evolve: { decay: {}, skillSynthesis: {} }, housekeeping: {}, review: { enabled: false },
  episodeLearning: { enabled: false, reviewEnabled: false, operationalRecallEnabled: false } };
 let db, entry;
 try {
  await loader.create({ id: 'auth-self-improved', name: './index.js', config }); await loader.await(); entry = loader.resolve('auth-self-improved'); assert(entry?.fiber);
  // Await concrete optional SDK initialization, not a timing claim.
  for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve));
  db = new DatabaseSync(join(config.storageRoot, 'memory.db'), { readOnly: true });
  const source = ctx.sessions.create('auth-loader-source', { meta: { cwd: '/synthetic/auth-loader-project' } });
  agent.id = source.id; agent.session = source;
  const unauth = source.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'host-shaped-but-unauthenticated' }, content: [{ type: 'text', text: 'unauthenticated automation' }] }), { surfaceOp: 'append' });
  source.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  for (let n = 0; n < 2; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 0, 'actual main refuses human-shaped native append without finalized Host receipt');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM continuity_jobs WHERE session_id=?').get(source.id).n), 0);
  const response = await request('session/prompt', { request: { sessionId: source.id, requestId: 'auth-loader-real-prompt', content: [{ type: 'text', text: 'Continue unfinished authenticated parser work.' }], mode: 'followup' } });
  assert.equal(response.result.ok, true, JSON.stringify(response));
  let disposeCount = 0, resolveDone;
  const completed = new Promise(resolve => { resolveDone = resolve; });
  const originalObserve = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
  ctx.sessionQuery.observeSession = async (...args) => { const lease = await originalObserve(...args); return { ...lease, [Symbol.dispose]() { lease[Symbol.dispose](); if (args[0] === source.id && ++disposeCount >= 2) resolveDone(); } }; };
  const timeout = setTimeout(() => resolveDone(), 10000);
  source.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } });
  await completed; clearTimeout(timeout); await new Promise(resolve => setImmediate(resolve)); ctx.sessionQuery.observeSession = originalObserve;
  assert.equal(calls, 1, 'actual main worker dispatches once after authenticated finalized exact append');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff WHERE session_id=?').get(source.id).n), 1, 'actual main commits bounded handoff');
  const awaitBoundary = async (session, turn, expectedDrops) => {
   let drops = 0, resolveDone;
   const done = new Promise(resolve => { resolveDone = resolve; });
   const before = ctx.sessionQuery.observeSession.bind(ctx.sessionQuery);
   ctx.sessionQuery.observeSession = async (...args) => { const lease = await before(...args); return { ...lease, [Symbol.dispose]() { lease[Symbol.dispose](); if (args[0] === session.id && ++drops >= expectedDrops) resolveDone(); } }; };
   const timer = setTimeout(resolveDone, 10000);
   try { session.append('turn/end', { turn, reason: { kind: 'interrupted' } }); await done; await new Promise(resolve => setImmediate(resolve)); assert(drops >= expectedDrops, 'accepted native leases must settle'); }
   finally { clearTimeout(timer); ctx.sessionQuery.observeSession = before; }
  };
  let nextConfig = structuredClone(config); nextConfig.continuity.summaryEnabled = false;
  await entry.update({ config: nextConfig }); await loader.await(); Object.assign(config, nextConfig);
  const structural = ctx.sessions.create('auth-loader-structural-only', { meta: { cwd: '/synthetic/auth-loader-project' } }); agent.id = structural.id; agent.session = structural;
  assert.equal((await request('session/prompt', { request: { sessionId: structural.id, requestId: 'auth-structural-only', content: [{ type: 'text', text: 'Structural continuity without provider consent.' }], mode: 'followup' } })).result.ok, true);
  await awaitBoundary(structural, 1, 1);
  assert.equal(calls, 1, 'summary-off authenticated structural capture invokes no provider');
  const oldJob = db.prepare('SELECT id,cut FROM continuity_jobs WHERE session_id=?').get(structural.id); assert(oldJob, 'summary-off fresh authenticated prompt creates structural job');
  nextConfig = structuredClone(config); nextConfig.continuity.summaryEnabled = true;
  await entry.update({ config: nextConfig }); await loader.await(); Object.assign(config, nextConfig);
  structural.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } });
  for (let n = 0; n < 2; n++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1, 'summary false->true does not spend prior authenticated boundary');
  assert.equal((await request('session/prompt', { request: { sessionId: structural.id, requestId: 'auth-new-summary-consent', content: [{ type: 'text', text: 'Fresh authenticated unfinished parser work after consent.' }], mode: 'followup' } })).result.ok, true);
  await awaitBoundary(structural, 3, 2);
  assert.equal(calls, 2, 'new authenticated job bypasses stale older structural job');
  assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(oldJob.id), undefined, 'old unauthorized backlog is not leased/acknowledged');
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff WHERE session_id=?').get(structural.id).n), 1);
  const target = ctx.sessions.create('auth-loader-target', { meta: { cwd: '/synthetic/auth-loader-project' } });
  const oldDescriptor = gateway.resolveDescriptor, oldReceiver = gateway.resolveReceiverContext;
  gateway.resolveDescriptor = (namespace, method, endpoint) => namespace !== 'selfImproved' ? oldDescriptor(namespace, method, endpoint) : ({ service: 'selfImprovedMemoryUi', namespace, method, invocation: { kind: 'direct' }, cancellation: { parameter: 'signal' }, result: { mode: 'src-json' }, parameters: (method === 'continuityStatus' ? ['targetSessionId'] : method === 'prepareContinue' ? ['targetSessionId', 'jobId'] : ['targetSessionId', 'jobId', 'authorization']).map(wire => ({ wire, source: 'json', codec: { mode: 'src-json' } })) });
  gateway.resolveReceiverContext = async (descriptor, args, endpoint) => descriptor.namespace === 'selfImproved' ? ctx : oldReceiver(descriptor, args, endpoint);
  const inventory = await request('selfImproved/continuityStatus', { targetSessionId: target.id }); assert.equal(inventory.result.ok, true, JSON.stringify(inventory));
  const offered = inventory.result.value.offers.find(offer => offer.sessionId === source.id || offer.sourceSessionId === source.id); assert(offered, JSON.stringify(inventory));
  const jobId = offered.jobId;
  const staged = await request('selfImproved/prepareContinue', { targetSessionId: target.id, jobId }); assert.equal(staged.result.ok, true, JSON.stringify(staged));
  const continued = await request('selfImproved/continueSession', { targetSessionId: target.id, jobId, authorization: { token: staged.result.value.token } }); assert.equal(continued.result.ok, true, JSON.stringify(continued)); assert(continued.result.value);
  await assert.rejects(gateway.invoke({ namespace: 'selfImproved', method: 'prepareContinue', args: { targetSessionId: target.id, jobId }, peer: ctx.connection.operator }), /Host-authenticated/);
  const replay = await request('selfImproved/continueSession', { targetSessionId: target.id, jobId, authorization: { token: staged.result.value.token } }); assert.equal(replay.result.ok, false);
  console.log('PASS actual Loader/main native capture -> SQLite human boundary -> real bounded worker -> handoff -> authenticated Continue; no-receipt append/direct invoke/replay denied.');
 } finally { db?.close(); if (entry) { loader.remove('auth-self-improved'); await loader.await(); } unregister(); await llmFiber.dispose(); await loaderFiber.dispose(); }
}
