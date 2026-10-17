#!/usr/bin/env node
// V3 schema owner, read-only classifier, and private in-memory SQLite regression fixtures.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { classifyContinuitySchemaV03 } from '../lib/continuity-schema-v03.js';
import { preflightContinuityV2RowsV03, preflightContinuityV03Rows } from '../lib/continuity-v03-row-preflight.js';
import { ensureContinuitySchemaV03, ensureContinuityWorkerPairV03 } from '../lib/continuity-owner-v03.js';
import { consumeContinuityV03OfflineAuthorization, runContinuityV03OfflineMigration, validateContinuityV03OfflineStoreTarget } from '../lib/continuity-offline-migrator-v03.js';
import { CONTINUITY_V03_MARKER_DDL, CONTINUITY_V03_HUMAN_BOUNDARY_DDL, CONTINUITY_V03_ACTIVE_DDL, CONTINUITY_V03_LEGACY_ARCHIVE_DDL, CONTINUITY_V03_DDL_FINGERPRINT, CONTINUITY_V03_FINGERPRINT_TEMPLATES, CONTINUITY_V03_FINGERPRINT_TABLES, continuitySchemaFingerprintV03, isSafeContinuityV03PolicyDbRow, isSafeContinuityV03SessionId, isSafeContinuityV03HumanBoundaryDbRow } from '../lib/continuity-schema-contract-v03.js';
import { CONTINUITY_V02_DDL } from '../lib/continuity-store-v02.js';
import { CONTINUITY_WORK_V02_DDL } from '../lib/continuity-work-v02.js';
import { CONTINUITY_HANDOFF_V02_DDL } from '../lib/continuity-handoff-v02.js';
import { continuityCanonicalDigest as digest } from '../lib/continuity-checkpoint-v02.js';
import { initContinuityProjectionV03, applyContinuityProjectionV03 } from '../lib/continuity-projection-v03.js';
import { continuitySourceHashV03, parseContinuityCheckpointEnvelopeV03 } from '../lib/continuity-envelope-v03.js';
import { ContinuityWorkV03 } from '../lib/continuity-work-v03.js';
import { ContinuityPolicyV03 } from '../lib/continuity-policy-v03.js';
import { ContinuityBoundaryV03 } from '../lib/continuity-boundary-v03.js';

const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit validated DSH_RUNTIME_RC2 required for the exact checkpoint Zod schema');
const zodDir = join(runtime, 'node_modules/zod');
assert.equal(JSON.parse(readFileSync(join(zodDir, 'package.json'), 'utf8')).version, '4.4.3');
const z = await import(pathToFileURL(join(zodDir, 'index.js')).href);

let passes = 0;
const check = (name, fn) => { fn(); passes++; console.log(`PASS ${name}`); };
const open = () => new DatabaseSync(':memory:');
const createCore = db => db.exec(Object.values(CONTINUITY_V02_DDL).join(';\n'));
const createV2 = (db, workerPair = false) => {
  createCore(db);
  if (workerPair) db.exec(`${CONTINUITY_WORK_V02_DDL};\n${CONTINUITY_HANDOFF_V02_DDL}`);
};
const createFreshV3 = (db, { origin = 'fresh', archive = 'none', fingerprint = CONTINUITY_V03_DDL_FINGERPRINT, addArchiveTables = true } = {}) => {
  for (const table of CONTINUITY_V03_FINGERPRINT_TABLES) {
    if (table === 'continuity_work' || table === 'continuity_handoff') continue;
    db.exec(CONTINUITY_V03_ACTIVE_DDL[table]);
  }
  if (origin === 'v2-cutover' && addArchiveTables) {
    if (archive === 'jobs-only' || archive === 'jobs-and-handoffs') db.exec(CONTINUITY_V03_LEGACY_ARCHIVE_DDL.continuity_jobs_legacy_v2);
    if (archive === 'jobs-and-handoffs') db.exec(CONTINUITY_V03_LEGACY_ARCHIVE_DDL.continuity_handoff_legacy_v2);
  }
  db.exec(CONTINUITY_V03_MARKER_DDL);
  db.prepare('INSERT INTO continuity_schema_meta VALUES(1,1,3,?,?,?)').run(origin, archive, fingerprint);
};
const memoryStore = (db, failAfterOperation = false, alreadyInsideTransaction = false) => {
  let inTransaction = alreadyInsideTransaction;
  return {
    getJournalSqlite: () => db,
    isInsideTransaction: () => inTransaction,
    close() {},
    runInImmediateTransaction(operation) {
      db.exec('BEGIN IMMEDIATE');
      inTransaction = true;
      try {
        const value = operation();
        if (failAfterOperation) throw new Error('injected commit failure');
        db.exec('COMMIT');
        return value;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { inTransaction = false; }
    },
  };
};
const summaryDdl = `CREATE TABLE continuity_summary_policy (
  id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL CHECK(generation>=0),
  allowed INTEGER NOT NULL CHECK(allowed IN(0,1))
) STRICT;
CREATE TABLE continuity_summary_human (
  session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, header_hash TEXT NOT NULL,
  inherited_floor INTEGER NOT NULL, human_seq INTEGER NOT NULL
) STRICT`;
const project = 'pj-' + 'a'.repeat(32), hash = 'a'.repeat(64), token = '11111111-1111-1111-1111-111111111111';
const rootEnvelopeFixture = ({ sessionId = 'session', projectId = project, generation = 1 } = {}) => {
  const header = { version: 4, id: sessionId, createdAt: 1, cwd: '/synthetic/v3-project', isSeeded: false, delegationDepth: 0 };
  const event = { type: 'user/message', seq: 0, time: 1, data: { role: 'user', source: { kind: 'user' }, content: [] } };
  const child = { sessionKey: digest(sessionId), headerHash: digest(header), inheritedEventCount: 0, selectedCut: 0,
    selectedSourceHash: digest({ bindingVersion: 3, header, inheritedEventCount: 0, events: [event] }) };
  const lineagePayload = { format: 2, bindingVersion: 3, projectId, child, edges: [], rootSessionKey: child.sessionKey };
  const lineage = { ...lineagePayload, bindingHash: digest(lineagePayload) };
  const sourceHash = continuitySourceHashV03(sessionId, projectId, 0, 'root', child.selectedSourceHash, lineage.bindingHash);
  const row = { ver: 2, seq: 0, val: applyContinuityProjectionV03(initContinuityProjectionV03(header, 0), event) };
  const envelope = { checkpointFormat: 2, sourceBindingVersion: 3, sessionId, projectId, generation,
    headerHash: child.headerHash, inheritedEventCount: 0, asOfSeq: 0, selectedSourceHash: child.selectedSourceHash,
    sourceHash, lineageKind: 'root',
    lineageHash: lineage.bindingHash, lineage, row };
  return { envelope, sourceHash, lineage, row };
};
const forkEnvelopeFixture = ({ sessionId = 'fork-child', parentId = 'parent-session', projectId = project, generation = 1 } = {}) => {
  const parentHeader = { version: 4, id: parentId, createdAt: 1, cwd: '/synthetic/v3-project', isSeeded: false, delegationDepth: 0 };
  const header = { version: 4, id: sessionId, createdAt: 2, cwd: '/synthetic/v3-project', isSeeded: true,
    parentSession: parentId, delegationDepth: 0 };
  const parentEvent = { type: 'user/message', seq: 0, time: 1, data: { role: 'user', source: { kind: 'user' }, content: [] } };
  const childEvents = [parentEvent,
    { type: 'session/end-seed', seq: 1, time: 2, data: { inherited: true } },
    { type: 'user/message', seq: 2, time: 3, data: { role: 'user', source: { kind: 'user' }, content: [] } }];
  const child = { sessionKey: digest(sessionId), headerHash: digest(header), inheritedEventCount: 1, selectedCut: 2,
    selectedSourceHash: digest({ bindingVersion: 3, header, inheritedEventCount: 1, events: childEvents }) };
  const edges = [{ childSessionKey: digest(sessionId), parentSessionKey: digest(parentId), childHeaderHash: digest(header),
    parentHeaderHash: digest(parentHeader), childInheritedEventCount: 1, parentInheritedEventCount: 0,
    copiedPrefixCut: 0, copiedPrefixHash: digest([parentEvent]) }];
  const lineagePayload = { format: 2, bindingVersion: 3, projectId, child, edges, rootSessionKey: digest(parentId) };
  const lineage = { ...lineagePayload, bindingHash: digest(lineagePayload) };
  const sourceHash = continuitySourceHashV03(sessionId, projectId, 2, 'fork', child.selectedSourceHash, lineage.bindingHash);
  const state = childEvents.reduce(applyContinuityProjectionV03, initContinuityProjectionV03(header, 1));
  const row = { ver: 2, seq: 2, val: state };
  const envelope = { checkpointFormat: 2, sourceBindingVersion: 3, sessionId, projectId, generation,
    headerHash: child.headerHash, inheritedEventCount: 1, asOfSeq: 2, selectedSourceHash: child.selectedSourceHash,
    sourceHash, lineageKind: 'fork',
    lineageHash: lineage.bindingHash, lineage, row };
  return { envelope, sourceHash, lineage, row };
};
const insertV3Checkpoint = (db, fixture) => {
  const envelope = fixture.envelope;
  db.prepare(`INSERT INTO continuity_checkpoint(session_id,project_id,generation,cut,source_hash,checkpoint_format,
    source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,envelope)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(envelope.sessionId, envelope.projectId, envelope.generation, envelope.asOfSeq,
      envelope.sourceHash, envelope.checkpointFormat, envelope.sourceBindingVersion, envelope.selectedSourceHash,
      envelope.lineage.format, envelope.lineage.bindingVersion, envelope.lineageKind, envelope.lineageHash, JSON.stringify(envelope));
};
const v3JobFixture = (fixture, { id = '33333333-3333-3333-3333-333333333333', ...overrides } = {}) => ({
  id, sessionId: fixture.envelope.sessionId, projectId: fixture.envelope.projectId,
  generation: fixture.envelope.generation, cut: fixture.envelope.asOfSeq, sourceHash: fixture.sourceHash,
  checkpointFormat: 2, sourceBindingVersion: 3, selectedSourceHash: fixture.lineage.child.selectedSourceHash,
  lineageFormat: 2, lineageBindingVersion: 3,
  lineageKind: fixture.envelope.lineageKind, lineageHash: fixture.lineage.bindingHash,
  trigger: 'turn-end', status: 'pending', ...overrides,
});
const insertV3Job = (db, job) => db.prepare(`INSERT INTO continuity_jobs(id,session_id,project_id,generation,cut,source_hash,
  checkpoint_format,source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,trigger,status)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.sessionId, job.projectId, job.generation, job.cut, job.sourceHash,
    job.checkpointFormat, job.sourceBindingVersion, job.selectedSourceHash, job.lineageFormat, job.lineageBindingVersion,
    job.lineageKind, job.lineageHash, job.trigger, job.status);
const handoffFixture = job => ({ jobId: job.id, sessionId: job.sessionId, projectId: job.projectId,
  generation: job.generation, cut: job.cut, sourceHash: job.sourceHash, checkpointFormat: job.checkpointFormat,
  sourceBindingVersion: job.sourceBindingVersion, selectedSourceHash: job.selectedSourceHash,
  lineageFormat: job.lineageFormat, lineageBindingVersion: job.lineageBindingVersion,
  lineageKind: job.lineageKind, lineageHash: job.lineageHash,
  notes: ['untrusted synthetic note'], uncertain: true });
const offlineArgs = (storeRoot = '/private/continuity-v3-test') => [
  '--offline-approved', '--exclusive-owner-confirmed', '--backup-confirmed', '--store-root', storeRoot,
];
const authorizeOffline = (storeRoot = '/private/continuity-v3-test') => {
  const args = offlineArgs(storeRoot);
  const parsed = consumeContinuityV03OfflineAuthorization(args);
  assert.equal(parsed.kind, 'authorized');
  assert.deepEqual(args, [], 'launcher flags and target are consumed');
  return parsed.authorization;
};
const seedV2 = (db, workerPair = false) => {
  db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 4, 1);
  const checkpointEnvelope = JSON.stringify({ format: 1, sessionId: 'session', headerHash: hash,
    inheritedEventCount: 0, asOfSeq: 0, sourceHash: hash,
    row: { ver: 1, seq: 0, val: { version: 1, inheritedEventCount: 0, delegated: false,
      lastOwnSeq: 0, lastHumanSeq: 0, lastBoundarySeq: -1, turnState: 'completed',
      pendingCalls: [], recentExecutions: [], coverageIncomplete: false, unmatchedResults: 0 } } });
  db.prepare('INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?)').run('session', project, 4, 0, hash, checkpointEnvelope);
  db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?)').run('job', 'session', project, 4, 0, hash, 'turn-end', 'pending');
  if (workerPair) {
    db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)').run('job', token, 100, 1, 'completed');
    const payload = JSON.stringify({ jobId: 'job', sessionId: 'session', projectId: project,
      generation: 4, cut: 0, sourceHash: hash, notes: ['bounded note'], uncertain: true });
    db.prepare('INSERT INTO continuity_handoff VALUES(?,?,?,?,?,?,?)').run('job', 'session', project, 4, 0, hash, payload);
  }
};
function snapshot(db) {
  const objects = {};
  const rows = {};
  const schemas = db.prepare('PRAGMA database_list').all().map(entry => entry.name);
  for (const schema of schemas) {
    const quotedSchema = schema.replaceAll('"', '""');
    objects[schema] = db.prepare(`SELECT type,name,tbl_name,sql FROM "${quotedSchema}".sqlite_schema ORDER BY type,name`).all();
    rows[schema] = [];
    for (const object of objects[schema]) {
      if (object.type !== 'table' || /^sqlite_/i.test(object.name)) continue;
      const name = object.name.replaceAll('"', '""');
      const statement = db.prepare(`SELECT * FROM "${quotedSchema}"."${name}"`);
      statement.setReadBigInts(true);
      rows[schema].push([object.name, statement.all()]);
    }
  }
  return { objects, rows };
}
function seedUnrelatedSentinel(db) {
  db.exec('CREATE TABLE ordinary_sentinel (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT');
  db.prepare('INSERT INTO ordinary_sentinel VALUES(1,?)').run('unchanged');
}
function classifyUnchanged(name, setup, expected) {
  const db = open();
  try {
    setup(db); seedUnrelatedSentinel(db);
    const before = snapshot(db);
    assert.deepEqual(classifyContinuitySchemaV03(db), expected, name);
    assert.deepEqual(snapshot(db), before, `${name}: classifier changed schema or rows`);
  } finally { db.close(); }
}
function preflightUnchanged(name, setup, expected) {
  const db = open();
  try {
    setup(db); seedUnrelatedSentinel(db);
    const before = snapshot(db);
    assert.deepEqual(preflightContinuityV2RowsV03(db, z), expected, name);
    assert.deepEqual(snapshot(db), before, `${name}: row preflight changed schema or rows`);
  } finally { db.close(); }
}

