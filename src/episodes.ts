/**
 * Episode assembly and deterministic outcome classification (Phases 1+2).
 *
 * Assembly aggregates the durable episode_events ledger per (session_id, turn),
 * pairs calls with results STRICTLY via the toolCallId carried inside the result
 * payload (never by turn/step/position), and classifies outcomes from tool
 * evidence only. Interrupted, unmatched or incomplete histories stay ambiguous
 * and are never learned from.
 */
import { createHash } from "node:crypto";
import type {
  MemoryStore,
  EpisodeEventRecord,
  EpisodeUpsertInput,
  EpisodeStepInput,
} from "./storage.js";

export type EpisodeOutcome = "succeeded" | "failed" | "ambiguous";

/**
 * Deterministic per-tool last-attempt rule: with no unpaired halves, take each
 * tool's highest-ordinal attempt; succeeded when every tool's last attempt is
 * error-free, failed otherwise. Any unpaired half (missing call/result in a
 * closed turn) makes the whole episode ambiguous.
 */
export function classifyTrajectory(
  steps: Array<{ tool_name: string; is_error: number }>,
  unpaired: number,
): EpisodeOutcome {
  if (unpaired > 0 || steps.length === 0) return "ambiguous";
  const lastAttempt = new Map<string, number>();
  for (const step of steps) {
    lastAttempt.set(step.tool_name, step.is_error === 1 ? 1 : 0);
  }
  for (const isError of lastAttempt.values()) {
    if (isError === 1) return "failed";
  }
  return "succeeded";
}

/** Stable episode fingerprint: sha256 of "|"-joined tool names, first 16 hex chars. */
export function fingerprintOf(toolNames: string[]): string {
  return createHash("sha256").update(toolNames.join("|")).digest("hex").slice(0, 16);
}

interface ParsedCallPayload {
  callId: string;
  toolName: string;
  argumentsRedacted: string;
  argsTruncated: number;
}

interface ParsedResultPayload {
  toolCallId: string;
  resultExcerpt: string;
  resultTruncated: number;
  isError: number;
  errorName: string | null;
  errorCode: string | null;
}

function parseCallPayload(raw: string): ParsedCallPayload | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = JSON.parse(raw) as any;
    if (typeof p?.callId !== "string") return null;
    return {
      callId: p.callId,
      toolName: typeof p.toolName === "string" ? p.toolName : "unknown",
      argumentsRedacted: typeof p.argumentsRedacted === "string" ? p.argumentsRedacted : "",
      argsTruncated: p.argsTruncated === 1 ? 1 : 0,
    };
  } catch {
    return null;
  }
}

function parseResultPayload(raw: string): ParsedResultPayload | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = JSON.parse(raw) as any;
    if (typeof p?.toolCallId !== "string") return null;
    return {
      toolCallId: p.toolCallId,
      resultExcerpt: typeof p.resultExcerpt === "string" ? p.resultExcerpt : "",
      resultTruncated: p.resultTruncated === 1 ? 1 : 0,
      isError: p.isError === 1 ? 1 : 0,
      errorName: typeof p.errorName === "string" ? p.errorName : null,
      errorCode: typeof p.errorCode === "string" ? p.errorCode : null,
    };
  } catch {
    return null;
  }
}

/**
 * Assemble all deterministically classifiable episodes of one session from the
 * durable episode_events ledger. Idempotent: replay-safe by INSERT OR IGNORE
 * step rows + claim idempotency; reviewed/rejected episodes are never touched.
 *
 * Classification gate (completion proof): an episode may only become
 * 'succeeded'/'failed' when the turn's OWN turn-end event exists AND its
 * reasonKind === 'completed'. Any other reasonKind (aborted/blocked/error/
 * interrupted/... — merge-extensible, unknown kinds count as not-completed),
 * or closure merely because a later turn exists, keeps the episode 'ambiguous'.
 * Duplicate call identifiers or malformed/unpairable ledger rows make ownership
 * untrustworthy: the episode is 'ambiguous', every row is claimed for audit
 * linkage, and NO steps are inserted.
 *
 * A turn is closed when a turn-end event exists for it, any event with a greater
 * turn exists (detected over the FULL ledger via maxEventTurn, not just the
 * pending prefix), or its (already created) episode row is terminal. Open turns
 * keep a pending episode row (so the stale closure timer can fire) and refresh
 * its updated_at/last_seq while activity continues. Terminal, unreviewed
 * episodes are re-validated when new event rows for their turn arrive
 * (late-evidence → ambiguous).
 *
 * Multi-pass: turns are processed in ascending order and, whenever a pass made
 * progress (claims/status changes), another pass runs (bounded to 10) so turns
 * stranded behind a huge open turn still get assembled.
 */
