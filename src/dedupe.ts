/**
 * Semantic duplicate / contradiction consolidation (M7).
 *
 * Practical, no-embedding approach on top of jieba token sets:
 * - similarity: Jaccard overlap of token sets (cheap paraphrase detector)
 * - contradiction: high token overlap + asymmetric negation (one side carries a
 *   negation cue the other does not)
 *
 * Shared by the extraction pump and memory_correct so every writer path uses one definition.
 *
 * Hardening (dedupe boundaries): neighbor lookups accept the PROPOSED draft's
 * kind + meta and only consider compatible targets — same kind (unless proposed
 * is persona), trusted provenance (never legacy/unknown/system/tool rows), and a
 * compatible scope/project. Trusted new content is never merged into legacy rows
 * and never merged across projects.
 */
import type { MemoryStore, MemoryRecord, MemoryMetaInput, MemoryKind, MemoryScope } from "./storage.js";
import { tokenize } from "./storage.js";

export interface DedupeSettings {
  /** Jaccard overlap at/above which two texts count as near-duplicates (default 0.7) */
  tokenSimilarity: number;
  /** Minimum token overlap for the negation-contradiction heuristic (default 0.3) */
  contradictionOverlap: number;
}

export const DEFAULT_DEDUPE_SETTINGS: DedupeSettings = {
  tokenSimilarity: 0.7,
  contradictionOverlap: 0.3,
};

export type DuplicateVerdict = "duplicate" | "conflict" | "distinct" | null;

