import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import "@deepseek-ai/dsh-typert-protocol";
import { continuityV03LiveHumanReceiptFromSessionEvent } from "./continuity-live-human-event-v03.js";
import { continuityCanonicalDigest, continuityCanonicalHeader } from "./continuity-checkpoint-v02.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd, isDelegatedHeader } from "./capture.js";

/**
 * Host authentication for the continuity lane, built on the 0.2.1 Peer model.
 *
 * Since 0.2.1 the Gateway refuses any invocation without a live Peer (no
 * implicit operator fallback), HTTP callers are admitted only with a signed
 * cookie, and a Peer's principal is fixed by in-process Host code at creation.
 * The Session controller stamps every prompt it admits as
 * `{kind:'user', rpcId[, clientTimeZone][, principal]}`, writing `principal`
 * only for a caller other than the owner.
 *
 * Trust boundary: in-process plugins are trusted, as everywhere in DSH; they
 * can already read session files directly. What this module refuses is
 * non-owner remote principals, delegated/forked sessions, and every other
 * message source (commands, plan mode, goals, ACP, SDK, title generation).
 */

/** Unmodified pre-0.2.1 runtimes lack the Peer model and fail closed. */
export function continuityHostAuthAvailable(ctx: Context): boolean {
  const connection = ctx.get("connection") as { createPeer?: unknown } | undefined;
  return typeof connection?.createPeer === "function";
}

/** The current Remote invocation comes from a live Peer whose principal is the owner. */
export function authenticatedContinuityInvocation(ctx: Context): boolean {
  if (!continuityHostAuthAvailable(ctx)) return false;
  try {
    const invocation = ctx.invocation;
    const peer = invocation?.peer;
    if (!invocation || invocation.signal?.aborted || !peer || peer.signal?.aborted) return false;
    return peer.principal?.kind === "owner";
  } catch { return false; }
}

interface Coordinate { readonly projectId: string; readonly seq: number; readonly generation: number; readonly headerHash: string; readonly floor: number }

/** Owner-prompt authority for the mounted conservative v2 lane. Fork/delegated
 * headers remain refused; structural projection is never treated as
 * authenticated origin. The cache is process-local, so new body work requires
 * a fresh owner prompt after restart. */
export function mountContinuityHostAuthV02(ctx: Context, generation: () => number,
  allowed: (session: Session) => boolean): { has(session: Session, seq: number, epoch: number): boolean; clear(): void; dispose(): void } {
  const coordinates = new Map<string, Coordinate>();
  let disposed = false;
  const stamp = (session: Session) => continuityCanonicalDigest({ header: continuityCanonicalHeader(session.header), inheritedEventCount: session.inheritedEventCount });
  const eligible = (session: Session) => !disposed && allowed(session) && !!session.header.cwd && !isDelegatedHeader(session.header);
  const removeAppend = ctx.on("session/event", (session, event) => {
    if (disposed || event.type !== "user/message" || event.surfaceOp !== "append" || !eligible(session)) return;
    const epoch = generation();
    if (epoch < 0) return;
    const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd!));
    // Exact owner source only: a `principal` key (non-owner caller) or any
    // other source shape is rejected by the structural check.
    const coordinate = continuityV03LiveHumanReceiptFromSessionEvent(session, event, projectId, epoch);
    if (!coordinate) return;
    if (coordinates.size >= 4096 && !coordinates.has(session.id)) return;
    coordinates.set(session.id, { projectId, seq: coordinate.seq, generation: epoch, headerHash: stamp(session), floor: session.inheritedEventCount });
  });
  const removeDisposed = ctx.on("session/disposed", session => { coordinates.delete(session.id); });
  const clear = () => { coordinates.clear(); };
  const dispose = () => { if (disposed) return; disposed = true; clear(); removeAppend(); removeDisposed(); };
  ctx.effect(() => dispose);
  return { clear, dispose, has(session, seq, epoch) {
    const coordinate = coordinates.get(session.id);
    return eligible(session) && !!coordinate && coordinate.seq === seq && coordinate.generation === epoch && epoch === generation()
      && coordinate.floor === session.inheritedEventCount && coordinate.headerHash === stamp(session)
      && coordinate.projectId === opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd!));
  } };
}
