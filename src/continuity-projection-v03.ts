import { createHash } from "node:crypto";
import type { SessionEvent, SessionHeader } from "@deepseek-ai/dsh-session";
import type * as Zod from "zod";
import { isDirectHumanUserSource, isInjectedContextUserSource } from "./compat-v02.js";

/** State v2 is deliberately isolated from the currently registered v1 fold. */
export const CONTINUITY_STATE_VERSION_V03 = 2;
export const CONTINUITY_V03_PENDING_LIMIT = 32;
export const CONTINUITY_V03_EXECUTION_LIMIT = 16;
export type ContinuityV03LineageKind = "root" | "fork-candidate" | "denied";
export type ContinuityV03TurnState = "unknown" | "running" | "completed" | "aborted" | "blocked" | "error" | "max-tokens" | "interrupted" | "forked";
export interface ContinuityV03CallCoordinate { callKey: string; callSeq: number }
export interface ContinuityV03Execution extends ContinuityV03CallCoordinate {
  resultSeq: number;
  outcome: "returned" | "failed";
  verified: false;
}
export interface ContinuityProjectionStateV03 {
  version: typeof CONTINUITY_STATE_VERSION_V03;
  inheritedEventCount: number;
  /** Structural only. A fork-candidate is NOT ancestry-verified or admitted. */
  lineageKind: ContinuityV03LineageKind;
  lastOwnSeq: number;
  lastHumanSeq: number;
  lastBoundarySeq: number;
  turnState: ContinuityV03TurnState;
  pendingCalls: ContinuityV03CallCoordinate[];
  recentExecutions: ContinuityV03Execution[];
  coverageIncomplete: boolean;
  unmatchedResults: number;
}

const ZERO = String.fromCharCode(0);
const HASH = /^[a-f0-9]{64}$/;
const KNOWN_TURN_STATES = ["unknown", "running", "completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"] as const;

/**
 * Child-header-only classification is intentionally conservative: an explicit
 * origin is not trusted here, and a native parent-linked seed is only a
 * fork-candidate. The async ancestry owner must verify the full chain before
 * any admission or durable job creation.
 */
export function classifyContinuityV03Lineage(header: SessionHeader, inheritedEventCount: number): ContinuityV03LineageKind {
  if (typeof header !== "object" || header === null || typeof header.id !== "string" || header.id.length < 1
    || header.id.length > 256 || header.id.includes(ZERO) || typeof header.isSeeded !== "boolean"
    || !Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) return "denied";
  if (Object.hasOwn(header, "origin")) return "denied";
  if (Object.hasOwn(header, "delegationDepth")
    && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth !== 0)) return "denied";

  const hasParent = Object.hasOwn(header, "parentSession");
  if (hasParent && (typeof header.parentSession !== "string" || header.parentSession.length < 1
    || header.parentSession.length > 256 || header.parentSession.includes(ZERO) || header.parentSession === header.id)) return "denied";
  if (!hasParent && !header.isSeeded && inheritedEventCount === 0) return "root";
  if (hasParent && header.isSeeded) return "fork-candidate";
  return "denied";
}

export function initContinuityProjectionV03(header: SessionHeader, inheritedEventCount: number): ContinuityProjectionStateV03 {
  if (!Number.isSafeInteger(inheritedEventCount) || inheritedEventCount < 0) throw new Error("invalid inherited continuity boundary");
  return {
    version: CONTINUITY_STATE_VERSION_V03,
    inheritedEventCount,
    lineageKind: classifyContinuityV03Lineage(header, inheritedEventCount),
    lastOwnSeq: inheritedEventCount - 1,
    lastHumanSeq: -1,
    lastBoundarySeq: -1,
    turnState: "unknown",
    pendingCalls: [],
    recentExecutions: [],
    coverageIncomplete: false,
    unmatchedResults: 0,
  };
}

function callKey(value: unknown): string | null {
  return typeof value === "string" && value.length > 0
    ? createHash("sha256").update(value, "utf8").digest("hex") : null;
}

