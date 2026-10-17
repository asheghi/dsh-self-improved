#!/usr/bin/env node
// Fabricated captures here are validation tests ONLY, never efficacy evidence.
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { evaluateLearnedProcedure } from './measure-learned-procedure.mjs';
const root = await mkdtemp(resolve('fixtures/skill-measurement/validator-test-'));
let n = 0, passed = 0;
async function artifact(value = `test-only-${n}`) {
  const bytes = typeof value === 'string' ? value : JSON.stringify(value);
  const path = `${n++}.json`;
  await writeFile(join(root, path), bytes);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex') };
}
try {
  const bundle = { version: 'learned-procedure-capture-v1', scope: 'isolated-project', projectId: 'test', freezeRevision: 'test-only', protocol: await artifact(),
    skill: { draftId: 'draft', name: 'test-skill', evaluationVersion: 'structural-review-v1', draft: await artifact(), synthesisCapture: await artifact(), activationCapture: await artifact(), sources: [] }, tasks: [] };
  for (let i = 0; i < 2; i++) bundle.skill.sources.push({ episodeId: `e${i}`, rootSessionId: `source${i}`, projectId: 'test', reviewed: true, outcome: 'verified-success', delegated: false, capture: await artifact(), verifier: await artifact() });
  for (const kind of ['procedure', 'unrelated-control', 'current-rule-control']) {
    const task = { id: kind, kind, prompt: await artifact(), initialState: await artifact(), verifier: await artifact() };
    for (const arm of ['baseline', 'learned']) {
      const capture = await artifact();
      const success = kind !== 'procedure' || arm === 'learned';
      task[arm] = { rootSessionId: `${kind}-${arm}`, promptSha256: task.prompt.sha256, initialStateSha256: task.initialState.sha256,
        configuration: { provider: 'test-not-real', model: 'test', sampling: 'fixed', toolPolicySha256: 'test', systemContextSha256: 'test' }, capture,
        verification: await artifact({ captureSha256: capture.sha256, verifierSha256: task.verifier.sha256, exitCode: success ? 0 : 1, passed: success }),
        invocationCapture: await artifact(), invokedSkills: arm === 'baseline' ? [] : [{ name: 'test-skill', draftId: 'draft', draftSha256: bundle.skill.draft.sha256 }],
        safetyViolations: 0, metrics: { promptTokens: 10, providerCalls: 1, cost: 0, elapsedMs: 1 } };
    }
    bundle.tasks.push(task);
  }
  const report = await evaluateLearnedProcedure(bundle, root);
  assert.equal(report.observedBenefit, true); assert.equal(report.phaseEAccepted, false); assert.equal(report.evidenceOnly, true); passed++;
  async function rejects(change, pattern) { const copy = structuredClone(bundle); await change(copy); await assert.rejects(evaluateLearnedProcedure(copy, root), pattern); passed++; }
  await rejects(b => { b.skill.sources[1].rootSessionId = 'source0'; }, /not independent/);
  await rejects(b => { b.skill.sources[0].delegated = true; }, /independently verified/);
  await rejects(b => { b.tasks[0].learned.invokedSkills = []; }, /exact native draft/);
  await rejects(b => { b.tasks[0].baseline.invokedSkills = b.tasks[0].learned.invokedSkills; }, /baseline must not learn/);
  await rejects(b => { b.tasks[0].learned.configuration.model = 'different'; }, /configuration differs/);
  await rejects(b => { delete b.tasks[0].learned.metrics.cost; }, /cost must be measured or explicitly unavailable/);
  await rejects(b => { b.tasks[0].learned.capture.sha256 = 'a'.repeat(64); }, /hash mismatch/);
  await rejects(b => { b.tasks[0].learned.rootSessionId = 'source0'; }, /inherited from training/);
  await rejects(b => { b.tasks[0].learned.verification = b.tasks[0].baseline.verification; }, /verification must bind/);
  await rejects(b => { b.tasks = [b.tasks[0]]; }, /held-out tasks and controls/);
  const unknownCost = structuredClone(bundle); for (const task of unknownCost.tasks) for (const arm of ['baseline','learned']) task[arm].metrics.cost = null;
  const unknownCostReport = await evaluateLearnedProcedure(unknownCost, root);
  assert.equal(unknownCostReport.costMeasured, false); assert.equal(unknownCostReport.totals.learned.cost, null); assert.equal(unknownCostReport.observedBenefit, true); assert.equal(unknownCostReport.costBenefitClaimAllowed, false); passed++;
  const unsafe = structuredClone(bundle); unsafe.tasks[0].learned.safetyViolations = 1;
  assert.equal((await evaluateLearnedProcedure(unsafe, root)).observedBenefit, false); passed++;
  const ties = structuredClone(bundle);
  ties.tasks[0].baseline.verification = await artifact({ captureSha256: ties.tasks[0].baseline.capture.sha256, verifierSha256: ties.tasks[0].verifier.sha256, exitCode: 0, passed: true });
  assert.equal((await evaluateLearnedProcedure(ties, root)).observedBenefit, false); passed++;
  console.log(`${passed} learned-procedure evidence validation checks PASS (test-only captures; no efficacy run)`);
} finally {
  // Exact mkdtemp-owned path, confined beneath known test root before removal.
  assert.ok(root.startsWith(resolve('fixtures/skill-measurement/validator-test-')));
  await rm(root, { recursive: true, force: true });
}
