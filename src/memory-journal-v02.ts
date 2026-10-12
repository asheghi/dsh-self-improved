/**
 * Phase B durable core (MIGRATION-V0.2.md): SQLite dedup/minimized-source
 * journal with consumed-range jobs.
 *
 * OWNERSHIP AND POSITIONING
 * - This module owns enqueue/claim/commit durability for the memory lanes plus
 *   the journal support graph / revocation metadata. The authoritative review,
 *   correction and consent facts stay in MemoryStore; this module never
 *   derives them — it links derived candidates back to their exact source
 *   coordinates through `journal_derived`.
 * - The native session log is the canonical history and is untouched. The
 *   journal keeps NO second raw transcript archive: every retained source
 *   payload is minimized (redacted + bounded through src/redact.ts) BEFORE any
 *   SQLite write, and only the minimized text persists.
 * - Everything runs on the MemoryStore's single SQLite connection
 *   (`MemoryStore.runInImmediateTransaction` + `MemoryStore.getJournalSqlite`),
 *   so candidate inserts, consumed-range acks, `getMemoryRevision()` bumps and
 *   generation counters serialize as ONE writer. There is no second connection
 *   and no cross-connection transaction by construction.
 *
 * DOCUMENTED GENERATION CONTRACT (exact semantics)
 * - `policy_generation`: durable monotonic counter (journal_state). A policy
 *   change (`bumpPolicyGeneration`) cancels queued jobs created under an older
   * generation. claimWork REFRESHES only the policy snapshot of the claimed
 *   job (the pre-commit policy recheck the plan requires); a claimed job whose
 *   snapshot drifted is released to the queue with its attempt budget restored,
 *   and its commit is rejected with JournalContractError("stale-policy-generation").
 * - `cancellation_generation`: durable monotonic counter bumped by
 *   `bumpCancellationGeneration` (consent revoke / forget / purges) and by
 *   `revokeSessions`. Queued jobs are cancelled immediately; a CLAIMED job
 *   keeps its lease but can NEVER commit after any bump: the commit is
 *   rejected (stale-cancellation-generation) and the job is TERMINALLY
 *   cancelled — cancellation never resurrects into queued work, so late
 *   commits cannot recreate revoked material.
 * - Claim/lease: at-least-once scheduling with durable claim tokens and
 *   expired-lease recovery on startup. Provider/model calls are NEVER
 *   exactly-once; the idempotent commit (deduped candidate keys + chunk acks
 *   in one tx) is what prevents duplicate evidence or inflated support counts
 *   on retries/restarts.
 *
 * ATOMICITY CONTRACTS (all on one connection)
 * - Enqueue: session header (project, producer/fork identity, revoked flag),
 *   minimized source rows (unique (session_id, seq) coordinates, seq 0 fully
 *   preserved) and job/chunk coverage rows commit in ONE transaction.
 * - Commit: validated candidate inserts + chunk ack + consumed-source
 *   recomputation commit in ONE transaction. A crash anywhere in between
 *   leaves either the full committed state or a clean retryable pre-state —
 *   never candidates-without-ack, never ack-without-consumed-source.
 * - Missing / revoked / never-stored source coordinates can NEVER be
 *   acknowledged: the commit path re-verifies chunk evidence availability
 *   inside the commit transaction and refuses to ack otherwise.
 * - Oversize source input rejects ATOMICALLY before any write: an event whose
 *   minimized form is only reachable through head-truncation above
 *   `sourceMaxChars` fails the whole append with the typed
 *   `source-too-large` contract error — truncated survivors are never stored,
 *   never planned for coverage, and never acked coordinates whose middle/tail
 *   the extractor could not read (see MIGRATION-PHASE-B-OVERSIZE.md).
 * - Malformed/aborted/truncated/unknown-terminal outputs stay retryable
 *   (bounded attempt budget + deterministic backoff) or fail terminally; they
 *   never ack. A valid "nothing to learn" verdict is a DIFFERENT verdict type
 *   and acks the chunk without candidates.
 *
 * TAMPER-EVIDENT EVIDENCE (typed `corrupt` is a REAL verdict path now):
 * Every stored minimized source row carries an immutable enqueue-metadata
 * contract: `event_hash` (sha256 over the exact [sessionId, seq, kind,
 * sourceKind, injected, minimizedText] tuple), `text_chars` and its identity
 * fields; every chunk row carries the immutable enqueue-time planning
 * metadata (`from_seq..to_seq`, `seg_from/seg_to`, `chars`, `event_count`).
 * These are validated in BOTH gates that guarantee adversarially damaged
 * SQLite can never be acked or published:
 * 1. BEFORE the provider: `readChunkEvidence` recomputes the event hashes and
 *    the chunk's planned shape; relays whole-range damage as
 *    `source-unavailable` never-ack evidence;
 * 2. INSIDE THE COMMIT TRANSACTION right before any ack or candidate insert.
 * Damaged evidence — tampered text, deleted rows inside a planned range,
 * forged chunk/session metadata, damaged session identity header — is typed
 * `corrupt`-family unavailable/blocking damage, NEVER `missing` (which is a
 * planning/cooldown state): a legitimately unchanged reopen of the same
 * database with the same options recomputes identical hashes and passes.
 *
 * TERMINAL-FAILURE DURABILITY (bounded retries are DURABLE, not per-boot):
 * A terminally `failed` job's coverage is durable: `planCoverageForSession`
 * treats failed-covered coordinates like active coverage, so boot recovery
 * (`recoverStartup`) and later appends NEVER resurrect that range with a
 * fresh attempt budget — boot resurrection of deterministic failures would
 * be unbounded cost. The failed row keeps its exhausted budget and
 * idempotency key. The ONLY path back to queued work is the explicitly
 * authorized typed API `retryFailedJobs` (targeted selection required, audit
 * reason recorded, attempt budget reset UNDER AUTHORIZATION — bounded
 * again). Cancellation WITHOUT source revocation still replans fresh jobs
 * under the new generation by contract (policy-change semantics, not
 * failure-resurrection).
 *
 * TYPED NARROW API SURFACE (producer / worker / policy / recovery)
 * - producer: appendSession, planJobsCoverPending
 * - worker:   claimWork, readChunkEvidence, commitChunkResult, releaseClaim
 * - policy:   bumpPolicyGeneration, bumpCancellationGeneration, revocation
 * - recovery: recoverStartup
 * - status:   getJob, listJobs, getConsumedRanges, pendingSessions, status
 * - explicit authorized retry of failed coverage: retryFailedJobs
 */
import { randomUUID, createHash } from "node:crypto";
import type { DatabaseSync, StatementSync } from "node:sqlite";
import type {
  MemoryKind,
  MemoryMetaInput,
  MemoryProvenance,
  MemoryScope,
  MemorySource,
  MemoryStore,
} from "./storage.js";
import {
  boundText,
  redactAndBoundResult,
  redactFreeText,
  redactObject,
} from "./redact.js";

// ---------------------------------------------------------------------------
// Public types (contract surface)
// ---------------------------------------------------------------------------

export type JournalJobKind = "extract";

export type JournalEventKind = "user" | "assistant" | "tool";

/** Producer header state, persisted with the session (frame facts only). */
export interface JournalProducerHeader {
  /** True when the whole session is a delegated child (coordinator-authored user turns). */
  delegated: boolean;
  origin?: string | null;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  /** Exact rc.2 fork boundary captured at first enqueue; never recomputed. */
  inheritedEventCount?: number | null;
  /** Additional opaque producer facts; persisted verbatim as bounded JSON. */
  extra?: Readonly<Record<string, string | number | boolean | null>> | null;
}

export interface JournalSourceEventInput {
  /** Native event sequence (zero-based). seq 0 is legitimate and preserved. */
  seq: number;
  ts: number;
  kind: JournalEventKind;
  /** RAW text here; the journal minimizes (redact + bound) BEFORE persistence. */
  text: string;
  /** Verbatim host source kind ("user" | "model" | "coordinator" | plugin kinds | "unknown"). */
  sourceKind?: string;
  injected?: boolean;
}

export interface JournalAppendInput {
  sessionId: string;
  projectId: string;
  producer: JournalProducerHeader;
  events: JournalSourceEventInput[];
  /** Minimization bound (chars) applied to every event of this append. */
  sourceMaxChars: number;
  /** Opt-in complete human prose retention in bounded rows; default rejects overflow. */
  oversizePolicy?: "reject" | "segment";
  /** Job kinds to cover pending sources (default ["extract"]). */
  jobKinds?: readonly JournalJobKind[];
  /** Per-kind attempt budget (default 5). */
  maxAttempts?: number;
}

export interface JournalAppendReport {
  sessionId: string;
  stored: number;
  deduped: number;
  conflictDeduped: number;
  jobsCreated: number;
  chunksPlanned: number;
  pendingSeqs: number;
}

export interface JournalJobView {
  id: string;
  kind: JournalJobKind;
  sessionId: string;
  projectId: string;
  fromSeq: number;
  toSeq: number;
  state: "queued" | "claimed" | "done" | "failed" | "cancelled";
  policyGeneration: number;
  cancellationGeneration: number;
  attemptsMade: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: number;
  completedAt: number | null;
  producerHeader: JournalProducerHeader;
}

export interface JournalClaim {
  jobId: string;
  claimToken: string;
  kind: JournalJobKind;
  sessionId: string;
  projectId: string;
  fromSeq: number;
  toSeq: number;
  policyGeneration: number;
  cancellationGeneration: number;
  attemptsMade: number;
  maxAttempts: number;
  producerHeader: JournalProducerHeader;
  chunksTotal: number;
  chunksPending: number;
}

export interface JournalEvidenceEvent {
  seq: number;
  ts: number;
  kind: JournalEventKind;
  /** Minimized text exactly as persisted (already redacted + bounded). */
  text: string;
  sourceKind: string;
  injected: boolean;
  /** Segment index within this event's text (total segments of the event). */
  segIndex: number;
  segCount: number;
  /** True when this evidence is one segment of a larger event text. */
  isPartial: boolean;
}

export type JournalChunkEvidence =
  | {
      status: "ok";
      chunkIdx: number;
      fromSeq: number;
      toSeq: number;
      events: JournalEvidenceEvent[];
    }
  | {
      status: "exhausted";
      message: string;
    }
  | {
      status: "unavailable";
      chunkIdx: number;
      /**
       * missing-source-row  ⇒ replaced by tamper/no-row
       * revoked-source      ⇒ consent revocation (never replans)
       * range-not-stored    ⇒ stale claim / job not claimed under this token
       * corrupt             ⇒ tamper/deletion/store damage: hash, text_chars,
       *                       chunk metadata, coverage contiguity or the
       *                       session identity header failed revalidation
       *                       (hash/spec checks below). Previously dead
       *                       vocabulary — now a real typed reason the
       *                       worker relays as `source-unavailable`.
       */
      reasonCode: "missing-source-row" | "revoked-source" | "range-not-stored" | "corrupt";
      message: string;
    };

export type JournalRetryableReason =
  | "malformed-model-output"
  | "aborted"
  | "provider-truncated"
  | "unknown-terminal-finish"
  | "toolcall-finish"
  | "evidence-shortfall"
  | "transient";

export type JournalVerdict =
  | { kind: "consumed"; candidates: readonly JournalCandidateInput[] }
  | { kind: "nothing-to-learn"; note?: string }
  | { kind: "retryable"; reason: JournalRetryableReason; message: string }
  | {
      kind: "source-unavailable";
      /** "corrupt" is a REAL path now: tamper-damage detected by the journal's integrity gates. */
      reason: "missing" | "corrupt" | "revoked";
      message: string;
    };

export interface JournalCandidateInput {
  text: string;
  /**
   * Provenance is typed but NOT implicitly defaulted to a trusted tier:
   * MemoryStore fails closed ('unknown') when it is omitted.
   */
  provenance: MemoryProvenance;
  source?: MemorySource;
  scope?: MemoryScope;
  kind?: MemoryKind;
  importance?: number;
  confidence?: number;
  expiresAt?: number | null;
  /** Explicit evidence coordinates; default is the chunk's exact source range. */
  evidence?: ReadonlyArray<{ sessionId: string; seq: number; snippet?: string }>;
}

export interface JournalChunkCommitReport {
  jobId: string;
  chunkIdx: number;
  acked: boolean;
  memoryIds: string[];
  jobState: "queued" | "claimed" | "done" | "failed" | "cancelled";
  chunksPending: number;
  retryScheduledAt: number | null;
}

export interface JournalRecoveryReport {
  leasesRecovered: number;
  jobsRequeued: number;
  jobsCancelled: number;
  jobsMarkedDone: number;
  jobsPlanned: number;
}

export interface JournalRevocationReport {
  cancellationGeneration: number;
  sessionsRevoked: number;
  sourcesRevoked: number;
  jobsCancelled: number;
  memoryIdsInvalidated: string[];
}

/** Report of the explicitly authorized retry of terminal-failed coverage. */
export interface JournalFailedRetryReport {
  retried: number;
  jobIds: string[];
}

export interface JournalStatusView {
  policyGeneration: number;
  cancellationGeneration: number;
  queued: number;
  claimed: number;
  done: number;
  failed: number;
  cancelled: number;
  pendingSessions: number;
}

