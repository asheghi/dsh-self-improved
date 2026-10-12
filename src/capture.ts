/**
 * L0 capture module (M1/M2): normalizes the session event stream into extraction-pipeline input slices (JSONL),
 * persists them within the session/flush barrier and marks the extraction queue watermark.
 *
 * Design alignment: docs/design/dsh-memory-plugin-design.md §4.3
 */
import type { Context } from "@deepseek-ai/cordis";
import type { Session } from "@deepseek-ai/dsh-session";
import type { MemoryStore, ConversationSliceRecord, EpisodeEventInput } from "./storage.js";
import { redactAndBoundArguments, redactAndBoundResult, boundText, redactFreeText } from "./redact.js";
import { assembleSessionEpisodes } from "./episodes.js";
import { isInjectedContextUserSource, readOwnSessionEvents } from "./compat-v02.js";
import type {
  JournalAppendInput,
  JournalAppendReport,
  JournalClaim,
  JournalChunkCommitReport,
  JournalChunkEvidence,
  JournalJobView,
  JournalProducerHeader,
  JournalRevocationReport,
  JournalSourceEventInput,
  JournalStatusView,
  JournalVerdict,
} from "./memory-journal-v02.js";
import type { MemoryJournalV02 } from "./memory-journal-v02.js";
import { createHash } from "node:crypto";

export interface CaptureController {
  /** Whether currently enabled (master switch && capture module switch) */
  enabled(): boolean;
}

/**
 * Episode-capture controller (schema v2): episode events are captured alongside
 * conversation slices inside the same session/flush barrier, gated by the
 * episodeLearning runtime state.
 */
export interface EpisodeCaptureController {
  enabled(): boolean;
  /** argsChars / resultExcerptChars bound applied to every redacted payload */
  maxChars(): number;
}

// ── Phase B capture → journal lane (MIGRATION-PHASE-B-STORAGE.md §4.4) ──────

/** Minimization budget passed to the journal for enqueued direct-human text.
 *  Deliberately a GENEROUS ceiling, not the redaction/extraction budget: the
 *  journal divides retained text into lossless chunks (planSourceChunks /
 *  journalTextSegments), so long direct-human input consumes every chunk and
 *  the middle is never silently dropped. Only input above this ceiling is
 *  honestly head-truncated (report contract §source coverage). */
export const JOURNAL_SOURCE_MAX_CHARS = 200_000;

/**
 * Narrow producer/worker seam (documented, implemented by the runtime index
 * over ONE MemoryJournalV02 instance). The extractor wiring lane claims via
 * `claimWork`, reads exact persisted minimized evidence with
 * `readChunkEvidence`, reports one typed verdict per chunk through
 * `commitChunkResult`, and never fabricates acks. This module owns the
 * CONTRACT only; extraction is not implemented here (Phase B next lane).
 */
export interface JournalExtractorSeam {
  claimWork(filter?: { kind?: "extract"; projectId?: string; perChunkLeaseMs?: number }, leaseMs?: number): JournalClaim | null;
  readChunkEvidence(claim: JournalClaim): JournalChunkEvidence;
  commitChunkResult(claim: JournalClaim, chunkIdx: number, verdict: JournalVerdict): JournalChunkCommitReport;
  releaseClaim(claim: JournalClaim, reason: string): void;
  revokeSessions(
    input: { sessionIds?: readonly string[]; projectIds?: readonly string[]; reason: string; invalidateMemories?: boolean },
  ): JournalRevocationReport;
  bumpPolicyGeneration(reason: string): number;
  listJobs(filter?: { sessionId?: string; kind?: "extract"; state?: string; limit?: number }): JournalJobView[];
  status(): JournalStatusView;
}

/**
 * Single-site builder for the extractor seam over the runtime's ONE durable
 * journal instance. Every field is a direct delegation to the documented
 * journal API (§4.2 table in MIGRATION-PHASE-B-STORAGE.md); no behavior is
 * added and no extraction logic lives here.
 */
