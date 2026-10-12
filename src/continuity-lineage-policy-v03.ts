import {
  CONTINUITY_ANCESTOR_LIMIT,
  CONTINUITY_HISTORICAL_LINEAGE_FORMAT,
  CONTINUITY_LINEAGE_BINDING_VERSION,
} from "./continuity-ancestry-v02.js";
import { continuityCanonicalDigest } from "./continuity-checkpoint-v02.js";
import { isSafeContinuityV03ProjectId, isSafeContinuityV03Sha256 } from "./continuity-schema-contract-v03.js";

/** Immutable identity of one allowed policy snapshot for a verified lineage. */
export interface ContinuityPreviewLineagePolicyStampV03 {
  lineageBindingHash: string;
  policyRowsHash: string;
  globalEpoch: number;
}
export interface ContinuityPreviewLineagePolicyRowV03 {
  sessionKey: string;
  projectId: string;
  generation: number;
  allowed: true;
}

const LINEAGE_KEYS = ["format", "bindingVersion", "projectId", "child", "edges", "rootSessionKey", "bindingHash"] as const;
const LINEAGE_CHILD_KEYS = ["sessionKey", "headerHash", "inheritedEventCount", "selectedCut", "selectedSourceHash"] as const;
const LINEAGE_EDGE_KEYS = ["childSessionKey", "parentSessionKey", "childHeaderHash", "parentHeaderHash",
  "childInheritedEventCount", "parentInheritedEventCount", "copiedPrefixCut", "copiedPrefixHash"] as const;
const POLICY_ROW_KEYS = ["sessionKey", "projectId", "generation", "allowed"] as const;

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch { return null; }
  const ownKeys = Reflect.ownKeys(descriptors);
  if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const copy: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    copy[key] = descriptor.value;
  }
  return copy;
}

function exactDataArray(value: unknown, max: number): unknown[] | null {
  if (value === null || typeof value !== "object") return null;
  let descriptors: Record<PropertyKey, PropertyDescriptor>;
  try {
    if (!Array.isArray(value)) return null;
    descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<PropertyKey, PropertyDescriptor>;
  } catch { return null; }
  const lengthDescriptor = descriptors.length;
  if (!lengthDescriptor || !Object.hasOwn(lengthDescriptor, "value") || typeof lengthDescriptor.value !== "number"
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0 || lengthDescriptor.value > max) return null;
  const length = lengthDescriptor.value;
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== length + 1 || !Object.hasOwn(descriptors, "length")) return null;
  const out: unknown[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value")) return null;
    out.push(descriptor.value);
  }
  if (keys.some(key => key !== "length" && (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key)
    || Number(key) >= length))) return null;
  return out;
}

/**
 * Compose a default-deny policy stamp from one exact row per node in a
 * verified child-to-root lineage. This pure layer does not read or authenticate
 * policy rows; a trusted Host adapter must resolve and provide the snapshot.
 */
