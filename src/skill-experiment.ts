/**
 * Phase E measurement HARNESS — the last thing the phase gate needs.
 *
 * It does NOT decide what to measure and it does NOT run models itself: the
 * caller supplies the task set, the arms and an executor, and this module runs
 * PAIRED trials under an explicit budget and reports what happened.
 *
 * Honesty rules (each one is enforced, not documented):
 *  - a trial counts only when the executor says its outcome was VERIFIED; the
 *    harness never infers success from the absence of an error;
 *  - a pair counts only when BOTH arms produced verified outcomes, so an
 *    unverified run can never look like a win;
 *  - `measured` is true only when every planned pair was verified, so a partial
 *    or unverified run can never be quoted as a result;
 *  - exhausting the budget stops the run and is REPORTED (stoppedReason), never
 *    silently truncated;
 *  - arms alternate per trial, so ordering cannot hand one arm the warm cache.
 */
export interface ExperimentTask { id: string; prompt: string; }
export interface ExperimentTrialOutcome {
  /** The executor's own statement that this outcome was verified. */
  verified: boolean;
  passed: boolean;
}
export interface SkillExperimentOptions {
  tasks: readonly ExperimentTask[];
  /** At least two arms; the FIRST is the baseline by convention (stated in the report). */
  arms: readonly string[];
  /** Trials per task per arm. Default 1. */
  trialsPerTask?: number;
  /** Hard budget: the run stops when this many trials have been executed. */
  budget: { maxTrials: number };
  /** The host's executor. Returning null means "not executed" and is counted as such. */
  execute(task: ExperimentTask, arm: string, trial: number, signal?: AbortSignal): Promise<ExperimentTrialOutcome | null>;
  now?: () => number;
}
export interface SkillExperimentReport {
  version: string;
  baseline: string;
  arms: readonly string[];
  tasks: number;
  trialsPlanned: number;
  trialsRun: number;
  unverifiedTrials: number;
  notExecutedTrials: number;
  stoppedReason: "completed" | "budget";
  perArm: Readonly<Record<string, { ran: number; verified: number; passed: number }>>;
  paired: { pairs: number; wins: number; losses: number; ties: number };
  /** True only when every PLANNED pair was verified: nothing less may be quoted as a result. */
  measured: boolean;
  startedAt: number; endedAt: number;
}
export const EXPERIMENT_VERSION = "paired-experiment-v1";

export async function runSkillExperiment(
  options: SkillExperimentOptions, signal?: AbortSignal,
): Promise<SkillExperimentReport> {
  const tasks = options?.tasks;
  const arms = options?.arms;
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("an experiment requires at least one task");
  if (!Array.isArray(arms) || arms.length < 2) throw new Error("an experiment requires at least two arms (the first is the baseline)");
  if (typeof options.execute !== "function") throw new Error("an experiment requires an executor");
  const trialsPerTask = options.trialsPerTask ?? 1;
  if (!Number.isSafeInteger(trialsPerTask) || trialsPerTask < 1) throw new Error("trialsPerTask must be a positive integer");
  const maxTrials = options.budget?.maxTrials;
  if (!Number.isSafeInteger(maxTrials) || (maxTrials as number) < 1) throw new Error("an experiment requires an explicit positive budget");
  const ids = new Set<string>();
  for (const task of tasks) {
    if (typeof task?.id !== "string" || task.id.length === 0) throw new Error("every task needs an id");
    if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    ids.add(task.id);
    if (typeof task.prompt !== "string" || task.prompt.trim().length === 0) throw new Error(`task ${task.id} has no prompt`);
  }
  const uniqueArms = [...new Set(arms)];
  if (uniqueArms.length !== arms.length) throw new Error("arm names must be unique");

  const now = options.now ?? Date.now;
  const startedAt = now();
  const perArm: Record<string, { ran: number; verified: number; passed: number }> = {};
  for (const arm of uniqueArms) perArm[arm] = { ran: 0, verified: 0, passed: 0 };
  const trialsPlanned = tasks.length * uniqueArms.length * trialsPerTask;
  let trialsRun = 0, unverifiedTrials = 0, notExecutedTrials = 0;
  const budgetCap = maxTrials as number;
  let stoppedReason: SkillExperimentReport["stoppedReason"] = "budget";
  const paired = { pairs: 0, wins: 0, losses: 0, ties: 0 };
  const baseline = uniqueArms[0];
  const others = uniqueArms.slice(1);

  outer:
  for (const task of tasks) {
    for (let trial = 0; trial < trialsPerTask; trial++) {
      // Alternate the arm order per trial so no arm systematically runs first.
      const ordered = trial % 2 === 0 ? uniqueArms : [...uniqueArms].reverse();
      const outcomes = new Map<string, ExperimentTrialOutcome | null>();
      for (const arm of ordered) {
        if (trialsRun >= budgetCap) { stoppedReason = "budget"; break outer; }
        signal?.throwIfAborted();
        const outcome = await options.execute(task, arm, trial, signal);
        trialsRun++;
        perArm[arm].ran++;
        outcomes.set(arm, outcome ?? null);
        if (outcome === null || outcome === undefined) { notExecutedTrials++; continue; }
        if (outcome.verified !== true) { unverifiedTrials++; continue; }
        perArm[arm].verified++;
        if (outcome.passed === true) perArm[arm].passed++;
      }
      const base = outcomes.get(baseline) ?? null;
      for (const arm of others) {
        const other = outcomes.get(arm) ?? null;
        // A pair counts only when BOTH sides were verified.
        if (!base || base.verified !== true || !other || other.verified !== true) continue;
        paired.pairs++;
        if (other.passed === base.passed) paired.ties++;
        else if (other.passed === true) paired.wins++;
        else paired.losses++;
      }
    }
  }
  if (trialsRun >= budgetCap && trialsRun < trialsPlanned) stoppedReason = "budget";
  else stoppedReason = "completed";
  const plannedPairs = tasks.length * trialsPerTask * others.length;
  return {
    version: EXPERIMENT_VERSION, baseline, arms: uniqueArms, tasks: tasks.length,
    trialsPlanned, trialsRun, unverifiedTrials, notExecutedTrials, stoppedReason,
    perArm, paired, measured: stoppedReason === "completed" && paired.pairs === plannedPairs && plannedPairs > 0,
    startedAt, endedAt: now(),
  };
}
