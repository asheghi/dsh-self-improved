/**
 * Phase A runtime-config module (MIGRATION-V0.2.md settings boundary).
 *
 * This module is the single site where the plugin decides WHICH schema fields
 * are volatile (editable without remounting the plugin fiber) and which are
 * initialization-only (a change restarts the fiber through every effect-owned
 * disposer). The schemastery schema in index.ts carries the same decision
 * through `.volatile()` markers; this module keeps the POLICY documented in one
 * place and provides the typed helpers every runtime consumer uses.
 *
 * Field classification (schema-to-UI inventory contract):
 * - `enabled`, `debug`, `modules`, `extract`, `recall`, `consolidate`,
 *   `evolve`, `housekeeping`, `review`, `episodeLearning`, `continuity`: editable everyday/
 *   advanced values → explicitly volatile. A volatile update commits into the
 *   refs the plugin already holds and emits `loader/volatile-update`; the
 *   plugin re-applies into its live view instead of restarting.
 * - `storageRoot`: initialization-only (opens/owns the SQLite store). Kept
 *   NONVOLATILE on purpose: a storage-root change must go through the full
 *   restart lifecycle (store close under drain) and never rewrite a live
 *   store handle. Documented in MIGRATION-V0.2.md as an explicit migration
 *   workflow, not a live text-field write.
 * - `recall.embedding.apiKey`: schema-declared SECRET (`role('secret')`) so
 *   wire reads (settings describe) always redact it to a presence-only view;
 *   UI drafts never receive the value and a blank input keeps the current key.
 */
import type { Volatile, VolatileSnapshot } from "@deepseek-ai/cordis";
import { isVolatile } from "@deepseek-ai/cosmokit";

/**
 * True when the raw apply() config value for a field is a rc.2 volatile ref
 * (the schema marked the field `.volatile()` and the loader handed us the
 * stable reference instead of a plain value). Volatile refs are frozen
 * plain objects with a `get()` snapshot method and a write side-channel; the
 * shared `cosmokit.isVolatile` predicate identifies them across ESM copies.
 */
export function isVolatileRef(value: unknown): value is Volatile<unknown> {
  return isVolatile(value);
}

/**
 * Read one field as a plain current value: a volatile ref is dereferenced,
 * any other value passes through. Volatile refs are stable identities —
 * consumers that keep the ref get fresh values for free; anything that
 * captures a plain snapshot must re-read through this helper on
 * `loader/volatile-update`.
 */
export function readValue<T>(field: T | Volatile<T>): T {
  if (isVolatileRef(field)) {
    return (field as Volatile<T>).get() as T;
  }
  return field as T;
}

/**
 * Dedup/ref guard for reference-sensitive fields. Returns the current
 * immutable snapshot of a volatile field (recursively readonly).
 */
export function volatileSnapshot<T>(field: T | Volatile<T>): VolatileSnapshot<T> {
  return readValue(field) as VolatileSnapshot<T>;
}

/**
 * Field inventory consumed by tests and the client field table: every
 * editable dotted path plus its UI class.
 *
 * Classes (MIGRATION-V0.2.md settings inventory, extended per
 * MIGRATION-COORDINATOR-REVIEW.md round 48 to match the importer's field
 * mapping vocabulary in src/migration-v02.ts):
 * - `everyday`   — main-form values (master/scope/consent switches);
 * - `advanced`   — ordinary Advanced/accordion fields;
 * - `init-only`  — filesystem roots and lifecycle-invalidated paths
 *                  (storageRoot, evolve.skillSynthesis.skillsRoot): the value
 *                  is resolved ONCE at plugin start; a later live write must
 *                  never retarget a running filesystem/store handle. Runtime
 *                  enforcement lives in src/index.ts (effective value stays
 *                  the startup value; a live change only warns + needs a
 *                  restart), the UI shows the restart badge, and scoped
 *                  resets/saves skip them.
 * - `secret`     — role('secret') slots: presence-only on every wire read.
 * - `migration-only` — unsafe migration-only settings that must NEVER appear
 *                  in ordinary Advanced UI (e.g. extract.provenanceFilter='off'
 *                  provenance bypass — MIGRATION-V0.2.md "Unsafe provenance
 *                  bypass is migration-only"): still inventoried (hidden ≠
 *                  forgotten) but not rendered, saved, or reset by the live
 *                  form; recoverable only through the migration workflow.
 * - `retired`    — settings the plan retires (unsafe defaults like an
 *                  automatic bad-JSON fallback summarization); inventoried
 *                  for visibility, never write-enabled.
 */
export const FIELD_CLASSIFICATION: Readonly<
  Record<string, "everyday" | "advanced" | "init-only" | "secret" | "migration-only" | "retired">
