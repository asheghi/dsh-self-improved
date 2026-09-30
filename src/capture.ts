/**
 * L0 capture module (M1/M2): normalizes the session event stream into extraction-pipeline input slices (JSONL),
 * persists them within the session/flush barrier and marks the extraction queue watermark.
 *
 * Design alignment: docs/design/dsh-memory-plugin-design.md §4.3
 */
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore, ConversationSliceRecord, EpisodeEventInput } from "./storage.js";
import { redactAndBoundArguments, redactAndBoundResult, boundText, redactFreeText } from "./redact.js";
import { assembleSessionEpisodes } from "./episodes.js";

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

/**
 * Install the capture listener.
 * @param onCaptured Called after persisting and marking the queue; if it returns a Promise and is awaited, it blocks flush (used for headless finalization)
 * @param episodeCtl Optional episode controller; when provided (and enabled), tool/call, tool/result and turn/end events are
 *   redacted-and-bounded then persisted into episode_events before episode assembly runs.
 */
export function installCapture(
  ctx: Context,
  store: MemoryStore,
  controller: CaptureController,
  onCaptured?: (sessions: string[]) => void | Promise<unknown>,
  episodeCtl?: EpisodeCaptureController,
): void {
  // Max seq written per session (in-process cursor; authoritative dedup is guaranteed by the DSH event seq)
  const lastWritten = new Map<string, number>();
  // Episode-event cursor per session (same pattern as lastWritten), seeded from the durable store floor
  const episodeSeq = new Map<string, number>();

  ctx.on("session/flush", async (session) => {
    if (!controller.enabled()) return;
    // Delegated-session classification is decided once per session from its
    // immutable header and applied to every slice captured below.
    const delegated = isDelegatedHeader(session.header);
    const captureCtx: SessionCaptureContext = { delegated };
    const floor = lastWritten.get(session.id) ?? 0;
    const records: ConversationSliceRecord[] = [];
    for (const event of session.events) {
      if (event.seq <= floor) continue;
      const slice = toSlice(session.id, event, captureCtx);
      if (slice) records.push(slice);
    }
    if (records.length > 0) {
      store.appendConversationSlice(session.id, records);
      const maxSeq = records[records.length - 1].seq;
      store.markPending(session.id, maxSeq);
      const cwd = typeof session.header?.cwd === "string" ? session.header.cwd : "";
      store.setSessionProject(session.id, projectKeyFromCwd(cwd));
      lastWritten.set(session.id, maxSeq);
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
      for (const event of session.events) {
        if (event.seq <= epFloor) continue;
        const row = toEpisodeEventRow(event, episodeCtl.maxChars());
        if (row) {
          rows.push(row);
          if (row.seq > maxRowSeq) maxRowSeq = row.seq;
        }
      }
      if (rows.length > 0) {
        try {
          const cwd = typeof session.header?.cwd === "string" ? session.header.cwd : "";
          store.appendEpisodeEvents(session.id, projectKeyFromCwd(cwd), delegated, rows);
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
      const message = (data.message ?? {}) as Record<string, unknown>;
      const content = Array.isArray(message.content) ? message.content : [];
      let toolCallId: string | null = null;
      let isError = message.isError === true;
      const innerContents: unknown[] = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b.type !== "tool-result") continue;
        if (typeof b.toolCallId === "string") toolCallId = b.toolCallId;
        if (b.isError === true) isError = true;
        innerContents.push(b.content ?? "");
      }
      if (!toolCallId) return null;
      const text =
        innerContents.map((c) => textOfContent(c)).filter(Boolean).join("\n") || textOfContent(content);
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