export interface JournalRange {
  fromSeq: number;
  toSeq: number;
}

/** Deterministic crash/failpoint notifications (durable-test evidence only; production wires none). */
export type JournalBoundaryName =
  | "append-source-tx-committed"
  | "claim-tx-committed"
  | "commit-chunk-pre-commit"
  | "commit-chunk-tx-committed";

export class JournalContractError extends Error {
  readonly code:
    | "stale-policy-generation"
    | "stale-cancellation-generation"
    | "claim-invalid"
    | "lease-expired"
    | "chunk-state-invalid"
    | "revoked-session"
    | "source-too-large"
    | "closed"
    | "invalid-input";

  constructor(
    code: JournalContractError["code"],
    message: string,
    readonly detail?: Readonly<Record<string, unknown>>,
  ) {
    super(`[journal-v02:${code}] ${message}`);
    this.name = "JournalContractError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Pure deterministic helpers (identical results in every process)
// ---------------------------------------------------------------------------

const MIN_BOUND_CHARS = 64;

/** Canonical dedup hash of one minimized source event. */
export function journalEventHash(input: {
  sessionId: string;
  seq: number;
  kind: JournalEventKind;
  minimizedText: string;
  sourceKind: string;
  injected: boolean;
}): string {
  const canonical = JSON.stringify([
    input.sessionId,
    input.seq,
    input.kind,
    input.sourceKind,
    input.injected ? 1 : 0,
    input.minimizedText,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** Shrink a raw event text to its minimized retained form BEFORE persistence.
 *
 * `truncated` is part of the caller contract, not an advisory flag: a
 * `truncated:true` result means the HEAD survivor alone does not represent the
 * raw input, so persistence paths (appendSession) must REJECT it (source-too-large)
 * rather than store it and plan coverage over the lossy remainder. */
export function minimizeEventText(
  kind: JournalEventKind,
  rawText: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const budget = Math.max(MIN_BOUND_CHARS, Math.floor(maxChars));
  if (kind === "tool" || kind === "assistant") {
    // JSON-ish producer outputs parse differently than human prose.
    return redactAndBoundResult(rawText, budget);
  }
  return boundText(redactFreeText(rawText), budget);
}

/**
 * Deterministic text segmentation at text boundaries. The concatenation of
 * every segment is EXACTLY the input text (lossless — no middle truncation):
 * - text <= maxChars stays one segment;
 * - longer text splits first at blank lines, then newlines, then spaces;
 * - a boundary within [maxChars/2, maxChars] wins, else a hard slice (still
 *   lossless: the remainder continues in the next segment).
 */
export function journalTextSegments(minimizedText: string, maxChars: number): string[] {
  const budget = Math.max(MIN_BOUND_CHARS, Math.floor(maxChars));
  if (minimizedText.length === 0) return [""];
  if (minimizedText.length <= budget) return [minimizedText];
  const out: string[] = [];
  let rest = minimizedText;
  while (rest.length > budget) {
    const window = rest.slice(0, budget);
    let cut = window.lastIndexOf("\n\n");
    if (cut < budget / 2) cut = window.lastIndexOf("\n");
    if (cut < budget / 2) cut = window.lastIndexOf(" ");
    if (cut < budget / 2) cut = window.length;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** One planned chunk: an exact coverage coordinate over the event space. */
export interface PlannedChunk {
  fromSeq: number;
  toSeq: number;
  /** segTo === -1 ⇒ whole-event mode (all segments of every event in range). */
  segFrom: number;
  segTo: number;
  chars: number;
  eventCount: number;
}

/**
 * Deterministic chunk planner over the given seq-ordered minimized events.
 * Whole events accumulate into one chunk while under the char budget; a single
 * event with >1 segment gets one chunk per segment, so oversized input is
 * consumed boundary-by-boundary and never middle-truncated. The union of the
 * planned chunks covers exactly the provided event list.
 */
export function planSourceChunks(
  events: ReadonlyArray<{ seq: number; text: string }>,
  maxCharsPerChunk: number,
): PlannedChunk[] {
  const budget = Math.max(MIN_BOUND_CHARS, Math.floor(maxCharsPerChunk));
  const out: PlannedChunk[] = [];
  let open: { fromSeq: number; toSeq: number; chars: number; eventCount: number } | null = null;
  const flushOpen = (): void => {
    if (!open) return;
    out.push({ fromSeq: open.fromSeq, toSeq: open.toSeq, segFrom: 0, segTo: -1, chars: open.chars, eventCount: open.eventCount });
    open = null;
  };
  for (const event of events) {
    const segs = journalTextSegments(event.text, budget);
    if (segs.length === 1) {
      if (open && open.chars + event.text.length > budget) flushOpen();
      if (open) {
        open.toSeq = event.seq;
        open.chars += event.text.length;
        open.eventCount += 1;
      } else {
        open = { fromSeq: event.seq, toSeq: event.seq, chars: event.text.length, eventCount: 1 };
      }
    } else {
      flushOpen();
      for (let i = 0; i < segs.length; i++) {
        out.push({ fromSeq: event.seq, toSeq: event.seq, segFrom: i, segTo: i, chars: segs[i].length, eventCount: 1 });
      }
    }
  }
  flushOpen();
  return out;
}

function parseProducerHeader(raw: string | null | undefined): JournalProducerHeader {
  if (!raw) return { delegated: false };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).delegated === "boolean") {
      return parsed as JournalProducerHeader;
    }
  } catch {
    /* fall through */
  }
  return { delegated: false };
}

function backoffDelayMs(attempt: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempt - 1);
  return Math.min(base, 15 * 60_000);
}

// Producer-header minimization bounds. Pattern redaction alone CANNOT
// guarantee every credential is caught, so the persistence path also
// structurally fails closed: bounded field lengths, sensitive keys replaced
// by "[REDACTED]", a capped entry count, and a total-header bound that drops
// `extra` rather than ever truncating through credential text.
const HEADER_FIELD_CHAR_BOUND = 256;
const HEADER_EXTRA_INDIVIDUAL_CHAR_BOUND = 256;
const HEADER_EXTRA_MAX_ENTRIES = 32;
const HEADER_EXTRA_JSON_CHAR_BOUND = 2048;

/**
 * Minimize a producer header BEFORE any persistence touchpoint (journal
 * sessions AND the job rows copied from it).
 *
 * Defenses, in order:
 * 1. keyed redaction (`redactObject`): any extra key whose normalized name is
 *    credential-shaped has its value replaced with "[REDACTED]" regardless of
 *    the value type;
 * 2. free-text redaction: every extra string value and `origin` runs through
 *    `redactFreeText` (labeled assignments, well-known token formats, private
 *    keys, URI userinfo, …);
 * 3. structural containment (the "text redaction alone is insufficient"
 *    guarantee): each retained string is hard-bounded, only scalar extra
 *    entries of scalar values survive, the entry count is capped, and an
 *    extra payload too large as JSON is dropped WHOLE (never sliced through
 *    unknown-format credential text).
 */
function minimizeProducerHeader(header: JournalProducerHeader): JournalProducerHeader {
  const out: JournalProducerHeader = { delegated: header.delegated === true };
  const limit = (value: string): string => boundText(value, HEADER_FIELD_CHAR_BOUND).text;

  const origin = typeof header.origin === "string" ? limit(redactFreeText(header.origin)) : null;
  out.origin = origin && origin.length > 0 ? origin : null;
  const parent = typeof header.parentSessionId === "string" ? limit(header.parentSessionId) : null;
  out.parentSessionId = parent && parent.length > 0 ? parent : null;
  const root = typeof header.rootSessionId === "string" ? limit(header.rootSessionId) : null;
  out.rootSessionId = root && root.length > 0 ? root : null;
  const inherited = header.inheritedEventCount;
  out.inheritedEventCount =
    typeof inherited === "number" && Number.isInteger(inherited) && inherited >= 0 ? inherited : null;

  let extra: Record<string, string | number | boolean | null> = {};
  const extraInput = header.extra;
  if (extraInput !== null && typeof extraInput === "object" && !Array.isArray(extraInput)) {
    const redacted = redactObject(extraInput);
    if (redacted !== null && typeof redacted === "object" && !Array.isArray(redacted)) {
      for (const [rawKey, value] of Object.entries(redacted)) {
        if (Object.keys(extra).length >= HEADER_EXTRA_MAX_ENTRIES) break;
        const key = rawKey.slice(0, HEADER_FIELD_CHAR_BOUND);
        if (!key) continue;
        if (typeof value === "string") {
          extra[key] = boundText(value, HEADER_EXTRA_INDIVIDUAL_CHAR_BOUND).text;
        } else if (
          value === null ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value))
        ) {
          extra[key] = value;
        }
        // nested objects/arrays/functions: dropped entirely (not scalar facts)
      }
    }
  }
  while (JSON.stringify({ ...out, extra }).length > HEADER_EXTRA_JSON_CHAR_BOUND) {
    const keys = Object.keys(extra);
    if (keys.length === 0) break;
    delete extra[keys[keys.length - 1]];
  }
  out.extra = extra;
  return out;
}

const DEFAULT_MAX_ATTEMPTS = 5;

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

interface JournalJobRow {
  id: string;
  idempotency_key: string;
  kind: string;
  session_id: string;
  project_id: string;
  from_seq: number;
  to_seq: number;
  policy_generation: number;
  cancellation_generation: number;
  max_attempts: number;
  state: string;
  attempt_count: number;
  claim_token: string | null;
  lease_expires_at: number | null;
  last_error: string | null;
  retry_after_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  producer_header_json: string;
}

function toJobRow(row: Record<string, unknown>): JournalJobRow {
  return {
    id: String(row.id),
    idempotency_key: String(row.idempotency_key ?? ""),
    kind: String(row.kind),
    session_id: String(row.session_id),
    project_id: String(row.project_id),
    from_seq: Number(row.from_seq),
    to_seq: Number(row.to_seq),
    policy_generation: Number(row.policy_generation),
    cancellation_generation: Number(row.cancellation_generation),
    max_attempts: Number(row.max_attempts),
    state: String(row.state),
    attempt_count: Number(row.attempt_count),
    claim_token: row.claim_token == null ? null : String(row.claim_token),
    lease_expires_at: row.lease_expires_at == null ? null : Number(row.lease_expires_at),
    last_error: row.last_error == null ? null : String(row.last_error),
    retry_after_at: row.retry_after_at == null ? null : Number(row.retry_after_at),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    completed_at: row.completed_at == null ? null : Number(row.completed_at),
    producer_header_json: String(row.producer_header_json ?? "{}"),
  };
}

interface JournalSourceRow {
  seq: number;
  ts: number;
  kind: string;
  text: string;
  text_chars: number;
  source_kind: string;
  injected: number;
  event_hash: string;
  consumed: number;
  revoked: number;
}

function toSourceRow(row: Record<string, unknown>): JournalSourceRow {
  return {
    seq: Number(row.seq),
    ts: Number(row.ts),
    kind: String(row.kind),
    text: String(row.text),
    text_chars: Number(row.text_chars),
    source_kind: String(row.source_kind),
    injected: Number(row.injected),
    event_hash: String(row.event_hash),
    consumed: Number(row.consumed),
    revoked: Number(row.revoked),
  };
}

// ---------------------------------------------------------------------------
// Journal implementation
// ---------------------------------------------------------------------------

interface MemoryJournalOptions {
  /** Injected clock for deterministic tests. */
  nowMs?: () => number;
  /** Deterministic failpoint/crash boundary notifications (tests wire SIGKILL/throws here). */
  boundaryHook?: (name: JournalBoundaryName) => void;
  /** Chunk char budget (default 6000, deterministic). */
  chunkMaxChars?: number;
  /** Claim lease duration (default 60s). */
  defaultLeaseMs?: number;
  /** Default job attempt budget (default 5). */
  defaultMaxAttempts?: number;
}

export class MemoryJournalV02 {
  private db: DatabaseSync;
  private store: MemoryStore;
  private nowMs: () => number;
  private boundaryHook: (name: JournalBoundaryName) => void;
  private chunkMaxChars: number;
  private defaultLeaseMs: number;
  private defaultMaxAttempts: number;

  constructor(store: MemoryStore, options: MemoryJournalOptions = {}) {
    this.store = store;
    this.db = store.getJournalSqlite();
    this.nowMs = options.nowMs ?? Date.now;
    this.boundaryHook = options.boundaryHook ?? (() => undefined);
    this.chunkMaxChars = Math.max(MIN_BOUND_CHARS, Math.floor(options.chunkMaxChars ?? 6000));
    this.defaultLeaseMs = Math.max(1000, Math.floor(options.defaultLeaseMs ?? 60_000));
    this.defaultMaxAttempts = Math.max(1, Math.floor(options.defaultMaxAttempts ?? DEFAULT_MAX_ATTEMPTS));
    this.ensureSchema();
  }

  // ---- transaction helpers -------------------------------------------------

  /** Transaction wrapper owning the after-commit boundary hook. */
  private withTx<T>(after: JournalBoundaryName | null, fn: () => T): T {
    const out = this.store.runInImmediateTransaction(fn);
    if (after !== null) this.boundaryHook(after);
    return out;
  }

