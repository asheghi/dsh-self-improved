#!/usr/bin/env node
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { initContinuityProjection as init, applyContinuityProjection as apply, CONTINUITY_PENDING_LIMIT, CONTINUITY_EXECUTION_LIMIT } from '../lib/continuity-projection-v02.js';
const header = { version: 4, id: 'synthetic', createdAt: 1, isSeeded: false };
const event = (type, seq, data) => ({ type, seq, time: seq + 1, data });
const user = (seq, source = { kind: 'user' }) => event('user/message', seq, { role: 'user', source, content: [{ type: 'text', text: 'password=ProjectionCanary' }] });
const call = (seq, id) => event('tool/call', seq, { callId: id, name: 'token=ProjectionCanary', arguments: 'password=ProjectionCanary', turn: 1, step: 1 });
const result = (seq, id, extra = {}, sourceId = id) => event('tool/result', seq, { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: sourceId }, toolCallId: id, content: [{ type: 'text', text: 'password=ProjectionCanary' }], ...extra } });
let passes = 0;
const check = async (label, fn) => { await fn(); console.log(`PASS ${label}`); passes++; };
const freeze = value => { Object.freeze(value); for (const child of Object.values(value)) if (child && typeof child === 'object' && !Object.isFrozen(child)) freeze(child); return value; };

