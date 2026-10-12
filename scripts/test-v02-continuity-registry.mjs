#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { continuityProjectionDefinition, registerContinuityProjection, createContinuityRegistrationController, CONTINUITY_PROJECTION_KEY as KEY } from '../lib/continuity-registry-v02.js';
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Set DSH_RUNTIME_RC2 (or DSH_RUNTIME_DIR) to the validated installed rc.2 checkout; no machine-specific default');
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const { Context } = await native('cordis');
const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { Session } = await native('dsh-session');
const { createUserMessage, createAssistantMessage } = await native('dsh-llm');
let passes = 0;
const check = (label, fn) => { fn(); passes++; console.log(`PASS ${label}`); };
const root = new Context();
const registryFiber = root.plugin(SessionProjectionRegistry);
await registryFiber.await();
let owner;
try {
  owner = root.plugin({ name: 'continuity-fixture-owner', inject: ['sessionProjections'], apply: ctx => { registerContinuityProjection(ctx, z); } });
  await owner.await();
  const registry = root.sessionProjections;
  const session = Session.create('native-continuity-registry');
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic unfinished task' }] }), { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  session.append('tool/call', { turn: 1, step: 1, callId: 'native-pending', name: 'synthetic', arguments: '{}' });
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  session.append('assistant/message', { turn: 1, message: createAssistantMessage({ source: { kind: 'model' }, content: [{ type: 'text', text: 'UNTRUSTED completed all work' }] }) }, { surfaceOp: 'append' });
  check('native registry materializes owned structural state without assistant task-success inference', () => {
    const state = registry.stateOf(session, KEY);
    assert.equal(state.lastHumanSeq, 0);
    assert.equal(state.lastOwnSeq, 3);
    assert.equal(state.pendingCalls.length, 1);
    assert.equal(state.turnState, 'interrupted');
  });
  const checkpoint = registry.checkpoint(session);
  check('native checkpoint watermark covers ignored events and is detached from live state', () => {
    assert.equal(checkpoint[KEY].seq, 4);
    assert.equal(checkpoint[KEY].ver, 1);
    assert.equal(registry.snapshot(session).asOfSeq, 4);
    assert.equal(Object.hasOwn(registry.snapshot(session).values, KEY), false, 'host-only state is not a client wire payload');
    const cloned = structuredClone(checkpoint);
    cloned[KEY].val.pendingCalls.length = 0;
    assert.equal(registry.stateOf(session, KEY).pendingCalls.length, 1);
  });
  const definition = continuityProjectionDefinition(z);
  check('strict bounded cache schema rejects forged confidence, bodies and invalid coordinates', () => {
    assert.ok(definition.stateSchema.safeParse(checkpoint[KEY].val).success);
    for (const mutate of [
      state => { state.taskCompleted = true; },
      state => { state.pendingCalls[0].arguments = 'secret'; },
      state => { state.pendingCalls[0].callSeq = 999; },
      state => { state.lastHumanSeq = 999; },
      state => { state.delegated = true; },
      state => { state.pendingCalls.push({ ...state.pendingCalls[0] }); },
      state => { state.pendingCalls[0].callKey = 'password=canary'; },
      state => { state.recentExecutions = [{ ...state.pendingCalls[0], resultSeq: 3, outcome: 'returned', verified: true }]; state.pendingCalls = []; },
    ]) { const bad = structuredClone(checkpoint[KEY].val); mutate(bad); assert.equal(definition.stateSchema.safeParse(bad).success, false); }
  });
  check('native cold restore replays valid source cut without duplicate observations', () => {
    const restored = registry.restore(checkpoint, [], 5, session.header, session.inheritedEventCount);
    assert.equal(restored.snapshot.asOfSeq, 4);
    assert.deepEqual(restored.checkpoint[KEY].val, checkpoint[KEY].val);
    assert.equal(restored.checkpoint[KEY].val.pendingCalls.length, 1);
  });
  check('native version drift refolds; malformed matching-version cache fails closed before explicit full-log recovery', () => {
    for (const corrupt of ['version', 'state']) {
      const bad = structuredClone(checkpoint);
      if (corrupt === 'version') bad[KEY].ver = 999;
      else bad[KEY].val.taskCompleted = true;
      if (corrupt === 'state') {
        assert.throws(() => registry.restore(bad, session.snapshotEvents(), 0, session.header, session.inheritedEventCount), /taskCompleted/);
        // Native matching-version malformed state throws; recovery must
        // explicitly reject that row and reread the COMPLETE canonical cut.
        delete bad[KEY];
      }
      const restored = registry.restore(bad, session.snapshotEvents(), 0, session.header, session.inheritedEventCount);
      assert.deepEqual(restored.checkpoint[KEY].val, checkpoint[KEY].val);
      assert.equal(restored.snapshot.asOfSeq, 4);
      assert.throws(() => registry.restore(bad, [], 5, session.header, session.inheritedEventCount));
    }
  });
  const next = session.append('turn/start', { turn: 2 });
  root.emit('session/event', session, next);
  check('framework-owned committed-event drive advances the state without a plugin subscription', () => {
    assert.equal(registry.stateOf(session, KEY).turnState, 'running');
    assert.equal(registry.checkpoint(session)[KEY].seq, 5);
    assert.equal(registry.stateOf(session, KEY).pendingCalls.length, 1);
  });
  await owner.dispose();
  check('owner disposal removes registration and capability state', () => {
    assert.equal(registry.stateOf(session, KEY), undefined);
    assert.equal(Object.hasOwn(registry.checkpoint(session), KEY), false);
  });
  let controller;
  const controllerOwner = root.plugin({ name: 'continuity-controller-owner', inject: ['sessionProjections'], apply: ctx => {
    controller = createContinuityRegistrationController(ctx, z);
    ctx.effect(() => () => controller.dispose(), 'fixture controller ownership');
  } });
  await controllerOwner.await();
  try {
    check('controller stays inert at boot and repeated enable owns one registration only', () => {
      controller.sync(false);
      assert.equal(registry.stateOf(session, KEY), undefined);
      controller.sync(true); controller.sync(true);
      assert.equal(registry.stateOf(session, KEY).lastHumanSeq, 0);
      controller.sync(false);
      assert.equal(registry.stateOf(session, KEY), undefined, 'one pause must clear repeated-enable registration');
    });
    check('controller resume uses the canonical fold, not prior mutable cache cells', () => {
      controller.sync(true);
      assert.equal(registry.stateOf(session, KEY).turnState, 'running');
      assert.equal(registry.stateOf(session, KEY).pendingCalls.length, 1);
    });
    check('disposed controller permanently refuses a late enable callback', () => {
      controller.dispose(); controller.sync(true);
      assert.equal(registry.stateOf(session, KEY), undefined);
    });
  } finally { await controllerOwner.dispose(); }
  console.log(`${passes} PASS / 0 FAIL`);
} finally {
  if (owner?.uid != null) await owner.dispose();
  await registryFiber.dispose();
}
