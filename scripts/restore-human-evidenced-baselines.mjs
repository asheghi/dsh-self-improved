#!/usr/bin/env node
/**
 * One-shot repair of rows over-demoted by retro-scrub-provenance: rows whose facts
 * were verbatim-stated by the human in TOP-LEVEL (delegationDepth 0) sessions got
 * demoted only because the later seeding step APPENDED subagent-cited evidence
 * entries. This script verifies the human evidence is genuinely present in the
 * top-level session logs (verbatim snippet checked against source.kind=user
 * messages of the zstd session store), restores it (dropping subagent-cited
 * evidence), resets provenance/status, and re-pins the surviving curated baseline.
 *
 * Pin target after the repair (≤15, no duplicates):
 *   laptop/Omarchy · server fact · AI workloads · works-locally/offloads ·
 *   delegation roles · the two legacy-accepted rows.
 *   approval-never + Obsidian vault STAY demoted: no verbatim human evidence
 *   exists in top-level logs (approval policy appears only as plugin notices;
 *   the vault phrase only as skill-catalog/subagent-report text).
 *
 * Run: node scripts/restore-human-evidenced-baselines.mjs [--dry-run]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { MemoryStore, defaultMemoryDir } from "../lib/storage.js";

const dry = process.argv.slice(2).includes("--dry-run");
const store = new MemoryStore(defaultMemoryDir());
const db = store.db;
const sessionsRoot = join(resolveDshHome(undefined, process.env), "sessions");

/** Read one stored session's human (source.kind=user) message texts from the zstd log. */
function humanTextsOf(sessionId) {
  let dir = "";
  for (const grp of readdirSync(sessionsRoot)) {
    const p = join(sessionsRoot, grp, sessionId);
    try {
      if (statSync(p).isDirectory()) { dir = p; break; }
    } catch { /* keep looking */ }
  }
  if (!dir) return null; // session not in the store
  const out = [];
  try {
    const lines = execFileSync("zstd", ["-dc", join(dir, "session.jsonl.zstd")], { maxBuffer: 1 << 26 }).toString().split("\n");
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e?.type !== "user/message") continue;
        const d = e.data ?? {};
        const kind = d.source?.kind;
        const c = d.content;
        const txt = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text ?? "").join("\n") : "";
        if (kind === "user" && txt.trim()) out.push(txt);
      } catch { /* skip malformed line */ }
    }
  } catch { /* unreadable log */ }
  return out;
}

const SERVER_SID = "session-b7c2881f-ec49-4d61-a25e-7279a6fa1210";
const SERVER_SNIPPET = 'remember that I have a headless ubuntu server at home reachable at "ssh bahman@100.82.9.67"  it has a llama.cpp configured with routing also with comfy-ui';
const DEVICE_SID = "session-b1b9c294-538e-4f47-a5c3-3cda3f4eac5f";
const DEVICE_SNIPPET = "remember my device is a Asus g16 zephyrus";
const DELEGATION_SID = "session-742d37b9-e7c1-44f0-8633-ab1bf0a5d195";
const DELEGATION_SNIPPET = "you're supposed to be the smart manager and move most of the work to glm-5.3 flash.  spend my precous gpt 5.6 sol token wisely!";
const VAULT_SID = "session-742d37b9-e7c1-44f0-8633-ab1bf0a5d195";
const VAULT_SNIPPET = "we're working on this plugin as a project now, obsidian memory is something specific to my personal dsh setup";

const textsOf = new Map();
for (const sid of [SERVER_SID, DEVICE_SID, DELEGATION_SID, VAULT_SID]) textsOf.set(sid, humanTextsOf(sid) ?? []);
const haveUserSnippet = (sid, snippet) => {
  const needle = snippet.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80);
  return (textsOf.get(sid) ?? []).some((t) => t.replace(/\s+/g, " ").trim().toLowerCase().includes(needle));
};

