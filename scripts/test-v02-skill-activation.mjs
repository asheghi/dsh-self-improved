#!/usr/bin/env node
/**
 * scripts/test-v02-skill-activation.mjs — safety core of Phase E activation.
 *
 * Pins the properties that make activation safe: the invocation policy is
 * FORCED (never model-invocable, not caller-controlled), the body is rendered
 * with its provenance/verification header, a name can only be activated once,
 * rollback disposes exactly once, and a disposal that throws never reports
 * success.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const { LearnedSkillActivator, renderLearnedSkillBody, SKILL_EVALUATION_VERSION } = await import(join(repo, 'lib/skill-activation.js'));

let passes = 0, failures = 0;
const check = (name, fn) => {
  try { fn(); passes++; console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' :: ' + (error && error.message)); }
};
/** Recording host: captures what would be registered and hands back a disposer. */
const host = () => {
  const registered = []; const disposed = [];
  return {
    registered, disposed,
    register(skill) { registered.push(skill); return () => { disposed.push(skill.name); }; },
  };
};
const request = (over = {}) => ({
  draftId: 'draft-1', name: 'pnpm-build-project', description: 'Build this project with pnpm',
  whenToUse: 'when a build is needed', steps: ['run pnpm run build', 'check the exit status'],
  citations: ['episode e1 / call-1', 'episode e2 / call-2'], ...over,
});

check('activation registers a runtime skill with a FORCED user-only policy', () => {
  const h = host(); const activator = new LearnedSkillActivator(h, () => 1700000000000);
  const record = activator.activate(request({ invocation: { modelInvocable: true, userInvocable: true } }));
  assert.equal(h.registered.length, 1);
  const skill = h.registered[0];
  assert.equal(skill.source, 'runtime');
  assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: true }, 'a caller must not be able to make a learned skill model-invocable');
  assert.deepEqual(record.invocation, { modelInvocable: false, userInvocable: true });
  assert.equal(record.evaluationVersion, null, 'no evaluation was supplied, so none may be invented');
  assert.equal(record.contentChars, skill.content.length);
});
check('the rendered body carries the provenance/verification header, evidence and bounded size', () => {
  const h = host(); const activator = new LearnedSkillActivator(h, () => 1700000000000);
  activator.activate(request());
  const body = h.registered[0].content;
  assert.match(body, /activated by the operator/i);
  assert.match(body, /not permission, and not proof/i);
  assert.match(body, /Verify the current environment/);
  assert.match(body, /Evaluation: static-eval-1 \(static\)/, 'a missing evaluation is stated, never implied present');
  assert.match(body, /episode e1 \/ call-1/);
  assert.match(body, /1\. run pnpm run build/);
  assert.equal(body, renderLearnedSkillBody({ name: 'pnpm-build-project', steps: ['run pnpm run build', 'check the exit status'], citations: ['episode e1 / call-1', 'episode e2 / call-2'], activatedAt: 1700000000000 }), 'rendering is deterministic');
  assert.ok(body.length <= 4000);
});
check('invalid names, empty content and oversized procedures are refused', () => {
  const h = host(); const activator = new LearnedSkillActivator(h, () => 1);
  for (const name of ['Bad Name', 'UPPER', 'trailing-', '-leading', 'double--dash', '', 'a'.repeat(65)]) {
    assert.throws(() => activator.activate(request({ name })), /kebab-case|name/, `name ${JSON.stringify(name)} must be refused`);
  }
  assert.throws(() => activator.activate(request({ steps: [] })), /steps/);
  assert.throws(() => activator.activate(request({ steps: new Array(25).fill('x') })), /steps/);
  assert.throws(() => activator.activate(request({ citations: [] })), /citations/);
  assert.throws(() => activator.activate(request({ description: 'x'.repeat(201) })), /description/);
  assert.throws(() => activator.activate(request({ draftId: 'a\0b' })), /NUL/);
  assert.throws(() => activator.activate(request({ steps: ['x'.repeat(401)] })), /steps/);
  assert.equal(h.registered.length, 0, 'no refused request may reach the skill registry');
});
check('a name can only be activated once, and rollback frees it again', () => {
  const h = host(); const activator = new LearnedSkillActivator(h, () => 5);
  activator.activate(request());
  assert.throws(() => activator.activate(request()), /already activated/);
  assert.equal(activator.size, 1);
  assert.equal(activator.rollback('pnpm-build-project'), true);
  assert.deepEqual(h.disposed, ['pnpm-build-project']);
  assert.equal(activator.size, 0);
  assert.equal(activator.rollback('pnpm-build-project'), false, 'rollback is not repeatable');
  assert.equal(h.disposed.length, 1, 'a disposer runs exactly once');
  activator.activate(request());
  assert.equal(activator.size, 1, 'the name is usable again after a real rollback');
});
check('a failing disposer never reports a successful rollback', () => {
  let calls = 0;
  const activator = new LearnedSkillActivator({ register: () => () => { calls++; throw new Error('registry refused'); } }, () => 7);
  activator.activate(request());
  assert.equal(activator.rollback('pnpm-build-project'), false);
  assert.equal(calls, 1);
  assert.equal(activator.size, 1, 'the record stays so the operator can retry');
  assert.equal(activator.list()[0].name, 'pnpm-build-project');
});
check('unload tears every activation down and never throws', () => {
  const h = host(); const activator = new LearnedSkillActivator(h, () => 9);
  activator.activate(request());
  activator.activate(request({ name: 'other-learned-skill' }));
  assert.equal(activator.size, 2);
  activator.dispose();
  assert.equal(activator.size, 0);
  assert.deepEqual(h.disposed.sort(), ['other-learned-skill', 'pnpm-build-project']);
  activator.dispose(); // idempotent
});

console.log(`${passes} skill-activation gates PASS, ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
