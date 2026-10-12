import type { ContinuityV03AncestryQuery } from "./continuity-source-v03.js";
import type { CanonicalContinuitySource } from "./continuity-checkpoint-v02.js";
import { ContinuityCaptureV03, type ContinuityV03CaptureOwner, type ContinuityV03FreshSourceReader, type ContinuityV03TurnEndCaptureRequest } from "./continuity-capture-v03.js";
import { ContinuityWorkV03, type ContinuityV03WorkOwner, type ContinuityV03WorkClaim } from "./continuity-work-v03.js";
import { readContinuitySummaryPolicyEpochV02 } from "./continuity-summary-ledger-owner.js";
import { isSafeContinuityV03ProjectId, isSafeContinuityV03SessionId } from "./continuity-schema-contract-v03.js";

export interface ContinuityRuntimeV03Store extends ContinuityV03CaptureOwner, ContinuityV03WorkOwner {}
export interface ContinuityRuntimeV03TrustedReceipt {
  readonly kind: "host-authenticated-turn-end"; readonly receiptId: string; readonly request: ContinuityV03TurnEndCaptureRequest;
}
/** A trusted Host owner validates/consumes actual authority; a client-provided kind is not authentication. */
export type ContinuityRuntimeV03Admission = (receipt: unknown) => ContinuityRuntimeV03TrustedReceipt | null;
export interface ContinuityRuntimeV03Hooks {
  readonly query: ContinuityV03AncestryQuery; readonly readFreshSource: ContinuityV03FreshSourceReader;
  readonly summarize: (claim: ContinuityV03WorkClaim, signal: AbortSignal) => Promise<unknown>;
  readonly now: () => number;
  /** Live explicit body/provider consent. Omission denies before source/provider access. */
  readonly canSummarize?: () => boolean;
}
export type ContinuityRuntimeV03Result = { kind: "captured" | "completed"; jobId: string } | { kind: "cancelled" }
  | { kind: "denied"; reason: "untrusted-receipt" | "stale" | "no-work" | "consent" | "disposed" | "capacity" };
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  try {
    const ds = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(ds).length !== keys.length || Reflect.ownKeys(ds).some(key => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: Record<string, unknown> = Object.create(null);
    for (const key of keys) { const d = ds[key]; if (!d?.enumerable || !Object.hasOwn(d, "value")) return null; copy[key] = d.value; }
    return copy;
  } catch { return null; }
}
function snapshotReceipt(value: unknown): ContinuityRuntimeV03TrustedReceipt | null {
  const r = record(value, ["kind", "receiptId", "request"]);
  if (!r || r.kind !== "host-authenticated-turn-end" || typeof r.receiptId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(r.receiptId)) return null;
  const q = record(r.request, ["kind", "sessionId", "projectId", "generation", "turnEndSeq"]);
  if (!q || q.kind !== "host-live-turn-end" || !isSafeContinuityV03SessionId(q.sessionId) || !isSafeContinuityV03ProjectId(q.projectId)
    || typeof q.generation !== "number" || !Number.isSafeInteger(q.generation) || q.generation < 0
    || typeof q.turnEndSeq !== "number" || !Number.isSafeInteger(q.turnEndSeq) || q.turnEndSeq < 0) return null;
  return Object.freeze({ kind: "host-authenticated-turn-end", receiptId: r.receiptId,
    request: Object.freeze({ kind: "host-live-turn-end", sessionId: q.sessionId, projectId: q.projectId, generation: q.generation, turnEndSeq: q.turnEndSeq }) });
}

