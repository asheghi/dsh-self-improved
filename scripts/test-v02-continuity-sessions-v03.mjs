import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ContinuitySessionsV03 } from '../lib/continuity-sessions-v03.js';
import { opaqueProjectIdFromKey, projectKeyFromCwd } from '../lib/capture.js';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit pinned DSH_RUNTIME_RC2 required');
for (const name of ['cordis', 'dsh-session', 'dsh-session-query', 'dsh-session-projection']) {
  const version = JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version;
  assert.equal(version, name === 'cordis' ? '4.0.4' : '0.2.0-rc.2');
}
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const ctx = new Context(); const fibers = [];
let leases = 0, previews = 0, identityReads = 0, candidateReads = 0, passes = 0;
const check = async (name, fn) => { await fn(); assert.equal(leases, 0, 'all accepted native observations must be released'); passes++; console.log('PASS ' + name); };
try {
  for (const plugin of [SessionStore, SessionProjectionRegistry, SessionQueryEngine]) { const fiber = ctx.plugin(plugin); await fiber.await(); fibers.push(fiber); }
  const cwd = '/synthetic/sessions-takeover-project'; const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
  ctx.sessions.create('target', { meta: { cwd } }); ctx.sessions.create('source', { meta: { cwd } });
  ctx.sessions.create('foreign', { meta: { cwd: '/synthetic/foreign-project' } });
  ctx.sessions.create('delegated', { meta: { cwd, origin: 'subagent', delegationDepth: 1 } });
  const query = { async observeSession(id, options) {
    const lease = await ctx.sessionQuery.observeSession(id, options); leases++; let disposed = false;
    return { source: lease.source, header: lease.header, inheritedEventCount: lease.inheritedEventCount,
      events: lease.events, cursor: lease.cursor, [Symbol.dispose]() { if (!disposed) { disposed = true; leases--; lease[Symbol.dispose](); } } };
  } };
  let rows = [{ sessionId: 'source', projectId, hasUnfinishedWork: true, title: 'Synthetic unfinished work', workMetadata: { pendingCalls: 1, turnState: 'interrupted', rawBody: 'MUST-NOT-LEAK' } }];
  const owner = { listCandidates() { candidateReads++; return rows; }, readHandoffIdentity() { identityReads++; return { job: { id: '00000000-0000-0000-0000-000000000001' } }; } };
  const preview = { async resolve(request) { previews++; return { ...request, notes: [], uncertain: true, untrusted: true, orientationOnly: true }; } };
  let permitted = true;
  const gates = { hostCapability: () => true, policyAllows: () => permitted };
  const allowed = new ContinuitySessionsV03(query, owner, preview, () => true, gates);
  const intent = { targetSessionId: 'target', sourceSessionId: 'source', authenticated: true };
  await check('default policy denies before candidate or note reads', async () => {
    const denied = new ContinuitySessionsV03(query, owner, preview); const before = candidateReads;
    assert.equal((await denied.view('target')).availability, 'policy-denied'); assert.equal(candidateReads, before);
    assert.equal(await denied.continue(intent), null); assert.equal(identityReads, 0);
  });
  await check('missing Host capability is explicitly unavailable without minting intent', async () => {
    let intents = 0; const denied = new ContinuitySessionsV03(query, owner, preview, () => { intents++; return true; }, { ...gates, hostCapability: () => false });
    const view = await denied.view('target'); assert.equal(view.availability, 'no-authenticated-host-intent'); assert.equal(view.canContinue, false);
    assert.equal(await denied.continue(intent), null); assert.equal(intents, 0);
  });
  await check('native same-project source delegates only to separately validating preview', async () => {
    assert.ok(await allowed.continue(intent)); assert.equal(previews, 1); assert.equal(identityReads, 1);
  });
  await check('metadata is detached bounded and body-free; getters never run', async () => {
    let touched = 0; rows = Array.from({ length: 180 }, (_, i) => ({ sessionId: `candidate-${i}`, projectId, hasUnfinishedWork: true,
      get title() { touched++; throw new Error('getter'); }, workMetadata: { pendingCalls: 1, rawBody: 'MUST-NOT-LEAK' } }));
    const view = await allowed.view('target'); assert.equal(view.candidates.length, 128); assert.equal(touched, 0);
    assert.ok(Object.isFrozen(view.candidates)); assert.ok(Object.isFrozen(view.candidates[0]));
    assert.equal(JSON.stringify(view).includes('MUST-NOT-LEAK'), false);
    rows = [{ sessionId: 'source', projectId, hasUnfinishedWork: true }];
  });
  await check('cross-project source cannot reach identity or preview', async () => {
    const before = identityReads; assert.equal(await allowed.continue({ ...intent, sourceSessionId: 'foreign' }), null); assert.equal(identityReads, before);
  });
  await check('direct delegated source cannot reach protected identity', async () => {
    const before = identityReads; assert.equal(await allowed.continue({ ...intent, sourceSessionId: 'delegated' }), null); assert.equal(identityReads, before);
  });
  await check('partial native acquisition failure releases accepted target', async () => {
    const failing = new ContinuitySessionsV03({ async observeSession(id, options) { if (id === 'source') throw new Error('source unavailable'); return query.observeSession(id, options); } }, owner, preview, () => true, gates);
    await assert.rejects(failing.continue(intent), /source unavailable/);
  });
  await check('cancellation after target acquisition releases the target and denies notes', async () => {
    const controller = new AbortController(); const before = identityReads;
    const cancelled = new ContinuitySessionsV03({ async observeSession(id, options) { const lease = await query.observeSession(id, options); controller.abort(); return lease; } }, owner, preview, () => true, gates);
    await assert.rejects(cancelled.continue(intent, controller.signal)); assert.equal(identityReads, before);
  });
  await check('live policy revocation prevents protected identity lookup', async () => {
    const before = identityReads; permitted = false; assert.equal(await allowed.continue(intent), null);
    assert.equal(identityReads, before); assert.equal((await allowed.view('target')).candidates.length, 0); permitted = true;
  });
  await check('malformed IDs and pre-aborted invocations cannot acquire or invoke getters', async () => {
    const controller = new AbortController(); controller.abort(); assert.equal(await allowed.continue(intent, controller.signal), null);
    assert.equal(await allowed.continue({ ...intent, sourceSessionId: 'bad\0id' }), null);
    let touched = 0; assert.equal(await allowed.continue({ ...intent, get sourceSessionId() { touched++; throw new Error('getter'); } }), null); assert.equal(touched, 0);
  });
  console.log(`${passes} native Sessions adapter gates PASS; protected source proof remains the real preview owner's responsibility; no prompt dispatch performed`);
} finally { for (const fiber of fibers.reverse()) await fiber.dispose(); }
