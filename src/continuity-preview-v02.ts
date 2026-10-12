import type { SessionQueryEngine, SessionObservation } from "@deepseek-ai/dsh-session-query";
import type { SessionHeader } from "@deepseek-ai/dsh-session/types";
import type { SessionProjectionRegistry } from "@deepseek-ai/dsh-session-projection";
import type * as Zod from "zod";
import type { ContinuityHandoffV02 } from "./continuity-handoff-v02.js";
import { verifyContinuitySourceReference } from "./continuity-source-v02.js";
import { bindContinuityCheckpoint, recoverContinuityCheckpoint } from "./continuity-checkpoint-v02.js";
import { CONTINUITY_PROJECTION_KEY } from "./continuity-registry-v02.js";
import { isDelegatedHeader, opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";

export interface ContinuityPreviewRequest { targetSessionId: string; jobId: string }
export interface ContinuityPreview {
  targetSessionId: string; sourceSessionId: string; projectId: string; jobId: string;
  cut: number; sourceHash: string; generation: number; notes: string[];
  uncertain: true; untrusted: true; orientationOnly: true;
}
/** Cold read ONLY. Operator/policy callbacks are trusted Host code, never wire
 * flags, and default deny. No Agent activation, prompt, model, goal or grant.
 * This is not saved-data inspection while processing eligibility is revoked.
 * A preview is a point-in-time orientation, never a durable action receipt. */
export class ContinuityPreviewV02 {
  private disposed = false;
  private readonly stop = new AbortController();
  constructor(private readonly handoffs: Pick<ContinuityHandoffV02, "read">,
    private readonly query: Pick<SessionQueryEngine, "observeSession">,
    private readonly registry: SessionProjectionRegistry, private readonly z: typeof Zod,
    private readonly operator: (request: Readonly<ContinuityPreviewRequest>, selectedSourceSessionId?: string) => boolean = () => false,
    private readonly admitted: (header: SessionHeader, role: "target" | "source") => boolean = () => false) {}

  async resolve(request: ContinuityPreviewRequest, signal?: AbortSignal): Promise<ContinuityPreview | null> {
    const parsed = this.z.object({ targetSessionId: this.z.string().min(1).max(256), jobId: this.z.string().min(1).max(256) }).strict().parse(request);
    const req = Object.freeze(parsed);
    const abort = signal ? AbortSignal.any([this.stop.signal, signal]) : this.stop.signal;
    let selectedSourceSessionId: string | undefined;
    const alive = () => !this.disposed && !abort.aborted && this.operator(req, selectedSourceSessionId);
    if (!alive()) return null;
    // Normalize ONLY aborted acquisition errors from this owned signal. An
    // ordinary I/O/canonical failure stays reported, even if abort races it.
    const observe = async (id: SessionHeader["id"]): Promise<SessionObservation | undefined> => {
      try { return await this.query.observeSession(id, { signal: abort, projectionMode: "none" }); }
      catch (error) {
        if (abort.aborted && (error === abort.reason || (error instanceof Error && "code" in error
          && error.code === "SESSION_QUERY_ABORTED" && error.cause === abort.reason))) return undefined;
        throw error;
      }
    };
    let target: SessionObservation | undefined, source: SessionObservation | undefined, targetFresh: SessionObservation | undefined;
    try {
      target = await observe(req.targetSessionId as SessionHeader["id"]);
      if (!target || !alive()) return null;
      if (target.header.id !== req.targetSessionId || !target.header.cwd || isDelegatedHeader(target.header)
        || !this.admitted(target.header, "target")) return null;
      const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(target.header.cwd));
      const targetState = recoverContinuityCheckpoint(this.registry, target, null, this.z).checkpoint[CONTINUITY_PROJECTION_KEY];
      if (this.z.object({ lastHumanSeq: this.z.number().int() }).passthrough().parse(targetState.val).lastHumanSeq < target.inheritedEventCount) return null;
      const targetBound = bindContinuityCheckpoint(target, targetState);
      const selected = this.handoffs.read(projectId, req.jobId);
      if (!selected) return null;
      selectedSourceSessionId = selected.sessionId;
      if (!alive()) return null; // exact selected-source policy BEFORE body read
      // This exact current row is independently source-verified, no invented
      // work claim/token or newest-checkpoint substitution.
      source = await observe(selected.sessionId as SessionHeader["id"]);
      if (!source || !alive() || !this.admitted(target.header, "target") || !this.admitted(source.header, "source")) return null;
      verifyContinuitySourceReference({ sessionId: selected.sessionId, projectId, cut: selected.cut, sourceHash: selected.sourceHash }, source, this.registry, this.z);
      const beforeTargetRefresh = this.handoffs.read(projectId, req.jobId);
      if (!beforeTargetRefresh || JSON.stringify(beforeTargetRefresh) !== JSON.stringify(selected)) return null;
      // Reobserve the target after the source await: a stale observation cannot
      // authorize a changed/replaced native target with the same logical ID.
      targetFresh = await observe(target.header.id);
      if (!targetFresh || !alive() || !this.admitted(targetFresh.header, "target") || !this.admitted(source.header, "source")) return null;
      verifyContinuitySourceReference({ sessionId: req.targetSessionId, projectId, cut: targetBound.asOfSeq, sourceHash: targetBound.sourceHash }, targetFresh, this.registry, this.z);
      const current = this.handoffs.read(projectId, req.jobId);
      if (!current || JSON.stringify(current) !== JSON.stringify(selected) || !alive()
        || !this.admitted(target.header, "target") || !this.admitted(source.header, "source")) return null;
      return { targetSessionId: req.targetSessionId, sourceSessionId: selected.sessionId, projectId, jobId: selected.jobId,
        cut: selected.cut, sourceHash: selected.sourceHash, generation: selected.generation, notes: [...selected.notes],
        uncertain: true, untrusted: true, orientationOnly: true };
    } finally {
      try { targetFresh?.[Symbol.dispose](); }
      finally { try { source?.[Symbol.dispose](); } finally { target?.[Symbol.dispose](); } }
    }
  }
  dispose(): void { this.disposed = true; this.stop.abort(); }
}