await check('empty zero-based cursor and first human coordinate', () => {
  const s = init(header, 0);
  assert.equal(s.lastOwnSeq, -1);
  assert.equal(s.lastHumanSeq, -1);
  assert.equal(apply(s, user(0)).lastHumanSeq, 0);
  assert.throws(() => init(header, -1));
  assert.throws(() => init(header, 0.5));
});
await check('inherited fork prefixes never count as owned progress', () => {
  const s = init(header, 3);
  assert.equal(apply(s, user(0)), s);
  assert.equal(apply(s, call(2, 'inherited')), s);
  assert.equal(apply(s, user(3)).lastHumanSeq, 3);
});
await check('delegated user-kind briefs are not human intent', () => {
  for (const marker of [{ origin: 'subagent' }, { parentSession: 'parent' }, { delegationDepth: 1 }]) {
    const s = init({ ...header, ...marker }, 0);
    assert.equal(apply(s, user(0)), s);
    assert.equal(s.lastHumanSeq, -1);
  }
});
await check('coordinator, injected and unknown producers cannot create human intent', () => {
  const s = init(header, 0);
  for (const source of [undefined, null, { kind: 'unknown' }, { kind: 'coordinator' }, { kind: 'dsh-self-improved' }, { kind: 'model' }, { kind: 'user', form: 'snapshot' }, { kind: 'user', form: 'recall' }]) {
    const row = user(0, source);
    row.data.source = source;
    assert.equal(apply(s, row), s);
  }
});
await check('exact native call/result identity pairing never implies verified task success', () => {
  const s = apply(init(header, 0), call(0, 'call-a'));
  const paired = apply(s, result(1, 'call-a'));
  assert.equal(paired.pendingCalls.length, 0);
  assert.equal(paired.recentExecutions[0].outcome, 'returned');
  assert.equal(paired.recentExecutions[0].verified, false);
  assert.equal(paired.turnState, 'unknown');
  assert.equal(paired.recentExecutions[0].callSeq, 0);
  assert.equal(paired.recentExecutions[0].resultSeq, 1);
});
await check('unmatched or mismatched result preserves pending external-action uncertainty', () => {
  const s = apply(init(header, 0), call(0, 'call-a'));
  for (const row of [result(1, 'call-b'), result(1, 'call-a', {}, 'forged-source')]) {
    const next = apply(s, row);
    assert.equal(next.pendingCalls.length, 1);
    assert.equal(next.recentExecutions.length, 0);
    assert.equal(next.coverageIncomplete, true);
    assert.equal(next.unmatchedResults, 1);
  }
});
await check('native error remains failed execution, not verified lesson', () => {
  const s = apply(init(header, 0), call(0, 'a'));
  assert.equal(apply(s, result(1, 'a', { isError: true })).recentExecutions[0].outcome, 'failed');
  const row = result(1, 'a'); row.data.error = { name: 'Error', code: 'synthetic' };
  assert.equal(apply(s, row).recentExecutions[0].outcome, 'failed');
});
await check('every turn-end kind preserves unresolved calls and never asserts task completion', () => {
  const s = apply(init(header, 0), call(0, 'still-uncertain'));
  for (const kind of ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked']) {
    const next = apply(s, event('turn/end', 1, { turn: 1, reason: { kind } }));
    assert.equal(next.turnState, kind);
    assert.equal(next.lastBoundarySeq, 1);
    assert.equal(next.pendingCalls.length, 1);
    assert.equal(Object.hasOwn(next, 'taskCompleted'), false);
  }
  assert.equal(apply(s, event('turn/end', 1, { reason: { kind: 'future-unknown' } })).coverageIncomplete, true);
});
await check('overflow is bounded and sticky, not falsely complete', () => {
  let s = init(header, 0);
  for (let i = 0; i <= CONTINUITY_PENDING_LIMIT; i++) s = apply(s, call(i, `a-${i}`));
  assert.equal(s.pendingCalls.length, CONTINUITY_PENDING_LIMIT);
  assert.equal(s.coverageIncomplete, true);
  s = apply(s, result(100, 'a-0'));
  assert.equal(s.coverageIncomplete, true);
  assert.equal(s.pendingCalls.length, CONTINUITY_PENDING_LIMIT - 1);
  let recent = init(header, 0);
  for (let i = 0; i <= CONTINUITY_EXECUTION_LIMIT; i++) { recent = apply(recent, call(i * 2, `recent-${i}`)); recent = apply(recent, result(i * 2 + 1, `recent-${i}`)); }
  assert.equal(recent.recentExecutions.length, CONTINUITY_EXECUTION_LIMIT);
  assert.equal(recent.coverageIncomplete, true);
});
await check('replay, ignored events and duplicate native ids do not inflate progress', () => {
  const s = apply(init(header, 0), call(0, 'dup'));
  assert.equal(apply(s, call(0, 'dup')), s);
  assert.equal(apply(s, event('system/message', 2, { ignored: true })), s);
  assert.equal(apply(s, call(1, 'dup')).pendingCalls.length, 1);
  const returned = apply(s, result(1, 'dup'));
  const duplicate = apply(returned, call(2, 'dup'));
  assert.equal(duplicate.pendingCalls.length, 0);
  assert.equal(duplicate.coverageIncomplete, true);
});
await check('pure immutable JSON state never stores native message/argument/result/call-id secrets', () => {
  const s = freeze(init(header, 0));
  const row = freeze(call(0, 'password=ProjectionCanary'));
  const next = apply(s, row);
  assert.equal(s.pendingCalls.length, 0);
  const done = apply(next, result(1, 'password=ProjectionCanary'));
  assert.ok(!JSON.stringify(done).includes('ProjectionCanary'));
  assert.deepEqual(JSON.parse(JSON.stringify(done)), done);
  assert.deepEqual(apply(s, row), next);
});
await check('genuine rc.2 Session append/ownEvents drives the same pure fold at seq zero', async () => {
  const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
  assert.ok(runtime, 'Set DSH_RUNTIME_RC2 (or DSH_RUNTIME_DIR) to the validated installed rc.2 checkout; no machine-specific default');
  const { Session } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')).href);
  const { createUserMessage } = await import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai/dsh-llm/lib/index.js')).href);
  const session = Session.create('continuity-native-fixture');
  session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic unfinished work' }] }), { surfaceOp: 'append' });
  session.append('turn/start', { turn: 1 });
  session.append('tool/call', { turn: 1, step: 1, callId: 'native-call', name: 'synthetic', arguments: '{}' });
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  const s = session.ownEvents().reduce(apply, init(session.header, session.inheritedEventCount));
  assert.equal(s.lastHumanSeq, 0);
  assert.equal(s.pendingCalls.length, 1);
  assert.equal(s.turnState, 'interrupted');
  assert.equal(s.lastBoundarySeq, 3);
});
console.log(`${passes} PASS / 0 FAIL`);
