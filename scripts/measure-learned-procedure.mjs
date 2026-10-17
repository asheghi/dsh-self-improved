#!/usr/bin/env node
/** Offline evidence aggregation only. Never invokes a provider or changes a store.
 * Input assertions are NOT host attestations. A reviewer must verify captures.
 */
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };
const nonblank = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => new Set(values).size === values.length;
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export async function evaluateLearnedProcedure(bundle, root) {
  const base = await realpath(root);
  const artifacts = new Map();
  async function artifact(ref, label) {
    requireThat(nonblank(ref?.path) && /^[a-f0-9]{64}$/.test(ref?.sha256), `${label}: missing artifact/hash`);
    const path = await realpath(resolve(base, ref.path));
    const rel = relative(base, path);
    requireThat(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), `${label}: artifact outside evidence root`);
    const bytes = await readFile(path);
    requireThat(hash(bytes) === ref.sha256, `${label}: artifact hash mismatch`);
    artifacts.set(rel, ref.sha256);
    return bytes;
  }
  requireThat(bundle?.version === 'learned-procedure-capture-v1', 'unsupported capture version');
  requireThat(bundle.scope === 'isolated-project' && nonblank(bundle.projectId), 'isolated project required');
  await artifact(bundle.protocol, 'frozen protocol');
  requireThat(nonblank(bundle.freezeRevision), 'pre-execution freeze revision required');
  const skill = bundle.skill;
  requireThat(nonblank(skill?.draftId) && nonblank(skill?.name) && nonblank(skill?.evaluationVersion), 'recorded learned draft required');
  await artifact(skill.draft, 'draft');
  await artifact(skill.synthesisCapture, 'synthesis capture');
  await artifact(skill.activationCapture, 'isolated activation capture');
  requireThat(Array.isArray(skill.sources) && skill.sources.length >= 2, 'two independently verified training sources required');
  requireThat(unique(skill.sources.map(s => s.episodeId)), 'duplicate source episode');
  requireThat(unique(skill.sources.map(s => s.rootSessionId)), 'fork/replay roots are not independent');
  for (const source of skill.sources) {
    requireThat(nonblank(source.episodeId) && nonblank(source.rootSessionId) && source.projectId === bundle.projectId
      && source.reviewed === true && source.outcome === 'verified-success' && source.delegated === false,
    'source must be independently verified reviewed project evidence');
    await artifact(source.capture, 'training source');
    await artifact(source.verifier, 'training verification');
  }
  requireThat(Array.isArray(bundle.tasks) && bundle.tasks.length >= 3 && unique(bundle.tasks.map(t => t.id)), 'distinct held-out tasks and controls required');
  requireThat(bundle.tasks.some(t => t.kind === 'procedure') && bundle.tasks.some(t => t.kind === 'unrelated-control')
    && bundle.tasks.some(t => t.kind === 'current-rule-control'), 'procedure and both controls required');
  const trainingHashes = new Set(skill.sources.map(s => s.capture.sha256));
  let wins = 0, losses = 0, ties = 0, controlFailures = 0, safetyViolations = 0;
  const totals = Object.fromEntries(['baseline', 'learned'].map(a => [a, { passed: 0, promptTokens: 0, providerCalls: 0, cost: 0, elapsedMs: 0 }]));
  const sessionRoots = new Set();
  const perTask = [];
  let configuration;
  for (const task of bundle.tasks) {
    requireThat(nonblank(task.id) && ['procedure', 'unrelated-control', 'current-rule-control'].includes(task.kind), 'invalid task');
    await artifact(task.prompt, 'held-out prompt');
    requireThat(!trainingHashes.has(task.prompt.sha256), 'training capture reused as held-out prompt');
    await artifact(task.initialState, 'held-out initial state');
    await artifact(task.verifier, 'held-out verifier');
    const outcomes = {};
    for (const arm of ['baseline', 'learned']) {
      const run = task[arm];
      requireThat(nonblank(run?.rootSessionId) && !sessionRoots.has(run.rootSessionId)
        && !skill.sources.some(s => s.rootSessionId === run.rootSessionId), 'executor root reused or inherited from training');
      sessionRoots.add(run.rootSessionId);
      requireThat(run.promptSha256 === task.prompt.sha256 && run.initialStateSha256 === task.initialState.sha256,
        'arms must share frozen prompt and initial state');
      requireThat(nonblank(run.configuration?.provider) && nonblank(run.configuration?.model)
        && nonblank(run.configuration?.sampling) && nonblank(run.configuration?.toolPolicySha256)
        && nonblank(run.configuration?.systemContextSha256), 'effective executor configuration required');
      const config = JSON.stringify(Object.entries(run.configuration).sort(([a], [b]) => a.localeCompare(b)));
      configuration ??= config;
      requireThat(config === configuration, 'effective model/tool/system configuration differs');
      await artifact(run.capture, 'raw executor capture');
      const verification = JSON.parse((await artifact(run.verification, 'verification result')).toString('utf8'));
      requireThat(verification.captureSha256 === run.capture.sha256 && verification.verifierSha256 === task.verifier.sha256
        && Number.isInteger(verification.exitCode) && typeof verification.passed === 'boolean'
        && verification.passed === (verification.exitCode === 0), 'verification must bind capture and frozen verifier with consistent exit status');
      requireThat(typeof run.safetyViolations === 'number' && Number.isSafeInteger(run.safetyViolations) && run.safetyViolations >= 0, 'safety inspection missing');
      safetyViolations += run.safetyViolations;
      requireThat(Array.isArray(run.invokedSkills), 'native invocation trace required');
      requireThat(arm === 'baseline' ? run.invokedSkills.length === 0
        : run.invokedSkills.length === 1 && run.invokedSkills[0].draftId === skill.draftId
          && run.invokedSkills[0].draftSha256 === skill.draft.sha256 && run.invokedSkills[0].name === skill.name,
      'baseline must not learn; learned arm must invoke the exact native draft');
      await artifact(run.invocationCapture, 'native invocation observation');
      for (const metric of ['promptTokens', 'providerCalls', 'elapsedMs']) {
        requireThat(finite(run.metrics?.[metric]), `missing measured ${metric}`);
        totals[arm][metric] += run.metrics[metric];
      }
      requireThat(run.metrics?.cost === null || finite(run.metrics?.cost), 'cost must be measured or explicitly unavailable');
      if (run.metrics.cost === null) totals[arm].cost = null;
      else if (totals[arm].cost !== null) totals[arm].cost += run.metrics.cost;
      requireThat(Number.isSafeInteger(run.metrics.promptTokens) && Number.isSafeInteger(run.metrics.providerCalls)
        && run.metrics.providerCalls > 0, 'real provider call and integer token accounting required');
      outcomes[arm] = verification.passed;
      totals[arm].passed += Number(verification.passed);
      if (task.kind !== 'procedure' && !verification.passed) controlFailures++;
    }
    if (outcomes.baseline === outcomes.learned) ties++;
    else if (outcomes.learned) wins++;
    else losses++;
    perTask.push({ id: task.id, kind: task.kind, ...outcomes });
  }
  const regressions = ['promptTokens', 'providerCalls', 'cost', 'elapsedMs'].filter(metric => totals.learned[metric] !== null && totals.baseline[metric] !== null && totals.learned[metric] > totals.baseline[metric]);
  const costMeasured = totals.learned.cost !== null && totals.baseline.cost !== null;
  return { version: bundle.version, measured: true, evidenceOnly: true, phaseEAccepted: false,
    reviewRequired: 'Capture claims and freeze chronology require independent review; this aggregator cannot attest provenance or authorize rollout.',
    paired: { wins, losses, ties }, totals, perTask, safetyViolations, controlFailures, regressions, costMeasured, costBenefitClaimAllowed: false,
    observedBenefit: wins > losses && safetyViolations === 0 && controlFailures === 0,
    artifacts: Object.fromEntries(artifacts) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, manifest] = process.argv.slice(2);
  requireThat(root && manifest, 'Usage: node scripts/measure-learned-procedure.mjs EVIDENCE_ROOT MANIFEST_JSON');
  // Manifest is also confined: no arbitrary production-store reads.
  const base = await realpath(root), path = await realpath(resolve(base, manifest));
  const rel = relative(base, path);
  requireThat(rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel), 'manifest outside evidence root');
  console.log(JSON.stringify(await evaluateLearnedProcedure(JSON.parse(await readFile(path, 'utf8')), base), null, 2));
}
