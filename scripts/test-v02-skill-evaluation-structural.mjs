#!/usr/bin/env node
/**
 * scripts/test-v02-skill-evaluation-structural.mjs — the Phase E evaluation
 * producer, and the writer that lets a draft honestly reach `evaluated`.
 *
 * The producer must FAIL CLOSED on every degraded input (a claim without
 * evidence, evidence from one session, evidence that stopped being reviewable,
 * credential-shaped text, an oversized or step-less body) and must never claim
 * behavioral measurement. The writer must refuse a report that does not match
 * the row or that hand-writes its own verdict.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const { evaluateSkillDraftStructure, STRUCTURAL_EVALUATION_VERSION } = await import(join(repo, 'lib/skill-evaluation-structural.js'));
const { MemoryStore } = await import(join(repo, 'lib/storage.js'));
const { handleMemoryCommand } = await import(join(repo, 'lib/commands.js'));

let passes = 0, failures = 0;
const check = (name, fn) => {
  try { fn(); passes++; console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' :: ' + (error && error.message)); }
};
const body = (name, steps, extra = []) => ['---', `name: ${name}`, 'description: A reviewed procedure',
  'whenToUse: when the fixture asks', ...extra, '---', ...steps.map((s, i) => `${i + 1}. ${s}`)].join('\n');
const draft = (over = {}) => ({ id: 'draft-1', projectId: 'proj-1', fingerprint: 'fp-1', name: 'reviewed-skill',
  markdown: body('reviewed-skill', ['first step', 'second step']), sourceEpisodeIds: ['ep-1', 'ep-2'], ...over });
const episode = (over = {}) => ({ id: 'ep-1', projectId: 'proj-1', fingerprint: 'fp-1', sessionId: 's-1',
  status: 'reviewed', reviewedAt: 1, delegated: false, rejectReason: null, ...over });
const source = (d = draft(), episodes = [episode(), episode({ id: 'ep-2', sessionId: 's-2' })]) => ({
  getSkillDraft: (id, projectId) => (id === d.id && (projectId === undefined || projectId === d.projectId) ? d : undefined),
  getEpisode: (id) => episodes.find((e) => e.id === id),
});

check('a well-formed draft with independent, reviewable evidence is eligible for human review', () => {
  const report = evaluateSkillDraftStructure(source(), 'draft-1', { projectId: 'proj-1', now: 42 });
  assert.equal(report.eligibleForHumanReview, true, JSON.stringify(report.checks.filter(c => !c.passed)));
  assert.equal(report.passed, report.total);
  assert.equal(report.mode, 'structural-review'); assert.equal(report.staticOnly, true);
  assert.equal(report.version, STRUCTURAL_EVALUATION_VERSION); assert.equal(report.evaluatedAt, 42);
});
check('evidence from ONE session never satisfies the quorum', () => {
  const report = evaluateSkillDraftStructure(source(draft(), [episode(), episode({ id: 'ep-2' })]), 'draft-1');
  assert.equal(report.eligibleForHumanReview, false);
  const check6 = report.checks.find((c) => c.id === 'independent-sessions');
  assert.equal(check6.passed, false); assert.match(check6.reason, /1 independent session/);
});
check('evidence that stopped being reviewable, delegated evidence and foreign fingerprints all fail', () => {
  const cases = [
    [episode({ status: 'pending', reviewedAt: null }), 'citations-reviewable'],
    [episode({ delegated: true }), 'citations-reviewable'],
    [episode({ rejectReason: 'late-evidence' }), 'citations-reviewable'],
    [episode({ fingerprint: 'other' }), 'citations-reviewable'],
    [episode({ projectId: 'other-project' }), 'citations-reviewable'],
  ];
  for (const [bad, id] of cases) {
    const report = evaluateSkillDraftStructure(source(draft(), [bad, episode({ id: 'ep-2', sessionId: 's-2' })]), 'draft-1');
    assert.equal(report.eligibleForHumanReview, false, JSON.stringify(bad));
    assert.equal(report.checks.find((c) => c.id === id).passed, false);
  }
  const missing = evaluateSkillDraftStructure(source(draft(), [episode()]), 'draft-1');
  assert.equal(missing.eligibleForHumanReview, false, 'a cited episode that no longer exists fails closed');
});
check('a malformed body, credential-shaped text and no steps all fail with a named reason', () => {
  const noSteps = evaluateSkillDraftStructure(source(draft({ markdown: body('reviewed-skill', []) })), 'draft-1');
  assert.equal(noSteps.checks.find((c) => c.id === 'body-procedure').passed, false);
  const mismatched = evaluateSkillDraftStructure(source(draft({ markdown: body('other-name', ['x']) })), 'draft-1');
  assert.equal(mismatched.checks.find((c) => c.id === 'body-frontmatter').passed, false);
  const secret = evaluateSkillDraftStructure(source(draft({ markdown: body('reviewed-skill', ['export ghp_AbCdEfGhIjKlMnOpQrStUvWx']) })), 'draft-1');
  assert.equal(secret.checks.find((c) => c.id === 'body-credential-shapes').passed, false);
  const huge = evaluateSkillDraftStructure(source(draft({ markdown: body('reviewed-skill', ['x'.repeat(4100)]) })), 'draft-1');
  assert.equal(huge.eligibleForHumanReview, false);
  assert.equal(evaluateSkillDraftStructure(source(), 'missing-draft'), null);
});
check('only an anchor-matching, self-consistent report can move a draft to evaluated', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dsi-structural-')), 'store');
  const store = new MemoryStore(dir);
  const db = store.getJournalSqlite();
  const insert = (id, over = {}) => db.prepare(`INSERT INTO skill_drafts(id,project_id,fingerprint,name,markdown,source_episode_ids,status,evaluation_version,evaluation_report,active_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, 'proj-1', 'fp-1', 'reviewed-skill', body('reviewed-skill', ['first step']), '["ep-1","ep-2"]', 'draft', null, null, null, 1, 1);
  insert('draft-a');
  // The writer rechecks real evidence eligibility, so this store needs the
  // reviewed episodes the draft cites (direct rows: the review path is covered
  // by the episode suites).
  const insertEpisode = (id, sessionId) => db.prepare(`INSERT INTO episodes(id,session_id,project_id,turn,status,started_at,ended_at,updated_at,first_seq,last_seq,reviewed_at,summary,confidence,fingerprint,delegated,reject_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, sessionId, 'proj-1', 1, 'reviewed', 1, 2, 2, 0, 1, 2, null, null, 'fp-1', 0, null);
  insertEpisode('ep-1', 's-1'); insertEpisode('ep-2', 's-2');
  const good = evaluateSkillDraftStructure(source(draft({ id: 'draft-a' })), 'draft-a', { projectId: 'proj-1' });
  assert.equal(store.recordSkillDraftStructuralEvaluation('draft-a', good.version, { ...good, checks: [] }), false, 'an empty check list is refused');
  assert.equal(store.recordSkillDraftStructuralEvaluation('draft-a', good.version, { ...good, draftId: 'someone-else' }), false, 'a report about another draft is refused');
  assert.equal(store.recordSkillDraftStructuralEvaluation('draft-a', good.version, { ...good, eligibleForHumanReview: true, passed: 0 }), false, 'a hand-written verdict is refused');
  assert.equal(store.recordSkillDraftStructuralEvaluation('draft-a', good.version, good), true);
  assert.equal(store.getSkillDraft('draft-a').status, 'evaluated');
  assert.equal(store.getSkillDraft('draft-a').evaluationVersion, good.version);
  assert.equal(store.recordSkillDraftStructuralEvaluation('draft-a', good.version, good), false, 'evaluated is not re-evaluatable');
  store.close();
});
check('the command runs the producer and refuses to evaluate a degraded draft', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dsi-structural-cmd-')), 'store');
  const store = new MemoryStore(dir);
  const db = store.getJournalSqlite();
  db.prepare(`INSERT INTO skill_drafts(id,project_id,fingerprint,name,markdown,source_episode_ids,status,evaluation_version,evaluation_report,active_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run('draft-cmd', 'proj-1', 'fp-1', 'reviewed-skill', body('reviewed-skill', ['first step']), '["ep-1","ep-2"]', 'draft', null, null, null, 1, 1);
  const opts = { episodeEnabled: () => true, skillDraftProjectId: 'proj-1' };
  const refused = handleMemoryCommand(store, 'skill-evaluate draft-cmd', opts);
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /citations-reviewable/, 'the failing check is named, not summarised away');
  assert.equal(store.getSkillDraft('draft-cmd').status, 'draft', 'a failed evaluation must not move the draft');
  assert.match(handleMemoryCommand(store, 'skill-evaluate missing', opts).text, /not found/);
  assert.match(handleMemoryCommand(store, 'skill-evaluate draft-cmd', { episodeEnabled: () => true }).text, /project scope/);
  store.close();
});

console.log(`${passes} structural-evaluation gates PASS, ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
