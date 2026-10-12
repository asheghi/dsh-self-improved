#!/usr/bin/env node
// Pure completed-reference lineage gate with actual native observations. No policy/model/Continue actions.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no install/profile/fallback');
const repo = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection'])
  assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.0-rc.2');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.6.5');
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-reference-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { verifyContinuitySourceReference: verify, verifyContinuityWorkSource: workerVerify } = await own('continuity-source-v02');
const { bindContinuityCheckpoint: bind } = await own('continuity-checkpoint-v02');
const { registerContinuityProjection, CONTINUITY_PROJECTION_KEY: KEY } = await own('continuity-registry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const ctx = new Context(); const sf = ctx.plugin(SessionStore); await sf.await();
const pf = ctx.plugin(SessionProjectionRegistry); await pf.await(); registerContinuityProjection(ctx, z);
const qf = ctx.plugin(SessionQueryEngine); await qf.await();
const cwd = '/synthetic/reference'; const p = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
const session = ctx.sessions.create('reference-source', { meta: { cwd } });
const human = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
session.append('user/message', human('SOURCE-CANARY'), { surfaceOp: 'append' });
session.append('tool/call', { turn: 1, step: 1, callId: 'uncertain-call', name: 'synthetic', arguments: '{}' });
let source = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
const old = bind(source, ctx.sessionProjections.checkpoint(session)[KEY]);
const ref = { sessionId: session.id, projectId: p, cut: old.asOfSeq, sourceHash: old.sourceHash };
let count = 0; const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
const forSession = async s => {
  const obs = await ctx.sessionQuery.observeSession(s.id, { projectionMode: 'none' });
  const cp = bind(obs, ctx.sessionProjections.checkpoint(s)[KEY]);
  return { obs, ref: { sessionId: s.id, projectId: p, cut: cp.asOfSeq, sourceHash: cp.sourceHash } };
};
try {
  await check('four-field completed reference needs no job, token or lease and returns only detached structural cut', () => {
    const out = verify(ref, source, ctx.sessionProjections, z);
    assert.equal(out.asOfSeq, 1); assert.equal(out.row.val.pendingCalls.length, 1);
    assert.ok(!JSON.stringify(out).includes('SOURCE-CANARY')); assert.equal(out.row.val.lastHumanSeq, 0);
    out.row.val.pendingCalls.length = 0; assert.equal(ctx.sessionProjections.stateOf(session, KEY).pendingCalls.length, 1);
    assert.deepEqual(workerVerify({ ...ref, token: 'not-authority', generation: 999 }, source, ctx.sessionProjections, z), old);
  });
  await check('strict reference DTO refuses extra authority fields and parses changing getters only once', () => {
    for (const bad of [{ ...ref, token: 'fake' }, { ...ref, permission: true }, { ...ref, completedTask: true }, { ...ref, cut: NaN }, { ...ref, cut: 0.5 }, { ...ref, sourceHash: 'bad' }, { ...ref, sessionId: '' }])
      assert.throws(() => verify(bad, source, ctx.sessionProjections, z));
    let reads = 0; const changing = { ...ref }; Object.defineProperty(changing, 'sourceHash', { enumerable: true, get() { reads++; return reads === 1 ? ref.sourceHash : 'f'.repeat(64); } });
    Object.defineProperty(changing, 'toJSON', { value() { throw Error('must not serialize caller'); } });
    assert.equal(verify(changing, source, ctx.sessionProjections, z).sourceHash, ref.sourceHash); assert.equal(reads, 1);
  });
  await check('appended native tail never changes selected historical prefix', async () => {
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    source[Symbol.dispose](); source = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
    assert.deepEqual(verify(ref, source, ctx.sessionProjections, z), old);
    assert.throws(() => verify({ ...ref, cut: source.cursor }, source, ctx.sessionProjections, z), /hash mismatch/);
  });
  await check('ownership, old header, inherited floor, complete source and mutated prefix fail closed', () => {
    for (const patch of [{ sessionId: 'foreign' }, { projectId: 'pj-' + 'f'.repeat(32) }, { cut: 999 }, { sourceHash: 'f'.repeat(64) }]) assert.throws(() => verify({ ...ref, ...patch }, source, ctx.sessionProjections, z));
    assert.throws(() => verify(ref, { ...source, header: { ...source.header, createdAt: source.header.createdAt + 1 } }, ctx.sessionProjections, z), /hash mismatch/);
    assert.throws(() => verify(ref, { ...source, inheritedEventCount: 1 }, ctx.sessionProjections, z), /hash mismatch/);
    assert.throws(() => verify(ref, { ...source, events: source.events.slice(1) }, ctx.sessionProjections, z), /contiguous/);
    const events = structuredClone(source.events); events[0].data.content[0].text = 'mutated';
    assert.throws(() => verify(ref, { ...source, events }, ctx.sessionProjections, z), /hash mismatch/);
  });
  await check('actual native delegated and missing-cwd sources never qualify', async () => {
    for (const [id, meta] of [['reference-delegated', { cwd, origin: 'subagent', delegationDepth: 1 }], ['reference-no-cwd', {}]]) {
      const s = ctx.sessions.create(id, { meta }); s.append('user/message', human('own'), { surfaceOp: 'append' });
      const { obs, ref: r } = await forSession(s);
      try { assert.throws(() => verify(r, obs, ctx.sessionProjections, z), /ownership mismatch/); } finally { obs[Symbol.dispose](); }
    }
  });
  await check('actual native parent-linked forks remain conservatively denied even after own human (known integration gap)', async () => {
    const fork = ctx.sessions.create('reference-parent-fork', { seed: source.events.slice(0, 1), inheritedEventCount: 1,
      meta: { cwd, parentSession: session.id, isSeeded: true } });
    for (const own of [false, true]) {
      if (own) fork.append('user/message', human('own fork instruction'), { surfaceOp: 'append' });
      const found = await forSession(fork);
      try { assert.throws(() => verify(found.ref, found.obs, ctx.sessionProjections, z), /ownership mismatch/); }
      finally { found.obs[Symbol.dispose](); }
    }
  });
  await check('native seeded inherited floor refuses inherited-only evidence; new own human qualifies (no parent lineage)', async () => {
    const fork = ctx.sessions.create('reference-seeded-floor', { seed: source.events.slice(0, 1), inheritedEventCount: 1,
      meta: { cwd, isSeeded: true } });
    let found = await forSession(fork);
    try { assert.throws(() => verify(found.ref, found.obs, ctx.sessionProjections, z), /own human/); } finally { found.obs[Symbol.dispose](); }
    fork.append('user/message', human('new own instruction'), { surfaceOp: 'append' }); found = await forSession(fork);
    try { const out = verify(found.ref, found.obs, ctx.sessionProjections, z); assert.ok(out.row.val.lastHumanSeq >= found.obs.inheritedEventCount);
      assert.throws(() => verify({ ...found.ref, cut: -1 }, found.obs, ctx.sessionProjections, z), /historical cut/);
    } finally { found.obs[Symbol.dispose](); }
  });
  await check('empty and injected-only native sources are not own-human continuation evidence', async () => {
    for (const injected of [false, true]) {
      const s = ctx.sessions.create('reference-nohuman-' + injected, { meta: { cwd } });
      if (injected) s.append('user/message', createUserMessage({ source: { kind: 'injected-context' }, content: [{ type: 'text', text: 'fabricated user authority' }] }), { surfaceOp: 'append' });
      const { obs, ref: r } = await forSession(s); try { assert.throws(() => verify(r, obs, ctx.sessionProjections, z), /own human/); } finally { obs[Symbol.dispose](); }
    }
  });
  console.log(`${count} PASS / 0 FAIL; private fixture=${pkg}; pure lineage only, no consent or Continue authority`);
} finally { source[Symbol.dispose](); await qf.dispose(); await pf.dispose(); await sf.dispose(); }
