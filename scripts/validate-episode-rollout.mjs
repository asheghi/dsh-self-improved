#!/usr/bin/env node
/**
 * Episode-learning rollout validation (Phase 7).
 *
 * Replays REAL DSH sessions from a sessions root through the actual capture
 * pipeline (installCapture flush handler → redaction → episode_events →
 * assembly), then verifies ON DISK (raw SQLite bytes, not the store API) that
 * no credential-shaped value from the raw session survived persistence.
 *
 * This is the plan's Phase 7 acceptance check:
 *   - real failure → retry → success evidence (episode counts + retry pairs)
 *   - stored arguments/results are redacted on disk
 *
 * Usage:
 *   node scripts/validate-episode-rollout.mjs --sessions-root <dir> --memory-dir <dir> \
 *        [--session <id>] [--pick N] [--max-events 4000]
 *
 * Default: analyze up to --pick 12 sessions, auto-select the best
 * failure→retry→success candidates, persist ONLY into --memory-dir
 * (never the live ~/.dsh), and print a JSON verdict. Exit 1 on any redaction hit.
 */
import { statSync, readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const sessionsRoot = arg("sessions-root", "");
const memoryDir = arg("memory-dir", "");
if (!sessionsRoot || !memoryDir) {
  console.error(JSON.stringify({ error: "usage: --sessions-root <dir> --memory-dir <dir> [--session id] [--pick N]" }));
  process.exit(2);
}
if (!existsSync(sessionsRoot) || !statSync(sessionsRoot).isDirectory()) {
  console.error(JSON.stringify({ error: `sessions-root is not a directory: ${sessionsRoot}` }));
  process.exit(2);
}

const { MemoryStore } = await import("../lib/storage.js");
const { installCapture } = await import("../lib/capture.js");
// dsh-session-persistence-jsonl is a HOST package (peer of the DSH checkout),
// not a plugin dependency — resolve it from the running DSH's node_modules.
let Jsonl;
{
  const dshModules = arg("dsh-node-modules", "/home/bahman/github/dsh/node_modules");
  const url = new URL(`file://${dshModules}/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`);
  try {
    Jsonl = (await import(url.href)).default;
  } catch (e) {
    console.error(JSON.stringify({ error: `cannot load dsh-session-persistence-jsonl from ${dshModules} (pass --dsh-node-modules): ${String(e).split("\n")[0]}` }));
    process.exit(2);
  }
}
const { Context } = await import("@deepseek-ai/cordis");

// ── 1. List real sessions via the production persistence layer ─────────────
const ctx = new Context();
ctx.sessions = { list: () => [] };
const p = new Jsonl(ctx, { root: sessionsRoot, compression: "zstd" });
const metas = await p.list();

const maxEvents = Number(arg("max-events", "4000"));
const pick = Number(arg("pick", "12"));

/** Credential-shaped probes extracted from RAW event payloads. */
function collectSecretProbes(event) {
  const probes = new Set();
  const scanText = (text) => {
    if (typeof text !== "string" || text.length < 8 || text.length > 5000) return;
    // JSON-style sensitive keys → their values
    const re = /"(?:password|passwd|pwd|secret|token|api[_-]?key|apiKey|authorization|cookie|privateKey|recoveryCode)"\s*:\s*"([^"]{8,200})"/gi;
    for (const m of text.matchAll(re)) probes.add(m[1]);
    // header / URL forms
    for (const m of text.matchAll(/(?:Bearer|bearer)\s+([A-Za-z0-9_\-./]{16,200})/g)) probes.add(m[1]);
    for (const m of text.matchAll(/(?:api[_-]?key|token|password|passwd)=([A-Za-z0-9_\-./]{16,200})/gi)) probes.add(m[1]);
    for (const m of text.matchAll(/Authorization:\s*Basic\s+([A-Za-z0-9+/=]{16,200})/gi)) probes.add(m[1]);
  };
  const walk = (v, depth = 0) => {
    if (v === null || v === undefined || depth > 6) return;
    if (typeof v === "string") return scanText(v);
    if (typeof v === "object") for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(event);
  return probes;
}

function trajectoryOf(events) {
  let calls = 0, results = 0, errors = 0, turnEnds = 0;
  const perTool = new Map(); // tool → { calls, errors, lastErrorSeq, successAfterError }
  for (const e of events) {
    if (e.type === "tool/call") {
      calls++;
      const name = e.data?.name ?? "unknown";
      const t = perTool.get(name) ?? { calls: 0, errors: 0, lastErrorSeq: -1, successAfterError: 0 };
      t.calls++;
      t.lastCallSeq = e.seq;
      perTool.set(name, t);
    } else if (e.type === "tool/result") {
      results++;
      const msg = e.data?.message ?? {};
      const isError = msg.isError === true || (Array.isArray(msg.content) && msg.content.some((b) => b?.type === "tool-result" && b.isError === true));
      if (isError) {
        errors++;
        // attribute to the most recently called tool (approximation; the real
        // pairing by callId happens in the capture/assembly pipeline)
        let best = null;
        for (const [name, t] of perTool) if (t.lastCallSeq !== undefined && (best === null || t.lastCallSeq > best.t.lastCallSeq)) best = { name, t };
        if (best) best.t.lastErrorSeq = e.seq;
      } else {
        let best = null;
        for (const [name, t] of perTool) if (t.lastCallSeq !== undefined && (best === null || t.lastCallSeq > best.t.lastCallSeq)) best = { name, t };
        if (best && best.t.lastErrorSeq >= 0 && e.seq > best.t.lastErrorSeq) best.t.successAfterError++;
      }
    } else if (e.type === "turn/end") turnEnds++;
  }
  const retries = [...perTool.entries()].filter(([, t]) => t.lastErrorSeq >= 0 && t.successAfterError > 0);
  return { calls, results, errors, turnEnds, retryTools: retries.map(([n]) => n) };
}

