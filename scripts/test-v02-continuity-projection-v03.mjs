#!/usr/bin/env node
// Isolated state-v2 projection tests. No registry/runtime admission wiring.
import assert from 'node:assert/strict';
import * as z from 'zod';
import {
  CONTINUITY_STATE_VERSION_V03,
  classifyContinuityV03Lineage,
  initContinuityProjectionV03,
  applyContinuityProjectionV03,
  continuityProjectionStateSchemaV03,
} from '../lib/continuity-projection-v03.js';

const rootHeader = { version: 4, id: 'root-session', createdAt: 1, isSeeded: false };
const forkHeader = { version: 4, id: 'fork-session', createdAt: 2, isSeeded: true, parentSession: 'root-session' };
const event = (type, seq, data) => ({ type, seq, time: seq + 1, data });
const user = (seq, source = { kind: 'user' }) => event('user/message', seq, {
  role: 'user', source, content: [{ type: 'text', text: 'PRIVATE-PROJECTION-V3-CANARY' }],
});
let passes = 0;
const check = (label, run) => { run(); passes++; console.log(`PASS ${label}`); };

check('root and parent-linked native fork receive distinct structural variants', () => {
  assert.equal(classifyContinuityV03Lineage(rootHeader, 0), 'root');
  assert.equal(classifyContinuityV03Lineage(forkHeader, 3), 'fork-candidate');
  assert.equal(classifyContinuityV03Lineage({ ...rootHeader, parentSession: 'parent', isSeeded: true }, 0), 'fork-candidate');
  assert.equal(classifyContinuityV03Lineage({ ...rootHeader, origin: 'subagent', parentSession: 'parent', isSeeded: true }, 0), 'denied');
});
check('unknown, explicit-undefined, delegated and malformed lineage markers fail closed', () => {
  for (const patch of [
    { origin: 'unknown-producer' }, { origin: undefined }, { delegationDepth: undefined },
    { delegationDepth: 1 }, { delegationDepth: -1 }, { parentSession: undefined },
    { parentSession: 'root-session', isSeeded: false },
    { parentSession: 'fork-session', isSeeded: true }, { id: 'bad' + String.fromCharCode(0) + 'id' },
  ]) assert.equal(classifyContinuityV03Lineage({ ...forkHeader, ...patch }, 3), 'denied', JSON.stringify(patch));
  assert.equal(classifyContinuityV03Lineage({ ...rootHeader, id: 'seeded-root', isSeeded: true }, 0), 'denied');
  assert.equal(classifyContinuityV03Lineage(rootHeader, -1), 'denied');
  assert.throws(() => initContinuityProjectionV03(rootHeader, -1), /invalid inherited/);
});
check('fork-candidate tracks only own direct human evidence and never becomes verified', () => {
  const initial = initContinuityProjectionV03(forkHeader, 3);
  assert.equal(initial.version, CONTINUITY_STATE_VERSION_V03);
  assert.equal(initial.lineageKind, 'fork-candidate');
  assert.equal(applyContinuityProjectionV03(initial, user(0)), initial, 'inherited user event is ignored');
  const owned = applyContinuityProjectionV03(initial, user(3));
  assert.equal(owned.lastHumanSeq, 3);
  assert.equal(owned.lineageKind, 'fork-candidate');
  assert.equal(Object.hasOwn(owned, 'verified'), false);
  assert.equal(Object.hasOwn(owned, 'allowed'), false);
  assert.equal(JSON.stringify(owned).includes('PRIVATE-PROJECTION-V3-CANARY'), false);
});
check('denied lineage cannot accumulate human evidence', () => {
  const initial = initContinuityProjectionV03({ ...forkHeader, origin: 'subagent' }, 0);
  assert.equal(initial.lineageKind, 'denied');
  assert.equal(applyContinuityProjectionV03(initial, user(0)), initial);
  assert.equal(initial.lastHumanSeq, -1);
});
check('state-v2 schema enforces version, lineage variant, bounds and exact JSON keys', () => {
  const schema = continuityProjectionStateSchemaV03(z);
  const candidate = initContinuityProjectionV03(forkHeader, 3);
  const own = applyContinuityProjectionV03(candidate, user(3));
  const denied = initContinuityProjectionV03({ ...forkHeader, origin: 'subagent' }, 3);
  assert.equal(schema.safeParse(denied).success, true);
  assert.equal(schema.safeParse({ ...denied, turnState: 'running' }).success, false);
  assert.equal(schema.safeParse({ ...denied, lastOwnSeq: 3 }).success, false);
  assert.equal(schema.safeParse(own).success, true);
  assert.equal(schema.safeParse({ ...own, version: 1 }).success, false);
  assert.equal(schema.safeParse({ ...own, unexpected: true }).success, false);
  assert.equal(schema.safeParse({ ...own, lineageKind: 'root' }).success, false);
  assert.equal(schema.safeParse({ ...own, lineageKind: 'denied' }).success, false);
  assert.equal(schema.safeParse({ ...own, lastHumanSeq: 2 }).success, false);
  assert.equal(schema.safeParse({ ...own, lastOwnSeq: Number.MAX_SAFE_INTEGER + 1 }).success, false);
  assert.equal(schema.safeParse({ ...own, pendingCalls: [{ callKey: 'x', callSeq: 3 }] }).success, false);
  const rootWithFloor = { ...initContinuityProjectionV03(rootHeader, 0), inheritedEventCount: 1, lastOwnSeq: 0 };
  assert.equal(schema.safeParse(rootWithFloor).success, false);
});
check('fold retains bounded uncertain execution evidence without bodies or task success', () => {
  const schema = continuityProjectionStateSchemaV03(z);
  const call = event('tool/call', 3, { callId: 'RAW-CALL-ID', name: 'tool', arguments: 'secret' });
  const result = event('tool/result', 4, { message: {
    role: 'tool', source: { kind: 'tool', callId: 'RAW-CALL-ID' }, toolCallId: 'RAW-CALL-ID',
    content: [{ type: 'text', text: 'secret' }],
  } });
  const initial = initContinuityProjectionV03(forkHeader, 3);
  const folded = applyContinuityProjectionV03(applyContinuityProjectionV03(initial, call), result);
  assert.equal(schema.safeParse(folded).success, true);
  assert.equal(folded.recentExecutions[0].verified, false);
  assert.equal(folded.turnState, 'unknown');
  assert.equal(JSON.stringify(folded).includes('RAW-CALL-ID'), false);
  assert.equal(JSON.stringify(folded).includes('secret'), false);
});
console.log(`${passes} PASS / 0 FAIL`);
