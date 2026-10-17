// Static/unit fixture for the rc.2 client.js settings boundary
// (MIGRATION-V0.2.md Phase A: ConfigForms consumer + volatile Config + secrets).
// Structural source checks + behavior replay; mounted-browser gates remain
// tracked separately (isolated-profile browser verification is a Phase A
// runtime gate and is NOT claimed by this file).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../client.js", import.meta.url), "utf8");

const both = (key, label) => {
  const hits = [...src.matchAll(new RegExp(`^      ${key}: "`, "gm"))].length;
  assert.equal(hits, 2, `${label ?? key} present in both dictionaries (zh+en)`);
};

for (const key of [
  "nav", "tabConfig", "tabMemories", "intro", "helpTitle", "unavailable", "loading",
  "groupMaster", "groupModules", "groupStorage", "groupExtract", "groupRecall",
  "groupConsolidate", "groupEvolve", "groupHousekeeping", "groupReview", "groupEpisodes",
  "episodeEnableWarning", "save", "saved", "saving", "error", "conflict", "dirtyBadge",
  "browserEpisodesDisabled", "browserEpisodePurge", "browserEpisodeDryReview",
  "browserEpisodeDetailTitle", "secretHint", "resetScoped", "resetConfirm",
  "conflictKeep", "conflictDiscard", "conflictDiscardConfirm", "dirtySummary",
  "restartNote", "overridden", "secretSet", "secretUnset",
]) both(key);
assert.equal([...src.matchAll(/fEpEnabledHint: .*configured provider/g)].length, 2, "both locale hints disclose provider transfer");
assert.equal([...src.matchAll(/episodeEnableWarning: .*configured LLM provider/g)].length, 2, "both enable confirmations disclose provider transfer");
assert.doesNotMatch(src, /Nothing leaves this machine|Fully local/, "episode disclosure does not claim all data stays local");

// ── 1. No removed private settingsScope anywhere; ConfigForms is the seam ──
assert.ok(!src.includes("settingsScope"), "the removed private settingsScope API must not be referenced");
assert.ok(/ctx\.get\("configForms"\)/.test(src), "the entry's form derives from the shared configForms service");