// ── 2. Select candidate sessions (or the explicit one) ─────────────────────
// --probe-scan N: quick raw scan of N sessions for credential-shaped values;
// reports the most probe-rich sessions and exits (no persistence). Useful to
// FIND the sessions the on-disk redaction check should then be run against.
if (arg("probe-scan")) {
  const budget = Number(arg("probe-scan"));
  const found = [];
  for (const meta of metas.slice(0, budget)) {
    let events;
    try {
      events = (await p.readFrom(meta.id, 0)).events;
    } catch {
      continue;
    }
    const probes = new Set();
    for (const e of events) for (const pr of collectSecretProbes(e)) probes.add(pr);
    if (probes.size > 0) found.push({ id: meta.id, cwd: meta.cwd, probes: probes.size, events: events.length });
  }
  found.sort((a, b) => b.probes - a.probes);
  console.log(JSON.stringify({ probeScan: { scanned: Math.min(budget, metas.length), withProbes: found.length, top: found.slice(0, 8) } }, null, 2));
  process.exit(0);
}

const wanted = arg("session", null);
const candidates = [];
let scanned = 0;
for (const meta of metas) {
  if (candidates.length >= pick && !wanted) break;
  if (scanned >= (wanted ? metas.length : pick * 6)) break;
  scanned++;
  // Explicit-session mode must not read every store: skip until the wanted id.
  if (wanted && meta.id !== wanted) continue;
  let events;
  try {
    events = (await p.readFrom(meta.id, 0)).events;
  } catch {
    continue;
  }
  if (!events || events.length === 0) continue;
  const hasTool = events.some((e) => e.type === "tool/call");
  if (!hasTool) continue;
  const traj = trajectoryOf(events.slice(0, maxEvents));
  const score = traj.errors * 10 + traj.retryTools.length * 25 + Math.min(traj.calls, 20);
  candidates.push({ id: meta.id, cwd: meta.cwd, n: events.length, traj, score, events });
}
candidates.sort((a, b) => b.score - a.score);
const chosen = wanted ? candidates.filter((c) => c.id === wanted) : candidates.slice(0, Math.min(3, candidates.length));
if (chosen.length === 0) {
  console.log(JSON.stringify({ verdict: "no-candidates", scanned, sessionsWithToolCalls: candidates.length, note: "no session with tool calls found under the pick budget" }));
  process.exit(0);
}

// ── 3. Flush through the REAL capture pipeline into the isolated store ─────
rmSync(memoryDir, { recursive: true, force: true });
mkdirSync(memoryDir, { recursive: true });
const store = new MemoryStore(memoryDir);
const flushed = [];
{
  const registrations = [];
  const fakeCtx = { on: (type, fn) => registrations.push({ type, fn }) };
  installCapture(
    fakeCtx,
    store,
    { enabled: () => true },
    undefined,
    { enabled: () => true, maxChars: () => 4000 },
  );
  const flush = registrations[0];
  if (!flush || flush.type !== "session/flush") {
    console.error(JSON.stringify({ error: "flush handler not registered" }));
    process.exit(2);
  }
  const probes = new Set();
  for (const c of chosen) {
    const session = { id: c.id, header: { cwd: c.cwd ?? "/tmp" }, events: c.events.slice(0, maxEvents) };
    for (const e of session.events) for (const pr of collectSecretProbes(e)) probes.add(pr);
    const t0 = performance.now();
    await flush.fn(session);
    flushed.push({ id: c.id, events: session.events.length, flushMs: Math.round(performance.now() - t0) });
  }
  var secretProbes = [...probes];
}

const counts = store.episodeCounts();
const total = Object.values(counts).reduce((a, b) => a + b, 0);
const episodes = store.listEpisodes({ limit: 200 });
const retryEvidence = [];
for (const ep of episodes) {
  const steps = store.getEpisodeSteps(ep.id);
  const failed = steps.filter((s) => s.isError === 1).map((s) => s.toolName);
  const ok = steps.filter((s) => s.isError === 0).map((s) => s.toolName);
  const retried = failed.filter((f) => ok.includes(f));
  if (retried.length > 0) retryEvidence.push({ episode: ep.id, status: ep.status, retriedTools: [...new Set(retried)] });
}

// ── 4. ON-DISK redaction check (raw SQLite bytes, bypassing the store API) ──
const dbPath = join(memoryDir, "memory.db");
const dbBytes = readFileSync(dbPath);
const dbText = dbBytes.toString("latin1");
const leaks = [];
for (const probe of secretProbes) {
  if (probe.length < 8) continue;
  if (dbText.includes(probe)) leaks.push({ probe: probe.slice(0, 12) + "…", len: probe.length });
}
// The store must contain redaction markers (something WAS redacted) when the
// raw sessions contained credential-shaped values.
const hasMarkers = secretProbes.length === 0 ? true : dbText.includes("[REDACTED]");

store.close();

const verdict = {
  verdict: leaks.length === 0 ? "pass" : "FAIL",
  sessionsScanned: scanned,
  flushed,
  episodeCounts: counts,
  totalEpisodes: total,
  retryEvidence,
  secretProbesChecked: secretProbes.length,
  redactionMarkersOnDisk: hasMarkers,
  onDiskLeaks: leaks,
};
console.log(JSON.stringify(verdict, null, 2));
process.exit(verdict.verdict === "pass" ? 0 : 1);
