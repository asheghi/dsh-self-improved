import type { Context } from "@deepseek-ai/cordis";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import { ContinuityPromptReceiptLedgerV03 } from "./continuity-prompt-receipt-v03.js";
import { continuityCanonicalDigest, continuityCanonicalHeader } from "./continuity-checkpoint-v02.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd, isDelegatedHeader } from "./capture.js";

interface HostReceipt { readonly sessionId: string; readonly messageId: string; readonly requestId: string }
interface ConnectionReceiptCapability {
  consumeFinalizedPromptReceipt(receipt: unknown): HostReceipt | undefined;
  readAuthenticatedInvocationAdmission(proof: unknown, endpoint: string, args: Readonly<Record<string, unknown>>): unknown;
}
const connectionOf = (ctx: Context): ConnectionReceiptCapability | undefined => {
  const connection = (ctx as unknown as { get(key: string): unknown }).get("connection") as Partial<ConnectionReceiptCapability> | undefined;
  return typeof connection?.consumeFinalizedPromptReceipt === "function" && typeof connection.readAuthenticatedInvocationAdmission === "function"
    ? connection as ConnectionReceiptCapability : undefined;
};

export function continuityHostAuthAvailable(ctx: Context): boolean { return connectionOf(ctx) !== undefined; }

/** Requires the candidate Host-owned verifier, not peer/request JSON presence.
 * Unmodified runtimes fail closed. No public receipt-mint operation exists. */
export function authenticatedContinuityInvocation(ctx: Context): boolean {
  const invocation = (ctx as unknown as { invocation?: { authenticatedAdmission?: unknown; request?: { namespace?: string; method?: string; args?: Readonly<Record<string, unknown>> }; signal?: AbortSignal } }).invocation;
  const request = invocation?.request;
  if (!invocation || invocation.signal?.aborted || !request?.namespace || !request.method || !request.args) return false;
  try { return !!connectionOf(ctx)?.readAuthenticatedInvocationAdmission(invocation.authenticatedAdmission, `${request.namespace}/${request.method}`, request.args); }
  catch { return false; }
}

interface Coordinate { readonly sessionId: string; readonly projectId: string; readonly seq: number; readonly generation: number; readonly headerHash: string; readonly floor: number }

/** Finalized-only native exact-append authority for the mounted conservative v2
 * lane. Fork/delegated headers remain refused; structural projection is never
 * treated as authenticated origin. Entire cache is lost on unload/restart, so
 * new body work requires a fresh authenticated prompt after restart. */
