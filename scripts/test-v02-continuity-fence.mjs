#!/usr/bin/env node
// Actual SQLite policy-only fence gates; no capability/source/provider required.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MemoryStore } from '../lib/storage.js';
import { fenceExistingContinuity } from '../lib/continuity-store-v02.js';

const V02_DDL = {
  continuity_policy: `CREATE TABLE IF NOT EXISTS continuity_policy (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK(generation>=0), allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
  ) STRICT`,
  continuity_checkpoint: `CREATE TABLE IF NOT EXISTS continuity_checkpoint (
    session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, generation INTEGER NOT NULL,
    cut INTEGER NOT NULL CHECK(cut>=-1), source_hash TEXT NOT NULL, envelope TEXT NOT NULL
  ) STRICT`,
  continuity_jobs: `CREATE TABLE IF NOT EXISTS continuity_jobs (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
    generation INTEGER NOT NULL, cut INTEGER NOT NULL CHECK(cut>=-1), source_hash TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN('turn-end','pause','finish')),
    status TEXT NOT NULL CHECK(status IN('pending','cancelled')),
    UNIQUE(session_id,generation,cut,source_hash,trigger)
  ) STRICT`,
};
mkdirSync('.tmp-import-lane', { recursive: true });
let n = 0;
const check = (name, fn) => { fn(); console.log('PASS ' + name); n++; };
const open = name => {
  const dir = mkdtempSync(`.tmp-import-lane/${name}-`);
  const store = new MemoryStore(join(dir, 'data'));
  return { dir, store, db: store.getJournalSqlite() };
};
const createSchema = (db, overrides = {}) => db.exec(Object.values({ ...V02_DDL, ...overrides }).join(';\n'));
const seed = (db, jobStatus = 'pending') => {
  db.prepare('INSERT INTO main.continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,?)').run('prior', 'project', 3, 1);
  db.prepare('INSERT INTO main.continuity_checkpoint(session_id,project_id,generation,cut,source_hash,envelope) VALUES(?,?,?,?,?,?)')
    .run('prior', 'project', 3, 0, 'opaque', '{}');
  db.prepare('INSERT INTO main.continuity_jobs(id,session_id,project_id,generation,cut,source_hash,trigger,status) VALUES(?,?,?,?,?,?,?,?)')
    .run('job', 'prior', 'project', 3, 0, 'opaque', 'turn-end', jobStatus);
};
const snapshot = db => ({
  policy: { ...db.prepare('SELECT session_id,project_id,generation,allowed FROM main.continuity_policy').get() },
  checkpoint: { ...db.prepare('SELECT session_id,project_id,generation,cut,source_hash,envelope FROM main.continuity_checkpoint').get() },
  job: { ...db.prepare('SELECT id,session_id,project_id,generation,cut,source_hash,trigger,status FROM main.continuity_jobs').get() },
});
const expectDriftRefusal = (label, overrides = {}, extraSetup = () => {}, jobStatus = 'pending') => {
  const fixture = open('continuity-fence-drift');
  try {
    createSchema(fixture.db, overrides);
    seed(fixture.db, jobStatus);
    extraSetup(fixture.db);
    const before = snapshot(fixture.db);
    check(label, () => {
      assert.throws(() => fenceExistingContinuity(fixture.store, false, [], []), /incompatible/);
      assert.deepEqual(snapshot(fixture.db), before);
    });
  } finally { fixture.store.close(); }
};