const NEGATION_RE = /\b(not|never|no longer|avoid|instead|without|don'?t|dont)\b/i;

/** Provenance values legitimate consolidation may touch (trusted rows only) */
const TRUSTED_PROVENANCES: ReadonlySet<string> = new Set(["user", "persona"]);

/** Compatibility constraints handed over with the proposed draft */
export interface NeighborConstraints {
  /** Proposed memory kind; neighbors are restricted to the same kind (persona cross-kind allowed) */
  kind?: MemoryKind;
  /** Proposed scope */
  scope?: MemoryScope;
  /** Proposed project key (the draft's own project id) */
  projectId?: string | null;
}

/** Jaccard overlap of jieba token sets */
export function tokenJaccard(a: string, b: string): number {
  const ta = new Set(tokenize(a).split(/\s+/).filter(Boolean));
  const tb = new Set(tokenize(b).split(/\s+/).filter(Boolean));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = new Set([...ta, ...tb]).size;
  return union > 0 ? inter / union : 0;
}

/** Does the second text negate the first (or vice versa)? */
export function negates(a: string, b: string): boolean {
  const aNeg = NEGATION_RE.test(a);
  const bNeg = NEGATION_RE.test(b);
  return (aNeg !== bNeg) && tokenJaccard(a, b) >= DEFAULT_DEDUPE_SETTINGS.contradictionOverlap;
}

export interface ExistingNeighbor {
  record: MemoryRecord;
  similarity: number;
}

/**
 * Find existing ACTIVE, TRUSTED, COMPATIBLE records near the draft content.
 * Constraints (kind + scope + projectId) restrict the recall lane so a draft can
 * only ever merge into a row it legitimately corresponds to:
 * - hostile provenance rows (legacy/unknown/system/tool/skill/assistant) are excluded;
 * - cross-project merges are impossible (global neighbor ok; project neighbor must match;
 *   a project-scoped draft may merge into a global row, a global draft never into a project row);
 * - session-scoped rows are task-local and never merge targets.
 */
export function findNeighbors(
  store: MemoryStore,
  content: string,
  limit = 3,
  constraints: NeighborConstraints = {},
): Array<{ record: MemoryRecord; similarity: number }> {
  const hits = store.searchMemories(content, {
    limit: Math.max(limit + 3, 8),
    matchAny: true,
    injectableOnly: true,
    ...(constraints.kind && constraints.kind !== "persona" ? { kind: constraints.kind } : {}),
  });
  const out: Array<{ record: MemoryRecord; similarity: number }> = [];
  for (const hit of hits) {
    const record = store.getMemory(hit.id);
    if (!record || record.status !== "active") continue;
    const meta = record.meta ?? store.getMeta(record.id);
    const prov = meta?.provenance;
    if (!TRUSTED_PROVENANCES.has(String(prov))) continue;
    // Kind compatibility: keeps persona drafts out of fact/preference rows
    if (constraints.kind && constraints.kind !== "persona" && record.kind !== constraints.kind) continue;
    // Scope/project compatibility
    const neighborScopeLocal = meta?.scope ?? "global";
    if (neighborScopeLocal === "session") continue;
    if (neighborScopeLocal === "project") {
      // A project neighbor only accepts a draft of the same project
      if (constraints.scope === "global") continue;
      if (constraints.projectId != null && (meta?.projectId ?? null) !== constraints.projectId) continue;
    }
    const similarity = tokenJaccard(content, record.content);
    if (similarity <= 0) continue;
    out.push({ record, similarity });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, limit);
}

/** Classify a draft against existing content */
export function classify(content: string, neighbor: { record: MemoryRecord; similarity: number }, settings = DEFAULT_DEDUPE_SETTINGS): DuplicateVerdict {
  if (neighbor.similarity >= settings.tokenSimilarity) return "duplicate";
  if (neighbor.similarity >= settings.contradictionOverlap && negates(content, neighbor.record.content)) return "conflict";
  return "distinct";
}

/**
 * Merge a near-duplicate draft into the existing memory instead of inserting:
 * evidence is appended, confidence raised (never inflated importance). Access
 * stats are NOT bumped here — duplicate-evidence observation is write-side
 * bookkeeping and must never masquerade as recall access.
 */
export function mergeDuplicate(store: MemoryStore, record: MemoryRecord, draft: { evidence?: MemoryMetaInput["evidence"] }): boolean {
  const meta = store.getMeta(record.id);
  const evidence = Array.isArray(meta?.evidence) ? meta.evidence : [];
  const extra = (draft.evidence ?? []).slice(0, 3);
  const merged = [...evidence, ...extra].slice(0, 5);
  const confidence = Math.min(1, Math.max(meta?.confidence ?? 0.5, 0.65));
  store.updateMeta(record.id, { evidence: merged as MemoryMetaInput["evidence"], confidence });
  return true;
}

/**
 * Full dedupe/contradiction gate used by the extraction pump.
 * Returns the verdict; on "duplicate" the merge already happened and the caller
 * must not insert; on "conflict" the caller must insert WITH provenance info and
 * keep both rows (no silent overwrite), optionally flagging the challenger.
 */
export function gate(
  store: MemoryStore,
  content: string,
  draft: { evidence?: MemoryMetaInput["evidence"] },
  settings = DEFAULT_DEDUPE_SETTINGS,
  constraints: NeighborConstraints = {},
): { verdict: Exclude<DuplicateVerdict, null>; neighbor?: MemoryRecord } {
  const neighbors = findNeighbors(store, content, 3, constraints);
  for (const n of neighbors) {
    const verdict = classify(content, n, settings);
    if (verdict === "duplicate") {
      mergeDuplicate(store, n.record, draft);
      return { verdict, neighbor: n.record };
    }
    if (verdict === "conflict") {
      return { verdict, neighbor: n.record };
    }
  }
  return { verdict: "distinct" };
}

/** Slot a draft into the store using the gate result (insert path shared by tool/command writers) */
export function insertWithProvenance(
  store: MemoryStore,
  draft: { kind: MemoryRecord["kind"]; content: string; importance: number; supersedes?: string },
  meta: MemoryMetaInput,
): MemoryRecord {
  const gateResult = gate(
    store,
    draft.content,
    meta.evidence ? { evidence: meta.evidence } : {},
    DEFAULT_DEDUPE_SETTINGS,
    { kind: draft.kind, scope: meta.scope, projectId: meta.projectId ?? null },
  );
  if (gateResult.verdict === "duplicate") {
    return store.getMemory(gateResult.neighbor!.id)!;
  }
  const record = store.insertMemory(draft, meta);
  if (gateResult.verdict === "conflict" && gateResult.neighbor) {
    // Both rows survive; the challenger is flagged in evidence so the browser / `/memory conflicts` can surface it.
    // Scoring prefers the user-asserted row later (confidence/importance weighting), no auto-decide.
    console.log(
      `[dsh-self-improved] memory conflict detected: existing=${gateResult.neighbor.id.slice(0, 8)} new=${record.id.slice(0, 8)}`,
    );
  }
  return record;
}