check('brand-new store is Empty and its schema/rows remain unchanged', () => {
  classifyUnchanged('empty', () => {}, { kind: 'empty', summaryLedgersPresent: false });
});
check('summary-ledger-only store is Empty and classifier leaves those rows untouched', () => {
  classifyUnchanged('summary-only', db => {
    db.exec(summaryDdl);
    db.prepare('INSERT INTO continuity_summary_policy VALUES(1,7,0)').run();
    db.prepare('INSERT INTO continuity_summary_human VALUES(?,?,?,?,?)').run('s', 'p', 'h', -1, 2);
  }, { kind: 'empty', summaryLedgersPresent: true });
});
check('exact v2 core with absent worker pair is Legacy v2 and read-only', () => {
  classifyUnchanged('v2-no-pair', db => { createV2(db); seedV2(db); }, { kind: 'legacy-v2-schema', workerPair: 'absent', summaryLedgersPresent: false });
});
check('exact v2 core plus exact worker/handoff pair is Legacy v2 and read-only', () => {
  classifyUnchanged('v2-pair', db => { createV2(db, true); seedV2(db, true); }, { kind: 'legacy-v2-schema', workerPair: 'present', summaryLedgersPresent: false });
});
check('safe exact v2 rows pass the read-only preflight for either worker-pair state', () => {
  preflightUnchanged('safe-v2-no-pair', db => { createV2(db); seedV2(db); },
    { kind: 'safe-v2-row-preflight', workerPair: 'absent', counts: { policies: 1, checkpoints: 1, jobs: 1, work: 0, handoffs: 0 } });
  preflightUnchanged('safe-v2-pair', db => { createV2(db, true); seedV2(db, true); },
    { kind: 'safe-v2-row-preflight', workerPair: 'present', counts: { policies: 1, checkpoints: 1, jobs: 1, work: 1, handoffs: 1 } });
});
check('checkpoint coordinates, policy anchor, strict envelope and size are preflighted read-only', () => {
  preflightUnchanged('checkpoint-generation-overflow', db => {
    createV2(db); seedV2(db); db.prepare('UPDATE continuity_checkpoint SET generation=?').run(Number.MAX_SAFE_INTEGER);
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-row' });
  preflightUnchanged('checkpoint-policy-mismatch', db => {
    createV2(db); seedV2(db); db.exec('UPDATE continuity_checkpoint SET generation=3');
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-row' });
  preflightUnchanged('checkpoint-cut-overflow', db => {
    createV2(db); seedV2(db); db.exec('UPDATE continuity_checkpoint SET cut=9007199254740992');
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-row' });
  preflightUnchanged('checkpoint-malformed-json', db => {
    createV2(db); seedV2(db); db.prepare('UPDATE continuity_checkpoint SET envelope=?').run('not-json');
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-envelope' });
  preflightUnchanged('checkpoint-malformed-shape', db => {
    createV2(db); seedV2(db); db.prepare('UPDATE continuity_checkpoint SET envelope=?').run('{}');
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-envelope' });
  preflightUnchanged('checkpoint-envelope-cut-mismatch', db => {
    createV2(db); seedV2(db);
    const envelope = JSON.parse(db.prepare('SELECT envelope FROM continuity_checkpoint').get().envelope);
    envelope.asOfSeq = 1; envelope.row.seq = 1;
    db.prepare('UPDATE continuity_checkpoint SET envelope=?').run(JSON.stringify(envelope));
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-envelope' });
  preflightUnchanged('checkpoint-oversized-envelope', db => {
    createV2(db); seedV2(db); db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE continuity_checkpoint SET envelope=?').run('x'.repeat(24001));
    db.exec('PRAGMA ignore_check_constraints=OFF');
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-envelope' });
});
check('policy generation at the increment boundary refuses without changing any table', () => {
  preflightUnchanged('policy-generation-overflow', db => {
    createV2(db); seedV2(db); db.prepare('UPDATE continuity_policy SET generation=?').run(Number.MAX_SAFE_INTEGER);
  }, { kind: 'refuse', reason: 'unsafe-v2-policy-row' });
});
check('legacy rows with embedded-NUL text refuse the v3 cutover preflight', () => {
  const nulTail = value => value + String.fromCharCode(0) + 'tail';
  preflightUnchanged('policy-session-id-nul', db => {
    createV2(db); db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run(nulTail('session'), project, 0, 0);
  }, { kind: 'refuse', reason: 'unsafe-v2-policy-row' });
  preflightUnchanged('job-id-nul', db => {
    createV2(db); db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?)').run(nulTail('job'), 'session', project, 0, 0, hash, 'turn-end', 'cancelled');
  }, { kind: 'refuse', reason: 'unsafe-v2-job-row' });
  preflightUnchanged('job-hash-nul', db => {
    createV2(db); seedV2(db); db.prepare('UPDATE continuity_jobs SET source_hash=?').run(nulTail(hash));
  }, { kind: 'refuse', reason: 'unsafe-v2-job-row' });
  preflightUnchanged('checkpoint-envelope-nul', db => {
    createV2(db); seedV2(db); db.prepare('UPDATE continuity_checkpoint SET envelope=?').run(nulTail(db.prepare('SELECT envelope FROM continuity_checkpoint').get().envelope));
  }, { kind: 'refuse', reason: 'unsafe-v2-checkpoint-envelope' });
  preflightUnchanged('work-token-nul', db => {
    createV2(db, true); seedV2(db, true); db.prepare('UPDATE continuity_work SET token=?').run(nulTail(token));
  }, { kind: 'refuse', reason: 'unsafe-v2-work-row' });
  preflightUnchanged('handoff-payload-nul', db => {
    createV2(db, true); seedV2(db, true); db.prepare('UPDATE continuity_handoff SET payload=?').run(nulTail(db.prepare('SELECT payload FROM continuity_handoff').get().payload));
  }, { kind: 'refuse', reason: 'unsafe-v2-handoff-payload' });
});
check('negative job generation and malformed source hash refuse', () => {
  preflightUnchanged('negative-job-generation', db => {
    createV2(db); seedV2(db); db.exec('UPDATE continuity_jobs SET generation=-1');
  }, { kind: 'refuse', reason: 'unsafe-v2-job-row' });
  preflightUnchanged('malformed-job-hash', db => {
    createV2(db); seedV2(db); db.exec("UPDATE continuity_jobs SET source_hash='not-a-hash'");
  }, { kind: 'refuse', reason: 'unsafe-v2-job-row' });
});
check('orphan work, invalid token, attempts, and unsafe lease refuse without writes', () => {
  preflightUnchanged('orphan-work', db => {
    createV2(db, true); seedV2(db, true); db.prepare('DELETE FROM continuity_jobs WHERE id=?').run('job');
  }, { kind: 'refuse', reason: 'unsafe-v2-work-row' });
  preflightUnchanged('bad-work-token', db => {
    createV2(db, true); seedV2(db, true); db.exec("UPDATE continuity_work SET token='not-a-uuid'");
  }, { kind: 'refuse', reason: 'unsafe-v2-work-row' });
  preflightUnchanged('unsafe-lease', db => {
    createV2(db, true); seedV2(db, true); db.exec('UPDATE continuity_work SET lease_deadline=9007199254740992');
  }, { kind: 'refuse', reason: 'unsafe-v2-work-row' });
  preflightUnchanged('invalid-attempts', db => {
    createV2(db, true); seedV2(db, true); db.exec('PRAGMA ignore_check_constraints=ON; UPDATE continuity_work SET attempts=4; PRAGMA ignore_check_constraints=OFF');
  }, { kind: 'refuse', reason: 'unsafe-v2-work-row' });
});
check('mismatched/orphan handoffs and malformed strict-v2 payloads refuse', () => {
  preflightUnchanged('mismatched-handoff-anchor', db => {
    createV2(db, true); seedV2(db, true); db.exec('UPDATE continuity_handoff SET generation=5');
  }, { kind: 'refuse', reason: 'unsafe-v2-handoff-row' });
  preflightUnchanged('orphan-handoff', db => {
    createV2(db, true); seedV2(db, true); db.prepare('DELETE FROM continuity_work WHERE job_id=?').run('job');
  }, { kind: 'refuse', reason: 'unsafe-v2-handoff-row' });
  preflightUnchanged('malformed-handoff', db => {
    createV2(db, true); seedV2(db, true); db.prepare('UPDATE continuity_handoff SET payload=?').run('not-json');
  }, { kind: 'refuse', reason: 'unsafe-v2-handoff-payload' });
  preflightUnchanged('oversized-handoff', db => {
    createV2(db, true); seedV2(db, true);
    db.exec('PRAGMA ignore_check_constraints=ON');
    db.prepare('UPDATE continuity_handoff SET payload=?').run('x'.repeat(4001));
    db.exec('PRAGMA ignore_check_constraints=OFF');
  }, { kind: 'refuse', reason: 'unsafe-v2-handoff-payload' });
});
check('partial core refuses without mutation', () => {
  classifyUnchanged('partial-core', db => db.exec(CONTINUITY_V02_DDL.continuity_policy),
    { kind: 'refuse', reason: 'partial-v2-core' });
});
check('split v2 worker/handoff pair refuses without mutation', () => {
  classifyUnchanged('split-pair', db => { createV2(db); db.exec(CONTINUITY_WORK_V02_DDL); },
    { kind: 'refuse', reason: 'split-v2-worker-pair' });
});
check('altered v2 worker DDL refuses without mutation', () => {
  classifyUnchanged('worker-drift', db => {
    createV2(db);
    const alteredWork = CONTINUITY_WORK_V02_DDL.replace(
      'attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3),',
      'attempts INTEGER NOT NULL CHECK(attempts BETWEEN 1 AND 3), extra TEXT NOT NULL,');
    db.exec(alteredWork);
    db.exec(CONTINUITY_HANDOFF_V02_DDL);
  }, { kind: 'refuse', reason: 'v2-worker-schema-mismatch' });
});
check('altered core DDL refuses before any row or schema write', () => {
  classifyUnchanged('altered-core', db => {
    const altered = CONTINUITY_V02_DDL.continuity_policy.replace('generation>=0', 'generation>0');
    db.exec(altered); db.exec(CONTINUITY_V02_DDL.continuity_checkpoint); db.exec(CONTINUITY_V02_DDL.continuity_jobs);
    seedV2(db);
  }, { kind: 'refuse', reason: 'v2-core-schema-mismatch' });
});
check('unknown continuity namespace object refuses', () => {
  classifyUnchanged('unknown-object', db => db.exec('CREATE TABLE continuity_unrecognized (id INTEGER PRIMARY KEY) STRICT'),
    { kind: 'refuse', reason: 'unknown-or-attached-object' });
});
check('attached databases are inventoried and continuity objects refuse', () => {
  classifyUnchanged('attached-continuity', db => {
    db.exec("ATTACH DATABASE ':memory:' AS auxiliary");
    db.exec('CREATE TABLE auxiliary.continuity_unrecognized (id INTEGER PRIMARY KEY) STRICT');
  }, { kind: 'refuse', reason: 'unknown-or-attached-object' });
});
check('case-variant main name refuses', () => {
  classifyUnchanged('case-variant', db => db.exec('CREATE TABLE CONTINUITY_POLICY (id INTEGER PRIMARY KEY) STRICT'),
    { kind: 'refuse', reason: 'noncanonical-object-name' });
});
check('TEMP shadow refuses', () => {
  classifyUnchanged('temp-shadow', db => { createV2(db); db.exec('CREATE TEMP TABLE continuity_policy (id INTEGER PRIMARY KEY) STRICT'); },
    { kind: 'refuse', reason: 'temp-continuity-object' });
});
check('custom index attached to continuity table refuses', () => {
  classifyUnchanged('custom-index', db => { createV2(db); db.exec('CREATE INDEX custom_policy_idx ON continuity_policy(project_id)'); },
    { kind: 'refuse', reason: 'unknown-or-attached-object' });
});
check('custom trigger attached to continuity table refuses', () => {
  classifyUnchanged('custom-trigger', db => { createV2(db); db.exec('CREATE TRIGGER custom_policy_trigger AFTER INSERT ON continuity_policy BEGIN SELECT 1; END'); },
    { kind: 'refuse', reason: 'unknown-or-attached-object' });
});
check('extra summary-ledger index refuses without touching summary data', () => {
  classifyUnchanged('summary-index', db => {
    db.exec(summaryDdl);
    db.exec('CREATE INDEX extra_summary_idx ON continuity_summary_policy(generation)');
  }, { kind: 'refuse', reason: 'unknown-or-attached-object' });
});
check('extra implicit summary UNIQUE index refuses', () => {
  classifyUnchanged('summary-autoindex', db => db.exec(`CREATE TABLE continuity_summary_policy (
    id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL UNIQUE, allowed INTEGER NOT NULL
  ) STRICT`), { kind: 'refuse', reason: 'summary-index-mismatch' });
});
check('exact v3 marker DDL pins singleton, epoch, fingerprint and origin/archive domains', () => {
  const markerRow = (values, accepted) => {
    const db = open();
    try {
      db.exec(CONTINUITY_V03_MARKER_DDL);
      assert.equal(db.prepare("SELECT strict FROM pragma_table_list WHERE name='continuity_schema_meta'").get().strict, 1);
      const insert = () => db.prepare('INSERT INTO continuity_schema_meta VALUES(?,?,?,?,?,?)').run(...values);
      if (accepted) assert.doesNotThrow(insert); else assert.throws(insert);
    } finally { db.close(); }
  };
  const fingerprint = '0'.repeat(64);
  markerRow([1, 1, 3, 'fresh', 'none', fingerprint], true);
  markerRow([1, 1, 3, 'v2-cutover', 'jobs-only', fingerprint], true);
  markerRow([1, 1, 3, 'v2-cutover', 'jobs-and-handoffs', fingerprint], true);
  markerRow([1, 1, 3, 'v2-cutover', 'purged', fingerprint], true);
  markerRow([1, 1, 3, 'fresh', 'jobs-only', fingerprint], false);
  markerRow([1, 1, 3, 'v2-cutover', 'none', fingerprint], false);
  markerRow([2, 1, 3, 'fresh', 'none', fingerprint], false);
  markerRow([1, 2, 3, 'fresh', 'none', fingerprint], false);
  markerRow([1, 1, 2, 'fresh', 'none', fingerprint], false);
  markerRow([1, 1, 3, 'fresh', 'none', 'A'.repeat(64)], false);
  markerRow([1, 1, 3, 'fresh', 'none', 'f'.repeat(63)], false);
  markerRow([1, 1, 3, 'fresh', 'none', 'a'.repeat(64) + String.fromCharCode(0) + 'tail'], false);
  markerRow([1, 1, 3, 'fresh' + String.fromCharCode(0) + 'tail', 'none', fingerprint], false);
  markerRow([1, 1, 3, 'v2-cutover', 'jobs-only' + String.fromCharCode(0) + 'tail', fingerprint], false);
});
check('all six v3 active templates are exact, executable, and fingerprinted together', () => {
  assert.ok(Object.isFrozen(CONTINUITY_V03_ACTIVE_DDL));
  assert.ok(Object.isFrozen(CONTINUITY_V03_FINGERPRINT_TABLES));
  assert.ok(Object.isFrozen(CONTINUITY_V03_FINGERPRINT_TEMPLATES));
  assert.ok(CONTINUITY_V03_FINGERPRINT_TEMPLATES.every(Object.isFrozen));
  assert.throws(() => CONTINUITY_V03_FINGERPRINT_TABLES.push('continuity_extra'));
  assert.throws(() => { CONTINUITY_V03_ACTIVE_DDL.continuity_policy = 'CREATE TABLE altered(x)'; });
  assert.throws(() => { CONTINUITY_V03_FINGERPRINT_TEMPLATES[0].ddl = 'CREATE TABLE altered(x)'; });
  assert.deepEqual(Object.keys(CONTINUITY_V03_ACTIVE_DDL).sort(), [...CONTINUITY_V03_FINGERPRINT_TABLES]);
  assert.deepEqual(CONTINUITY_V03_FINGERPRINT_TEMPLATES.map(template => template.tableName), [...CONTINUITY_V03_FINGERPRINT_TABLES]);
  assert.equal(continuitySchemaFingerprintV03(CONTINUITY_V03_FINGERPRINT_TEMPLATES), CONTINUITY_V03_DDL_FINGERPRINT);
  assert.equal(CONTINUITY_V03_DDL_FINGERPRINT, '40321ffa5ac44864535b1a2db66ffc44dacdb389fe87d579cf0c1a24fcc291c0');
  assert.match(CONTINUITY_V03_DDL_FINGERPRINT, /^[a-f0-9]{64}$/);
  assert.equal(CONTINUITY_V03_ACTIVE_DDL.continuity_policy.replace(/\s+/g, ' ').trim(),
    CONTINUITY_V02_DDL.continuity_policy.replace(/^CREATE TABLE IF NOT EXISTS /, 'CREATE TABLE ').replace(/\s+/g, ' ').trim());

  const db = open();
  const projectId = `pj-${'a'.repeat(32)}`, hashValue = 'b'.repeat(64);
  const jobId = '11111111-1111-1111-1111-111111111111', tokenValue = '22222222-2222-2222-2222-222222222222';
  try {
    for (const tableName of CONTINUITY_V03_FINGERPRINT_TABLES) db.exec(CONTINUITY_V03_ACTIVE_DDL[tableName]);
    const columns = {
      continuity_checkpoint: [['session_id', 'TEXT', 1], ['project_id', 'TEXT', 0], ['generation', 'INTEGER', 0], ['cut', 'INTEGER', 0], ['source_hash', 'TEXT', 0], ['checkpoint_format', 'INTEGER', 0], ['source_binding_version', 'INTEGER', 0], ['selected_source_hash', 'TEXT', 0], ['lineage_format', 'INTEGER', 0], ['lineage_binding_version', 'INTEGER', 0], ['lineage_kind', 'TEXT', 0], ['lineage_hash', 'TEXT', 0], ['envelope', 'TEXT', 0]],
      continuity_handoff: [['job_id', 'TEXT', 1], ['session_id', 'TEXT', 0], ['project_id', 'TEXT', 0], ['generation', 'INTEGER', 0], ['cut', 'INTEGER', 0], ['source_hash', 'TEXT', 0], ['checkpoint_format', 'INTEGER', 0], ['source_binding_version', 'INTEGER', 0], ['selected_source_hash', 'TEXT', 0], ['lineage_format', 'INTEGER', 0], ['lineage_binding_version', 'INTEGER', 0], ['lineage_kind', 'TEXT', 0], ['lineage_hash', 'TEXT', 0], ['payload', 'TEXT', 0]],
      continuity_jobs: [['id', 'TEXT', 1], ['session_id', 'TEXT', 0], ['project_id', 'TEXT', 0], ['generation', 'INTEGER', 0], ['cut', 'INTEGER', 0], ['source_hash', 'TEXT', 0], ['checkpoint_format', 'INTEGER', 0], ['source_binding_version', 'INTEGER', 0], ['selected_source_hash', 'TEXT', 0], ['lineage_format', 'INTEGER', 0], ['lineage_binding_version', 'INTEGER', 0], ['lineage_kind', 'TEXT', 0], ['lineage_hash', 'TEXT', 0], ['trigger', 'TEXT', 0], ['status', 'TEXT', 0]],
      continuity_policy: [['session_id', 'TEXT', 1], ['project_id', 'TEXT', 0], ['generation', 'INTEGER', 0], ['allowed', 'INTEGER', 0]],
      continuity_v3_human_boundary: [['session_id', 'TEXT', 1], ['project_id', 'TEXT', 0], ['header_hash', 'TEXT', 0], ['inherited_event_count', 'INTEGER', 0], ['generation', 'INTEGER', 0], ['latest_live_human_seq', 'INTEGER', 0], ['last_enqueued_human_seq', 'INTEGER', 0]],
      continuity_work: [['job_id', 'TEXT', 1], ['token', 'TEXT', 0], ['lease_deadline', 'INTEGER', 0], ['attempts', 'INTEGER', 0], ['status', 'TEXT', 0]],
    };
    for (const tableName of CONTINUITY_V03_FINGERPRINT_TABLES) {
      const metadata = db.prepare("SELECT strict,ncol FROM pragma_table_list WHERE schema='main' AND name=?").get(tableName);
      assert.deepEqual([metadata.strict, metadata.ncol], [1, columns[tableName].length], `${tableName} STRICT/column count`);
      const actualColumns = db.prepare(`PRAGMA main.table_xinfo('${tableName}')`).all();
      assert.deepEqual(actualColumns.map(column => [column.name, column.type, column.notnull, column.dflt_value, column.pk, column.hidden]),
        columns[tableName].map(([name, type, pk]) => [name, type, 1, null, pk, 0]), `${tableName} exact ordered metadata`);
      const indexes = db.prepare(`PRAGMA main.index_list('${tableName}')`).all()
        .map(index => [index.unique, index.origin, index.partial]).sort((left, right) => left[1].localeCompare(right[1]));
      const expectedIndexes = ['continuity_jobs', 'continuity_work'].includes(tableName) ? [[1, 'pk', 0], [1, 'u', 0]] : [[1, 'pk', 0]];
      assert.deepEqual(indexes, expectedIndexes, `${tableName} indexes`);
    }

    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', projectId, 3, 1);
    db.prepare('INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, '{"format":2}');
    db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(jobId, 'session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, 'turn-end', 'pending');
    db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)').run(jobId, tokenValue, 100, 1, 'running');
    db.prepare('INSERT INTO continuity_handoff VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(jobId, 'session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, '{"format":2}');
    assert.throws(() => db.prepare('INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('other', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 2, 'root', hashValue, '{"format":2}'));
    assert.throws(() => db.prepare('INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('other-source-version', projectId, 3, 0, hashValue, 2, 2, hashValue, 2, 3, 'root', hashValue, '{"format":2}'));
    assert.throws(() => db.prepare('INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('other-nul', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, '{"format":2}' + String.fromCharCode(0) + 'tail'));
    assert.throws(() => db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('not-a-uuid', 'session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, 'turn-end', 'pending'));
    assert.throws(() => db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('33333333-3333-3333-3333-333333333333', 'session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'unknown', hashValue, 'turn-end', 'pending'));
    assert.throws(() => db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('44444444-4444-4444-4444-444444444444', 'session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root' + String.fromCharCode(0) + 'tail', hashValue, 'pause', 'pending'));
    assert.throws(() => db.prepare('INSERT INTO continuity_jobs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('55555555-5555-5555-5555-555555555555', 'session', projectId, 3, 1, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, 'turn-end' + String.fromCharCode(0) + 'tail', 'pending'));
    assert.throws(() => db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)')
      .run(jobId, 'not-a-uuid', 100, 1, 'running'));
    assert.throws(() => db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)')
      .run('66666666-6666-6666-6666-666666666666', '44444444-4444-4444-4444-444444444444', 100, 1,
        'running' + String.fromCharCode(0) + 'tail'));
    assert.throws(() => db.prepare('INSERT INTO continuity_handoff VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(jobId, 'session', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue, 'x'.repeat(4001)));
    assert.throws(() => db.prepare('INSERT INTO continuity_handoff VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('33333333-3333-3333-3333-333333333333', 'session2', projectId, 3, 0, hashValue, 2, 3, hashValue, 2, 3, 'root', hashValue,
        '{"format":2}' + String.fromCharCode(0) + 'tail'));
  } finally { db.close(); }
});
check('exact v3 active DDL and singleton marker classify read-only', () => {
  const db = open();
  try {
    createFreshV3(db);
    const before = snapshot(db);
    assert.deepEqual(classifyContinuitySchemaV03(db), {
      kind: 'v3-schema', workerPair: 'absent', origin: 'fresh', legacyArchiveState: 'none', summaryLedgersPresent: false,
    });
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});
check('v3 classifier enforces archive-state/sidecar DDL correspondence', () => {
  classifyUnchanged('v3-marker-only', db => db.exec(CONTINUITY_V03_MARKER_DDL),
    { kind: 'refuse', reason: 'v3-required-table-missing' });
  classifyUnchanged('v3-split-worker-pair', db => {
    createFreshV3(db);
    db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_work);
  }, { kind: 'refuse', reason: 'split-v2-worker-pair' });
  classifyUnchanged('v3-wrong-fingerprint', db => createFreshV3(db, { fingerprint: 'b'.repeat(64) }),
    { kind: 'refuse', reason: 'v3-marker-invalid' });
  classifyUnchanged('v3-archive-sidecar-missing', db => createFreshV3(db, { origin: 'v2-cutover', archive: 'jobs-only', addArchiveTables: false }),
    { kind: 'refuse', reason: 'v3-archive-schema-mismatch' });
  classifyUnchanged('v3-jobs-only-archive', db => createFreshV3(db, { origin: 'v2-cutover', archive: 'jobs-only' }),
    { kind: 'v3-schema', workerPair: 'absent', origin: 'v2-cutover', legacyArchiveState: 'jobs-only', summaryLedgersPresent: false });
  classifyUnchanged('v3-jobs-and-handoffs-archive', db => createFreshV3(db, { origin: 'v2-cutover', archive: 'jobs-and-handoffs' }),
    { kind: 'v3-schema', workerPair: 'absent', origin: 'v2-cutover', legacyArchiveState: 'jobs-and-handoffs', summaryLedgersPresent: false });
  classifyUnchanged('v3-altered-archive-ddl', db => {
    createFreshV3(db, { origin: 'v2-cutover', archive: 'jobs-only', addArchiveTables: false });
    db.exec('CREATE TABLE continuity_jobs_legacy_v2(id TEXT PRIMARY KEY) STRICT');
  }, { kind: 'refuse', reason: 'v3-archive-schema-mismatch' });
  classifyUnchanged('v3-purged-archive-state', db => createFreshV3(db, { origin: 'v2-cutover', archive: 'purged' }),
    { kind: 'v3-schema', workerPair: 'absent', origin: 'v2-cutover', legacyArchiveState: 'purged', summaryLedgersPresent: false });
  classifyUnchanged('v3-sidecar-with-fresh-marker', db => {
    createFreshV3(db);
    db.exec('CREATE TABLE continuity_jobs_legacy_v2(id TEXT PRIMARY KEY) STRICT');
  }, { kind: 'refuse', reason: 'v3-marker-invalid' });
  classifyUnchanged('v3-altered-active-ddl', db => {
    createFreshV3(db);
    db.exec('DROP TABLE continuity_checkpoint');
    db.exec('CREATE TABLE continuity_checkpoint(session_id TEXT PRIMARY KEY) STRICT');
  }, { kind: 'refuse', reason: 'v3-active-schema-mismatch' });
});
check('fresh v3 owner bootstraps atomically, preserves summary ledgers, and lazily creates the pair', () => {
  const db = open();
  try {
    db.exec(summaryDdl);
    db.prepare('INSERT INTO continuity_summary_policy VALUES(1,7,1)').run();
    db.prepare('INSERT INTO continuity_summary_human VALUES(?,?,?,?,?)').run('summary-session', project, hash, 2, 3);
    const summaryBefore = [
      db.prepare('SELECT * FROM continuity_summary_policy').all(),
      db.prepare('SELECT * FROM continuity_summary_human').all(),
    ];
    const store = memoryStore(db);
    assert.deepEqual(ensureContinuitySchemaV03(store), { kind: 'created-fresh', workerPair: 'absent', summaryLedgersPresent: true, summaryLedgersValidated: false });
    assert.deepEqual(ensureContinuitySchemaV03(store), { kind: 'already-v3', workerPair: 'absent', summaryLedgersPresent: true, summaryLedgersValidated: false });
    assert.deepEqual(preflightContinuityV03Rows(db), { kind: 'safe-v3-row-preflight', counts: {
      policies: 0, boundaries: 0, checkpoints: 0, jobs: 0, work: 0, handoffs: 0, archivedJobs: 0, archivedHandoffs: 0,
    } });
    assert.deepEqual(ensureContinuityWorkerPairV03(store), { kind: 'created-worker-pair', summaryLedgersPresent: true, summaryLedgersValidated: false });
    assert.deepEqual(ensureContinuityWorkerPairV03(store), { kind: 'already-present', summaryLedgersPresent: true, summaryLedgersValidated: false });
    assert.deepEqual(classifyContinuitySchemaV03(db), {
      kind: 'v3-schema', workerPair: 'present', origin: 'fresh', legacyArchiveState: 'none', summaryLedgersPresent: true,
    });
    assert.deepEqual([
      db.prepare('SELECT * FROM continuity_summary_policy').all(),
      db.prepare('SELECT * FROM continuity_summary_human').all(),
    ], summaryBefore);
  } finally { db.close(); }
});
check('v3 owner refuses v2 cutover and injected transaction failure without writes', () => {
  const legacy = open();
  try {
    createV2(legacy);
    const before = snapshot(legacy);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(legacy)), {
      kind: 'refuse', reason: 'legacy-v2-offline-authorization-required',
    });
    assert.deepEqual(snapshot(legacy), before);
  } finally { legacy.close(); }

  const fresh = open();
  try {
    const before = snapshot(fresh);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(fresh, true)), {
      kind: 'refuse', reason: 'v3-owner-transaction-failed',
    });
    assert.deepEqual(snapshot(fresh), before);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(fresh, false, true)), {
      kind: 'refuse', reason: 'v3-owner-transaction-failed',
    });
    assert.deepEqual(snapshot(fresh), before);
  } finally { fresh.close(); }
});
check('offline pre-open gate requires every one-shot confirmation before calling the store factory', () => {
  const db = open();
  try {
    createV2(db);
    const before = snapshot(db);
    let opens = 0;
    assert.deepEqual(consumeContinuityV03OfflineAuthorization([
      '--exclusive-owner-confirmed', '--backup-confirmed', '--store-root', '/private/continuity-v3-test',
    ]), { kind: 'refuse', reason: 'offline-authorization-required' });
    assert.deepEqual(consumeContinuityV03OfflineAuthorization([
      '--offline-approved', '--backup-confirmed', '--store-root', '/private/continuity-v3-test',
    ]), { kind: 'refuse', reason: 'offline-authorization-invalid' });
    assert.deepEqual(consumeContinuityV03OfflineAuthorization(offlineArgs('/')),
      { kind: 'refuse', reason: 'offline-authorization-invalid' });
    assert.deepEqual(runContinuityV03OfflineMigration(null, () => { opens++; return memoryStore(db); }, z),
      { kind: 'refuse', reason: 'offline-authorization-invalid' });
    assert.equal(opens, 0);
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});
check('offline target validation rejects canonical-root redirects and database symlinks before storage import', () => {
  const stat = kind => ({
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => kind === 'symlink',
  });
  const regularTarget = {
    realpath: () => '/private/authorized-store',
    stat: () => stat('directory'),
    lstat: path => { assert.equal(path, '/private/authorized-store/memory.db'); return stat('file'); },
  };
  assert.deepEqual(validateContinuityV03OfflineStoreTarget('/private/authorized-store', regularTarget), {
    kind: 'valid-target', storeRoot: '/private/authorized-store',
  });
  let lstatCalls = 0;
  assert.deepEqual(validateContinuityV03OfflineStoreTarget('/private/root-link', {
    realpath: () => '/', stat: () => stat('directory'), lstat: () => { lstatCalls++; return stat('file'); },
  }), { kind: 'refuse', reason: 'offline-store-target-invalid' });
  assert.equal(lstatCalls, 0, 'canonical filesystem roots are refused before checking a database path');
  assert.deepEqual(validateContinuityV03OfflineStoreTarget('/private/store', {
    realpath: () => '/private/store', stat: () => stat('directory'), lstat: () => stat('symlink'),
  }), { kind: 'refuse', reason: 'offline-store-target-invalid' });
  assert.deepEqual(validateContinuityV03OfflineStoreTarget('/private/missing-db', {
    realpath: () => '/private/missing-db', stat: () => stat('directory'), lstat: () => { throw new Error('ENOENT'); },
  }), { kind: 'refuse', reason: 'offline-store-target-invalid' });
});
check('standalone CLI refuses before store imports when offline authorization is absent', () => {
  const child = spawnSync(process.execPath, ['scripts/migrate-continuity-v03.mjs'], { encoding: 'utf8' });
  assert.equal(child.status, 2, child.stderr || child.stdout);
  assert.match(child.stderr, /offline-authorization-required/);
});
check('authorized offline migrator archives jobs and revokes policy in one transaction', () => {
  const db = open();
  try {
    createV2(db);
    seedV2(db);
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('previously-denied', project, 9, 0);
    db.exec(summaryDdl);
    db.prepare('INSERT INTO continuity_summary_policy VALUES(1,7,1)').run();
    db.prepare('INSERT INTO continuity_summary_human VALUES(?,?,?,?,?)').run('summary-session', project, hash, 2, 3);
    const summaryBefore = [db.prepare('SELECT * FROM continuity_summary_policy').all(), db.prepare('SELECT * FROM continuity_summary_human').all()];
    const authorization = authorizeOffline();
    let opens = 0, closes = 0;
    const result = runContinuityV03OfflineMigration(authorization, root => {
      opens++;
      assert.equal(root, '/private/continuity-v3-test');
      const store = memoryStore(db);
      store.close = () => { closes++; };
      return store;
    }, z);
    assert.deepEqual(result, {
      kind: 'migrated-v2', archiveState: 'jobs-only',
      counts: { policies: 2, jobs: 1, handoffs: 0 }, summaryLedgersPresent: true, summaryLedgersValidated: false,
    });
    assert.equal(opens, 1);
    assert.equal(closes, 1);
    assert.deepEqual({ ...db.prepare('SELECT generation,allowed FROM continuity_policy WHERE session_id=?').get('session') }, { generation: 5, allowed: 0 });
    assert.deepEqual({ ...db.prepare('SELECT generation,allowed FROM continuity_policy WHERE session_id=?').get('previously-denied') }, { generation: 10, allowed: 0 });
    assert.equal(db.prepare('SELECT count(*) AS n FROM continuity_checkpoint').get().n, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM continuity_jobs').get().n, 0);
    assert.equal(db.prepare('SELECT status FROM continuity_jobs_legacy_v2').get().status, 'cancelled');
    assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='table' AND name IN('continuity_work','continuity_handoff')").get().n, 0);
    assert.deepEqual(classifyContinuitySchemaV03(db), {
      kind: 'v3-schema', workerPair: 'absent', origin: 'v2-cutover', legacyArchiveState: 'jobs-only', summaryLedgersPresent: true,
    });
    assert.deepEqual(preflightContinuityV03Rows(db), { kind: 'safe-v3-row-preflight', counts: {
      policies: 2, boundaries: 0, checkpoints: 0, jobs: 0, work: 0, handoffs: 0, archivedJobs: 1, archivedHandoffs: 0,
    } });
    assert.deepEqual([db.prepare('SELECT * FROM continuity_summary_policy').all(), db.prepare('SELECT * FROM continuity_summary_human').all()], summaryBefore);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(db)), {
      kind: 'already-v3', workerPair: 'absent', summaryLedgersPresent: true, summaryLedgersValidated: false,
    });
    assert.deepEqual(runContinuityV03OfflineMigration(authorization, () => { opens++; return memoryStore(db); }, z),
      { kind: 'refuse', reason: 'offline-authorization-invalid' });
    assert.equal(opens, 1, 'the same capability cannot open a second store');
  } finally { db.close(); }
});
check('authorized pair cutover archives completed handoffs and drops old leases', () => {
  const db = open();
  try {
    createV2(db, true);
    seedV2(db, true);
    const result = runContinuityV03OfflineMigration(authorizeOffline(), () => memoryStore(db), z);
    assert.deepEqual(result, {
      kind: 'migrated-v2', archiveState: 'jobs-and-handoffs',
      counts: { policies: 1, jobs: 1, handoffs: 1 }, summaryLedgersPresent: false, summaryLedgersValidated: false,
    });
    assert.equal(db.prepare('SELECT count(*) AS n FROM continuity_handoff_legacy_v2').get().n, 1);
    assert.equal(db.prepare('SELECT payload FROM continuity_handoff_legacy_v2').get().payload.includes('bounded note'), true);
    assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='table' AND name='continuity_work'").get().n, 0);
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
    assert.deepEqual(ensureContinuityWorkerPairV03(memoryStore(db)), {
      kind: 'created-worker-pair', summaryLedgersPresent: false, summaryLedgersValidated: false,
    });
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
  } finally { db.close(); }
});
check('offline cutover rolls back every table and row when commit fails', () => {
  const db = open();
  try {
    createV2(db, true);
    seedV2(db, true);
    const before = snapshot(db);
    const result = runContinuityV03OfflineMigration(authorizeOffline(), () => memoryStore(db, true), z);
    assert.deepEqual(result, { kind: 'refuse', reason: 'v3-owner-transaction-failed' });
    assert.deepEqual(snapshot(db), before);
  } finally { db.close(); }
});
check('v3 archive row preflight refuses pending, NUL-bearing, or mismatched archived rows', () => {
  const pending = open();
  try {
    createFreshV3(pending, { origin: 'v2-cutover', archive: 'jobs-only' });
    pending.prepare('INSERT INTO continuity_jobs_legacy_v2 VALUES(?,?,?,?,?,?,?,?)')
      .run('old-job', 'session', project, 1, 0, hash, 'turn-end', 'pending');
    assert.deepEqual(preflightContinuityV03Rows(pending), { kind: 'refuse', reason: 'unsafe-v2-archive-job-row' });
  } finally { pending.close(); }

  const badHandoff = open();
  try {
    createFreshV3(badHandoff, { origin: 'v2-cutover', archive: 'jobs-and-handoffs' });
    badHandoff.prepare('INSERT INTO continuity_jobs_legacy_v2 VALUES(?,?,?,?,?,?,?,?)')
      .run('job', 'session', project, 1, 0, hash, 'turn-end', 'cancelled');
    badHandoff.prepare('INSERT INTO continuity_handoff_legacy_v2 VALUES(?,?,?,?,?,?,?)')
      .run('job', 'other-session', project, 1, 0, hash,
        JSON.stringify({ jobId: 'job', sessionId: 'other-session', projectId: project, generation: 1, cut: 0, sourceHash: hash, notes: [], uncertain: true }));
    assert.deepEqual(preflightContinuityV03Rows(badHandoff), { kind: 'refuse', reason: 'unsafe-v2-archive-handoff-row' });
  } finally { badHandoff.close(); }

  const nulPayload = open();
  try {
    createFreshV3(nulPayload, { origin: 'v2-cutover', archive: 'jobs-and-handoffs' });
    nulPayload.prepare('INSERT INTO continuity_jobs_legacy_v2 VALUES(?,?,?,?,?,?,?,?)')
      .run('job', 'session', project, 1, 0, hash, 'turn-end', 'cancelled');
    nulPayload.exec('PRAGMA ignore_check_constraints=ON');
    nulPayload.prepare('INSERT INTO continuity_handoff_legacy_v2 VALUES(?,?,?,?,?,?,?)')
      .run('job', 'session', project, 1, 0, hash, '{"x":1}' + String.fromCharCode(0) + 'tail');
    assert.deepEqual(preflightContinuityV03Rows(nulPayload), { kind: 'refuse', reason: 'unsafe-v2-archive-handoff-payload' });
  } finally { nulPayload.close(); }
});
check('v3 owner applies policy/boundary guards and refuses malformed active checkpoint envelopes', () => {
  const unsafePolicy = open();
  try {
    createFreshV3(unsafePolicy);
    unsafePolicy.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, Number.MAX_SAFE_INTEGER + 1, 1);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(unsafePolicy)), { kind: 'refuse', reason: 'unsafe-v3-policy-row' });
  } finally { unsafePolicy.close(); }

  const nulPolicy = open();
  try {
    createFreshV3(nulPolicy);
    nulPolicy.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session' + String.fromCharCode(0) + 'tail', project, 1, 1);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(nulPolicy)), { kind: 'refuse', reason: 'unsafe-v3-policy-row' });
  } finally { nulPolicy.close(); }

  const good = open();
  try {
    createFreshV3(good);
    good.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 1, 1);
    good.prepare('INSERT INTO continuity_v3_human_boundary VALUES(?,?,?,?,?,?,?)').run('session', project, hash, 0, 1, 0, -1);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(good)), { kind: 'already-v3', workerPair: 'absent', summaryLedgersPresent: false, summaryLedgersValidated: false });
  } finally { good.close(); }

  const nulBoundary = open();
  try {
    createFreshV3(nulBoundary);
    nulBoundary.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 1, 1);
    nulBoundary.exec('PRAGMA ignore_check_constraints=ON');
    nulBoundary.prepare('INSERT INTO continuity_v3_human_boundary VALUES(?,?,?,?,?,?,?)')
      .run('session' + String.fromCharCode(0) + 'tail', project, hash, 0, 1, 0, -1);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(nulBoundary)), { kind: 'refuse', reason: 'unsafe-v3-boundary-row' });
  } finally { nulBoundary.close(); }

  const deniedBoundary = open();
  try {
    createFreshV3(deniedBoundary);
    deniedBoundary.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 2, 0);
    deniedBoundary.prepare('INSERT INTO continuity_v3_human_boundary VALUES(?,?,?,?,?,?,?)').run('session', project, hash, 0, 1, 0, -1);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(deniedBoundary)), {
      kind: 'already-v3', workerPair: 'absent', summaryLedgersPresent: false, summaryLedgersValidated: false,
    });
    assert.equal(deniedBoundary.prepare('SELECT allowed FROM continuity_policy WHERE session_id=?').get('session').allowed, 0,
      'structural validation does not grant denied policy');
  } finally { deniedBoundary.close(); }

  const futureBoundary = open();
  try {
    createFreshV3(futureBoundary);
    futureBoundary.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 2, 1);
    futureBoundary.prepare('INSERT INTO continuity_v3_human_boundary VALUES(?,?,?,?,?,?,?)').run('session', project, hash, 0, 3, 0, -1);
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(futureBoundary)), { kind: 'refuse', reason: 'unsafe-v3-boundary-row' });
  } finally { futureBoundary.close(); }

  const active = open();
  try {
    createFreshV3(active);
    active.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 1, 1);
    active.prepare('INSERT INTO continuity_checkpoint VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('session', project, 1, 0, hash, 2, 3, hash, 2, 3, 'root', hash, '{}');
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(active)), { kind: 'refuse', reason: 'unsafe-v3-checkpoint-envelope' });
  } finally { active.close(); }
});
check('v3 envelope codec keeps checkpoint, composite source, and lineage namespaces distinct', () => {
  const fixture = rootEnvelopeFixture({ generation: 3 });
  const parsed = parseContinuityCheckpointEnvelopeV03(fixture.envelope);
  assert.ok(parsed);
  assert.equal(parsed.checkpointFormat, 2);
  assert.equal(parsed.sourceBindingVersion, 3);
  assert.equal(parsed.lineage.format, 2);
  assert.equal(parsed.lineage.bindingVersion, 3);
  assert.equal(parsed.lineageHash, parsed.lineage.bindingHash);
  const forkFixture = forkEnvelopeFixture({ generation: 3 });
  const forkParsed = parseContinuityCheckpointEnvelopeV03(forkFixture.envelope);
  assert.ok(forkParsed);
  assert.equal(forkParsed.lineageKind, 'fork');
  assert.equal(forkParsed.lineage.edges.length, 1);
  assert.equal(forkParsed.row.val.lineageKind, 'fork-candidate');
  assert.equal(parsed.sourceHash, continuitySourceHashV03(parsed.sessionId, parsed.projectId, parsed.asOfSeq,
    parsed.lineageKind, parsed.selectedSourceHash, parsed.lineageHash));
  const badSourceVersion = structuredClone(fixture.envelope); badSourceVersion.sourceBindingVersion = 2;
  assert.equal(parseContinuityCheckpointEnvelopeV03(badSourceVersion), null);
  const badLineageHash = structuredClone(fixture.envelope); badLineageHash.lineage.child.selectedSourceHash = 'c'.repeat(64);
  assert.equal(parseContinuityCheckpointEnvelopeV03(badLineageHash), null);
  const badSelectedSource = structuredClone(fixture.envelope); badSelectedSource.selectedSourceHash = 'f'.repeat(64);
  assert.equal(parseContinuityCheckpointEnvelopeV03(badSelectedSource), null);
  const badSourceHash = structuredClone(fixture.envelope); badSourceHash.sourceHash = 'd'.repeat(64);
  assert.equal(parseContinuityCheckpointEnvelopeV03(badSourceHash), null);
  const extra = { ...fixture.envelope, legacyBindingVersion: 3 };
  assert.equal(parseContinuityCheckpointEnvelopeV03(extra), null);
});
check('v3 active checkpoint, job, work, and handoff rows pass strict version and anchor preflight', () => {
  const db = open();
  try {
    createFreshV3(db);
    assert.equal(ensureContinuityWorkerPairV03(memoryStore(db)).kind, 'created-worker-pair');
    const fixture = rootEnvelopeFixture({ generation: 3 });
    const forkFixture = forkEnvelopeFixture({ generation: 3 });
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 3, 1);
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('fork-child', project, 3, 1);
    insertV3Checkpoint(db, fixture);
    insertV3Checkpoint(db, forkFixture);
    const job = v3JobFixture(fixture);
    insertV3Job(db, job);
    db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)').run(job.id, '44444444-4444-4444-4444-444444444444', 100, 1, 'completed');
    const payload = JSON.stringify(handoffFixture(job));
    db.prepare(`INSERT INTO continuity_handoff(job_id,session_id,project_id,generation,cut,source_hash,checkpoint_format,
      source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.sessionId, job.projectId, job.generation, job.cut, job.sourceHash,
        job.checkpointFormat, job.sourceBindingVersion, job.selectedSourceHash, job.lineageFormat, job.lineageBindingVersion, job.lineageKind,
        job.lineageHash, payload);
    const wrongPayloadVersion = JSON.stringify({ ...handoffFixture(job), sourceBindingVersion: 2 });
    db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(wrongPayloadVersion, job.id);
    assert.deepEqual(preflightContinuityV03Rows(db), { kind: 'refuse', reason: 'unsafe-v3-handoff-payload' });
    db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(payload, job.id);
    assert.deepEqual(preflightContinuityV03Rows(db), { kind: 'safe-v3-row-preflight', counts: {
      policies: 2, boundaries: 0, checkpoints: 2, jobs: 1, work: 1, handoffs: 1, archivedJobs: 0, archivedHandoffs: 0,
    } });
    assert.deepEqual(ensureContinuitySchemaV03(memoryStore(db)), {
      kind: 'already-v3', workerPair: 'present', summaryLedgersPresent: false, summaryLedgersValidated: false,
    });
  } finally { db.close(); }
});
check('v3 active job, lease, and handoff tampering refuses before owner acceptance', () => {
  const badJob = open();
  try {
    createFreshV3(badJob);
    const fixture = rootEnvelopeFixture({ generation: 3 });
    badJob.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 3, 1);
    insertV3Checkpoint(badJob, fixture);
    insertV3Job(badJob, v3JobFixture(fixture, { sourceHash: 'e'.repeat(64) }));
    assert.deepEqual(preflightContinuityV03Rows(badJob), { kind: 'refuse', reason: 'unsafe-v3-job-row' });
  } finally { badJob.close(); }

  const badHandoff = open();
  try {
    createFreshV3(badHandoff);
    assert.equal(ensureContinuityWorkerPairV03(memoryStore(badHandoff)).kind, 'created-worker-pair');
    const fixture = rootEnvelopeFixture({ generation: 3 });
    badHandoff.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 3, 1);
    insertV3Checkpoint(badHandoff, fixture);
    const job = v3JobFixture(fixture);
    insertV3Job(badHandoff, job);
    badHandoff.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)')
      .run(job.id, '44444444-4444-4444-4444-444444444444', 100, 1, 'completed');
    const payload = JSON.stringify(handoffFixture(job));
    badHandoff.prepare(`INSERT INTO continuity_handoff(job_id,session_id,project_id,generation,cut,source_hash,checkpoint_format,
      source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.sessionId, job.projectId, job.generation, job.cut, job.sourceHash,
        job.checkpointFormat, job.sourceBindingVersion, job.selectedSourceHash, job.lineageFormat, job.lineageBindingVersion, job.lineageKind,
        'f'.repeat(64), payload);
    assert.deepEqual(preflightContinuityV03Rows(badHandoff), { kind: 'refuse', reason: 'unsafe-v3-handoff-row' });
  } finally { badHandoff.close(); }

  const orphanWork = open();
  try {
    createFreshV3(orphanWork);
    assert.equal(ensureContinuityWorkerPairV03(memoryStore(orphanWork)).kind, 'created-worker-pair');
    orphanWork.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)')
      .run('33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444', 100, 1, 'running');
    assert.deepEqual(preflightContinuityV03Rows(orphanWork), { kind: 'refuse', reason: 'unsafe-v3-work-row' });
  } finally { orphanWork.close(); }
});
check('v3 lazy pair rolls back both DDLs if nested or unable to commit', () => {
  const db = open();
  try {
    createFreshV3(db);
    const before = snapshot(db);
    assert.deepEqual(ensureContinuityWorkerPairV03(memoryStore(db, false, true)), {
      kind: 'refuse', reason: 'v3-owner-transaction-failed',
    });
    assert.deepEqual(snapshot(db), before);
    assert.deepEqual(ensureContinuityWorkerPairV03(memoryStore(db, true)), {
      kind: 'refuse', reason: 'v3-owner-transaction-failed',
    });
    assert.deepEqual(snapshot(db), before);
    assert.equal(db.prepare("SELECT count(*) AS n FROM main.sqlite_schema WHERE type='table' AND name IN('continuity_work','continuity_handoff')").get().n, 0);
  } finally { db.close(); }
});
check('v3 policy row guard bounds safe integers and UTF-16 session IDs', () => {
  const row = { session_id: 'session', project_id: project, generation: Number.MAX_SAFE_INTEGER, allowed: 1 };
  assert.equal(isSafeContinuityV03PolicyDbRow(row), true);
  assert.equal(isSafeContinuityV03PolicyDbRow({ ...row, generation: Number.MAX_SAFE_INTEGER + 1 }), false);
  assert.equal(isSafeContinuityV03PolicyDbRow({ ...row, allowed: 2 }), false);
  assert.equal(isSafeContinuityV03PolicyDbRow({ ...row, project_id: project + String.fromCharCode(10) }), false);
  assert.equal(isSafeContinuityV03PolicyDbRow({ ...row, session_id: 'session' + String.fromCharCode(0) + 'tail' }), false);
  const mixed = '😀'.repeat(170) + 'a'.repeat(86);
  assert.equal([...mixed].length, 256);
  assert.equal(isSafeContinuityV03SessionId(mixed), false);
  assert.equal(isSafeContinuityV03PolicyDbRow({ ...row, session_id: mixed }), false);
  assert.equal(isSafeContinuityV03PolicyDbRow({ ...row, unexpected: true }), false);
  let getterCalls = 0;
  const getterRow = { ...row };
  Object.defineProperty(getterRow, 'generation', { enumerable: true, get() { getterCalls++; return 1; } });
  assert.equal(isSafeContinuityV03PolicyDbRow(getterRow), false);
  assert.equal(getterCalls, 0);
  const symbolRow = { ...row, [Symbol('extra')]: true };
  assert.equal(isSafeContinuityV03PolicyDbRow(symbolRow), false);

  const db = open();
  try {
    db.exec(CONTINUITY_V03_ACTIVE_DDL.continuity_policy);
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session' + String.fromCharCode(0) + 'tail', project, 1, 1);
    const projected = db.prepare('SELECT session_id FROM main.continuity_policy').get();
    const rawNul = db.prepare("SELECT instr(CAST(session_id AS BLOB),X'00') AS found FROM main.continuity_policy").get().found;
    assert.equal(projected.session_id, 'session');
    assert.ok(rawNul > 0, 'future v3 owner must SQL-probe policy TEXT before applying the JS row guard');
  } finally { db.close(); }
});
check('candidate v3 human-boundary DDL pins exact metadata and NUL-safe domains', () => {
  const db = open();
  const nul = String.fromCharCode(0);
  try {
    db.exec(CONTINUITY_V03_HUMAN_BOUNDARY_DDL);
    const table = db.prepare("SELECT strict,ncol FROM pragma_table_list WHERE name='continuity_v3_human_boundary'").get();
    assert.deepEqual([table.strict, table.ncol], [1, 7]);
    const columns = db.prepare('PRAGMA table_info(continuity_v3_human_boundary)').all();
    assert.deepEqual(columns.map(column => [column.name, column.type, column.notnull, column.dflt_value, column.pk]), [
      ['session_id', 'TEXT', 1, null, 1], ['project_id', 'TEXT', 1, null, 0], ['header_hash', 'TEXT', 1, null, 0],
      ['inherited_event_count', 'INTEGER', 1, null, 0], ['generation', 'INTEGER', 1, null, 0],
      ['latest_live_human_seq', 'INTEGER', 1, null, 0], ['last_enqueued_human_seq', 'INTEGER', 1, null, 0],
    ]);
    assert.deepEqual(db.prepare('PRAGMA table_xinfo(continuity_v3_human_boundary)').all().map(column => column.hidden), [0, 0, 0, 0, 0, 0, 0]);
    assert.deepEqual(db.prepare('PRAGMA index_list(continuity_v3_human_boundary)').all().map(index => [index.name, index.unique, index.origin, index.partial]),
      [['sqlite_autoindex_continuity_v3_human_boundary_1', 1, 'pk', 0]]);

    const insert = db.prepare('INSERT INTO continuity_v3_human_boundary VALUES(?,?,?,?,?,?,?)');
    const projectId = `pj-${'a'.repeat(32)}`, headerHash = 'b'.repeat(64);
    const valid = ['session', projectId, headerHash, 10, 3, 12, -1];
    insert.run(...valid);
    assert.equal(isSafeContinuityV03HumanBoundaryDbRow(db.prepare('SELECT * FROM continuity_v3_human_boundary').get()), true);
    db.exec('DELETE FROM continuity_v3_human_boundary');
    insert.run('😀'.repeat(128), projectId, headerHash, 10, 3, 12, -1);
    assert.equal(isSafeContinuityV03HumanBoundaryDbRow(db.prepare('SELECT * FROM continuity_v3_human_boundary').get()), true);
    db.exec('DELETE FROM continuity_v3_human_boundary');
    insert.run('😀'.repeat(129), projectId, headerHash, 10, 3, 12, -1);
    assert.equal(isSafeContinuityV03HumanBoundaryDbRow(db.prepare('SELECT * FROM continuity_v3_human_boundary').get()), false);
    db.prepare('UPDATE continuity_v3_human_boundary SET last_enqueued_human_seq=?').run(10);
    db.prepare('UPDATE continuity_v3_human_boundary SET last_enqueued_human_seq=?').run(12);
    db.prepare('UPDATE continuity_v3_human_boundary SET last_enqueued_human_seq=?').run(-1);
    db.exec('DELETE FROM continuity_v3_human_boundary');
    insert.run('session', projectId, headerHash, 10, Number.MAX_SAFE_INTEGER, 12, -1);
    const invalidRows = [
      ['', projectId, headerHash, 10, 3, 12, -1],
      ['s'.repeat(257), projectId, headerHash, 10, 3, 12, -1],
      ['session' + String.fromCharCode(0) + 'tail', projectId, headerHash, 10, 3, 12, -1],
      ['session', `pj-${'A'.repeat(32)}`, headerHash, 10, 3, 12, -1],
      ['session', `pj-${'a'.repeat(10)}${nul}${'a'.repeat(21)}`, headerHash, 10, 3, 12, -1],
      ['session', projectId, 'B'.repeat(64), 10, 3, 12, -1],
      ['session', projectId, `${'b'.repeat(10)}${nul}${'b'.repeat(53)}`, 10, 3, 12, -1],
      ['session', projectId, headerHash, 10, 9007199254740992n, 12, -1],
      ['session', projectId, headerHash, 10, 3, 9, -1],
      ['session', projectId, headerHash, 10, 3, 9007199254740992n, -1],
      ['session', projectId, headerHash, 10, 3, 12, -2],
      ['session', projectId, headerHash, 10, 3, 12, 9],
      ['session', projectId, headerHash, 10, 3, 12, 13],
      ['session', projectId, headerHash, 10, 3, 12, 9007199254740992n],
      ['session', projectId, headerHash, 9007199254740992n, 3, 12, -1],
    ];
    for (const row of invalidRows) {
      db.exec('DELETE FROM continuity_v3_human_boundary');
      assert.throws(() => insert.run(...row));
      assert.equal(db.prepare('SELECT count(*) AS n FROM continuity_v3_human_boundary').get().n, 0);
    }
    db.exec('DELETE FROM continuity_v3_human_boundary');
    insert.run(...valid);
    assert.throws(() => insert.run(...valid), /UNIQUE|PRIMARY KEY/i);
  } finally { db.close(); }
  const row = { session_id: 's', project_id: `pj-${'a'.repeat(32)}`, header_hash: 'b'.repeat(64),
    inherited_event_count: 10, generation: Number.MAX_SAFE_INTEGER, latest_live_human_seq: 12, last_enqueued_human_seq: -1 };
  assert.equal(isSafeContinuityV03HumanBoundaryDbRow(row), true);
  assert.equal(isSafeContinuityV03HumanBoundaryDbRow({ ...row, session_id: 's'.repeat(257) }), false);
  assert.equal(isSafeContinuityV03HumanBoundaryDbRow({ ...row, session_id: '😀'.repeat(128) }), true);
  assert.equal(isSafeContinuityV03HumanBoundaryDbRow({ ...row, session_id: '😀'.repeat(129) }), false);
  assert.equal(isSafeContinuityV03HumanBoundaryDbRow({ ...row, session_id: 's' + nul + 'tail' }), false);
  let getterCalls = 0;
  const getterRow = { ...row };
  Object.defineProperty(getterRow, 'generation', { enumerable: true, get() { getterCalls++; return 3; } });
  assert.equal(isSafeContinuityV03HumanBoundaryDbRow(getterRow), false);
  assert.equal(getterCalls, 0);
});
check('incomplete v3 marker state refuses before owner bootstrap', () => {
  classifyUnchanged('v3-not-yet-supported', db => db.exec(CONTINUITY_V03_MARKER_DDL),
    { kind: 'refuse', reason: 'v3-required-table-missing' });
});
check('schema fingerprint uses uint32 length frames in canonical ASCII table order', () => {
  const compact = CONTINUITY_V03_FINGERPRINT_TABLES.map(tableName => ({
    tableName, ddl: `CREATE TABLE ${tableName}(id INTEGER PRIMARY KEY) STRICT`,
  }));
  const formatted = compact.map(({ tableName }) => ({
    tableName, ddl: `CREATE TABLE IF NOT EXISTS ${tableName} (
  id INTEGER PRIMARY KEY
) STRICT`,
  }));
  const expected = 'ab2ebe5c1fe36991cff9743cbbd015883c1ad0409629016addd714daf277dd88';
  assert.deepEqual([...CONTINUITY_V03_FINGERPRINT_TABLES], [...CONTINUITY_V03_FINGERPRINT_TABLES].sort());
  assert.equal(CONTINUITY_V03_FINGERPRINT_TABLES.includes('continuity_work'), true);
  assert.equal(CONTINUITY_V03_FINGERPRINT_TABLES.includes('continuity_handoff'), true);
  assert.equal(CONTINUITY_V03_FINGERPRINT_TABLES.includes('continuity_schema_meta'), false);
  assert.equal(continuitySchemaFingerprintV03(compact), expected);
  assert.equal(continuitySchemaFingerprintV03([...compact].reverse()), expected);
  assert.equal(continuitySchemaFingerprintV03(formatted), expected);
  const withBoundary = compact.map(template => ({ ...template }));
  const boundaryTemplate = withBoundary.find(template => template.tableName === 'continuity_v3_human_boundary');
  assert.ok(boundaryTemplate);
  boundaryTemplate.ddl = CONTINUITY_V03_HUMAN_BOUNDARY_DDL;
  const boundaryDigest = continuitySchemaFingerprintV03(withBoundary);
  assert.match(boundaryDigest, /^[a-f0-9]{64}$/);
  const changedBoundaryColumn = withBoundary.map(template => ({ ...template }));
  const changedColumnTemplate = changedBoundaryColumn.find(template => template.tableName === 'continuity_v3_human_boundary');
  changedColumnTemplate.ddl = changedColumnTemplate.ddl.replaceAll('latest_live_human_seq', 'latest_live_seq');
  assert.notEqual(continuitySchemaFingerprintV03(changedBoundaryColumn), boundaryDigest);
  const changedBoundaryRange = withBoundary.map(template => ({ ...template }));
  const changedRangeTemplate = changedBoundaryRange.find(template => template.tableName === 'continuity_v3_human_boundary');
  changedRangeTemplate.ddl = changedRangeTemplate.ddl.replace('latest_live_human_seq BETWEEN 0 AND 9007199254740991',
    'latest_live_human_seq BETWEEN 0 AND 9007199254740990');
  assert.notEqual(continuitySchemaFingerprintV03(changedBoundaryRange), boundaryDigest);
  const changedLastColumn = withBoundary.map(template => ({ ...template }));
  const changedLastColumnTemplate = changedLastColumn.find(template => template.tableName === 'continuity_v3_human_boundary');
  changedLastColumnTemplate.ddl = changedLastColumnTemplate.ddl.replaceAll('last_enqueued_human_seq', 'last_enqueued_seq');
  assert.notEqual(continuitySchemaFingerprintV03(changedLastColumn), boundaryDigest);
  const changedLastRange = withBoundary.map(template => ({ ...template }));
  const changedLastRangeTemplate = changedLastRange.find(template => template.tableName === 'continuity_v3_human_boundary');
  changedLastRangeTemplate.ddl = changedLastRangeTemplate.ddl.replace('last_enqueued_human_seq BETWEEN -1 AND 9007199254740991',
    'last_enqueued_human_seq BETWEEN -1 AND 9007199254740990');
  assert.notEqual(continuitySchemaFingerprintV03(changedLastRange), boundaryDigest);
  const changed = compact.map(template => ({ ...template }));
  changed[0].ddl = changed[0].ddl.replace('id INTEGER', 'id TEXT');
  assert.notEqual(continuitySchemaFingerprintV03(changed), expected);
  assert.throws(() => continuitySchemaFingerprintV03(compact.slice(1)));
  const duplicate = compact.map(template => ({ ...template }));
  duplicate[1].tableName = duplicate[0].tableName;
  assert.throws(() => continuitySchemaFingerprintV03(duplicate));
  const unknown = compact.map(template => ({ ...template }));
  unknown[0].tableName = 'continuity_unknown';
  assert.throws(() => continuitySchemaFingerprintV03(unknown));
  const quoted = compact.map(template => ({ ...template }));
  quoted[0].ddl = 'CREATE TABLE "' + quoted[0].tableName + '"(id INTEGER PRIMARY KEY) STRICT';
  assert.throws(() => continuitySchemaFingerprintV03(quoted));
  const commented = compact.map(template => ({ ...template }));
  commented[0].ddl = commented[0].ddl + ' -- comment';
  assert.throws(() => continuitySchemaFingerprintV03(commented));
});
check('v3 human boundary alone refuses and mixed v2/v3 refuses', () => {
  const boundary = CONTINUITY_V03_HUMAN_BOUNDARY_DDL;
  classifyUnchanged('v3-boundary-only', db => db.exec(boundary),
    { kind: 'refuse', reason: 'v3-required-table-missing' });
  classifyUnchanged('mixed-v2-v3', db => { createV2(db); seedV2(db); db.exec(boundary); },
    { kind: 'refuse', reason: 'v3-required-table-missing' });
});
check('legacy sidecar without an exact v3 marker refuses', () => {
  classifyUnchanged('sidecar', db => db.exec('CREATE TABLE continuity_jobs_legacy_v2 (id TEXT PRIMARY KEY) STRICT'),
    { kind: 'refuse', reason: 'legacy-sidecar-present' });
});
check('v3 work claim/current/fail are DDL-free and fenced by exact policy, checkpoint, anchors, and lease', () => {
  const db = open();
  try {
    createFreshV3(db);
    const owner = memoryStore(db);
    const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'continuity_%' ORDER BY name").all();
    const work = new ContinuityWorkV03(owner);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'continuity_%' ORDER BY name").all(), before,
      'constructor must not create schema');
    assert.throws(() => work.claim(project, 1000, 1000), /worker pair/);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'continuity_%' ORDER BY name").all(), before,
      'work class must not create schema');

    ensureContinuityWorkerPairV03(owner);
    const fixture = rootEnvelopeFixture({ generation: 4 });
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run(fixture.envelope.sessionId, project, 4, 1);
    insertV3Checkpoint(db, fixture);
    insertV3Job(db, v3JobFixture(fixture));
    const commitFailureWork = new ContinuityWorkV03(memoryStore(db, true));
    assert.throws(() => commitFailureWork.claim(project, 1000, 1000), /injected commit failure/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_work').get().count, 0,
      'failed owner commit must roll back the inserted lease');

    const claim = work.claim(project, 1000, 1000);
    assert.ok(claim);
    assert.equal(claim.generation, 4);
    assert.equal(claim.sourceHash, fixture.envelope.sourceHash);
    assert.equal(claim.selectedSourceHash, fixture.envelope.selectedSourceHash);
    assert.equal(claim.attempts, 1);
    assert.equal(work.isCurrent(claim, 1001), true);
    assert.equal(work.hasEligibleWork(project, 1001), false);
    assert.equal(work.isCurrent({ ...claim, selectedSourceHash: 'f'.repeat(64) }, 1001), false);
    assert.equal(work.isCurrent(claim, 2000), false, 'lease deadline is exclusive');
    assert.equal(work.hasEligibleWork(project, 2000), true, 'expired lease remains observable after bounded claiming');
    assert.equal(work.fail(claim, 2000), false, 'expired work cannot settle');
    const retried = work.claim(project, 2000, 1000);
    assert.ok(retried);
    assert.equal(retried.attempts, 2);
    assert.notEqual(retried.token, claim.token);
    assert.equal(work.isCurrent(claim, 2001), false, 'a reclaimed token cannot remain current');
    assert.equal(work.isCurrent(retried, 2001), true);

    db.prepare('UPDATE continuity_policy SET allowed=0 WHERE session_id=?').run(fixture.envelope.sessionId);
    assert.equal(work.isCurrent(retried, 2001), false, 'current durable policy is reread');
    assert.equal(work.fail(retried, 2001), false, 'revoked policy cannot settle');
    db.prepare('UPDATE continuity_policy SET allowed=1 WHERE session_id=?').run(fixture.envelope.sessionId);
    db.prepare('UPDATE continuity_policy SET generation=5 WHERE session_id=?').run(fixture.envelope.sessionId);
    assert.equal(work.isCurrent(retried, 2001), false, 'new policy generation invalidates the old job claim');
    assert.equal(work.fail(retried, 2001), false, 'stale generation cannot settle');
    db.prepare('UPDATE continuity_policy SET generation=4 WHERE session_id=?').run(fixture.envelope.sessionId);
    assert.equal(work.fail(retried, 2001), true);
    assert.equal(work.isCurrent(retried, 2001), false, 'failed work is no longer current');
    assert.equal(work.claim(project, 2001, 1000), null, 'terminal failed work is not reclaimed');
    assert.equal(work.hasEligibleWork(project, 2001), false);

    insertV3Job(db, v3JobFixture(fixture, { id: '44444444-4444-4444-4444-444444444444', trigger: 'pause' }));
    const attempt1 = work.claim(project, 3000, 1000);
    assert.equal(attempt1.attempts, 1);
    const attempt2 = work.claim(project, 4000, 1000);
    assert.equal(attempt2.attempts, 2);
    const attempt3 = work.claim(project, 5000, 1000);
    assert.equal(attempt3.attempts, 3);
    assert.equal(work.claim(project, 6000, 1000), null, 'expired maximum-attempt row becomes terminal');
    const terminal = db.prepare('SELECT attempts,status FROM continuity_work WHERE job_id=?').get(attempt3.id);
    assert.equal(terminal.attempts, 3);
    assert.equal(terminal.status, 'failed');
    assert.equal(work.hasEligibleWork(project, 6000), false);
  } finally { db.close(); }
});