const MAX_ASSEMBLY_PASSES = 10;

/** reasonKind carried inside a turn-end payload (schema v2 capture). */
function turnEndReasonKind(payload: string): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = JSON.parse(payload) as any;
    if (typeof p?.reasonKind === "string") return p.reasonKind;
    if (typeof p?.reason?.kind === "string") return p.reason.kind;
  } catch {
    /* malformed turn-end payload → not-completed */
  }
  return "unknown";
}

export function assembleSessionEpisodes(store: MemoryStore, sessionId: string): void {
  const projectId = store.getSessionProject(sessionId);
  const delegated = store.episodeDelegated(sessionId);
  const maxLedgerTurn = store.maxEventTurn(sessionId);
  for (let pass = 0; pass < MAX_ASSEMBLY_PASSES; pass++) {
    const pending = store.getPendingEpisodeEvents(sessionId);
    if (pending.length === 0) break;
    const turnedTurns = new Map<number, boolean>();
    for (const row of pending) turnedTurns.set(row.turn, true);
    let progress = false;
    // Ascending order: a big open turn must not starve smaller later turns.
    for (const turn of [...turnedTurns.keys()].sort((a, b) => a - b)) {
      const madeProgress = assembleClosedOrPendingTurn(store, sessionId, turn, {
        projectId,
        delegated,
        maxLedgerTurn,
      });
      progress = progress || madeProgress;
    }
    if (!progress) break;
  }
}

/**
 * Assemble ONE turn. Returns true when progress was made (a claim/status
 * change), false when the turn's pending state was merely refreshed.
 */
