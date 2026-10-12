import type { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import type * as Zod from "zod";
import {
  CONTINUITY_STATE_VERSION, CONTINUITY_PENDING_LIMIT, CONTINUITY_EXECUTION_LIMIT,
  initContinuityProjection, applyContinuityProjection,
  type ContinuityProjectionState,
} from "./continuity-projection-v02.js";

export const CONTINUITY_PROJECTION_KEY = "self-improved.continuity";
declare module "@deepseek-ai/dsh-session-projection/types" {
  interface SessionProjectionStateMap {
    "self-improved.continuity": ContinuityProjectionState;
  }
}

/** Resolve only the declared exact Zod4 dependency of this package. No
 * registry fetch, local SDK guessing, or dependency installation occurs.
 */
export async function loadContinuitySchema(): Promise<typeof Zod> {
  const require = createRequire(import.meta.url);
  const declared = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies?.zod;
  const installed = JSON.parse(readFileSync(require.resolve("zod/package.json"), "utf8"));
  if (typeof declared !== "string" || !/^4\.\d+\.\d+$/.test(declared) || installed.name !== "zod" || installed.version !== declared) {
    throw new Error("continuity schema requires the package's exact declared Zod4 dependency");
  }
  return import("zod");
}

/** Build the actual native host-only unit. Zod is supplied explicitly so
 * schema construction and pure folding stay separately testable; installed
 * callers must supply the declared tested Zod4 dependency, not an SDK guess.
 */
export function continuityProjectionDefinition(z: typeof Zod): ProjectionDefinition<typeof CONTINUITY_PROJECTION_KEY> {
  const seq = z.number().int().min(-1);
  const coordinate = z.object({
    callKey: z.string().regex(/^[a-f0-9]{64}$/), callSeq: z.number().int().nonnegative(),
  }).strict();
  const stateSchema = z.object({
    version: z.literal(CONTINUITY_STATE_VERSION), inheritedEventCount: z.number().int().nonnegative(),
    delegated: z.boolean(), lastOwnSeq: seq, lastHumanSeq: seq, lastBoundarySeq: seq,
    turnState: z.enum(["unknown", "running", "completed", "aborted", "blocked", "error", "max-tokens", "interrupted", "forked"]),
    pendingCalls: z.array(coordinate).max(CONTINUITY_PENDING_LIMIT),
    recentExecutions: z.array(coordinate.extend({ resultSeq: z.number().int().nonnegative(),
      outcome: z.enum(["returned", "failed"]), verified: z.literal(false) })).max(CONTINUITY_EXECUTION_LIMIT),
    coverageIncomplete: z.boolean(), unmatchedResults: z.number().int().min(0).max(1_000_000_000),
  }).strict().superRefine((state, ctx) => {
    const bad = (message: string): void => { ctx.addIssue({ code: "custom", message }); };
    if (state.lastOwnSeq < state.inheritedEventCount - 1) bad("owned cursor predates fork boundary");
    for (const value of [state.lastHumanSeq, state.lastBoundarySeq]) {
      if (value !== -1 && (value < state.inheritedEventCount || value > state.lastOwnSeq)) bad("source coordinate outside owned cut");
    }
    if (state.delegated && state.lastHumanSeq !== -1) bad("delegated brief cannot grant human intent");
    const keys = new Set<string>();
    for (const call of [...state.pendingCalls, ...state.recentExecutions]) {
      if (call.callSeq < state.inheritedEventCount || call.callSeq > state.lastOwnSeq) bad("call coordinate outside owned cut");
      if (keys.has(call.callKey)) bad("duplicate call identity in checkpoint");
      keys.add(call.callKey);
    }
    for (const call of state.recentExecutions) {
      if (call.resultSeq <= call.callSeq || call.resultSeq > state.lastOwnSeq) bad("result coordinate outside ordered owned cut");
    }
  });
  return { key: CONTINUITY_PROJECTION_KEY, stateSchema, stateVersion: CONTINUITY_STATE_VERSION,
    init: initContinuityProjection, apply: applyContinuityProjection };
}

/** Effect-owned native registration; deliberately no wire view yet.
 * No session subscription, ad-hoc event, provider, persistent copy or wake.
 */
export function registerContinuityProjection(ctx: Context, z: typeof Zod): () => void {
  return ctx.sessionProjections.register(continuityProjectionDefinition(z));
}

/** Own one registration, not a second session subscriber. Pause removes the
 * native capability/cells; resume reconstructs only through canonical native
 * machinery. Disposed controllers can never be rearmed by a late callback.
 */
export function createContinuityRegistrationController(ctx: Context, z: typeof Zod): {
  sync(enabled: boolean): void;
  dispose(): void;
} {
  let disposed = false;
  let remove: (() => void) | undefined;
  const clear = (): void => { const current = remove; remove = undefined; current?.(); };
  return {
    sync(enabled) {
      if (disposed) return;
      if (!enabled) { clear(); return; }
      if (!remove) remove = registerContinuityProjection(ctx, z);
    },
    dispose() { disposed = true; clear(); },
  };
}
