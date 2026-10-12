#!/usr/bin/env node
// Exact summary-ledger schema/main-qualification regressions with private SQLite stores.
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  claimContinuitySummaryHumanV02,
  continuitySummaryLedgersReadyV02,
  continuitySummaryPolicyFingerprintV02,
  readContinuitySummaryPolicyEpochV02,
  CONTINUITY_SUMMARY_HUMAN_DDL,
  CONTINUITY_SUMMARY_POLICY_DDL,
  syncContinuitySummaryPolicyV02,
} from '../lib/continuity-summary-ledger-owner.js';

let passes = 0;
const check = (name, fn) => { fn(); passes++; console.log(`PASS ${name}`); };
const open = () => new DatabaseSync(':memory:');
const tx = (db, operation) => {
  db.exec('BEGIN IMMEDIATE');
  try { const value = operation(); db.exec('COMMIT'); return value; }
  catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
};
const snapshot = db => {
  const dbs = db.prepare('PRAGMA database_list').all();
  return dbs.map(({ name }) => {
    const schema = `"${name.replaceAll('"', '""')}"`;
    const objects = db.prepare(`SELECT type,name,tbl_name,sql FROM ${schema}.sqlite_schema ORDER BY type,name`).all();
    const rows = [];
    for (const table of ['continuity_summary_policy', 'continuity_summary_human']) {
      const exists = objects.some(object => object.type === 'table' && object.name === table);
      if (exists) rows.push([table, db.prepare(`SELECT * FROM ${schema}."${table}" ORDER BY 1`).all()]);
    }
    return [name, objects, rows];
  });
};
const addExactPolicy = (db, generation = 4, allowed = 1) => {
  db.exec(CONTINUITY_SUMMARY_POLICY_DDL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
  db.prepare('INSERT INTO main.continuity_summary_policy VALUES(1,?,?)').run(generation, allowed);
};
const addExactHuman = (db, row = ['session-1', 'pj-' + 'a'.repeat(32), 'b'.repeat(64), 0, 3]) => {
  db.exec(CONTINUITY_SUMMARY_HUMAN_DDL.replace('CREATE TABLE ', 'CREATE TABLE main.'));
  db.prepare('INSERT INTO main.continuity_summary_human VALUES(?,?,?,?,?)').run(...row);
};
const claim = (overrides = {}) => ({
  sessionId: 'session-1', projectId: 'pj-' + 'a'.repeat(32), headerHash: 'b'.repeat(64),
  inheritedFloor: 0, humanSeq: 3, generation: 0, ...overrides,
});

check('summary policy fingerprint is stable to order but changes for exclusions, route, and consent', () => {
  const input = { allowed: true, route: { provider: 'provider-a', model: 'model-a' },
    excludedSessionIds: ['session-b', 'session-a'], excludedProjectIds: ['project-b', 'project-a'] };
  const base = continuitySummaryPolicyFingerprintV02(input);
  assert.equal(base, JSON.stringify({ allowed: true, route: input.route,
    sessions: ['session-a', 'session-b'], projects: ['project-a', 'project-b'] }));
  assert.equal(continuitySummaryPolicyFingerprintV02({ ...input,
    excludedSessionIds: [...input.excludedSessionIds].reverse(), excludedProjectIds: [...input.excludedProjectIds].reverse() }), base);
  assert.notEqual(continuitySummaryPolicyFingerprintV02({ ...input, allowed: false }), base);
  assert.notEqual(continuitySummaryPolicyFingerprintV02({ ...input, route: { provider: 'provider-b', model: 'model-a' } }), base);
  assert.notEqual(continuitySummaryPolicyFingerprintV02({ ...input, excludedSessionIds: [...input.excludedSessionIds, 'session-c'] }), base);
  assert.notEqual(continuitySummaryPolicyFingerprintV02({ ...input, excludedProjectIds: [...input.excludedProjectIds, 'project-c'] }), base);
});

check('default-off empty store stays summary-ledger-free', () => {
  const db = open();
  try {
    assert.equal(tx(db, () => syncContinuitySummaryPolicyV02(db, false)), -1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM main.sqlite_schema WHERE name LIKE 'continuity_summary_%'").get().n, 0);
  } finally { db.close(); }
});

check('policy sync creates exact main DDL and increments safe consent generations', () => {
  const db = open();
  try {
    assert.equal(tx(db, () => syncContinuitySummaryPolicyV02(db, true)), 0);
    assert.equal(continuitySummaryLedgersReadyV02(db), true);
    assert.equal(db.prepare("SELECT sql FROM main.sqlite_schema WHERE type='table' AND name='continuity_summary_policy'").get().sql
      .replace(/\s+/g, ' ').trim(), CONTINUITY_SUMMARY_POLICY_DDL.replace(/\s+/g, ' ').trim());
    assert.deepEqual(db.prepare('SELECT id,generation,allowed FROM main.continuity_summary_policy').all()
      .map(row => [row.id, row.generation, row.allowed]), [[1, 0, 1]]);
    assert.equal(tx(db, () => syncContinuitySummaryPolicyV02(db, false)), 1);
    assert.deepEqual(db.prepare('SELECT id,generation,allowed FROM main.continuity_summary_policy').all()
      .map(row => [row.id, row.generation, row.allowed]), [[1, 1, 0]]);
  } finally { db.close(); }
});

check('durable consent epoch and human watermark survive file-backed database reopen', () => {
  const tempBase = resolve(tmpdir());
  const allocated = mkdtempSync(join(tempBase, 'dsh-summary-owner-reopen-'));
  const directory = realpathSync(allocated);
  assert.ok(directory.startsWith(tempBase + sep) && directory !== tempBase, 'cleanup target is the generated child of the temp root');
  const file = join(directory, 'memory.db');
  let db = new DatabaseSync(file);
  try {
    const generation = tx(db, () => syncContinuitySummaryPolicyV02(db, true));
    assert.equal(generation, 0);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation }))), true);
    const firstRow = db.prepare('SELECT * FROM main.continuity_summary_human WHERE session_id=?').get('session-1');
    assert.deepEqual([firstRow.project_id, firstRow.header_hash, firstRow.inherited_floor, firstRow.human_seq],
      ['pj-' + 'a'.repeat(32), 'b'.repeat(64), 0, 3]);
    db.close(); db = undefined;
    db = new DatabaseSync(file);
    assert.equal(readContinuitySummaryPolicyEpochV02(db), generation);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation }))), false,
      'a previously consumed human coordinate stays consumed after reopen');
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation, humanSeq: 4 }))), true,
      'a later fresh coordinate remains admissible');
    const reopenedRow = db.prepare('SELECT * FROM main.continuity_summary_human WHERE session_id=?').get('session-1');
    assert.deepEqual([reopenedRow.project_id, reopenedRow.header_hash, reopenedRow.inherited_floor, reopenedRow.human_seq],
      ['pj-' + 'a'.repeat(32), 'b'.repeat(64), 0, 4]);
  } finally {
    try { db?.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

check('human claim is generation-fenced, monotonic, and stores only body-free coordinates', () => {
  const db = open();
  try {
    const generation = tx(db, () => syncContinuitySummaryPolicyV02(db, true));
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation: generation + 1 }))), false);
    assert.equal(db.prepare("SELECT 1 FROM main.sqlite_schema WHERE name='continuity_summary_human'").get(), undefined);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation }))), true);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation }))), false);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation, humanSeq: 4 }))), true);
    const row = db.prepare('SELECT * FROM main.continuity_summary_human').get();
    assert.deepEqual([row.session_id, row.project_id, row.header_hash, row.inherited_floor, row.human_seq],
      ['session-1', 'pj-' + 'a'.repeat(32), 'b'.repeat(64), 0, 4]);
    assert.equal(Object.hasOwn(row, 'body'), false);
    assert.equal(tx(db, () => syncContinuitySummaryPolicyV02(db, false)), generation + 1);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation }))), false);
  } finally { db.close(); }
});

