#!/usr/bin/env node
/**
 * Deterministic persona rebuild from the SURVIVING trusted rows (post provenance
 * scrub). Used instead of an LLM synthesis round so the new version's content is
 * auditable line-by-line and structurally guaranteed not to duplicate (the v56
 * bug): every section heading appears exactly once, assembled in fixed order.
 *
 * Selection mirrors Consolidator.synthesizePersona's material gate:
 * active + provenance 'user' + scope 'global' + kind fact/preference.
 * Rows demoted to provenance 'coordinator' (delegated-session evidence) are out.
 *
 * Run: node scripts/rebuild-persona.mjs [--dry-run]
 */
import { MemoryStore, defaultMemoryDir } from "../lib/storage.js";
import { sanitizePersonaContent } from "../lib/consolidate.js";

const dry = process.argv.slice(2).includes("--dry-run");
const store = new MemoryStore(defaultMemoryDir());
const db = store.db;
const rows = db
  .prepare(
    `SELECT m.id, m.kind, m.content, m.importance
     FROM memories m JOIN memories_meta mm ON mm.memory_id = m.id
     WHERE m.status = 'active' AND mm.provenance = 'user' AND mm.scope = 'global'
       AND m.kind IN ('fact','preference')`,
  )
  .all()
  .sort((a, b) => Number(b.importance) - Number(a.importance));

const sections = { "Basic Info": [], "Preferences & Habits": [], "Working Style": [], "Known Conventions": [] };
for (const row of rows) {
  const content = String(row.content).trim();
  const kind = String(row.kind);
  if (kind === "preference") {
    sections["Preferences & Habits"].push(`- ${content} [${kind}]`);
    continue;
  }
  if (/^(User|Operator)\b/i.test(content) && /\b(server|laptop|machine|computer|runs?|owns?|device)\b/i.test(content)) {
    sections["Basic Info"].push(`- ${content} [${kind}]`);
  } else if (/\b(workboard|board|AppShell|routing|authentication|FTS|recall|migration|quarantin|extraction|decay|harness)\b/i.test(content)) {
    sections["Known Conventions"].push(`- ${content} [${kind}]`);
  } else {
    sections["Working Style"].push(`- ${content} [${kind}]`);
  }
}

const out = ["## Basic Info", ...sections["Basic Info"], "", "## Preferences & Habits", ...sections["Preferences & Habits"], "", "## Working Style", ...sections["Working Style"], "", "## Known Conventions", ...sections["Known Conventions"]]
  .join("\n");
const final = sanitizePersonaContent(out).replace(/\n{3,}/g, "\n\n");

console.log(final);
console.log(`[rebuild] rows in: ${rows.length}, sections: ${Object.entries(sections).map(([k, v]) => `${k}=${v.length}`).join(", ")}`);
if (!dry) {
  const ver = store.savePersona(final);
  console.log(`[rebuild] persona version saved: v${ver}`);
}
store.close();