check('v3 policy generation preserves no-op startup and atomically revokes, re-enables, and purges moved projects', () => {
  const db = open();
  try {
    createFreshV3(db);
    const owner = memoryStore(db);
    ensureContinuityWorkerPairV03(owner);
    const fixture = rootEnvelopeFixture({ generation: 4 });
    const firstJob = v3JobFixture(fixture);
    const completedJob = v3JobFixture(fixture, { id: '44444444-4444-4444-4444-444444444444', trigger: 'pause' });
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run(fixture.envelope.sessionId, project, 4, 1);
    insertV3Checkpoint(db, fixture);
    insertV3Job(db, firstJob);
    insertV3Job(db, completedJob);
    db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)').run(firstJob.id, token, 6000, 1, 'running');
    db.prepare('INSERT INTO continuity_work VALUES(?,?,?,?,?)').run(completedJob.id, '22222222-2222-2222-2222-222222222222', 6000, 1, 'completed');
    db.prepare(`INSERT INTO continuity_handoff(job_id,session_id,project_id,generation,cut,source_hash,checkpoint_format,
      source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,payload)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(completedJob.id, completedJob.sessionId, completedJob.projectId,
      completedJob.generation, completedJob.cut, completedJob.sourceHash, completedJob.checkpointFormat,
      completedJob.sourceBindingVersion, completedJob.selectedSourceHash, completedJob.lineageFormat,
      completedJob.lineageBindingVersion, completedJob.lineageKind, completedJob.lineageHash,
      JSON.stringify(handoffFixture(completedJob)));
    db.prepare('INSERT INTO continuity_v3_human_boundary VALUES(?,?,?,?,?,?,?)')
      .run(fixture.envelope.sessionId, project, hash, 0, 4, 0, -1);
    const policy = new ContinuityPolicyV03(owner);

    assert.equal(policy.ensurePolicy(fixture.envelope.sessionId, project, true), 4,
      'unchanged policy preserves its generation');
    assert.equal(db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(firstJob.id).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(firstJob.id).status, 'running');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 1);

    const failingRevocation = new ContinuityPolicyV03(memoryStore(db, true));
    assert.throws(() => failingRevocation.setPolicy(fixture.envelope.sessionId, project, false), /injected commit failure/);
    assert.equal(db.prepare('SELECT generation FROM continuity_policy WHERE session_id=?').get(fixture.envelope.sessionId).generation, 4);
    assert.equal(db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(firstJob.id).status, 'pending');
    assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(firstJob.id).status, 'running');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_handoff').get().count, 1);
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight', 'failed revocation rolls every write back');

    assert.equal(policy.setPolicy(fixture.envelope.sessionId, project, false), 5);
    const denied = db.prepare('SELECT project_id,generation,allowed FROM continuity_policy WHERE session_id=?').get(fixture.envelope.sessionId);
    assert.deepEqual([denied.project_id, denied.generation, denied.allowed], [project, 5, 0]);
    assert.equal(db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(firstJob.id).status, 'cancelled');
    assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(firstJob.id).status, 'failed',
      'running lease is invalidated in the revocation transaction');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_handoff').get().count, 1,
      'completed handoff remains anchored to a cancelled job, not current work');
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');

    assert.equal(policy.ensurePolicy(fixture.envelope.sessionId, project, false), 5,
      'unchanged denial is idempotent');
    assert.equal(policy.ensurePolicy(fixture.envelope.sessionId, project, true), 6);
    assert.equal(db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(firstJob.id).status, 'cancelled',
      're-enable never resurrects canceled work');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 0);
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');

    const movedProject = 'pj-' + 'b'.repeat(32);
    assert.equal(policy.setPolicy(fixture.envelope.sessionId, movedProject, true), 7);
    assert.equal(db.prepare('SELECT project_id,generation,allowed FROM continuity_policy WHERE session_id=?').get(fixture.envelope.sessionId).project_id, movedProject);
    for (const table of ['continuity_jobs', 'continuity_work', 'continuity_handoff', 'continuity_checkpoint', 'continuity_v3_human_boundary']) {
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM main.${table}`).get().count, 0,
        `project movement purges stale ${table} anchors`);
    }
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');

    const failingPolicy = new ContinuityPolicyV03(memoryStore(db, true));
    assert.throws(() => failingPolicy.setPolicy(fixture.envelope.sessionId, movedProject, false), /injected commit failure/);
    const rolledBack = db.prepare('SELECT project_id,generation,allowed FROM continuity_policy WHERE session_id=?').get(fixture.envelope.sessionId);
    assert.deepEqual([rolledBack.project_id, rolledBack.generation, rolledBack.allowed], [movedProject, 7, 1]);
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
  } finally { db.close(); }
});

