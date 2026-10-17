#!/usr/bin/env node
// Real SQLite queue/lease gates. No source/native-query/provider imports or calls.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../lib/storage.js';
import { ContinuityWorkV02 } from '../lib/continuity-work-v02.js';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no SDK install/patch/fallback');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai/dsh-session/package.json'), 'utf8')).version, '0.2.1-rc.2');
mkdirSync('.tmp-import-lane', { recursive: true }); const dir = mkdtempSync('.tmp-import-lane/continuity-work-');
let store = new MemoryStore(join(dir, 'data')), db = store.getJournalSqlite();
db.exec(`CREATE TABLE continuity_policy(session_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,generation INTEGER NOT NULL,allowed INTEGER NOT NULL) STRICT;
CREATE TABLE continuity_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,project_id TEXT NOT NULL,generation INTEGER NOT NULL,cut INTEGER NOT NULL,source_hash TEXT NOT NULL,trigger TEXT NOT NULL,status TEXT NOT NULL) STRICT;`);
let queue = new ContinuityWorkV02(store); const p = 'pj-' + 'a'.repeat(32), other = 'pj-' + 'b'.repeat(32), hash = 'c'.repeat(64);
const seed = id => { db.prepare('INSERT INTO continuity_policy VALUES(?,?,0,1)').run(id, p); db.prepare("INSERT INTO continuity_jobs VALUES(?,?,?,0,0,?,'turn-end','pending')").run(id, id, p, hash); };
let n = 0; const check = (name, fn) => { fn(); console.log('PASS ' + name); n++; };
try {
  check('new STRICT work table only, timestamps/TTL/project primitive validation fails before claim', () => {
    assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='continuity_work'").get().strict, 1);
    for (const args of [[p, NaN, 1], [p, Infinity, 1], [p, -1, 1], [p, 0.5, 1], [p, 0, 60001], [p, 0, 0], [p, Number.MAX_SAFE_INTEGER, 1], [{ toJSON() { throw Error('must not serialize'); } }, 0, 1]]) assert.throws(() => queue.claim(...args));
    assert.equal(queue.claim(p, 0, 1), null);
  });
  seed('one'); let first;
  check('claim returns exact detached source-hash reference and competing active lease cannot claim', () => {
    assert.equal(queue.claim(other, 0, 10), null); first = queue.claim(p, 0, 10);
    assert.equal(first.id, 'one'); assert.equal(first.sourceHash, hash); assert.equal(first.attempts, 1);
    assert.equal(new ContinuityWorkV02(store).claim(p, 9, 10), null);
    first.sourceHash = 'detached mutation'; assert.equal(db.prepare('SELECT source_hash FROM continuity_jobs').get().source_hash, hash);
  });
  check('actual close/reopen preserves active lease and expired CAS replacement rejects old token', () => {
    store.close(); store = new MemoryStore(join(dir, 'data')); db = store.getJournalSqlite(); queue = new ContinuityWorkV02(store);
    assert.equal(queue.claim(p, 9, 10), null); assert.equal(queue.finish(first.token, 10), false);
    const second = queue.claim(p, 10, 10); assert.equal(second.attempts, 2); assert.notEqual(second.token, first.token);
    assert.equal(queue.finish(first.token, 11), false); assert.equal(queue.finish(second.token, 19), true);
    assert.equal(queue.finish(second.token, 19), false); assert.equal(queue.fail(second.token, 19), false);
    assert.equal(queue.readStatus(p, 'one').status, 'completed'); assert.equal(queue.claim(p, 100, 10), null);
  });
  check('explicit fail is terminal and legacy pending references are not re-consumed', () => {
    seed('two'); const job = queue.claim(p, 100, 10); assert.equal(queue.fail(job.token, 109), true);
    assert.equal(queue.readStatus(p, 'two').status, 'failed'); assert.equal(queue.claim(p, 110, 10), null);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM continuity_jobs WHERE status='pending'").get().n, 2);
  });
  check('expired retries bounded to three then terminal failed, never fake success', () => {
    seed('three'); const a = queue.claim(p, 200, 10), b = queue.claim(p, 210, 10), c = queue.claim(p, 220, 10);
    assert.deepEqual([a.attempts, b.attempts, c.attempts], [1, 2, 3]);
    assert.equal(queue.fail(a.token, 221), false); assert.equal(queue.finish(c.token, 230), false);
    assert.equal(queue.claim(p, 230, 10), null); assert.equal(queue.readStatus(p, 'three').status, 'failed');
  });
  check('cancelled/denied/wrong project or generation fences lease commits and further claims', () => {
    for (const [id, sql] of [['cancel', "UPDATE continuity_jobs SET status='cancelled' WHERE id=?"], ['deny', 'UPDATE continuity_policy SET allowed=0 WHERE session_id=?'], ['gen', 'UPDATE continuity_policy SET generation=1 WHERE session_id=?'], ['project', `UPDATE continuity_policy SET project_id='${other}' WHERE session_id=?`]]) {
      seed(id); const job = queue.claim(p, 300, 10); db.prepare(sql).run(id);
      assert.equal(queue.finish(job.token, 301), false); assert.equal(queue.fail(job.token, 301), false);
      assert.equal(queue.readStatus(p, id), null); assert.equal(queue.claim(p, 310, 10), null);
    }
  });
  check('trigger failure rolls claim back with no successful token or attempt', () => {
    seed('rollback'); db.exec("CREATE TRIGGER reject_work BEFORE INSERT ON continuity_work BEGIN SELECT RAISE(ABORT,'synthetic work failure'); END");
    assert.throws(() => queue.claim(p, 400, 10), /synthetic work failure/);
    assert.equal(queue.readStatus(p, 'rollback'), null); db.exec('DROP TRIGGER reject_work');
    const job = queue.claim(p, 400, 10); assert.equal(job.attempts, 1);
    db.exec("CREATE TRIGGER reject_finish BEFORE UPDATE ON continuity_work BEGIN SELECT RAISE(ABORT,'synthetic settle failure'); END");
    assert.throws(() => queue.finish(job.token, 401), /synthetic settle failure/);
    assert.equal(queue.readStatus(p, 'rollback').status, 'running'); db.exec('DROP TRIGGER reject_finish'); assert.equal(queue.finish(job.token, 401), true);
  });
  check('expiry cleanup stops at bounded scan budget and next call advances beyond terminal backlog', () => {
    for (let i = 0; i < 101; i++) {
      const id = 'backlog-' + String(i).padStart(3, '0'); seed(id);
      db.prepare("INSERT INTO continuity_work VALUES(?,?,500,3,'running')").run(id, 'expired-' + i);
    }
    seed('z-fresh');
    assert.equal(queue.claim(p, 500, 10), null);
    assert.equal(queue.hasEligibleWork(p, 500), true);
    assert.equal(queue.hasEligibleWork(other, 500), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM continuity_work WHERE job_id LIKE 'backlog-%' AND status='failed'").get().n, 100);
    assert.equal(queue.claim(p, 500, 10).id, 'z-fresh');
    assert.equal(queue.hasEligibleWork(p, 500), false);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM continuity_work WHERE job_id LIKE 'backlog-%' AND status='failed'").get().n, 101);
  });
  check('pre-egress admission binds every verified claim anchor and never mutates the queue', () => {
    seed('admission'); const job = queue.claim(p, 600, 10);
    assert.equal(job.id, 'admission'); assert.equal(queue.isCurrent(job, 600), true);
    const before = JSON.stringify(db.prepare('SELECT * FROM continuity_work WHERE job_id=?').get(job.id));
    for (const [key, value] of Object.entries({ id: 'other', sessionId: 'other', projectId: other, generation: 1, cut: 1,
      sourceHash: 'd'.repeat(64), trigger: 'finish', token: '00000000-0000-0000-0000-000000000000', leaseDeadline: 611, attempts: 2 })) {
      assert.equal(queue.isCurrent({ ...job, [key]: value }, 601), false, key);
    }
    assert.equal(queue.isCurrent({ ...job, token: 'bad' }, 601), false);
    assert.throws(() => queue.isCurrent(job, NaN), /time/);
    assert.equal(queue.isCurrent(job, 610), false);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM continuity_work WHERE job_id=?').get(job.id)), before);
    const next = queue.claim(p, 610, 10); assert.equal(queue.isCurrent(job, 611), false);
    assert.equal(queue.isCurrent(next, 611), true); assert.equal(queue.finish(next.token, 611), true);
    assert.equal(queue.isCurrent(next, 611), false);
  });
  check('pre-egress admission refuses cancellation, policy drift and historical-source mutation', () => {
    for (const [id, sql] of [['egress-cancel', "UPDATE continuity_jobs SET status='cancelled' WHERE id=?"],
      ['egress-deny', 'UPDATE continuity_policy SET allowed=0 WHERE session_id=?'],
      ['egress-gen', 'UPDATE continuity_policy SET generation=1 WHERE session_id=?'],
      ['egress-project', `UPDATE continuity_policy SET project_id='${other}' WHERE session_id=?`],
      ['egress-source', `UPDATE continuity_jobs SET source_hash='${'d'.repeat(64)}' WHERE id=?`],
      ['egress-cut', 'UPDATE continuity_jobs SET cut=1 WHERE id=?']]) {
      seed(id); const job = queue.claim(p, 700, 10); assert.equal(queue.isCurrent(job, 701), true);
      db.prepare(sql).run(id); assert.equal(queue.isCurrent(job, 701), false, id);
      // Modified-source rows remain eligible for a future canonical reread;
      // terminalize only fixture work, never waive the false admission above.
      queue.fail(job.token, 701);
    }
  });
  check('bounded Sessions inventory distinguishes processing states without source/token authority', () => {
    // Give this fixture a new current project to avoid the earlier backlog.
    const viewProject = 'pj-' + 'e'.repeat(32);
    const add = (id, cut) => { db.prepare('INSERT INTO continuity_policy VALUES(?,?,0,1)').run(id, viewProject);
      db.prepare("INSERT INTO continuity_jobs VALUES(?,?,?,0,?,?,'turn-end','pending')").run(id, id, viewProject, cut, hash); };
    add('view-completed', 0); let job = queue.claim(viewProject, 800, 10); queue.finish(job.token, 801);
    add('view-failed', 1); job = queue.claim(viewProject, 800, 10); queue.fail(job.token, 801);
    add('view-expired', 2); queue.claim(viewProject, 800, 10);
    add('view-running', 3); queue.claim(viewProject, 805, 10);
    add('view-queued', 4);
    const snapshot = () => JSON.stringify(['continuity_policy', 'continuity_jobs', 'continuity_work'].map(table =>
      db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const before = snapshot();
    const rows = queue.listStatus(viewProject, 810);
    assert.deepEqual(rows.map(r => [r.id, r.status, r.attempts]), [['view-queued', 'queued', 0], ['view-running', 'running', 1],
      ['view-expired', 'expired', 1], ['view-failed', 'failed', 1], ['view-completed', 'completed', 1]]);
    for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['attempts', 'cut', 'id', 'sessionId', 'status', 'trigger'].sort());
    assert.equal(snapshot(), before);
    assert.deepEqual(queue.listStatus(other, 810), []); assert.throws(() => queue.listStatus(viewProject, -1), /time/);
    db.prepare('UPDATE continuity_policy SET allowed=0 WHERE session_id=?').run('view-completed');
    db.prepare('UPDATE continuity_policy SET generation=1 WHERE session_id=?').run('view-failed');
    db.prepare("UPDATE continuity_jobs SET status='cancelled' WHERE id=?").run('view-expired');
    assert.deepEqual(queue.listStatus(viewProject, 810).map(r => r.id), ['view-queued', 'view-running']);
    db.prepare('UPDATE continuity_policy SET project_id=? WHERE session_id=?').run(other, 'view-running');
    assert.deepEqual(queue.listStatus(viewProject, 810).map(r => r.id), ['view-queued']);
    assert.deepEqual(queue.listStatus(other, 810), [], 'policy-only project move cannot transfer old project evidence');
    for (let i = 0; i < 101; i++) add('view-bound-' + i, i + 10);
    assert.equal(queue.listStatus(viewProject, 810).length, 100);
    assert.equal(queue.listStatus(viewProject, 810)[0].cut, 110);
    db.prepare("UPDATE continuity_jobs SET trigger='forged-success' WHERE id=?").run('view-bound-100');
    assert.throws(() => queue.listStatus(viewProject, 810), /invalid continuity inventory/);
    db.prepare("UPDATE continuity_jobs SET trigger='turn-end' WHERE id=?").run('view-bound-100');
    db.prepare('UPDATE continuity_jobs SET id=? WHERE id=?').run('x'.repeat(257), 'view-bound-100');
    assert.throws(() => queue.listStatus(viewProject, 810), /invalid continuity inventory/);
  });
  console.log(`${n} PASS / 0 FAIL; private fixture=${dir}; main Sessions inventory NOT wired`);
} finally { store.close(); }