check('altered policy DDL refuses before generation or row writes', () => {
  const db = open();
  try {
    db.exec('CREATE TABLE main.continuity_summary_policy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,allowed INTEGER NOT NULL) STRICT; INSERT INTO main.continuity_summary_policy VALUES(1,9,1)');
    const before = snapshot(db);
    assert.throws(() => tx(db, () => syncContinuitySummaryPolicyV02(db, false)));
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

check('unsafe policy row refuses before consent mutation', () => {
  const db = open();
  try {
    addExactPolicy(db, 8, 1);
    db.exec('PRAGMA ignore_check_constraints=ON; UPDATE main.continuity_summary_policy SET allowed=2 WHERE id=1; PRAGMA ignore_check_constraints=OFF');
    const before = snapshot(db);
    assert.throws(() => tx(db, () => syncContinuitySummaryPolicyV02(db, false)));
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

check('extra policy index refuses before consent mutation', () => {
  const db = open();
  try {
    addExactPolicy(db, 8, 1);
    db.exec('CREATE INDEX main.bad_summary_policy_idx ON continuity_summary_policy(generation)');
    assert.equal(continuitySummaryLedgersReadyV02(db), false);
    const before = snapshot(db);
    assert.throws(() => tx(db, () => syncContinuitySummaryPolicyV02(db, false)));
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

check('custom direct or indirect trigger referencing a summary ledger refuses before writes', () => {
  for (const triggerSql of [
    'CREATE TRIGGER main.bad_summary_trigger AFTER UPDATE ON continuity_summary_policy BEGIN SELECT 1; END',
    'CREATE TABLE main.unrelated(x INTEGER); CREATE TRIGGER main.bad_indirect_summary_trigger AFTER INSERT ON unrelated BEGIN UPDATE continuity_summary_policy SET allowed=0 WHERE id=1; END',
  ]) {
    const db = open();
    try {
      addExactPolicy(db, 8, 1);
      db.exec(triggerSql);
      const before = snapshot(db);
      assert.throws(() => tx(db, () => syncContinuitySummaryPolicyV02(db, false)));
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  }
});

check('TEMP table shadow refuses before either main or TEMP rows change', () => {
  const db = open();
  try {
    addExactPolicy(db, 8, 1);
    db.exec('CREATE TEMP TABLE continuity_summary_policy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,allowed INTEGER NOT NULL) STRICT; INSERT INTO temp.continuity_summary_policy VALUES(1,91,0)');
    assert.equal(continuitySummaryLedgersReadyV02(db), false);
    const before = snapshot(db);
    assert.throws(() => tx(db, () => syncContinuitySummaryPolicyV02(db, false)));
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

check('altered human DDL and extra human index refuse before claim writes', () => {
  const reordered = open();
  try {
    addExactPolicy(reordered, 4, 1);
    reordered.exec(`CREATE TABLE main.continuity_summary_human (
      project_id TEXT NOT NULL, session_id TEXT PRIMARY KEY, header_hash TEXT NOT NULL,
      inherited_floor INTEGER NOT NULL, human_seq INTEGER NOT NULL
    ) STRICT`);
    reordered.prepare('INSERT INTO main.continuity_summary_human VALUES(?,?,?,?,?)')
      .run('pj-' + 'a'.repeat(32), 'session-1', 'b'.repeat(64), 0, 3);
    const before = snapshot(reordered);
    assert.throws(() => tx(reordered, () => claimContinuitySummaryHumanV02(reordered, claim({ generation: 4, humanSeq: 5 }))));
    assert.deepEqual(snapshot(reordered), before);
  } finally { reordered.close(); }
  const indexed = open();
  try {
    addExactPolicy(indexed, 4, 1); addExactHuman(indexed);
    indexed.exec('CREATE INDEX main.bad_summary_human_idx ON continuity_summary_human(human_seq)');
    const before = snapshot(indexed);
    assert.throws(() => tx(indexed, () => claimContinuitySummaryHumanV02(indexed, claim({ generation: 4, humanSeq: 5 }))));
    assert.deepEqual(snapshot(indexed), before);
  } finally { indexed.close(); }
});

check('TEMP trigger attached to main human ledger refuses before claim writes', () => {
  const db = open();
  try {
    addExactPolicy(db, 4, 1); addExactHuman(db);
    db.exec('CREATE TEMP TRIGGER bad_human_trigger AFTER UPDATE ON main.continuity_summary_human BEGIN SELECT 1; END');
    const before = snapshot(db);
    assert.throws(() => tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation: 4, humanSeq: 5 }))));
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

check('attached summary-ledger shadow refuses before main writes', () => {
  const db = open();
  try {
    addExactPolicy(db, 8, 1);
    db.exec("ATTACH DATABASE ':memory:' AS aux; CREATE TABLE aux.continuity_summary_policy(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL,allowed INTEGER NOT NULL) STRICT; INSERT INTO aux.continuity_summary_policy VALUES(1,91,0)");
    const before = snapshot(db);
    assert.throws(() => tx(db, () => syncContinuitySummaryPolicyV02(db, false)));
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

check('malformed matching human coordinates refuse before a new claim', () => {
  for (const row of [
    ['session-1', 'pj-' + 'a'.repeat(32), 'b'.repeat(64), -1, 3],
    ['session-1', 'pj-' + 'a'.repeat(32), 'b'.repeat(64), 4, 3],
    ['session-1', 'not-a-project', 'b'.repeat(64), 0, 3],
  ]) {
    const db = open();
    try {
      addExactPolicy(db, 4, 1); addExactHuman(db, row);
      const before = snapshot(db);
      assert.throws(() => tx(db, () => claimContinuitySummaryHumanV02(db, claim({ generation: 4, humanSeq: 5 }))));
      assert.deepEqual(snapshot(db), before);
    } finally { db.close(); }
  }
  const db = open();
  try {
    const unsafeSessionId = `session-1${String.fromCharCode(0)}hidden`;
    addExactPolicy(db, 4, 1); addExactHuman(db, [unsafeSessionId, 'pj-' + 'a'.repeat(32), 'b'.repeat(64), 0, 3]);
    const before = snapshot(db);
    assert.equal(tx(db, () => claimContinuitySummaryHumanV02(db, claim({ sessionId: unsafeSessionId, generation: 4, humanSeq: 5 }))), false);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});

console.log(`${passes} PASS / 0 FAIL; private in-memory and isolated file-backed SQLite fixtures`);
