/**
 * Phase A typed business service (MIGRATION-V0.2.md settings boundary).
 *
 * ONE owner of every memory-browser operation, shared by all callers:
 *
 * - the rc.2 browser UI, through the TYPED remote namespace `selfImproved`
 *   (src/client-remote shared descriptors); the business API refuses
 *   Config-namespace round-trips by design;
 * - the agent tools (src/tools.ts) and the /memory command (src/commands.ts),
 *   which already call the same underlying store operations — this module is
 *   where browser-facing policy lives, not where callers diverge;
 * - the legacy rc.6/rc.8 Config-namespace browser channel (commands.ts
 *   installBrowserChannel) stays fail-closed scaffolding on legacy hosts and
 *   is never the rc.2 transport.
 *
 * Design rules implemented here (each maps to a Phase A acceptance item):
 *
 * - Authorized: mutating operations run only through a TWO-CALL handshake.
 *   `prepareMutation` mints a short-TTL one-shot challenge BOUND to the exact
 *   operation arguments AND the requesting peer id; the follow-up call must
 *   echo that token, and the pending challenge is consumed before execution.
 *   Consequences: a captured payload cannot be replayed for a different or
 *   repeated action, and a token cannot be lifted across peers. This replaces
 *   the legacy design that published a reusable HMAC snapshot token in the
 *   same readable store the actions arrived through.
 * - Cancellable: every remote method takes an optional trailing
 *   `signal: AbortSignal` (the Gateway SRC cancellation parameter); work
 *   observes it between awaits. rc.2 dispatch verified against the installed
 *   runtime (the dsh-api-gateway `prepareInvocation`): when the SRC
 *   descriptor declares `cancellation.parameter === "signal"` the carrier
 *   signal IS pushed as the method's final argument (`args.push(signal)`) AND
 *   the same signal is reachable as `this.ctx.invocation.signal`; for the HTTP
 *   unary route the carrier signal is the connection's `request.signal`
 *   (aborted by client cancel/disconnect), and `invokePrepared` maps any
 *   settle-aborted call to `gateway/cancelled`. LONG aux work must not merely
 *   survive until a post-install re-check: the dry-review pass therefore
 *   RECEIVES this signal and unions it with the consent/shutdown gates, so a
 *   mid-flight carrier cancel stops the aux provider transport via
 *   `GenerateOptions.signal` and a post-cancel "settle" can never be returned.
 * - Presence-only secrets: no method here ever returns a credential value.
 *   Credentials live in Config under `role('secret')` and reach browsers only
 *   as redacted slots (presence flags), so a UI draft can never echo them.
 *
 * Honesty boundaries (documented, not silently claimed away):
 * - The one-shot handshake is a REPLAY/args/peer rebind guard — NOT the
 *   authority itself and NOT an exactly-once durable-write guarantee: a crash
 *   between `consume()` and the store write can still burn a challenge without
 *   durably executing the action, and a two-player race consumes one token and
 *   executes once only while BOTH callers settle with one result and one
 *   rejection. Authorization rests on the Gateway Gateway-permitted caller
 *   (remote peer derived from `this.ctx.invocation`) or the command registry's
 *   own `command/run` provenance lane. Durable at-least-once/idempotent
 *   execution with intent receipts is Phase B/D work.
 * - The destructive-confirmation DIALOG that mints intent is a client concern.
 *   The agent tool path remains the sanctioned automation lane and keeps its
 *   own tool-permission authorization.
 * - Consent revocation mid-flight beyond the one-shot TTL binding (generation
 *   -based invalidation of pending model work) is Phase B/Phase D work.
 */