export function createJournalExtractSeam(journal: MemoryJournalV02): JournalExtractorSeam {
  return {
    claimWork: (filter, leaseMs) => journal.claimWork(filter, leaseMs),
    readChunkEvidence: (claim) => journal.readChunkEvidence(claim),
    commitChunkResult: (claim, chunkIdx, verdict) => journal.commitChunkResult(claim, chunkIdx, verdict),
    releaseClaim: (claim, reason) => journal.releaseClaim(claim, reason),
    revokeSessions: (input) => journal.revokeSessions(input),
    bumpPolicyGeneration: (reason) => journal.bumpPolicyGeneration(reason),
    listJobs: (filter) => journal.listJobs(filter),
    status: () => journal.status(),
  };
}

/**
 * Producer lane's durable persistence seam: the ONE runtime journal instance.
 * `append` runs the atomic enqueue transaction the journal owns
 * (minimize-before-persist included); `closed()` is the ingress signal —
 * once the runtime dropIngress boundary has closed the capture lane, no
 * further enqueue may run (bounded drain then closes the store).
 */
export interface JournalCaptureSink {
  append(input: JournalAppendInput): JournalAppendReport;
  closed(): boolean;
}

/**
 * Stable OPAQUE project identity for the journal lane: a sha-256 digest of
 * the NORMALIZED project key (full normalized cwd, never a basename or
 * clipped path). The journal groups jobs/evidence by this id; the
 * path-derived legacy key (`projectKeyFromCwd`) stays exactly where legacy
 * consumers already read it (session_projects scope mapping). No path text
 * is retained in the journal's project column and no clipped path is used
 * as an identity anywhere.
 */
export function opaqueProjectIdFromKey(key: string): string {
  const normalized = String(key).trim() || "default";
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return `pj-${digest.slice(0, 32)}`;
}

/**
 * STRUCTURAL ALLOWLIST producer header (journal §JournalProducerHeader):
 * only categorical session facts — delegation state, fork lineage sizes and
 * parent/root ids, and the subagent-service origin sentinel — are copied.
 * Arbitrary `session.header` payloads and opaque producer `extra` are NEVER
 * constructed from capture (extra is left empty; credential-shaped values
 * cannot even reach the journal's header minimizer from this lane).
 */
export function journalProducerHeader(
  header: { inheritedEventCount?: unknown; header?: { origin?: unknown; parentSession?: unknown; rootSession?: unknown } },
  delegated: boolean,
): JournalProducerHeader {
  const h = header.header && typeof header.header === "object" ? header.header : {};
  const producer: JournalProducerHeader & { origin?: "subagent"; parentSessionId?: string; rootSessionId?: string } = {
    delegated,
  };
  const inherited = Number(header.inheritedEventCount);
  if (Number.isFinite(inherited)) producer.inheritedEventCount = Math.max(0, Math.floor(inherited));
  if (typeof h.parentSession === "string" && h.parentSession.length > 0) {
    producer.parentSessionId = h.parentSession.slice(0, 256);
  }
  if (typeof h.rootSession === "string" && h.rootSession.length > 0) {
    producer.rootSessionId = h.rootSession.slice(0, 256);
  }
  // Allowlisted categorical origin ONLY: the SubAgent service's stamped
  // sentinel. Any other header.origin value is never copied.
  if (h.origin === "subagent") producer.origin = "subagent";
  return producer;
}

/**
 * Convert ONE own session event into a journal source event, or null.
 *
 * Eligibility is a DIRECT-HUMAN gate (privacy-before-persist in the producer
 * lane): only `source.kind === 'user'` messages that are not plugin/agent/
 * recall/`snapshot` injected-context sources and that live in a
 * NON-delegated session are enqueued. Ordinary assistant/tool producers,
 * coordinator briefs/relays, scheduled/injected/unknown/private/excluded
 * producers therefore persist NO personal-lane text through this lane
 * (the raw JSONL slice copies they used to feed are REMOVED; the canonical
 * native session history is untouched and remains the full record).
 */
