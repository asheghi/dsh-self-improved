/** Default-off static textual fixture coverage. NOT executable sandboxing or behavioral evaluation. */
import { createHash } from "node:crypto";
import type { MemoryStore, SkillDraftRecord } from "./storage.js";

export interface StaticFixtureCase { id: string; projectId: string; fingerprint: string; input: string; expectedProcedure: string[]; }
export type OfflineEvaluationCase = StaticFixtureCase;
export interface OfflineEvaluationOptions { version?: string; cases: StaticFixtureCase[]; enabled?: boolean; }
export interface OfflineEvaluationReport {
  version: string; mode: "static-fixture-review"; draftId: string; projectId: string; fingerprint: string;
  sourceEpisodeIds: string[]; cases: Array<{ id: string; passed: boolean; reason: string }>;
  passed: number; total: number; eligibleForHumanReview: false; syntheticOnly: true;
}
const REPORT_KEYS = ["version", "mode", "draftId", "projectId", "fingerprint", "sourceEpisodeIds", "cases", "passed", "total", "eligibleForHumanReview", "syntheticOnly"];
function data(value: unknown, keys: readonly string[], exact = false): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (exact && (Reflect.ownKeys(descriptors).length !== keys.length || Reflect.ownKeys(descriptors).some(key => typeof key !== "string" || !keys.includes(key)))) return null;
    const result: Record<string, unknown> = Object.create(null);
    for (const key of keys) {
      const d = descriptors[key]; if (!d || !d.enumerable || !Object.hasOwn(d, "value")) return null;
      result[key] = d.value;
    }
    return result;
  } catch { return null; }
}
function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  try { const d = Object.getOwnPropertyDescriptor(value, key); return d?.enumerable && Object.hasOwn(d, "value") ? d.value : undefined; } catch { return undefined; }
}
function text(value: unknown, max = 128): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= max && !value.includes("\0"); }
function array(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) return null;
  const result: unknown[] = [];
  for (let i = 0; i < value.length; i++) { const d = Object.getOwnPropertyDescriptor(value, String(i)); if (!d?.enumerable || !Object.hasOwn(d, "value")) return null; result.push(d.value); }
  return result;
}
function normalize(value: string): string[] { return value.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter(Boolean); }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16); }

/** Strict detached report parser: never invoke getters/toJSON or persist arbitrary input. */
export function parseStaticFixtureReviewReport(value: unknown): OfflineEvaluationReport | null {
  const r = data(value, REPORT_KEYS, true);
  if (!r || r.mode !== "static-fixture-review" || r.eligibleForHumanReview !== false || r.syntheticOnly !== true
    || !text(r.version, 200) || !text(r.draftId) || !text(r.projectId) || !text(r.fingerprint)) return null;
  const sourceEpisodeIds = array(r.sourceEpisodeIds, 50); const rawCases = array(r.cases, 50);
  if (!sourceEpisodeIds || sourceEpisodeIds.some(id => !text(id)) || new Set(sourceEpisodeIds).size !== sourceEpisodeIds.length || !rawCases) return null;
  const cases: OfflineEvaluationReport["cases"] = [];
  for (const value of rawCases) {
    const c = data(value, ["id", "passed", "reason"], true);
    if (!c || !text(c.id) || typeof c.passed !== "boolean" || !text(c.reason, 256)) return null;
    cases.push({ id: c.id, passed: c.passed, reason: c.reason });
  }
  if (new Set(cases.map(c => c.id)).size !== cases.length || r.total !== cases.length || r.passed !== cases.filter(c => c.passed).length) return null;
  const base = { mode: "static-fixture-review" as const, draftId: r.draftId, projectId: r.projectId, fingerprint: r.fingerprint,
    sourceEpisodeIds: [...sourceEpisodeIds as string[]].sort(), cases, passed: r.passed as number, total: cases.length,
    eligibleForHumanReview: false as const, syntheticOnly: true as const };
  if (!r.version.endsWith(`:${digest(base)}`)) return null;
  const report = { version: r.version, ...base };
  return JSON.stringify(report).length <= 20_000 ? report : null;
}

/** Coverage checks remain inactive, never grant review/activation authority, and keep status draft. */
export function evaluateSkillDraftOffline(store: MemoryStore, draft: SkillDraftRecord, options: OfflineEvaluationOptions): OfflineEvaluationReport | null {
  if (own(options, "enabled") !== true) return null;
  const rawCases = array(own(options, "cases"), 50);
  const supplied = data(draft, ["id", "projectId", "fingerprint"]);
  if (!supplied || !text(supplied.id) || !text(supplied.projectId) || !text(supplied.fingerprint) || !rawCases) return null;
  const current = store.getSkillDraft(supplied.id, supplied.projectId);
  if (!current || current.status !== "draft" || current.fingerprint !== supplied.fingerprint || current.sourceEpisodeIds.length < 2 || current.sourceEpisodeIds.length > 50) return null;
  const sources = [...current.sourceEpisodeIds].sort();
  for (const id of sources) {
    const episode = store.getEpisode(id);
    if (!episode || episode.status !== "reviewed" || episode.reviewedAt == null || episode.projectId !== current.projectId
      || episode.fingerprint !== current.fingerprint || episode.delegated || episode.rejectReason !== null) return null;
    const steps = store.getEpisodeSteps(id);
    if (!steps.length || steps.some(step => step.isError || step.resultSeq == null)) return null;
  }
  const versionOption = own(options, "version");
  if (versionOption !== undefined && !text(versionOption, 100)) return null;
  const version = typeof versionOption === "string" ? versionOption : "static-fixture-review-v1";
  const procedure = normalize(current.markdown);
  const cases: OfflineEvaluationReport["cases"] = [];
  for (const raw of rawCases) {
    const c = data(raw, ["id", "projectId", "fingerprint", "input", "expectedProcedure"], true);
    if (!c || !text(c.id) || !text(c.projectId) || !text(c.fingerprint) || !text(c.input, 4000)
      || c.projectId !== current.projectId || c.fingerprint !== current.fingerprint) return null;
    const assertions = array(c.expectedProcedure, 20);
    if (!assertions || assertions.some(a => !text(a, 4000))) return null;
    const expected = normalize((assertions as string[]).join(" ")); if (!expected.length) return null;
    const missing = expected.filter(token => !procedure.includes(token));
    cases.push({ id: c.id, passed: missing.length === 0, reason: missing.length ? "missing-static-coverage" : "matched-static-coverage" });
  }
  const base = { mode: "static-fixture-review" as const, draftId: current.id, projectId: current.projectId, fingerprint: current.fingerprint,
    sourceEpisodeIds: sources, cases, passed: cases.filter(c => c.passed).length, total: cases.length, eligibleForHumanReview: false as const, syntheticOnly: true as const };
  const report = parseStaticFixtureReviewReport({ version: `${version}:${digest(base)}`, ...base });
  if (!report || !store.recordSkillDraftEvaluation(current.id, report.version, report)) return null;
  return report;
}
export const reviewSkillDraftStaticFixtures = evaluateSkillDraftOffline;
export type StaticFixtureReviewReport = OfflineEvaluationReport;