function assembleClosedOrPendingTurn(
  store: MemoryStore,
  sessionId: string,
  turn: number,
  scope: { projectId: string; delegated: boolean; maxLedgerTurn: number },
): boolean {
  // Closed turns are re-derived from the FULL event set (claimed rows included)
  // so a turn straddling two flush barriers pairs deterministically on replay.
  const evs = store.getTurnEpisodeEvents(sessionId, turn);
  if (evs.length === 0) return false;
  const turnEndAt: number[] = [];
  for (const e of evs) {
    if (e.kind === "turn-end") turnEndAt.push(e.at);
  }
  const closedByEnd = turnEndAt.length > 0;
  const closedByLater = turn < scope.maxLedgerTurn;
  const existing = store.getEpisodeBySessionTurn(sessionId, turn);

  // Fresh unclaimed call/result rows for this turn (staleness refresh + late evidence)
  const unclaimed = evs.filter((e) => e.episodeId === null && (e.kind === "call" || e.kind === "result" || e.kind === "turn-end"));

  if (!closedByEnd && !closedByLater) {
    // Open turn: keep a pending probe so stale closure can fire, but refresh it
    // while new evidence keeps arriving (an ACTIVE long turn must not be killed
    // by the 30-min stale-closure timer measuring from an old updated_at).
    if (!existing) {
      const calls = evs.filter((e) => e.kind === "call");
      const startedAt = calls.length > 0 ? Math.min(...calls.map((e) => e.at)) : evs[0].at;
      store.upsertEpisode({
        sessionId,
        projectId: scope.projectId,
        turn,
        status: "pending",
        startedAt,
        endedAt: null,
        firstSeq: Math.min(...evs.map((e) => e.seq)),
        lastSeq: Math.max(...evs.map((e) => e.seq)),
        fingerprint: calls.length > 0 ? fingerprintOf(calls.map((e) => parseCallPayload(e.payload)?.toolName ?? "unknown")) : null,
        delegated: scope.delegated,
      });
      return true;
    }
    if (existing.status === "pending" && existing.reviewedAt == null && unclaimed.length > 0) {
      store.upsertEpisode({
        sessionId,
        projectId: scope.projectId,
        turn,
        status: "pending",
        startedAt: existing.startedAt,
        endedAt: existing.endedAt,
        firstSeq: existing.firstSeq,
        lastSeq: Math.max(existing.lastSeq ?? 0, ...unclaimed.map((e) => e.seq)),
        fingerprint: existing.fingerprint,
        delegated: scope.delegated,
      });
    }
    return false;
  }

  // Late-evidence revalidation: a terminal episode with reviewed_at NULL whose
  // turn received NEW rows is demoted to ambiguous and adopts the new rows.
  if (existing && (existing.status === "succeeded" || existing.status === "failed") && existing.reviewedAt == null && unclaimed.length > 0) {
    const id = store.revalidateEpisodeLateEvidence(sessionId, turn);
    if (id) {
      const claimCallIds = [
        ...new Set(
          unclaimed
            .filter((e): e is EpisodeEventRecord & { callId: string } => e.callId != null && e.callId !== "")
            .map((e) => e.callId),
        ),
      ];
      store.claimEpisodeEvents(sessionId, claimCallIds, turn, id);
      return true;
    }
  }

  // Never reclassify reviewed/rejected (or already terminal) episodes
  if (existing && (existing.reviewedAt != null || existing.status !== "pending")) return false;

  const calls = evs
    .filter((e) => e.kind === "call")
    .sort((a, b) => a.seq - b.seq);
  const rawResults = evs.filter((e) => e.kind === "result").sort((a, b) => a.seq - b.seq);
  const turnEnds = evs.filter((e) => e.kind === "turn-end");
  const parsedResults = rawResults
    .map((row) => ({ row, parsed: parseResultPayload(row.payload) }))
    .filter((r): r is { row: EpisodeEventRecord; parsed: ParsedResultPayload } => r.parsed !== null);

  // OWNERSHIP TRUST LIMITS: duplicate call identifiers (two calls sharing one
  // callId, or two results sharing one toolCallId), call rows with empty/missing
  // callId, or result rows whose payload is unparsable or lacks toolCallId make
  // step ownership untrustworthy → ambiguous, all rows claimed for audit, NO steps.
  const callIdCounts = new Map<string, number>();
  let ownershipSuspect = false;
  for (const c of calls) {
    if (c.callId == null || c.callId === "") { ownershipSuspect = true; continue; }
    const n = (callIdCounts.get(c.callId) ?? 0) + 1;
    callIdCounts.set(c.callId, n);
    if (n > 1) ownershipSuspect = true;
  }
  const resultIdCounts = new Map<string, number>();
  for (const r of parsedResults) {
    if (r.parsed.toolCallId === "") { ownershipSuspect = true; continue; }
    const n = (resultIdCounts.get(r.parsed.toolCallId) ?? 0) + 1;
    resultIdCounts.set(r.parsed.toolCallId, n);
    if (n > 1) ownershipSuspect = true;
  }
  if (rawResults.length !== parsedResults.length) ownershipSuspect = true;

  if (ownershipSuspect) {
    // Claim every row of the turn (call ids, result toolCallIds, empty/null ids
    // and turn-ends) so the audit linkage is complete, and insert no steps.
    const claimCallIds = [
      ...new Set([
        ...calls.filter((e) => e.callId != null).map((e) => e.callId as string),
        ...rawResults.map((e) => (e.callId ?? "") as string),
        ...parsedResults.map((r) => r.parsed.toolCallId),
      ]),
    ];
    const ats = evs.map((e) => e.at);
    store.commitEpisode(
      {
        sessionId,
        projectId: scope.projectId,
        turn,
        status: "ambiguous",
        startedAt: Math.min(...ats),
        endedAt: Math.max(...ats),
        firstSeq: Math.min(...evs.map((e) => e.seq)),
        lastSeq: Math.max(...evs.map((e) => e.seq)),
        fingerprint: null,
        delegated: scope.delegated,
      },
      [],
      claimCallIds,
    );
    return true;
  }

  const usedResults = new Set<number>();
  const steps: EpisodeStepInput[] = [];
  for (const callEv of calls) {
    const call = parseCallPayload(callEv.payload);
    if (!call) continue; // malformed call ledger row: unpaired audit, no step
    // PAIRING RULE: equality on toolCallId only — never positional, never turn/step slop
    let matched: { row: EpisodeEventRecord; parsed: ParsedResultPayload } | null = null;
    for (const r of parsedResults) {
      if (usedResults.has(r.row.seq)) continue;
      if (r.parsed.toolCallId === call.callId) {
        matched = r;
        break;
      }
    }
    if (!matched) continue;
    usedResults.add(matched.row.seq);
    steps.push({
      episodeId: "",
      ordinal: steps.length + 1,
      callId: call.callId,
      toolName: call.toolName,
      argumentsRedacted: call.argumentsRedacted,
      resultExcerpt: matched.parsed.resultExcerpt,
      isError: matched.parsed.isError,
      errorName: matched.parsed.errorName,
      errorCode: matched.parsed.errorCode,
      callSeq: callEv.seq,
      resultSeq: matched.row.seq,
      callAt: callEv.at,
      resultAt: matched.row.at,
      argsTruncated: call.argsTruncated,
      resultTruncated: matched.parsed.resultTruncated,
    });
  }
  const unpaired = calls.length - steps.length + (parsedResults.length - steps.length);
  const claimCallIds = [...new Set([...calls.map((e) => e.callId), ...parsedResults.map((r) => r.parsed.toolCallId)])]
    .filter((id): id is string => id != null);
  let status: EpisodeOutcome = classifyTrajectory(
    steps.map((s) => ({ tool_name: s.toolName, is_error: s.isError })),
    unpaired,
  );
  // COMPLETION PROOF GATE: succeeded/failed require the turn's OWN turn-end event
  // with reasonKind === 'completed'. Any other reasonKind (aborted/blocked/error/
  // interrupted/unknown — merge-extensible, unknown counts as not-completed) or a
  // closure justified only by a later turn keeps the episode ambiguous.
  const completedByOwnEnd = turnEnds.length > 0 && turnEnds.some((t) => turnEndReasonKind(t.payload) === "completed");
  if (!completedByOwnEnd) status = "ambiguous";
  const callAts = calls.map((e) => e.at);
  const startedAt = callAts.length > 0 ? Math.min(...callAts) : Math.min(...evs.map((e) => e.at));
  const endedCandidates = [
    ...parsedResults.map((r) => r.row.at),
    ...turnEndAt,
    startedAt,
  ];
  const input: EpisodeUpsertInput = {
    sessionId,
    projectId: scope.projectId,
    turn,
    status,
    startedAt,
    endedAt: Math.max(...endedCandidates),
    firstSeq: Math.min(...evs.map((e) => e.seq)),
    lastSeq: Math.max(...evs.map((e) => e.seq)),
    fingerprint: steps.length > 0 && status !== "ambiguous" ? fingerprintOf(steps.map((s) => s.toolName)) : null,
    delegated: scope.delegated,
  };
  // Closed turn: claim every event row of the turn (unmatched halves keep their
  // audit trail attached to the episode even without a step row).
  store.commitEpisode(input, steps, claimCallIds);
  return true;
}


/**
 * Close stale pending episodes (open-turn probes not assembled within the
 * window). Delegates to the store's transactional implementation.
 */
export function closeStalePendingEpisodes(store: MemoryStore, olderThanMs: number): number {
  return store.closeStalePendingEpisodes(olderThanMs);
}

/** Episode-side consistency repair (startup maintenance): delegates to the store. */
export function repairEpisodeConsistency(store: MemoryStore): void {
  store.repairEpisodeConsistency();
}