export function toJournalSourceEvent(
  event: SessionEventLike,
  captureCtx: SessionCaptureContext = { delegated: false },
): JournalSourceEventInput | null {
  if (captureCtx.delegated) return null;
  if (event.type !== "user/message") return null;
  const data = event.data as Record<string, unknown> | undefined;
  const source = data?.source;
  if (!source || typeof source !== "object" || (source as { kind?: unknown }).kind !== "user") return null;
  if (isInjectedContextUserSource(source)) return null; // snapshot/recall/plugin injections are never personal-lane text
  const text = textOfContent(data?.content);
  if (!text) return null;
  return {
    seq: event.seq,
    ts: typeof event.time === "number" ? event.time : Date.now(),
    kind: "user",
    text, // RAW in; the journal minimizes before persistence (single choke point)
    sourceKind: sourceKindOf(data).slice(0, 128),
    injected: false,
  };
}

/**
 * Install the capture listener.
 * @param onCaptured Called after persisting and marking the queue; if it returns a Promise and is awaited, it blocks flush (used for headless finalization)
 * @param episodeCtl Optional episode controller; when provided (and enabled), tool/call, tool/result and turn/end events are
 *   redacted-and-bounded then persisted into episode_events before episode assembly runs.
 * @param journalSink Optional Phase B producer lane seam over the ONE runtime
 *   journal instance (MIGRATION-PHASE-B-CAPTURE.md): when provided and open,
 *   the flush atomically enqueues ONLY direct-human minimized evidence
 *   (raw text in; the journal minimizes before persistence inside its
 *   transaction). Ordinary assistant/tool/coordinator/injected/unknown
 *   producers and delegated forks persist no personal-lane text here.
 * @returns a disposer that unregisters the `session/flush` listener (Effect-
 *   owned lifecycle support, Phase A): the plugin's shutdown boundary
 *   explicitly takes the ingress down before draining/closing the store.
 */
