import { continuityCanonicalDigest as digest, continuityCanonicalHeader } from "./continuity-checkpoint-v02.js";
import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { SessionObservation, SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import { opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";

export const CONTINUITY_ANCESTOR_LIMIT = 16;
export interface ContinuityAncestryCoordinate {
  sessionKey: string;
  headerHash: string;
  inheritedEventCount: number;
  asOfSeq: number;
  /** Complete observed source, independently binding this node's own seed. */
  sourceHash: string;
  /** Parent prefix copied by the previous node; full child cut for the child. */
  prefixCut: number;
  prefixHash: string;
}
export interface ContinuityAncestryProof {
  format: 1;
  projectId: string;
  child: ContinuityAncestryCoordinate;
  ancestors: ContinuityAncestryCoordinate[];
  proofHash: string;
}
// Share checkpoint binding-v2's audited encoding/default normalization.
// This changes fingerprint portability only, never ancestry admission.

function validateSource(source: SessionObservation, expectedId: SessionId, projectId: string): void {
  const h = source.header, floor = source.inheritedEventCount;
  if (h.version !== 4 || h.id !== expectedId || typeof h.id !== "string" || !h.id || h.id.length > 256
    || typeof h.isSeeded !== "boolean" || typeof h.cwd !== "string" || !isAbsolute(h.cwd)
    || !Number.isSafeInteger(h.createdAt) || h.createdAt < 0
    || opaqueProjectIdFromKey(projectKeyFromCwd(h.cwd)) !== projectId) throw new Error("continuity ancestry ownership mismatch");
  // Known durable native delegation markers deny, including an ancestor whose
  // markers were not carried into its plain-fork child. Optional fields are
  // fail-closed by presence: own `undefined` is malformed metadata, not absence.
  const hasOrigin = Object.hasOwn(h, "origin");
  const hasDepth = Object.hasOwn(h, "delegationDepth");
  if (hasOrigin || (hasDepth && (!Number.isSafeInteger(h.delegationDepth) || h.delegationDepth !== 0))) {
    throw new Error("continuity ancestry delegated or unknown origin");
  }
  if (!Number.isSafeInteger(source.cursor) || source.cursor < -1 || source.events.length !== source.cursor + 1
    || source.events.some((event, index) => event.seq !== index)
    || !Number.isSafeInteger(floor) || floor < 0 || floor > source.events.length) throw new Error("continuity ancestry canonical source invalid");
  const hasParent = Object.hasOwn(h, "parentSession");
  if (hasParent && (typeof h.parentSession !== "string" || !h.parentSession || h.parentSession.length > 256)) {
    throw new Error("continuity ancestry seed lineage invalid");
  }
  if (hasParent) {
    if (!h.isSeeded) throw new Error("continuity ancestry seed lineage invalid");
    // Native buildForkSeed copies [0,floor), then appends this CHILD-owned
    // inherited marker and synthetic closers. Never compare closers to parent.
    const marker = source.events[floor];
    if (marker?.type !== "session/end-seed" || marker.data.inherited !== true) throw new Error("continuity ancestry seed marker missing");
  } else if (h.isSeeded || floor !== 0) throw new Error("continuity ancestry seed lineage missing");
}
function coordinate(source: SessionObservation, prefixCut: number): ContinuityAncestryCoordinate {
  return {
    sessionKey: digest(source.header.id), headerHash: digest(continuityCanonicalHeader(source.header)), inheritedEventCount: source.inheritedEventCount,
    asOfSeq: source.cursor,
    sourceHash: digest({ bindingVersion: 1, header: continuityCanonicalHeader(source.header), inheritedEventCount: source.inheritedEventCount, events: source.events }),
    prefixCut, prefixHash: digest(source.events.slice(0, prefixCut + 1)),
  };
}
interface ContinuityAncestryQuery extends Pick<SessionQueryEngine, "observeSession"> {}
type AncestryReader<T> = (sources: readonly SessionObservation[]) => T;

/** Acquire and validate one complete child-to-root chain, run a body-free
 * derivation while the leases are owned, then dispose every accepted lease.
 * Shared by the existing current-source proof and the new historical binding
 * so ancestry validity/lifetime rules cannot drift between the two.
 */
async function withValidatedAncestry<T>(query: ContinuityAncestryQuery, childId: SessionId, projectId: string,
  signal: AbortSignal, read: AncestryReader<T>): Promise<T> {
  if (typeof childId !== "string" || !childId || childId.length > 256
    || typeof projectId !== "string" || !/^pj-[a-f0-9]{32}$/.test(projectId)) throw new Error("invalid continuity ancestry ownership");
  const stop = new AbortController();
  const relay = (): void => { stop.abort(); };
  signal.addEventListener("abort", relay, { once: true });
  if (signal.aborted) stop.abort();
  const leases: SessionObservation[] = [];
  try {
    stop.signal.throwIfAborted();
    let source = await query.observeSession(childId, { signal: stop.signal, projectionMode: "none" });
    leases.push(source); stop.signal.throwIfAborted(); validateSource(source, childId, projectId);
    const sources: SessionObservation[] = [source];
    const visited = new Set<string>([childId]);
    while (source.header.parentSession !== undefined) {
      stop.signal.throwIfAborted();
      if (sources.length > CONTINUITY_ANCESTOR_LIMIT) throw new Error("continuity ancestry depth exceeded");
      const parentId = source.header.parentSession;
      if (visited.has(parentId)) throw new Error("continuity ancestry cycle");
      visited.add(parentId);
      const parent = await query.observeSession(parentId, { signal: stop.signal, projectionMode: "none" });
      leases.push(parent); stop.signal.throwIfAborted(); validateSource(parent, parentId, projectId);
      const floor = source.inheritedEventCount;
      if (floor > parent.events.length || !isDeepStrictEqual(source.events.slice(0, floor), parent.events.slice(0, floor))) throw new Error("continuity ancestry inherited prefix mismatch");
      sources.push(parent);
      source = parent;
    }
    stop.signal.throwIfAborted();
    return read(sources);
  } finally {
    signal.removeEventListener("abort", relay); stop.abort();
    // Release ALL accepted observations even if one disposal throws.
    const errors: unknown[] = [];
    for (let index = leases.length - 1; index >= 0; index--) {
      try { leases[index]![Symbol.dispose](); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "continuity ancestry lease disposal failed");
  }
}

/** Standalone trusted-source IDENTITY proof, not policy, direct-human
 * attestation, permission, task success, prompt or Continue authority. No
 * writes/projection changes/provider calls. Caller must separately verify own
 * explicit intent/current consent and revalidate this proof for any action.
 * At most sixteen ancestors (seventeen caller-owned observation leases); reads
 * are complete native snapshots, NOT a globally bounded body/memory budget.
 * Hashes are not a cryptographic external golden root against rewritten logs.
 */
export async function verifyContinuityAncestryV02(query: ContinuityAncestryQuery,
  childId: SessionId, projectId: string, signal: AbortSignal): Promise<ContinuityAncestryProof> {
  return withValidatedAncestry(query, childId, projectId, signal, (sources) => {
    const childSource = sources[0]!;
    const child = coordinate(childSource, childSource.cursor);
    const ancestors = sources.slice(1).map((parent, index) => coordinate(parent, sources[index]!.inheritedEventCount - 1));
    const proof = { format: 1 as const, projectId, child, ancestors };
    return { ...proof, proofHash: digest(proof) };
  });
}

export const CONTINUITY_HISTORICAL_LINEAGE_FORMAT = 2;
export const CONTINUITY_LINEAGE_BINDING_VERSION = 3;
export interface ContinuityHistoricalLineageEdge {
  childSessionKey: string;
  parentSessionKey: string;
  childHeaderHash: string;
  parentHeaderHash: string;
  childInheritedEventCount: number;
  parentInheritedEventCount: number;
  copiedPrefixCut: number;
  copiedPrefixHash: string;
}
export interface ContinuityHistoricalLineageBindingV02 {
  format: typeof CONTINUITY_HISTORICAL_LINEAGE_FORMAT;
  bindingVersion: typeof CONTINUITY_LINEAGE_BINDING_VERSION;
  projectId: string;
  child: {
    sessionKey: string;
    headerHash: string;
    inheritedEventCount: number;
    selectedCut: number;
    selectedSourceHash: string;
  };
  edges: ContinuityHistoricalLineageEdge[];
  rootSessionKey: string;
  bindingHash: string;
}

function deriveContinuityHistoricalLineageBindingV02(sources: readonly SessionObservation[],
  projectId: string, selectedCut: number): ContinuityHistoricalLineageBindingV02 {
  const childSource = sources[0]!;
  if (!Number.isSafeInteger(selectedCut) || selectedCut < -1 || selectedCut > childSource.cursor
    || selectedCut + 1 < childSource.inheritedEventCount) throw new Error("invalid continuity historical cut");
  const selectedEvents = childSource.events.slice(0, selectedCut + 1);
  const childHeader = continuityCanonicalHeader(childSource.header);
  const child = {
    sessionKey: digest(childSource.header.id),
    headerHash: digest(childHeader),
    inheritedEventCount: childSource.inheritedEventCount,
    selectedCut,
    selectedSourceHash: digest({ bindingVersion: CONTINUITY_LINEAGE_BINDING_VERSION,
      header: childHeader, inheritedEventCount: childSource.inheritedEventCount, events: selectedEvents }),
  };
  const edges = sources.slice(0, -1).map((edgeChild, index): ContinuityHistoricalLineageEdge => {
    const parent = sources[index + 1]!;
    const copiedPrefixCount = edgeChild.inheritedEventCount;
    return {
      childSessionKey: digest(edgeChild.header.id), parentSessionKey: digest(parent.header.id),
      childHeaderHash: digest(continuityCanonicalHeader(edgeChild.header)),
      parentHeaderHash: digest(continuityCanonicalHeader(parent.header)),
      childInheritedEventCount: copiedPrefixCount,
      parentInheritedEventCount: parent.inheritedEventCount,
      copiedPrefixCut: copiedPrefixCount - 1,
      copiedPrefixHash: digest(parent.events.slice(0, copiedPrefixCount)),
    };
  });
  const rootSessionKey = digest(sources.at(-1)!.header.id);
  const payload = {
    format: CONTINUITY_HISTORICAL_LINEAGE_FORMAT,
    bindingVersion: CONTINUITY_LINEAGE_BINDING_VERSION,
    projectId, child, edges, rootSessionKey,
  } as const;
  return { ...payload, bindingHash: digest(payload) };
}

/** Recompute a body-free stable identity binding for one selected child cut.
 * This is deliberately not wired into admission, work/job persistence,
 * provider, preview, Continue, or permission decisions. The exact caller-supplied
 * selected cut must later be compared against a freshly recomputed binding.
 *
 * Binding format 2 uses composite bindingVersion 3. Unlike the separate
 * current-source proof above, it excludes later parent tails and child events
 * after selectedCut. Each edge binds the child's exact copied parent prefix;
 * nested edges use each parent node's own inherited floor. All ancestry is
 * still reread and fully validated. Native reads are complete O(history), not
 * a global memory bound or an external golden root against rewritten logs.
 */
export async function verifyContinuityHistoricalLineageBindingV02(query: ContinuityAncestryQuery,
  childId: SessionId, projectId: string, selectedCut: number, signal: AbortSignal): Promise<ContinuityHistoricalLineageBindingV02> {
  return withValidatedAncestry(query, childId, projectId, signal,
    sources => deriveContinuityHistoricalLineageBindingV02(sources, projectId, selectedCut));
}

export interface ContinuityHistoricalLineageSnapshotV02 {
  binding: ContinuityHistoricalLineageBindingV02;
  /** Sensitive ephemeral IDs in child-to-root order; never persist or expose to providers/clients. */
  sessionIds: readonly SessionId[];
}

function freezeContinuityHistoricalLineageBindingV02(
  binding: ContinuityHistoricalLineageBindingV02,
): ContinuityHistoricalLineageBindingV02 {
  Object.freeze(binding.child);
  for (const edge of binding.edges) Object.freeze(edge);
  Object.freeze(binding.edges);
  return Object.freeze(binding);
}

/**
 * Derive a lineage binding and its raw-ID lookup chain from the SAME validated
 * native observations. This ephemeral internal snapshot exists only so a Host
 * owner can resolve policy rows; it is not authority, persistence data, or a
 * provider/client payload. Leases are still disposed by withValidatedAncestry.
 */
export async function verifyContinuityHistoricalLineageSnapshotV02(query: ContinuityAncestryQuery,
  childId: SessionId, projectId: string, selectedCut: number,
  signal: AbortSignal): Promise<ContinuityHistoricalLineageSnapshotV02> {
  return withValidatedAncestry(query, childId, projectId, signal, sources => Object.freeze({
    binding: freezeContinuityHistoricalLineageBindingV02(
      deriveContinuityHistoricalLineageBindingV02(sources, projectId, selectedCut)),
    sessionIds: Object.freeze(sources.map(source => source.header.id)),
  }));
}