  // ---- schema --------------------------------------------------------------

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS journal_sessions (
        session_id            TEXT PRIMARY KEY,
        project_id            TEXT NOT NULL,
        delegated             INTEGER NOT NULL DEFAULT 0,
        root_session_id       TEXT,
        parent_session_id     TEXT,
        inherited_event_count INTEGER,
        producer_header_json  TEXT NOT NULL DEFAULT '{}',
        revoked               INTEGER NOT NULL DEFAULT 0,
        first_seen_at         INTEGER NOT NULL,
        updated_at            INTEGER NOT NULL
      ) STRICT;

      -- Minimized source events: unique (session_id, seq); text already
      -- redacted + bounded before this table is ever touched. Immutable
      -- lineage: rows are never updated with new content, only flagged.
      CREATE TABLE IF NOT EXISTS journal_sources (
        session_id  TEXT NOT NULL,
        seq         INTEGER NOT NULL,
        ts          INTEGER NOT NULL,
        kind        TEXT NOT NULL,
        text        TEXT NOT NULL,
        text_chars  INTEGER NOT NULL,
        source_kind TEXT NOT NULL DEFAULT 'unknown',
        injected    INTEGER NOT NULL DEFAULT 0,
        event_hash  TEXT NOT NULL,
        consumed    INTEGER NOT NULL DEFAULT 0,
        revoked     INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL,
        updated_at  INTEGER NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_journal_sources_pending
        ON journal_sources(session_id, consumed, seq);

      -- Overflow prose is redacted as one complete event BEFORE splitting.
      -- Root text holds part zero; text_chars/event_hash bind the complete event.
      CREATE TABLE IF NOT EXISTS journal_source_parts (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        idx INTEGER NOT NULL CHECK (idx > 0),
        text TEXT NOT NULL,
        PRIMARY KEY (session_id, seq, idx)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS journal_jobs (
        id                      TEXT PRIMARY KEY,
        idempotency_key         TEXT NOT NULL,
        kind                    TEXT NOT NULL,
        session_id              TEXT NOT NULL,
        project_id              TEXT NOT NULL,
        from_seq                INTEGER NOT NULL,
        to_seq                  INTEGER NOT NULL,
        policy_generation       INTEGER NOT NULL,
        cancellation_generation INTEGER NOT NULL,
        max_attempts            INTEGER NOT NULL,
        state                   TEXT NOT NULL,
        attempt_count           INTEGER NOT NULL DEFAULT 0,
        claim_token             TEXT,
        lease_expires_at        INTEGER,
        last_error              TEXT,
        retry_after_at          INTEGER,
        created_at              INTEGER NOT NULL,
        updated_at              INTEGER NOT NULL,
        completed_at            INTEGER,
        cancel_reason           TEXT,
        producer_header_json    TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      -- One ACTIVE job per idempotency key: crash-duplicate enqueue dedup
      -- while terminal rows (failed/cancelled/done) keep their audit trail.
      CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_jobs_active_key
        ON journal_jobs(idempotency_key) WHERE state IN ('queued','claimed');
      CREATE INDEX IF NOT EXISTS idx_journal_jobs_state
        ON journal_jobs(state, kind, retry_after_at);
      CREATE INDEX IF NOT EXISTS idx_journal_jobs_session
        ON journal_jobs(session_id, kind, state);

      CREATE TABLE IF NOT EXISTS journal_chunks (
        job_id   TEXT NOT NULL,
        idx      INTEGER NOT NULL,
        from_seq INTEGER NOT NULL,
        to_seq   INTEGER NOT NULL,
        seg_from INTEGER NOT NULL,
        seg_to   INTEGER NOT NULL,
        chars    INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        acked    INTEGER NOT NULL DEFAULT 0,
        acked_at INTEGER,
        PRIMARY KEY (job_id, idx)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_journal_chunks_job ON journal_chunks(job_id, acked);

      CREATE TABLE IF NOT EXISTS journal_derived (
        job_id        TEXT NOT NULL,
        chunk_idx     INTEGER NOT NULL,
        ordinal       INTEGER NOT NULL,
        memory_id     TEXT NOT NULL,
        candidate_key TEXT NOT NULL,
        provenance    TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        PRIMARY KEY (job_id, chunk_idx, ordinal)
      ) STRICT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_journal_derived_key
        ON journal_derived(candidate_key);
      CREATE INDEX IF NOT EXISTS idx_journal_derived_memory
        ON journal_derived(memory_id);
    `);
  }

  // ---- generation counters -------------------------------------------------

  private stateGet(key: string, fallback: number): number {
    const row = this.db.prepare("SELECT value FROM journal_state WHERE key = ?").get(`journal:${key}`) as
      | { value?: string }
      | undefined;
    const n = Number(row?.value ?? String(fallback));
    return Number.isFinite(n) && n >= 0 && Number.isInteger(n) ? n : fallback;
  }

  private stateSet(key: string, value: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO journal_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(`journal:${key}`, String(value), now);
  }

  private stateSetReason(key: string, value: string, now: number): void {
    this.db
      .prepare(
        `INSERT INTO journal_state (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(`journal:${key}`, value.slice(0, 200), now);
  }

  /** Durable policy generation (read). */
  getPolicyGeneration(): number {
    return this.withTx(null, () => this.stateGet("policy_generation", 0));
  }

  /**
   * Durable policy change: bumps the policy generation, cancels every queued
   * job created under an older generation, records the reason durably, and
   * returns the new generation.
   */
  bumpPolicyGeneration(reason: string): number {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const next = this.stateGet("policy_generation", 0) + 1;
      this.stateSet("policy_generation", next, now);
      this.stateSetReason("policy_reason", `${next}:${reason || "policy-change"}`, now);
      this.db
        .prepare(
          `UPDATE journal_jobs
             SET state = 'cancelled', cancel_reason = ?, updated_at = ?
           WHERE state = 'queued' AND policy_generation < ?`,
        )
        .run((reason || "policy-change").slice(0, 200), now, next);
      return next;
    });
  }

  /** Durable cancellation generation (read — diagnostics only). */
  getCancellationGeneration(): number {
    return this.withTx(null, () => this.stateGet("cancellation_generation", 0));
  }

  /**
   * Durable cancellation trigger (consent revoke / forget / purge). Bumps the
   * cancellation generation and cancels every queued job immediately. Claimed
   * jobs survive with their lease but can never commit after this bump
   * (stale-cancellation-generation → the job becomes terminally cancelled).
   */
  bumpCancellationGeneration(reason: string): number {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const next = this.stateGet("cancellation_generation", 0) + 1;
      this.stateSet("cancellation_generation", next, now);
      this.stateSetReason("cancellation_reason", `${next}:${reason || "cancellation"}`, now);
      this.db
        .prepare(
          `UPDATE journal_jobs
             SET state = 'cancelled', cancel_reason = ?, updated_at = ?
           WHERE state = 'queued'`,
        )
        .run((reason || "cancellation").slice(0, 200), now);
      return next;
    });
  }

  // ---- producer API --------------------------------------------------------