export function installCapture(
  ctx: Context,
  store: MemoryStore,
  controller: CaptureController,
  onCaptured?: (sessions: string[]) => void | Promise<unknown>,
  episodeCtl?: EpisodeCaptureController,
  journalSink?: JournalCaptureSink,
): () => void {
  // Journal-lane enqueue cursor per session: advances only after a committed
  // append; the journal's immutable (session_id, seq, event_hash) dedup makes
  // any re-flush idempotent, so the durable authority is the journal, not this map.
  const journalSeq = new Map<string, number>();
  // Episode-event cursor per session (same pattern as journalSeq), seeded from the durable store floor
  const episodeSeq = new Map<string, number>();

  const uninstall = ctx.on("session/flush", async (session: Session) => {
    if (!controller.enabled()) return;
    // Delegated-session classification is decided once per session from its
    // immutable header and applied to every slice captured below.
    const delegated = isDelegatedHeader(session.header);
    const captureCtx: SessionCaptureContext = { delegated };
    // rc.2 fork boundary: a forked session's inherited prefix belongs to the
    // parent and is never recaptured; the own-event floor seeds at
    // `inheritedEventCount - 1` so a legitimate exact seq=0 own event is not
    // excluded (the legacy floor `?? 0` failed the zero-based log).
    const sessionFloor = Number.isFinite(Number(session.inheritedEventCount))
      ? Number(session.inheritedEventCount) - 1
      : -1;
    // Canonical project scope mapping (legacy lane consumers read this key);
    // the journal lane derives its own OPAQUE identity from the same stable key.
    const cwd = typeof session.header?.cwd === "string" ? session.header.cwd : "";
    store.setSessionProject(session.id, projectKeyFromCwd(cwd));

    // ── Phase B journal lane: atomic enqueue of ONLY direct-human minimized
    // evidence. This replaces the plugin-owned raw JSONL transcript copies
    // (the old appendConversationSlice + markPending lane): assistant, tool,
    // coordinator, scheduled, injected, unknown, private and excluded
    // producers no longer persist personal-lane text through capture; the
    // canonical native session history is untouched and remains the record.
    if (journalSink !== undefined && !journalSink.closed()) {
      const journalFloor = Math.max(journalSeq.get(session.id) ?? -1, sessionFloor);
      const enqueued: JournalSourceEventInput[] = [];
      for (const event of readOwnSessionEvents(session, journalFloor)) {
        const source = toJournalSourceEvent(event, captureCtx);
        if (source) enqueued.push(source);
      }
      if (enqueued.length > 0) {
        const maxSeq = enqueued[enqueued.length - 1].seq;
        try {
          // RAW text in; the journal minimizes BEFORE persistence inside its
          // single append transaction (privacy-before-owned-write contract,
          // MIGRATION-PHASE-B-STORAGE.md §4.2).
          journalSink.append({
            sessionId: session.id,
            projectId: opaqueProjectIdFromKey(projectKeyFromCwd(cwd)),
            producer: journalProducerHeader(session, delegated),
            events: enqueued,
            sourceMaxChars: JOURNAL_SOURCE_MAX_CHARS,
            oversizePolicy: "segment",
          });
          // Cursor advances ONLY after a successful append: a crash/throw
          // before commit leaves the floor untouched, and the journal's
          // immutable lineage dedup makes the retry idempotent and seq0-safe.
          journalSeq.set(session.id, maxSeq);
        } catch (error) {
          // No commit ⇒ cursor not advanced; never fabricate a flush ack.
          console.warn("[dsh-self-improved] journal enqueue failed:", String(error));
        }
      }
      // Per-session map growth guard (same pattern as episodeSeq below);
      // cleared floors re-advance via the journal's immutable event dedup.
      if (journalSeq.size > 4096) journalSeq.clear();
    }
    // Episode capture (schema v2): redact BEFORE any persistence call
    if (episodeCtl?.enabled()) {
      let epFloor = episodeSeq.get(session.id);
      if (epFloor === undefined) {
        epFloor = store.lastEpisodeSeq(session.id);
        episodeSeq.set(session.id, epFloor);
      }
      const rows: EpisodeEventInput[] = [];
      let maxRowSeq = epFloor;
      for (const event of readOwnSessionEvents(session, epFloor)) {
        const row = toEpisodeEventRow(event, episodeCtl.maxChars());
        if (row) {
          rows.push(row);
          if (row.seq > maxRowSeq) maxRowSeq = row.seq;
        }
      }
      if (rows.length > 0) {
        try {
          const cwd = typeof session.header?.cwd === "string" ? session.header.cwd : "";
          store.appendEpisodeEvents(session.id, projectKeyFromCwd(cwd), journalProducerHeader(session, delegated), rows);
          episodeSeq.set(session.id, maxRowSeq);
        } catch (error) {
          console.warn("[dsh-self-improved] episode event append failed:", String(error));
        }
      }
      // Retry starvation guard: assemble whenever the store still holds pending
      // (unclaimed) episode events for this session — regardless of whether THIS
      // flush appended rows, so a previously failed/stranded assembly is retried.
      try {
        if (store.getPendingEpisodeEvents(session.id, 1).length > 0) {
          assembleSessionEpisodes(store, session.id);
        }
      } catch (error) {
        console.warn("[dsh-self-improved] episode assembly failed:", String(error));
      }
      // Per-session map growth guard (same pattern as the accessDedup cap in storage.ts);
      // cleared floors are re-seeded durably from store.lastEpisodeSeq on the next flush.
      if (episodeSeq.size > 4096) episodeSeq.clear();
    }
    if (onCaptured) {
      const result = onCaptured([session.id]);
      if (result instanceof Promise) await result;
    }
  });
  // Ingress-down disposer: cordis itself would unregister this listener with
  // the fiber; handing it out FIRST lets the plugin's shutdown boundary take
  // the ingress down before its bounded drain and store close.
  return uninstall;
}

/** Stable project scope key. Keep the normalized absolute cwd to avoid basename collisions. */
export function projectKeyFromCwd(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "default";
}