export function composeContinuityPreviewLineagePolicyStampV03(
  lineageValue: unknown,
  rowsValue: unknown,
  globalEpoch: unknown,
): ContinuityPreviewLineagePolicyStampV03 | null {
  const lineage = exactDataRecord(lineageValue, LINEAGE_KEYS);
  if (!lineage || lineage.format !== CONTINUITY_HISTORICAL_LINEAGE_FORMAT
    || lineage.bindingVersion !== CONTINUITY_LINEAGE_BINDING_VERSION
    || !isSafeContinuityV03ProjectId(lineage.projectId) || !isSafeContinuityV03Sha256(lineage.bindingHash)
    || !isSafeContinuityV03Sha256(lineage.rootSessionKey)
    || typeof globalEpoch !== "number" || !Number.isSafeInteger(globalEpoch) || globalEpoch < 0) return null;
  const child = exactDataRecord(lineage.child, LINEAGE_CHILD_KEYS);
  if (!child || !isSafeContinuityV03Sha256(child.sessionKey) || !isSafeContinuityV03Sha256(child.headerHash)
    || !isSafeContinuityV03Sha256(child.selectedSourceHash)
    || typeof child.inheritedEventCount !== "number" || !Number.isSafeInteger(child.inheritedEventCount) || child.inheritedEventCount < 0
    || typeof child.selectedCut !== "number" || !Number.isSafeInteger(child.selectedCut) || child.selectedCut < -1
    || child.selectedCut + 1 < child.inheritedEventCount) return null;
  const rawEdges = exactDataArray(lineage.edges, CONTINUITY_ANCESTOR_LIMIT);
  if (!rawEdges) return null;
  const edges: Array<Record<string, unknown>> = [];
  const sessionKeys = [child.sessionKey];
  const visited = new Set<string>(sessionKeys);
  let expectedChildKey = child.sessionKey;
  let expectedChildHeaderHash = child.headerHash;
  let expectedInheritedCount = child.inheritedEventCount;
  for (const rawEdge of rawEdges) {
    const edge = exactDataRecord(rawEdge, LINEAGE_EDGE_KEYS);
    if (!edge || edge.childSessionKey !== expectedChildKey || edge.childHeaderHash !== expectedChildHeaderHash
      || !isSafeContinuityV03Sha256(edge.parentSessionKey) || !isSafeContinuityV03Sha256(edge.childHeaderHash)
      || !isSafeContinuityV03Sha256(edge.parentHeaderHash) || !isSafeContinuityV03Sha256(edge.copiedPrefixHash)
      || visited.has(edge.parentSessionKey)
      || typeof edge.childInheritedEventCount !== "number" || !Number.isSafeInteger(edge.childInheritedEventCount)
      || edge.childInheritedEventCount !== expectedInheritedCount
      || typeof edge.parentInheritedEventCount !== "number" || !Number.isSafeInteger(edge.parentInheritedEventCount)
      || edge.parentInheritedEventCount < 0
      || typeof edge.copiedPrefixCut !== "number" || !Number.isSafeInteger(edge.copiedPrefixCut)
      || edge.copiedPrefixCut !== edge.childInheritedEventCount - 1) return null;
    visited.add(edge.parentSessionKey);
    sessionKeys.push(edge.parentSessionKey);
    expectedChildKey = edge.parentSessionKey;
    expectedChildHeaderHash = edge.parentHeaderHash;
    expectedInheritedCount = edge.parentInheritedEventCount;
    edges.push(edge);
  }
  if (lineage.rootSessionKey !== expectedChildKey) return null;
  const payload = {
    format: lineage.format, bindingVersion: lineage.bindingVersion, projectId: lineage.projectId,
    child, edges, rootSessionKey: lineage.rootSessionKey,
  };
  if (continuityCanonicalDigest(payload) !== lineage.bindingHash) return null;

  const rawRows = exactDataArray(rowsValue, CONTINUITY_ANCESTOR_LIMIT + 1);
  if (!rawRows || rawRows.length !== sessionKeys.length) return null;
  const rows: ContinuityPreviewLineagePolicyRowV03[] = [];
  for (let index = 0; index < rawRows.length; index++) {
    const row = exactDataRecord(rawRows[index], POLICY_ROW_KEYS);
    if (!row || row.sessionKey !== sessionKeys[index] || row.projectId !== lineage.projectId
      || !isSafeContinuityV03Sha256(row.sessionKey)
      || typeof row.generation !== "number" || !Number.isSafeInteger(row.generation) || row.generation < 0
      || row.allowed !== true) return null;
    rows.push({ sessionKey: row.sessionKey, projectId: row.projectId as string,
      generation: row.generation, allowed: true });
  }
  return Object.freeze({
    lineageBindingHash: lineage.bindingHash,
    policyRowsHash: continuityCanonicalDigest({ lineageBindingHash: lineage.bindingHash, projectId: lineage.projectId, rows }),
    globalEpoch,
  });
}
