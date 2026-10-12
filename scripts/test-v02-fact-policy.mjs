#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/storage.js';
import { MemoryJournalV02 } from '../lib/memory-journal-v02.js';
import { createMemoryBusiness } from '../lib/business.js';

const dir = mkdtempSync(join(tmpdir(), 'dsh-fact-policy-'));
const store = new MemoryStore(dir);
const journal = new MemoryJournalV02(store);
const db = store.getJournalSqlite();
const caller = { peerId: null, source: 'command' };
const authorization = { token: '' };
const policy = { revokeMemoryEvidence: (memoryIds, reason) => journal.revokeMemoryEvidence({ memoryIds, reason }) };
const business = (journalPolicy = policy) => createMemoryBusiness({ store, enabled: () => true, skillsPrefix: () => 'dsi-', skillsRoot: () => '', episodeEnabled: () => true, journalPolicy });
function append(sessionId, seq, text) {
  journal.appendSession({ sessionId, projectId: 'pj-fact-fixture', producer: { delegated: false, inheritedEventCount: 0 }, sourceMaxChars: 6000, events: [{ seq, ts: seq + 1, kind: 'user', text }] });
}
function derive(sessionId) {
  append(sessionId, 0, `User owns a synthetic blue cabinet in ${sessionId}.`);
  const claim = journal.claimWork({ kind: 'extract' });
  const result = journal.commitChunkResult(claim, 0, { kind: 'consumed', candidates: [{ text: `User owns a synthetic blue cabinet in ${sessionId}.`, kind: 'fact', provenance: 'derived', source: 'llm-extract' }] });
  return result.memoryIds[0];
}
let passed = 0;
function check(name, fn) { fn(); passed++; console.log(`PASS ${name}`); }
try {
  check('forget spends only support coordinates while unrelated same-session in-flight and future evidence remain eligible', () => {
    const id = derive('forget-fixture');
    append('forget-fixture', 1, 'User owns an unrelated green notebook.');
    const unrelated = journal.claimWork({ kind: 'extract' });
    const generation = journal.getCancellationGeneration();
    business().forget(caller, id, authorization);
    assert.equal(store.getMemory(id).status, 'forgotten');
    assert.equal(db.prepare('SELECT revoked FROM journal_sources WHERE session_id=? AND seq=0').get('forget-fixture').revoked, 1);
    assert.equal(db.prepare('SELECT revoked FROM journal_sessions WHERE session_id=?').get('forget-fixture').revoked, 0);
    assert.equal(journal.getCancellationGeneration(), generation);
    assert.equal(journal.commitChunkResult(unrelated, 0, { kind: 'nothing-to-learn' }).acked, true);
    append('forget-fixture', 2, 'User adds a future unrelated brass lamp.');
    const future = journal.claimWork({ kind: 'extract' });
    assert.equal(journal.commitChunkResult(future, 0, { kind: 'nothing-to-learn' }).acked, true);
  });
  check('correct atomically preserves the latest human decision and spends the old support without closing its session', () => {
    const id = derive('correct-fixture');
    const result = business().correct(caller, id, 'User now owns a red cabinet.', authorization);
    assert.equal(store.getMemory(id).status, 'corrected');
    assert.equal(store.getMemory(result.affected).meta.provenance, 'user');
    assert.equal(db.prepare('SELECT revoked FROM journal_sources WHERE session_id=?').get('correct-fixture').revoked, 1);
    assert.equal(db.prepare('SELECT revoked FROM journal_sessions WHERE session_id=?').get('correct-fixture').revoked, 0);
  });
  for (const operation of ['forget', 'correct']) check(`${operation} rolls back both support revocation and the human mutation on a journal fault`, () => {
    const id = derive(`rollback-${operation}`);
    const revision = store.getMemoryRevision();
    const count = db.prepare('SELECT COUNT(*) n FROM memories').get().n;
    const faulty = business({ revokeMemoryEvidence: (memoryIds, reason) => { journal.revokeMemoryEvidence({ memoryIds, reason }); throw new Error('synthetic journal failure'); } });
    assert.throws(() => operation === 'forget' ? faulty.forget(caller, id, authorization) : faulty.correct(caller, id, 'Must roll back.', authorization), /synthetic journal failure/);
    assert.equal(store.getMemory(id).status, 'active');
    assert.equal(store.getMemoryRevision(), revision);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n, count);
    assert.equal(db.prepare('SELECT revoked FROM journal_sources WHERE session_id=?').get(`rollback-${operation}`).revoked, 0);
  });
  check('confirm-correct spends only the old support and promotes the explicit human decision atomically', () => {
    const id = derive('confirm-fixture');
    const draft = store.insertMemory({ kind: 'fact', content: 'Explicit replacement cabinet.', importance: 7, supersedes: id }, { provenance: 'tool', source: 'tool-correct', scope: 'project', projectId: 'pj-fact-fixture' });
    business().confirmCorrect(caller, draft.id, authorization);
    assert.equal(store.getMemory(id).status, 'corrected');
    assert.equal(store.getMemory(draft.id).meta.provenance, 'user');
    assert.equal(db.prepare('SELECT revoked FROM journal_sources WHERE session_id=?').get('confirm-fixture').revoked, 1);
    assert.equal(db.prepare('SELECT revoked FROM journal_sessions WHERE session_id=?').get('confirm-fixture').revoked, 0);
  });
  check('confirm-correct rolls back promotion and support revocation together on a journal fault', () => {
    const id = derive('confirm-rollback');
    const draft = store.insertMemory({ kind: 'fact', content: 'Uncommitted replacement cabinet.', importance: 7, supersedes: id }, { provenance: 'tool', source: 'tool-correct', scope: 'project', projectId: 'pj-fact-fixture' });
    const revision = store.getMemoryRevision();
    const faulty = business({ revokeMemoryEvidence: (memoryIds, reason) => { journal.revokeMemoryEvidence({ memoryIds, reason }); throw new Error('synthetic journal failure'); } });
    assert.throws(() => faulty.confirmCorrect(caller, draft.id, authorization), /synthetic journal failure/);
    assert.equal(store.getMemory(id).status, 'active');
    assert.equal(store.getMemory(draft.id).meta.provenance, 'tool');
    assert.equal(store.getMemoryRevision(), revision);
    assert.equal(db.prepare('SELECT revoked FROM journal_sources WHERE session_id=?').get('confirm-rollback').revoked, 0);
  });
  check('a pre-forget claim over another coordinate cannot publish the same forgotten fact late', () => {
    const id = derive('late-fact');
    const text = store.getMemory(id).content;
    append('late-fact', 1, text);
    const held = journal.claimWork({ kind: 'extract' });
    business().forget(caller, id, authorization);
    const late = journal.commitChunkResult(held, 0, { kind: 'consumed', candidates: [{ text, kind: 'fact', provenance: 'derived', source: 'llm-extract' }] });
    assert.equal(late.memoryIds.length, 0, 'a human forget must fence matching late facts, not only the already-linked coordinate');
  });
  check('missing revocation ownership refuses a derived mutation instead of announcing an uncovered success', () => {
    const id = derive('missing-lane');
    assert.throws(() => business(null).forget(caller, id, authorization));
  });
  console.log(`${passed} fact-policy checks passed; synthetic store retained at ${dir}`);
} finally { store.close(); }
