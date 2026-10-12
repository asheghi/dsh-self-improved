#!/usr/bin/env node
/**
 * scripts/test-v02-skill-activation-drafts.mjs — the DURABLE half of Phase E
 * activation: reviewed draft rows to live runtime skills and back.
 *
 * Pins: only an approved+evaluated draft activates; the status move is the
 * commit point and a losing compare-and-set rolls the registration back
 * (no orphan); rollback disposes and records; boot replays only drafts that are
 * still activated; invalidated support deactivates the live skill WITHOUT
 * rewriting its status.
 *
 * The drafts are inserted directly: draft CREATION and its evidence boundary
 * are covered by the episode/storage suites; what is under test here is the
 * transition contract.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const { MemoryStore } = await import(join(repo, 'lib/storage.js'));
const { LearnedSkillActivator } = await import(join(repo, 'lib/skill-activation.js'));
const { activateDraftSkill, rollbackDraftSkill, restoreActivatedDrafts, deactivateInvalidatedDrafts, activationRequestFromDraft } =
  await import(join(repo, 'lib/skill-activation-runtime.js'));

let passes = 0, failures = 0;
const check = (name, fn) => {
  try { fn(); passes++; console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' :: ' + (error && error.message)); }
};

const body = (name, description, steps) => [
  '---', `name: ${name}`, `description: ${description}`, 'whenToUse: when the same build is needed',
  'source_episodes: ["ep-1","ep-2"]', 'generated_at: 2026-01-01T00:00:00.000Z', '---',
  ...steps.map((step, i) => `${i + 1}. ${step}`),
].join('\n');

const addDraft = (db, over = {}) => {
  const draft = {
    id: 'draft-1', projectId: 'proj-1', fingerprint: 'fp-1', name: 'pnpm-build-project',
    markdown: body('pnpm-build-project', 'Build this project with pnpm', ['run pnpm run build', 'check the exit status']),
    sources: '["ep-1","ep-2"]', status: 'approved', evaluationVersion: 'static-eval-1', ...over,
  };
  db.prepare(`INSERT INTO skill_drafts(id,project_id,fingerprint,name,markdown,source_episode_ids,status,evaluation_version,evaluation_report,active_path,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(draft.id, draft.projectId, draft.fingerprint, draft.name, draft.markdown,
      draft.sources, draft.status, draft.evaluationVersion, '{}', null, 1, 1);
  return draft;
};
const recordingHost = () => {
  const registered = [], disposed = [];
  return { registered, disposed, register(skill) { registered.push(skill); return () => { disposed.push(skill.name); }; } };
};
const withStore = (fn) => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dsi-activation-')), 'store');
  const store = new MemoryStore(dir);
  try { return fn(store); } finally { store.close(); }
};

withStore((store) => {
  const host = recordingHost(), activator = new LearnedSkillActivator(host, () => 1000);
  const db = store.getJournalSqlite();
  addDraft(db);
  const deps = { store, activator };
  const outcome = activateDraftSkill(deps, 'draft-1');
  check('an approved, evaluated draft activates and is recorded as activated', () => {
    assert.equal(outcome.ok, true, outcome.reason);
    assert.equal(store.getSkillDraft('draft-1').status, 'activated');
    assert.equal(host.registered.length, 1);
    assert.deepEqual(host.registered[0].invocation, { modelInvocable: false, userInvocable: true });
    assert.match(host.registered[0].content, /activated by the operator/i);
    assert.match(host.registered[0].content, /1\. run pnpm run build/);
    assert.match(host.registered[0].content, /ep-1/);
  });
  check('an already-activated draft is refused, and a duplicate NAME cannot be activated twice', () => {
    const again = activateDraftSkill(deps, 'draft-1');
    assert.equal(again.ok, false, 'an activated draft is not approved any more');
    assert.equal(host.registered.length, 1);
    // A DIFFERENT approved draft that would claim the same skill name must be
    // refused by the registry-level uniqueness rule, not silently shadow it.
    const dbx = store.getJournalSqlite();
    addDraft(dbx, { id: 'draft-dup', name: 'pnpm-build-project', fingerprint: 'fp-dup' });
    const dup = activateDraftSkill(deps, 'draft-dup');
    assert.equal(dup.ok, false);
    assert.match(dup.reason, /already activated/);
    assert.equal(host.registered.length, 1, 'the shadowing draft never reached the registry');
    assert.equal(store.getSkillDraft('draft-dup').status, 'approved', 'a refused activation leaves the draft untouched');
  });
  check('rollback disposes exactly once and records rolled-back', () => {
    const rolled = rollbackDraftSkill(deps, 'pnpm-build-project');
    assert.equal(rolled.ok, true, rolled.reason);
    assert.deepEqual(host.disposed, ['pnpm-build-project']);
    assert.equal(store.getSkillDraft('draft-1').status, 'rolled-back');
    assert.equal(rollbackDraftSkill(deps, 'pnpm-build-project').ok, false);
    assert.equal(host.disposed.length, 1);
  });
  check('boot replays only durably activated drafts, and skips live ones', () => {
    const host2 = recordingHost(), activator2 = new LearnedSkillActivator(host2, () => 2000);
    const empty = restoreActivatedDrafts({ store, activator: activator2 });
    assert.deepEqual(empty, { restored: 0, skipped: 0, failed: [] }, 'a rolled-back draft is not replayed');
    store.transitionSkillDraft('draft-1', ['rolled-back'], 'activated');
    const restored = restoreActivatedDrafts({ store, activator: activator2 });
    assert.equal(restored.restored, 1);
    assert.equal(host2.registered.length, 1);
    const again = restoreActivatedDrafts({ store, activator: activator2 });
    assert.deepEqual(again, { restored: 0, skipped: 1, failed: [] }, 'a live activation is skipped, never double-registered');
  });
  check('invalidated support deactivates the live skill without rewriting the status', () => {
    const host3 = recordingHost(), activator3 = new LearnedSkillActivator(host3, () => 3000);
    restoreActivatedDrafts({ store, activator: activator3 });
    assert.equal(activator3.size, 1);
    assert.equal(store.transitionSkillDraft('draft-1', ['activated'], 'invalidated'), true);
    const swept = deactivateInvalidatedDrafts({ store, activator: activator3 });
    assert.deepEqual(swept, { deactivated: 1, failed: [] });
    assert.equal(activator3.size, 0);
    assert.deepEqual(host3.disposed, ['pnpm-build-project']);
    assert.equal(store.getSkillDraft('draft-1').status, 'invalidated', 'invalidation is a stronger fact than a rollback and must survive');
    assert.deepEqual(restoreActivatedDrafts({ store, activator: activator3 }), { restored: 0, skipped: 0, failed: [] });
  });
  check('a non-approved draft, an unevaluated draft and a corrupt body never activate', () => {
    const host4 = recordingHost(), activator4 = new LearnedSkillActivator(host4, () => 4000);
    const deps4 = { store, activator: activator4 };
    addDraft(db, { id: 'draft-2', name: 'still-a-claim', status: 'draft', fingerprint: 'fp-2' });
    assert.match(activateDraftSkill(deps4, 'draft-2').reason, /not approved/);
    addDraft(db, { id: 'draft-3', name: 'never-evaluated', status: 'approved', evaluationVersion: null, fingerprint: 'fp-3' });
    assert.match(activateDraftSkill(deps4, 'draft-3').reason, /no recorded evaluation/);
    addDraft(db, { id: 'draft-4', name: 'wrong-name-in-body', status: 'approved', fingerprint: 'fp-4',
      markdown: body('a-different-name', 'desc', ['step']) });
    assert.match(activateDraftSkill(deps4, 'draft-4').reason, /does not match/);
    addDraft(db, { id: 'draft-5', name: 'no-steps-at-all', status: 'approved', fingerprint: 'fp-5',
      markdown: ['---', 'name: no-steps-at-all', 'description: d', '---', ''].join('\n') });
    assert.match(activateDraftSkill(deps4, 'draft-5').reason, /no numbered procedure/);
    assert.equal(activateDraftSkill(deps4, 'missing-draft').reason, 'draft not found');
    assert.equal(host4.registered.length, 0, 'nothing refused may reach the skill registry');
  });
  check('the parser refuses a body whose frontmatter name disagrees with the row', () => {
    assert.throws(() => activationRequestFromDraft({ id: 'x', name: 'a-name', markdown: body('b-name', 'd', ['s']), sourceEpisodeIds: [] }), /does not match/);
  });
});

console.log(`${passes} draft-activation gates PASS, ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