// Every entry is verified against the top-level session log BEFORE writing.
const restorePlan = [
  { id: "d41666a7-6709-44dc-8e65-65b2fa7baa89", evidence: [{ sessionId: SERVER_SID, snippet: SERVER_SNIPPET }] },
  { id: "d0dd93bf-a82a-40a7-b3f8-3ec584290a00", evidence: [{ sessionId: SERVER_SID, snippet: SERVER_SNIPPET }] },
  { id: "822dec5d-59cc-4e01-b755-082e1b843a85", evidence: [{ sessionId: DEVICE_SID, snippet: DEVICE_SNIPPET }] },
  { id: "ed964932-c335-47cf-a636-4e6610f4f769", evidence: [{ sessionId: DELEGATION_SID, snippet: DELEGATION_SNIPPET }] },
  // Restored in round 2: human verbatim turn at seq=42449 in the top-level session.
  // Only ONE English vault row exists (eb054bf3); duplicate legacy rows are
  // decayed/quarantined unknown-provenance and are deliberately not restored.
  { id: "eb054bf3-a8dd-4c56-9007-f21c7949bc66", evidence: [{ sessionId: VAULT_SID, snippet: VAULT_SNIPPET }] },
];

let restored = 0;
for (const plan of restorePlan) {
  for (const ev of plan.evidence) {
    if (!haveUserSnippet(ev.sessionId, ev.snippet)) {
      console.error(`[restore] ABORT: verbatim snippet not found as human text in ${ev.sessionId} for row ${plan.id}`);
      process.exit(1);
    }
  }
  const meta = store.getMeta(plan.id);
  if (!meta) {
    console.error(`[restore] ABORT: row ${plan.id} has no meta`);
    process.exit(1);
  }
  console.log(`[restore] ${plan.id} (${String(meta.provenance)}/${String(meta.sessionId ?? "no-session")}) <- human evidence in ${plan.evidence.map((e) => e.sessionId).join(", ")}`);
  if (!dry) {
    // one restoring write per short transaction; keep the forgotten meta.session_id
    // (extraction-time pointer) but let provenance/evidence drive trust.
    db.exec("BEGIN IMMEDIATE");
    try {
      store.updateMeta(plan.id, { provenance: "user", evidence: plan.evidence });
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      console.error("[restore] ABORT on write:", String(error));
      process.exit(1);
    }
    // un-quarantine rows the scrub had sent to quarantine (now they have human evidence)
    if (store.getMemory(plan.id)?.status !== "active") store.setMemoryStatus(plan.id, "active");
  }
  restored++;
}

// Rebuild the curated baseline to EXACTLY the agreed entries (slot per entry, no duplicates).
const PIN_TARGETS = [
  { slot: 7, id: "6948a54a-b538-446a-a1f9-c406b337b513" }, // laptop Omarchy (kept pin)
  { slot: 8, id: "83bc7760-1959-42d6-aa1c-c5881285ba71" }, // legacy-accepted
  { slot: 9, id: "bb571a89-8643-4cd3-b4c8-2052fcf57498" }, // legacy-accepted
  { slot: 1, id: "d41666a7-6709-44dc-8e65-65b2fa7baa89" }, // server fact
  { slot: 2, id: "d0dd93bf-a82a-40a7-b3f8-3ec584290a00" }, // AI workloads llama.cpp/ComfyUI
  { slot: 3, id: "822dec5d-59cc-4e01-b755-082e1b843a85" }, // works locally + offloads
  { slot: 4, id: "ed964932-c335-47cf-a636-4e6610f4f769" }, // delegation roles
  { slot: 5, id: "eb054bf3-a8dd-4c56-9007-f21c7949bc66" }, // Obsidian vault
];
const pinnedIds = new Set(PIN_TARGETS.map((p) => p.id));
let unpinned = 0;
let repinned = 0;
if (!dry) {
  for (const pin of db.prepare(`SELECT slot, memory_id FROM baseline`).all()) {
    if (!pinnedIds.has(String(pin.memory_id))) {
      db.prepare(`DELETE FROM baseline WHERE slot = ?`).run(pin.slot);
      unpinned++;
    }
  }
  for (const target of PIN_TARGETS) {
    // Keep at most one pin per memory row (unique index) — move/rewrite idempotently.
    db.prepare(`DELETE FROM baseline WHERE memory_id = ?`).run(target.id);
    db.prepare(`INSERT INTO baseline (slot, memory_id, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(slot) DO UPDATE SET memory_id = excluded.memory_id, updated_at = excluded.updated_at`)
      .run(target.slot, target.id, Date.now());
    repinned++;
  }
}

if (!dry) {
  const integrity = store.db.prepare(`PRAGMA integrity_check`).get();
  console.log(`[restore] integrity_check: ${JSON.stringify(integrity)}`);
}
console.log(`[restore] done: restored=${restored}, unpinnedStray=${unpinned}, pinsWritten=${repinned}`);
store.close();