function sourceKindOf(data: Record<string, unknown> | undefined): string {
  const source = data?.source as Record<string, unknown> | undefined;
  return source && typeof source.kind === "string" ? source.kind : "unknown";
}

/** MessageSourceMap is merge-extensible: trust only the one explicit human producer. */
function isDirectHumanMessage(data: Record<string, unknown> | undefined): boolean {
  return sourceKindOf(data) === "user";
}

/**
 * Convert a session event into a slice record; non-text events (such as turn/start, tool/call) return null.
 *
 * `captureCtx` carries the session-level delegation classification: in a delegated
 * session, even a source.kind === 'user' turn is the COORDINATOR's task brief or a
 * parent-relayed message, never a human utterance — it is captured as a
 * non-extractable 'coordinator' slice (type tool/injected), so an L1 extractor can
 * never mistake coordinator-authored text for the human operator's voice.
 */
export function toSlice(
  sessionId: string,
  event: SessionEventLike,
  captureCtx: SessionCaptureContext = { delegated: false },
): ConversationSliceRecord | null {
  const ts = typeof event.time === "number" ? event.time : Date.now();
  const data = event.data as Record<string, unknown> | undefined;
  switch (event.type) {
    case "user/message": {
      const sourceKind = sourceKindOf(data);
      const directHuman = isDirectHumanMessage(data) && !captureCtx.delegated;
      // Unknown and plugin-defined producers are untrusted by default. They remain
      // captured as non-extractable audit slices rather than being mistaken for humans.
      const text = textOfContent(data?.content);
      if (!text) return null;
      if (captureCtx.delegated) {
        // The delegation prompt and any later relayed parent text inside a child
        // session: explicit coordinator classification (verbatim task brief text,
        // NOT spoken user phrasing).
        return {
          type: "tool",
          seq: event.seq,
          ts,
          text,
          sessionId,
          injected: true,
          sourceKind: sourceKind === "user" ? "coordinator" : sourceKind,
        };
      }
      return { type: directHuman ? "user" : "tool", seq: event.seq, ts, text, sessionId, injected: !directHuman, sourceKind };
    }
    case "assistant/message": {
      const message = (data?.message ?? data) as Record<string, unknown> | undefined;
      const text = textOfContent(message?.content);
      if (!text) return null;
      const sourceKind = sourceKindOf(message);
      return { type: "assistant", seq: event.seq, ts, text, sessionId, injected: sourceKind !== "model", sourceKind };
    }
    case "tool/result": {
      const message = data?.message as Record<string, unknown> | undefined;
      const text = textOfContent(message?.content);
      if (!text) return null;
      return { type: "tool", seq: event.seq, ts, text, sessionId };
    }
    default:
      return null;
  }
}

/** Extract plain text from an LLM message content block array (or string) */
export function textOfContent(content: unknown): string {
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (block && typeof block === "object" && typeof (block as { text?: unknown }).text === "string") {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join("\n").trim();
  }
  if (typeof content === "string") return content.trim();
  return "";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SessionEventLike = { type: string; seq: number; time?: number; data?: any };

/**
 * The capture context of one session: enough header facts to decide whether the
 * session's user-role turns were spoken by the human operator or written by a
 * delegating coordinator.
 */
export interface SessionCaptureContext {
  /** True when the session was spawned by a delegation tool call (subagent/send_message/fork/workflow). */
  delegated: boolean;
}

/**
 * Distinguishing signal (deterministic, from the persisted SessionHeader):
 * the harness SubAgent service stamps every delegate child session with
 * `origin: 'subagent'`, `delegationDepth >= 1`, and the `parentSession` id of
 * the delegating session, while a top-level operator session has `delegationDepth 0`
 * (zero/absent, no `origin`). Because this decision reads only the immutable
 * session header, resume/restart cannot reclassify a session, and the one tool
 * that sponsors the prompt (`subagent`, subagent_fork, send_message, workflow
 * agents) is caught uniformly — including nested (depth ≥ 2) sessions.
 * In a delegated session the delegator's task brief arrives as that session's
 * FIRST user-role message (source.kind === 'user' like any other turn), so the
 * message source kind alone is NOT sufficient — the header flag is.
 */
export function isDelegatedHeader(header: unknown): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const h = header as null | Record<string, any>;
  if (!h || typeof h !== "object") return false;
  // Origin stamped by the subagent service is the primary, explicit signal.
  if (h.origin === "subagent") return true;
  const depth = typeof h.delegationDepth === "number" ? h.delegationDepth : 0;
  if (depth > 0) return true;
  return typeof h.parentSession === "string" && h.parentSession.length > 0;
}

