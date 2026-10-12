import { isAbsolute } from "node:path";
import type { SessionQueryEngine } from "@deepseek-ai/dsh-session-query";
import {
  continuityCanonicalDigest as digest,
  continuityCanonicalHeader,
  continuitySourceAtCut,
  type CanonicalContinuitySource,
} from "./continuity-checkpoint-v02.js";
import {
  CONTINUITY_LINEAGE_BINDING_VERSION,
  verifyContinuityHistoricalLineageBindingV02,
  verifyContinuityHistoricalLineageSnapshotV02,
  type ContinuityHistoricalLineageBindingV02,
  type ContinuityHistoricalLineageSnapshotV02,
} from "./continuity-ancestry-v02.js";
import { opaqueProjectIdFromKey, projectKeyFromCwd } from "./capture.js";
import {
  CONTINUITY_STATE_VERSION_V03,
  applyContinuityProjectionV03,
  initContinuityProjectionV03,
} from "./continuity-projection-v03.js";
import {
  CONTINUITY_CHECKPOINT_FORMAT_V03,
  CONTINUITY_SOURCE_BINDING_VERSION_V03,
  continuitySourceHashV03,
  parseContinuityCheckpointEnvelopeV03,
  parseContinuityV03JobAnchor,
  type ContinuityCheckpointEnvelopeV03,
  type ContinuityV03PersistedLineageKind,
} from "./continuity-envelope-v03.js";
import { isSafeContinuityV03ProjectId, isSafeContinuityV03SessionId } from "./continuity-schema-contract-v03.js";

export type ContinuityV03AncestryQuery = Pick<SessionQueryEngine, "observeSession">;

interface ContinuityCheckpointEnvelopeBuildV03 {
  envelope: ContinuityCheckpointEnvelopeV03;
  lineageSnapshot?: ContinuityHistoricalLineageSnapshotV02;
}

async function buildContinuityCheckpointEnvelopeV03(
  query: ContinuityV03AncestryQuery,
  source: CanonicalContinuitySource,
  projectId: string,
  generation: number,
  cut: number,
  signal: AbortSignal,
  includeLineageSnapshot = false,
): Promise<ContinuityCheckpointEnvelopeBuildV03> {
  signal.throwIfAborted();
  if (!source || !source.header || !isSafeContinuityV03SessionId(source.header.id)
    || typeof source.header.cwd !== "string" || !isAbsolute(source.header.cwd)
    || !isSafeContinuityV03ProjectId(projectId) || !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("invalid v3 checkpoint source coordinates");
  }
  if (opaqueProjectIdFromKey(projectKeyFromCwd(source.header.cwd)) !== projectId) {
    throw new Error("v3 checkpoint source project mismatch");
  }

  const selected = continuitySourceAtCut(source, cut);
  const lineageSnapshot = includeLineageSnapshot
    ? await verifyContinuityHistoricalLineageSnapshotV02(query, source.header.id, projectId, cut, signal)
    : undefined;
  const lineage: ContinuityHistoricalLineageBindingV02 = lineageSnapshot?.binding
    ?? await verifyContinuityHistoricalLineageBindingV02(query, source.header.id, projectId, cut, signal);
  signal.throwIfAborted();
  const header = continuityCanonicalHeader(source.header);
  const headerHash = digest(header);
  const selectedSourceHash = digest({ bindingVersion: CONTINUITY_LINEAGE_BINDING_VERSION,
    header, inheritedEventCount: selected.inheritedEventCount, events: selected.events });
  const lineageKind: ContinuityV03PersistedLineageKind = lineage.edges.length === 0 ? "root" : "fork";
  if (lineage.projectId !== projectId || lineage.child.sessionKey !== digest(source.header.id)
    || lineage.child.headerHash !== headerHash || lineage.child.inheritedEventCount !== selected.inheritedEventCount
    || lineage.child.selectedCut !== cut || lineage.child.selectedSourceHash !== selectedSourceHash) {
    throw new Error("v3 checkpoint source differs from verified historical lineage");
  }

  let state = initContinuityProjectionV03(source.header, selected.inheritedEventCount);
  for (const event of selected.events) state = applyContinuityProjectionV03(state, event);
  if (state.lineageKind === "denied" || state.lineageKind !== (lineageKind === "root" ? "root" : "fork-candidate")) {
    throw new Error("v3 checkpoint projection and verified lineage disagree");
  }
  const sourceHash = continuitySourceHashV03(source.header.id, projectId, cut, lineageKind, selectedSourceHash, lineage.bindingHash);
  const candidate: ContinuityCheckpointEnvelopeV03 = {
    checkpointFormat: CONTINUITY_CHECKPOINT_FORMAT_V03,
    sourceBindingVersion: CONTINUITY_SOURCE_BINDING_VERSION_V03,
    sessionId: source.header.id,
    projectId,
    generation,
    headerHash,
    inheritedEventCount: selected.inheritedEventCount,
    asOfSeq: cut,
    selectedSourceHash,
    sourceHash,
    lineageKind,
    lineageHash: lineage.bindingHash,
    lineage,
    row: { ver: CONTINUITY_STATE_VERSION_V03, seq: cut, val: state },
  };
  const parsed = parseContinuityCheckpointEnvelopeV03(candidate);
  if (!parsed) throw new Error("constructed v3 checkpoint failed its strict envelope contract");
  return { envelope: parsed, ...(lineageSnapshot ? { lineageSnapshot } : {}) };
}