const fixture = open('continuity-fence');
const { store, db, dir } = fixture;
const count = table => Number(db.prepare(`SELECT COUNT(*) AS n FROM main.${table}`).get().n);
try {
  check('absent namespace is inert and never creates tables or grants source access', () => {
    fenceExistingContinuity(store, false, [], []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE 'continuity_%'").get().n, 0);
  });
  db.exec(V02_DDL.continuity_policy);
  db.prepare('INSERT INTO main.continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,?)').run('prior', 'project', 3, 1);
  check('partial schema refuses writes rather than inventing migrations or claiming cleanup', () => {
    assert.throws(() => fenceExistingContinuity(store, false, [], []), /incompatible/);
    assert.equal(db.prepare('SELECT allowed FROM main.continuity_policy').get().allowed, 1);
  });
  db.exec('DROP TABLE continuity_policy');
  createSchema(db);
  seed(db);
  db.exec("CREATE TRIGGER refuse_cancel BEFORE UPDATE ON continuity_jobs BEGIN SELECT RAISE(ABORT,'synthetic cancellation failure'); END");
  const beforeTriggerFence = snapshot(db);
  check('trigger-bearing schema is rejected before policy, checkpoint, or job writes', () => {
    assert.throws(() => fenceExistingContinuity(store, false, [], []), /incompatible/);
    assert.deepEqual(snapshot(db), beforeTriggerFence);
  });
  db.exec('DROP TRIGGER refuse_cancel');
  check('exact v2 schema fences only the selected project and reenable does not resurrect work', () => {
    fenceExistingContinuity(store, true, ['unrelated'], []);
    assert.equal(count('continuity_checkpoint'), 1);
    fenceExistingContinuity(store, true, [], ['project']);
    assert.equal(db.prepare('SELECT allowed FROM main.continuity_policy').get().allowed, 0);
    assert.equal(db.prepare('SELECT status FROM main.continuity_jobs').get().status, 'cancelled');
    assert.equal(count('continuity_checkpoint'), 0);
    fenceExistingContinuity(store, false, [], []);
    assert.equal(db.prepare('SELECT generation FROM main.continuity_policy').get().generation, 4);
  });
} finally { store.close(); }

const reorderedPolicy = `CREATE TABLE IF NOT EXISTS continuity_policy (
  project_id TEXT NOT NULL, session_id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL CHECK(generation>=0), allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
) STRICT`;
expectDriftRefusal('reordered required columns fail before writes', { continuity_policy: reorderedPolicy });

const extraColumnPolicy = `CREATE TABLE IF NOT EXISTS continuity_policy (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0), allowed INTEGER NOT NULL CHECK(allowed IN(0,1)),
  unexpected TEXT NOT NULL DEFAULT ''
) STRICT`;
expectDriftRefusal('extra column fails before writes', { continuity_policy: extraColumnPolicy });

const uppercasePolicy = `CREATE TABLE IF NOT EXISTS CONTINUITY_POLICY (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0), allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
) STRICT`;
expectDriftRefusal('case-insensitive main table name is detected and refused before writes', { continuity_policy: uppercasePolicy });

const widenedStatusJobs = `CREATE TABLE IF NOT EXISTS continuity_jobs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
  generation INTEGER NOT NULL, cut INTEGER NOT NULL CHECK(cut>=-1), source_hash TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN('turn-end','pause','finish')),
  status TEXT NOT NULL CHECK(status IN('pending','cancelled','legacy')),
  UNIQUE(session_id,generation,cut,source_hash,trigger)
) STRICT`;
expectDriftRefusal('altered CHECK constraint fails before writes', { continuity_jobs: widenedStatusJobs });

const caseShiftedTriggerJobs = `CREATE TABLE IF NOT EXISTS continuity_jobs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, project_id TEXT NOT NULL,
  generation INTEGER NOT NULL, cut INTEGER NOT NULL CHECK(cut>=-1), source_hash TEXT NOT NULL,
  trigger TEXT NOT NULL CHECK(trigger IN('turn-end','PAUSE','finish')),
  status TEXT NOT NULL CHECK(status IN('pending','cancelled')),
  UNIQUE(session_id,generation,cut,source_hash,trigger)
) STRICT`;
expectDriftRefusal('case-sensitive CHECK literals are not normalized into a match', { continuity_jobs: caseShiftedTriggerJobs });
expectDriftRefusal('custom index fails before writes', {}, db => db.exec('CREATE INDEX injected_scope ON continuity_policy(project_id)'));
expectDriftRefusal('TEMP trigger attached to a main table fails before writes', {}, db => db.exec("CREATE TEMP TRIGGER injected_temp BEFORE UPDATE ON main.continuity_jobs BEGIN SELECT RAISE(ABORT,'temp trigger ran'); END"));
const tempShadowPolicy = `CREATE TEMP TABLE CONTINUITY_POLICY (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>=0), allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
) STRICT`;
expectDriftRefusal('case-insensitive TEMP table shadowing a main policy name fails before writes', {}, db => db.exec(tempShadowPolicy));
const tempOnly = open('continuity-fence-temp-only');
try {
  tempOnly.db.exec(tempShadowPolicy);
  check('TEMP-only uppercase continuity namespace is rejected without creating main tables', () => {
    assert.throws(() => fenceExistingContinuity(tempOnly.store, false, [], []), /incompatible/);
    assert.equal(tempOnly.db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type='table' AND name IN ('continuity_policy','continuity_checkpoint','continuity_jobs')").get().n, 0);
  });
} finally { tempOnly.store.close(); }

console.log(`${n} PASS / 0 FAIL; primary fixture=${dir}`);