  /**
   * Enqueue one producer flush ATOMICALLY on the store's single connection:
   * session header + minimized sources + chunk/job coverage commit together.
   * Idempotent for retries: an identical (session_id, seq) coordinate with
   * identical minimized content is a no-op (deduped); a differing content hash
   * at the same coordinate is a conflict — the retained original stays, the
   * conflict is counted, nothing is overwritten (source lineage is immutable).
   *
   * Appends to a revoked session are refused (revoked lineage cannot be
   * re-populated by a late flush). Legitimate seq 0 is preserved: coordinates
   * start at 0, never at 1.
   *
   * OPT-IN HUMAN SEGMENTATION: oversizePolicy="segment" redacts complete
   * human prose before splitting it into sourceMaxChars-bounded source/part
   * rows in this same transaction. Hash/length bind the complete event; only
   * full worker segment coverage consumes its original native coordinate.
   * Tools/assistant outputs retain the default refusal contract below.
   *
   * DEFAULT OVERSIZE FAIL-CLOSED (typed, atomic, retryable): a raw event text that
   * would survive minimization only by being head-truncated above
   * `sourceMaxChars` (minimizeEventText ⇒ truncated:true) NEVER enters the
   * journal. A read-only pre-pass detects it BEFORE any session/source/job
   * write; the whole append is rejected with
   * JournalContractError("source-too-large") (detail: sessionId, sourceMaxChars,
   * offending seqs — never raw text). Nothing is persisted, no coverage is
   * planned and no consumed coordinate can ack content the extractor never
   * saw; the caller's native cursor stays unacked and the flush may be retried
   * after shrinking/splitting (or once canonical native reread supports
   * oversize). Identical re-flushes of content ALREADY stored under this
   * bound stay plain dedup — idempotence is not traded for the gate.
   */
  appendSession(input: JournalAppendInput): JournalAppendReport {
    const self = this;
    return this.withTx("append-source-tx-committed", () => {
      const now = self.nowMs();
      self.assertAppendInput(input);
      const sessionId = input.sessionId;
      let project = input.projectId.trim() || "default";
      if (typeof input.sourceMaxChars !== "number" || !Number.isFinite(input.sourceMaxChars)) {
        throw new JournalContractError("invalid-input", "sourceMaxChars must be a finite number");
      }
      const sourceMax = Math.max(MIN_BOUND_CHARS, Math.floor(input.sourceMaxChars));

      const sessionRow = self.db
        .prepare("SELECT revoked FROM journal_sessions WHERE session_id = ?")
        .get(sessionId) as { revoked?: number } | undefined;
      if (sessionRow && Number(sessionRow.revoked ?? 0) === 1) {
        throw new JournalContractError("revoked-session", `session ${sessionId} is revoked; append refused`, { sessionId });
      }

      // 0) OVERSIZE PRE-PASS (read-only, before ANY persistence touchpoint).
      // minimizeEventText honestly head-truncates above the bound: storing
      // that survivor and planning coverage over it would ack a coordinate
      // whose middle/tail never reached the extractor. Truncated survivors
      // are therefore rejected here — atomic, typed, retryable — so no
      // truncated text is ever enqueued as fully consumable.
      if (input.oversizePolicy !== undefined && input.oversizePolicy !== "reject" && input.oversizePolicy !== "segment") {
        throw new JournalContractError("invalid-input", "unknown oversizePolicy");
      }
      const retained = new Map<number, string>();
      const oversizeSeqs: number[] = [];
      for (const event of input.events) {
        const seq = event.seq;
        if (typeof event.text !== "string") continue;
        const kind: JournalEventKind = event.kind === "user" || event.kind === "assistant" ? event.kind : "tool";
        // Human prose only: redact the COMPLETE text before part boundaries so
        // credentials spanning a boundary cannot escape privacy minimization.
        const budget = input.oversizePolicy === "segment" && kind === "user"
          ? Number.MAX_SAFE_INTEGER : sourceMax;
        const minimized = minimizeEventText(kind, event.text, budget);
        if (minimized.truncated) oversizeSeqs.push(seq);
        retained.set(seq, minimized.text);
      }
      if (oversizeSeqs.length > 0) {
        throw new JournalContractError(
          "source-too-large",
          `${oversizeSeqs.length} event(s) exceed the source retention bound (${sourceMax} chars); ` +
            `oversize raw input is rejected BEFORE enqueue so no head-truncated survivor is ever planned as fully consumable — ` +
            `shrink/split the events and re-flush; no coordinate advanced (the producer's unacked flush is retained)`,
          { sessionId, sourceMaxChars: sourceMax, seqs: oversizeSeqs.slice(0, 32), offendingCount: oversizeSeqs.length },
        );
      }

      // 1) durable session/producer state (fork identity + delegated header).
      // Minimized BEFORE persistence: origin/extra/project are opaque
      // producer facts and can carry credential canaries the event-text
      // redaction never sees. Redaction + structural bounds here are the
      // single choke point; job rows copy only this minimized JSON.
      project = boundText(redactFreeText(project), HEADER_FIELD_CHAR_BOUND).text || "default";
      const producerJson = self.boundedJson(minimizeProducerHeader(input.producer) as unknown as Record<string, unknown>);
      self.db
        .prepare(
          `INSERT INTO journal_sessions
             (session_id, project_id, delegated, root_session_id, parent_session_id,
              inherited_event_count, producer_header_json, revoked, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
           ON CONFLICT(session_id) DO UPDATE SET
             project_id = excluded.project_id,
             delegated = CASE WHEN excluded.delegated = 1 THEN 1 ELSE journal_sessions.delegated END,
             inherited_event_count = COALESCE(journal_sessions.inherited_event_count, excluded.inherited_event_count),
             producer_header_json = CASE WHEN journal_sessions.delegated = 1 THEN journal_sessions.producer_header_json ELSE excluded.producer_header_json END,
             updated_at = excluded.updated_at`,
        )
        .run(
          sessionId,
          project,
          input.producer.delegated ? 1 : 0,
          input.producer.rootSessionId ?? null,
          input.producer.parentSessionId ?? null,
          input.producer.inheritedEventCount ?? null,
          producerJson,
          now,
          now,
        );

      // 2) minimized source rows (dedup + immutable conflict handling).
      const report: JournalAppendReport = {
        sessionId,
        stored: 0,
        deduped: 0,
        conflictDeduped: 0,
        jobsCreated: 0,
        chunksPlanned: 0,
        pendingSeqs: 0,
      };
      const seenSeqs = new Set<number>();
      for (const event of input.events) {
        const seq = event.seq;
        if (!Number.isInteger(seq) || seq < 0) {
          throw new JournalContractError("invalid-input", `event seq must be an integer >= 0 (got ${String(seq)})`, { sessionId });
        }
        if (seenSeqs.has(seq)) {
          throw new JournalContractError("invalid-input", `duplicate seq ${seq} within one append batch`, { sessionId });
        }
        seenSeqs.add(seq);
        if (typeof event.text !== "string") {
          throw new JournalContractError("invalid-input", `event seq ${seq} text must be a string`, { sessionId });
        }
        const kind: JournalEventKind = event.kind === "user" || event.kind === "assistant" ? event.kind :"tool";
        const minimized = { text: retained.get(seq)! };
        const parts = journalTextSegments(minimized.text, sourceMax);
        const sourceKind = (event.sourceKind ?? "unknown").slice(0, 128);
        const injected = event.injected === true;
        const hash = journalEventHash({ sessionId, seq, kind, minimizedText: minimized.text, sourceKind, injected });
        const existing = self.db
          .prepare(`SELECT event_hash, revoked FROM journal_sources WHERE session_id = ? AND seq = ?`)
          .get(sessionId, seq) as { event_hash: string; revoked: number } | undefined;
        if (existing) {
          if (existing.event_hash === hash && Number(existing.revoked) === 0) {
            report.deduped++;
          } else {
            report.conflictDeduped++; // never overwrite; lineage is immutable
          }
          continue;
        }
        self.db
          .prepare(
            `INSERT INTO journal_sources
               (session_id, seq, ts, kind, text, text_chars, source_kind, injected, event_hash, consumed, revoked, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
          )
          .run(
            sessionId,
            seq,
            Number.isFinite(event.ts) ? Math.floor(event.ts) : now,
            kind,
            parts[0],
            minimized.text.length,
            sourceKind,
            injected ? 1 : 0,
            hash,
            now,
            now,
          );
        const insertPart = self.db.prepare(
          `INSERT INTO journal_source_parts (session_id, seq, idx, text) VALUES (?, ?, ?, ?)`,
        );
        for (let idx = 1; idx < parts.length; idx++) insertPart.run(sessionId, seq, idx, parts[idx]);
        report.stored++;
      }

      // 3) job coverage over pending sources (same tx ⇒ enqueue is atomic).
      const jobKinds: readonly JournalJobKind[] = input.jobKinds ?? ["extract"];
      const maxAttempts = Math.max(1, Math.floor(input.maxAttempts ?? self.defaultMaxAttempts));
      for (const kind of jobKinds) {
        const planned = self.planCoverageForSession(sessionId, kind, maxAttempts, now);
        report.jobsCreated += planned.jobsCreated;
        report.chunksPlanned += planned.chunksCreated;
      }
      report.pendingSeqs = self.countPendingSeqs(sessionId);
      return report;
    });
  }

  private assertAppendInput(input: JournalAppendInput): void {
    const sessionId = typeof input.sessionId === "string" ? input.sessionId.trim() : "";
    if (!sessionId) throw new JournalContractError("invalid-input", "sessionId must be a non-empty string");
    if (input.sessionId.length > 512) throw new JournalContractError("invalid-input", "sessionId too long");
    if (typeof input.projectId !== "string") {
      throw new JournalContractError("invalid-input", "projectId must be a string");
    }
    if (!input.events || !Array.isArray(input.events)) {
      throw new JournalContractError("invalid-input", "events must be an array");
    }
    if (!input.producer || typeof input.producer.delegated !== "boolean") {
      throw new JournalContractError("invalid-input", "producer.delegated must be a boolean");
    }
  }

  private boundedJson(value: Record<string, unknown>): string {
    let raw = JSON.stringify(value);
    if (raw.length > 4096) raw = "{}";
    return raw;
  }

  // ---- coverage planning (jobs + chunk rows) --------------------------------

  /**
   * Create missing coverage (jobs + chunk plans) for unconsumed sources.
   * Ranges already covered by an active queued/claimed job are skipped, so
   * concurrent appends and recovery replanning never create overlapping work.
   *
   * TERMINAL-FAILED coverage is durable: failed-covered coordinates are also
   * skipped here — recovery and later appends never re-enqueue a failed job's
   * range with a fresh attempt budget (bounded retries are durable across
   * boots). Returning failed coverage to the queue is ONLY possible through
   * the explicitly authorized typed API `retryFailedJobs` (targeted
   * selection + audit reason).
   */
  planJobsCoverPending(sessionIds?: readonly string[]): { jobsCreated: number; chunksPlanned: number } {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const sessions =
        sessionIds && sessionIds.length > 0
          ? sessionIds
          : (this.db
              .prepare(
                `SELECT DISTINCT s.session_id AS session_id
                   FROM journal_sources s
                   JOIN journal_sessions js ON js.session_id = s.session_id
                  WHERE s.consumed = 0 AND s.revoked = 0 AND js.revoked = 0`,
              )
              .all() as Array<{ session_id: string }>).map((r) => r.session_id);
      let jobsCreated = 0;
      let chunksPlanned = 0;
      for (const sessionId of sessions) {
        const planned = this.planCoverageForSession(sessionId, "extract", this.defaultMaxAttempts, now);
        jobsCreated += planned.jobsCreated;
        chunksPlanned += planned.chunksCreated;
      }
      return { jobsCreated, chunksPlanned };
    });
  }

  /** Internal: coverage planning inside an open transaction for ONE session+kind. */
  private planCoverageForSession(
    sessionId: string,
    kind: JournalJobKind,
    maxAttempts: number,
    now: number,
  ): { jobsCreated: number; chunksCreated: number } {
    const rows = this.db
      .prepare(
        `SELECT seq, text FROM journal_sources
          WHERE session_id = ? AND consumed = 0 AND revoked = 0 ORDER BY seq`,
      )
      .all(sessionId) as Array<{ seq: number; text: string }>;
    const pending = rows.map((r) => ({ seq: Number(r.seq), text: String(r.text) }));
    if (pending.length === 0) return { jobsCreated: 0, chunksCreated: 0 };

    // Terminal-failed coverage is durable (no boot resurrection): a failed
    // job's range blocks new coverage exactly like queued/claimed ranges do,
    // so recovery/appends cannot re-enqueue its coordinates with a fresh
    // attempt budget. Only retryFailedJobs may return it to the queue.
    const activeJobs = this.db
      .prepare(
        `SELECT from_seq, to_seq FROM journal_jobs
          WHERE session_id = ? AND kind = ? AND state IN ('queued','claimed','failed')`,
      )
      .all(sessionId, kind) as Array<{ from_seq: number; to_seq: number }>;
    const isCovered = (seq: number): boolean =>
      activeJobs.some((j) => seq >= Number(j.from_seq) && seq <= Number(j.to_seq));

    const sessionRow = this.db
      .prepare(
        `SELECT project_id, producer_header_json FROM journal_sessions WHERE session_id = ?`,
      )
      .get(sessionId) as { project_id: string; producer_header_json: string } | undefined;

    let jobsCreated = 0;
    let chunksCreated = 0;
    const policyGen = this.stateGet("policy_generation", 0);
    const cancelGen = this.stateGet("cancellation_generation", 0);

    let runStart: number | null = null;
    let lastSeq: number | null = null;
    const flushRun = (): void => {
      if (runStart === null || lastSeq === null) {
        runStart = null;
        lastSeq = null;
        return;
      }
      const from = runStart;
      const to = lastSeq;
      runStart = null;
      lastSeq = null;
      const jobId = randomUUID();
      const res = this.db
        .prepare(
          `INSERT OR IGNORE INTO journal_jobs
             (id, idempotency_key, kind, session_id, project_id, from_seq, to_seq,
              policy_generation, cancellation_generation, max_attempts, state,
              attempt_count, created_at, updated_at, producer_header_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
        )
        .run(
          jobId,
          `${sessionId}|${kind}|${from}|${to}`,
          kind,
          sessionId,
          sessionRow?.project_id ?? "default",
          from,
          to,
          policyGen,
          cancelGen,
          maxAttempts,
          now,
          now,
          boundedJsonHeader(sessionRow?.producer_header_json),
        );
      if (Number(res.changes) === 1) {
        jobsCreated++;
        chunksCreated += this.planChunksForJob(jobId, sessionId, from, to);
      }
    };

    for (const event of pending) {
      const seq = Number(event.seq);
      if (isCovered(seq)) continue;
      const currentLast: number | null = lastSeq;
      if (currentLast === null) {
        runStart = seq;
        lastSeq = seq;
      } else if (seq === currentLast + 1) {
        lastSeq = seq;
      } else {
        flushRun();
        runStart = seq;
        lastSeq = seq;
      }
    }
    flushRun();
    return { jobsCreated, chunksCreated };
  }

  /** Reconstruct complete minimized prose. Old sources have no overflow rows.
   * Complete-event hashes/lengths are checked before read AND inside commit.
   * Reconstruction is transient; persistence rows and provider chunks stay bounded.
   */
  private hydrateSourceRows<T extends { seq?: unknown; text?: unknown }>(sessionId: string, rows: T[]): T[] {
    const readParts = this.db.prepare(
      `SELECT text FROM journal_source_parts WHERE session_id = ? AND seq = ? ORDER BY idx`,
    );
    for (const row of rows) {
      const parts = readParts.all(sessionId, Number(row.seq)) as Array<{ text: string }>;
      row.text = String(row.text) + parts.map((part) => part.text).join("");
    }
    return rows;
  }

  /** Deterministic chunk rows for one job's exact source range */
  private planChunksForJob(jobId: string, sessionId: string, fromSeq: number, toSeq: number): number {
    const rows = this.db
      .prepare(
        `SELECT seq, text FROM journal_sources WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq`,
      )
      .all(sessionId, fromSeq, toSeq) as Array<{ seq: number; text: string }>;
    if (rows.length === 0) {
      this.db.prepare(`DELETE FROM journal_jobs WHERE id = ?`).run(jobId);
      return 0;
    }
    const planned = planSourceChunks(
      this.hydrateSourceRows(sessionId, rows).map((r) => ({ seq: Number(r.seq), text: String(r.text) })),
      this.chunkMaxChars,
    );
    const statement = this.db
      .prepare(
        `INSERT OR IGNORE INTO journal_chunks
           (job_id, idx, from_seq, to_seq, seg_from, seg_to, chars, event_count, acked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      );
    let created = 0;
    for (let i = 0; i < planned.length; i++) {
      const c = planned[i];
      statement.run(jobId, i, c.fromSeq, c.toSeq, c.segFrom, c.segTo, c.chars, c.eventCount);
      created++;
    }
    return created;
  }

  // ---- worker API ------------------------------------------------------------

  /**
   * Claim the oldest runnable job (optionally filtered). One tx: picks a queued
   * job honoring retry_after, takes the lease, records a fresh claim token, and
   * REFRESHES the job's policy generation snapshot to the current durable value
   * when it drifted (commit-time policy recheck). Jobs whose cancellation
   * generation drifted are terminally cancelled here — cancellation never
   * resurrects into queued work.
   */
  claimWork(
    filter: { kind?: JournalJobKind; projectId?: string; perChunkLeaseMs?: number } = {},
    leaseMs?: number,
  ): JournalClaim | null {
    const self = this;
    return this.withTx("claim-tx-committed", () => {
      const now = self.nowMs();
      let lease = Math.max(1000, Math.floor(leaseMs ?? self.defaultLeaseMs));
      if (filter.perChunkLeaseMs !== undefined &&
          (!Number.isSafeInteger(filter.perChunkLeaseMs) || filter.perChunkLeaseMs <= 0)) {
        throw new JournalContractError("invalid-input", "perChunkLeaseMs must be a positive safe integer");
      }
      const where: string[] = ["state = 'queued'", "(retry_after_at IS NULL OR retry_after_at <= ?)"];
      const params: Array<string | number> = [now];
      if (filter.kind) {
        where.push("kind = ?");
        params.push(filter.kind);
      }
      if (filter.projectId) {
        where.push("project_id = ?");
        params.push(filter.projectId);
      }
      const currentPolicyGen = self.stateGet("policy_generation", 0);
      const currentCancelGen = self.stateGet("cancellation_generation", 0);
      // Set-based cleanup in this transaction: a stale queue head must not
      // masquerade as an empty queue while current-generation work is ready.
      // Preserve cancellation finality; recovery owns unrevoked-source replans.
      self.db.prepare(
        `UPDATE journal_jobs SET state = 'cancelled', cancel_reason = ?,
           claim_token = NULL, lease_expires_at = NULL, updated_at = ?
         WHERE ${where.join(" AND ")} AND cancellation_generation <> ?`,
      ).run("stale-cancellation-generation", now, ...params, currentCancelGen);
      const rows = self.db
        .prepare(
          `SELECT * FROM journal_jobs WHERE ${where.join(" AND ")} ORDER BY created_at, id LIMIT 1`,
        )
        .all(...params) as Array<Record<string, unknown>>;
      if (rows.length === 0) return null;
      const job = toJobRow(rows[0]);
      // Count the selected job's remaining work UNDER this claim transaction:
      // no peek/claim race, no fixed event-size ceiling, no healthy rollover
      // burning the provider retry budget. Numeric-only callers are unchanged.
      const chunks = self.jobChunkCount(job.id);
      const pendingChunks = self.pendingChunkCount(job.id);
      if (filter.perChunkLeaseMs !== undefined) {
        const budget = pendingChunks * filter.perChunkLeaseMs + 5_000;
        if (!Number.isSafeInteger(budget) || !Number.isSafeInteger(now + Math.max(lease, budget))) {
          throw new JournalContractError("invalid-input", "computed claim lease exceeds safe timestamp range");
        }
        lease = Math.max(lease, budget);
      }

      const token = randomUUID();
      const res = self.db
        .prepare(
          `UPDATE journal_jobs
             SET state = 'claimed', claim_token = ?, lease_expires_at = ?,
                 attempt_count = attempt_count + 1, policy_generation = ?, updated_at = ?
           WHERE id = ? AND state = 'queued'`,
        )
        .run(token, now + lease, currentPolicyGen, now, job.id);
      if (Number(res.changes) !== 1) return null;

      const updatedJob = self.getJobInternal(job.id);
      if (!updatedJob) return null;
      return {
        jobId: updatedJob.id,
        claimToken: token,
        kind: updatedJob.kind as JournalJobKind,
        sessionId: updatedJob.session_id,
        projectId: updatedJob.project_id,
        fromSeq: updatedJob.from_seq,
        toSeq: updatedJob.to_seq,
        policyGeneration: currentPolicyGen,
        cancellationGeneration: currentCancelGen,
        attemptsMade: job.attempt_count + 1,
        maxAttempts: updatedJob.max_attempts,
        producerHeader: parseProducerHeader(updatedJob.producer_header_json),
        chunksTotal: chunks,
        chunksPending: pendingChunks,
      };
    });
  }

  /**
   * Read the next pending chunk's evidence for a claimed job (minimized
   * journal text only). Untreadable coordinates (missing/revoked) are REPORTED
   * as `unavailable` and never skipped — the worker relays that verdict back,
   * which guarantees such ranges are never acknowledged. Tamper-damaged
   * evidence (event_hash / text_chars / chunk-metadata / header-identity
   * mismatch against the immutable enqueue metadata, or deleted rows inside a
   * planned range) reports typed `corrupt` and is likewise never served or
   * ackable.
   */
  readChunkEvidence(claim: JournalClaim): JournalChunkEvidence {
    this.assertClaimShape(claim);
    return this.withTx(null, () => {
      const job = this.getJobInternal(claim.jobId);
      if (!job || job.state !== "claimed" || job.claim_token !== claim.claimToken) {
        return {
          status: "unavailable",
          chunkIdx: -1,
          reasonCode: "range-not-stored",
          message: "job is no longer claimed (stale claim)",
        } as JournalChunkEvidence;
      }
      // Claim-header identity gate: a claim object whose header (sessionId /
      // kind / range) does not match the durable job row is treated as a
      // forged claim — its evidence is NEVER served and nothing can commit.
      const identityMismatch = this.claimIdentityMismatch(claim, job);
      if (identityMismatch !== null) {
        return {
          status: "unavailable",
          chunkIdx: -1,
          reasonCode: "range-not-stored",
          message: identityMismatch,
        } as JournalChunkEvidence;
      }
      const chunk = this.db
        .prepare(
          `SELECT idx, from_seq, to_seq, seg_from, seg_to, chars, event_count FROM journal_chunks
            WHERE job_id = ? AND acked = 0 ORDER BY idx LIMIT 1`,
        )
        .get(claim.jobId) as
        | { idx: number; from_seq: number; to_seq: number; seg_from: number; seg_to: number; chars: number; event_count: number }
        | undefined;
      if (!chunk) {
        return { status: "exhausted", message: "no pending chunk on this claimed job" } as JournalChunkEvidence;
      }
      const chunkIdx = Number(chunk.idx);
      const fromSeq = Number(chunk.from_seq);
      const toSeq = Number(chunk.to_seq);
      const segFrom = Number(chunk.seg_from);
      const segTo = Number(chunk.seg_to);

      const failure = this.verifyChunkAvailability(job.session_id, segFrom, segTo, { fromSeq, toSeq });
      if (failure !== null) {
        return {
          status: "unavailable",
          chunkIdx,
          reasonCode: failure.reasonCode,
          message: failure.message,
        } as JournalChunkEvidence;
      }
      // Tamper-evident gate BEFORE the provider: recompute hashes / lengths /
      // planned coverage against the immutable enqueue metadata. Adversarial
      // damage (text tamper, partial source deletion, forged chunk or session
      // metadata) is typed `corrupt` — never served, never ackable.
      const damage = this.verifyChunkIntegrity(job, {
        chunkIdx,
        fromSeq,
        toSeq,
        segFrom,
        segTo,
        chars: Number(chunk.chars),
        eventCount: Number(chunk.event_count),
      });
      if (damage !== null) {
        return {
          status: "unavailable",
          chunkIdx,
          reasonCode: "corrupt",
          message: damage.message,
        } as JournalChunkEvidence;
      }

      if (segTo >= 0) {
        const row = this.db
          .prepare(
            `SELECT seq, ts, kind, text, source_kind, injected FROM journal_sources
              WHERE session_id = ? AND seq = ? AND revoked = 0`,
          )
          .get(job.session_id, fromSeq) as Record<string, unknown> | undefined;
        if (!row) {
          return {
            status: "unavailable",
            chunkIdx,
            reasonCode: "missing-source-row",
            message: `source (${job.session_id}, ${fromSeq}) missing`,
          } as JournalChunkEvidence;
        }
        const src = toSourceRow(this.hydrateSourceRows(job.session_id, [row])[0]);
        const segs = journalTextSegments(src.text, this.chunkMaxChars);
        const segIndex = Math.min(Math.max(segFrom, 0), segs.length - 1);
        return {
          status: "ok",
          chunkIdx,
          fromSeq,
          toSeq,
          events: [
            {
              seq: src.seq,
              ts: src.ts,
              kind: src.kind as JournalEventKind,
              text: segs[segIndex],
              sourceKind: src.source_kind,
              injected: src.injected === 1,
              segIndex,
              segCount: segs.length,
              isPartial: segs.length > 1,
            },
          ],
        } as JournalChunkEvidence;
      }

      const rows = this.db
        .prepare(
          `SELECT seq, ts, kind, text, source_kind, injected FROM journal_sources
            WHERE session_id = ? AND seq >= ? AND seq <= ? AND revoked = 0 ORDER BY seq`,
        )
        .all(job.session_id, fromSeq, toSeq) as Array<Record<string, unknown>>;
      const events: JournalEvidenceEvent[] = rows.map((row) => {
        const src = toSourceRow(this.hydrateSourceRows(job.session_id, [row])[0]);
        const segs = journalTextSegments(src.text, this.chunkMaxChars);
        return {
          seq: src.seq,
          ts: src.ts,
          kind: src.kind as JournalEventKind,
          text: src.text, // whole mode carries the exact minimized text
          sourceKind: src.source_kind,
          injected: src.injected === 1,
          segIndex: 0,
          segCount: segs.length,
          isPartial: segs.length > 1,
        };
      });
      return { status: "ok", chunkIdx, fromSeq, toSeq, events } as JournalChunkEvidence;
    });
  }

  private assertClaimShape(claim: JournalClaim): void {
    if (!claim || typeof claim !== "object") {
      throw new JournalContractError("claim-invalid", "claim must be an object");
    }
    if (typeof claim.jobId !== "string" || !claim.jobId) {
      throw new JournalContractError("claim-invalid", "claim.jobId missing");
    }
    if (typeof claim.claimToken !== "string" || !claim.claimToken) {
      throw new JournalContractError("claim-invalid", "claim.claimToken missing");
    }
    if (typeof claim.sessionId !== "string" || !claim.sessionId) {
      throw new JournalContractError("claim-invalid", "claim.sessionId missing");
    }
  }

  /**
   * Outside-the-tx contract rejection for claims that cannot proceed at all.
   */
  releaseClaim(claim: JournalClaim, reason: string): void {
    this.assertClaimShape(claim);
    this.withTx(null, () => {
      const job = this.getJobInternal(claim.jobId);
      if (!job || job.claim_token !== claim.claimToken) return;
      // Identity gate: only a claim whose header matches the durable job row
      // may act on it (a forged/stale-header claim cannot even release).
      const identityMismatch = this.claimIdentityMismatch(claim, job);
      if (identityMismatch !== null) {
        throw new JournalContractError("claim-invalid", identityMismatch, { jobId: job.id });
      }
      this.releaseClaimInternal(job, reason, this.nowMs());
      return null;
    });
  }

  /**
   * The claim object's header must be an exact mirror of the immutable job
   * coordinates it was issued from. Anything else is a forged or re-bound
   * claim and gates every claim-derived action (read/commit/release).
   */
  private claimIdentityMismatch(claim: JournalClaim, job: JournalJobRow): string | null {
    const claimKind: JournalJobKind = claim.kind;
    if (
      claim.sessionId !== job.session_id ||
      claimKind !== (job.kind as JournalJobKind) ||
      claim.fromSeq !== job.from_seq ||
      claim.toSeq !== job.to_seq
    ) {
      return (
        `claim identity header does not match the durable job ${job.id} ` +
        `(claim: ${claim.sessionId}/${claimKind}/${claim.fromSeq}..${claim.toSeq}, ` +
        `job: ${job.session_id}/${job.kind}/${job.from_seq}..${job.to_seq})`
      );
    }
    return null;
  }

  // ---- commit ---------------------------------------------------------------

  /**
   * Commit one chunk's verdict. Internal tx result: either a final report or a
   * pending typed rejection raised AFTER the transaction commits (so release
   * decisions stay durable while callers still get a typed failure).
   */
  commitChunkResult(
    claim: JournalClaim,
    chunkIdx: number,
    verdict: JournalVerdict,
  ): JournalChunkCommitReport {
    this.assertClaimShape(claim);
    if (!Number.isInteger(chunkIdx) || chunkIdx < 0) {
      throw new JournalContractError("invalid-input", `chunkIdx must be a non-negative integer (got ${String(chunkIdx)})`);
    }
    if (!verdict || typeof verdict.kind !== "string") {
      throw new JournalContractError("invalid-input", "verdict.kind missing");
    }

    const self = this;
    const outcome = this.withTxInternal(() => {
      const now = self.nowMs();
      const job = self.getJobInternal(claim.jobId);
      if (!job) {
        throw new JournalContractError("claim-invalid", `job ${claim.jobId} not found`);
      }
      if (job.state !== "claimed" || job.claim_token !== claim.claimToken) {
        throw new JournalContractError("claim-invalid", "claim token/state mismatch", {
          jobId: job.id,
          state: job.state,
        });
      }
      // Claim-header identity gate (mirror of the read path): a claim whose
      // header does not match the durable job coordinates is a forged claim —
      // the commit transaction aborts BEFORE any durable state moves.
      const identityMismatch = self.claimIdentityMismatch(claim, job);
      if (identityMismatch !== null) {
        throw new JournalContractError("claim-invalid", identityMismatch, { jobId: job.id });
      }
      if (job.lease_expires_at !== null && job.lease_expires_at < now) {
        // Zombie commit: drop the expired lease durably, reject the verdict.
        self.releaseClaimInternal(job, "lease-expired", now);
        return { stale: { code: "lease-expired" as const, message: "claim lease expired before commit" } };
      }
      const chunkRow = self.db
        .prepare(
          `SELECT from_seq, to_seq, seg_from, seg_to, chars, event_count, acked FROM journal_chunks
            WHERE job_id = ? AND idx = ?`,
        )
        .get(job.id, chunkIdx) as
        | { from_seq: number; to_seq: number; seg_from: number; seg_to: number; chars: number; event_count: number; acked: number }
        | undefined;
      if (!chunkRow) {
        throw new JournalContractError("chunk-state-invalid", `chunk ${chunkIdx} not found on job ${job.id}`);
      }
      const chunk = chunkRow;
      if (Number(chunk.acked) === 1) {
        return { report: self.buildReport(job, chunkIdx, true, self.derivedMemoryIds(job.id, chunkIdx), now) };
      }

      // Generation gates (stale commits NEVER leak chunk state).
      const currentPolicyGen = self.stateGet("policy_generation", 0);
      const currentCancelGen = self.stateGet("cancellation_generation", 0);
      if (job.policy_generation !== currentPolicyGen) {
        self.releaseClaimInternal(job, `stale-policy-generation (${job.policy_generation} vs ${currentPolicyGen})`, now);
        return {
          stale: {
            code: "stale-policy-generation" as const,
            message: "policy generation changed since enqueue/claim",
            detail: { jobId: job.id, jobGeneration: job.policy_generation, current: currentPolicyGen },
          },
        };
      }
      if (job.cancellation_generation !== currentCancelGen) {
        // Cancellation is terminal: no resurrection into queued work.
        self.db
          .prepare(
            `UPDATE journal_jobs SET state='cancelled', cancel_reason=?, claim_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
          )
          .run(`stale-cancellation-generation: ${job.cancellation_generation} vs ${currentCancelGen}`, now, job.id);
        return {
          stale: {
            code: "stale-cancellation-generation" as const,
            message: "cancellation generation changed since claim; job terminally cancelled",
            detail: { jobId: job.id, jobGeneration: job.cancellation_generation, current: currentCancelGen },
          },
        };
      }

      const fromSeq = Number(chunk.from_seq);
      const toSeq = Number(chunk.to_seq);
      const segFrom = Number(chunk.seg_from);
      const segTo = Number(chunk.seg_to);

      if (verdict.kind === "consumed" || verdict.kind === "nothing-to-learn") {
        // Defence in depth (1/2): verify the chunk's evidence availability inside the
        // commit transaction. A buggy worker cannot ack evidence not present.
        const notAvailable = self.verifyChunkAvailability(job.session_id, segFrom, segTo, { fromSeq, toSeq });
        if (notAvailable !== null) {
          self.db
            .prepare(
              `UPDATE journal_jobs SET state='queued', claim_token=NULL, lease_expires_at=NULL, last_error=?, updated_at=? WHERE id=?`,
            )
            .run(`blocked-source-unavailable:${notAvailable.reasonCode}`, now, job.id);
          return {
            stale: {
              code: "chunk-state-invalid" as const,
              message: `chunk evidence unavailable at commit: ${notAvailable.message}`,
              detail: { jobId: job.id, chunkIdx, reasonCode: notAvailable.reasonCode },
            },
          };
        }
        // Defence in depth (2/2): tamper-evident revalidation inside the commit
        // transaction, right before any ack or candidate insert (same gate the
        // read path runs before the provider). Damaged evidence NEVER acks or
        // publishes, even if a tampered read raced between the two gates.
        const damage = self.verifyChunkIntegrity(job, {
          chunkIdx,
          fromSeq,
          toSeq,
          segFrom,
          segTo,
          chars: Number(chunk.chars),
          eventCount: Number(chunk.event_count),
        });
        if (damage !== null) {
          self.db
            .prepare(
              `UPDATE journal_jobs SET state='queued', claim_token=NULL, lease_expires_at=NULL, last_error=?, updated_at=? WHERE id=?`,
            )
            .run(`blocked-integrity: ${damage.message.slice(0, 180)}`, now, job.id);
          return {
            stale: {
              code: "chunk-state-invalid" as const,
              message: `chunk evidence failed integrity at commit: ${damage.message}`,
              detail: { jobId: job.id, chunkIdx, reasonCode: "corrupt" },
            },
          };
        }

        const memoryIds: string[] = [];
        if (verdict.kind === "consumed") {
          for (let i = 0; i < verdict.candidates.length; i++) {
            const cand = verdict.candidates[i];
            // Human decisions win at the FINAL same-transaction boundary, even
            // when a different, previously unlinked pending coordinate repeats
            // the forgotten/corrected body. Do not revoke unrelated source work.
            const candidateScope = cand.scope ?? "project";
            const humanTombstone = self.db.prepare(
              `SELECT 1 FROM memories m JOIN memories_meta mm ON mm.memory_id = m.id
               WHERE m.status IN ('forgotten', 'corrected') AND m.kind = ?
                 AND LOWER(TRIM(m.content)) = LOWER(TRIM(?)) AND mm.scope = ?
                 AND (? = 'global' OR (? = 'project' AND mm.project_id IS ?)
                   OR (? = 'session' AND mm.session_id = ?)) LIMIT 1`,
            ).get(cand.kind ?? "fact", cand.text, candidateScope, candidateScope,
              candidateScope, job.project_id, candidateScope, job.session_id);
            if (humanTombstone) continue;
            const candidateKey = `${job.id}:${chunkIdx}:${i}`;
            const existing = self.db
              .prepare(`SELECT memory_id FROM journal_derived WHERE candidate_key = ?`)
              .get(candidateKey) as { memory_id?: string } | undefined;
            if (existing) {
              memoryIds.push(String(existing.memory_id));
              continue;
            }
            const meta: MemoryMetaInput = {
              provenance: cand.provenance,
              source: cand.source ?? "llm-extract",
              scope: cand.scope ?? "project",
              projectId: (cand.scope ?? "project") === "global" ? null : job.project_id,
              sessionId: job.session_id,
              confidence: cand.confidence ?? 0.5,
              expiresAt: cand.expiresAt ?? null,
              evidence:
                cand.evidence !== undefined
                  ? [...cand.evidence]
                  : self.evidenceSeqsForCoord(job.session_id, fromSeq, toSeq).map((seq) => ({ sessionId: job.session_id, seq })),
            };
            const mem = self.store.insertMemoryInTx(
              { kind: cand.kind ?? "fact", content: cand.text, importance: cand.importance ?? 5 },
              meta,
            );
            memoryIds.push(mem.id);
            self.db
              .prepare(
                `INSERT INTO journal_derived
                   (job_id, chunk_idx, ordinal, memory_id, candidate_key, provenance, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(job.id, chunkIdx, i, mem.id, candidateKey, String(cand.provenance), now);
          }
        }
        self.commitChunkAck(job.id, chunkIdx, now);
        self.recomputeConsumption(job.id, job.session_id, now);
        const pendingAfter = self.pendingChunkCount(job.id);
        if (pendingAfter === 0) {
          // Final-chunk done transition (J3): the claim dies IN THE SAME
          // transaction. A done row must never retain a live claim token —
          // any releaseClaim carrying that token after done would otherwise
          // resurrect a fully-acked DONE job into 'queued' (verified
          // resurrection drill: release over the stale token reclaims work
          // that already consumed its entire range).
          self.db
            .prepare(
              `UPDATE journal_jobs
                 SET state = 'done', completed_at = ?, updated_at = ?,
                     claim_token = NULL, lease_expires_at = NULL
               WHERE id = ?`,
            )
            .run(now, now, job.id);
        }
        self.boundaryHook("commit-chunk-pre-commit");
        return {
          report: {
            jobId: job.id,
            chunkIdx,
            acked: true,
            memoryIds,
            jobState: pendingAfter === 0 ? "done" : "claimed",
            chunksPending: pendingAfter,
            retryScheduledAt: null,
          },
        };
      }

      if (verdict.kind === "source-unavailable") {
        self.db
          .prepare(
            `UPDATE journal_jobs SET state='failed', last_error=?, claim_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
          )
          .run(`source-unavailable:${verdict.reason}: ${verdict.message.slice(0, 200)}`, now, job.id);
        self.boundaryHook("commit-chunk-pre-commit");
        return { report: self.buildReport(job, chunkIdx, false, [], now, "failed") };
      }

      // verdict.kind === "retryable"
      if (job.attempt_count >= job.max_attempts) {
        self.db
          .prepare(
            `UPDATE journal_jobs SET state='failed', last_error=?, claim_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id=?`,
          )
          .run(`exhausted:${verdict.reason}: ${verdict.message.slice(0, 160)}`, now, job.id);
        self.boundaryHook("commit-chunk-pre-commit");
        return { report: self.buildReport(job, chunkIdx, false, [], now, "failed") };
      }
      const retryAt = now + backoffDelayMs(job.attempt_count + 1);
      self.db
        .prepare(
          `UPDATE journal_jobs
             SET state='queued', claim_token=NULL, lease_expires_at=NULL, retry_after_at=?, last_error=?, updated_at=?
           WHERE id = ?`,
        )
        .run(retryAt, `${verdict.reason}: ${verdict.message.slice(0, 160)}`, now, job.id);
      self.boundaryHook("commit-chunk-pre-commit");
      return {
        report: {
          jobId: job.id,
          chunkIdx,
          acked: false,
          memoryIds: [],
          jobState: "queued",
          chunksPending: self.pendingChunkCount(job.id),
          retryScheduledAt: retryAt,
        },
      };
    });

    if (outcome.stale) {
      throw new JournalContractError(
        outcome.stale.code as JournalContractError["code"],
        outcome.stale.message,
        outcome.stale.detail,
      );
    }
    if (!outcome.report) throw new JournalContractError("invalid-input", "commit produced no outcome");
    return outcome.report;
  }

  private buildReport(
    job: JournalJobRow,
    chunkIdx: number,
    acked: boolean,
    memoryIds: string[],
    _now: number,
    jobStateOverride?: JournalChunkCommitReport["jobState"],
  ): JournalChunkCommitReport {
    return {
      jobId: job.id,
      chunkIdx,
      acked,
      memoryIds,
      jobState: jobStateOverride ?? ((this.getJobInternal(job.id)?.state as JournalChunkCommitReport["jobState"]) ?? "queued"),
      chunksPending: this.pendingChunkCount(job.id),
      retryScheduledAt: null,
    };
  }

  /** null ⇒ available; else the reason code a commit/read must fail with. */
  private verifyChunkAvailability(
    sessionId: string,
    segFrom: number,
    segTo: number,
    coord: { fromSeq: number; toSeq: number },
  ): { reasonCode: "missing-source-row" | "revoked-source" | "range-not-stored" | "corrupt"; message: string } | null {
    if (segTo >= 0) {
      const row = this.db
        .prepare(`SELECT revoked FROM journal_sources WHERE session_id = ? AND seq = ?`)
        .get(sessionId, coord.fromSeq) as { revoked?: number } | undefined;
      if (!row) {
        return { reasonCode: "missing-source-row", message: `source (${sessionId}, ${coord.fromSeq}) missing` };
      }
      if (Number(row.revoked) === 1) {
        return { reasonCode: "revoked-source", message: `source (${sessionId}, ${coord.fromSeq}) revoked` };
      }
      return null;
    }
    // Whole-mode: coverage of a planned range is exact — planning only ever
    // covered rows that EXISTED in the same transaction. Fetch every row in
    // range (any revocation state): rows missing WITHOUT a revocation record
    // are damaged/tampered coverage, which is typed `corrupt`
    // (never `missing`, and never publishable): a partial deletion must not
    // leave the surviving subset ackable as "fully covered".
    const rows = this.db
      .prepare(
        `SELECT seq, revoked FROM journal_sources
          WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq`,
      )
      .all(sessionId, coord.fromSeq, coord.toSeq) as Array<{ seq: number; revoked: number }>;
    const total = coord.toSeq - coord.fromSeq + 1;
    if (rows.length === 0) {
      return { reasonCode: "missing-source-row", message: `range [${coord.fromSeq}..${coord.toSeq}] has no available source rows` };
    }
    if (rows.length < total) {
      const present = new Set(rows.map((r) => Number(r.seq)));
      const missing: number[] = [];
      for (let s = coord.fromSeq; s <= coord.toSeq && missing.length < 8; s++) {
        if (!present.has(s)) missing.push(s);
      }
      return {
        reasonCode: "corrupt",
        message:
          `range [${coord.fromSeq}..${coord.toSeq}] coverage incomplete: ${rows.length}/${total} rows survive ` +
          `(missing seq ${missing.join(", ")}${missing.length >= 8 ? " …" : ""}) — durable source lineage is damaged; this range can never be acked`,
      };
    }
    // Whole-mode disambiguation: an in-range row that is merely revoked is
    // a REVOKED source, not a missing one — the worker relays the reason
    // verbatim as the typed source-unavailable verdict, so consent-revoked
    // ranges must not be reported as (never-stored) "missing".
    const row = this.db
      .prepare(
        `SELECT COUNT(*) n FROM journal_sources
          WHERE session_id = ? AND seq >= ? AND seq <= ? AND revoked = 0`,
      )
      .get(sessionId, coord.fromSeq, coord.toSeq) as { n: number };
    if (Number(row.n) === 0) {
      return { reasonCode: "revoked-source", message: `range [${coord.fromSeq}..${coord.toSeq}] is revoked` };
    }
    return null;
  }

  /**
   * Tamper-evident revalidation of one chunk against its immutable enqueue
   * metadata (runs before the provider via `readChunkEvidence` AND again
   * inside the commit transaction). Checks, in order:
   * 1. the session identity header still exists (the durable anchor of the
   *    job's evidence coordinates);
   * 2. the chunk row's coordinates are exactly the immutable enqueue-time
   *    planning shape (inside the job range; valid seg shape);
   * 3. every surviving source row recomputes its `event_hash`
   *    (sha256 over [sessionId, seq, kind, sourceKind, injected, minimized
   *    text]) and its `text_chars` length reference — tampered text or
   *    tampered identity fields are caught;
   * 4. the chunk's immutable planning metadata (`chars`, `event_count`,
   *    segment bounds) matches the surviving rows.
   * null ⇒ intact; else the message for the typed `corrupt` damage.
   * NOTE: satisfied by ANY unchanged reopen (pure deterministic functions of
   * the persisted bytes); a reopen with a DIFFERENT chunkMaxChars would
   * legitimately re-segment long texts — that drift is a documented
   * limitation, not part of this contract (unchanged reopen works by design).
   */
  private verifyChunkIntegrity(
    job: JournalJobRow,
    meta: { chunkIdx: number; fromSeq: number; toSeq: number; segFrom: number; segTo: number; chars: number; eventCount: number },
  ): { message: string } | null {
    const sessionRow = this.db
      .prepare(`SELECT session_id FROM journal_sessions WHERE session_id = ?`)
      .get(job.session_id);
    if (!sessionRow) {
      return {
        message: `session header for ${job.session_id} is missing — the durable identity anchor of this job's evidence is damaged`,
      };
    }
    const isSegMode = meta.segTo >= 0;
    const shapeValid = isSegMode
      ? meta.fromSeq === meta.toSeq && meta.segFrom >= 0 && meta.segFrom === meta.segTo
      : meta.fromSeq <= meta.toSeq && meta.segFrom === 0 && meta.segTo === -1;
    if (!(meta.fromSeq >= job.from_seq && meta.toSeq <= job.to_seq) || !shapeValid) {
      return {
        message:
          `chunk ${meta.chunkIdx} coordinates (${meta.fromSeq}..${meta.toSeq}, seg ${meta.segFrom}..${meta.segTo}) ` +
          `do not match the job's immutable coverage (${job.from_seq}..${job.to_seq}) — chunk metadata was tampered`,
      };
    }
    const rows = this.db
      .prepare(
        `SELECT seq, kind, text, text_chars, source_kind, injected, event_hash, revoked FROM journal_sources
          WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq`,
      )
      .all(job.session_id, meta.fromSeq, meta.toSeq) as Array<Record<string, unknown>>;
    this.hydrateSourceRows(job.session_id, rows);
    if (isSegMode) {
      if (rows.length !== 1) {
        return {
          message: `segment chunk ${meta.chunkIdx} covers source (${job.session_id}, ${meta.fromSeq}) but ${rows.length} rows survive there`,
        };
      }
    }
    for (const row of rows) {
      const src = toSourceRow(row);
      const recomputed = journalEventHash({
        sessionId: job.session_id,
        seq: src.seq,
        kind: src.kind as JournalEventKind,
        minimizedText: src.text,
        sourceKind: src.source_kind,
        injected: src.injected === 1,
      });
      if (recomputed !== src.event_hash) {
        return {
          message: `source (${job.session_id}, ${src.seq}) event_hash mismatch — stored minimized text or its identity fields (kind/source_kind/injected) were tampered`,
        };
      }
      if (src.text_chars !== src.text.length) {
        return {
          message: `source (${job.session_id}, ${src.seq}) text_chars mismatch — stored length metadata ${src.text_chars} != actual ${src.text.length}`,
        };
      }
    }
    if (isSegMode) {
      const src = toSourceRow(rows[0]);
      const segs = journalTextSegments(src.text, this.chunkMaxChars);
      if (meta.segTo >= segs.length) {
        return {
          message: `planned segment ${meta.segTo} of source (${job.session_id}, ${src.seq}) is out of range (${segs.length} segments)`,
        };
      }
      if (meta.eventCount !== 1) {
        return { message: `segment chunk ${meta.chunkIdx} event_count metadata ${meta.eventCount} != 1` };
      }
      if (meta.chars !== segs[meta.segTo].length) {
        return {
          message: `segment chunk ${meta.chunkIdx} chars metadata ${meta.chars} != recomputed segment length ${segs[meta.segTo].length}`,
        };
      }
      return null;
    }
    const expectedRows = meta.toSeq - meta.fromSeq + 1;
    if (rows.length !== expectedRows) {
      return {
        message: `range [${meta.fromSeq}..${meta.toSeq}] coverage incomplete: ${rows.length}/${expectedRows} rows survive — durable source lineage is damaged`,
      };
    }
    const sumChars = rows.reduce((acc, r) => acc + String(r.text).length, 0);
    if (meta.eventCount !== rows.length) {
      return { message: `chunk ${meta.chunkIdx} event_count metadata ${meta.eventCount} != surviving in-range rows ${rows.length}` };
    }
    if (meta.chars !== sumChars) {
      return {
        message: `chunk ${meta.chunkIdx} chars metadata ${meta.chars} != recomputed stored bytes ${sumChars}`,
      };
    }
    return null;
  }

  /** Evidence seqs for candidate defaults: bounded first-five seqs in the chunk range. */
  private evidenceSeqsForCoord(sessionId: string, fromSeq: number, toSeq: number): number[] {
    const rows = this.db
      .prepare(
        `SELECT seq FROM journal_sources
          WHERE session_id = ? AND seq >= ? AND seq <= ? AND revoked = 0 ORDER BY seq LIMIT 5`,
      )
      .all(sessionId, fromSeq, toSeq) as Array<{ seq: number }>;
    return rows.map((r) => Number(r.seq));
  }

  private commitChunkAck(jobId: string, chunkIdx: number, now: number): void {
    this.db
      .prepare(`UPDATE journal_chunks SET acked = 1, acked_at = ? WHERE job_id = ? AND idx = ?`)
      .run(now, jobId, chunkIdx);
  }

  /** Recompute consumed flags after an ack, from the exact chunk coordinates.
   *  Full coverage of every segment ⇒ consumed=1. */
  private recomputeConsumption(jobId: string, sessionId: string, now: number): void {
    const chunks = this.db
      .prepare(`SELECT from_seq, to_seq, seg_from, seg_to FROM journal_chunks WHERE job_id = ? AND acked = 1`)
      .all(jobId) as Array<{ from_seq: number; to_seq: number; seg_from: number; seg_to: number }>;
    if (chunks.length === 0) return;
    const sources = this.db
      .prepare(
        `SELECT seq, text FROM journal_sources
          WHERE session_id = ? AND consumed = 0 AND revoked = 0 ORDER BY seq`,
      )
      .all(sessionId) as Array<{ seq: number; text: string }>;
    const ackedCoverFor = (seq: number, segCount: number): boolean => {
      const seen = new Set<number>();
      let whole = false;
      for (const c of chunks) {
        const from = Number(c.from_seq);
        const to = Number(c.to_seq);
        if (seq < from || seq > to) continue;
        if (Number(c.seg_to) >= 0) seen.add(Number(c.seg_from));
        else whole = true;
      }
      if (whole) return true;
      if (seen.size === 0) return false;
      for (let s = 0; s < segCount; s++) if (!seen.has(s)) return false;
      return true;
    };
    const upd = this.db.prepare(`UPDATE journal_sources SET consumed = 1, updated_at = ? WHERE session_id = ? AND seq = ?`);
    for (const src of this.hydrateSourceRows(sessionId, sources)) {
      const seq = Number(src.seq);
      const segCount = journalTextSegments(String(src.text), this.chunkMaxChars).length;
      if (ackedCoverFor(seq, segCount)) upd.run(now, sessionId, seq);
    }
  }

  // ---- revocation -------------------------------------------------------

  /**
   * Spend only the retained source coordinates behind named derived memories.
   * The durable derivation ledger, never model-declared session ids, chooses
   * the ranges. Chunk-level granularity is conservative; sessions and later
   * unrelated events remain eligible. Global consent generations are unchanged.
   */
  revokeMemoryEvidence(input: { memoryIds: readonly string[]; reason: string }): JournalRevocationReport {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const report: JournalRevocationReport = {
        cancellationGeneration: this.stateGet("cancellation_generation", 0),
        sessionsRevoked: 0, sourcesRevoked: 0, jobsCancelled: 0, memoryIdsInvalidated: [],
      };
      const ids = [...new Set(input.memoryIds)];
      if (ids.length === 0) return report;
      const reason = (input.reason || "memory-evidence-revoked").slice(0, 200);
      const ranges = this.db.prepare(
        `SELECT DISTINCT j.session_id, c.from_seq, c.to_seq
         FROM journal_derived d JOIN journal_jobs j ON j.id = d.job_id
         JOIN journal_chunks c ON c.job_id = d.job_id AND c.idx = d.chunk_idx
         WHERE d.memory_id IN (${ids.map(() => "?").join(",")})`,
      ).all(...ids) as Array<{ session_id: string; from_seq: number; to_seq: number }>;
      for (const range of ranges) {
        const sources = this.db.prepare(
          `UPDATE journal_sources SET revoked = 1, updated_at = ?
           WHERE session_id = ? AND seq BETWEEN ? AND ? AND revoked = 0`,
        ).run(now, range.session_id, range.from_seq, range.to_seq);
        report.sourcesRevoked += Number(sources.changes);
        const jobs = this.db.prepare(
          `UPDATE journal_jobs SET state = 'cancelled', cancel_reason = ?,
             claim_token = NULL, lease_expires_at = NULL, updated_at = ?
           WHERE session_id = ? AND state IN ('queued', 'claimed')
             AND from_seq <= ? AND to_seq >= ?`,
        ).run(reason, now, range.session_id, range.to_seq, range.from_seq);
        report.jobsCancelled += Number(jobs.changes);
      }
      return report;
    });
  }

