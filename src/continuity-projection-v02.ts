import { createHash } from "node:crypto";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import { isDirectHumanUserSource, isInjectedContextUserSource } from "./compat-v02.js";
import { isDelegatedHeader } from "./capture.js";

/** Structural continuity only: no message bodies, tool arguments/results,
 * provider calls, storage writes, task-success inference, or wake/resume action.
 * Runtime projection registration and handoff jobs are separate owners.
 */
export const CONTINUITY_STATE_VERSION = 1;
export const CONTINUITY_PENDING_LIMIT = 32;
export const CONTINUITY_EXECUTION_LIMIT = 16;
export type ContinuityTurnState = "unknown" | "running" | "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted" | "forked";
export interface ContinuityCallCoordinate {
  /** Hash of native call id; never a provider/model-declared outcome. */
  callKey: string;
  callSeq: number;
}
export interface ContinuityExecution extends ContinuityCallCoordinate {
  resultSeq: number;
  outcome: "returned" | "failed";
  verified: false;
}
export interface ContinuityProjectionState {
  version: typeof CONTINUITY_STATE_VERSION;
  inheritedEventCount: number;
  delegated: boolean;
  lastOwnSeq: number;
  lastHumanSeq: number;
  lastBoundarySeq: number;
  turnState: ContinuityTurnState;
  pendingCalls: ContinuityCallCoordinate[];
  recentExecutions: ContinuityExecution[];
  /** Sticky loss-of-structural-coverage marker; never claim full certainty. */
  coverageIncomplete: boolean;
  unmatchedResults: number;
}

export function initContinuityProjection(header: SessionHeader, inheritedEventCount: number): ContinuityProjectionState {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) throw new Error("invalid inherited continuity boundary");
  return {
    version: CONTINUITY_STATE_VERSION, inheritedEventCount,
    delegated: isDelegatedHeader(header), lastOwnSeq: inheritedEventCount - 1,
    lastHumanSeq: -1, lastBoundarySeq: -1, turnState: "unknown",
    pendingCalls: [], recentExecutions: [], coverageIncomplete: false, unmatchedResults: 0,
  };
}

function callKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value, "utf8").digest("hex") : null;
}

/** Pure, immutable, deterministic native ProjectionDefinition.apply helper.
 * Completed means the native TURN ended, never that the user's TASK succeeded.
 * A tool returned value is structural execution evidence, never verification.
 */
export function applyContinuityProjection(state: ContinuityProjectionState, event: SessionEvent): ContinuityProjectionState {
  if (!Number.isSafeInteger(event.seq) || event.seq < state.inheritedEventCount || event.seq <= state.lastOwnSeq) return state;
  switch (event.type) {
    case "user/message":
      if (state.delegated || !isDirectHumanUserSource(event.data.source) || isInjectedContextUserSource(event.data.source)) return state;
      return { ...state, lastOwnSeq: event.seq, lastHumanSeq: event.seq };
    case "turn/start":
      return { ...state, lastOwnSeq: event.seq, turnState: "running" };
    case "turn/end": {
      const kind = event.data.reason.kind;
      const known = ["completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"].includes(kind);
      return { ...state, lastOwnSeq: event.seq, lastBoundarySeq: event.seq,
        turnState: known ? kind as ContinuityTurnState : "unknown",
        coverageIncomplete: state.coverageIncomplete || !known };
    }
    case "tool/call": {
      const key = callKey(event.data.callId);
      if (!key || state.pendingCalls.some(call => call.callKey === key) || state.recentExecutions.some(call => call.callKey === key)) {
        return { ...state, lastOwnSeq: event.seq, coverageIncomplete: true };
      }
      if (state.pendingCalls.length >= CONTINUITY_PENDING_LIMIT) {
        return { ...state, lastOwnSeq: event.seq, coverageIncomplete: true };
      }
      return { ...state, lastOwnSeq: event.seq,
        pendingCalls: [...state.pendingCalls, { callKey: key, callSeq: event.seq }] };
    }
    case "tool/result": {
      const message = event.data.message;
      const key = callKey(message.toolCallId);
      const sourceKey = message.source?.kind === "tool" ? callKey(message.source.callId) : null;
      const call = key && key === sourceKey ? state.pendingCalls.find(item => item.callKey === key) : undefined;
      if (!call) return { ...state, lastOwnSeq: event.seq, coverageIncomplete: true,
        unmatchedResults: Math.min(1_000_000_000, state.unmatchedResults + 1) };
      const execution: ContinuityExecution = {
        ...call, resultSeq: event.seq,
        outcome: message.isError === true || event.data.error !== undefined ? "failed" : "returned", verified: false,
      };
      return { ...state, lastOwnSeq: event.seq,
        pendingCalls: state.pendingCalls.filter(item => item.callKey !== key),
        recentExecutions: [...state.recentExecutions, execution].slice(-CONTINUITY_EXECUTION_LIMIT),
        coverageIncomplete: state.coverageIncomplete || state.recentExecutions.length >= CONTINUITY_EXECUTION_LIMIT };
    }
    default:
      return state;
  }
}
