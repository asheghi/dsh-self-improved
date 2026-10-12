#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/storage.js';
import { MemoryJournalV02 } from '../lib/memory-journal-v02.js';
const store = new MemoryStore(mkdtempSync(join(tmpdir(), 'dsh-claim-lease-budget-')));
const now = 100000;
const journal = new MemoryJournalV02(store, { nowMs: () => now, chunkMaxChars: 600 });
const db = store.getJournalSqlite();
try {
  const report = journal.appendSession({ sessionId: 'lease-budget', projectId: 'synthetic', producer: { delegated: false }, sourceMaxChars: 20000, events: [{ seq: 0, ts: now, kind: 'user', text: 'a'.repeat(1400) }] });
  assert.equal(report.chunksPlanned, 3);
  const first = journal.claimWork({ kind: 'extract' }, 1000);
  const row = () => db.prepare('SELECT state, lease_expires_at, attempt_count FROM journal_jobs WHERE id = ?').get(first.jobId);
  assert.equal(row().lease_expires_at, now + 1000, 'numeric lease API stays exact regardless of chunk count');
  assert.equal(journal.commitChunkResult(first, 0, { kind: 'consumed', candidates: [] }).acked, true);
  journal.releaseClaim(first, 'synthetic partial progress');
  console.log('PASS numeric-only lease compatibility');
  for (const invalid of [0, -1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => journal.claimWork({ perChunkLeaseMs: invalid }, 1000), error => error.code === 'invalid-input');
    assert.equal(row().state, 'queued');
    assert.equal(row().attempt_count, 1, 'invalid budgets do not acquire or burn attempts');
  }
  console.log('PASS invalid and overflow budgets roll back without claim mutation');
  const second = journal.claimWork({ perChunkLeaseMs: 2000 }, 1000);
  assert.equal(second.chunksTotal, 3);
  assert.equal(row().lease_expires_at, now + 2 * 2000 + 5000, 'lease counts remaining chunks, not already acked prefix');
  assert.equal(row().attempt_count, 2, 'one explicit claim increments one attempt, unchanged');
  assert.equal(journal.readChunkEvidence(second).chunkIdx, 1);
  console.log('PASS atomic pending-only claim budget');
  for (const idx of [1, 2]) assert.equal(journal.commitChunkResult(second, idx, { kind: 'consumed', candidates: [] }).acked, true);
  assert.equal(row().state, 'done');
  assert.equal(row().lease_expires_at, null);
  assert.deepEqual(journal.getConsumedRanges('lease-budget'), [{ fromSeq: 0, toSeq: 0 }]);
  console.log('PASS final acknowledgment retains terminal ownership seal');
  console.log('4 PASS / 0 FAIL');
} finally { store.close(); }
