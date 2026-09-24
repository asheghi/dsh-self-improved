// Static/unit fixture for client.js settings UI fixes:
// 1. unset/blank provenanceFilter select renders the configured strict fallback
// 2. label polish in both locale dictionaries (no "(strict/off)" suffix, no "(default off)", reset relabel)
// 3. reset refreshes the draft from the authoritative snapshot after a successful unset
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../client.js", import.meta.url), "utf8");

// ── 1. Select fallback covers valueToDraft's "" initialization ─────────────
assert.ok(
  /f\.type === "select" && \(draft\[f\.key\] === void 0 \|\| draft\[f\.key\] === ""\)/.test(src),
  "fieldDraft must treat an empty-string draft as unset for the select fallback",
);
// The select field declares its schema fallback.
assert.ok(
  /path: \["extract", "provenanceFilter"\], label: "fProvenance", type: "select", options: \["strict", "off"\], includeBlank: false, fallback: "strict"/.test(src),
  "provenanceFilter must declare fallback 'strict'",
);

// Unit test the real fallback logic by replaying valueToDraft + fieldDraft against a fixture.
const FIELDS_NS = [
  { path: ["extract", "provenanceFilter"], type: "select", options: ["strict", "off"], fallback: "strict" },
  { path: ["recall", "strategy"], type: "select", options: ["keyword", "hybrid"] },
];

function getPath(obj, path) {
  let cur = obj;
  for (const p of path) {
    if (cur === null || cur === void 0 || typeof cur !== "object") return void 0;
    cur = cur[p];
  }
  return cur;
}
function valueToDraft(value) {
  const out = {};
  for (const f of FIELDS_NS) {
    f.key = f.path.join(".");
    out[f.key] = String(getPath(value, f.path) ?? "");
  }
  return out;
}
function fieldDraft(draft, value, f) {
  if (f.type === "select" && (draft[f.key] === void 0 || draft[f.key] === "") && f.fallback !== void 0) {
    const cur = getPath(value, f.path);
    return cur === void 0 || cur === null || cur === "" ? String(f.fallback) : String(cur);
  }
  return draft[f.key] !== void 0 ? draft[f.key] : String(getPath(value, f.path) ?? "");
}

// Unset value + freshly initialized draft → renders the strict fallback, never a dead "".
const unsetValue = {};
assert.equal(fieldDraft(valueToDraft(unsetValue), unsetValue, FIELDS_NS[0]), "strict", "unset select renders fallback");
// An explicit user value wins over the fallback.
const offValue = { extract: { provenanceFilter: "off" } };
assert.equal(fieldDraft(valueToDraft(offValue), offValue, FIELDS_NS[0]), "off");
// Stale "" draft (e.g. after server unset elsewhere) still resolves deterministically.
assert.equal(fieldDraft({ "extract.provenanceFilter": "" }, unsetValue, FIELDS_NS[0]), "strict");
// Selects without a fallback keep the existing "" behavior.
assert.equal(fieldDraft(valueToDraft(unsetValue), unsetValue, FIELDS_NS[1]), "");
assert.equal(fieldDraft(valueToDraft({ recall: { strategy: "hybrid" } }), { recall: { strategy: "hybrid" } }, FIELDS_NS[1]), "hybrid");

// Save never materializes an unset field as an override just because it renders its fallback.
// Replay of the select diff branch from onSave:
function selectDiffOp(draft, current, f) {
  const d = fieldDraft(draft, { extract: { provenanceFilter: current } }, f);
  const cur = current ?? "";
  if (String(d) === String(cur)) return null;
  if (String(cur) === "" && f.fallback !== void 0 && String(d) === String(f.fallback)) return null;
  return String(d) ? { op: "set", value: d } : { op: "unset" };
}
assert.equal(selectDiffOp(valueToDraft({}), void 0, FIELDS_NS[0]), null, "unset fallback equals default: no write");
assert.deepEqual(selectDiffOp({ "extract.provenanceFilter": "off" }, void 0, FIELDS_NS[0]), { op: "set", value: "off" });
assert.deepEqual(selectDiffOp({ "extract.provenanceFilter": "strict" }, "off", FIELDS_NS[0]), { op: "set", value: "strict" });

// ── 2. Label polish in BOTH dictionaries ───────────────────────────────────
for (const m of src.matchAll(/fProvenance: "([^"]*)"/g)) {
  assert.equal(m[1], "Extraction provenance filter", "fProvenance suffix removed");
}
for (const m of src.matchAll(/fScenesEnabled: "([^"]*)"/g)) {
  assert.equal(m[1], "Scene grouping (L2 scenes)", "fScenesEnabled default wording moved to hint");
}
for (const m of src.matchAll(/fScenesEnabledHint: "([^"]*)"/g)) {
  assert.ok(m[1].startsWith("Default off:"), "scenes hint carries the default wording");
}
for (const m of src.matchAll(/reset: "([^"]*)"/g)) {
  assert.equal(m[1], "Reset to defaults", "reset button relabeled");
}

// ── 3. Reset refreshes the draft from the authoritative snapshot ───────────
const onReset = src.slice(src.indexOf("function onReset()"), src.indexOf("// Collapse groups"));
assert.ok(/ops: FIELDS\.map\(function \(f\) \{ return \{ op: "unset", path: f\.path \}; \}\)/.test(src), "reset still unsets every field");
assert.ok(
  /var fresh = scope\.getSnapshot\(\);[\s\S]{0,200}setDraft\(Object\.assign\(\{\}, valueToDraft\(fresh\.value\)\)\)/.test(onReset),
  "successful reset refreshes the draft from the authoritative settings snapshot",
);
// Only the reset path refreshes drafts this way — save keeps its conflict/draft handling.
const onSave = src.slice(src.indexOf("function onSave()"), src.indexOf("function onReset()"));
assert.ok(!/valueToDraft\(fresh/.test(onSave), "save path unchanged");

console.log("test-settings-ui: PASS");
