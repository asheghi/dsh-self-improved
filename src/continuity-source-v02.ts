import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import type * as Zod from "zod";
import type { ContinuityWorkClaim } from "./continuity-work-v02.js";
import { continuitySourceAtCut, recoverContinuityCheckpoint, bindContinuityCheckpoint, type CanonicalContinuitySource, type BoundContinuityCheckpoint } from "./continuity-checkpoint-v02.js";
import { CONTINUITY_PROJECTION_KEY } from "./continuity-registry-v02.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd, isDelegatedHeader } from "./capture.js";

/** Structural source coordinates, independent of running work leases. This
 * authenticates no consent, operator selection, goals or permission to act. */
export interface ContinuitySourceReference {
  sessionId: string; projectId: string; cut: number; sourceHash: string;
}
/** Pure completed-reference/source gate. Caller owns the native observation
 * lease and current-policy/intent checks. Output is detached and body-free;
 * canonical lineage is not proof that a task or external action succeeded. */
export function verifyContinuitySourceReference(reference: ContinuitySourceReference, observation: CanonicalContinuitySource,
  registry: SessionProjectionRegistry, z: typeof Zod): BoundContinuityCheckpoint {
  // One strict plain snapshot; no hidden toJSON/caller getters are reread.
  const ref = z.object({ sessionId: z.string().min(1).max(256), projectId: z.string().regex(/^pj-[a-f0-9]{32}$/),
    cut: z.number().int().min(-1).refine(Number.isSafeInteger), sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().parse(reference);
  if (ref.sessionId !== observation.header.id || !observation.header.cwd || isDelegatedHeader(observation.header)
    || ref.projectId !== opaqueProjectIdFromKey(projectKeyFromCwd(observation.header.cwd))) throw new Error("continuity work source ownership mismatch");
  const source = continuitySourceAtCut(observation, ref.cut);
  const restored = recoverContinuityCheckpoint(registry, source, null, z);
  const bound = bindContinuityCheckpoint(source, restored.checkpoint[CONTINUITY_PROJECTION_KEY]);
  if (bound.sourceHash !== ref.sourceHash) throw new Error("continuity work source hash mismatch");
  const state = z.object({ lastHumanSeq: z.number().int() }).passthrough().parse(bound.row.val);
  if (state.lastHumanSeq < source.inheritedEventCount) throw new Error("continuity work has no own human authority");
  return bound;
}
/** Compatible worker wrapper. Running token/current policy still belong to
 * isCurrent + atomic commit, NOT to source verification. */
export function verifyContinuityWorkSource(claim: ContinuityWorkClaim, observation: CanonicalContinuitySource,
  registry: SessionProjectionRegistry, z: typeof Zod): BoundContinuityCheckpoint {
  const { sessionId, projectId, cut, sourceHash } = claim;
  return verifyContinuitySourceReference({ sessionId, projectId, cut, sourceHash }, observation, registry, z);
}
