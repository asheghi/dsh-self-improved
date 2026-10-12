/**
 * Phase E evaluation producer — a REAL, self-contained static evaluation.
 *
 * The only other evaluator in this repository is the default-off fixture lane
 * (episode-evaluation.ts), which needs externally supplied cases and always
 * reports `eligibleForHumanReview: false`. That left `evaluated` a state no
 * draft could honestly reach. This module closes that gap with checks that are
 * deterministic, need no model calls and no fixtures, and are named in the
 * report so nobody can mistake them for behavioral evidence.
 *
 * It is deliberately NOT a sandbox and NOT a behavioral measurement: it cannot
 * show that following the procedure works. It shows that the draft is
 * well-formed, that its citations are still reviewable evidence, and that they
 * come from independent sessions. `eligibleForHumanReview` therefore means
 * "a human can now decide", never "this was measured".
 */
export interface StructuralEvaluationDraft {
  id: string; projectId: string; fingerprint: string; name: string;
  markdown: string; sourceEpisodeIds: string[];
}
export interface StructuralEvaluationEpisode {
  id: string; projectId: string; fingerprint: string | null; sessionId: string;
  status: string; reviewedAt: number | null; delegated: boolean; rejectReason: string | null;
}
/** The narrow slice of the store this evaluation reads. */
export interface StructuralEvaluationSource {
  getSkillDraft(id: string, projectId?: string): StructuralEvaluationDraft | undefined;
  getEpisode(id: string): StructuralEvaluationEpisode | undefined;
}
export interface StructuralEvaluationCheck { id: string; passed: boolean; reason: string; }
export interface StructuralEvaluationReport {
  version: string; mode: "structural-review"; draftId: string; projectId: string; fingerprint: string;
  sourceEpisodeIds: string[]; checks: StructuralEvaluationCheck[];
  passed: number; total: number;
  /** True only when EVERY check passed: the draft may be reviewed by a human. */
  eligibleForHumanReview: boolean;
  /** Always true: this is a static review, never a behavioral measurement. */
  staticOnly: true;
  evaluatedAt: number;
}

export const STRUCTURAL_EVALUATION_VERSION = "structural-review-v1";
const MAX_BODY = 4000;
const MAX_STEPS = 24;
const MIN_INDEPENDENT_SESSIONS = 2;
/** Conservative credential shapes. Best effort, never arbitrary-secret detection. */
const CREDENTIAL_SHAPES = /(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.)/;

function parseBody(markdown: string): { name: string; description: string; steps: string[] } | null {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.indexOf("---", 1);
  if (end < 0) return null;
  const header = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (match) header.set(match[1], match[2]);
  }
  const steps = lines.slice(end + 1)
    .map((line) => /^\s*\d+[.)]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((step) => step.length > 0);
  return { name: header.get("name") ?? "", description: (header.get("description") ?? "").trim(), steps };
}

/**
 * Evaluate one draft. Returns null when the draft does not exist (the caller's
 * scope question), otherwise a report whose failed checks explain themselves.
 */
export function evaluateSkillDraftStructure(
  source: StructuralEvaluationSource, draftId: string,
  options: { projectId?: string; now?: number } = {},
): StructuralEvaluationReport | null {
  const draft = source.getSkillDraft(draftId, options.projectId);
  if (!draft) return null;
  const checks: StructuralEvaluationCheck[] = [];
  const body = parseBody(draft.markdown);
  checks.push({
    id: "body-frontmatter",
    passed: !!body && body.name === draft.name && body.description.length > 0,
    reason: !body ? "body has no complete frontmatter block"
      : body.name !== draft.name ? "frontmatter name does not match the stored draft name"
      : body.description.length === 0 ? "frontmatter has no description" : "frontmatter parsed",
  });
  checks.push({
    id: "body-procedure",
    passed: !!body && body.steps.length > 0 && body.steps.length <= MAX_STEPS,
    reason: !body ? "no body to read" : body.steps.length === 0 ? "no numbered procedure steps"
      : body.steps.length > MAX_STEPS ? `procedure has ${body.steps.length} steps (max ${MAX_STEPS})` : `${body.steps.length} steps`,
  });
  checks.push({
    id: "body-bounds",
    passed: draft.markdown.length <= MAX_BODY,
    reason: draft.markdown.length <= MAX_BODY ? `${draft.markdown.length} chars` : `body is ${draft.markdown.length} chars (max ${MAX_BODY})`,
  });
  const credential = CREDENTIAL_SHAPES.exec(draft.markdown);
  checks.push({
    id: "body-credential-shapes",
    passed: credential === null,
    reason: credential === null ? "no credential-shaped text" : `body carries a credential-shaped token (${credential[0].slice(0, 6)}…)`,
  });

  const episodes: StructuralEvaluationEpisode[] = [];
  const unresolved: string[] = [];
  for (const id of draft.sourceEpisodeIds) {
    const episode = source.getEpisode(id);
    if (!episode) { unresolved.push(id); continue; }
    const usable = episode.status === "reviewed" && episode.reviewedAt !== null && !episode.delegated
      && episode.rejectReason === null && episode.projectId === draft.projectId && episode.fingerprint === draft.fingerprint;
    if (!usable) { unresolved.push(id); continue; }
    episodes.push(episode);
  }
  checks.push({
    id: "citations-reviewable",
    passed: unresolved.length === 0 && episodes.length === draft.sourceEpisodeIds.length && episodes.length > 0,
    reason: unresolved.length > 0 ? `${unresolved.length} citation(s) are no longer reviewable evidence`
      : episodes.length === 0 ? "the draft cites no evidence" : `${episodes.length} reviewed citation(s)`,
  });
  const sessions = new Set(episodes.map((episode) => episode.sessionId));
  checks.push({
    id: "independent-sessions",
    passed: sessions.size >= MIN_INDEPENDENT_SESSIONS,
    reason: sessions.size >= MIN_INDEPENDENT_SESSIONS ? `${sessions.size} independent sessions`
      : `${sessions.size} independent session(s); ${MIN_INDEPENDENT_SESSIONS} required`,
  });

  const now = options.now ?? Date.now();
  const passed = checks.filter((check) => check.passed).length;
  return {
    version: STRUCTURAL_EVALUATION_VERSION, mode: "structural-review",
    draftId: draft.id, projectId: draft.projectId, fingerprint: draft.fingerprint,
    sourceEpisodeIds: [...draft.sourceEpisodeIds], checks,
    passed, total: checks.length, eligibleForHumanReview: passed === checks.length,
    staticOnly: true, evaluatedAt: now,
  };
}
