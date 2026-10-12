/**
 * Phase E — the durable half of skill activation.
 *
 * `skill-activation.ts` owns the live runtime registrations (forced user-only
 * policy, reversible by disposal). This module connects them to the reviewed
 * draft rows so an activation is a *recorded, reversible transition* rather
 * than a runtime side effect:
 *
 *  - only an APPROVED, evaluated draft can be activated;
 *  - the status move is an atomic compare-and-set, so a concurrent invalidation
 *    can never lose to a stale activation, and a failed transition rolls the
 *    live registration back instead of leaving an orphan;
 *  - rollback disposes the registration and marks the draft rolled-back;
 *  - a draft whose support was invalidated is DEACTIVATED without rewriting its
 *    status (invalidation is a stronger and different fact than a rollback);
 *  - boot re-registration replays only drafts that are still `activated`.
 *
 * Everything here is bounded, stores no bodies beyond what the draft already
 * holds, and never writes to a skills directory.
 */
import type { MemoryStore, SkillDraftRecord } from "./storage.js";
import type { LearnedSkillActivator, SkillActivationRecord, SkillActivationRequest } from "./skill-activation.js";

export interface DraftActivationDeps {
  store: Pick<MemoryStore, "getSkillDraft" | "listSkillDrafts" | "transitionSkillDraft">;
  activator: LearnedSkillActivator;
  now?: () => number;
}
export interface ActivationOutcome {
  ok: boolean;
  reason: string;
  record?: SkillActivationRecord;
}

const MAX_DRAFTS_PER_PASS = 100;

/** Frontmatter + numbered-procedure parser for the reviewed draft body. */
export function activationRequestFromDraft(draft: SkillDraftRecord): SkillActivationRequest {
  const lines = draft.markdown.split("\n");
  if (lines[0]?.trim() !== "---") throw new Error("draft body has no frontmatter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("draft body frontmatter is unterminated");
  const header = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_]+):\s*(.*)$/.exec(line.trim());
    if (match) header.set(match[1], match[2]);
  }
  const name = header.get("name") ?? "";
  if (name !== draft.name) throw new Error("draft body name does not match the stored draft name");
  const description = (header.get("description") ?? "").trim();
  if (!description) throw new Error("draft body has no description");
  const whenToUse = (header.get("whenToUse") ?? "").trim();
  const steps = lines.slice(end + 1)
    .map((line) => /^\s*\d+[.)]\s+(.*)$/.exec(line)?.[1]?.trim() ?? "")
    .filter((step) => step.length > 0);
  if (steps.length === 0) throw new Error("draft body has no numbered procedure steps");
  return {
    draftId: draft.id, name, description, ...(whenToUse ? { whenToUse } : {}),
    steps, citations: [...draft.sourceEpisodeIds],
  };
}

/** Activate ONE approved draft. Nothing else may reach the skill registry. */
export function activateDraftSkill(deps: DraftActivationDeps, draftId: string, projectId?: string): ActivationOutcome {
  const draft = deps.store.getSkillDraft(draftId, projectId);
  if (!draft) return { ok: false, reason: "draft not found" };
  if (draft.status !== "approved") return { ok: false, reason: `draft is ${draft.status}, not approved` };
  if (!draft.evaluationVersion) return { ok: false, reason: "draft has no recorded evaluation" };
  let request: SkillActivationRequest;
  try { request = activationRequestFromDraft(draft); } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error) };
  }
  let record: SkillActivationRecord;
  try { record = deps.activator.activate(request); } catch (error) {
    return { ok: false, reason: String((error as Error)?.message ?? error) };
  }
  // The status move is the commit point. If it loses (a concurrent invalidation
  // or a second operator won first), the live registration must not survive.
  const moved = deps.store.transitionSkillDraft(draft.id, ["approved"], "activated", { requireEvaluation: true });
  if (!moved) {
    deps.activator.rollback(record.name);
    return { ok: false, reason: "draft status changed before the activation could be recorded" };
  }
  return { ok: true, reason: "activated", record };
}

/** Dispose one live activation and record the rollback. */
export function rollbackDraftSkill(deps: DraftActivationDeps, name: string): { ok: boolean; reason: string } {
  const live = deps.activator.list().find((entry) => entry.name === name);
  if (!live) return { ok: false, reason: "no live activation with that name" };
  if (!deps.activator.rollback(name)) return { ok: false, reason: "the skill registry refused the rollback" };
  const moved = deps.store.transitionSkillDraft(live.draftId, ["activated"], "rolled-back");
  // The registration is already gone, so a failed status move is reported
  // rather than hidden: boot will not re-register a non-'activated' draft, but
  // the row is now stale and the operator should see that.
  return moved ? { ok: true, reason: "rolled back" } : { ok: false, reason: "rolled back in runtime, but the draft status could not be recorded" };
}

/** Re-register every draft that is still durably activated (boot path). */
export function restoreActivatedDrafts(deps: DraftActivationDeps): { restored: number; skipped: number; failed: string[] } {
  const live = new Set(deps.activator.list().map((entry) => entry.name));
  const summaries = deps.store.listSkillDrafts({ status: "activated", limit: MAX_DRAFTS_PER_PASS });
  let restored = 0, skipped = 0;
  const failed: string[] = [];
  for (const summary of summaries) {
    const draft = deps.store.getSkillDraft(summary.id);
    if (!draft || draft.status !== "activated") { skipped++; continue; }
    if (live.has(draft.name)) { skipped++; continue; }
    try {
      deps.activator.activate(activationRequestFromDraft(draft));
      restored++;
    } catch (error) {
      // A draft that can no longer be rendered (corrupt body, name collision)
      // stays durably activated but is NOT registered: report it, never fake it.
      failed.push(`${draft.name}: ${String((error as Error)?.message ?? error)}`);
    }
  }
  return { restored, skipped, failed };
}

/**
 * Deactivate any live skill whose supporting draft is no longer activated (its
 * evidence was invalidated or purged). The draft's status is deliberately NOT
 * rewritten: "invalidated" is a stronger, different fact than "rolled-back".
 */
export function deactivateInvalidatedDrafts(deps: DraftActivationDeps): { deactivated: number; failed: string[] } {
  let deactivated = 0;
  const failed: string[] = [];
  for (const entry of deps.activator.list()) {
    const draft = deps.store.getSkillDraft(entry.draftId);
    if (draft?.status === "activated") continue;
    if (!deps.activator.rollback(entry.name)) { failed.push(entry.name); continue; }
    deactivated++;
  }
  return { deactivated, failed };
}
