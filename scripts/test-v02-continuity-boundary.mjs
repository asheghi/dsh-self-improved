#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Explicit validated rc.2 checkout required');
const repo = fileURLToPath(new URL('../', import.meta.url)); mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-boundary-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { MemoryStore } = await own('storage'); const { ContinuityStoreV02 } = await own('continuity-store-v02');
const { mountContinuityRuntime } = await own('continuity-runtime-v02');
const { registerContinuityProjection } = await own('continuity-registry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const root = new Context(); const sf = root.plugin(SessionStore); await sf.await();
const pf = root.plugin(SessionProjectionRegistry); await pf.await(); registerContinuityProjection(root, z);
const qf = root.plugin(SessionQueryEngine); await qf.await();
const store = new MemoryStore(join(pkg, 'data')); const lane = new ContinuityStoreV02(store, z);
let bridge, held; let leaseDrops = 0;
const observedQuery = { async observeSession(id, options) {
  const observation = await root.sessionQuery.observeSession(id, options);
  const current = held; held = undefined;
  if (!current) return observation;
  current.ready(); await current.gate;
  return { ...observation, [Symbol.dispose]() { leaseDrops++; observation[Symbol.dispose](); } };
} };
function Runtime(ctx) { bridge = mountContinuityRuntime(ctx, lane, root.sessionProjections, z, observedQuery, () => true); }
const rf = root.plugin(Runtime); await rf.await();
const session = root.sessions.create('native-boundary', { meta: { cwd: '/synthetic/boundary-project' } });
const project = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd));
let passes = 0;
const check = async (name, fn) => { await fn(); passes++; console.log(`PASS ${name}`); };
const end = () => session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
try {
  await check('inert bridge boot ignores committed native boundaries', async () => {
    session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'BOUNDARY-PRIVATE-CANARY' }] }), { surfaceOp: 'append' });
    end(); await bridge.flush(); assert.equal(lane.listPending(project).length, 0);
  });
  await check('enabled real native committed boundary automatically checkpoints/enqueues without manual owner call', async () => {
    bridge.sync(true); end(); await bridge.flush();
    assert.equal(lane.listPending(project).length, 1);
    const saved = lane.readCheckpoint(session.id, project); assert.equal(saved.row.val.lastHumanSeq, 0);
    assert.equal(saved.asOfSeq, session.seq - 1); assert.ok(!JSON.stringify(saved).includes('BOUNDARY-PRIVATE-CANARY'));
  });
  await check('privacy pause cancels/drops all admitted work and paused events create no ghost', async () => {
    bridge.sync(false); const policy = lane.readPolicy(session.id);
    assert.equal(policy.allowed, false); assert.equal(lane.listPending(project).length, 0);
    assert.equal(lane.readCheckpoint(session.id, project), null);
    end(); await bridge.flush(); assert.equal(lane.listPending(project).length, 0);
    bridge.sync(false); assert.equal(lane.readPolicy(session.id).generation, policy.generation);
  });
  await check('explicit resume captures a fresh native cut only on a later boundary', async () => {
    bridge.sync(true); assert.equal(lane.listPending(project).length, 0);
    end(); await bridge.flush(); assert.equal(lane.listPending(project).length, 1);
    assert.equal(bridge.failures(), 0);
  });
  await check('held native observation spanning rapid pause/resume cannot refresh new generation or resurrect work', async () => {
    let ready, release;
    const acquired = new Promise(resolve => { ready = resolve; });
    const gate = new Promise(resolve => { release = resolve; });
    held = { ready, gate }; const oldGeneration = lane.readPolicy(session.id).generation;
    end(); await acquired;
    bridge.sync(false); bridge.sync(true);
    assert.ok(lane.readPolicy(session.id).generation > oldGeneration);
    release(); await bridge.flush();
    assert.equal(leaseDrops, 1); assert.equal(lane.listPending(project).length, 0);
    assert.equal(lane.readCheckpoint(session.id, project), null);
    end(); await bridge.flush(); assert.equal(lane.listPending(project).length, 1);
    assert.equal(bridge.failures(), 0);
  });
  await check('actual effect disposal stops observers, preserves committed progress and refuses late sync', async () => {
    await rf.dispose(); const saved = lane.readCheckpoint(session.id, project);
    bridge.sync(true); end(); await bridge.flush();
    assert.deepEqual(lane.readCheckpoint(session.id, project), saved);
    assert.equal(lane.listPending(project).length, 1);
  });
  console.log(`${passes} PASS / 0 FAIL; private fixture=${pkg}`);
} finally { bridge.dispose(); await qf.dispose(); await pf.dispose(); await sf.dispose(); store.close(); }
