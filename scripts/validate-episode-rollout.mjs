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
 *   node scripts/validate-episode-rollout.mjs --sessions-root <dir> --memory-dir <new-dir> \
 *        [--live-memory-dir <custom-live-dir>] [--session <id>] [--pick N] [--max-events 4000]
 *
 * The destination must not exist; its parent must exist. The validator refuses
 * overlap with session storage, $DSH_HOME, and any explicitly supplied custom
 * live memory directory. It never deletes the destination. Exit 1 on leaks or
 * missing redaction markers, 2 when the run lacks evidence to validate.
 */
import { statSync, mkdirSync, existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { assertSafeMemoryDir, collectSecretProbes, judgeRolloutEvidence, scanStoreArtifacts } from "./episode-rollout-utils.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};

const sessionsRoot = arg("sessions-root", "");
const requestedMemoryDir = arg("memory-dir", "");
if (!sessionsRoot || !requestedMemoryDir) {
  console.error(JSON.stringify({ error: "usage: --sessions-root <dir> --memory-dir <new-dir> [--live-memory-dir <dir>] [--session id] [--pick N]" }));
  process.exit(2);
}
if (!existsSync(sessionsRoot) || !statSync(sessionsRoot).isDirectory()) {
  console.error(JSON.stringify({ error: `sessions-root is not a directory: ${sessionsRoot}` }));
  process.exit(2);
}
let memoryDir;
try {
  const liveMemoryDir = arg("live-memory-dir", "");
  memoryDir = assertSafeMemoryDir(requestedMemoryDir, sessionsRoot, process.env.DSH_HOME || undefined, liveMemoryDir ? [liveMemoryDir] : []);
} catch (error) {
  console.error(JSON.stringify({ error: String(error) }));
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
  console.log(JSON.stringify({ verdict: "inconclusive", reason: "no-candidates", scanned, sessionsWithToolCalls: candidates.length, note: "no session with tool calls found under the pick budget" }));
  process.exit(2);
}

// ── 3. Flush through the REAL capture pipeline into the isolated store ─────
mkdirSync(memoryDir);
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

// ── 4. Checkpoint and close before scanning every persisted store artifact. ──
try {
  store.checkpoint();
} finally {
  store.close();
}
const diskScan = scanStoreArtifacts(memoryDir, secretProbes);
const evidenceVerdict = judgeRolloutEvidence({
  leaks: diskScan.leaks,
  secretProbesChecked: secretProbes.length,
  totalEpisodes: total,
  retryEpisodes: retryEvidence.length,
  redactionMarkersOnDisk: diskScan.redactionMarkersOnDisk,
});
const verdictData = {
  verdict: evidenceVerdict.verdict,
  sessionsScanned: scanned,
  flushed,
  episodeCounts: counts,
  totalEpisodes: total,
  retryEvidence,
  secretProbesChecked: secretProbes.length,
  sqliteArtifactsScanned: diskScan.sqliteArtifacts,
  storeFilesScanned: diskScan.filesScanned.length,
  redactionMarkersOnDisk: diskScan.redactionMarkersOnDisk,
  inconclusiveReasons: evidenceVerdict.inconclusiveReasons,
  onDiskLeaks: diskScan.leaks,
};
console.log(JSON.stringify(verdictData, null, 2));
process.exitCode = evidenceVerdict.verdict === "pass" ? 0 : evidenceVerdict.verdict === "FAIL" ? 1 : 2;