// ── 2. Entry-addressed consumer: subscribe + unsubscribeAll, never dispose ─
assert.ok(/form\.subscribe\(/.test(src), "binding subscribes to the shared form");
assert.ok(/unsubscribeAll: unsubscribe/.test(src), "binding exposes the provider subscription disposer (unsubscribe)");
assert.ok(!/form\.dispose\(/.test(src), "the shared form is provider-owned: consumers never dispose it");
assert.ok(/return formBinding\.unsubscribeAll/.test(src),
  "the plugin effect registers the provider subscription disposer so navigations only unsubscribe");
assert.ok(/state\.listeners\.delete\(listener\)/.test(src), "unsubscribe removes ONLY this consumer's listener");

// ── 3. Dirty-path mutation with a baseline revision fence ─────────────────
assert.ok(/state\.dirty\.push\(/.test(src), "edits record dirty dotted paths");
assert.match(src, /state\.dirty\.push/, "dirty set is path-keyed");
assert.ok(/state\.baselineRevision = snap\.revision/.test(src),
  "the first edit pins the baseline revision (edit-baseline fence)");
assert.ok(/form\.mutate\(ops, fence\)/.test(src),
  "a save mutates ONLY the dirty paths with the captured baseline revision fence");
assert.ok(/state\.conflict = \{ kind: "refused"/.test(src) || /state\.conflict = \{ kind: "external"/.test(src),
  "a refused/external revision change lifts the visible stale-conflict state");
assert.ok(/rebaseDirty|discardDirty/.test(src), "conflict offers explicit rebase/discard actions");
assert.ok(/role: "alert"/.test(src), "conflict state renders as an alert (visible failure)");
assert.ok(/conflictKeep/.test(src) && /conflictDiscard/.test(src),
  "conflict keeps dirty edits by default with an explicit discard option"); // preserved draft
assert.ok(/resetScoped/.test(src), "scoped reset exists (no reset-everything button)");
assert.ok(!/ops: FIELDS\.map\(function \(f\) \{ return \{ op: "unset"/.test(src),
  "the legacy reset-all listed-unsets write is gone");

// Select fallback replay: an unset provenanceFilter renders the strict fallback.
const NS_FIELDS = [
  { path: ["extract", "provenanceFilter"], type: "select", options: ["strict", "off"], fallback: "strict" },
  { path: ["recall", "strategy"], type: "select", options: ["keyword", "hybrid"] },
];
NS_FIELDS.forEach((f) => { f.key = f.path.join("."); });
function getPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur === null || cur === void 0 || typeof cur !== "object") return void 0;
    cur = cur[p];
  }
  return cur;
}
function draftOfReplay(draft, value, f) {
  if (f.type === "select" && (draft[f.key] === void 0 || draft[f.key] === "") && f.fallback !== void 0) {
    const cur = getPath(value, f.path);
    return cur === void 0 || cur === null || cur === "" ? String(f.fallback) : String(cur);
  }
  return draft[f.key] !== void 0 ? draft[f.key] : String(getPath(value, f.path) ?? "");
}
const unsetValue = {};
const offValue2 = { extract: { provenanceFilter: "off" } };
assert.equal(draftOfReplay({}, unsetValue, NS_FIELDS[0]), "strict", "unset select renders fallback");
assert.equal(draftOfReplay({ "extract.provenanceFilter": "off" }, offValue2, NS_FIELDS[0]), "off");
assert.equal(draftOfReplay({ "extract.provenanceFilter": "" }, unsetValue, NS_FIELDS[0]), "strict");
assert.equal(draftOfReplay({}, unsetValue, NS_FIELDS[1]), "", "selects without a fallback keep the previous behavior");

// ── 4. Secrets: presence-only — no credential echo path ───────────────────
assert.ok(/secretsByPath\[f\.key\]/.test(src), "secret presence renders from the redacted secrets sidecar");
assert.ok(/placeholder: isSecret \? \(secretSet \? "••••••••"/.test(src),
  "a stored secret renders only presence markers, never the value");
assert.match(src, /if \(!d\) return; \/\/ blank keeps/, "a blank secret input keeps the stored key");
assert.ok(!/\.value\b[^;]*apiKey/.test(src), "no code path reads a redacted apiKey VALUE into a draft");
assert.equal([...src.matchAll(/fEmbKey: "([^"]*)"/g)].length, 2, "fEmbKey label present in both dictionaries");
assert.ok(/role\("secret"\)|secret/.test(src), "the secret hint explains presence-only behavior");

// ── 5. Lost-draft protection: draft state lives in the apply-scoped binding ─
assert.match(src, /var formBinding = bindSettingsForm\(ctx\);/, "settings-form binding created once in apply()");
// The panel is the INTENDED four-tab composition (Overview/Sessions/Settings/
// Memory); the earlier two-tab literal is superseded, and the section wiring
// must still be keyed by the active tab.
assert.match(src, /tab === "overview" \? h\(OverviewSection, Object\.assign\(\{ key: tab(?:, goTo: setTab)? \}, props\)\) : tab === "sessions" \? h\(SessionsSection, Object\.assign\(\{ key: tab \}, props\)\) : tab === "config" \? h\(MemorySection, Object\.assign\(\{ key: tab \}, props\)\) : h\(BrowserSection, Object\.assign\(\{ key: tab \}, props\)\)/,
  "tab switching mounts the SAME shared binding (no per-tab state loss)");

// ── 6. Typed business remote is wired (no Config-as-RPC rows) ──────────────
assert.ok(/remote\.\$mount\(\{ package: "dsh-self-improved", descriptors: BUSINESS_DESCRIPTORS \}\)/.test(src),
  "the client mounts its typed business contribution via $mount");
assert.ok(src.includes('ns: "dsh-self-improved-browser"') === false,
  "the legacy browser Config-namespace action channel is not referenced");
assert.ok(!src.includes("api.settings.mutate"), "no client write goes through settings-as-RPC Config fields");
assert.ok(/api\.prepareMutation/.test(src) && /\{ token \}/.test(src),
  "mutating browser ops run the stage+echo one-shot challenge");
assert.ok(/\{ op: "set", path: f\.path, value: Boolean\(d\) \}/.test(src),
  "checkbox disable still writes set:false (unset would flip back to the default)");

// ── 7. Episode learning fields still exposed and consent-gated ────────────
const EPISODE_PATHS = [
  "episodeLearning.enabled", "episodeLearning.captureArguments", "episodeLearning.resultExcerptChars",
  "episodeLearning.retentionDays", "episodeLearning.reviewEnabled", "episodeLearning.confidenceFloor",
  "episodeLearning.expiryDays", "episodeLearning.operationalRecallEnabled", "episodeLearning.maxRecallResults",
  "episodeLearning.maxRecallChars", "episodeLearning.skillMinEpisodes", "episodeLearning.skillDraftsEnabled",
];
const fieldsBlock = src.match(/var FIELDS = \[[\s\S]*?\n\s*\];/);
assert.ok(fieldsBlock, "FIELDS block parses");
for (const p of EPISODE_PATHS) {
  const path = p.split(".");
  const pattern = new RegExp(`path: \\[${path.map((s) => `"${s}"`).join(", ")}\\]`);
  assert.match(fieldsBlock[0], pattern, `episodeLearning field exposed in the settings UI: ${p}`);
}
assert.match(src, /groupEpisodes: "enabled"/, "groupEpisodes visible while episode learning is off (else it can never be enabled)");
assert.match(src, /confirmConsent.*episodeEnableWarning|episodeEnableWarning.*confirmConsent|resetConfirm/, "episode first-enable consent confirmed at the save boundary");
assert.match(src, /collapse\("episodes"/, "episodes panel rendered");
assert.match(src, /episodeModal/, "episode detail modal rendered");
assert.equal([...src.matchAll(/browserSummary: "\{n\} memories[^\n]*\{e\} tool episodes"/g)].length, 2, "browserSummary shows the episode count in both dictionaries");

// ── 8. Accessibility gates carried by source (mounted browser checks remain open) ─
assert.match(src, /__dsi_switch input:focus-visible \+ \.__dsi_switchTrack/, "slide switch has a visible keyboard focus treatment");
assert.match(src, /ariaLabel: t\(f\.label\)|aria-label/, "form controls carry accessible names");
assert.match(src, /htmlFor: "dsi-"/, "labels are bound to inputs via htmlFor");
assert.match(src, /role: "dialog", "aria-modal": true/, "modals are semantic dialogs");
assert.match(src, /Escape/, "Escape closes modals/editors");
assert.match(src, /"aria-expanded": isOpen/, "collapsible headers expose expanded state via buttons");

// ── 9. A11y: dialog focus lifecycle (focus-in, Tab trap, focus return) + hidden-by-policy classes ─
assert.match(src, /dialogFocus\.trap\(e\)/, "dialog Tab cycling is trapped inside the modal");
assert.match(src, /dialogFocus\.open\(\)/, "opening a detail modal captures the opener for focus return");
assert.match(src, /dialogFocus\.restore\(\)/, "closing a modal restores focus to the opener");
assert.match(src, /ref: dialogFocus\.focusNode/, "focus lands inside the opened dialog (no behind-modal start)");
assert.match(src, /f\.uiClass === "migration-only" \|\| f\.uiClass === "retired"/,
  "migration-only/retired fields are not rendered in the ordinary form (hidden ≠ forgotten: they stay in the inventory)");

console.log("test-settings-ui: PASS (rc.2 client boundary static + replay checks)");