/** Build a detached body-free envelope; this is structural proof, not consent or action authority. */
export async function createContinuityCheckpointEnvelopeV03(
  query: ContinuityV03AncestryQuery,
  source: CanonicalContinuitySource,
  projectId: string,
  generation: number,
  cut: number,
  signal: AbortSignal,
): Promise<ContinuityCheckpointEnvelopeV03> {
  return (await buildContinuityCheckpointEnvelopeV03(query, source, projectId, generation, cut, signal)).envelope;
}

export interface ContinuityCheckpointEnvelopeLineageSnapshotV03 {
  envelope: ContinuityCheckpointEnvelopeV03;
  /** Internal-only raw session IDs; never persist or forward to providers/clients. */
  lineageSnapshot: ContinuityHistoricalLineageSnapshotV02;
}

/** Build the ordinary envelope plus an ephemeral raw-ID chain from the SAME ancestry observations. */
export async function createContinuityCheckpointEnvelopeWithLineageSnapshotV03(
  query: ContinuityV03AncestryQuery,
  source: CanonicalContinuitySource,
  projectId: string,
  generation: number,
  cut: number,
  signal: AbortSignal,
): Promise<ContinuityCheckpointEnvelopeLineageSnapshotV03> {
  const built = await buildContinuityCheckpointEnvelopeV03(query, source, projectId, generation, cut, signal, true);
  if (!built.lineageSnapshot) throw new Error("verified v3 lineage snapshot missing");
  return { envelope: built.envelope, lineageSnapshot: built.lineageSnapshot };
}

/**
 * Revalidate a pending v3 job's exact historical source against a fresh native
 * child-to-root observation. It intentionally does not require the latest
 * checkpoint to remain at this job's cut: newer checkpoints may supersede it
 * while the job still owns a valid historical reference. This verifies source
 * identity only; an owner must separately reread current job status, policy
 * generation/allowed, lease/token, cancellation and user intent atomically
 * before provider, preview, handoff or Continue work. Native read failures and
 * source mismatches fail closed; explicit abort remains visible.
 */
export async function isContinuityV03JobSourceCurrent(
  query: ContinuityV03AncestryQuery,
  source: CanonicalContinuitySource,
  jobValue: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const job = parseContinuityV03JobAnchor(jobValue);
  if (!job || job.status !== "pending") return false;

  let current: ContinuityCheckpointEnvelopeV03;
  try {
    current = await createContinuityCheckpointEnvelopeV03(query, source, job.projectId, job.generation, job.cut, signal);
  } catch {
    signal.throwIfAborted();
    return false;
  }
  return current.sessionId === job.sessionId && current.projectId === job.projectId
    && current.generation === job.generation && current.asOfSeq === job.cut
    && current.sourceHash === job.sourceHash && current.selectedSourceHash === job.selectedSourceHash
    && current.checkpointFormat === job.checkpointFormat && current.sourceBindingVersion === job.sourceBindingVersion
    && current.lineage.format === job.lineageFormat && current.lineage.bindingVersion === job.lineageBindingVersion
    && current.lineageKind === job.lineageKind && current.lineageHash === job.lineageHash;
}
