import type { Session } from "@deepseek-ai/dsh-session";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import type * as Zod from "zod";
import { ContinuityStoreV02, type ContinuityTrigger } from "./continuity-store-v02.js";
import { bindContinuityCheckpoint, recoverContinuityCheckpoint } from "./continuity-checkpoint-v02.js";
import { CONTINUITY_PROJECTION_KEY } from "./continuity-registry-v02.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd, isDelegatedHeader } from "./capture.js";

/** Trusted native owner. Current policy is supplied by runtime, default deny.
 * No synchronous history reads, provider, ad-hoc event or task permission.
 */
export class ContinuityOwnerV02 {
  private disposed = false;
  private readonly stop = new AbortController();
  constructor(private readonly lane: ContinuityStoreV02,
    private readonly registry: SessionProjectionRegistry,
    private readonly z: typeof Zod,
    private readonly query: Pick<SessionQueryEngine, "observeSession">,
    private readonly admitted: (session: Session) => boolean = () => false) {}

  async capture(session: Session, trigger: ContinuityTrigger): Promise<{ id: string; created: boolean } | null> {
    if (this.disposed) return null;
    if (!session.header.cwd) {
      const old = this.lane.readPolicy(session.id);
      if (old) this.lane.ensurePolicy(session.id, old.projectId, false);
      return null;
    }
    const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd));
    const allowed = !isDelegatedHeader(session.header) && this.admitted(session);
    const generation = this.lane.ensurePolicy(session.id, projectId, allowed);
    if (!allowed) return null;
    const observation = await this.query.observeSession(session.id, { signal: this.stop.signal, projectionMode: "none" });
    try {
      if (this.disposed) return null;
      // An async observation must belong to EXACT original native ownership.
      if (JSON.stringify(observation.header) !== JSON.stringify(session.header)
        || observation.inheritedEventCount !== session.inheritedEventCount) throw new Error("continuity observation ownership mismatch");
      if (!this.admitted(session) || isDelegatedHeader(observation.header)) {
        this.lane.ensurePolicy(session.id, projectId, false);
        return null;
      }
      const current = this.lane.readPolicy(session.id);
      if (!current?.allowed || current.projectId !== projectId || current.generation !== generation) return null;
      const previous = this.lane.readCheckpoint(session.id, projectId);
      const restored = recoverContinuityCheckpoint(this.registry, observation, previous, this.z);
      const bound = bindContinuityCheckpoint(observation, restored.checkpoint[CONTINUITY_PROJECTION_KEY]);
      const state = this.z.object({ lastHumanSeq: this.z.number().int() }).passthrough().parse(bound.row.val);
      if (state.lastHumanSeq < 0) return null;
      return this.lane.enqueue(bound, projectId, generation, trigger);
    } finally { observation[Symbol.dispose](); }
  }
  dispose(): void { this.disposed = true; this.stop.abort(); }
}
