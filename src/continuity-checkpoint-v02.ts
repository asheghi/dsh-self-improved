import { createHash } from "node:crypto";
import type { SessionObservation } from "@deepseek-ai/dsh-session-query";
import type { SessionProjectionRegistry, ProjectionCheckpoint } from "@deepseek-ai/dsh-session-projection";
import type * as Zod from "zod";
import { CONTINUITY_PROJECTION_KEY as KEY, continuityProjectionDefinition } from "./continuity-registry-v02.js";

// Private validated structural source, NOT a native observation lease/cursor
// constructor. Historical cursor numbers are checked against the owned cut.
export type CanonicalContinuitySource = Pick<SessionObservation, "header" | "events" | "inheritedEventCount"> & { cursor: number };
export interface BoundContinuityCheckpoint {
  format: 1; sessionId: string; headerHash: string; inheritedEventCount: number;
  asOfSeq: number; sourceHash: string; row: ProjectionCheckpoint[string];
}
// Verified native JSON values only. Sort object keys at every level so cold
// native decode/property insertion order cannot change immutable fingerprints.
// Array order and every present value remain authoritative.
export const continuityCanonicalDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, part: unknown) =>
  part !== null && typeof part === "object" && !Array.isArray(part)
    ? Object.fromEntries(Object.keys(part).sort().map(key => [key, (part as Record<string, unknown>)[key]])) : part), "utf8").digest("hex");
// Native persistence hydrates an OMITTED delegationDepth to exactly zero.
// Normalize only that verified optional default, never parent/origin/cwd/id,
// explicit depth (including nonzero), or any other ownership/source field.
export const continuityCanonicalHeader = (header: CanonicalContinuitySource["header"]): CanonicalContinuitySource["header"] =>
  Object.hasOwn(header, "delegationDepth") ? header : { ...header, delegationDepth: 0 };
// Private aliases retain the audited binding-v2 call sites/bytes; shared
// ancestry hashing uses these same trusted-source helpers, not a new codec.
const digest = continuityCanonicalDigest;
const fingerprintHeader = continuityCanonicalHeader;
// Binding v2 changes canonical encoding/default handling. Experimental v1
// jobs fail closed against this digest; old caches refold, never rebind jobs.
const sourceDigest = (source: CanonicalContinuitySource, events: CanonicalContinuitySource["events"]): string =>
  digest({ bindingVersion: 2, header: fingerprintHeader(source.header), inheritedEventCount: source.inheritedEventCount, events });
function canonicalEvents(source: CanonicalContinuitySource) {
  const events = source.events;
  if (!Number.isSafeInteger(source.cursor) || source.cursor < -1
    || !Number.isSafeInteger(source.inheritedEventCount) || source.inheritedEventCount < 0 || source.inheritedEventCount > events.length
    || events.length !== source.cursor + 1 || events.some((event, index) => event.seq !== index)) {
    throw new Error("continuity recovery requires complete contiguous canonical source");
  }
  return events;
}
/** Historical job cut from the SAME full native observation. Never reuse the
 * latest checkpoint for older work. Fork cuts before inherited floor refuse. */
export function continuitySourceAtCut(source: CanonicalContinuitySource, cut: number): CanonicalContinuitySource {
  const events = canonicalEvents(source);
  if (!Number.isSafeInteger(cut) || cut < -1 || cut > source.cursor || cut + 1 < source.inheritedEventCount) throw new Error("invalid continuity historical cut");
  return { header: source.header, inheritedEventCount: source.inheritedEventCount,
    cursor: cut, events: events.slice(0, cut + 1) };
}
/** Detached envelope from ONE authoritative native observation, not a live
 * Session synchronous history read. Caller retains/disposes that lease.
 */
export function bindContinuityCheckpoint(source: CanonicalContinuitySource, row: ProjectionCheckpoint[string]): BoundContinuityCheckpoint {
  const events = canonicalEvents(source);
  if (!row || row.seq !== source.cursor) throw new Error("continuity capability missing or checkpoint cut drift");
  return { format: 1, sessionId: source.header.id, headerHash: digest(fingerprintHeader(source.header)),
    inheritedEventCount: source.inheritedEventCount, asOfSeq: source.cursor,
    sourceHash: sourceDigest(source, events), row: structuredClone(row) };
}
/** COLD O(full-source) validation. No subscriber/write/provider/task wake.
 * Hashes are not an external golden root against rewritten native history.
 */
export function recoverContinuityCheckpoint(
  registry: SessionProjectionRegistry, source: CanonicalContinuitySource, input: unknown, z: typeof Zod,
): { checkpoint: ProjectionCheckpoint; cacheAccepted: boolean; reason: "accepted" | "absent" | "binding-mismatch" } {
  const events = canonicalEvents(source);
  const definition = continuityProjectionDefinition(z);
  const envelope = input as Partial<BoundContinuityCheckpoint> | null;
  let accepted = false;
  if (envelope && typeof envelope === "object" && envelope.format === 1
    && envelope.sessionId === source.header.id && envelope.headerHash === digest(fingerprintHeader(source.header))
    && envelope.inheritedEventCount === source.inheritedEventCount
    && Number.isSafeInteger(envelope.asOfSeq) && envelope.asOfSeq! >= -1 && envelope.asOfSeq! <= source.cursor
    && envelope.row?.ver === definition.stateVersion && envelope.row.seq === envelope.asOfSeq) {
    const prefix = events.slice(0, envelope.asOfSeq! + 1);
    const parsed = definition.stateSchema.safeParse(envelope.row.val);
    if (parsed.success && envelope.sourceHash === sourceDigest(source, prefix)) {
      let canonical = definition.init(source.header, source.inheritedEventCount);
      for (const event of prefix) canonical = definition.apply(canonical, event);
      accepted = digest(parsed.data) === digest(canonical);
    }
  }
  const seed: ProjectionCheckpoint = accepted ? { [KEY]: structuredClone(envelope!.row!) } : {};
  // Ask the actual native registry to admit its full-read branded offset.
  // An empty checkpoint requires offset zero; no eager SDK runtime import
  // can break accepted memory lanes before optional capability injection.
  const fullStart = registry.restoreFloor({});
  if (fullStart !== 0) throw new Error("continuity recovery capability unavailable");
  const restored = registry.restore(seed, events, fullStart, source.header, source.inheritedEventCount);
  if (!restored.checkpoint[KEY]) throw new Error("continuity recovery capability unavailable");
  return { checkpoint: { [KEY]: restored.checkpoint[KEY] }, cacheAccepted: accepted,
    reason: accepted ? "accepted" : input == null ? "absent" : "binding-mismatch" };
}
