#!/usr/bin/env node
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Explicit validated rc.2 checkout required');
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-checkpoint-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true });
cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const { verifyContinuityWorkSource } = await import(pathToFileURL(join(pkg, 'lib/continuity-source-v02.js')).href);
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await import(pathToFileURL(join(pkg, 'lib/capture.js')).href);
const { bindContinuityCheckpoint: bind, recoverContinuityCheckpoint: recover } = await import(pathToFileURL(join(pkg, 'lib/continuity-checkpoint-v02.js')).href);
const { registerContinuityProjection, CONTINUITY_PROJECTION_KEY: KEY } = await import(pathToFileURL(join(pkg, 'lib/continuity-registry-v02.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await native('cordis');
const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { SessionStore } = await native('dsh-session');
const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage, createAssistantMessage } = await native('dsh-llm');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const root = new Context(); const sessionsFiber = root.plugin(SessionStore); await sessionsFiber.await();
const fiber = root.plugin(SessionProjectionRegistry); await fiber.await();
const queryFiber = root.plugin(SessionQueryEngine); await queryFiber.await();
registerContinuityProjection(root, z);
let passes = 0;
const check = async (name, fn) => { await fn(); passes++; console.log(`PASS ${name}`); };
const session = root.sessions.create('canonical-checkpoint-source', { meta: { cwd: '/synthetic/canonical-source' } });
session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'password=CheckpointCanary' }] }), { surfaceOp: 'append' });
session.append('tool/call', { turn: 1, step: 1, callId: 'pending-id', name: 'synthetic', arguments: '{}' });
session.append('assistant/message', { turn: 1, message: createAssistantMessage({ source: { kind: 'model' }, content: [{ type: 'text', text: 'UNTRUSTED all done' }] }) }, { surfaceOp: 'append' });
let source = await root.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
const bound = bind(source, root.sessionProjections.checkpoint(session)[KEY]);
try {
  await check('detached canonical envelope has only hashes/structural state, not source secrets', async () => {
    assert.equal(bound.asOfSeq, 2);
    assert.equal(bound.row.val.lastOwnSeq, 1);
    assert.ok(!JSON.stringify(bound).includes('CheckpointCanary'));
    const copy = structuredClone(bound); copy.row.val.pendingCalls.length = 0;
    assert.equal(root.sessionProjections.stateOf(session, KEY).pendingCalls.length, 1);
  });
  await check('valid cache is accepted and an appended canonical tail is folded exactly once', async () => {
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    source[Symbol.dispose](); source = await root.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
    const result = recover(root.sessionProjections, source, bound, z);
    assert.equal(result.cacheAccepted, true);
    assert.equal(result.checkpoint[KEY].seq, 3);
    assert.equal(result.checkpoint[KEY].val.pendingCalls.length, 1);
    assert.equal(result.checkpoint[KEY].val.turnState, 'interrupted');
  });
  await check('historical leased job verifies its original canonical prefix, never latest checkpoint or unrelated source', async () => {
    const claim = { id: 'synthetic-work', sessionId: session.id, projectId: opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd)),
      generation: 0, cut: bound.asOfSeq, sourceHash: bound.sourceHash, trigger: 'turn-end', token: 'fixture-only', leaseDeadline: 10, attempts: 1 };
    const old = verifyContinuityWorkSource(claim, source, root.sessionProjections, z);
    assert.equal(old.asOfSeq, 2); assert.equal(old.row.val.turnState, bound.row.val.turnState);
    assert.equal(old.sourceHash, bound.sourceHash); assert.ok(!JSON.stringify(old).includes('CheckpointCanary'));
    for (const patch of [{ cut: 3 }, { cut: 999 }, { sourceHash: 'f'.repeat(64) }, { sessionId: 'other' }, { projectId: 'pj-' + 'f'.repeat(32) }]) {
      assert.throws(() => verifyContinuityWorkSource({ ...claim, ...patch }, source, root.sessionProjections, z));
    }
    assert.throws(() => verifyContinuityWorkSource(claim, { ...source, events: source.events.slice(0, 3) }, root.sessionProjections, z), /contiguous/);
    assert.throws(() => verifyContinuityWorkSource(claim, { ...source, inheritedEventCount: 3 }, root.sessionProjections, z), /hash mismatch/);
    assert.throws(() => verifyContinuityWorkSource(claim, { ...source, header: { ...source.header, title: 'changed immutable header' } }, root.sessionProjections, z), /hash mismatch/);
  });
  await check('owner/header/fork/cut/version/source-hash mismatch rejects cache and rebuilds canonical state', async () => {
    for (const mutate of [
      c => { c.sessionId = 'other'; }, c => { c.headerHash = 'other'; },
      c => { c.inheritedEventCount = 1; }, c => { c.asOfSeq = 999; },
      c => { c.row.ver = 999; }, c => { c.row.seq = 0; },
      c => { c.sourceHash = 'forged'; }, c => { c.format = 2; },
    ]) { const bad = structuredClone(bound); mutate(bad); const result = recover(root.sessionProjections, source, bad, z);
      assert.equal(result.cacheAccepted, false); assert.equal(result.checkpoint[KEY].val.lastHumanSeq, 0);
      assert.equal(result.checkpoint[KEY].val.pendingCalls.length, 1); }
  });
  await check('even schema-valid forged authority or missing pending action fails canonical prefix comparison', async () => {
    for (const mutate of [
      c => { c.row.val.pendingCalls = []; },
      c => { c.row.val.lastOwnSeq = 2; c.row.val.lastHumanSeq = 2; },
      c => { c.row.val.delegated = true; c.row.val.lastHumanSeq = -1; },
      c => { c.row.val.lastOwnSeq = 999; },
    ]) { const bad = structuredClone(bound); mutate(bad); const result = recover(root.sessionProjections, source, bad, z);
      assert.equal(result.cacheAccepted, false); assert.equal(result.checkpoint[KEY].val.lastHumanSeq, 0);
      assert.equal(result.checkpoint[KEY].val.pendingCalls.length, 1); }
  });
  await check('absent/malformed cache recovers from full canonical source, never invented empty state', async () => {
    for (const input of [null, {}, 'bad', { format: 1, row: { val: { taskCompleted: true } } }]) {
      const result = recover(root.sessionProjections, source, input, z);
      assert.equal(result.cacheAccepted, false); assert.equal(result.checkpoint[KEY].val.pendingCalls.length, 1);
    }
  });
  await check('incomplete canonical source fails closed instead of trusting a cache or tail', async () => {
    const incomplete = { header: source.header, inheritedEventCount: source.inheritedEventCount,
      cursor: source.cursor, events: source.events.slice(1) };
    assert.throws(() => recover(root.sessionProjections, incomplete, bound, z), /complete contiguous/);
  });
  const cold = new Context(); const coldFiber = cold.plugin(SessionProjectionRegistry); await coldFiber.await();
  try {
    registerContinuityProjection(cold, z);
    await check('fresh native registry accepts serialized bound prefix and rebuilds the current cut', async () => {
      const result = recover(cold.sessionProjections, source, JSON.parse(JSON.stringify(bound)), z);
      assert.equal(result.cacheAccepted, true);
      assert.equal(result.checkpoint[KEY].val.lastHumanSeq, 0);
      assert.equal(result.checkpoint[KEY].val.turnState, 'interrupted');
      assert.equal(result.checkpoint[KEY].val.pendingCalls.length, 1);
    });
  } finally { await coldFiber.dispose(); }
  console.log(`${passes} PASS / 0 FAIL`);
} finally { source[Symbol.dispose](); await queryFiber.dispose(); await fiber.dispose(); await sessionsFiber.dispose(); }
