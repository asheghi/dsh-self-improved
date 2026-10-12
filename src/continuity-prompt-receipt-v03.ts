import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ContinuityV03EligibleLiveHuman } from "./continuity-boundary-v03.js";
import { continuityV03LiveHumanReceiptFromSessionEvent } from "./continuity-live-human-event-v03.js";
import {
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03SessionId,
} from "./continuity-schema-contract-v03.js";

const RECEIPT_KEYS = ["kind", "sessionId", "projectId", "messageId", "requestId", "generation"] as const;
const RECEIPT_KEY_SET = new Set<string>(RECEIPT_KEYS);
const DEFAULT_MAX_PENDING = 4096;

interface AcceptedPrompt {
  sessionId: string;
  projectId: string;
  messageId: string;
  requestId: string;
  generation: number;
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable === true
      ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactAcceptedPrompt(value: unknown): AcceptedPrompt | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>; }
  catch { return null; }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== RECEIPT_KEYS.length || keys.some(key => typeof key !== "string" || !RECEIPT_KEY_SET.has(key))) return null;
  for (const key of RECEIPT_KEYS) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return null;
  }
  const fields = Object.fromEntries(RECEIPT_KEYS.map(key => [key, descriptors[key].value])) as Record<string, unknown>;
  if (fields.kind !== "host-prompt-accepted"
    || !isSafeContinuityV03SessionId(fields.sessionId)
    || !isSafeContinuityV03ProjectId(fields.projectId)
    || typeof fields.messageId !== "string" || fields.messageId.length < 1 || fields.messageId.length > 256 || fields.messageId.includes("\0")
    || typeof fields.requestId !== "string" || fields.requestId.length < 1 || fields.requestId.length > 512 || fields.requestId.includes("\0")
    || typeof fields.generation !== "number" || !Number.isSafeInteger(fields.generation) || fields.generation < 0) return null;
  return {
    sessionId: fields.sessionId,
    projectId: fields.projectId,
    messageId: fields.messageId,
    requestId: fields.requestId,
    generation: fields.generation,
  };
}

function promptKey(sessionId: string, messageId: string): string {
  return JSON.stringify([sessionId, messageId]);
}

/**
 * DDL-free one-time pairing between a Host-admitted prompt and its exact live
 * Session append. `acceptHostPrompt` is caller-attested: production use must be
 * restricted to the authenticated Host prompt route after Agent admission;
 * this class does not verify invocation.peer, browser authentication, or human
 * intent. The client request ID is only a secondary correlation check. The
 * Host-generated UserMessage id binds the later append, and the result contains
 * only the boundary coordinate, never either ID or the message body.
 */
export class ContinuityPromptReceiptLedgerV03 {
  private readonly pending = new Map<string, AcceptedPrompt>();

  constructor(private readonly maxPending = DEFAULT_MAX_PENDING) {
    if (!Number.isSafeInteger(maxPending) || maxPending < 1 || maxPending > 65_536) {
      throw new RangeError("invalid v3 Host prompt receipt capacity");
    }
  }

  /** Call only after the trusted Host route has admitted this exact message. */
  acceptHostPrompt(value: unknown): boolean {
    const prompt = exactAcceptedPrompt(value);
    if (!prompt || this.pending.size >= this.maxPending) return false;
    const key = promptKey(prompt.sessionId, prompt.messageId);
    if (this.pending.has(key) || [...this.pending.values()].some(existing =>
      existing.sessionId === prompt.sessionId && existing.requestId === prompt.requestId)) return false;
    this.pending.set(key, prompt);
    return true;
  }

  /** Consume one receipt only when the exact live append, IDs, project and generation match. */
  observeLiveAppend(
    session: Session,
    event: SessionEvent,
    projectId: string,
    generation: number,
  ): ContinuityV03EligibleLiveHuman | null {
    if (!session || !event || ownData(event, "type") !== "user/message" || ownData(event, "surfaceOp") !== "append") return null;
    const data = ownData(event, "data");
    if (ownData(data, "role") !== "user") return null;
    const seq = ownData(event, "seq");
    let sessionId: string;
    let inheritedEventCount: number;
    let firstLiveSeq: number;
    try {
      sessionId = session.id;
      inheritedEventCount = session.inheritedEventCount;
      firstLiveSeq = session.firstLiveSeq;
    } catch { return null; }
    if (!isSafeContinuityV03SessionId(sessionId)
      || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0
      || !Number.isSafeInteger(firstLiveSeq) || firstLiveSeq < inheritedEventCount
      || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < firstLiveSeq || seq < inheritedEventCount) return null;
    const messageId = ownData(data, "id");
    if (typeof messageId !== "string" || messageId.length < 1 || messageId.length > 256 || messageId.includes("\0")) return null;
    const key = promptKey(sessionId, messageId);
    const prompt = this.pending.get(key);
    if (!prompt) return null;
    // The first live append carrying this Host message ID burns the ticket even
    // if its source, project, or generation is wrong; a later duplicate cannot
    // turn the same identity into an eligible event.
    this.pending.delete(key);
    const coordinate = continuityV03LiveHumanReceiptFromSessionEvent(session, event, projectId, generation);
    if (!coordinate) return null;
    const source = ownData(data, "source");
    const requestId = ownData(source, "rpcId");
    if (typeof requestId !== "string" || requestId.length < 1 || requestId.length > 512 || requestId.includes("\0")
      || prompt.requestId !== requestId || prompt.projectId !== coordinate.projectId
      || prompt.generation !== coordinate.generation) return null;
    return coordinate;
  }

  /** Drop all unpaired prompt receipts when the owning session is disposed. */
  forgetSession(sessionId: string): number {
    if (!isSafeContinuityV03SessionId(sessionId)) return 0;
    let removed = 0;
    for (const [key, prompt] of this.pending) {
      if (prompt.sessionId !== sessionId) continue;
      this.pending.delete(key);
      removed++;
    }
    return removed;
  }

  get pendingCount(): number { return this.pending.size; }
}