/** Pure structural fold; candidate fork evidence is never an admission token. */
export function applyContinuityProjectionV03(
  state: ContinuityProjectionStateV03,
  event: SessionEvent,
): ContinuityProjectionStateV03 {
  if (state.lineageKind === "denied" || !Number.isSafeInteger(event.seq)
    || event.seq < state.inheritedEventCount || event.seq <= state.lastOwnSeq) return state;
  switch (event.type) {
    case "user/message":
      if (!isDirectHumanUserSource(event.data.source) || isInjectedContextUserSource(event.data.source)) return state;
      return { ...state, lastOwnSeq: event.seq, lastHumanSeq: event.seq };
    case "turn/start":
      return { ...state, lastOwnSeq: event.seq, turnState: "running" };
    case "turn/end": {
      const kind = event.data.reason.kind;
      const known = (KNOWN_TURN_STATES as readonly string[]).includes(kind);
      return {
        ...state,
        lastOwnSeq: event.seq,
        lastBoundarySeq: event.seq,
        turnState: known ? kind as ContinuityV03TurnState : "unknown",
        coverageIncomplete: state.coverageIncomplete || !known,
      };
    }
    case "tool/call": {
      const key = callKey(event.data.callId);
      if (!key || state.pendingCalls.some(call => call.callKey === key)
        || state.recentExecutions.some(call => call.callKey === key)) {
        return { ...state, lastOwnSeq: event.seq, coverageIncomplete: true };
      }
      if (state.pendingCalls.length >= CONTINUITY_V03_PENDING_LIMIT) {
        return { ...state, lastOwnSeq: event.seq, coverageIncomplete: true };
      }
      return { ...state, lastOwnSeq: event.seq, pendingCalls: [...state.pendingCalls, { callKey: key, callSeq: event.seq }] };
    }
    case "tool/result": {
      const message = event.data.message;
      const key = callKey(message.toolCallId);
      const sourceKey = message.source?.kind === "tool" ? callKey(message.source.callId) : null;
      const call = key && key === sourceKey ? state.pendingCalls.find(item => item.callKey === key) : undefined;
      if (!call) return {
        ...state,
        lastOwnSeq: event.seq,
        coverageIncomplete: true,
        unmatchedResults: Math.min(1_000_000_000, state.unmatchedResults + 1),
      };
      const execution: ContinuityV03Execution = {
        ...call,
        resultSeq: event.seq,
        outcome: message.isError === true || event.data.error !== undefined ? "failed" : "returned",
        verified: false,
      };
      return {
        ...state,
        lastOwnSeq: event.seq,
        pendingCalls: state.pendingCalls.filter(item => item.callKey !== key),
        recentExecutions: [...state.recentExecutions, execution].slice(-CONTINUITY_V03_EXECUTION_LIMIT),
        coverageIncomplete: state.coverageIncomplete || state.recentExecutions.length >= CONTINUITY_V03_EXECUTION_LIMIT,
      };
    }
    default:
      return state;
  }
}

/** Strict state-v2 validator; does not verify native lineage or source truth. */
export function continuityProjectionStateSchemaV03(z: typeof Zod): Zod.ZodType<ContinuityProjectionStateV03> {
  const safeInt = z.number().int().refine(Number.isSafeInteger);
  const seq = safeInt.min(-1);
  const coordinate = z.object({ callKey: z.string().regex(HASH), callSeq: safeInt.min(0) }).strict();
  return z.object({
    version: z.literal(CONTINUITY_STATE_VERSION_V03),
    inheritedEventCount: safeInt.min(0),
    lineageKind: z.enum(["root", "fork-candidate", "denied"]),
    lastOwnSeq: seq,
    lastHumanSeq: seq,
    lastBoundarySeq: seq,
    turnState: z.enum(KNOWN_TURN_STATES),
    pendingCalls: z.array(coordinate).max(CONTINUITY_V03_PENDING_LIMIT),
    recentExecutions: z.array(coordinate.extend({
      resultSeq: safeInt.min(0),
      outcome: z.enum(["returned", "failed"]),
      verified: z.literal(false),
    })).max(CONTINUITY_V03_EXECUTION_LIMIT),
    coverageIncomplete: z.boolean(),
    unmatchedResults: safeInt.min(0).max(1_000_000_000),
  }).strict().superRefine((state, ctx) => {
    const bad = (message: string): void => { ctx.addIssue({ code: "custom", message }); };
    if (state.lastOwnSeq < state.inheritedEventCount - 1) bad("owned cursor predates fork boundary");
    if (state.lineageKind === "root" && state.inheritedEventCount !== 0) bad("root lineage has inherited events");
    if (state.lineageKind === "denied" && (state.lastHumanSeq !== -1
      || state.lastOwnSeq !== state.inheritedEventCount - 1 || state.lastBoundarySeq !== -1
      || state.turnState !== "unknown" || state.pendingCalls.length !== 0 || state.recentExecutions.length !== 0
      || state.coverageIncomplete || state.unmatchedResults !== 0)) {
      bad("denied lineage cannot retain folded evidence");
    }
    for (const value of [state.lastHumanSeq, state.lastBoundarySeq]) {
      if (value !== -1 && (value < state.inheritedEventCount || value > state.lastOwnSeq)) bad("source coordinate outside owned cut");
    }
    const keys = new Set<string>();
    for (const call of [...state.pendingCalls, ...state.recentExecutions]) {
      if (call.callSeq < state.inheritedEventCount || call.callSeq > state.lastOwnSeq) bad("call coordinate outside owned cut");
      if (keys.has(call.callKey)) bad("duplicate call identity in checkpoint");
      keys.add(call.callKey);
    }
    for (const execution of state.recentExecutions) {
      if (execution.resultSeq <= execution.callSeq || execution.resultSeq > state.lastOwnSeq) bad("result coordinate outside ordered owned cut");
    }
  });
}
