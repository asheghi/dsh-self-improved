#!/usr/bin/env node
/**
 * scripts/test-v02-skill-experiment.mjs — the Phase E measurement harness.
 *
 * Pins the honesty rules: only VERIFIED outcomes count; a pair needs both sides
 * verified; `measured` is true only for a complete, fully verified run; the
 * budget stops the run and says so; arms alternate so ordering cannot bias.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const { runSkillExperiment, EXPERIMENT_VERSION } = await import(join(repo, 'lib/skill-experiment.js'));

let passes = 0, failures = 0;
const check = async (name, fn) => {
  try { await fn(); passes++; console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' :: ' + (error && error.message)); }
};
const tasks = [{ id: 't1', prompt: 'first task' }, { id: 't2', prompt: 'second task' }];

await check('a complete, fully verified paired run is measured and counts wins/losses/ties', async () => {
  const seen = [];
  const report = await runSkillExperiment({
    tasks, arms: ['baseline', 'learning'], trialsPerTask: 2, budget: { maxTrials: 100 },
    now: (() => { let t = 0; return () => ++t; })(),
    async execute(task, arm, trial) {
      seen.push([task.id, arm, trial]);
      // The learning arm passes one of the two trials; the baseline passes none.
      return { verified: true, passed: arm === 'learning' && trial === 1 };
    },
  });
  assert.equal(report.version, EXPERIMENT_VERSION);
  assert.equal(report.baseline, 'baseline');
  assert.equal(report.trialsPlanned, 8); assert.equal(report.trialsRun, 8);
  assert.equal(report.stoppedReason, 'completed'); assert.equal(report.measured, true);
  assert.deepEqual(report.perArm.baseline, { ran: 4, verified: 4, passed: 0 });
  assert.deepEqual(report.perArm.learning, { ran: 4, verified: 4, passed: 2 });
  assert.deepEqual(report.paired, { pairs: 4, wins: 2, losses: 0, ties: 2 });
  // Ordering alternates per trial, so the baseline is not always first.
  assert.deepEqual(seen.slice(0, 4).map((e) => e[1]), ['baseline', 'learning', 'learning', 'baseline']);
});
await check('an unverified or unexecuted outcome can never look like a win', async () => {
  const report = await runSkillExperiment({
    tasks: [tasks[0]], arms: ['baseline', 'learning'], budget: { maxTrials: 10 },
    async execute(_task, arm) {
      if (arm === 'learning') return null;                       // not executed
      return { verified: false, passed: true };                  // unverified
    },
  });
  assert.equal(report.paired.pairs, 0, 'neither side of a pair was verified');
  assert.equal(report.measured, false, 'an unverified run is not a measurement');
  assert.equal(report.notExecutedTrials, 1);
  assert.equal(report.unverifiedTrials, 1);
  assert.equal(report.perArm.learning.passed, 0);
  assert.equal(report.perArm.baseline.passed, 0, 'an unverified pass must not be counted as a pass');
});
await check('the budget stops the run, says so, and cannot be quoted as measured', async () => {
  let calls = 0;
  const report = await runSkillExperiment({
    tasks, arms: ['baseline', 'learning'], trialsPerTask: 5, budget: { maxTrials: 6 },
    async execute() { calls++; return { verified: true, passed: false }; },
  });
  assert.equal(calls, 6, 'the executor is never called past the budget');
  assert.equal(report.trialsRun, 6); assert.equal(report.trialsPlanned, 20);
  assert.equal(report.stoppedReason, 'budget'); assert.equal(report.measured, false);
  assert.ok(report.paired.pairs < 10, 'a truncated run has fewer pairs than planned');
});
await check('a partial run where every executed pair was verified is still not measured', async () => {
  const report = await runSkillExperiment({
    tasks, arms: ['baseline', 'learning'], trialsPerTask: 3, budget: { maxTrials: 4 },
    async execute() { return { verified: true, passed: true }; },
  });
  assert.equal(report.stoppedReason, 'budget');
  assert.equal(report.measured, false, 'measured requires the PLANNED pairs, not just the executed ones');
  assert.equal(report.paired.pairs, 2);
});
await check('the harness refuses an experiment it cannot run honestly', async () => {
  const base = { tasks, arms: ['baseline', 'learning'], budget: { maxTrials: 4 }, execute: async () => ({ verified: true, passed: true }) };
  await assert.rejects(runSkillExperiment({ ...base, tasks: [] }), /at least one task/);
  await assert.rejects(runSkillExperiment({ ...base, arms: ['only-one'] }), /at least two arms/);
  await assert.rejects(runSkillExperiment({ ...base, execute: undefined }), /executor/);
  await assert.rejects(runSkillExperiment({ ...base, budget: { maxTrials: 0 } }), /positive budget/);
  await assert.rejects(runSkillExperiment({ ...base, trialsPerTask: 0 }), /positive integer/);
  await assert.rejects(runSkillExperiment({ ...base, tasks: [{ id: 'x', prompt: 'a' }, { id: 'x', prompt: 'b' }] }), /duplicate task id/);
  await assert.rejects(runSkillExperiment({ ...base, tasks: [{ id: 'x', prompt: '   ' }] }), /no prompt/);
  await assert.rejects(runSkillExperiment({ ...base, arms: ['a', 'a'] }), /unique/);
});
await check('an aborted run stops instead of spending the rest of the budget', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(runSkillExperiment({
    tasks, arms: ['baseline', 'learning'], budget: { maxTrials: 100 },
    async execute() { calls++; if (calls === 3) controller.abort(); return { verified: true, passed: false }; },
  }, controller.signal), /abort/i);
  assert.equal(calls, 3, 'the run stops at the abort check BEFORE spending the next call');
});

console.log(`${passes} measurement-harness gates PASS, ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
