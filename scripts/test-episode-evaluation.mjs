import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { MemoryStore } from '../lib/storage.js';
import { assembleSessionEpisodes } from '../lib/episodes.js';
import { evaluateSkillDraftOffline, parseStaticFixtureReviewReport } from '../lib/episode-evaluation.js';
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const dir = mkdtempSync(join(repo, '.tmp-import-lane/static-fixture-review-'));
const store = new MemoryStore(dir);
let passes = 0;
const check = (name, fn) => { fn(); passes++; console.log('PASS ' + name); };
function reviewedEpisode(sessionId) {
  const callId = `${sessionId}-call`;
  store.appendEpisodeEvents(sessionId, 'project-a', { delegated: false }, [
    { kind: 'call', callId, turn: 1, step: 0, seq: 1, at: 1, payload: JSON.stringify({ toolName: 'fixture', argumentsRedacted: '{}', callId }) },
    { kind: 'result', callId, turn: 1, step: 0, seq: 2, at: 2, payload: JSON.stringify({ toolCallId: callId, resultExcerpt: 'ok', resultTruncated: 0, isError: 0, errorName: null, errorCode: null, toolHint: null }) },
    { kind: 'turn-end', callId: '', turn: 1, step: null, seq: 3, at: 3, payload: JSON.stringify({ reasonKind: 'completed' }) },
  ]);
  assembleSessionEpisodes(store, sessionId);
  const episode = store.getEpisodeBySessionTurn(sessionId, 1);
  assert.ok(episode);
  assert.equal(store.setEpisodeReview(episode.id, { summary: 'synthetic static review evidence', confidence: 1, status: 'reviewed' }), true);
  return store.getEpisode(episode.id);
}
try {
  const first = reviewedEpisode('eval-a'); const second = reviewedEpisode('eval-b');
  assert.equal(first.fingerprint, second.fingerprint);
  const fingerprint = first.fingerprint;
  const { draft } = store.createSkillDraft({ projectId: 'project-a', fingerprint, name: 'fixture', markdown: '---\nname: fixture\n---\n1. Verify static fixture coverage', sourceEpisodeIds: [first.id, second.id], minIndependentSupport: 2 });
  const fixture = { id: 'case-1', projectId: draft.projectId, fingerprint, input: 'synthetic fixture label', expectedProcedure: ['verify', 'static', 'fixture'] };
  const review = cases => evaluateSkillDraftOffline(store, draft, { enabled: true, cases });
  check('default off does not inspect malformed draft or options', () => assert.equal(evaluateSkillDraftOffline(store, null, { cases: [] }), null));
  check('missing draft denies', () => assert.equal(evaluateSkillDraftOffline(store, { id: 'missing', projectId: 'project-a', fingerprint }, { enabled: true, cases: [fixture] }), null));
  let report;
  check('actual assembled reviewed sources produce bounded static coverage only', () => {
    report = review([fixture]); assert.ok(report); assert.equal(report.mode, 'static-fixture-review');
    assert.equal(report.eligibleForHumanReview, false); assert.equal(report.syntheticOnly, true); assert.equal(report.passed, 1);
    const persisted = store.getSkillDraft(draft.id); assert.equal(persisted.status, 'draft'); assert.equal(persisted.evaluationVersion, report.version);
    assert.deepEqual(JSON.parse(persisted.evaluationReport), report);
  });
  check('empty assertions deny without changing report', () => assert.equal(review([{ ...fixture, expectedProcedure: [] }]), null));
  check('cross-project cases deny', () => assert.equal(review([{ ...fixture, projectId: 'other' }]), null));
  check('oversized cases and identifiers deny', () => { assert.equal(review([{ ...fixture, id: 'x'.repeat(129) }]), null); assert.equal(review(Array(51).fill(fixture)), null); });
  check('oversized assertions deny', () => assert.equal(review([{ ...fixture, expectedProcedure: ['x'.repeat(4001)] }]), null));
  check('duplicate case IDs deny', () => assert.equal(review([fixture, fixture]), null));
  check('getter inputs never execute', () => {
    let touched = 0; const evil = { ...draft, get id() { touched++; throw new Error('getter'); } };
    assert.equal(evaluateSkillDraftOffline(store, evil, { enabled: true, cases: [fixture] }), null);
    const evilCase = { ...fixture, get input() { touched++; throw new Error('getter'); } };
    assert.equal(review([evilCase]), null); assert.equal(touched, 0);
  });
  check('serialization hooks are rejected without invocation', () => {
    let touched = 0; assert.equal(store.recordSkillDraftEvaluation(draft.id, report.version, { ...report, toJSON() { touched++; return report; } }), false);
    assert.equal(touched, 0);
  });
  check('forged report scope or version fails strict binding', () => {
    assert.equal(parseStaticFixtureReviewReport({ ...report, projectId: 'other' }), null);
    assert.equal(store.recordSkillDraftEvaluation(draft.id, 'mismatch', report), false);
  });
  check('recorder failure is returned as denial', () => {
    const original = store.recordSkillDraftEvaluation; store.recordSkillDraftEvaluation = () => false;
    try { assert.equal(review([fixture]), null); } finally { store.recordSkillDraftEvaluation = original; }
  });
  check('approved draft cannot be downgraded or overwritten', () => {
    store.getJournalSqlite().prepare("UPDATE skill_drafts SET status='approved' WHERE id=?").run(draft.id);
    assert.equal(review([fixture]), null); assert.equal(store.recordSkillDraftEvaluation(draft.id, report.version, report), false);
    assert.equal(store.getSkillDraft(draft.id).status, 'approved');
    store.getJournalSqlite().prepare("UPDATE skill_drafts SET status='draft' WHERE id=?").run(draft.id);
  });
  check('revoked source blocks review and persisted report writes in the same store', () => {
    store.getJournalSqlite().prepare("UPDATE episodes SET status='rejected' WHERE id=?").run(first.id);
    assert.equal(review([fixture]), null); assert.equal(store.recordSkillDraftEvaluation(draft.id, report.version, report), false);
    store.getJournalSqlite().prepare("UPDATE episodes SET status='reviewed' WHERE id=?").run(first.id);
  });
  check('invalidated and activated drafts reject static review', () => {
    for (const status of ['invalidated', 'activated']) {
      store.getJournalSqlite().prepare('UPDATE skill_drafts SET status=? WHERE id=?').run(status, draft.id);
      assert.equal(review([fixture]), null); assert.equal(store.recordSkillDraftEvaluation(draft.id, report.version, report), false);
    }
  });
  console.log(`${passes} static fixture review gates PASS; no executable sandbox or held-out improvement claimed; fixture=${dir}`);
} finally { store.close(); }
