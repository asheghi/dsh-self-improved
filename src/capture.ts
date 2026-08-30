/**
 * L0 capture module (M1/M2): normalizes the session event stream into extraction-pipeline input slices (JSONL),
 * persists them within the session/flush barrier and marks the extraction queue watermark.
 *
 * Design alignment: docs/design/dsh-memory-plugin-design.md §4.3
 */
import type { Context } from "@deepseek-ai/cordis";
import type { MemoryStore, ConversationSliceRecord } from "./storage.js";

export interface CaptureController {
  /** Whether currently enabled (master switch && capture module switch) */
  enabled(): boolean;
}

/**
 * Install the capture listener.
 * @param onCaptured Called after persisting and marking the queue; if it returns a Promise and is awaited, it blocks flush (used for headless finalization)
 */
export function installCapture(
  ctx: Context,
  store: MemoryStore,
  controller: CaptureController,
  onCaptured?: () => void | Promise<unknown>,
): void {
  // Max seq written per session (in-process cursor; authoritative dedup is guaranteed by the DSH event seq)
  const lastWritten = new Map<string, number>();

  ctx.on("session/flush", async (session) => {
    if (!controller.enabled()) return;
    const floor = lastWritten.get(session.id) ?? 0;
    const records: ConversationSliceRecord[] = [];
    for (const event of session.events) {
      if (event.seq <= floor) continue;
      const slice = toSlice(session.id, event);
      if (slice) records.push(slice);
    }
    if (records.length > 0) {
      store.appendConversationSlice(session.id, records);
      const maxSeq = records[records.length - 1].seq;
      store.markPending(session.id, maxSeq);
      lastWritten.set(session.id, maxSeq);
    }
    if (onCaptured) {
      const result = onCaptured();
      if (result instanceof Promise) await result;
    }
  });
}

/** Convert a session event into a slice record; non-text events (such as turn/start, tool/call) return null */
function toSlice(sessionId: string, event: SessionEventLike): ConversationSliceRecord | null {
  const ts = typeof event.time === "number" ? event.time : Date.now();
  const data = event.data as Record<string, unknown> | undefined;
  switch (event.type) {
    case "user/message": {
      const text = textOfContent(data?.content);
      return text ? { type: "user", seq: event.seq, ts, text, sessionId } : null;
    }
    case "assistant/message": {
      const message = (data?.message ?? data) as Record<string, unknown> | undefined;
      const text = textOfContent(message?.content);
      return text ? { type: "assistant", seq: event.seq, ts, text, sessionId } : null;
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
function textOfContent(content: unknown): string {
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
