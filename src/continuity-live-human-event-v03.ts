import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  continuityCanonicalDigest,
  continuityCanonicalHeader,
} from "./continuity-checkpoint-v02.js";
import {
  isSafeContinuityV03ProjectId,
  isSafeContinuityV03SessionId,
} from "./continuity-schema-contract-v03.js";
import type { ContinuityV03EligibleLiveHuman } from "./continuity-boundary-v03.js";

const SOURCE_KEYS = new Set(["kind", "rpcId", "clientTimeZone"]);

function ownData(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object") return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") && descriptor.enumerable === true
      ? descriptor.value : undefined;
  } catch { return undefined; }
}

function exactUserRpcSource(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  let descriptors: Record<string, PropertyDescriptor>;
  try { descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<string, PropertyDescriptor>; }
  catch { return false; }
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some(key => typeof key !== "string" || !SOURCE_KEYS.has(key))
    || !Object.hasOwn(descriptors, "kind") || !Object.hasOwn(descriptors, "rpcId")) return false;
  for (const key of keys) {
    const descriptor = descriptors[key as string];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true) return false;
  }
  const rpcId = (descriptors.rpcId as PropertyDescriptor).value;
  if (descriptors.kind.value !== "user" || typeof rpcId !== "string" || rpcId.length < 1 || rpcId.length > 512
    || rpcId.includes("\0")) return false;
  if (Object.hasOwn(descriptors, "clientTimeZone")) {
    const zone = (descriptors.clientTimeZone as PropertyDescriptor).value;
    if (typeof zone !== "string" || zone.length > 128 || zone.includes("\0")) return false;
  }
  return true;
}

/**
 * Normalize one actual appended DSH user message into the boundary recorder's
 * body-free coordinate. Invoke only from the Host-owned `session/event`
 * observer, as an inner structural check before the one-time receipt ledger.
 * rc.2 `SessionController.prompt` writes `{kind:'user',rpcId}` for accepted
 * client prompts; the rpcId is client-minted correlation, not proof of human
 * intent or authorization. This helper does not authenticate its caller or
 * event provenance; production code must not send its result straight to the
 * boundary without a Host-issued message-identity receipt.
 */
export function continuityV03LiveHumanReceiptFromSessionEvent(
  session: Session,
  event: SessionEvent,
  projectId: string,
  generation: number,
): ContinuityV03EligibleLiveHuman | null {
  if (!session || !event) return null;
  const eventType = ownData(event, "type");
  const surfaceOp = ownData(event, "surfaceOp");
  const seq = ownData(event, "seq");
  const data = ownData(event, "data");
  if (eventType !== "user/message" || surfaceOp !== "append" || ownData(data, "role") !== "user"
    || !exactUserRpcSource(ownData(data, "source"))) return null;
  try {
    const sessionId = session.id;
    const header = session.header;
    const inheritedEventCount = session.inheritedEventCount;
    const firstLiveSeq = session.firstLiveSeq;
    if (!isSafeContinuityV03SessionId(sessionId) || header.id !== sessionId
      || !isSafeContinuityV03ProjectId(projectId)
      || !Number.isSafeInteger(generation) || generation < 0
      || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0
      || !Number.isSafeInteger(firstLiveSeq) || firstLiveSeq < inheritedEventCount
      || typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < firstLiveSeq || seq < inheritedEventCount) return null;
    return {
      kind: "host-direct-user-message",
      sessionId,
      projectId,
      headerHash: continuityCanonicalDigest(continuityCanonicalHeader(header)),
      inheritedEventCount,
      generation,
      seq,
    };
  } catch { return null; }
}