  /**
   * Revoke retained journal sources for the given sessions/projects
   * (support-graph removal). One transaction: bumps the cancellation
   * generation FIRST, cancels affected queued jobs, marks sessions + sources
   * revoked, and (default) quarantines every derivative memory journal-derived
   * from affected jobs using MemoryStore.setMemoryStatus (same tx). Returns
   * the invalidated derivative ids. Native session history is untouched.
   */
  revokeSessions(
    input: { sessionIds?: readonly string[]; projectIds?: readonly string[]; reason: string; invalidateMemories?: boolean },
  ): JournalRevocationReport {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const reason = (input.reason || "revocation").slice(0, 200);
      const empty: JournalRevocationReport = {
        cancellationGeneration: this.stateGet("cancellation_generation", 0),
        sessionsRevoked: 0,
        sourcesRevoked: 0,
        jobsCancelled: 0,
        memoryIdsInvalidated: [],
      };
      if (
        (input.sessionIds !== undefined && input.sessionIds.length === 0) ||
        (input.projectIds !== undefined && input.projectIds.length === 0)
      ) {
        // Explicit empty selection: no-op by contract (never a blanket revoke).
        return empty;
      }

      // Affected sessions from the durable session table.
      let sessionIds: string[];
      if (input.sessionIds !== undefined) {
        sessionIds = [...input.sessionIds];
      } else if (input.projectIds !== undefined) {
        const rows = this.db
          .prepare(
            `SELECT session_id FROM journal_sessions WHERE project_id IN (${input.projectIds.map(() => "?").join(",")})`,
          )
          .all(...input.projectIds) as Array<{ session_id: string }>;
        sessionIds = rows.map((r) => String(r.session_id));
      } else {
        // No targeted ids: refuse the blanket revoke (fail closed).
        return empty;
      }
      if (sessionIds.length === 0) return empty;
      const ph = sessionIds.map(() => "?").join(",");

      // 1) cancellation generation FIRST (blocks late commits).
      const cancelGen = this.stateGet("cancellation_generation", 0) + 1;
      this.stateSet("cancellation_generation", cancelGen, now);
      this.stateSetReason("cancellation_reason", `${cancelGen}:${reason}`, now);

      // 2) cancel affected queued jobs (claimed ones die at their commit).
      const jobsRes = this.db
        .prepare(
          `UPDATE journal_jobs SET state='cancelled', cancel_reason=?, updated_at=? WHERE state='queued' AND session_id IN (${ph})`,
        )
        .run(reason, now, ...sessionIds);
      const jobsCancelled = Number(jobsRes.changes);

      // 3) mark sessions revoked.
      const sessionRes = this.db
        .prepare(`UPDATE journal_sessions SET revoked = 1, updated_at = ? WHERE session_id IN (${ph})`)
        .run(now, ...sessionIds);

      // 4) mark sources revoked (lineage immutable; only the flag changes).
      const sourcesRes = this.db
        .prepare(`UPDATE journal_sources SET revoked = 1, updated_at = ? WHERE session_id IN (${ph}) AND revoked = 0`)
        .run(now, ...sessionIds);

      // 5) collect derivative ids from affected jobs and invalidate them.
      const memoryIdsInvalidated: string[] = [];
      const derivedRows = this.db
        .prepare(
          `SELECT jd.memory_id AS memory_id FROM journal_derived jd
            JOIN journal_jobs jj ON jj.id = jd.job_id
            WHERE jj.session_id IN (${ph})`,
        )
        .all(...sessionIds) as Array<{ memory_id: string }>;
      for (const row of derivedRows) {
        const memoryId = String(row.memory_id);
        if (!memoryIdsInvalidated.includes(memoryId)) memoryIdsInvalidated.push(memoryId);
      }
      if (input.invalidateMemories !== false && memoryIdsInvalidated.length > 0) {
        for (const memoryId of memoryIdsInvalidated) {
          // setMemoryStatus is tx-aware: inside our open tx it just runs.
          this.store.setMemoryStatus(memoryId, "quarantined");
        }
      }

      return {
        cancellationGeneration: cancelGen,
        sessionsRevoked: Number(sessionRes.changes),
        sourcesRevoked: Number(sourcesRes.changes),
        jobsCancelled,
        memoryIdsInvalidated,
      };
    });
  }

  /**
   * EXPLICIT AUTHORIZED RETRY of terminal-failed coverage (the ONLY path that
   * returns a `failed` job to the queue — boot recovery never resurrects
   * failed ranges implicitly; see the terminal-failure durability contract).
   *
   * Semantics (one transaction):
   * - targeted selection REQUIRED: sessionIds / projectId / jobId; a blanket
   *   call with no selection (or an explicitly empty one) is a typed no-op
   *   report (never a journal-wide retry), mirroring revokeSessions'
   *   fail-closed selection contract;
   * - the failed row's idempotency key is KEPT (same job id, same
   *   journal_derived ledger; a replayed candidate still dedupes to one
   *   memory). A failed row whose idempotency key is already held by an
   *   active (queued/claimed) job is skipped, never double-planned;
   * - the exhausted attempt budget is reset to a fresh bounded budget UNDER
   *   AUTHORIZATION: the `reason` is mandatory and recorded in the job's
   *   last_error trail; policy/cancellation generation snapshots are
   *   refreshed to the current durable values;
   * - retry_after_at / completed_at are cleared; the acked chunk prefix stays
   *   acked and the claim resumes at the first unacked chunk.
   * A deterministically failing range fails terminally again — each
   * authorization buys exactly one bounded budget, never an unbounded loop.
   */
  retryFailedJobs(input: {
    sessionIds?: readonly string[];
    projectId?: string;
    jobId?: string;
    reason: string;
  }): JournalFailedRetryReport {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const reason = (input.reason || "authorized-retry").slice(0, 200);
      const empty: JournalFailedRetryReport = { retried: 0, jobIds: [] };
      const hasSelection =
        (input.sessionIds !== undefined && input.sessionIds.length > 0) ||
        (typeof input.projectId === "string" && input.projectId.length > 0) ||
        (typeof input.jobId === "string" && input.jobId.length > 0);
      if (!hasSelection) return empty; // fail closed: never a blanket retry
      const where = ["state = 'failed'"];
      const params: Array<string | number> = [];
      if (input.sessionIds !== undefined && input.sessionIds.length > 0) {
        where.push(`session_id IN (${input.sessionIds.map(() => "?").join(",")})`);
        params.push(...input.sessionIds);
      }
      if (typeof input.projectId === "string" && input.projectId.length > 0) {
        where.push("project_id = ?");
        params.push(input.projectId);
      }
      if (typeof input.jobId === "string" && input.jobId.length > 0) {
        where.push("id = ?");
        params.push(input.jobId);
      }
      const rows = this.db
        .prepare(`SELECT * FROM journal_jobs WHERE ${where.join(" AND ")}`)
        .all(...params) as Array<Record<string, unknown>>;
      const policyGen = this.stateGet("policy_generation", 0);
      const cancelGen = this.stateGet("cancellation_generation", 0);
      const jobIds: string[] = [];
      for (const raw of rows) {
        const job = toJobRow(raw);
        // Idempotency guard: never two ACTIVE jobs per idempotency key —
        // a failed key already held by queued/claimed work stays as is.
        const active = this.db
          .prepare(
            `SELECT id FROM journal_jobs WHERE idempotency_key = ? AND state IN ('queued','claimed') LIMIT 1`,
          )
          .get(job.idempotency_key);
        if (active) continue;
        const lastError = `authorized-retry(${reason})${job.last_error ? `: prior error ${job.last_error}` : ""}`.slice(
          0,
          400,
        );
        const res = this.db
          .prepare(
            `UPDATE journal_jobs
               SET state = 'queued', attempt_count = 0, claim_token = NULL, lease_expires_at = NULL,
                   retry_after_at = NULL, completed_at = NULL, policy_generation = ?,
                   cancellation_generation = ?, last_error = ?, updated_at = ?
             WHERE id = ? AND state = 'failed'`,
          )
          .run(policyGen, cancelGen, lastError, now, job.id);
        if (Number(res.changes) === 1) jobIds.push(job.id);
      }
      return { retried: jobIds.length, jobIds };
    });
  }

  // ---- recovery -----------------------------------------------------------

  /**
   * Startup recovery: expired leases returned to 'queued' (zombie claims die,
   * attempt budget preserved for the next claim), claimed tasks that are fully
   * acked become 'done', and coverage is replanned for pending sources (the
   * enqueue/crash gap). Bounded and idempotent; no unsafe implicit effects.
   *
   * DURABLE-FAILURE RULE: recovery replans coverage ONLY for coordinates that
   * are neither consumed, revoked, nor covered by an active OR terminal-failed
   * job — a terminally failed range is NOT resurrected at boot with a fresh
   * attempt budget (that would make deterministic failures unbounded across
   * restarts). The only authorized path back is `retryFailedJobs`.
   * A `cancelled` row's unrevoked sources are legitimately replanned as FRESH
   * jobs under the new generation (policy-change semantics — asserted
   * contract, not failure resurrection).
   */
  recoverStartup(): JournalRecoveryReport {
    return this.withTx(null, () => {
      const now = this.nowMs();
      const report: JournalRecoveryReport = {
        leasesRecovered: 0,
        jobsRequeued: 0,
        jobsCancelled: 0,
        jobsMarkedDone: 0,
        jobsPlanned: 0,
      };
      // 1) zombie claims (lease expired): requeue preserving budget; stale
      //    cancellation snapshots are terminally cancelled here.
      const claimed = this.db
        .prepare(
          `SELECT * FROM journal_jobs WHERE state = 'claimed' AND (lease_expires_at IS NULL OR lease_expires_at < ?)`,
        )
        .all(now) as Array<Record<string, unknown>>;
      for (const raw of claimed) {
        const job = toJobRow(raw);
        if (job.cancellation_generation !== this.stateGet("cancellation_generation", 0)) {
          // Terminal cancel: the zombie claim's token/lease die here too —
          // cancel_reason alone would leave a live token and releaseClaim
          // (pre-guard) could requeue revoked-generation work.
          this.db
            .prepare(
              `UPDATE journal_jobs SET state='cancelled', cancel_reason='stale-cancellation-generation',
                  claim_token=NULL, lease_expires_at=NULL, updated_at=? WHERE id = ?`,
            )
            .run(now, job.id);
          report.jobsCancelled++;
        } else {
          this.releaseClaimInternal(job, "startup-expired-lease", now);
          report.jobsRequeued++;
        }
        report.leasesRecovered++;
      }
      // 2) fully-acked claimed/failed/queued work finishes up.
      const openJobs = this.db
        .prepare(`SELECT id FROM journal_jobs WHERE state IN ('queued','claimed','failed')`)
        .all() as Array<{ id: string }>;
      for (const j of openJobs) {
        if (this.pendingChunkCount(String(j.id)) === 0) {
          // Done transition at recovery: same J3 rule as the commit path — a
          // settled done row never retains a live claim token/lease.
          const res = this.db
            .prepare(
              `UPDATE journal_jobs SET state='done', completed_at=COALESCE(completed_at, ?), updated_at=?,
                  claim_token=NULL, lease_expires_at=NULL
                WHERE id = ?`,
            )
            .run(now, now, String(j.id));
          if (Number(res.changes) === 1) report.jobsMarkedDone++;
        }
      }
      // 3) replan coverage for any pending gap (crash between append & plan).
      const planned = this.planJobsCoverPending();
      report.jobsPlanned = planned.jobsCreated;
      return report;
    });
  }

  // ---- introspection (typed narrow reads for status/UI integration) --------

  getJob(jobId: string): JournalJobView | null {
    const job = this.getJobInternal(jobId);
    return job ? this.toJobView(job) : null;
  }

  listJobs(filter: { sessionId?: string; kind?: JournalJobKind; state?: string; limit?: number } = {}): JournalJobView[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (filter.sessionId) {
      where.push("session_id = ?");
      params.push(filter.sessionId);
    }
    if (filter.kind) {
      where.push("kind = ?");
      params.push(filter.kind);
    }
    if (filter.state) {
      where.push("state = ?");
      params.push(filter.state);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM journal_jobs
          ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(...params, Math.min(200, Math.max(1, Math.floor(filter.limit ?? 50)))) as Array<Record<string, unknown>>;
    return rows.map((row) => this.toJobView(toJobRow(row)));
  }

  /** Merged consumed ranges of one session (exact acked coverage union). */
  getConsumedRanges(sessionId: string): JournalRange[] {
    const seqRows = this.db
      .prepare(`SELECT seq FROM journal_sources WHERE session_id = ? AND consumed = 1 ORDER BY seq`)
      .all(sessionId) as Array<{ seq: number }>;
    const out: JournalRange[] = [];
    for (const row of seqRows) {
      const seq = Number(row.seq);
      const last = out[out.length - 1];
      if (last && last.toSeq === seq - 1) last.toSeq = seq;
      else out.push({ fromSeq: seq, toSeq: seq });
    }
    return out;
  }

  /** Sessions still holding unconsumed, non-revoked sources. */
  pendingSessions(limit = 200): Array<{ sessionId: string; pendingSeqs: number }> {
    const rows = this.db
      .prepare(
        `SELECT session_id, COUNT(*) n FROM journal_sources
          WHERE consumed = 0 AND revoked = 0
          GROUP BY session_id ORDER BY session_id LIMIT ?`,
      )
      .all(Math.min(200, Math.max(1, Math.floor(limit)))) as Array<{ session_id: string; n: number }>;
    return rows.map((r) => ({ sessionId: String(r.session_id), pendingSeqs: Number(r.n) }));
  }

  status(): JournalStatusView {
    const counts = { queued: 0, claimed: 0, done: 0, failed: 0, cancelled: 0 };
    const rows = this.db.prepare(`SELECT state, COUNT(*) n FROM journal_jobs GROUP BY state`).all() as
      Array<{ state: string; n: number }>;
    for (const row of rows) {
      const key = String(row.state) as keyof typeof counts;
      if (key in counts) counts[key] = Number(row.n);
    }
    return {
      policyGeneration: this.stateGet("policy_generation", 0),
      cancellationGeneration: this.stateGet("cancellation_generation", 0),
      ...counts,
      pendingSessions: this.pendingSessions(200).length,
    };
  }

  // ---- internals ------------------------------------------------------------

  /**
   * Commit-transaction wrapper with a typed internal outcome: `fn` may return
   * `{ report }` (success) or `{ stale: {...} }` (after a durable release /
   * cancel decision inside the tx). The "pre-commit" boundary hook is fired by
   * `fn` right before its report is produced; the "tx-committed" hook is fired
   * here, once, after COMMIT — never on the throw path.
   */
  private withTxInternal<T extends { report?: JournalChunkCommitReport; stale?: StaleOutcome }>(
    fn: () => T,
  ): T {
    const out = this.store.runInImmediateTransaction(fn);
    if (!out.stale) this.boundaryHook("commit-chunk-tx-committed");
    return out;
  }

  private releaseClaimInternal(job: JournalJobRow, reason: string, now: number): void {
    // Return to queued, PRESERVING the attempt budget (the worker's failure
    // count is not consumed by a stale-generation round trip).
    // STATE GUARD (J3, defense in depth): ONLY a currently-'claimed' row can
    // be released. done/failed/cancelled/queued rows keep their terminal or
    // settled state no matter which stale token calls this — releasing a done
    // row would resurrect fully-acked work; releasing a cancelled row would
    // requeue revoked-generation work (re-cancelled at the next claim, but
    // with pointless churn and a reclaim window before the generation gate).
    this.db
      .prepare(
        `UPDATE journal_jobs
           SET state = 'queued', claim_token = NULL, lease_expires_at = NULL,
               last_error = ?, updated_at = ?
         WHERE id = ? AND state = 'claimed'`,
      )
      .run(reason.slice(0, 200), now, job.id);
  }

  private getJobInternal(jobId: string): JournalJobRow | null {
    const row = this.db.prepare(`SELECT * FROM journal_jobs WHERE id = ?`).get(jobId) as
      | Record<string, unknown>
      | undefined;
    return row ? toJobRow(row) : null;
  }

  private toJobView(job: JournalJobRow): JournalJobView {
    return {
      id: job.id,
      kind: job.kind as JournalJobKind,
      sessionId: job.session_id,
      projectId: job.project_id,
      fromSeq: job.from_seq,
      toSeq: job.to_seq,
      state: job.state as JournalJobView["state"],
      policyGeneration: job.policy_generation,
      cancellationGeneration: job.cancellation_generation,
      attemptsMade: job.attempt_count,
      maxAttempts: job.max_attempts,
      lastError: job.last_error,
      createdAt: job.created_at,
      completedAt: job.completed_at,
      producerHeader: parseProducerHeader(job.producer_header_json),
    };
  }

  private pendingChunkCount(jobId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) n FROM journal_chunks WHERE job_id = ? AND acked = 0`)
      .get(jobId) as { n: number };
    return Number(row.n);
  }

  private jobChunkCount(jobId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) n FROM journal_chunks WHERE job_id = ?`)
      .get(jobId) as { n: number };
    return Number(row.n);
  }

  private derivedMemoryIds(jobId: string, chunkIdx: number): string[] {
    const rows = this.db
      .prepare(`SELECT memory_id FROM journal_derived WHERE job_id = ? AND chunk_idx = ? ORDER BY ordinal`)
      .all(jobId, chunkIdx) as Array<{ memory_id: string }>;
    return rows.map((r) => String(r.memory_id));
  }

  private countPendingSeqs(sessionId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) n FROM journal_sources WHERE session_id = ? AND consumed = 0 AND revoked = 0`)
      .get(sessionId) as { n: number };
    return Number(row.n);
  }
}

function boundedJsonHeader(raw: string | undefined): string {
  if (!raw) return "{}";
  return raw.length > 4096 ? "{}" : raw;
}

interface StaleOutcome {
  code:
    | "stale-policy-generation"
    | "stale-cancellation-generation"
    | "lease-expired"
    | "chunk-state-invalid";
  message: string;
  detail?: Record<string, unknown>;
}