> = {
  enabled: "everyday",
  "continuity.enabled": "everyday",
  "continuity.summaryEnabled": "everyday",
  "continuity.excludedSessionIds": "everyday",
  "continuity.excludedProjectIds": "everyday",
  debug: "advanced",
  "storageRoot": "init-only",
  "modules.capture": "everyday",
  "modules.extract": "everyday",
  "modules.consolidate": "advanced",
  "modules.evolve": "advanced",
  "modules.recall": "everyday",
  "modules.tools": "everyday",
  "searchLimit": "advanced",
  "extract.minImportance": "advanced",
  "extract.provider": "advanced",
  "extract.model": "advanced",
  "extract.intervalMinutes": "advanced",
  "extract.batchMaxChars": "advanced",
  "extract.maxOutputTokens": "advanced",
  "extract.timeoutMs": "advanced",
  "extract.dedup": "advanced",
  /* retired: recovering malformed model output by blindly summarizing raw
   * input is an unsafe default (malformed output must stay failed/retryable —
   * src/migration-v02.ts retires this path); inventoried, not write-enabled. */
  "extract.fallbackOnBadJson": "retired",
  "extract.flushDrain": "advanced",
  /* migration-only: provenanceFilter='off' bypasses the conservative
   * extraction gate — by the plan it exists only inside the migration
   * workflow, never as an ordinary advanced toggle. */
  "extract.provenanceFilter": "migration-only",
  "extract.requireEvidence": "advanced",
  "recall.strategy": "advanced",
  "recall.maxResults": "advanced",
  "recall.scoreThreshold": "advanced",
  "recall.timeoutMs": "advanced",
  "recall.maxInjectChars": "advanced",
  "recall.relevanceMargin": "advanced",
  "recall.minImportance": "advanced",
  "recall.maxInjectPerTurn": "advanced",
  "recall.embedding.baseUrl": "advanced",
  "recall.embedding.apiKey": "secret",
  "recall.embedding.model": "advanced",
  "recall.embedding.dimensions": "advanced",
  "recall.embedding.timeoutMs": "advanced",
  "consolidate.scenesEnabled": "advanced",
  "consolidate.sceneMaxMemories": "advanced",
  "consolidate.personaMaxMemories": "advanced",
  "consolidate.sceneBatchSize": "advanced",
  "evolve.decay.enabled": "advanced",
  "evolve.decay.minAgeDays": "advanced",
  "evolve.decay.threshold": "advanced",
  "evolve.decay.retentionDays": "advanced",
  "evolve.decay.maxActiveMemories": "advanced",
  "evolve.skillSynthesis.enabled": "advanced",
  "evolve.skillSynthesis.minImportance": "advanced",
  /* init-only filesystem root: a live edit must not retarget where skills are
   * written; startup value wins until a restart (same lifecycle as
   * storageRoot), matching the importer's "path not carried into live config". */
  "evolve.skillSynthesis.skillsRoot": "init-only",
  "evolve.skillSynthesis.prefix": "advanced",
  "evolve.skillSynthesis.maxSkills": "advanced",
  "housekeeping.personaVersions": "advanced",
  "housekeeping.maxScenes": "advanced",
  "housekeeping.sceneActiveRatio": "advanced",
  "housekeeping.conversationRetentionDays": "advanced",
  "review.enabled": "advanced",
  "review.time": "advanced",
  "episodeLearning.enabled": "everyday",
  "episodeLearning.captureArguments": "advanced",
  "episodeLearning.resultExcerptChars": "advanced",
  "episodeLearning.retentionDays": "advanced",
  "episodeLearning.reviewEnabled": "advanced",
  "episodeLearning.confidenceFloor": "advanced",
  "episodeLearning.expiryDays": "advanced",
  "episodeLearning.operationalRecallEnabled": "advanced",
  "episodeLearning.maxRecallResults": "advanced",
  "episodeLearning.maxRecallChars": "advanced",
  "episodeLearning.skillMinEpisodes": "advanced",
  "episodeLearning.skillDraftsEnabled": "advanced",
};

/**
 * Copy a (recursively readonly) volatile snapshot INTO an owned, mutable
 * plain tree IN PLACE. Nested plain objects recurse into the captured live
 * object; scalars/arrays are replaced.
 *
 * This is essential: volatile snapshots are recursively frozen. A shallow
 * `Object.assign(live.x, snapshot)` installs the FROZEN nested snapshot
 * objects into the live view (live.recall.embedding etc.), and the NEXT hot
 * edit then throws "Cannot assign to read only property ..." — reproduced
 * against the genuine rc.2 Loader in-process (probe: loader/volatile-update
 * was emitted, but the commit failed and applyHotSettingsUpdate never ran, so
 * the running pipeline kept the previous extraction/recall settings values).
 */
export function assignPlainTree(target: object, source: unknown): void {
  const dict = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source as Record<string, unknown>)) {
    const current = dict[key];
    if (
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      current !== null && typeof current === "object" && !Array.isArray(current)
    ) {
      assignPlainTree(current as object, value);
    } else {
      dict[key] = value;
    }
  }
}

/**
 * Dotted paths that must NOT take effect through a live remote form write:
 * the plugin resolves each of these ONCE at init (runtime enforcement in
 * src/index.ts) and a filesystem-root change must run the full restart
 * lifecycle. The schema still carries them under volatile groups (fidelity of
 * the schema shape is what the loader revalidates); the runtime simply keeps
 * the startup value effective until the restart applies it.
 */
export const INIT_ONLY_PATHS: readonly string[] = [
  "storageRoot",
  "evolve.skillSynthesis.skillsRoot",
];

/** Fields excluded from the ordinary Advanced/everyday UI by policy class. */
export const HIDDEN_FROM_UI_CLASSES: ReadonlySet<string> = new Set(["migration-only", "retired"]);
