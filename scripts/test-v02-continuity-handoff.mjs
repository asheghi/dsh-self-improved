#!/usr/bin/env node
// Actual shared SQLite handoff/work atomicity; source verification remains caller-owned.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MemoryStore } from '../lib/storage.js';
import { ContinuityWorkV02 } from '../lib/continuity-work-v02.js';
import { ContinuityHandoffV02 } from '../lib/continuity-handoff-v02.js';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no install/profile/fallback');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh-session/package.json'), 'utf8')).version, '0.2.1-rc.2');
const zp = join(runtime, 'node_modules/zod'); assert.equal(JSON.parse(readFileSync(join(zp, 'package.json'), 'utf8')).version, '4.4.3');
const z = await import(pathToFileURL(join(zp, 'index.js')).href);
mkdirSync('.tmp-import-lane', { recursive: true }); const dir = mkdtempSync('.tmp-import-lane/continuity-handoff-');
let store = new MemoryStore(join(dir, 'data')), db = store.getJournalSqlite();
db.exec(`CREATE TABLE continuity_policy(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,generation INTEGER NOT NULL,allowed INTEGER NOT NULL) STRICT;
CREATE TABLE continuity_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,project_id TEXT NOT NULL,generation INTEGER NOT NULL,cut INTEGER NOT NULL,source_hash TEXT NOT NULL,trigger TEXT NOT NULL,status TEXT NOT NULL) STRICT;`);
let queue = new ContinuityWorkV02(store), handoff = new ContinuityHandoffV02(store, z);
const p = 'pj-' + 'a'.repeat(32), other = 'pj-' + 'b'.repeat(32), hash = 'c'.repeat(64);
let n = 0; const check = (name, fn) => { fn(); console.log('PASS ' + name); n++; };
const seed = id => { db.prepare('INSERT INTO continuity_policy VALUES(?,?,0,1)').run(id, p); db.prepare("INSERT INTO continuity_jobs VALUES(?,?,?,0,7,?,'turn-end','pending')").run(id, id, p, hash); return queue.claim(p, 100, 10); };
const count = () => Number(db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n);
try {
  check('separate STRICT handoff table and malformed DTO/caps refuse before any DB access', () => {
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='continuity_handoff'").get().strict, 1);
    for (const input of [[], { notes: [1] }, { notes: ['x'.repeat(281)] }, { notes: ['', '', '', ''] }, { notes: [], completedTask: true }, { notes: [], jobId: 'invented' }, { notes: [], permission: true }, { notes: [], body: 'CANARY' }]) assert.throws(() => handoff.commit('bad', -1, input));
    assert.equal(count(), 0); assert.throws(() => handoff.commit('bad', NaN, { notes: [] }), /time/);
  });
  check('hidden serialization hooks ignored and changing getters persist only strict parsed snapshot', () => {
    const job = seed('safe'); let reads = 0;
    const input = {}; Object.defineProperty(input, 'notes', { enumerable: true, get() { reads++; return reads === 1 ? ['bounded note'] : ['RAW-SECRET']; } });
    Object.defineProperty(input, 'toJSON', { value() { return { body: 'RAW-SECRET' }; } });
    assert.equal(handoff.commit(job.token, 101, input), true); assert.equal(reads, 1);
    const saved = handoff.read(p, 'safe'); assert.deepEqual(saved.notes, ['bounded note']); assert.equal(saved.uncertain, true);
    assert.ok(!JSON.stringify(saved).includes('RAW-SECRET')); assert.equal(queue.readStatus(p, 'safe').status, 'completed');
    assert.deepEqual(Object.keys(saved).sort(), ['cut', 'generation', 'jobId', 'notes', 'projectId', 'sessionId', 'sourceHash', 'uncertain'].sort());
    assert.equal(saved.sourceHash, hash); assert.equal(saved.cut, 7); assert.equal(saved.sessionId, 'safe'); assert.equal(saved.generation, 0);
    saved.notes.push('detached mutation'); assert.deepEqual(handoff.read(p, 'safe').notes, ['bounded note']);
    assert.equal(handoff.commit(job.token, 101, { notes: [] }), false); assert.equal(handoff.read(other, 'safe'), null);
  });
  check('fresh OS process preserves committed handoff and cannot reconsume completed work', () => {
    store.close();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { MemoryStore } from './lib/storage.js';
      import { ContinuityWorkV02 } from './lib/continuity-work-v02.js';
      import { ContinuityHandoffV02 } from './lib/continuity-handoff-v02.js';
      import { pathToFileURL } from 'node:url';
      import { join } from 'node:path';
      const z = await import(pathToFileURL(join(process.argv[2], 'node_modules/zod/index.js')).href);
      const store = new MemoryStore(process.argv[1]);
      try {
        const queue = new ContinuityWorkV02(store), handoff = new ContinuityHandoffV02(store, z);
        const project = 'pj-' + 'a'.repeat(32);
        console.log(JSON.stringify({ pid: process.pid, handoff: handoff.read(project, 'safe'),
          status: queue.readStatus(project, 'safe'), claimed: queue.claim(project, 200, 10), offers: handoff.list(project) }));
      } finally { store.close(); }
    `, join(dir, 'data'), runtime], { encoding: 'utf8', timeout: 20000 });
    assert.equal(child.status, 0, child.stderr); assert.equal(child.error, undefined);
    const result = JSON.parse(child.stdout); assert.notEqual(result.pid, process.pid);
    assert.deepEqual(result.handoff.notes, ['bounded note']); assert.equal(result.handoff.uncertain, true);
    assert.equal(result.status.status, 'completed'); assert.equal(result.claimed, null);
    assert.deepEqual(result.offers.map(row => row.jobId), ['safe']);
    store = new MemoryStore(join(dir, 'data')); db = store.getJournalSqlite(); queue = new ContinuityWorkV02(store); handoff = new ContinuityHandoffV02(store, z);
    assert.deepEqual(handoff.read(p, 'safe').notes, ['bounded note']); assert.equal(queue.claim(p, 200, 10), null);
  });
  check('expired/replaced token cannot insert or acknowledge; fresh exact lease commits', () => {
    const first = seed('expiry'); assert.equal(handoff.commit(first.token, 110, { notes: [] }), false);
    const second = queue.claim(p, 110, 10); assert.equal(handoff.commit(first.token, 111, { notes: [] }), false);
    assert.equal(handoff.read(p, 'expiry'), null); assert.equal(queue.readStatus(p, 'expiry').status, 'running');
    assert.equal(handoff.commit(second.token, 119, { notes: [] }), true);
  });
  check('insert/update failures roll handoff and work settlement back together', () => {
    const job = seed('rollback'); const before = count();
    db.exec("CREATE TRIGGER refuse_handoff BEFORE INSERT ON continuity_handoff BEGIN SELECT RAISE(ABORT,'synthetic insert failure'); END");
    assert.throws(() => handoff.commit(job.token, 101, { notes: ['ok'] }), /synthetic insert failure/); assert.equal(count(), before); assert.equal(queue.readStatus(p, 'rollback').status, 'running'); db.exec('DROP TRIGGER refuse_handoff');
    db.exec("CREATE TRIGGER refuse_settle BEFORE UPDATE ON continuity_work BEGIN SELECT RAISE(ABORT,'synthetic update failure'); END");
    assert.throws(() => handoff.commit(job.token, 101, { notes: ['ok'] }), /synthetic update failure/); assert.equal(count(), before); assert.equal(queue.readStatus(p, 'rollback').status, 'running'); db.exec('DROP TRIGGER refuse_settle');
    db.exec(`CREATE TRIGGER change_source BEFORE INSERT ON continuity_handoff BEGIN UPDATE continuity_jobs SET source_hash='${'d'.repeat(64)}' WHERE id=NEW.job_id; END`);
    assert.throws(() => handoff.commit(job.token, 101, { notes: ['ok'] }), /admission changed/);
    assert.equal(count(), before); assert.equal(db.prepare('SELECT source_hash FROM continuity_jobs WHERE id=?').get('rollback').source_hash, hash);
    assert.equal(queue.readStatus(p, 'rollback').status, 'running'); db.exec('DROP TRIGGER change_source');
    assert.equal(handoff.commit(job.token, 101, { notes: ['ok'] }), true);
  });
  check('current cancellation/denial/generation/project fences both commit and read visibility', () => {
    for (const [id, sql] of [['cancel', "UPDATE continuity_jobs SET status='cancelled' WHERE id=?"], ['deny', 'UPDATE continuity_policy SET allowed=0 WHERE session_id=?'], ['generation', 'UPDATE continuity_policy SET generation=1 WHERE session_id=?'], ['project', `UPDATE continuity_policy SET project_id='${other}' WHERE session_id=?`]]) {
      const job = seed(id); const before = count(); db.prepare(sql).run(id);
      assert.equal(handoff.commit(job.token, 101, { notes: [] }), false); assert.equal(count(), before); assert.equal(handoff.read(p, id), null);
    }
    db.prepare('UPDATE continuity_policy SET generation=1 WHERE session_id=?').run('safe'); assert.equal(handoff.read(p, 'safe'), null);
    db.prepare("UPDATE continuity_jobs SET status='cancelled' WHERE id=?").run('expiry'); assert.equal(handoff.read(p, 'expiry'), null);
    db.prepare('UPDATE continuity_policy SET allowed=0 WHERE session_id=?').run('rollback'); assert.equal(handoff.read(p, 'rollback'), null);
  });
  check('persisted schema-valid anchor forgery or forbidden payload fails closed on read', () => {
    const job = seed('poison'); assert.equal(handoff.commit(job.token, 101, { notes: ['ok'] }), true);
    const original = handoff.read(p, 'poison'); db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(JSON.stringify({ ...original, sourceHash: 'd'.repeat(64) }), 'poison');
    assert.throws(() => handoff.read(p, 'poison'), /anchors mismatch/);
    db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(JSON.stringify({ ...original, completedTask: true }), 'poison'); assert.throws(() => handoff.read(p, 'poison'));
    assert.throws(() => handoff.list(p));
    db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(JSON.stringify(original), 'poison');
  });
  check('same-project offers are bounded, detached, current and never grant task success', () => {
    assert.deepEqual(handoff.list(other), []); assert.throws(() => handoff.list('bad'), /ownership/);
    assert.deepEqual(handoff.list(p).map(row => row.jobId), ['poison']);
    const copy = handoff.list(p); copy[0].notes.push('detached'); assert.deepEqual(handoff.read(p, 'poison').notes, ['ok']);
    for (let i = 0; i < 51; i++) {
      const id = 'offer-' + String(i).padStart(2, '0'); const job = seed(id);
      assert.equal(handoff.commit(job.token, 101, { notes: ['Unverified source quotation'] }), true);
    }
    const newest = handoff.read(p, 'offer-50');
    store.runInImmediateTransaction(() => {
      db.prepare('UPDATE continuity_jobs SET cut=99 WHERE id=?').run(newest.jobId);
      db.prepare('UPDATE continuity_handoff SET cut=99,payload=? WHERE job_id=?').run(JSON.stringify({ ...newest, cut: 99 }), newest.jobId);
    });
    assert.equal(handoff.list(p)[0].jobId, 'offer-50', 'newest source cut, not insertion/id ordering');
    const snapshot = () => JSON.stringify(['continuity_policy', 'continuity_jobs', 'continuity_work', 'continuity_handoff'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const before = snapshot(), rows = handoff.list(p); assert.equal(rows.length, 50); assert.equal(snapshot(), before);
    for (const row of rows) { assert.equal(row.uncertain, true); assert.ok(!('token' in row)); assert.ok(!('completedTask' in row)); }
    for (const [id, sql] of [['offer-00', 'UPDATE continuity_policy SET allowed=0 WHERE session_id=?'],
      ['offer-01', 'UPDATE continuity_policy SET generation=1 WHERE session_id=?'],
      ['offer-02', `UPDATE continuity_policy SET project_id='${other}' WHERE session_id=?`],
      ['offer-03', "UPDATE continuity_jobs SET status='cancelled' WHERE id=?"]]) db.prepare(sql).run(id);
    assert.ok(handoff.list(p).every(row => !['offer-00', 'offer-01', 'offer-02', 'offer-03'].includes(row.jobId)));
    assert.deepEqual(handoff.list(other), [], 'policy-only project move never transfers evidence');
  });
  console.log(`${n} PASS / 0 FAIL; private fixture=${dir}; canonical cut verification/worker wiring NOT supplied`);
} finally { store.close(); }