/** Optional summary pipeline; no default Host authority, consent, background timer, or prompt dispatch. */
export class ContinuityRuntimeV03 {
  private readonly capture: ContinuityCaptureV03;
  private readonly work: ContinuityWorkV03;
  private readonly active = new Set<{ controller: AbortController; promise: Promise<ContinuityRuntimeV03Result> }>();
  private readonly spent = new Set<string>();
  private disposed = false;
  constructor(private readonly store: ContinuityRuntimeV03Store,
    private readonly admission: ContinuityRuntimeV03Admission = () => null) {
    this.capture = new ContinuityCaptureV03(store); this.work = new ContinuityWorkV03(store);
  }
  onTrustedTurnEnd(receipt: unknown, hooks: ContinuityRuntimeV03Hooks, signal?: AbortSignal): Promise<ContinuityRuntimeV03Result> {
    if (this.disposed) return Promise.resolve({ kind: "denied", reason: "disposed" });
    if (signal?.aborted) return Promise.resolve({ kind: "cancelled" });
    if (this.active.size >= 8 || this.spent.size >= 256) return Promise.resolve({ kind: "denied", reason: "capacity" });
    let trusted: ContinuityRuntimeV03TrustedReceipt | null;
    try { trusted = snapshotReceipt(this.admission(receipt)); } catch { trusted = null; }
    if (!trusted || this.spent.has(trusted.receiptId)) return Promise.resolve({ kind: "denied", reason: "untrusted-receipt" });
    if (hooks.canSummarize?.() !== true) return Promise.resolve({ kind: "denied", reason: "consent" });
    this.spent.add(trusted.receiptId);
    for (const active of this.active) active.controller.abort();
    const controller = new AbortController(); const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const entry = { controller, promise: undefined as unknown as Promise<ContinuityRuntimeV03Result> };
    // Track before executing callbacks, so disposal owns even synchronously reentrant admission/source paths.
    entry.promise = Promise.resolve().then(() => this.run(trusted!, hooks, controller.signal)).finally(() => {
      signal?.removeEventListener("abort", abort); this.active.delete(entry);
    });
    this.active.add(entry);
    return entry.promise;
  }
  private async run(trusted: ContinuityRuntimeV03TrustedReceipt, hooks: ContinuityRuntimeV03Hooks, signal: AbortSignal): Promise<ContinuityRuntimeV03Result> {
    try {
      signal.throwIfAborted();
      const epoch = readContinuitySummaryPolicyEpochV02(this.store.getJournalSqlite());
      if (epoch === null || hooks.canSummarize?.() !== true) return { kind: "denied", reason: "consent" };
      const captured = await this.capture.captureAtTurnEnd(hooks.query, hooks.readFreshSource, trusted.request, signal);
      if (!captured) return { kind: "denied", reason: "stale" };
      signal.throwIfAborted();
      // Claim only the exact job made by this boundary. An older same-project job must not borrow this source reader.
      const claim = this.work.claim(trusted.request.projectId, hooks.now(), 30_000, captured.jobId);
      if (!claim) return { kind: "captured", jobId: captured.jobId };
      if (claim.id !== captured.jobId || claim.sessionId !== trusted.request.sessionId || claim.projectId !== trusted.request.projectId) return { kind: "denied", reason: "stale" };
      if (!await this.work.isCurrentWithFreshSource(hooks.query, hooks.readFreshSource, claim, hooks.now, signal)) return { kind: "denied", reason: "stale" };
      signal.throwIfAborted();
      if (hooks.canSummarize?.() !== true || readContinuitySummaryPolicyEpochV02(this.store.getJournalSqlite()) !== epoch) return { kind: "cancelled" };
      const notes = await hooks.summarize(claim, signal);
      signal.throwIfAborted();
      if (hooks.canSummarize?.() !== true || readContinuitySummaryPolicyEpochV02(this.store.getJournalSqlite()) !== epoch) return { kind: "cancelled" };
      const completed = await this.work.completeWithFreshSource(hooks.query, hooks.readFreshSource, claim, hooks.now, notes, signal);
      return completed ? { kind: "completed", jobId: claim.id } : { kind: "denied", reason: "stale" };
    } catch (error) { if (signal.aborted) return { kind: "cancelled" }; throw error; }
  }
  cancel(): void { for (const entry of this.active) entry.controller.abort(); }
  async dispose(): Promise<void> {
    this.disposed = true; this.cancel();
    await Promise.allSettled([...this.active].map(entry => entry.promise));
    this.active.clear();
  }
}
export interface ContinuityWorkerV03Hooks extends ContinuityRuntimeV03Hooks { projectId: string; }
export async function runContinuityWorkerV03(runtime: ContinuityRuntimeV03, receipt: unknown,
  hooks: ContinuityWorkerV03Hooks, signal?: AbortSignal): Promise<ContinuityRuntimeV03Result> {
  return runtime.onTrustedTurnEnd(receipt, hooks, signal);
}
export type { CanonicalContinuitySource, ContinuityV03WorkClaim, ContinuityV03TurnEndCaptureRequest };