export function mountContinuityHostAuthV02(ctx: Context, generation: () => number,
  allowed: (session: Session) => boolean): { has(session: Session, seq: number, epoch: number): boolean; clear(): void; dispose(): void } {
  const ledger = new ContinuityPromptReceiptLedgerV03(4096);
  const stamps = new WeakMap<object, number>();
  const coordinates = new Map<string, Coordinate>();
  const sessions = new Map<string, Session>();
  const pendingAppends = new Map<string, { session: Session; event: SessionEvent }>();
  let disposed = false;
  const diagnostic = (stage: string, ...flags: boolean[]) => { if (process.env.DSH_AUTH_DIAG === "1") console.warn("[auth candidate] owner", stage, ...flags); };
  const stamp = (session: Session) => continuityCanonicalDigest({ header: continuityCanonicalHeader(session.header), inheritedEventCount: session.inheritedEventCount });
  const eligible = (session: Session) => !disposed && allowed(session) && !!session.header.cwd && !isDelegatedHeader(session.header);
  const observe = (session: Session, event: SessionEvent): void => {
    if (!eligible(session)) return;
    const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd!));
    const epoch = generation();
    const coordinate = ledger.observeLiveAppend(session, event, projectId, epoch);
    diagnostic("append", ledger.pendingCount > 0, !!coordinate);
    if (!coordinate) return;
    if (coordinates.size >= 4096 && !coordinates.has(session.id)) return;
    coordinates.set(session.id, { sessionId: session.id, projectId, seq: coordinate.seq, generation: epoch, headerHash: stamp(session), floor: session.inheritedEventCount });
  };
  const removeAppend = ctx.on("session/event", (session, event) => {
    if (disposed || event.type !== "user/message" || event.surfaceOp !== "append" || !eligible(session)) return;
    if (sessions.size >= 4096 && !sessions.has(session.id)) return;
    sessions.set(session.id, session);
    const key = JSON.stringify([session.id, event.data.id]);
    if (pendingAppends.size >= 4096 && !pendingAppends.has(key)) return;
    const boundaryEvent = { type: "user/message", seq: event.seq, surfaceOp: "append", data: { id: event.data.id, role: event.data.role, source: { ...event.data.source } } } as SessionEvent;
    pendingAppends.set(key, { session, event: boundaryEvent });
    observe(session, event);
  });
  // Candidate core contract is not present in the installed rc.2 declarations.
  // Narrow runtime feature check keeps this plugin compatible and default-deny.
  type ReceiptContext = { on(event: string, callback: (event: { phase?: string; receipt?: unknown }) => void): () => void };
  const removeReceipt = (ctx as unknown as ReceiptContext).on("session/prompt-admission", event => {
    diagnostic("receipt-" + event?.phase, !disposed, !!event?.receipt);
    if (disposed || !event?.receipt || typeof event.receipt !== "object") return;
    if (event.phase === "provisional") { stamps.set(event.receipt, generation()); return; }
    if (event.phase !== "finalized") return;
    const epoch = stamps.get(event.receipt);
    diagnostic("receipt-epoch", epoch !== undefined, epoch === generation(), epoch !== undefined && epoch >= 0);
    if (epoch === undefined || epoch !== generation() || epoch < 0) return;
    let receipt: HostReceipt | undefined;
    try { receipt = connectionOf(ctx)?.consumeFinalizedPromptReceipt(event.receipt); } catch { return; }
    diagnostic("verified-final", !!receipt);
    if (!receipt) return;
    const session = sessions.get(receipt.sessionId) ?? ctx.get("sessions")?.get(receipt.sessionId as Session["id"]);
    diagnostic("native-session", !!session, !!session && eligible(session));
    if (!session || !eligible(session) || (sessions.size >= 4096 && !sessions.has(session.id))) return;
    sessions.set(session.id, session);
    const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd!));
    if (!ledger.acceptHostPrompt({ kind: "host-prompt-accepted", sessionId: session.id, projectId, messageId: receipt.messageId, requestId: receipt.requestId, generation: epoch })) return;
    const key = JSON.stringify([session.id, receipt.messageId]);
    const append = pendingAppends.get(key);
    if (append) { pendingAppends.delete(key); observe(append.session, append.event); }
  });
  const removeDisposed = ctx.on("session/disposed", session => {
    coordinates.delete(session.id); sessions.delete(session.id); ledger.forgetSession(session.id);
    for (const [key, append] of pendingAppends) if (append.session.id === session.id) pendingAppends.delete(key);
  });
  const clear = () => { coordinates.clear(); pendingAppends.clear(); for (const id of sessions.keys()) ledger.forgetSession(id); sessions.clear(); };
  const dispose = () => { if (disposed) return; disposed = true; clear(); removeAppend(); removeReceipt(); removeDisposed(); };
  ctx.effect(() => dispose);
  return { clear, dispose, has(session, seq, epoch) {
    const coordinate = coordinates.get(session.id);
    diagnostic("check", eligible(session), !!coordinate, coordinate?.seq === seq, coordinate?.generation === epoch, epoch === generation(), coordinate?.headerHash === stamp(session));
    return eligible(session) && !!coordinate && coordinate.seq === seq && coordinate.generation === epoch && epoch === generation()
      && coordinate.floor === session.inheritedEventCount && coordinate.headerHash === stamp(session)
      && coordinate.projectId === opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd!));
  } };
}