import { randomBytes } from "node:crypto";
import type { Context } from "@deepseek-ai/cordis";
import { Remote, RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import {
  ActionChallengeLedger,
  browserSnapshot,
} from "./commands.js";
import type { BrowserActionArgs } from "./commands.js";
import type { MemoryStore } from "./storage.js";
import type { ContinuityUiInventory, ContinuityUiOfferNotes } from "./continuity-inventory-ui.js";
import { deleteSkill as deleteSkillByName } from "./evolve.js";

/**
 * Plugin-owned failure codes (typert Remote failure vocabulary is
 * merge-extensible; these codes must be endpoint-grammar safe because the
 * Gateway transmits `details` verbatim.
 */
declare module "@deepseek-ai/dsh-typert-protocol" {
  interface RemoteErrorDetailsMap {
    /** The business surface refused this authorized action (consent state, disabled plugin, replay). */
    "self-improved/rejected": { readonly op?: string };
    /** The addressed row no longer exists. */
    "self-improved/not-found": { readonly id?: string };
  }
}

/** Wire-grammar prefix for this plugin's own failure vocabulary. */
const NS = "self-improved";

/** Bounded memory-browser snapshot: rows are truncated, counts are exact. */
export type MemoryBusinessSnapshot = Record<string, unknown>;

/** Result of one executed mutation. */
export interface MutationResult {
  op: string;
  /** Affected id/name, or null when the target no longer existed. */
  affected: string | null;
}

/**
 * Per-mutation journal policy lane (src/index.ts wiring over the ONE durable
 * journal instance). When installed, every mutating business operation trips
 * the journal's documented generation machinery (MIGRATION-PHASE-B-WORKER-REVIEW
 * finding F1: bumpCancellationGeneration/revokeSessions previously had ZERO
 * production call sites). Each trigger is BOUNDED:
 *
 * - revokeMemoryEvidence accepts exact mutated memory ids. The journal's
 *   durable derivation ledger selects supporting chunk coordinates; sessions,
 *   unrelated pending/future events, and sibling memories remain untouched.
 *   A fact mutation never bumps the global consent generation. Mutation and
 *   support revocation share one SQLite transaction and fail together.
 * - cancelPending is the durable cancellation trigger (purge / consent
 *   revocation): bumps the cancellation generation, cancels every queued job
 *   immediately, and makes every in-flight commit unable to proceed
 *   (stale-cancellation-generation → terminal cancellation, never resurrection).
 */
export interface MemoryJournalMutationPolicy {
  revokeMemoryEvidence?: (
    memoryIds: readonly string[],
    reason: string,
  ) => {
    cancellationGeneration: number;
    sessionsRevoked: number;
    sourcesRevoked: number;
    jobsCancelled: number;
    memoryIdsInvalidated: string[];
  } | null;
  /** Returns the new durable generation, or null when the trigger is absent. */
  cancelPending?: (reason: string) => number | null;
}

/** The one-shot authorization the UI echoes from `prepareMutation`. */
export interface MutationAuthorization {
  token: string;
}

/**
 * Caller context derived on the Host per invocation.
 * - `remote`: a Gateway-dispatched browser call — mutations require the
 *   one-shot args+peer-bound challenge handshake.
 * - `command`: in-process host coders (the /memory command registry, which
 *   owns its own `command/run` provenance and tool-permission authorization
 *   in the agent-tool lane) — mutations execute directly; the registry IS the
 *   authorization record.
 */
export interface BusinessCaller {
  /** Gateway peer id; null marks an in-process host-side caller. */
  peerId: string | null;
  source: "remote" | "command";
}

/** Live delegates kept as getters so volatile settings edits reach each call. */
export interface MemoryBusinessDeps {
  store: MemoryStore;
  /** Provisioning getters (volatile settings live): prefixes/roots and
   *  episode consent must follow hot edits per call, never per mount. */
  skillsPrefix: () => string;
  skillsRoot?: () => string;
  episodeEnabled: () => boolean;
  /** Master/plugin enablement: a disabled plugin serves rows as inert data
   *  inspection only (the plan requires pause to keep stored data visible). */
  enabled: () => boolean;
  /** Debug logging sink (plugin's own hot-switched flag). */
  log?: (...args: unknown[]) => void;
  /** Destructive-op delegate so tests can slice the filesystem away. */
  deleteSkill?: (name: string, skillsRoot: string, prefix: string) => boolean;
  /** Destructive-op delegate for purge (tests slice the store away). The
   *  optional project filter follows the /memory command lane. */
  purgeEpisodes?: (scope: string, projectId?: string, options?: { revokeDerived?: boolean }) => unknown;
  /**
   * Returns the dry-review summary JSON, or null when review is unavailable.
   * Called as `episodeDryReview(signal)`: the REMOTE dryReview call's own
   * carrier cancellation signal (rc.2 Gateway invocation signal) or undefined
   * for the in-process/legacy callers without a carrier. The delegate must
   * BOUND this signal into the real aux model work (consent/shutdown remain
   * the runner's own gates), so mid-flight caller cancellation stops the
   * review instead of letting it run to settlement.
   */
  episodeDryReview?: ((signal: AbortSignal | undefined) => Promise<unknown> | null) | null;
  /** Injectable challenge ledger (tests; production uses a per-process random secret). */
  ledger?: ActionChallengeLedger;
  /** Read-only, body-free native processing inventory. It LISTS offers; it
   *  never authorizes one (the operator door does, at the action). */
  continuityStatus?: (sessionId: string, signal?: AbortSignal) => Promise<ContinuityUiInventory>;
  /** Operator-door Continue: the bounded notes of ONE currently offered
   *  same-project handoff. Read only for an explicitly confirmed action. */
  continuityOfferNotes?: (targetSessionId: string, jobId: string, signal?: AbortSignal) => Promise<ContinuityUiOfferNotes | null>;
  /** Shared journal mutation policy (src/index.ts wiring). Absent = the op
   *  still executes with its documented store semantics and this module emits
   *  a visible warning naming the GAP; it never silently claims the journal
   *  generation was applied (MIGRATION-PHASE-B-POLICY.md honesty rules). */
  journalPolicy?: MemoryJournalMutationPolicy;
}

const MAX_EPISODE_INSPECT_STEPS = 24;
/** Purge scope grammar shared with the /memory command. */
const PURGE_SCOPE_RE = /^\d+$/;
/** Mutating ops that must run through the two-call handshake. */
export const AUTHORIZED_MUTATION_OPS: ReadonlySet<string> = new Set([
  "forget",
  "correct",
  "confirm-correct",
  "deleteSkill",
  "purgeEpisodes",
  "dryReview",
]);

function rejected(message: string, details?: Record<string, unknown>): RemoteError {
  return new RemoteError(`${NS}/rejected`, message, details ?? {});
}
function notFound(message: string, details?: Record<string, unknown>): RemoteError {
  return new RemoteError(`${NS}/not-found`, message, details ?? {});
}
function badRequest(message: string, details?: Record<string, unknown>): RemoteError {
  return new RemoteError("gateway/bad-request", message, details ?? {});
}
function cancelledFallback(error: unknown): RemoteError {
  return new RemoteError("gateway/cancelled", "operation was aborted", {}, { cause: error });
}
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * Bounded per-source forget/correct tombstone (review F1, this lane).
 *
 * Determines the journal binding of ONE memory row from its OWN provenance:
 * only rows the journal extraction lane created (source llm-extract /
 * llm-extract-pasted, provenance derived) with a durable session identity bind
 * to journal evidence. Everything else (user rows, legacy rows, tool-staged
 * supersession candidates that merely inherited a session id, imported rows)
 * has NO journal lineage to tombstone. Never derived by memory ID format or
 * any model-declared scope/permission: the binding is the store's own
 * provenance facts.
 */
function journalEvidenceSessionsOf(store: MemoryStore, id: string): string[] {
  const memory = store.getMemory(id);
  if (!memory?.meta) return [];
  const source = memory.meta.source;
  if (source !== "llm-extract" && source !== "llm-extract-pasted") return [];
  if (memory.meta.provenance !== "derived") return [];
  const sessions = new Set<string>();
  if (memory.meta.sessionId) sessions.add(String(memory.meta.sessionId));
  for (const ev of memory.meta.evidence ?? []) {
    if (ev && typeof ev.sessionId === "string" && ev.sessionId.length > 0) sessions.add(String(ev.sessionId));
  }
  return [...sessions].slice(0, 8);
}

/**
 * Apply the bounded lineage tombstone for a mutating op over `memoryIds`.
 * Order policy:
 * - for a tombstone-protective FORGET the caller tombstones FIRST (pending
 *   journal work dies while the human decision has not yet landed);
 * - for direct corrections the caller commits the human decision FIRST and
 *   then tombstones the OLD row's lineage, so the pre-correction content can
 *   never be re-derived by the journal (latest human decision stays the only
 *   active authority; the derivation source of the corrected fact is spent).
 * `invalidateMemories:false` from the lane: only the caller's own row changes
 * store-side; no sibling of the revoked session is touched, and no store purge
 * of any user data runs through this path.
 */
function tombstoneLineageForMutation(deps: MemoryBusinessDeps, store: MemoryStore, memoryIds: readonly string[], reason: string): void {
  const lane = deps.journalPolicy?.revokeMemoryEvidence;
  const ids = [...new Set(memoryIds)];
  if (!lane) {
    if (ids.some(id => journalEvidenceSessionsOf(store, id).length > 0)) {
      throw new Error("journal evidence revocation unavailable; mutation refused");
    }
    return;
  }
  // Only the journal's authoritative derivation ledger selects coordinates.
  // This runs inside the mutation's SAME SQLite transaction; any failure rolls
  // back both the human decision and its support tombstone.
  const report = lane(ids, reason);
  if (!report) throw new Error("journal evidence revocation unavailable; mutation refused");
  deps.log?.(
    `business policy: lineage tombstone for ${reason}: memories=${ids.length}`,
    `sourcesRevoked=${report.sourcesRevoked} jobsCancelled=${report.jobsCancelled}`,
    `cancelGeneration=${report.cancellationGeneration} (sessions preserved; siblings untouched)`,
  );
}

/** One business operation surface: reads + authorized mutating writes. */
export interface MemoryBusinessApi {
  snapshot(caller: BusinessCaller, signal: AbortSignal | undefined): MemoryBusinessSnapshot;
  continuityStatus(caller: BusinessCaller, sessionId: string, signal?: AbortSignal): Promise<ContinuityUiInventory>;
  /** Operator-door Continue step 1: mint the peer/args-bound one-shot confirm. */
  prepareContinue(caller: BusinessCaller, targetSessionId: string, jobId: string, signal?: AbortSignal): { op: string; token: string; ttlMs: number };
  /** Operator-door Continue step 2: read the bounded notes of one offered handoff. */
  continueSession(caller: BusinessCaller, targetSessionId: string, jobId: string, authorization: MutationAuthorization, signal: AbortSignal | undefined): Promise<ContinuityUiOfferNotes | null>;
  memoryDetail(caller: BusinessCaller, id: string, signal: AbortSignal | undefined): Record<string, unknown>;
  episodeDetail(caller: BusinessCaller, id: string, signal: AbortSignal | undefined): unknown;
  /** Mutating handshake step 1: mint the one-shot, args-and-peer-bound challenge. */
  prepareMutation(caller: BusinessCaller, args: BrowserActionArgs): { op: string; token: string; ttlMs: number };
  /** Mutating handshake step 2 (forget). */
  forget(caller: BusinessCaller, id: string, authorization: MutationAuthorization, signal: AbortSignal | undefined): MutationResult;
  /** Mutating handshake step 2 (correct → supersession candidate). */
  correct(caller: BusinessCaller, id: string, content: string, authorization: MutationAuthorization, signal: AbortSignal | undefined): MutationResult;
  /** Mutating handshake step 2 (confirm a supersession candidate). */
  confirmCorrect(caller: BusinessCaller, newId: string, authorization: MutationAuthorization, signal: AbortSignal | undefined): MutationResult;
  /** Mutating handshake step 2 (delete a plugin-synthesized skill). */
  deleteSkillRemoval(caller: BusinessCaller, name: string, authorization: MutationAuthorization, signal: AbortSignal | undefined): MutationResult;
  /** Mutating handshake step 2 (purge episodes + revoke linked derived learning; scope = "all" | days).
   *  `projectId` (legacy project key) is the /memory command lane's optional
   *  --project filter; the browser remote never passes it (its surface stays
   *  unchanged by design), a project-scoped purge is command-lane-only. */
  purgeEpisodes(caller: BusinessCaller, scope: string, authorization: MutationAuthorization, signal: AbortSignal | undefined, projectId?: string): unknown;
  /** Cancellable dry-run review (persists nothing); the summary returns directly. */
  dryReview(caller: BusinessCaller, authorization: MutationAuthorization, signal: AbortSignal | undefined): Promise<unknown>;
}

/**
 * Validate arbitrary browser-action input before anything trusts it.
 * `content` is the only unbounded-ish field and is capped for the wire.
 */
export function validateMutationArgs(args: BrowserActionArgs): void {
  if (typeof args.op !== "string" || args.op.length === 0 || args.op.length > 40 || !AUTHORIZED_MUTATION_OPS.has(args.op)) {
    throw badRequest("unauthorized or malformed action op");
  }
  for (const key of ["id", "name", "newId"] as const) {
    const value = args[key];
    if (value !== undefined && (typeof value !== "string" || value.length === 0 || value.length > 512)) {
      throw badRequest(`action argument ${key} is out of bounds`);
    }
  }
  if (args.content !== undefined && (typeof args.content !== "string" || args.content.length === 0 || args.content.length > 200_000)) {
    throw badRequest("action content is out of bounds");
  }
}

/**
 * Create the shared business implementation. Callers own the instance; the
 * remote service delegates into it so adapter code stays thin.
 */
export function createMemoryBusiness(deps: MemoryBusinessDeps): MemoryBusinessApi {
  const log = deps.log ?? (() => {});
  const ledger = deps.ledger ?? new ActionChallengeLedger(randomChallengeSecret());

  const assertInProcessOrPeer = (caller: BusinessCaller): void => {
    if (typeof caller?.peerId !== "string" && caller?.peerId !== null) {
      throw badRequest("calls must carry a caller context");
    }
  };
  // NOTE — deliberately NO enabled gate here (MIGRATION-V0.2.md: "pause must
  // not make stored data inaccessible"; coordinator round 51): the master
  // switch (`enabled: false`) means remember/learning work stops — it must not
  // hide stored-data reads, corrections, forgetting, or retention actions.
  // Only NEW capture/model work is consent-gated (episodeLearning fields and
  // the dryReview runner refusal below). A loader-row disable unloads the
  // service row entirely — a different, host-owned boundary.
  const assertEpisodeReveal = (): void => {
    // Row-level episode reveal stays consent-gated (counts never leave).
    if (deps.episodeEnabled() !== true) {
      throw rejected("episode learning is disabled; stored episode rows stay local until consent is armed");
    }
  };

  const assertNotAborted = (signal: AbortSignal | undefined): void => {
    if (aborted(signal)) throw cancelledFallback(signal?.reason);
  };

  const requireAuthorized = (caller: BusinessCaller, args: BrowserActionArgs, authorization: MutationAuthorization, signal: AbortSignal | undefined): void => {
    assertNotAborted(signal);
    if (caller?.source === "command") {
      // The command lane is authorized by the /memory command registry itself
      // (its `command/run` session event is the human-intent record); the
      // handshake is the BROWSER lane's guard, not this lane's.
      return;
    }
    if (!caller.peerId) throw rejected("mutations are not authorized for in-process callers through the remote surface");
    if (!authorization || typeof authorization.token !== "string" || authorization.token.length === 0) {
      throw badRequest("a mutation requires the one-shot token minted by prepareMutation");
    }
    if (!ledger.consume(args, authorization.token, caller.peerId)) {
      throw rejected("authorization expired, was replayed, or failed the exact-args/peer binding; re-stage the action");
    }
  };
  const commandCaller = (): BusinessCaller => ({ peerId: null, source: "command" });

  /**
   * CONTINUE IS DOOR-ONLY.
   *
   * DSH labels a model-authored delegation prompt with the same
   * `{kind:'user', rpcId}` source as a human prompt, so NO message marker can
   * authorize resuming work. The browser door can: a Gateway-dispatched call
   * carries a peer, and the operator's confirmation is a second, deliberate
   * round trip bound to that peer AND these exact arguments.
   *
   * In-process callers — the agent tool lane, other plugins, the /memory
   * command lane — carry no peer and are refused here even though they are
   * trusted code, because "trusted code" is precisely what cannot be told
   * apart from a model on the message path.
   *
   * MEASURED BOUNDARY, not a claim: this is not an authentication boundary.
   * The installed rc.2 runtime admits EVERY loopback `/api` request as the same
   * OperatorPeer (its browser-authentication call is patched off in this
   * installation — see MIGRATION-PROGRESS round 2 of the operator-door work and
   * scripts/test-v02-continuity-door-mounted.mjs, which asserts the running
   * host's actual behaviour). So a process that can open a loopback connection
   * reaches this door. It stops the agent's ordinary paths (tools, message-
   * driven plugins, in-process callers); it does not stop a shell. A
   * Host-issued authenticated receipt is the real fix, and it cannot be built
   * in this plugin.
   */
  const assertContinueArgs = (targetSessionId: unknown, jobId: unknown): { target: string; job: string } => {
    if (typeof targetSessionId !== "string" || targetSessionId.length === 0 || targetSessionId.length > 512 || targetSessionId.includes("\0")) {
      throw badRequest("target session identity is required");
    }
    if (typeof jobId !== "string" || jobId.length === 0 || jobId.length > 512 || jobId.includes("\0")) {
      throw badRequest("handoff job identity is required");
    }
    return { target: targetSessionId, job: jobId };
  };
  // Reuses the shared challenge ledger's exact-args fingerprint ("id" = handoff
  // job, "newId" = target session), so a confirmation minted for one offer can
  // never authorize a different one.
  const continueArgs = (target: string, job: string): BrowserActionArgs => ({ op: "continue", id: job, newId: target });
  const requireOperatorDoor = (caller: BusinessCaller, args: BrowserActionArgs, authorization: MutationAuthorization, signal: AbortSignal | undefined): void => {
    assertNotAborted(signal);
    if (caller?.source !== "remote" || !caller.peerId) {
      throw rejected("Continue is an operator action: it requires the browser remote door, not an in-process caller");
    }
    if (!authorization || typeof authorization.token !== "string" || authorization.token.length === 0) {
      throw badRequest("Continue requires the one-shot token minted by prepareContinue");
    }
    if (!ledger.consume(args, authorization.token, caller.peerId)) {
      throw rejected("Continue confirmation expired, was replayed, or failed the exact-args/peer binding; re-stage the action");
    }
  };

  return {
    async continuityStatus(caller, sessionId, signal) {
      assertInProcessOrPeer(caller);
      if (caller.source === "remote" && (!caller.peerId || typeof caller.peerId !== "string")) throw rejected("authenticated browser peer required");
      assertNotAborted(signal);
      if (typeof sessionId !== "string" || !sessionId || sessionId.length > 256 || sessionId.includes("\0")) throw badRequest("native session identity is required");
      if (!deps.continuityStatus) return { availability: "unavailable", canContinue: false, reason: "Native continuity inspection is unavailable.", rows: [], offers: [] };
      const value = await deps.continuityStatus(sessionId, signal);
      assertNotAborted(signal);
      return value;
    },
    async continueSession(caller, targetSessionId, jobId, authorization, signal) {
      assertInProcessOrPeer(caller);
      const { target, job } = assertContinueArgs(targetSessionId, jobId);
      requireOperatorDoor(caller, continueArgs(target, job), authorization, signal);
      if (!deps.continuityOfferNotes) return null;
      const notes = await deps.continuityOfferNotes(target, job, signal);
      assertNotAborted(signal);
      return notes;
    },
    prepareContinue(caller, targetSessionId, jobId, signal) {
      assertInProcessOrPeer(caller);
      const { target, job } = assertContinueArgs(targetSessionId, jobId);
      assertNotAborted(signal);
      if (caller.source !== "remote" || !caller.peerId) {
        throw rejected("Continue is an operator action: it requires the browser remote door, not an in-process caller");
      }
      const staged = ledger.prepare(continueArgs(target, job), caller.peerId);
      log("business: staged Continue confirm for peer", staged.token.slice(0, 6));
      return { op: "continue", token: staged.token, ttlMs: ledger.ttlMs };
    },
    snapshot(caller, signal) {
      assertInProcessOrPeer(caller);
      assertNotAborted(signal);
      try {
        return browserSnapshot(deps.store, deps.skillsPrefix(), deps.skillsRoot?.() ?? "", deps.episodeEnabled() === true);
      } catch (error) {
        throw rejected(`memory snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    memoryDetail(caller, id, signal) {
      assertInProcessOrPeer(caller);
      assertNotAborted(signal);
      if (typeof id !== "string" || id.length === 0 || id.length > 512) throw badRequest("memory id is required");
      const memory = deps.store.getMemory(id);
      if (!memory) throw notFound(`memory not found: ${id}`);
      return JSON.parse(JSON.stringify({ ...memory })) as Record<string, unknown>;
    },
    episodeDetail(caller, id, signal) {
      assertInProcessOrPeer(caller);
      assertNotAborted(signal);
      assertEpisodeReveal();
      if (typeof id !== "string" || id.length === 0 || id.length > 512) throw badRequest("episode id is required");
      const episode = deps.store.getEpisode(id);
      if (!episode) throw notFound(`episode not found: ${id}`);
      const steps = deps.store
        .getEpisodeSteps(id)
        .slice(0, MAX_EPISODE_INSPECT_STEPS)
        .map((s) => ({
          ordinal: s.ordinal,
          callId: s.callId,
          toolName: s.toolName,
          argumentsRedacted: s.argumentsRedacted.slice(0, 800),
          resultExcerpt: s.resultExcerpt.slice(0, 800),
          isError: s.isError,
          errorName: s.errorName,
          errorCode: s.errorCode,
          argsTruncated: s.argsTruncated,
          resultTruncated: s.resultTruncated,
        }));
      return {
        id: episode.id,
        sessionId: episode.sessionId,
        projectId: episode.projectId,
        turn: episode.turn,
        status: episode.status,
        delegated: episode.delegated,
        startedAt: episode.startedAt,
        endedAt: episode.endedAt,
        updatedAt: episode.updatedAt,
        summary: episode.summary,
        confidence: episode.confidence,
        fingerprint: episode.fingerprint,
        rejectReason: episode.rejectReason,
        steps,
      };
    },
    prepareMutation(caller, args) {
      assertInProcessOrPeer(caller);
      // No enabled gate: a paused plugin still stages authorized corrections
      // (forget/correct/purge stays usable while remember is off).
      validateMutationArgs(args);
      if (caller.source === "command") return { op: args.op, token: "", ttlMs: 0 }; // no stage needed
      if (!caller.peerId) throw rejected("mutations are not authorized for in-process callers through the remote surface");
      // One-shot: re-preparing the SAME action never reproduces an old token
      // (fresh nonce per preparation); consumed atomically before execution.
      const staged = ledger.prepare(args, caller.peerId);
      log("business: staged", args.op, "challenge for peer", staged.token.slice(0, 6));
      return { op: args.op, token: staged.token, ttlMs: ledger.ttlMs };
    },
    forget(caller, id, authorization, signal) {
      assertInProcessOrPeer(caller);
      requireAuthorized(caller, { op: "forget", id }, authorization, signal);
      if (typeof id !== "string" || id.length === 0 || id.length > 512) throw badRequest("memory id is required");
      // BOUNDED per-source tombstone BEFORE the human decision lands: the
      // forgotten fact's own journal evidence coordinates (durable ledger,
      // not the entire session) are revoked so no in-flight journal job
      // can re-derive the fact and resurrect it — review F1. invalidateMemories
      // stays false: facts of the same session that were NOT forgotten are
      // never invalidated, and other sessions/projects are untouched.
      const ok = deps.store.runInImmediateTransaction(() => {
        tombstoneLineageForMutation(deps, deps.store, [id], `forget:${id.slice(0, 8)}`);
        return deps.store.forgetMemory(id);
      });
      log("business: forget", id.slice(0, 8), ok ? "ok" : "not found");
      return { op: "forget", affected: ok ? id : null };
    },
    correct(caller, id, content, authorization, signal) {
      assertInProcessOrPeer(caller);
      requireAuthorized(caller, { op: "correct", id, content }, authorization, signal);
      if (typeof id !== "string" || id.length === 0 || id.length > 512) throw badRequest("memory id is required");
      if (typeof content !== "string" || content.trim().length === 0) throw badRequest("correction content is required");
      if (content.length > 200_000) throw badRequest("correction content is out of bounds");
      const candidate = deps.store.runInImmediateTransaction(() => {
      const old = deps.store.getMemory(id);
      if (!old) throw notFound(`memory not found: ${id}`);
      const candidate = deps.store.insertMemory(
        { kind: old.kind, content, importance: old.importance, supersedes: old.id },
        {
          // Direct human correction surfaces on the browser with a one-shot
          // authored challenge — trusted provenance, scope inherited so
          // project-bound corrections stay in their original scope.
          provenance: "user",
          source: "user-direct",
          scope: old.meta?.scope ?? "global",
          projectId: old.meta?.projectId ?? null,
          sessionId: old.meta?.sessionId ?? null,
          confidence: 0.9,
        },
      );
      deps.store.setMemoryStatus(id, "corrected");
      // Human-authoritative correction preserves the LATEST decision: the
      // corrected (old) row's journal lineage is tombstoned here so the
      // journal can never re-derive the pre-correction content as fresh
      // active evidence; the derived support of the old fact is spent with
      // it. Bounded exactly as the forget tombstone (no sibling invalidation,
      // no blanket revoke of any session's data).
      tombstoneLineageForMutation(deps, deps.store, [id], `correct:${id.slice(0, 8)}`);
      return candidate;
      });
      log("business: correct", id.slice(0, 8), "->", candidate.id.slice(0, 8));
      return { op: "correct", affected: candidate.id };
    },
    confirmCorrect(caller, newId, authorization, signal) {
      assertInProcessOrPeer(caller);
      requireAuthorized(caller, { op: "confirm-correct", newId }, authorization, signal);
      if (typeof newId !== "string" || newId.length === 0 || newId.length > 512) throw badRequest("candidate id is required");
      const candidate = deps.store.runInImmediateTransaction(() => {
      const candidate = deps.store.getMemory(newId);
      if (!candidate?.supersedes) throw notFound(`supersession candidate not found: ${newId}`);
      deps.store.updateMeta(candidate.id, { provenance: "user", source: "user-direct", confidence: 0.9 });
      deps.store.setMemoryStatus(candidate.supersedes, "corrected");
      // Same tombstone rule as `correct`: promote the human decision, then
      // spend the superseded row's journal lineage (no future re-derivation
      // of the pre-correction content; bounded to its own evidence sessions).
      tombstoneLineageForMutation(deps, deps.store, [candidate.supersedes], `confirm-correct:${candidate.id.slice(0, 8)}`);
      return candidate;
      });
      log("business: confirm-correct", candidate.id.slice(0, 8));
      return { op: "confirm-correct", affected: candidate.id };
    },
    deleteSkillRemoval(caller, name, authorization, signal) {
      assertInProcessOrPeer(caller);
      requireAuthorized(caller, { op: "deleteSkill", name }, authorization, signal);
      if (typeof name !== "string" || name.length === 0 || name.length > 200) throw badRequest("skill name is required");
      const removed = deps.deleteSkill
        ? deps.deleteSkill(name, deps.skillsRoot?.() ?? "", deps.skillsPrefix())
        : deleteSkillByName(name, deps.skillsRoot?.() ?? "", deps.skillsPrefix());
      log("business: deleteSkill", name, removed ? "removed" : "not removed");
      return { op: "deleteSkill", affected: removed ? name : null };
    },
    purgeEpisodes(caller, scope, authorization, signal, projectId) {
      assertInProcessOrPeer(caller);
      requireAuthorized(caller, { op: "purgeEpisodes", id: scope }, authorization, signal);
      if (typeof scope !== "string" || !scope || (scope !== "all" && !PURGE_SCOPE_RE.test(scope))) {
        throw badRequest("purge scope must be 'all' or a day count");
      }
      if (projectId !== undefined && (typeof projectId !== "string" || projectId.length === 0 || projectId.length > 256)) {
        throw badRequest("purge projectId filter is out of bounds");
      }
      // Purge adds a durable revocation generation BEFORE any deletion
      // (MIGRATION-V0.2.md "purge adds a durable revocation generation so an
      // in-flight job cannot recreate forgotten material"): queued journal
      // work is cancelled and in-flight commits become terminally blocked.
      // CANCELLATION ONLY — never a blanket journal revoke: retained sources
      // of unrelated sessions/projects stay intact (pending sources replan at
      // the next recovery under the new generation, per the journal's own
      // cancel-without-revocation contract; a SOURCE-only purge is the
      // bounded forget tombstone, not this op).
      try {
        const gen = deps.journalPolicy?.cancelPending?.(
          `purge:episodes:${projectId ? `${projectId.slice(0, 64)}@` : ""}${scope}`,
        );
        if (gen !== undefined && gen !== null) {
          log("business: purge policy", "journal cancellation generation", gen);
        }
      } catch (error) {
        // Without the bump an in-flight commit could recreate material the
        // operator intends to purge — refuse the purge rather than run it
        // unguarded (fail closed, never a silent fallback).
        throw rejected("purge policy precondition failed: journal cancellation bump unavailable — pending in-flight work cannot be blocked safely", { op: "purgeEpisodes", cause: String(error) });
      }
      // "all" maps to a FUTURE cutoff: purgeEpisodes treats absent filters as
      // delete-nothing, so an explicit future oldestTs is the only safe
      // everything-purge (same rule as the /memory command).
      const olderThanTs =
        scope === "all" ? Date.now() + 60_000 : Date.now() - Number(scope) * 86_400_000;
      const res = deps.purgeEpisodes
        ? deps.purgeEpisodes(scope, projectId, { revokeDerived: true })
        : deps.store.purgeEpisodes({ olderThanTs, projectId, revokeDerived: true });
      log("business: purgeEpisodes", scope, JSON.stringify(res));
      return res;
    },
    async dryReview(caller, authorization, signal) {
      assertInProcessOrPeer(caller);
      requireAuthorized(caller, { op: "dryReview" }, authorization, signal);
      assertEpisodeReveal();
      // FORWARD the per-call carrier cancellation into the runner (index.ts
      // unions it with consent/shutdown/downstream per-call timeouts, so the
      // abort reaches the actual aux GenerateOptions.signal mid-flight):
      // without it, caller cancellation could only stop the call BEFORE or
      // AFTER the whole run settled — a Gateway-observed cancel could not stop
      // the provider transport while it was streaming.
      const stage = deps.episodeDryReview?.(signal);
      if (!stage) throw rejected("episode review is unavailable (disabled or scheduled runs only)");
      assertNotAborted(signal);
      // The review runner carries the same signal internally; the remaining
      // checks harden the wire boundary: refused before start, and a call
      // whose carrier was cancelled while work ran can never RETURN a
      // post-cancel settle (the aux transport abort propagates out of the
      // await; anything that raced to completion here is discarded instead).
      const summary = await Promise.resolve(stage);
      assertNotAborted(signal);
      return summary ?? {};
    },
  };
}

/**
 * Mint the per-process secret for challenge HMACs (mirrors commands.ts;
 * kept distinct from the legacy channel's secrets so replacing one never
 * affects the other's outstanding credentials).
 */
function randomChallengeSecret(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Derive the rc.2 remote peer id. `ctx.invocation` is set ONLY while a
 * Gateway-dispatched remote call runs its receiver context (see
 * dsh-typert-protocol: provideInvocationAccessor), so this is the one
 * boundary between "invoked as a remote peer" and "in-process caller".
 */
export function remotePeerId(ctx: Context): string | null {
  const invocation = (ctx as { invocation?: { peer?: { id?: unknown } } }).invocation;
  const id = invocation?.peer?.id;
  if (typeof id === "string" || typeof id === "number") return String(id);
  return null;
}

/**
 * The rc.2 browser channel: one Typert Service wired into the Host gateway
 * by SOURCE markers (@Remote) and an explicit typertRemote binding. All
 * public methods are unary, take the optional trailing `signal` cancellation
 * parameter, and delegate into the shared business implementation.
 */
export class MemoryBusinessService extends TypertRemoteService {
  private readonly business: MemoryBusinessApi;

  constructor(ctx: Context, business: MemoryBusinessApi) {
    super(ctx, "selfImprovedMemoryUi", { namespace: "selfImproved" });
    this.business = business;
    // The Service base registered itself on ctx.fiber via reflect.provide,
    // so its registration is already disposed with the plugin fiber (config
    // restart or disable).
  }

  private caller(): BusinessCaller {
    return { peerId: remotePeerId(this.ctx), source: "remote" };
  }

  @Remote
  async continuityStatus(targetSessionId: string, signal?: AbortSignal): Promise<ContinuityUiInventory> {
    return this.business.continuityStatus(this.caller(), targetSessionId, signal);
  }

  @Remote
  async prepareContinue(targetSessionId: string, jobId: string, signal?: AbortSignal): Promise<{ op: string; token: string; ttlMs: number }> {
    return this.business.prepareContinue(this.caller(), targetSessionId, jobId, signal);
  }

  @Remote
  async continueSession(targetSessionId: string, jobId: string, authorization: MutationAuthorization, signal?: AbortSignal): Promise<ContinuityUiOfferNotes | null> {
    return this.business.continueSession(this.caller(), targetSessionId, jobId, authorization, signal);
  }

  @Remote
  async snapshot(signal?: AbortSignal): Promise<MemoryBusinessSnapshot> {
    return this.business.snapshot(this.caller(), signal);
  }

  @Remote
  async memoryDetail(id: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.business.memoryDetail(this.caller(), id, signal);
  }

  @Remote
  async episodeDetail(id: string, signal?: AbortSignal): Promise<unknown> {
    return this.business.episodeDetail(this.caller(), id, signal);
  }

  @Remote
  async prepareMutation(args: BrowserActionArgs): Promise<{ op: string; token: string; ttlMs: number }> {
    return this.business.prepareMutation(this.caller(), args);
  }

  @Remote
  async forget(id: string, authorization: MutationAuthorization, signal?: AbortSignal): Promise<MutationResult> {
    return this.business.forget(this.caller(), id, authorization, signal);
  }

  @Remote
  async correct(id: string, content: string, authorization: MutationAuthorization, signal?: AbortSignal): Promise<MutationResult> {
    return this.business.correct(this.caller(), id, content, authorization, signal);
  }

  @Remote
  async confirmCorrect(newId: string, authorization: MutationAuthorization, signal?: AbortSignal): Promise<MutationResult> {
    return this.business.confirmCorrect(this.caller(), newId, authorization, signal);
  }

  @Remote
  async deleteSkillRemoval(name: string, authorization: MutationAuthorization, signal?: AbortSignal): Promise<MutationResult> {
    return this.business.deleteSkillRemoval(this.caller(), name, authorization, signal);
  }

  @Remote
  async purgeEpisodes(scope: string, authorization: MutationAuthorization, signal?: AbortSignal): Promise<unknown> {
    return this.business.purgeEpisodes(this.caller(), scope, authorization, signal);
  }

  @Remote
  async dryReview(authorization: MutationAuthorization, signal?: AbortSignal): Promise<unknown> {
    return this.business.dryReview(this.caller(), authorization, signal);
  }
}

/**
 * Register the service with explicit effect ownership. The service runs
 * inside its own child plugin fiber on the plugin's tree: unloading the
 * plugin (config restart or disable) disposes the child fiber, which unmaps
 * the reflect.provide registration; the outer explict disposer supports
 * synchronous dispose in tests too.
 */
export function registerMemoryBusinessRemote(
  ctx: Context,
  deps: MemoryBusinessDeps,
  /** Shared business instance (commands/browser reuse; default constructs one). */
  shared?: MemoryBusinessApi,
): () => void {
  const business = shared ?? createMemoryBusiness(deps);
  return ctx.effect(() => {
    const fiber = ctx.plugin({
      name: "selfImprovedMemoryUi",
      apply: (child) => {
        new MemoryBusinessService(child, business);
      },
    });
    return () => {
      void Promise.resolve(fiber.dispose()).catch(() => { /* owned by the plugin unload too */ });
    };
  }, "memory business remote (selfImproved namespace)");
}
