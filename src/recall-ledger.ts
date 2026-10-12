/**
 * Bounded record of what recall ACTUALLY rendered into a session, so an
 * operator can ask "why did this appear?" and get facts instead of a story.
 *
 * This is runtime state, not evidence: it is intentionally in-memory, bounded
 * and evictable, and it disappears on restart. It never strengthens a memory,
 * never marks anything as used-and-therefore-good, and its counts must never be
 * read as improvement.
 */
export interface RecallDelivery {
  at: number;
  /** The query text that produced the hit, clipped for display only. */
  query: string;
  /** Ids actually rendered into the injected block (post-trim), in block order. */
  ids: readonly string[];
}
const MAX_SESSIONS = 50;
const MAX_DELIVERIES = 20;
const MAX_QUERY = 160;

export class RecallLedger {
  private readonly bySession = new Map<string, RecallDelivery[]>();

  /** Record one delivery. `sessionId` empty means the call had no session scope,
   *  and the entry is attributed to the anonymous bucket rather than dropped. */
  record(sessionId: string, delivery: { query: string; ids: readonly string[]; at?: number }): void {
    const key = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : "";
    const ids = Array.isArray(delivery?.ids) ? delivery.ids.filter((id) => typeof id === "string" && id.length > 0) : [];
    if (ids.length === 0) return;
    const entry: RecallDelivery = {
      at: Number.isSafeInteger(delivery.at) ? (delivery.at as number) : Date.now(),
      query: typeof delivery.query === "string" ? delivery.query.slice(0, MAX_QUERY) : "",
      ids: [...ids],
    };
    const list = this.bySession.get(key) ?? [];
    list.push(entry);
    if (list.length > MAX_DELIVERIES) list.splice(0, list.length - MAX_DELIVERIES);
    // Re-insert so the Map's iteration order is least-recently-used.
    this.bySession.delete(key);
    this.bySession.set(key, list);
    while (this.bySession.size > MAX_SESSIONS) {
      const oldest = this.bySession.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.bySession.delete(oldest);
    }
  }

  /** Most recent deliveries for one session, newest last. */
  list(sessionId: string): readonly RecallDelivery[] {
    return this.bySession.get(sessionId) ?? [];
  }

  get sessions(): number { return this.bySession.size; }
}