/**
 * Convert one session event into a redacted-and-bounded episode event input row
 * (Phase 1 capture). Redaction runs BEFORE persistence; pattern redaction cannot
 * guarantee every secret is removed, so the maxChars bound further limits exposure.
 *
 * Pairing is never positional: result rows carry the toolCallId found inside the
 * tool-result content block (payload.toolCallId), and episode assembly matches on
 * that id only.
 */
export function toEpisodeEventRow(event: SessionEventLike, maxChars: number): EpisodeEventInput | null {
  const seq = event.seq;
  const at = typeof event.time === "number" ? event.time : Date.now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data = (event.data ?? {}) as Record<string, any>;
  switch (event.type) {
    case "tool/call": {
      const callId = typeof data.callId === "string" ? data.callId : null;
      if (!callId) return null;
      const toolName = typeof data.name === "string" ? data.name : "unknown";
      const rawArgs = typeof data.arguments === "string" ? data.arguments : "";
      const bounded = redactAndBoundArguments(rawArgs, maxChars);
      return {
        kind: "call",
        callId,
        turn: Number(data.turn ?? 0),
        step: typeof data.step === "number" ? data.step : null,
        seq,
        at,
        payload: JSON.stringify({
          toolName,
          argumentsRedacted: bounded.text,
          argsTruncated: bounded.truncated ? 1 : 0,
          callId,
        }),
      };
    }
    case "tool/result": {
      // rc.2 flat ToolResultMessage: `toolCallId` lives at message level and
      // result content is ordinary content blocks (the legacy nested
      // `tool-result` block shape is gone and would discard every result).
      const message = (data.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      let toolCallId: string | null = typeof message.toolCallId === "string" ? message.toolCallId : null;
      let isError = message.isError === true;
      if (!toolCallId) return null;
      const text = textOfContent(content);
      const bounded = redactAndBoundResult(text, maxChars);
      const error = (data.error ?? null) as Record<string, unknown> | null;
      // error.name/error.code are attacker-influenced strings from tool outputs:
      // redact then bound before they touch the payload (non-strings via String()).
      const boundErrText = (v: unknown): string | null =>
        v == null ? null : boundText(redactFreeText(typeof v === "string" ? v : String(v)), 120).text;
      return {
        kind: "result",
        callId: toolCallId,
        turn: Number(data.turn ?? 0),
        step: typeof data.step === "number" ? data.step : null,
        seq,
        at,
        payload: JSON.stringify({
          toolCallId,
          resultExcerpt: bounded.text,
          resultTruncated: bounded.truncated ? 1 : 0,
          isError: isError ? 1 : 0,
          errorName: error ? boundErrText(error.name) : null,
          errorCode: error ? boundErrText(error.code) : null,
          toolHint: null,
        }),
      };
    }
    case "turn/end": {
      return {
        kind: "turn-end",
        // node:sqlite STRICT rejects NULL in PRIMARY KEY columns: turn-end rows use an empty-string call_id instead of NULL
        callId: "",
        turn: Number(data.turn ?? 0),
        step: null,
        seq,
        at,
        payload: JSON.stringify({
          // Only a categorical, bounded reasonKind persists — never an arbitrary
          // String(reason) ('[object Object]'). Unknown kinds are not-completed.
          reasonKind:
            typeof (data.reason as { kind?: unknown } | undefined)?.kind === "string"
              ? (data.reason.kind as string).slice(0, 64)
              : "unknown",
        }),
      };
    }
    default:
      return null;
  }
}
