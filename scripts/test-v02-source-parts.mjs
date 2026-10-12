#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../lib/storage.js';
import { MemoryJournalV02, minimizeEventText } from '../lib/memory-journal-v02.js';

// Isolated real SQLite; retained synthetic fixture directories aid diagnosis.
const raw = 'HEAD-MARK ' + 'plain prose '.repeat(18000) + '\nMIDDLE-MARK\npassword=CanarySecretOversize\n' + 'tail prose '.repeat(12000) + ' TAIL-MARK';
const expected = minimizeEventText('user', raw, Number.MAX_SAFE_INTEGER).text;
assert.ok(raw.length > 200000);
assert.ok(!expected.includes('CanarySecretOversize'));
let passes = 0;
for (const mode of ['complete', 'deleted-part', 'tampered-part', 'late-tamper', 'rollback']) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-source-parts-'));
  let store = new MemoryStore(dir);
  let journal = new MemoryJournalV02(store, { chunkMaxChars: 5000 });
  let db = store.getJournalSqlite();
  const input = { sessionId: mode, projectId: 'synthetic', producer: { delegated: false }, events: [{ seq: 0, ts: 1, kind: 'user', sourceKind: 'user', text: raw }], sourceMaxChars: 200000, oversizePolicy: 'segment' };
  try {
    if (mode === 'rollback') {
      db.exec("CREATE TRIGGER fail_parts BEFORE INSERT ON journal_source_parts BEGIN SELECT RAISE(ABORT, 'synthetic crash'); END;");
      assert.throws(() => journal.appendSession(input), /synthetic crash/);
      for (const table of ['journal_sessions', 'journal_sources', 'journal_source_parts', 'journal_jobs', 'journal_chunks']) {
        assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
      }
    } else {
      const report = journal.appendSession(input);
      assert.equal(report.stored, 1);
      assert.ok(report.chunksPlanned > 32);
      assert.equal(journal.appendSession(input).deduped, 1);
      const pieces = db.prepare('SELECT text FROM journal_sources UNION ALL SELECT text FROM journal_source_parts').all();
      assert.ok(pieces.length > 1);
      for (const piece of pieces) {
        assert.ok(piece.text.length <= 200000);
        assert.ok(!piece.text.includes('CanarySecretOversize'));
      }
      store.close();
      store = new MemoryStore(dir);
      db = store.getJournalSqlite();
      journal = new MemoryJournalV02(store, { chunkMaxChars: 5000 });
      journal.recoverStartup();
      const claim = journal.claimWork();
      assert.ok(claim);
      if (mode === 'deleted-part') db.prepare('DELETE FROM journal_source_parts WHERE idx = 1').run();
      if (mode === 'tampered-part') db.prepare("UPDATE journal_source_parts SET text = text || 'forged' WHERE idx = 1").run();
      if (mode === 'complete') {
        let received = '';
        for (let idx = 0; idx < report.chunksPlanned; idx++) {
          const evidence = journal.readChunkEvidence(claim);
          assert.equal(evidence.status, 'ok');
          assert.equal(evidence.chunkIdx, idx);
          for (const event of evidence.events) {
            assert.ok(event.text.length <= 5000);
            received += event.text;
          }
          assert.equal(journal.commitChunkResult(claim, idx, { kind: 'consumed', candidates: [] }).acked, true);
          if (idx < report.chunksPlanned - 1) assert.deepEqual(journal.getConsumedRanges(mode), []);
        }
        assert.equal(received, expected);
        assert.ok(received.includes('MIDDLE-MARK') && received.endsWith('TAIL-MARK'));
        assert.deepEqual(journal.getConsumedRanges(mode), [{ fromSeq: 0, toSeq: 0 }]);
        assert.equal(journal.getJob(claim.jobId).state, 'done');
      } else {
        if (mode === 'late-tamper') {
          assert.equal(journal.readChunkEvidence(claim).status, 'ok');
          db.prepare("UPDATE journal_source_parts SET text = text || 'late forgery' WHERE idx = 1").run();
        }
        const evidence = journal.readChunkEvidence(claim);
        assert.equal(evidence.status, 'unavailable');
        assert.equal(evidence.reasonCode, 'corrupt');
        assert.throws(() => journal.commitChunkResult(claim, 0, { kind: 'consumed', candidates: [{ text: 'ghost fact', kind: 'fact', scope: 'project' }] }), error => error.code === 'chunk-state-invalid' && error.detail.reasonCode === 'corrupt');
        assert.deepEqual(journal.getConsumedRanges(mode), []);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM journal_derived').get().n, 0);
        assert.equal(db.prepare('SELECT COUNT(*) n FROM memories').get().n, 0);
      }
    }
    console.log(`PASS ${mode}`);
    passes++;
  } finally { store.close(); }
}
console.log(`${passes} PASS / 0 FAIL`);