check('v3 live-human boundary is strict, ordered, generation-fenced, and rollback-safe', () => {
  const db = open();
  try {
    createFreshV3(db);
    const owner = memoryStore(db);
    db.prepare('INSERT INTO continuity_policy VALUES(?,?,?,?)').run('session', project, 4, 1);
    const before = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'continuity_%' ORDER BY name").all();
    const boundary = new ContinuityBoundaryV03(owner);
    assert.deepEqual(db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name LIKE 'continuity_%' ORDER BY name").all(), before,
      'boundary constructor must not create schema');
    const event = (seq, overrides = {}) => ({ kind: 'host-direct-user-message', sessionId: 'session', projectId: project,
      headerHash: hash, inheritedEventCount: 0, generation: 4, seq, ...overrides });
    assert.equal(boundary.recordEligibleLiveHuman(event(8)), true);
    assert.equal(boundary.recordEligibleLiveHuman(event(8)), false, 'duplicate seq is ignored');
    assert.equal(boundary.recordEligibleLiveHuman(event(7)), false, 'out-of-order seq is ignored');
    assert.equal(boundary.recordEligibleLiveHuman(event(10)), true);
    db.prepare('UPDATE continuity_v3_human_boundary SET last_enqueued_human_seq=8 WHERE session_id=?').run('session');
    assert.equal(boundary.recordEligibleLiveHuman(event(12)), true);
    let row = db.prepare('SELECT generation,latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get('session');
    assert.deepEqual([row.generation, row.latest_live_human_seq, row.last_enqueued_human_seq], [4, 12, 8],
      'new live event preserves the already-consumed watermark');

    assert.equal(boundary.recordEligibleLiveHuman({ ...event(13), body: 'not a boundary field' }), false);
    let getterCalls = 0;
    const getterReceipt = event(13);
    Object.defineProperty(getterReceipt, 'seq', { enumerable: true, get() { getterCalls++; return 13; } });
    assert.equal(boundary.recordEligibleLiveHuman(getterReceipt), false);
    assert.equal(getterCalls, 0, 'receipt accessors are never invoked');

    const policy = new ContinuityPolicyV03(owner);
    assert.equal(policy.setPolicy('session', project, false), 5);
    assert.equal(boundary.recordEligibleLiveHuman(event(13)), false, 'revoked policy rejects an old-generation event');
    assert.equal(policy.ensurePolicy('session', project, true), 6);
    assert.equal(boundary.recordEligibleLiveHuman(event(13, { generation: 6 })), true,
      'a new eligible event under the replacement generation resets the boundary');
    row = db.prepare('SELECT generation,latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get('session');
    assert.deepEqual([row.generation, row.latest_live_human_seq, row.last_enqueued_human_seq], [6, 13, -1]);
    assert.equal(boundary.recordEligibleLiveHuman(event(5, { generation: 6, headerHash: 'b'.repeat(64) })), true,
      'a new verified header identity can reset sequence coordinates');
    row = db.prepare('SELECT generation,header_hash,latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get('session');
    assert.deepEqual([row.generation, row.header_hash, row.latest_live_human_seq, row.last_enqueued_human_seq], [6, 'b'.repeat(64), 5, -1]);
    assert.equal(boundary.recordEligibleLiveHuman(event(4, { generation: 6, headerHash: 'b'.repeat(64) })), false);

    const failingBoundary = new ContinuityBoundaryV03(memoryStore(db, true));
    assert.throws(() => failingBoundary.recordEligibleLiveHuman(event(6, { generation: 6, headerHash: 'b'.repeat(64) })), /injected commit failure/);
    row = db.prepare('SELECT latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get('session');
    assert.deepEqual([row.latest_live_human_seq, row.last_enqueued_human_seq], [5, -1], 'failed boundary write rolls back');
    assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
  } finally { db.close(); }
});

console.log(`${passes} PASS / 0 FAIL; all fixtures were private in-memory SQLite`);
