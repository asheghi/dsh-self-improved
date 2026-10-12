#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MemoryStore } from '../lib/storage.js';
import { ContinuityStoreV02 } from '../lib/continuity-store-v02.js';
import { initContinuityProjection } from '../lib/continuity-projection-v02.js';
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Explicit validated rc.2 checkout required');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const dir = mkdtempSync(join(repo, '.tmp-import-lane/continuity-store-'));
const project = 'pj-' + 'a'.repeat(32), other = 'pj-' + 'b'.repeat(32);
const envelope = { format: 1, sessionId: 'synthetic-continuity-session', headerHash: 'a'.repeat(64), inheritedEventCount: 0,
  asOfSeq: -1, sourceHash: 'b'.repeat(64), row: { ver: 1, seq: -1, val: initContinuityProjection({}, 0) } };
let store = new MemoryStore(dir); let lane = new ContinuityStoreV02(store, z); let passes = 0;
const check = (label, fn) => { fn(); passes++; console.log(`PASS ${label}`); };
try {
  check('no implicit session/project admission; wrong owner cannot enqueue', () => {
    assert.throws(() => lane.enqueue(envelope, project, 0, 'turn-end'), /denied/);
    assert.equal(lane.listPending(project).length, 0);
  });
  const gen = lane.setPolicy(envelope.sessionId, project, true);
  let id;
  check('checkpoint and job enqueue commit together and identical source/trigger deduplicates', () => {
    const first = lane.enqueue(envelope, project, gen, 'turn-end'); id = first.id;
    assert.equal(first.created, true);
    assert.deepEqual(lane.enqueue(envelope, project, gen, 'turn-end'), { id, created: false });
    assert.equal(lane.listPending(project).length, 1);
    assert.deepEqual(lane.readCheckpoint(envelope.sessionId, project), envelope);
    assert.equal(lane.readCheckpoint(envelope.sessionId, other), null);
    assert.equal(lane.listPending(other).length, 0);
  });
  store.close(); store = new MemoryStore(dir); lane = new ContinuityStoreV02(store, z);
  check('actual SQLite close/reopen preserves checkpoint/reference/dedup identity', () => {
    assert.deepEqual(lane.readCheckpoint(envelope.sessionId, project), envelope);
    assert.equal(lane.listPending(project)[0].id, id);
    assert.equal(lane.enqueue(envelope, project, gen, 'turn-end').created, false);
  });
  check('trigger failure rolls checkpoint update back with enqueue; no partial committed cut', () => {
    store.getJournalSqlite().exec(`CREATE TRIGGER continuity_test_fail BEFORE INSERT ON continuity_jobs WHEN NEW.trigger='pause' BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
    const next = structuredClone(envelope); next.asOfSeq = 0; next.row.seq = 0; next.sourceHash = 'c'.repeat(64);
    assert.throws(() => lane.enqueue(next, project, gen, 'pause'), /synthetic failure/);
    assert.equal(lane.readCheckpoint(envelope.sessionId, project).asOfSeq, -1);
    assert.equal(lane.listPending(project).length, 1);
    store.getJournalSqlite().exec('DROP TRIGGER continuity_test_fail');
  });
  check('raw body/permission smuggling and inconsistent anchors are rejected before writes', () => {
    for (const mutate of [c => { c.body = 'password=canary'; }, c => { c.row.val.taskCompleted = true; },
      c => { c.row.val.pendingCalls = [{ callKey: 'a'.repeat(64), callSeq: 99 }]; },
      c => { c.inheritedEventCount = 1; }]) {
      const bad = structuredClone(envelope); mutate(bad); assert.throws(() => lane.enqueue(bad, project, gen, 'finish'));
    }
    assert.equal(lane.listPending(project).length, 1);
  });
  check('non-enumerable serialization hooks cannot inject bodies after strict validation', () => {
    const hooked = structuredClone(envelope);
    Object.defineProperty(hooked, 'toJSON', { enumerable: false, value() { return { ...envelope, body: 'PRIVATE-CONTINUITY-CANARY' }; } });
    lane.enqueue(hooked, project, gen, 'finish');
    const saved = store.getJournalSqlite().prepare('SELECT envelope FROM continuity_checkpoint WHERE session_id=?').get(envelope.sessionId).envelope;
    assert.ok(!saved.includes('PRIVATE-CONTINUITY-CANARY'));
    assert.equal(Object.hasOwn(JSON.parse(saved), 'body'), false);
    assert.equal(lane.listPending(project).length, 2);
  });
  check('changing getters cannot pass source-cut equality on a different representation', () => {
    const changing = structuredClone(envelope); changing.row.seq = 0;
    let calls = 0;
    Object.defineProperty(changing, 'asOfSeq', { enumerable: true, get() { return ++calls <= 4 ? 0 : -1; } });
    // Parsing reads the getter once: stored identity must agree with that one
    // parsed value, regardless of later hypothetical reads of the original.
    lane.enqueue(changing, project, gen, 'pause');
    const saved = lane.readCheckpoint(envelope.sessionId, project);
    assert.equal(saved.asOfSeq, saved.row.seq);
    assert.equal(calls, 1);
  });
  const denied = lane.setPolicy(envelope.sessionId, project, false);
  check('privacy/policy deny atomically cancels references and drops checkpoint; late generation refused', () => {
    assert.equal(lane.listPending(project).length, 0);
    assert.equal(lane.readCheckpoint(envelope.sessionId, project), null);
    assert.throws(() => lane.enqueue(envelope, project, gen, 'finish'), /stale or denied/);
    assert.throws(() => lane.enqueue(envelope, project, denied, 'finish'), /stale or denied/);
  });
  store.close(); store = new MemoryStore(dir); lane = new ContinuityStoreV02(store, z);
  check('denial survives restart and reenable does not resurrect cancelled work', () => {
    assert.equal(lane.listPending(project).length, 0);
    const resumed = lane.setPolicy(envelope.sessionId, project, true);
    assert.equal(lane.listPending(project).length, 0);
    assert.equal(lane.enqueue(envelope, project, resumed, 'turn-end').created, true);
    assert.equal(lane.listPending(project).length, 1);
  });
  console.log(`${passes} PASS / 0 FAIL; private fixture=${dir}`);
} finally { store.close(); }
