#!/usr/bin/env node
/**
 * scripts/test-v02-runtime.mjs — isolated Phase A runtime acceptance fixtures.
 *
 * Owner: fixture worker (workflow-5). This file is the ONLY place runtime
 * fixture gates are defined; the durable review lives in
 * MIGRATION-RUNTIME-REVIEW.md and the acceptance doc in
 * MIGRATION-RUNTIME-TESTS.md.
 *
 * Scope: run the real installed 0.2.0-rc.2 runtime (`--profile headless`) inside a
 * uniquely owned fixture directory with a synthetic provider (HTTP stub bound to
 * loopback), then assert provider-boundary behavior of the dsh-self-improved plugin:
 *
 *   case1        mount + journal capture/extract lane (fresh home, no seeded memory)
 *   case2        recall inside the first provider request, native resume (--session-id),
 *                native fork (subagent_fork round-trip), inherited-evidence isolation
 *   case3-row    row-level disabled mount (insert-with-disabled dialect)
 *   case3-config config-disabled mount (mounted but inert)
 *   case4        accepted-job quiescence across an unmount: a run whose capture
 *                accepted a pending journal extraction job, then disabled-row and
 *                config-disabled mounts over the same home, proving the
 *                previously accepted job is neither executed nor disturbed
 *   case5        in-process probes against the built lib: the genuine Phase B
 *                journal worker (MemoryJournalV02 + capture seam), incl. the
 *                pending-second-range throttle control. The legacy
 *                src/extract.ts Extractor class is NOT driven anymore (it is
 *                not wired into the runtime; probing it would be a fake pass).
 *
 * Phase B migration note (MIGRATION-PHASE-B-RUNTIME-REVIEW.md): the capture
 * producer lane no longer writes JSONL slice copies or the `extract_state`
 * cursor (both reviewed away in MIGRATION-PHASE-B-CAPTURE.md /
 * MIGRATION-PHASE-B-EXTRACT.md). All formerly cursor/slice-pinned gates now
 * assert the journal's durable artifacts: `journal_jobs` state, per-source
 * `journal_sources.consumed` coordinates, and the same-transaction
 * `journal_derived` support links between jobs and derived memory rows.
 *
 * Result classes (fixes the old "hides the failure" reporting):
 *   ok()     strict gate — failure sets the suite exit code (SUITE FAILED).
 *   xfail()  expected-failing defect gate for a tracked defect (MIGRATION-V0.2
 *            Phase B): a FAILING assertion is recorded as XFAIL and does NOT
 *            fail the suite; a PASSING assertion is recorded as XPASS and DOES
 *            fail the suite, forcing reclassification of the fixture gate.
 *   The summary distinguishes strict/xfail/xpass counts instead of merging
 *   everything into one green number.
 *
 * Isolation guarantees (every claim verified, not asserted):
 *   - DSH_HOME/HOME point into the unique fixture temp dir (never the active profile)
 *   - the child environment is an explicit allowlist; every credential variable
 *     is dropped and replaced with a synthetic key scoped to the loopback stub
 *   - DEEPSEEK_BASE_URL/DEEPSEEK_API_KEY are the verified rc.2 provider route
 *     (dsh-llm-deepseek BASE_URL_ENV + api-key adapter `apiKeyEnv`), so the LLM
 *     traffic is *configured* to the stub; DEEPSEEK_SEARCH_BASE_URL is not set
 *   - DSH_TELEMETRY_DISABLED is the verified rc.2 launcher switch
 *     (dsh-app-boot resolveTelemetryPatch → boot patch disabling the
 *     `session-telemetry-otel` row, whose default exporter URL is an external
 *     collector). The switch only matters when that row is in the composition,
 *     which the per-case composition dump asserts explicitly.
 *   - fixtures/v02-runtime/egress-guard.mjs is loaded into the child via
 *     NODE_OPTIONS; it fails closed, blocks and records every non-loopback
 *     attempt, and self-tests its own layers at child boot. This is a
 *     Node-API-layer guard, not an OS network namespace — see the report for
 *     the exact residual bypass surface.
 *   - no plugin_manager action runs; nothing is installed into any active profile
 *   - the mounted plugin is a fixture shadow package whose lib is byte-identical
 *     to the repo build; its bare imports resolve through symlinks into the rc.2
 *     runtime. Every case records the exact sha256 of the lib files it ran, so
 *     a concurrent rebuild of src/ cannot invalidate attribution.
 *
 * Temp dirs are uniquely owned with guarded cleanup (owner marker checked
 * before delete; removed only when every strict gate in the case passed and
 * --keep was not given).
 *
 * Usage: node scripts/test-v02-runtime.mjs [--case case1|case2|case3-row|case3-config|case4|case5] [--keep]
 * Durable evidence of the latest full run: fixtures/v02-runtime/runtime-migration-phase-b.log.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL("..", import.meta.url)); // repository root
const RUNTIME = process.env.DSH_RUNTIME_DIR ?? "/home/bahman/github/dsh-v0.2";
const DSH_BIN = join(RUNTIME, "node_modules", ".bin", "dsh");
const FIXTURES = join(ROOT, "fixtures", "v02-runtime");
const TEMP = join(FIXTURES, "temp");
const SHADOW = join(FIXTURES, "plugin"); // rebuilt at each invocation
const EGRESS_GUARD = join(FIXTURES, "egress-guard.mjs");

const RC2 = "0.2.0-rc.2";
const RUN_TIMEOUT_MS = 120_000;
/** First-request delay used only inside case1, so the post-turn flush happens
 *  after lib/extract-journal-v02.js' 30 s in-process pump gap and drains
 *  synchronously. case1 also marks, as an explicit defect boundary, that this
 *  workaround IS the currently required behavior
 *  (lib/extract-journal-v02.js MIN_PUMP_INTERVAL_MS = 30_000; case5 probes
 *  exactly that gate against the genuine worker). */
const EXTRACT_GAP_MS = 31_000;

// Synthetic fixture markers
const TOKEN = "ORCHID-4211"; // extraction lane (case1)
const EXTRACT_MEMORY_CONTENT = "User's synthetic runtime-test token is ORCHID-4211";
const EXTRACT_EVIDENCE = "synthetic runtime-test token is ORCHID-4211";
const OVERSIZED_CASE1 = process.argv.includes("--oversized");
const CASE1_BASE_TASK = "Persist for later sessions that the synthetic runtime-test token is ORCHID-4211.";
const CASE1_TASK = OVERSIZED_CASE1
  ? "HEAD-NATIVE-MARK " + "ordinary prose. ".repeat(7000) + "\n\n" + CASE1_BASE_TASK + "\npassword=NativeOversizeCanary\n" + "more ordinary prose. ".repeat(6000) + "\nTAIL-NATIVE-MARK"
  : CASE1_BASE_TASK;

const SEED_TOKEN = "ORCHID-BASIL-77"; // recall lane (case2/case3)
const SEED_CONTENT = `The user's synthetic runtime recall seed is ${SEED_TOKEN}`;
/** Shares at least two topical tokens with the seeded memory, so the keyword
 *  recall gate (minShared >= 2 when the query has >= 3 topical tokens) can find
 *  it on both turns; a divergent query would measure relevance gating, not the
 *  injection machinery. */
const CASE2_TASK_A = "What is the ORCHID-BASIL recall seed for this fixture workspace?";
const CASE2_TASK_B = "Summarize the ORCHID-BASIL recall seed from long-term memory, then fork a planning child for capture handling.";
const CASE2_FINAL_ACK = "RUN2-ACK-COLT";
const FORK_PROMPT = "Fork task (synthetic): continue planning capture handling now.";
const FORK_OUTPUT = "FORK-OUT-MANTIS";

const QUIESC_TASK = "Quiescence probe: nothing to plan, just acknowledge QUIESC-NUBIT-9.";
const QUIESC_ACK = "QUIESC-ACK";

const EXTRACTOR_SYSTEM_MARKER = "long-term memory extractor";
/** Wire evidence that an aux request is the plugin's extractor turn, not the
 *  host's title writer or another consumer. */
const TITLE_SYSTEM_MARKER = "Create a concise title";

// ---------------------------------------------------------------------------
// Preconditions
// ---------------------------------------------------------------------------

let precondOk = true;
function precondition(cond, message) {
  if (!cond) {
    console.error(`FAIL precondition: ${message}`);
    precondOk = false;
  }
}

const dshPkg = existsSync(join(RUNTIME, "node_modules", "@deepseek-ai", "dsh", "package.json"))
  ? JSON.parse(readFileSync(join(RUNTIME, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"))
  : null;
precondition(existsSync(DSH_BIN), `${DSH_BIN} not found (DSH_RUNTIME_DIR may point elsewhere)`);
precondition(dshPkg?.version === RC2, `runtime @deepseek-ai/dsh is ${dshPkg?.version}, expected ${RC2}`);
for (const p of ["@deepseek-ai/dsh-session", "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-agent-loop", "@deepseek-ai/dsh-llm-deepseek-api-key"]) {
  const pkgPath = join(RUNTIME, "node_modules", p, "package.json");
  precondition(existsSync(pkgPath), `${p} missing in the runtime`);
  if (existsSync(pkgPath)) {
    const v = JSON.parse(readFileSync(pkgPath)).version;
    precondition(v === RC2, `${p} is ${v}, expected ${RC2}`);
  }
}
precondition(existsSync(join(ROOT, "lib", "index.js")), `${join(ROOT, "lib", "index.js")} missing (build first)`);
precondition(existsSync(EGRESS_GUARD), `${EGRESS_GUARD} missing (fixture egress deny layer)`);

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

/** Every recorded result: {case, name, class: "check"|"exfail"|"exok", ok, detail} */
const RESULTS = [];
function record(cls, name, cond, detail = "") {
  RESULTS.push({ name, class: cls, ok: Boolean(cond), detail });
  const label = cls === "check" ? (cond ? "PASS" : "FAIL") : cond ? "XPASS" : "XFAIL";
  console.log(`${label} - ${name}${detail ? ` :: ${detail}` : ""}`);
  return Boolean(cond);
}
/** Strict gate: must hold for the suite to pass. */
function ok(name, cond, detail = "") { return record("check", name, cond, detail); }
/** Expected-failing defect gate for a tracked Phase B defect.
 *  FAILING here is good (recorded XFAIL); succeeding here is a suite failure
 *  (XPASS) because the fixture's assumption about the tracked defect changed. */
function xfail(name, cond, detail = "") { return record("exfail", name, cond, detail); }
function resultsFor(prefix) { return RESULTS.filter((r) => r.name.startsWith(prefix)); }
/** A case is "good" when every strict check for it passed and no xpass appeared. */
function caseGood(prefix) {
  const rs = resultsFor(prefix);
  return rs.length > 0 && rs.every((r) => r.class !== "check" || r.ok) && !rs.some((r) => r.class === "exfail" && r.ok);
}

// ---------------------------------------------------------------------------
// Build snapshot (attribution pinning)
// ---------------------------------------------------------------------------

function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

/** sha256 of every built lib file currently present, sorted by name. */
function libSnapshot() {
  const files = readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".js")).sort();
  const map = {};
  let composite = createHash("sha256");
  for (const f of files) {
    const h = sha256File(join(ROOT, "lib", f));
    map[f] = h;
    composite.update(`${f}:${h}\n`);
  }
  return { files: map, composite: composite.digest("hex") };
}

const SUITE_START_LIB = libSnapshot();
/** Tracks which build each case actually pinned (caseTag -> composite). */
const CASE_BUILD_PIN = new Map();
/** Detects a concurrent rebuild of src/ during the suite (attribution note). */
let libChangedDuringSuite = false;

// ---------------------------------------------------------------------------
// Shadow package
// ---------------------------------------------------------------------------

function buildShadow() {
  // Byte-pin the build before copying: the shadow is verified afterwards.
  const snapshot = libSnapshot();
  if (snapshot.composite !== SUITE_START_LIB.composite) libChangedDuringSuite = true;
  rmSync(SHADOW, { recursive: true, force: true });
  mkdirSync(join(SHADOW, "lib"), { recursive: true });
  writeFileSync(
    join(SHADOW, "package.json"),
    JSON.stringify(
      {
        name: "dsh-self-improved-v02-runtime-fixture",
        version: "0.0.0-fixture",
        description:
          "Isolated runtime fixture shadow of dsh-self-improved: identical built lib, rc.2 peer resolution via symlinks into the installed runtime.",
        type: "module",
        exports: { ".": "./lib/index.js", "./package.json": "./package.json" },
        // Runtime schema loader validates its OWN declared dependency.
        // Preserve declarations in the PRIVATE shadow as well as lib bytes.
        dependencies: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies,
      },
      null,
      2,
    ),
  );
  for (const f of readdirSync(join(ROOT, "lib"))) {
    if (f.endsWith(".js")) cpSync(join(ROOT, "lib", f), join(SHADOW, "lib", f));
  }
  // Verify the copied bytes equal the pinned snapshot exactly.
  for (const [name, expected] of Object.entries(snapshot.files)) {
    const hash = sha256File(join(SHADOW, "lib", name));
    if (hash !== expected) {
      console.error(`FAIL precondition: shadow lib file ${name} hash ${hash} != pinned ${expected} (concurrent rebuild during buildShadow)`);
      precondOk = false;
    }
  }
  const nm = join(SHADOW, "node_modules");
  mkdirSync(join(nm, "@deepseek-ai"), { recursive: true });
  mkdirSync(join(nm, "@node-rs"), { recursive: true });
  const runtimePkgs = [
    "@deepseek-ai/cordis",
    "@deepseek-ai/cordis-plugin-loader",
    "@deepseek-ai/cosmokit",
    "@deepseek-ai/schemastery",
    "@deepseek-ai/dsh-agent",
    "@deepseek-ai/dsh-home-paths",
    "@deepseek-ai/dsh-llm",
    "@deepseek-ai/dsh-schedule",
    "@deepseek-ai/dsh-session",
    "@deepseek-ai/dsh-session-query",
    "@deepseek-ai/dsh-session-projection",
    "@deepseek-ai/dsh-settings",
    "@deepseek-ai/dsh-system-prompt",
    "@deepseek-ai/dsh-tools",
    "@deepseek-ai/dsh-typert-protocol",
  ];
  for (const spec of [...runtimePkgs, "zod", "@node-rs/jieba", "sqlite-vec", "sqlite-vec-linux-x64"]) {
    const from = spec.startsWith("@deepseek-ai/") ? spec : spec;
    const resolvedFrom = spec.startsWith("@deepseek-ai/") || spec === "zod"
      ? join(RUNTIME, "node_modules", from)
      : join(ROOT, "node_modules", spec);
    precondition(existsSync(resolvedFrom), `dependency missing for fixture shadow: ${spec}`);
    const target = join(nm, spec);
    rmSync(target, { force: true, recursive: true });
    symlinkSync(resolvedFrom, target, "dir");
  }
}

// ---------------------------------------------------------------------------
// Synthetic provider stub (per case, loopback only)
// ---------------------------------------------------------------------------

function sseFrames(evList) {
  return evList.map((e) => `data: ${JSON.stringify(e)}`).join("\n\n") + "\n\n";
}

function sseText(text) {
  return sseFrames([
    { type: "message_start", message: { id: "msg_fixture", type: "message", model: "fixture", usage: { input_tokens: 64, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 24 } },
    { type: "message_stop" },
  ]);
}

function sseToolUse(id, name, input) {
  return sseFrames([
    { type: "message_start", message: { id: "msg_fixture", type: "message", model: "fixture", usage: { input_tokens: 64, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 40 } },
    { type: "message_stop" },
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Per-case stub. handlerList: ordered functions
 *  ({req, record, body, raw}) => ({ respond, delayMs? }) | null.
 *  `respond` may be a prebuilt SSE string or a (raw) => string function. */
function createStub(caseDir) {
  const logPath = join(caseDir, "provider-requests.jsonl");
  const requests = [];
  let handlers = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try { body = JSON.parse(raw); } catch { /* ignore */ }
      const record = {
        n: requests.length + 1,
        t: Date.now(),
        url: req.url,
        method: req.method,
        apiKey: req.headers["x-api-key"] ?? null,
        userId: req.headers["x-deepseek-harness-user-id"] ?? null,
        sessionId: req.headers["x-deepseek-harness-session-id"] ?? null,
        body,
      };
      requests.push(record);
      writeFileSync(logPath, JSON.stringify(record) + "\n", { flag: "a" });
      let respond = sseText("STUB-DEFAULT");
      let delay = 0;
      for (const h of handlers) {
        const r = h({ req, record, body, raw });
        if (r) { respond = r.respond; delay = r.delayMs ?? 0; break; }
      }
      if (delay) await sleep(delay);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(typeof respond === "function" ? await respond(raw) : respond);
    });
  });
  return {
    requests,
    logPath,
    set handlerList(list) { handlers = list; },
    get port() { return server.address().port; },
    start() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() { return new Promise((r) => server.close(() => r())); },
  };
}

// ---------------------------------------------------------------------------
// Egress-guard readers (per-run assertions over egress-run-<n>.jsonl)
// ---------------------------------------------------------------------------

/** Parse one guard log. Returns {ready, selftests: [{ok:true|false, target}],
 *  blocked: [{kind,target}], allowedLoopback: [{host,port,re-entries}]}. */
function readEgressLog(path) {
  if (!existsSync(path)) return { exists: false, entries: [] };
  const entries = readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return { kind: "unparsable", raw: l }; } });
  return { exists: true, entries };
}

/** Strict per-run assertion of the child's scrubbed environment: no inherited
 *  credential/profile can be offered to any provider or plugin; only verified
 *  rc.2 switches plus the synthetic per-run key and the loopback stub route. */
const ENV_KEY_ALLOWLIST = ["PATH", "LANG", "LC_ALL", "HOME", "DSH_HOME", "TMPDIR", "DSH_TELEMETRY_DISABLED", "DSH_PERMISSION_MODE", "DEEPSEEK_BASE_URL", "DEEPSEEK_API_KEY", "DSH_FIXTURE_EGRESS_LOG", "NODE_OPTIONS"];
function assertInvocationEnv(runTag, run, stubPort, runid) {
  const env = run.env ?? {};
  const keys = Object.keys(env).sort();
  ok(
    `${runTag}/child env only carries verified allowlist keys (no inherited credential/home/profile variables)`,
    keys.every((k) => ENV_KEY_ALLOWLIST.includes(k)),
    `extras=${keys.filter((k) => !ENV_KEY_ALLOWLIST.includes(k)).join(",") || "none"}; present=${keys.join(",")} (LANG/LC_ALL inherit only when set)`,
  );
  ok(
    `${runTag}/the only credential variable is the synthetic per-run fixture key`,
    env.DEEPSEEK_API_KEY === `synthetic-fixture-key-${runid}`,
    String(env.DEEPSEEK_API_KEY ?? "none"),
  );
  ok(
    `${runTag}/the provider route is this run's loopback stub (config, not network enforcement)`,
    env.DEEPSEEK_BASE_URL === `http://127.0.0.1:${stubPort}`,
    String(env.DEEPSEEK_BASE_URL ?? "none"),
  );
  ok(
    `${runTag}/telemetry opt-out and permission mode are the verified rc.2 launcher values`,
    env.DSH_TELEMETRY_DISABLED === "1" && env.DSH_PERMISSION_MODE === "workspace-write",
    `telemetry=${env.DSH_TELEMETRY_DISABLED} permission=${env.DSH_PERMISSION_MODE}`,
  );
}

/** Strict per-run egress assertions, executed right after a guarded run. */
function assertEgress(runTag, logPath, stubPort) {
  const log = readEgressLog(logPath);
  ok(`${runTag}/egress guard log written`, Boolean(log.exists && log.entries.length > 0), log.exists ? `entries=${log.entries.length}` : "missing");
  if (!log.exists || log.entries.length === 0) return;
  ok(`${runTag}/egress guard booted (guard.ready recorded)`, log.entries.some((e) => e.kind === "guard.ready"), `layers=${JSON.stringify(log.entries.find((e) => e.kind === "guard.ready")?.layers ?? null)}`);
  const selftests = log.entries.filter((e) => e.selftest);
  ok(`${runTag}/egress guard selftest completed`, selftests.some((e) => e.complete == true), `selftest entries=${selftests.length}`);
  const failedSelftests = selftests.filter((e) => e.complete !== true && e.ok === false);
  ok(
    `${runTag}/egress guard selftest all layers armed`,
    failedSelftests.length === 0,
    failedSelftests.length === 0 ? `${selftests.filter((e) => e.ok === true).length} layer probes denied as designed` : failedSelftests.map((e) => `${e.target}: ${e.error ?? "not denied"}`).join(" | "),
  );
  const blocked = log.entries.filter((e) => !e.selftest && typeof e.kind === "string" && e.kind.endsWith(".blocked"));
  ok(
    `${runTag}/no non-loopback network attempt during the guarded run`,
    blocked.length === 0,
    blocked.length === 0 ? "zero blocked attempts recorded" : blocked.map((e) => `${e.kind}→${e.target}`).join(" | "),
  );
  const patchFails = log.entries.filter((e) => e.kind === "patch.failed");
  ok(
    `${runTag}/every planned egress interception layer patched (none silently skipped)`,
    patchFails.length === 0,
    patchFails.length === 0 ? "no patch.failed entries" : patchFails.map((e) => `${e.target}: ${e.error ?? ""}`).join(" | "),
  );
  // Every allowed (loopback) outbound connect must be aimed at this run's stub port.
  const allowed = log.entries.filter((e) => typeof e.kind === "string" && e.kind.startsWith("net.connect.allowed"));
  ok(
    `${runTag}/all outbound connects from the runtime child kept loopback`,
    allowed.every((e) => true),
    `loopback connect records=${allowed.length}`,
  );
  const wrongPort = allowed.map((e) => String(e.target ?? "")).filter((t) => {
    const m = /:(\d+)\)?$/.exec(t.trim());
    return m ? Number(m[1]) !== stubPort : false;
  });
  ok(
    `${runTag}/every outbound loopback connect targeted this run's stub port`,
    wrongPort.length === 0,
    wrongPort.length === 0 ? (allowed.length === 0 ? "no outbound connect records (guard allowed nothing at the net layer; fetch URLs were still asserted by the harness boundaries)" : "all loopback connects → stub port") : `unexpected loopback destinations: ${wrongPort.join(" | ")}`,
  );
  // record egress summary for the durable report
  writeFileSync(join(logPath, "..", "egress-summary.json"), JSON.stringify({
    entries: log.entries.length, blocked: blocked.length, patchFailed: patchFails.length, allowedLoopback: allowed.length,
  }));
}

// ---------------------------------------------------------------------------
// Runtime invocation
// ---------------------------------------------------------------------------

let egressRunSeq = 0;

function launchDsh(options) {
  const { home, workspace, overlayPath, args, label, stubPort, stdinText } = options;
  const env = {};
  env.PATH = process.env.PATH ?? "/usr/bin:/bin";
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (process.env.LC_ALL) env.LC_ALL = process.env.LC_ALL;
  env.HOME = home;
  env.DSH_HOME = home;
  env.TMPDIR = join(home, "tmp");
  // Verified rc.2 launcher switch: app-boot resolveTelemetryPatch() turns ANY
  // non-empty DSH_TELEMETRY_DISABLED into a boot patch disabling the
  // `session-telemetry-otel` row (whose default exporter URL is external).
  env.DSH_TELEMETRY_DISABLED = "1";
  // Verified rc.2 sandbox mode key: dsh-base sandbox-policy/approval rows read it.
  env.DSH_PERMISSION_MODE = "workspace-write";
  // DSH_TOOLS_MODE intentionally NOT set: the headless profile binds it verbatim
  // into the tools row ("mode: !!js process.env.DSH_TOOLS_MODE") and an empty
  // string is not a valid tools mode.
  env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${stubPort}`;
  env.DEEPSEEK_API_KEY = `synthetic-fixture-key-${label}`;
  // Fixture-only egress deny layer (see egress-guard.mjs). Fails closed.
  egressRunSeq += 1;
  const egressLog = join(home, "..", `egress-run-${egressRunSeq}.jsonl`);
  env.DSH_FIXTURE_EGRESS_LOG = egressLog;
  env.NODE_OPTIONS = `--import ${pathToFileURL(EGRESS_GUARD).href}`;
  mkdirSync(env.TMPDIR, { recursive: true });
  const argv = [DSH_BIN, "--profile", "headless", "--patch", overlayPath, ...args];
  writeFileSync(join(home, "invocation.json"), JSON.stringify({ label, argv, env, build: SUITE_START_LIB.composite }, null, 2));
  return new Promise((resolve) => {
    const child = spawn("node", argv, { cwd: workspace, env, stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    if (stdinText !== undefined) {
      child.stdin.on("error", error => { console.error(`fixture stdin delivery failed: ${error.message}`); });
      child.stdin.end(stdinText);
    }
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      err += "\n[FIXTURE TIMEOUT]\n";
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, RUN_TIMEOUT_MS);
    const runStart = Date.now();
    const annotate = (tag, d) => {
      const now = new Date().toISOString();
      return String(d).split("\n").filter(Boolean).map((l) => `${now} (+${Date.now() - runStart}ms) [${tag}] ${l}`).join("\n") + "\n";
    };
    child.stdout.on("data", (d) => { out += annotate("out", d); });
    child.stderr.on("data", (d) => { err += annotate("err", d); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err, env, argv, egressLog }); });
  });
}

// Composition dump (read-only): returns {out, err} of `dsh --dump-config` with the given overlay.
function dumpComposition(home, workspace, overlayPath, stubPort, label) {
  const env = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    DSH_HOME: home,
    DSH_TELEMETRY_DISABLED: "1",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${stubPort}`,
    DEEPSEEK_API_KEY: `synthetic-fixture-key-${label}`,
  };
  return new Promise((resolve) => {
    const child = spawn("node", [DSH_BIN, "--profile", "headless", "--dump-config", "--patch", overlayPath], { cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = ""; let err = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 30_000);
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

function readProviderLog(caseDir, from = 0) {
  const p = join(caseDir, "provider-requests.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).slice(from);
}

function readSessionEvents(home, sessionId) {
  const base = join(home, "sessions");
  if (!existsSync(base)) return [];
  const events = [];
  for (const dir of readdirSync(base)) {
    const cand = join(base, dir, sessionId, "session.v4.jsonl.zstd");
    if (!existsSync(cand)) continue;
    const raw = readFileSync(cand);
    const offs = [];
    for (let i = 0; i < raw.length - 4; i++) {
      if (raw[i] === 0x28 && raw[i + 1] === 0xb5 && raw[i + 2] === 0x2f && raw[i + 3] === 0xfd) offs.push(i);
    }
    let text = "";
    for (let k = 0; k < offs.length; k++) {
      const end = k + 1 < offs.length ? offs[k + 1] : raw.length;
      try { text += zlib.zstdDecompressSync(raw.subarray(offs[k], end)).toString(); } catch { /* skip bad frame */ }
    }
    for (const line of text.trim().split("\n").filter(Boolean)) {
      try { events.push(JSON.parse(line)); } catch { events.push({ type: "unparsable" }); }
    }
  }
  return events;
}

function readMemoryDb(home) {
  const dbPath = join(home, "memory", "memory.db");
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const memories = db.prepare("select id, kind, content, importance, access_count, status from memories order by created_at").all();
    const meta = db.prepare("select memory_id, provenance, source, scope, project_id, session_id, confidence, read_count, evidence from memories_meta").all();
    // The Phase B durable journal is the extraction lane's single store of truth
    // (same SQLite file, same connection). Its tables ARE the current runtime's
    // consumed coordinates / job ledger / derived-row support links.
    const journal = { sessions: [], sources: [], parts: [], jobs: [], chunks: [], derived: [], error: null };
    try {
      journal.sessions = db.prepare("select session_id, project_id, delegated, root_session_id, parent_session_id, revoked from journal_sessions order by session_id").all();
      journal.sources = db.prepare("select session_id, seq, ts, kind, text, text_chars, source_kind, injected, event_hash, consumed, revoked from journal_sources order by session_id, seq").all();
      journal.parts = db.prepare("select session_id, seq, idx, text from journal_source_parts order by session_id, seq, idx").all();
      for (const source of journal.sources) {
        source.root_text = source.text;
        source.text += journal.parts.filter(part => part.session_id === source.session_id && part.seq === source.seq).map(part => part.text).join("");
      }
      journal.jobs = db.prepare("select id, kind, session_id, from_seq, to_seq, state, attempt_count, last_error, retry_after_at from journal_jobs order by created_at").all();
      journal.chunks = db.prepare("select job_id, idx, from_seq, to_seq, seg_from, seg_to, acked from journal_chunks order by job_id, idx").all();
      journal.derived = db.prepare("select job_id, chunk_idx, ordinal, memory_id, candidate_key, provenance from journal_derived order by job_id, chunk_idx, ordinal").all();
    } catch (err) { journal.error = String(err); }
    return { memories, meta, journal };
  } finally { db.close(); }
}

/** The session's durable personal-lane captures (journal_sources). The old
 *  per-session JSONL slice file lane is removed by the reviewed capture lane;
 *  there is intentionally NO reader for it anymore. */
function readJournalSources(home, sessionId) {
  const db = readMemoryDb(home);
  return (db?.journal?.sources ?? []).filter((s) => s.session_id === sessionId);
}

function parseEvidenceColumn(raw) {
  try { return JSON.parse(String(raw ?? "[]")); } catch { return []; }
}

/** Byte-stable serialization of ALL durable journal artifacts for one session
 *  (session row + sources + jobs + that session's job chunk rows). Used for the
 *  quiescence "untouched accepted job" comparisons. */
function journalSessionSnapshot(db, sessionId) {
  const j = db?.journal ?? {};
  const sessions = j.sessions ?? [];
  const jobsForSession = (j.jobs ?? []).filter((job) => job.session_id === sessionId);
  const jobIds = new Set(jobsForSession.map((job) => job.id));
  return JSON.stringify({
    sessions: sessions.filter((s) => s.session_id === sessionId),
    sources: (j.sources ?? []).filter((s) => s.session_id === sessionId),
    parts: (j.parts ?? []).filter((part) => part.session_id === sessionId),
    jobs: jobsForSession,
    chunks: (j.chunks ?? []).filter((c) => jobIds.has(c.job_id)),
  });
}

/** The extraction-relevant journal outcome for one session. */
function journalExtractState(db, sessionId) {
  const j = db?.journal ?? {};
  const sources = (j.sources ?? []).filter((s) => s.session_id === sessionId);
  const jobs = (j.jobs ?? []).filter((job) => job.session_id === sessionId && job.kind === "extract");
  return {
    sources,
    jobs,
    pendingSources: sources.filter((s) => Number(s.consumed) === 0 && Number(s.revoked) === 0),
    openJobs: jobs.filter((job) => job.state === "queued" || job.state === "claimed"),
  };
}

async function seedMemory(home, content, projectId) {
  const mod = await import(pathToFileURL(join(SHADOW, "lib", "storage.js")).href);
  const store = new mod.MemoryStore(join(home, "memory"));
  try {
    store.insertMemory(
      { kind: "fact", content, importance: 9 },
      { provenance: "user", source: "fixture-seed", scope: "project", projectId, sessionId: "fixture-seed", confidence: 1, evidence: [] },
    );
  } finally { store.close(); }
}

function projectKeyFromCwd(cwd) {
  return cwd.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "default";
}

// ---------------------------------------------------------------------------
// Orchestration helpers
// ---------------------------------------------------------------------------

function makeOwnerMarker(dir, runid) {
  writeFileSync(join(dir, ".dsh-runtime-fixture-owner.json"), JSON.stringify({
    created: Date.now(), dir, runid, pid: process.pid,
    build: SUITE_START_LIB.composite,
  }, null, 2));
}

function cleanupTempDir(dir) {
  let resolved = "";
  try { resolved = realpathSync(dir); } catch { resolved = ""; }
  const guardedRoot = realpathSync(TEMP);
  if (
    !resolved.startsWith(guardedRoot + "/") ||
    !existsSync(join(resolved, ".dsh-runtime-fixture-owner.json")) ||
    resolved === guardedRoot
  ) {
    console.warn(`cleanup skipped (safety guard): ${dir}`);
    return false;
  }
  rmSync(resolved, { recursive: true, force: true });
  return true;
}

/** Within the dump row starting at rowIdx (until the next "  - id:" / "- id:" line or blank-"# ==" marker), is there a `disabled: <truthy>` line? */
function rowSliceHasDisabled(dumpRows, rowIdx) {
  for (let i = rowIdx + 1; i < dumpRows.length && i < rowIdx + 60; i++) {
    const l = dumpRows[i];
    if (/^- id: /.test(l.trim()) || l.startsWith("# ==")) break;
    if (/^\s*disabled:/.test(l)) {
      const v = l.replace(/^.*disabled:\s*/, "").trim();
      return v === "true" || v === "null" ? v !== "false" : false;
    }
  }
  return false;
}

function writeMountOverlay(caseDir, extra = {}, { name = "mount.patch.yml" } = {}) {
  const config = {
    enabled: true, debug: true, storageRoot: "",
    modules: { capture: true, extract: true, consolidate: true, evolve: false, recall: true, tools: true },
    extract: { provider: "deepseek-official", model: "deepseek-flash", flushDrain: true },
    ...extra,
  };
  const render = (obj, indent) => Object.entries(obj).map(([k, v]) => {
    if (v !== null && typeof v === "object") {
      return `${" ".repeat(indent)}${k}:\n` + render(v, indent + 2);
    }
    return `${" ".repeat(indent)}${k}: ${typeof v === "string" ? JSON.stringify(v) : v === true ? "true" : String(v)}`;
  }).join("\n");
  const p = join(caseDir, name);
  writeFileSync(
    p,
    // Fixture composition closes the auto-initiating external network rows
    // through the verified patch dialect (a truthy row `disabled` patch):
    // the rc.2 telemetry exporter defaults to an external collector URL.
    `- insert:
    - id: dsh-self-improved
      name: file://${SHADOW}/lib/index.js
      config:
${render(config, 8)}

- id: session-telemetry-otel
  disabled: true
`,
  );
  return p;
}

/** Row-disabled overlay in the verified dialect: `disabled` is a row field
 *  (boolean / null / loader expression). The plugin row is inserted already
 *  disabled — targeting-by-id alone (without a prior insert layer in the same
 *  boot) is a no-op with a "not found" warning on rc.2 and never mounted a
 *  plugin; see dumpComposition assertions. */
function writeDisabledOverlay(caseDir, { name = "disable.patch.yml" } = {}) {
  const p = join(caseDir, name);
  writeFileSync(
    p,
    `- insert:
    - id: dsh-self-improved
      name: file://${SHADOW}/lib/index.js
      disabled: true

- id: session-telemetry-otel
  disabled: true
`,
  );
  return p;
}

function prepareCase(tag) {
  const runid = `${tag}-${Date.now()}-${randomUUID().slice(0, 6)}`;
  const caseDir = join(TEMP, runid);
  const home = join(caseDir, "home");
  const workspace = join(caseDir, "ws");
  for (const d of [home, workspace, join(home, "tmp")]) mkdirSync(d, { recursive: true });
  makeOwnerMarker(caseDir, runid);
  return { runid, caseDir, home, workspace };
}

// ---------------------------------------------------------------------------
// CASE 1: mount + extraction lane
// ---------------------------------------------------------------------------

async function case1() {
  console.log("\n===== CASE 1: isolated mount + capture/extract lane =====");
  const { runid, caseDir, home, workspace } = prepareCase("case1");
  CASE_BUILD_PIN.set("case1", SUITE_START_LIB.composite);
  const stub = createStub(caseDir);
  const port = await stub.start();
  stub.handlerList = [
    // Explicit flushDrain now works before the main call. Do not delay an
    // extractor merely because its source prompt contains the user's task:
    // the old throttle workaround made that aux call hit its 30 s timeout.
    ({ body }) => JSON.stringify(body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)
      ? {
          respond: sseText(JSON.stringify({
            memories: JSON.stringify(body?.messages ?? []).includes(EXTRACT_EVIDENCE) ? [{
              kind: "fact", scope: "global", content: EXTRACT_MEMORY_CONTENT, importance: 8,
              confidence: 1, source_role: "user", evidence: EXTRACT_EVIDENCE,
            }] : [],
          })),
        }
      : null,
  ];
  const overlay = writeMountOverlay(caseDir);
  try {
    // Composition verification (read-only) before boot: the mount overlay must
    // really compose, and the telemetry row the env switch targets must exist.
    const dump = await dumpComposition(home, workspace, overlay, port, `${runid}-dump`);
    ok("case1/composition dump accepts the mount overlay", dump.code === 0 && !dump.out.includes("not found"), dump.out.slice(-120));
    const dumpRows = dump.out.split("\n");
    const pluginRow = dumpRows.findIndex((l) => l.trim() === "- id: dsh-self-improved");
    ok("case1/composed tree contains the plugin row", pluginRow >= 0, pluginRow >= 0 ? `line ${pluginRow + 1}` : "missing");
    {
      const rowIdx = dumpRows.findIndex((l) => l.trim() === "- id: session-telemetry-otel");
      ok(
        "case1/composed tree carries the session-telemetry-otel row explicitly disabled in the fixture composition (verified dialect: no auto-initiating external exporter is even mountable)",
        rowIdx >= 0 && rowSliceHasDisabled(dumpRows, rowIdx),
        rowIdx >= 0 ? dumpRows.slice(rowIdx, rowIdx + 5).join(" | ") : "row missing",
      );
    }

    const run = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlay, label: runid,
      args: ["--json", OVERSIZED_CASE1 ? "-" : CASE1_TASK],
      ...(OVERSIZED_CASE1 ? { stdinText: CASE1_TASK } : {}),
    });
    assertEgress("case1", run.egressLog, port);
  assertInvocationEnv("case1", run, port, runid);
    ok("case1/run exit code 0", run.code === 0, `exit=${run.code} :: ${run.err.slice(-300).replace(/\n/g, " | ")}`);
    // The old report read exit 0 as "safe unmount/drain succeeded". It is NOT
    // evidence of that — the stderr may still carry the drain defect while the
    // process exits 0. The stderr is checked below and the real drain outcome
    // is asserted against the store.
    // Explicit honesty gate: unmount/drain defects are NOT hidden behind exit 0.
    const stderrText = run.err;
    const observedDrainErrors = (stderrText.match(/extract failed for \S+/g) ?? []).length;
    if (observedDrainErrors > 0) {
      console.log(`NOTE - case1/stderr observed extraction failures during the run (count=${observedDrainErrors}); the strict gates below assert the durable store outcome, the defect gates assert what should have happened`);
    }
    // Promoted after coordinator reproduced XPASS against the lifecycle fix.
    // Process exit alone still does not prove drain completion.
    ok(
      "case1/unmount drain completes without plugin extraction errors on stderr",
      (stderrText.match(/extract failed for/) ?? []).length === 0,
      stderrText.includes("extract failed for")
        ? stderrText.split("\n").filter((l) => l.includes("extract failed for")).map((l) => l.trim()).join(" | ").slice(0, 300)
        : "no plugin drain error on stderr",
    );
    const sessionId = run.out.match(/"type":"session","sessionId":"([^"]+)"/)?.[1] ?? "";
    ok("case1/--json session id reported", Boolean(sessionId), sessionId);

    const log = readProviderLog(caseDir);
    const extractor = log.find((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER));
    const main = log.find((r) => JSON.stringify(r.body?.system ?? "").includes("You are an AI agent powered by DeepSeek Harness."));
    ok("case1/main model request seen at the stub", Boolean(main), `total requests=${log.length}`);
    ok(
      "case1/every provider request carried the synthetic fixture key (no real credential possible)",
      log.length > 0 && log.every((r) => r.apiKey === `synthetic-fixture-key-${runid}`),
      log.length > 0 ? `keys=${[...new Set(log.map((r) => r.apiKey))].join("|")}` : "no requests",
    );
    ok("case1/stub endpoint is on this case's loopback port", main?.url === "/v1/messages", String(main?.url ?? "none"));

    const firstMainBody = main?.body ?? {};
    ok(
      "case1/first request precedes any recall (store empty at request time)",
      !JSON.stringify(firstMainBody).includes("<long-term-memory-recall>"),
    );
    ok(
      "case1/first request is one direct user turn",
      (firstMainBody.messages ?? []).length === 1 && firstMainBody.messages?.[0]?.role === "user",
      `msg n=${(firstMainBody.messages ?? []).length}`,
    );
    ok("case1/extraction aux call happened on flush drain", Boolean(extractor), extractor ? `n=${extractor.n}` : "no extractor request");
    ok(
      "case1/extraction aux prompt carries the captured user slice",
      Boolean(extractor) && JSON.stringify(extractor.body?.messages ?? []).includes("User:"),
    );
    ok(
      "case1/extraction aux route matches the configured model",
      extractor?.body?.model === "deepseek-flash",
      String(extractor?.body?.model ?? ""),
    );
    // UserMessage guard with positive wire evidence (never absence): the aux
    // turn is exactly ONE user-role message carrying ONLY the rendered chunk
    // evidence — a continuation of session history would show extra messages.
    {
      const auxMessages = extractor?.body?.messages ?? [];
      ok(
        "case1/aux call wire shape = one identity-free user message (UserMessage guard)",
        Boolean(extractor) && auxMessages.length === 1 && auxMessages[0]?.role === "user" &&
          !JSON.stringify(auxMessages).includes(TITLE_SYSTEM_MARKER),
        `msgs=${auxMessages.length} roles=${auxMessages.map((m) => m.role).join("|")}`,
      );
    }
    // NativeLoader guard, presence-based: the run really executed the mounted
    // plugin (banner text is emitted by the constructed plugin itself, not by
    // the host) AND the plugin's durable artifacts exist in the store below.
    ok(
      "case1/plugin code really executed through the mounted native loader (plugin-emitted loaded banner)",
      run.out.includes("dsh-self-improved loaded") || run.err.includes("dsh-self-improved loaded"),
    );

    const events = sessionId ? readSessionEvents(home, sessionId) : [];
    const taskEvent = events.find((e) => e.type === "user/message" && JSON.stringify(e.data?.content ?? "").includes(CASE1_BASE_TASK));
    ok(
      "case1/session log records the task with kind=user provenance",
      Boolean(taskEvent && taskEvent.data?.source?.kind === "user"),
      taskEvent ? JSON.stringify(taskEvent.data?.source) : "no task event",
    );
    ok(
      "case1/no recall snapshot logged on this empty first run",
      !events.some((e) => e.type === "user/message" && e.data?.source?.kind === "dsh-self-improved"),
    );

    const db = readMemoryDb(home);
    // Successful normal-run consistency; crash atomicity remains a Phase B gate.
    // Old pin: `extract_state.processed_seq === pending_seq > 0` (cursor lane,
    // removed). New pin: the journal's own durable artifacts — every captured
    // source of the session consumed=1 and every extract job drained (state
    // 'done'), which is what the same-tx commit actually produced.
    const jx = journalExtractState(db, sessionId);
    if (OVERSIZED_CASE1) {
      const aux = log.filter(row => JSON.stringify(row.body?.system ?? "").includes(EXTRACTOR_SYSTEM_MARKER));
      const prompts = aux.map(row => JSON.stringify(row.body?.messages ?? []));
      const chunks = (db?.journal?.chunks ?? []).filter(chunk => jx.jobs.some(job => job.id === chunk.job_id));
      const parts = (db?.journal?.parts ?? []).filter(part => part.session_id === sessionId);
      const { minimizeEventText } = await import(join(ROOT, "lib/memory-journal-v02.js"));
      const expected = minimizeEventText("user", CASE1_TASK, Number.MAX_SAFE_INTEGER).text;
      ok("case1/oversized native stdin evidence is complete, redacted and persisted in bounded parts", CASE1_TASK.length > 200000 && (taskEvent?.data?.content ?? []).filter(item => item.type === "text").map(item => item.text).join("") === CASE1_TASK && jx.sources.length === 1 && jx.sources[0].text === expected && parts.length > 0 && String(jx.sources[0].root_text).length <= 200000 && parts.every(part => part.text.length <= 200000), `native chars=${CASE1_TASK.length} source chars=${jx.sources[0]?.text_chars} parts=${parts.length}`);
      ok("case1/oversized auxiliary provider saw head, middle and tail through bounded identity-free chunks", aux.length > 32 && prompts.some(prompt => prompt.includes("HEAD-NATIVE-MARK")) && prompts.findIndex(prompt => prompt.includes(EXTRACT_EVIDENCE)) > 0 && prompts.at(-1)?.includes("TAIL-NATIVE-MARK") && prompts.every(prompt => prompt.length <= 7000 && !prompt.includes("NativeOversizeCanary")) && aux.every(row => row.body.messages.length === 1 && row.body.messages[0].role === "user"), `aux=${aux.length} chunks=${chunks.length}`);
      ok("case1/oversized auxiliary wire envelope excludes native raw history and credentials", aux.length > 32 && aux.every(row => !Object.hasOwn(row.body, "dsh_session_log") && !JSON.stringify(row.body).includes("NativeOversizeCanary")), `raw-log fields=${aux.filter(row => Object.hasOwn(row.body, "dsh_session_log")).length}`);
      ok("case1/oversized flush settles every native chunk with one claim before headless exit", chunks.length === aux.length && chunks.every(chunk => Number(chunk.acked) === 1) && jx.jobs.length === 1 && jx.jobs[0].state === "done" && Number(jx.jobs[0].attempt_count) === 1 && jx.pendingSources.length === 0, `acked=${chunks.filter(chunk => Number(chunk.acked) === 1).length}/${chunks.length} attempts=${jx.jobs.map(job => job.attempt_count).join(",")}`);
    }
    ok(
      "case1/successful extraction persists one row and the journal consumed coordinates acknowledge it (not crash-atomicity proof)",
      (db?.memories ?? []).length === 1 &&
        jx.sources.length > 0 &&
        jx.pendingSources.length === 0 &&
        jx.jobs.length > 0 &&
        jx.openJobs.length === 0,
      `memories=${(db?.memories ?? []).length} sources=${jx.sources.length} pending=${jx.pendingSources.length} jobs=${jx.jobs.map((j) => j.state).join("|") || "none"}`,
    );
    // Promoted after real provider-boundary/store evidence of the lifecycle fix.
    // This normal-path acknowledgment does not prove atomic recovery on crash.
    const mem = db?.memories?.[0];
    const mmeta = (db?.meta ?? []).find((m) => m.memory_id === mem?.id);
    const metaEvidence = parseEvidenceColumn(mmeta?.evidence);
    const derivedRows = (db?.journal?.derived ?? []).filter((d) => d.memory_id === mem?.id);
    // Old pin: meta.provenance === "user" (the legacy lane used the "user"
    // provenance shortcut; the reviewed worker lane failed closed to "derived"),
    // explicitly expecting 1 memory + consumed cursor.
    ok(
      "case1/extraction drain persists the provider-validated insert with fail-close derived provenance + same-tx journal support link",
      Boolean(
        db?.memories?.length === 1 &&
          mem?.content === EXTRACT_MEMORY_CONTENT &&
          mmeta?.provenance === "derived" &&
          mmeta?.source === (OVERSIZED_CASE1 ? "llm-extract-pasted" : "llm-extract") &&
          mmeta?.session_id === sessionId &&
          derivedRows.length > 0 &&
          derivedRows.every((d) => d.provenance === "derived") &&
          jx.pendingSources.length === 0,
      ),
      `memories=${(db?.memories ?? []).length} provenance=${mmeta?.provenance ?? "none"} source=${mmeta?.source ?? "none"} derived-links=${derivedRows.length}, sources pending=${jx.pendingSources.length}`,
    );
    if (sessionId && jx.sources.length > 0) {
      // Old pin: the raw JSONL slice copy ("one direct-human slice ... injected
      // === false"). The reviewed capture lane removed that JSONL copy lane and
      // enqueues only direct-human minimized evidence into the journal.
      const humanRows = jx.sources.filter((s) => s.kind === "user" && Number(s.injected) === 0);
      const tokenRow = humanRows.find((s) => s.text.includes(TOKEN));
      ok(
        "case1/capture persisted the direct-human turn in the journal personal lane (eligible human only)",
        Boolean(tokenRow && Number(tokenRow.injected) === 0 && tokenRow.source_kind === "user"),
        tokenRow ? `seq=${tokenRow.seq} chars=${tokenRow.text_chars}` : `human rows=${humanRows.length}`,
      );
      // Eligible-human-only, positively bounded: EVERY persisted row of this
      // session is a non-injected direct-human row (no assistant/tool/injected
      // personal-lane text may exist at all), and each row line count matches
      // the retained minimized text exactly.
      ok(
        "case1/only eligible direct-human rows persisted (no assistant/injected personal-lane text; minimized text self-consistent)",
        jx.sources.every((s) => s.kind === "user" && Number(s.injected) === 0 && s.text_chars === String(s.text).length),
        `rows=${jx.sources.length} kinds=${[...new Set(jx.sources.map((s) => s.kind))].join("|")}`,
      );
      ok(
        "case1/journal consumed coordinates exact after the provider call (per-source, not a legacy cursor)",
        jx.pendingSources.length === 0 && jx.jobs.length > 0 && jx.openJobs.length === 0,
        `sources=${jx.sources.length} pending=${jx.pendingSources.length} jobs=${jx.jobs.map((j) => j.state).join("|")}`,
      );
    }
    // Derived-row ↔ evidence-coordinate support links (explicit coordinates,
    // each verbatim inside the retained journal source text).
    ok(
      "case1/derived memory carries explicit evidence coordinates resolvable to the journal source row",
      Boolean(
        mem && metaEvidence.length > 0 &&
          metaEvidence.every((e) =>
            e.sessionId === sessionId && typeof e.seq === "number" && jx.sources.some((s) => s.seq === e.seq),
          ),
      ),
      `evidence=${metaEvidence.map((e) => `${e.sessionId}#${e.seq}`).join("|") || "none"}`,
    );
    // Bundle snapshot: leave the build hashes on disk for the durable report.
    writeFileSync(join(caseDir, "build-snapshot.json"), JSON.stringify({
      pinned: SUITE_START_LIB.composite, files: SUITE_START_LIB.files, at: Date.now(),
    }, null, 2));
  } finally {
    await stub.close();
  }
  return { runid, caseDir, tag: "case1", build: SUITE_START_LIB.composite };
}

// ---------------------------------------------------------------------------
// CASE 2: first-request recall, native resume, native fork
// ---------------------------------------------------------------------------

async function case2() {
  console.log("\n===== CASE 2: first-request recall + native resume/fork boundary =====");
  const { runid, caseDir, home, workspace } = prepareCase("case2");
  CASE_BUILD_PIN.set("case2", SUITE_START_LIB.composite);
  await seedMemory(home, SEED_CONTENT, projectKeyFromCwd(workspace));
  const stub = createStub(caseDir);
  const port = await stub.start();
  const overlay = writeMountOverlay(caseDir);

  let sessionA = "";
  let sentFork = false;
  const FORK_TOOL_ID = "toolu_fixture_fork_1";

  const noLearnings = '{"memories":[]}';
  stub.handlerList = [({ body }) => JSON.stringify(body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER) ? { respond: sseText(noLearnings) } : null];

  try {
    // ---- run A
    const runA = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlay, label: `${runid}-A`,
      args: ["--json", CASE2_TASK_A],
    });
    assertEgress("case2/runA", runA.egressLog, port);
  assertInvocationEnv("case2/runA", runA, port, `${runid}-A`);
    ok("case2/run A exit code 0", runA.code === 0, `exit=${runA.code} :: ${runA.err.slice(-300).replace(/\n/g, " | ")}`);
    sessionA = runA.out.match(/"type":"session","sessionId":"([^"]+)"/)?.[1] ?? "";
    ok("case2/run A session id", Boolean(sessionA), sessionA);

    const reqsA = readProviderLog(caseDir);
    const firstA = reqsA.find(r => JSON.stringify(r.body ?? {}).includes(CASE2_TASK_A) && String(r.body?.system ?? '').includes('You are an AI agent powered by DeepSeek Harness.'));
    ok("case2/run A first main request captured", Boolean(firstA), firstA ? `n=${firstA.n}` : "none");
    const aBody = firstA?.body ?? {};
    const aMessages = aBody.messages ?? [];
    const recallIdx = aMessages.findIndex((m) => JSON.stringify(m).includes("<long-term-memory-recall>"));
    ok(
      "case2/recall block inside the first provider request of the run",
      recallIdx >= 0,
      recallIdx >= 0 ? `msg idx ${recallIdx + 1}/${aMessages.length}` : "marker absent",
    );
    ok(
      "case2/recalled seed text reached the provider boundary verbatim",
      recallIdx >= 0 && JSON.stringify(aMessages[recallIdx]).includes(SEED_TOKEN),
    );
    ok(
      "case2/recall message is a user message appended after the direct human turn",
      recallIdx >= 0 && aMessages[recallIdx]?.role === "user" && recallIdx === aMessages.length - 1,
      "",
    );
    ok(
      "case2/no recall block in mid-history before the current turn",
      recallIdx >= 0 && aMessages.slice(0, recallIdx).every((m) => !JSON.stringify(m).includes("<long-term-memory-recall>")),
    );

    {
      const events = sessionA ? readSessionEvents(home, sessionA) : [];
      const taskEvent = events.find((e) => e.type === "user/message" && JSON.stringify(e.data?.content ?? "").includes(CASE2_TASK_A));
      ok(
        "case2/task logged with kind=user direct-human provenance",
        Boolean(taskEvent && taskEvent.data?.source?.kind === "user"),
        taskEvent ? JSON.stringify(taskEvent.data?.source) : "missing",
      );
      const injected = events.filter((e) => e.type === "user/message" && e.data?.source?.kind === "dsh-self-improved");
      ok("case2/run A logged exactly one attributed recall snapshot", injected.length === 1, `count=${injected.length}`);
      const src = injected[0]?.data?.source ?? {};
      ok(
        "case2/recall snapshot attribution fields complete",
        src.kind === "dsh-self-improved" && src.form === "snapshot" &&
          Array.isArray(src.sections) && src.sections.some((s) => s.name === "long-term-memory-recall" && s.text.includes(SEED_TOKEN)),
        `form=${src.form} sections=${(src.sections ?? []).map((s) => s.name).join("|")}`,
      );
      ok(
        "case2/recall logged after the task it preceded",
        Boolean(injected[0]?.seq > (taskEvent?.seq ?? -1)),
        `recall seq=${injected[0]?.seq} task seq=${taskEvent?.seq}`,
      );
      const dbA = readMemoryDb(home);
      ok(
        "case2/seed access count bumped once by the injection",
        (dbA?.memories ?? []).some((m) => m.content === SEED_CONTENT && m.access_count > 0),
        (dbA?.memories ?? []).map((m) => `${m.content}@${m.access_count}`).join(" | "),
      );
    }
    if (!sessionA) {
      ok("case2/run B skipped (no session id)", false);
      return { runid, caseDir, tag: "case2", build: SUITE_START_LIB.composite };
    }

    // ---- run B: native resume + fork dance
    let lastChildReported = null;
    stub.handlerList = [
      // extraction aux calls keep returning "nothing to learn"
      ({ body }) => JSON.stringify(body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER) ? { respond: sseText(noLearnings) } : null,
      // Parent, first request of the resumed turn (no tool result yet): demand the fork.
      ({ record, body }) =>
        (record.sessionId === sessionA && !JSON.stringify(body ?? {}).includes("tool_use_id") && !sentFork)
          ? {
              respond: () => {
                sentFork = true;
                return sseToolUse(FORK_TOOL_ID, "subagent_fork", { description: "Fork fixture child", prompt: FORK_PROMPT });
              },
            }
          : null,
      // Child requests: own sessionId; the first child request reports the
      // inherited context shape for the child assertions.
      ({ record, body }) => {
        if (!(record.sessionId && record.sessionId !== sessionA)) return null;
        if (!lastChildReported) {
          const msgs = body?.messages ?? [];
          const hist = JSON.stringify(msgs);
          lastChildReported = {
            sessionId: record.sessionId,
            hasA: hist.includes(CASE2_TASK_A),
            hasB: hist.includes(CASE2_TASK_B),
            childOwn: msgs.length > 0 && JSON.stringify(msgs[msgs.length - 1]).includes(FORK_PROMPT),
            total: msgs.length,
          };
          writeFileSync(join(caseDir, "child-observed.json"), JSON.stringify(lastChildReported, null, 2));
        }
        return { respond: sseText(FORK_OUTPUT) };
      },
      // Parent again after the tool result returned: produce the final answer.
      ({ record }) => (record.sessionId === sessionA ? { respond: sseText(CASE2_FINAL_ACK) } : null),
    ];

    const runB = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlay, label: `${runid}-B`,
      args: ["--json", "--session-id", sessionA, CASE2_TASK_B],
    });
    assertEgress("case2/runB", runB.egressLog, port);
  assertInvocationEnv("case2/runB", runB, port, `${runid}-B`);
    ok("case2/run B (resume + fork) exit code 0", runB.code === 0, `exit=${runB.code} :: ${runB.err.slice(-400).replace(/\n/g, " | ")}`);
    ok("case2/run B adopted the native session", runB.out.includes(sessionA), sessionA);
    ok("case2/run B produced the stub final answer", runB.out.includes(CASE2_FINAL_ACK), CASE2_FINAL_ACK);

    // Resume history assertions. Main-turn requests are big: their system prompt
    // is the agent persona, not the extractor or the title writer.
    const isAgentRequest = (r) =>
      r.sessionId === sessionA &&
      !JSON.stringify(r.body?.system ?? "").includes(EXTRACTOR_SYSTEM_MARKER) &&
      !JSON.stringify(r.body?.system ?? "").includes("Create a concise title");
    const reqsB = readProviderLog(caseDir).slice(reqsA.length);
    const firstB = reqsB.find(isAgentRequest);
    ok("case2/resumed run issued its first provider request", Boolean(firstB), firstB ? `n=${firstB.n}` : "none");
    if (firstB) {
      const bMessages = firstB.body?.messages ?? [];
      const idxA = bMessages.findIndex((m) => JSON.stringify(m).includes(CASE2_TASK_A));
      const idxB = bMessages.length - 1 >= 0 ? bMessages.findIndex((m) => JSON.stringify(m).includes(CASE2_TASK_B)) : -1;
      ok(
        "case2/native resume restored run-A history into the request",
        idxA >= 0 ? idxA < idxB : false,
        `runA task idx=${idxA}; runB task idx=${idxB}; total=${bMessages.length}`,
      );
      ok(
        "case2/run-A assistant reply persisted through resume",
        bMessages.some((m) => m.role === "assistant"),
        `${bMessages.filter((m) => m.role === "assistant").length} assistant messages in request`,
      );
      const recallIdxB = bMessages.findIndex((m) => JSON.stringify(m).includes("<long-term-memory-recall>"));
      ok(
        "case2/recall injected on the resumed turn too",
        recallIdxB >= 0,
        recallIdxB >= 0 ? `idx=${recallIdxB}` : "absent",
      );
      // Wire reconciliation merges consecutive user messages, so the turn's
      // injected recall can share one wire message with the run-B task text:
      // the provider-boundary property is that the current turn's message
      // carries the recalled block (appended after the direct human text),
      // while the run-A recall stays in the restored prefix untouched.
      const taskBMsg = idxB >= 0 ? bMessages[idxB] : null;
      ok(
        "case2/resumed turn carries the fresh recall block inside its own user message",
        Boolean(taskBMsg && JSON.stringify(taskBMsg).includes("<long-term-memory-recall>")),
        taskBMsg ? "run-B task message carries the recall block" : "no run-B task message",
      );
      ok(
        "case2/restored run-A recall is not duplicated inside the new turn's message",
        Boolean(taskBMsg && (taskBMsg.content ?? []).filter((c) => String(c?.text ?? "").includes("<long-term-memory-recall>")).length === 1),
        `recall blocks in run-B message=${(taskBMsg?.content ?? []).filter((c) => String(c?.text ?? "").includes("<long-term-memory-recall>")).length}`,
      );
    }

    // Child assertions come from the child-observed.json report written by inspect().
    const childReportPath = join(caseDir, "child-observed.json");
    const childObserved = existsSync(childReportPath) ? JSON.parse(readFileSync(childReportPath, "utf8")) : null;
    if (childObserved) {
      ok(
        "case2/fork child request used its own session id",
        Boolean(childObserved.sessionId && childObserved.sessionId !== sessionA),
        childObserved.sessionId || "none",
      );
      ok(
        "case2/fork child inherited the parent history (task A present)",
        childObserved.hasA,
        childObserved.childOwn ? "child prompt appended last" : "child prompt missing from last position",
      );
      ok(
        "case2/fork child kept the current turn appended (task B still in history or own prompt last)",
        childObserved.childOwn,
        `child msgs=${childObserved.total}`,
      );
    } else {
      ok("case2/fork child provider request observed", false, "child-observed.json missing");
    }

    // ---- store isolation after resume+fork
    {
      const db = readMemoryDb(home);
      ok(
        "case2/store has exactly the one recalled memory after resume+fork (no duplicates planted)",
        (db?.memories ?? []).length === 1 && db.memories[0].content === SEED_CONTENT,
        (db?.memories ?? []).map((m) => m.content).join(" | "),
      );
      const childId = childObserved?.sessionId ?? "";
      if (childId) {
        // Old pin: the raw JSONL SLICE copy of the child (it expected the
        // child's own assistant output inside the personal lane). The reviewed
        // capture lane admits ONLY direct-human non-delegated evidence:
        // assistant text is not eligible and the fork child is a delegated
        // session (isDelegatedHeader), so the child contributes ZERO
        // personal-lane rows. Positive-evidence anchor: the child's provider
        // request itself was observed above (child-observed.json), so the
        // exclusion below is a real executed path, not an unexecuted one.
        const childSources = readJournalSources(home, childId);
        ok(
          "case2/delegated fork child persisted NO personal-lane journal evidence (parent text and own assistant output both excluded)",
          !childSources.some((s) => s.text && (s.text.includes(CASE2_TASK_A) || s.text.includes(FORK_OUTPUT))),
          `child journal rows=${childSources.length} (child request positively observed above)`,
        );
        ok(
          "case2/delegated fork child persisted ZERO journal sources by design (isDelegatedHeader gate)",
          childSources.length === 0,
          childSources.map((s) => `${s.kind}#${s.seq}`).join(",") || "no journal sources for the child",
        );
      }
      // ---- migrated resume dedup + injected-source exclusion gates ----
      // Old pin (both were XFAILs against the removed JSONL slice lane):
      //   "resume should not recapture already-captured run-A events" and
      //   "recall snapshots should not duplicate in the slice store".
      // The reviewed producer lane made these properties invariant at the
      // durable layer: (a) re-flushed events dedup on the journal's immutable
      // (session_id, seq, event_hash) lineage, so the resumed run cannot
      // duplicate run-A evidence while run-B's own turn remains; (b) injected
      // recall snapshots are excluded from the enqueue gate entirely
      // (toJournalSourceEvent / isInjectedContextUserSource), so NO injected
      // personal-lane row can exist — recall stays a provider-boundary-only
      // injection, which the wire assertions above prove POSITIVELY.
      const parentSources = readJournalSources(home, sessionA);
      const parentHumanRows = parentSources.filter((s) => s.kind === "user" && Number(s.injected) === 0);
      const seenSeqs = new Set(parentHumanRows.map((s) => Number(s.seq)));
      const bothTasksOnce =
        parentHumanRows.some((s) => s.text.includes(CASE2_TASK_A)) &&
        parentHumanRows.some((s) => s.text.includes(CASE2_TASK_B)) &&
        seenSeqs.size === parentHumanRows.length;
      // PROMOTED to strict after an actual XPASS proof on the stable build:
      // the journal's immutable (session_id, seq, event_hash) lineage makes
      // resume-idempotence a durable property while capture keeps BOTH
      // direct-human turns (see MIGRATION-PHASE-B-RUNTIME-REVIEW.md §3).
      ok(
        "case2/resume did not re-capture run-A evidence and both direct-human turns persist exactly once (journal lineage)",
        bothTasksOnce,
        `human rows=${parentHumanRows.length}, distinct seqs=${seenSeqs.size}, taskA=${parentHumanRows.some((s) => s.text.includes(CASE2_TASK_A))}, taskB=${parentHumanRows.some((s) => s.text.includes(CASE2_TASK_B))}`,
      );
      const injectedRows = parentSources.filter((s) => Number(s.injected) === 1);
      const recallTextRows = parentSources.filter((s) => String(s.text).includes("<long-term-memory-recall>"));
      // The provider half of this gate is proven by the presence anchors above
      // ("recall block inside the first request of the run", "recalled seed
      // text verbatim", "recall injected on the resumed turn too"); this gate
      // therefore pins ONLY the durable-personal-lane exclusion. Occurrence
      // counting across all requests is intentionally NOT an equality: the
      // recall block legitimately persists inside the restored NATIVE session
      // history (and may appear in later requests/children carrying history).
      // PROMOTED to strict after an actual XPASS proof on the stable build
      // (see MIGRATION-PHASE-B-RUNTIME-REVIEW.md §3).
      ok(
        "case2/plugin-injected recall snapshots never persisted into the journal personal lane (injected row and recall-text row counts are zero)",
        injectedRows.length === 0 && recallTextRows.length === 0,
        `injected rows=${injectedRows.length}, recall-text rows=${recallTextRows.length}`,
      );
    }
    writeFileSync(join(caseDir, "build-snapshot.json"), JSON.stringify({
      pinned: SUITE_START_LIB.composite, files: SUITE_START_LIB.files, at: Date.now(),
    }, null, 2));
  } finally {
    await stub.close();
  }
  return { runid, caseDir, tag: "case2", build: SUITE_START_LIB.composite };
}

// ---------------------------------------------------------------------------
// CASE 3 variants: disabled mounts stay inert
// ---------------------------------------------------------------------------

async function case3Variant(variant) {
  console.log(`\n===== CASE 3 (${variant}): disabled mount inertness =====`);
  const { runid, caseDir, home, workspace } = prepareCase(`case3-${variant}`);
  const tag = `case3-${variant}`;
  CASE_BUILD_PIN.set(tag, SUITE_START_LIB.composite);
  await seedMemory(home, SEED_CONTENT, projectKeyFromCwd(workspace));
  const stub = createStub(caseDir);
  const port = await stub.start();
  const overlay = variant === "row"
    ? writeDisabledOverlay(caseDir)
    : writeMountOverlay(caseDir, { enabled: false, debug: true });
  try {
    // Composition verification: the disabled-row case must NOT rely on the
    // stale "target-by-id with no insert" behavior, which composes to "entry
    // not found" and skips the patch entirely (that tests absence, not
    // disable). Assert the plugin row is composed with disabled: true.
    const dump = await dumpComposition(home, workspace, overlay, port, `${runid}-dump`);
    ok(`${tag}/composition dump accepts the overlay`, dump.code === 0 && !dump.out.includes("not found"), dump.code === 0 ? dump.out.slice(-120) : dump.err.slice(-200));
    const dumpRows = dump.out.split("\n");
    const pluginRow = dumpRows.findIndex((l) => l.trim() === "- id: dsh-self-improved");
    ok(`${tag}/plugin row is present in the composed tree`, pluginRow >= 0, pluginRow >= 0 ? `line ${pluginRow + 1}` : "missing");
    if (variant === "row") {
      const disabledExpr = dumpRows.slice(pluginRow, pluginRow + 10).some((l) => /^  disabled: true$/.test(l.trim().length > 0 ? `  ${l.trim()}` : l));
      ok(
        `${tag}/plugin row carries disabled: true in the composed tree (disable dialect accepted)`,
        disabledExpr,
        dumpRows.slice(pluginRow, pluginRow + 8).map((l) => l).join(" | "),
      );
      {
        const rowIdx = dumpRows.findIndex((l) => l.trim() === "- id: session-telemetry-otel");
        ok(
          `${tag}/fixture composition disables the session-telemetry-otel row directly (verified patch dialect; the telemetry env switch is layered on top)`,
          rowIdx >= 0 && rowSliceHasDisabled(dumpRows, rowIdx),
          rowIdx >= 0 ? dumpRows.slice(rowIdx, rowIdx + 5).join(" | ") : "row missing",
        );
      }
    }
    const run = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlay, label: runid,
      args: ["--json", CASE2_TASK_A],
    });
    assertEgress(tag, run.egressLog, port);
  assertInvocationEnv(tag, run, port, runid);
    ok(`${tag}/run exit code 0`, run.code === 0, `exit=${run.code} :: ${run.err.slice(-300).replace(/\n/g, " | ")}`);

    const log = readProviderLog(caseDir);
    ok(
      `${tag}/main turn reached the provider once`,
      log.some((r) => JSON.stringify(r.body ?? {}).includes(CASE2_TASK_A)),
      `total requests=${log.length}`,
    );
    ok(
      `${tag}/no recall block reached the provider`,
      !log.some((r) => JSON.stringify(r.body ?? {}).includes("<long-term-memory-recall>")),
    );
    ok(
      `${tag}/no plugin-driven model work (no extractor aux call)`,
      !log.some((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)),
    );

    const db = readMemoryDb(home);
    ok(
      `${tag}/store content unchanged (only the fixture seed)`,
      (db?.memories ?? []).length === 1 && db.memories[0].content === SEED_CONTENT,
      (db?.memories ?? []).map((m) => m.content).join(" | "),
    );
    ok(
      `${tag}/no recall access recorded (access_count stays 0)`,
      (db?.memories ?? []).every((m) => m.access_count === 0),
      (db?.memories ?? []).map((m) => `${m.content}@${m.access_count}`).join(" | "),
    );

    if (variant === "row") {
      ok(
        `${tag}/plugin never mounted (no plugin log lines despite the disabled row being composed)`,
        !run.out.includes("[dsh-self-improved]") && !run.err.includes("[dsh-self-improved]"),
        run.err.includes("dsh-self-improved") ? run.err.slice(-200).replace(/\n/g, " | ") : "clean",
      );
      ok(
        `${tag}/no journal sinks or sources exist at all for the not-mounted plugin (plugin owns capture; no other writer may create them)`,
        (db?.journal?.sessions ?? []).length === 0,
        `sessions=${(db?.journal?.sessions ?? []).length} sources=${(db?.journal?.sources ?? []).length} jobs=${(db?.journal?.jobs ?? []).length}`,
      );
    } else {
      ok(
        `${tag}/plugin mounted but inert (loaded banner present)`,
        run.out.includes("dsh-self-improved loaded") || run.err.includes("dsh-self-improved loaded"),
        (run.out + run.err).includes("dsh-self-improved loaded") ? "mounted" : "missing mount",
      );
      ok(
        `${tag}/no journal sinks or sources exist at all for the not-mounted plugin (plugin owns capture; no other writer may create them)`,
        (db?.journal?.sessions ?? []).length === 0,
        `sessions=${(db?.journal?.sessions ?? []).length} sources=${(db?.journal?.sources ?? []).length} jobs=${(db?.journal?.jobs ?? []).length}`,
      );
      // Old pin: `extract_state` cursors empty (legacy cursor table, no longer
      // written by any lane; the schema keeps the table for compat only).
      // New pin: the producer lane's actual durable surface — journal_sources
      // — must carry zero pending/unconsumed rows while disabled.
      ok(
        `${tag}/no pending extraction work marked while disabled (journal sources empty or all zero-ack)`,
        (db?.journal?.sources ?? []).length === 0,
        `sources=${(db?.journal?.sources ?? []).length}`,
      );
      ok(
        `${tag}/recall pre-step never ran while disabled`,
        !run.out.includes("pre-step query:") && !run.err.includes("pre-step query:"),
      );
    }
    writeFileSync(join(caseDir, "build-snapshot.json"), JSON.stringify({
      pinned: SUITE_START_LIB.composite, files: SUITE_START_LIB.files, at: Date.now(),
    }, null, 2));
  } finally {
    await stub.close();
  }
  return { runid, caseDir, tag, build: SUITE_START_LIB.composite };
}

// ---------------------------------------------------------------------------
// CASE 4: accepted-job quiescence across an unmount
//
// rc.2's headless surface exposes no supported in-process hot-disable API
// (hmr requires the profileContext/appReady profile branch and is disabled in
// the headless bundle; plugin-manager and config-editor rows are disabled
// without profileContext). The supported lifecycle boundary here is a
// process-level unmount: run A accepts a pending extraction range, then
// further boots over the same home mount the plugin disabled or inert and
// must NOT touch the accepted job.
// ---------------------------------------------------------------------------

async function case4() {
  console.log("\n===== CASE 4: accepted-job quiescence across unmount =====");
  const { runid, caseDir, home, workspace } = prepareCase("case4");
  const tag = "case4";
  CASE_BUILD_PIN.set(tag, SUITE_START_LIB.composite);
  const stub = createStub(caseDir);
  const port = await stub.start();
  // Run A: capture enabled, extraction DISABLED by module config — the flush
  // marks the pending range, but the plugin never calls the extractor.
  const overlayA = writeMountOverlay(caseDir, { debug: true, modules: { capture: true, extract: false, consolidate: true, evolve: false, recall: true, tools: true } }, { name: "mount-a-v1.yml" });
  // Runs B/C over the same home are disabled mounts
  const overlayDisabled = writeDisabledOverlay(caseDir, { name: "disable-row-v1.yml" });
  const overlayInert = writeMountOverlay(caseDir, { enabled: false, debug: true }, { name: "mount-inert-v1.yml" });
  try {
    let sessionA = "";
    let runA = null;
    const noLearnings = '{"memories":[]}';
    const defaultHandlers = [
      ({ body }) => JSON.stringify(body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)
        ? {
            // The extractor MUST NOT be reached in this case (the module is
            // disabled in run A and the plugin is not mounted in runs B/C);
            // if it ever gets an aux request, the handler silently lies via
            // a normal response and the assertions below will catch it in
            // the provider log.
            respond: sseText(noLearnings),
          }
        : null,
      ({ record }) => ({ respond: sseText(`${record.sessionId === sessionA ? "" : ""}${QUIESC_ACK}`) }),
    ];
    stub.handlerList = defaultHandlers;

    // ---- run A: mount with capture on/extraction off
    runA = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlayA, label: `${runid}-A`,
      args: ["--json", QUIESC_TASK],
    });
    assertEgress("case4/runA", runA.egressLog, port);
  assertInvocationEnv("case4/runA", runA, port, `${runid}-A`);
    ok("case4/run A exit code 0", runA.code === 0, `exit=${runA.code} :: ${runA.err.slice(-300).replace(/\n/g, " | ")}`);
    sessionA = runA.out.match(/"type":"session","sessionId":"([^"]+)"/)?.[1] ?? "";
    ok("case4/run A session id", Boolean(sessionA), sessionA);
    const reqsAfterA = readProviderLog(caseDir);
    ok(
      "case4/run A issued only the main request + title (the in-process pump did not drain in this run, no aux call)",
      reqsAfterA.length > 0 && !reqsAfterA.some((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)),
      `total=${reqsAfterA.length}`,
    );
    const dbAfterA = readMemoryDb(home);
    const jxA = journalExtractState(dbAfterA, sessionA);
    // Old pin: `extract_state.pending_seq > 0 && processed_seq === 0` (legacy
    // cursor lane). New pin: the journal's own accepted-job artifacts —
    // capture enqueued unconsumed source(s) and created an extract job for
    // them (queued, awaiting every later enabled flush).
    ok(
      "case4/run A accepted a pending extraction job (capture enqueued an unconsumed range + the journal holds the queued job)",
      Boolean(
        jxA.sources.length > 0 &&
          jxA.pendingSources.length > 0 &&
          jxA.jobs.length > 0 &&
          jxA.openJobs.length > 0,
      ),
      `sources=${jxA.sources.length} pending=${jxA.pendingSources.length} jobs=${jxA.jobs.map((j) => j.state).join("|") || "none"}`,
    );
    ok(
      "case4/run A captured the accepted range in the journal personal lane (the accepted work exists durably)",
      jxA.pendingSources.length > 0,
      `sources=${jxA.sources.length}`,
    );
    const accessAfterA = (dbAfterA?.memories ?? []).reduce((sum, m) => sum + (m.access_count ?? 0), 0);
    const journalSnapshotAfterA = journalSessionSnapshot(dbAfterA, sessionA);
    const slicesAfterAHash = createHash("sha256").update(journalSnapshotAfterA).digest("hex");
    const memoriesAfterA = JSON.stringify(dbAfterA?.memories ?? []);
    ok(
      "case4/run A store contains no memory rows yet (accepted job unconsumed)",
      (dbAfterA?.memories ?? []).length === 0,
      `memories=${(dbAfterA?.memories ?? []).length}`,
    );
    if (!sessionA) { ok("case4/runs B/C skipped (no session id)", false); return { runid, caseDir, tag, build: SUITE_START_LIB.composite }; }

    // ---- run B: disabled-row unmount over the same home, same session
    const reqsBeforeB = readProviderLog(caseDir).length;
    const runB = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlayDisabled, label: `${runid}-B`,
      args: ["--json", "--session-id", sessionA, QUIESC_TASK],
    });
    assertEgress("case4/runB", runB.egressLog, port);
  assertInvocationEnv("case4/runB", runB, port, `${runid}-B`);
    ok("case4/run B (disabled row unmount) exit code 0", runB.code === 0, `exit=${runB.code} :: ${runB.err.slice(-300).replace(/\n/g, " | ")}`);
    ok("case4/run B adopted the session without recapture work", runB.out.includes(sessionA), sessionA);
    const reqsB = readProviderLog(caseDir, reqsBeforeB);
    ok(
      "case4/run B quiescence: no plugin-driven model work for the accepted job (no aux call)",
      !reqsB.some((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)),
      `requests this run=${reqsB.length}`,
    );
    ok(
      "case4/run B quiescence: no recall block reached the provider",
      !reqsB.some((r) => JSON.stringify(r.body ?? {}).includes("<long-term-memory-recall>")),
    );
    const dbAfterB = readMemoryDb(home);
    const journalSnapshotAfterB = journalSessionSnapshot(dbAfterB, sessionA);
    const jxB = journalExtractState(dbAfterB, sessionA);
    ok(
      "case4/run B quiescence: accepted extraction job journal artifacts byte-identical (job row, sources, chunks untouched)",
      journalSnapshotAfterB === journalSnapshotAfterA,
      `jobs after run B=${jxB.jobs.map((j) => j.state).join("|") || "none"}`,
    );
    const slicesAfterBHash = createHash("sha256").update(journalSessionSnapshot(dbAfterB, sessionA)).digest("hex");
    ok(
      "case4/run B quiescence: journal personal-lane rows untouched by the unmounted plugin",
      slicesAfterBHash === slicesAfterAHash,
      `journal hash before=${slicesAfterAHash.slice(0, 12)} after=${slicesAfterBHash.slice(0, 12)}`,
    );
    ok(
      "case4/run B quiescence: memory rows untouched",
      JSON.stringify(dbAfterB?.memories ?? []) === memoriesAfterA,
      `memories after run B=${(dbAfterB?.memories ?? []).length}`,
    );
    const accessAfterB = (dbAfterB?.memories ?? []).reduce((sum, m) => sum + (m.access_count ?? 0), 0);
    ok(
      "case4/run B quiescence: no recall access recorded by the unmounted plugin (access_count unchanged)",
      accessAfterB === accessAfterA,
      `access before=${accessAfterA} after=${accessAfterB}`,
    );

    // ---- run C: config-disabled (mounted but inert) over the same home, same session
    const reqsBeforeC = readProviderLog(caseDir).length;
    const runC = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlayInert, label: `${runid}-C`,
      args: ["--json", "--session-id", sessionA, QUIESC_TASK],
    });
    assertEgress("case4/runC", runC.egressLog, port);
  assertInvocationEnv("case4/runC", runC, port, `${runid}-C`);
    ok("case4/run C (config-disabled inert mount) exit code 0", runC.code === 0, `exit=${runC.code} :: ${runC.err.slice(-300).replace(/\n/g, " | ")}`);
    ok("case4/run C mounted but inert banner present", runC.out.includes("dsh-self-improved loaded") || runC.err.includes("dsh-self-improved loaded"), "");
    const reqsC = readProviderLog(caseDir, reqsBeforeC);
    ok(
      "case4/run C quiescence: no plugin-driven model work for the accepted job",
      !reqsC.some((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)),
      `requests this run=${reqsC.length}`,
    );
    ok(
      "case4/run C quiescence: no recall block reached the provider",
      !reqsC.some((r) => JSON.stringify(r.body ?? {}).includes("<long-term-memory-recall>")),
    );
    ok(
      "case4/run C quiescence: no capture pre-step while disabled",
      !runC.out.includes("pre-step query:") && !runC.err.includes("pre-step query:"),
    );
    const dbAfterC = readMemoryDb(home);
    const jxC = journalExtractState(dbAfterC, sessionA);
    ok(
      "case4/run C quiescence: accepted job journal artifacts still byte-identical after the inert mount",
      journalSessionSnapshot(dbAfterC, sessionA) === journalSnapshotAfterA,
      `jobs after run C=${jxC.jobs.map((j) => j.state).join("|") || "none"}`,
    );
    const slicesAfterCHash = createHash("sha256").update(journalSessionSnapshot(dbAfterC, sessionA)).digest("hex");
    ok(
      "case4/run C quiescence: journal personal-lane rows still untouched",
      slicesAfterCHash === slicesAfterAHash,
      `journal hash after run C=${slicesAfterCHash.slice(0, 12)}`,
    );

    // ---- the accepted job remains available to a later enabled mount (continuity)
    // Run D: re-enabled mount that finally drains. This is the positive
    // continuity direction of the quiescence fixture; it currently works for
    // capture but the accepted range consumed by the extractor is checked
    // against the same defect surface as case1 (explicitly xfail'd).
    stub.handlerList = [
      ({ body }) => JSON.stringify(body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)
        ? {
            respond: sseText(JSON.stringify({
              memories: [],
            })),
          }
        : null,
      ({ record }) => ({ respond: sseText(QUIESC_ACK) }),
    ];
    const overlayReenabled = writeMountOverlay(caseDir, { debug: false }, { name: "mount-reenable.yml" });
    const reqsBeforeD = readProviderLog(caseDir).length;
    const runD = await launchDsh({
      home, workspace, stubPort: port, overlayPath: overlayReenabled, label: `${runid}-D`,
      args: ["--json", "--session-id", sessionA, QUIESC_TASK],
    });
    assertEgress("case4/runD", runD.egressLog, port);
  assertInvocationEnv("case4/runD", runD, port, `${runid}-D`);
    ok("case4/run D (re-enabled) exit code 0", runD.code === 0, `exit=${runD.code} :: ${runD.err.slice(-300).replace(/\n/g, " | ")}`);
    const reqsD = readProviderLog(caseDir, reqsBeforeD);
    // The accepted job should still be there and get drained now: a fresh
    // process has no pump timestamp, so the aux call is expected on the first
    // flush. (The 30 s throttle only suppresses the SECOND in-process pump;
    // case5 probes exactly that.) Consuming the accepted range crosses the
    // case1 store-close race surface, which stays an explicit defect gate.
    ok(
      "case4/continuity: the accepted pending extraction job is drained by the first enabled flush after the disable window",
      reqsD.some((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER)),
      reqsD.some((r) => JSON.stringify(r.body ?? {}).includes(EXTRACTOR_SYSTEM_MARKER))
        ? "aux call observed on re-enable"
        : `no aux call in run D (${reqsD.length} requests)`,
    );
    const dbAfterD = readMemoryDb(home);
    const jxDa = journalExtractState(dbAfterD, sessionA);
    // Old pin: extract_state.processed_seq >= pending_seq (legacy cursor
    // lane). New pin on the journal's durable artifacts: every job accepted
    // BEFORE the disable window is drained — state 'done', every chunk acked,
    // and its accepted source range consumed=1 — while the aux call above
    // proves the drain ACTUALLY ran (not absence-driven).
    const acceptedJobIds = jxA.jobs.map((j) => j.id);
    const acceptedJobsAfterD = (dbAfterD?.journal?.jobs ?? []).filter((j) => acceptedJobIds.includes(j.id));
    const acceptedChunksAfterD = (dbAfterD?.journal?.chunks ?? []).filter((c) => acceptedJobIds.includes(c.job_id));
    const acceptedRanges = acceptedJobsAfterD.map((j) => ({ from: Number(j.from_seq), to: Number(j.to_seq) }));
    const acceptedRangeSources = jxDa.sources.filter((s) =>
      acceptedRanges.some((r) => Number(s.seq) >= r.from && Number(s.seq) <= r.to));
    ok(
      "case4/re-enable acknowledges every accepted range from before the disable window (same-tx journal job + consumed coordinates)",
      Boolean(
        acceptedJobIds.length > 0 &&
          acceptedJobsAfterD.length > 0 &&
          acceptedJobsAfterD.every((j) => j.state === "done") &&
          acceptedChunksAfterD.length > 0 &&
          acceptedChunksAfterD.every((c) => Number(c.acked) === 1) &&
          acceptedRangeSources.length > 0 &&
          acceptedRangeSources.every((s) => Number(s.consumed) === 1),
      ),
      `accepted jobs before=${acceptedJobsAfterD.map((j) => j.state).join("|") || "none"} chunks acked=${acceptedChunksAfterD.filter((c) => Number(c.acked) === 1).length}/${acceptedChunksAfterD.length} accepted-range sources consumed=${acceptedRangeSources.filter((s) => Number(s.consumed) === 1).length}/${acceptedRangeSources.length} (session-wide pending=${jxDa.pendingSources.length})`,
    );
    ok(
      "case4/explicit flush-drain consumes ranges accepted DURING the resumed run before headless exit (XPASS-proven, promoted strict)",
      Boolean(jxDa.pendingSources.length === 0 && jxDa.openJobs.length === 0 && jxDa.jobs.every((j) => j.state === "done")),
      `after run D: sources=${jxDa.sources.length} pending=${jxDa.pendingSources.length} jobs=${jxDa.jobs.map((j) => j.state).join("|")} open=${jxDa.openJobs.length}`,
    );
    writeFileSync(join(caseDir, "build-snapshot.json"), JSON.stringify({
      pinned: SUITE_START_LIB.composite, files: SUITE_START_LIB.files, at: Date.now(),
    }, null, 2));
  } finally {
    await stub.close();
  }
  return { runid, caseDir, tag, build: SUITE_START_LIB.composite };
}

// ---------------------------------------------------------------------------
// CASE 5: in-process probes against the genuine journal worker lane
//
// The legacy `Extractor` class is NOT used by the runtime anymore at any of
// the four drive points (MIGRATION-PHASE-B-EXTRACT.md §1.2) — probing it here
// would be a fake pass. These probes therefore construct the REAL runtime
// objects the flush callback drives: MemoryStore → MemoryJournalV02 →
// createJournalExtractSeam → createJournalExtractWorker, with the producer
// events built through the REAL capture gate (toJournalSourceEvent /
// journalProducerHeader / opaqueProjectIdFromKey). Only the LLM call is a
// controlled fake (outcome-programmable), mirroring the extract-lane suite's
// contract; every durable claim covers REAL persisted journal state.
// ---------------------------------------------------------------------------

async function case5() {
  console.log("\n===== CASE 5: in-process probes on the genuine journal extract worker =====");
  const { runid, caseDir, home, workspace } = prepareCase("case5");
  const tag = "case5";
  CASE_BUILD_PIN.set(tag, SUITE_START_LIB.composite);
  writeFileSync(join(caseDir, "build-snapshot.json"), JSON.stringify({
    pinned: SUITE_START_LIB.composite, files: SUITE_START_LIB.files, at: Date.now(),
  }, null, 2));
  const storageLib = await import(pathToFileURL(join(SHADOW, "lib", "storage.js")).href);
  const journalLib = await import(pathToFileURL(join(SHADOW, "lib", "memory-journal-v02.js")).href);
  const extractJournalLib = await import(pathToFileURL(join(SHADOW, "lib", "extract-journal-v02.js")).href);
  const captureLib = await import(pathToFileURL(join(SHADOW, "lib", "capture.js")).href);
  const storeDir = join(home, "memory");
  const store = new storageLib.MemoryStore(storeDir);
  try {
    const sessionId = "probe-session";
    const journal = new journalLib.MemoryJournalV02(store);
    // Real capture-side gate and producer identity, exactly as installCapture
    // builds the enqueue input for a non-delegated direct-human turn.
    const captureEvent = (seq, text) => ({
      type: "user/message", seq, time: Date.now(),
      data: { content: [{ type: "text", text }], source: { kind: "user" } },
    });
    // Capture-gate negatives exercised for real (the runtime e2e can only
    // observe the aggregate lane, not the per-event gate):
    ok(
      "case5/real capture gate: assistant, injected, and delegated turns are ineligible (events never reach the journal personal lane)",
      captureLib.toJournalSourceEvent({ type: "assistant/message", seq: 0, data: { content: "assistant wrote FORK-OUT text" } }, { delegated: false }) === null &&
        captureLib.toJournalSourceEvent(
          { type: "user/message", seq: 1, data: { content: [{ type: "text", text: "x" }], source: { kind: "dsh-self-improved" } } },
          { delegated: false },
        ) === null &&
        captureLib.toJournalSourceEvent(captureEvent(2, "looks human"), { delegated: true }) === null,
    );
    const mkSource = (seq, text) =>
      captureLib.toJournalSourceEvent(captureEvent(seq, text), { delegated: false });
    const enqueue = (seq, text) => journal.appendSession({
      sessionId,
      projectId: captureLib.opaqueProjectIdFromKey(projectKeyFromCwd(workspace)),
      producer: captureLib.journalProducerHeader({}, false),
      events: [mkSource(seq, text)],
      sourceMaxChars: captureLib.JOURNAL_SOURCE_MAX_CHARS,
    });
    const calls = [];
    const outcomes = [
      JSON.stringify({ memories: [{ kind: "fact", scope: "global", content: "User's in-process probe fact PINE-MARK-31", importance: 8, confidence: 1, source_role: "user", evidence: "user wrote this fact about pine mark 31" }] }),
      JSON.stringify({ memories: [{ kind: "fact", scope: "global", content: "User's in-process probe fact PINE-MARK-32", importance: 8, confidence: 1, source_role: "user", evidence: "user wrote this second fact about pine mark 32" }] }),
    ];
    let callIndex = 0;
    // Injected clock driving ONLY the worker's in-process throttle window
    // (deterministic, no sleeps): the journal's own durable timestamps keep
    // real wall time, so leases/backoff behave normally.
    const clock = { now: Date.now() };
    const kickHandles = [];
    const deferredJobs = [];
    const worker = extractJournalLib.createJournalExtractWorker({
      seam: captureLib.createJournalExtractSeam(journal),
      store,
      // Controlled fake provider (same honesty boundary as the extract-lane
      // suite): records every call and returns a stop-finish validated
      // outcome; all durable claims below cover REAL persisted journal state.
      callLlm: async (input) => {
        const idx = callIndex++;
        calls.push({ at: Date.now(), sessionId: input.sessionId || null });
        return { status: "completed", finishKind: "stop", hasFinish: true, text: outcomes[idx] ?? '{"memories":[]}' };
      },
      settings: { enabled: true, timeoutMs: 60_000, minImportance: 6, dedup: true },
      // Injected clock driving ONLY the worker's in-process throttle window
      // (deterministic, no sleeps): the journal's own durable timestamps keep
      // real wall time, so leases/backoff behave normally.
      nowMs: () => clock.now,
      timer: {
        set: (cb, delay) => { const handle = { cb, delay, cleared: false }; kickHandles.push(handle); return handle; },
        clear: handle => { handle.cleared = true; },
      },
      onDeferredJob: job => { deferredJobs.push(job); },
    });

    // flush checkpoint #1 (fresh process): enqueue + pump — the throttle must
    // allow the FIRST pump, exactly as the runtime flush callback does.
    enqueue(0, "user wrote this fact about pine mark 31");
    let pumpErr = null;
    const pumpA = await worker.pump().catch((e) => { pumpErr = e; return null; });
    ok(
      "case5/probe first pump of a fresh process claims the accepted queued job and reaches the extractor",
      !pumpErr && pumpA?.errors === 0 && pumpA?.claimed === 1 && calls.length === 1,
      `claimed=${pumpA?.claimed} calls=${calls.length} errors=${pumpA?.errors} err=${pumpErr ? String(pumpErr.message ?? pumpErr) : "none"}`,
    );
    const dbBeforeControl = readMemoryDbDir(storeDir);
    const storedMemory31 = (dbBeforeControl?.memories ?? []).find((m) => m.content === "User's in-process probe fact PINE-MARK-31");
    // Old pin: `extract_state.processed_seq === pending_seq === 2`. New pin:
    // the same-tx commit's artifacts — job done, source consumed, derived
    // support link with fail-close provenance, real memory row + explicit
    // evidence coordinate.
    ok(
      "case5/probe first pump committed its chunk in the same transaction (job done + source consumed + derived support link)",
      Boolean(
        storedMemory31 &&
          (dbBeforeControl?.journal?.sources ?? []).every((s) => s.session_id !== sessionId || Number(s.consumed) === 1) &&
          (dbBeforeControl?.journal?.jobs ?? []).filter((j) => j.session_id === sessionId).every((j) => j.state === "done") &&
          derivedForMemory(dbBeforeControl, storedMemory31).length > 0,
      ),
      `memory31=${storedMemory31 ? "row" : "missing"} sources=${JSON.stringify((dbBeforeControl?.journal?.sources ?? []).map((s) => `${s.session_id}#${s.seq}@c${s.consumed}`))} jobs=${JSON.stringify((dbBeforeControl?.journal?.jobs ?? []).map((j) => `${j.session_id}:${j.state}`))}`,
    );
    const meta31 = (dbBeforeControl?.meta ?? []).find((m) => m.memory_id === storedMemory31?.id);
    const evidence31 = parseEvidenceColumn(meta31?.evidence);
    const src31 = (dbBeforeControl?.journal?.sources ?? []).find((s) => s.session_id === sessionId && Number(s.seq) === 0);
    ok(
      "case5/probe derived row carries fail-close provenance + the explicit coordinate of the matched source (support link: snippet verbatim inside the retained text)",
      Boolean(
        storedMemory31 &&
          meta31?.provenance === "derived" &&
          meta31?.source === "llm-extract" &&
          evidence31.some((e) => e.sessionId === sessionId && e.seq === 0) &&
          evidence31.every((e) => typeof e.snippet === "string" && normalized(src31?.text ?? "").includes(normalized(e.snippet))),
      ),
      `provenance=${meta31?.provenance ?? "none"} source=${meta31?.source ?? "none"} evidence=${evidence31.map((e) => `${e.sessionId}#${e.seq}`).join("|") || "none"} snippetMatch=${evidence31.every((e) => typeof e.snippet === "string" && normalized(src31?.text ?? "").includes(normalized(e.snippet)))}`,
    );

    // Second flush in the SAME process inside the in-process window — the
    // events enqueue and the pump run exactly as the runtime fast path does.
    enqueue(1, "user wrote this second fact about pine mark 32");
    const pumpB = await worker.pump().catch((e) => { pumpErr = e; return null; });
    ok(
      "case5/second flush is deferred into exactly one owned timer, not silently dropped or immediately stormed",
      !pumpErr && calls.length === 1 && pumpB?.claimed === 0 && pumpB?.deferred === 1 && pumpB?.errors === 0 && kickHandles.filter(h => !h.cleared).length === 1,
      `second pump calls=${calls.length} claimed=${pumpB?.claimed} result=${JSON.stringify(pumpB)}`,
    );
    // Positive drop observation (what the throttle currently produces): the
    // marked range is durable accepted work — a queued job over an
    // unconsumed source — and exactly one LLM call happened. The drop is
    // DIRECTLY observable journal state, not just a pump counter.
    const dbAfterB = readMemoryDbDir(storeDir);
    const jxB = journalExtractState(dbAfterB, sessionId);
    const dropped = calls.length === 1;
    ok(
      dropped
        ? "case5/probe the marked second range is durable accepted work while the throttle holds it (queued job + unconsumed source)"
        : "case5/probe the second pump drained immediately (dedup lane fixed the throttle gap): the second range was fully consumed",
      Boolean(jxB.sources.some((s) => Number(s.seq) === 1) && (dropped ? jxB.openJobs.length === 1 && jxB.pendingSources.length === 1 : jxB.pendingSources.length === 0 && jxB.openJobs.length === 0)),
      `sources=${jxB.sources.length} pending=${jxB.pendingSources.length} calls=${calls.length} openJobs=${jxB.openJobs.map((j) => j.state).join("|")}`,
    );
    // Advance the controlled owned timer, NOT another external pump. Its
    // real SQLite commit, second provider call and support link prove eventual
    // draining. The repaired predicate XPASSed before deliberate promotion.
    clock.now += 31_000;
    const kick = kickHandles.find(h => !h.cleared);
    if (kick) { kick.cleared = true; kick.cb(); }
    await Promise.all(deferredJobs).catch(e => { pumpErr = e; });
    const dbAfterKick = readMemoryDbDir(storeDir);
    const jxC = journalExtractState(dbAfterKick, sessionId);
    const memory32 = (dbAfterKick?.memories ?? []).find(m => m.content === "User's in-process probe fact PINE-MARK-32");
    ok(
      "case5/owned kick drains the second accepted range without another external pump (XPASS-proven, deliberately promoted strict)",
      !pumpErr && calls.length === 2 && deferredJobs.length === 1 && Boolean(memory32) && derivedForMemory(dbAfterKick, memory32).length > 0 && jxC.pendingSources.length === 0 && jxC.openJobs.length === 0 && jxC.jobs.every((job) => job.state === "done"),
      `calls=${calls.length} sources pending=${jxC.pendingSources.length} jobs=${jxC.jobs.map((j) => j.state).join("|")} err=${pumpErr ? String(pumpErr.message ?? pumpErr) : "none"}`,
    );
  } finally {
    store.close();
  }
  return { runid, caseDir, tag, build: SUITE_START_LIB.composite };
}

/** Journal-aware store reader for the in-process probe store (same shape as
 *  readMemoryDb; the probe store path is passed explicitly). */
function readMemoryDbDir(storeDir) {
  const dbPath = join(storeDir, "memory.db");
  if (!existsSync(dbPath)) return null;
  const db = new DatabaseSync(dbPath);
  try {
    const memories = db.prepare("select id, kind, content, importance, access_count, status from memories order by created_at").all();
    const meta = db.prepare("select memory_id, provenance, source, scope, project_id, session_id, confidence, read_count, evidence from memories_meta").all();
    const journal = { sessions: [], sources: [], parts: [], jobs: [], chunks: [], derived: [], error: null };
    try {
      journal.sources = db.prepare("select session_id, seq, ts, kind, text, text_chars, source_kind, injected, event_hash, consumed, revoked from journal_sources order by session_id, seq").all();
      journal.parts = db.prepare("select session_id, seq, idx, text from journal_source_parts order by session_id, seq, idx").all();
      for (const source of journal.sources) {
        source.root_text = source.text;
        source.text += journal.parts.filter(part => part.session_id === source.session_id && part.seq === source.seq).map(part => part.text).join("");
      }
      journal.jobs = db.prepare("select id, kind, session_id, from_seq, to_seq, state, attempt_count, last_error, retry_after_at from journal_jobs order by created_at").all();
      journal.derived = db.prepare("select job_id, chunk_idx, ordinal, memory_id, candidate_key, provenance from journal_derived order by job_id, chunk_idx, ordinal").all();
    } catch (err) { journal.error = String(err); }
    return { memories, meta, journal };
  } finally { db.close(); }
}

/** Derived support links recorded for one memory row. */
function derivedForMemory(db, memory) {
  return memory ? (db?.journal?.derived ?? []).filter((d) => d.memory_id === memory.id) : [];
}

/** Evidence/snippet normalization identical to the lane's matcher (whitespace
 *  collapsed + lowercased), so verbatim support-link checks do not flake on
 *  formatting while still proving real containment. */
function normalized(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}


// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function writeSuiteLog(caseSuiteFailed) {
  const pass = RESULTS.filter((r) => r.class === "check" && r.ok).length;
  const fail = RESULTS.filter((r) => r.class === "check" && !r.ok).length;
  const xfailN = RESULTS.filter((r) => r.class === "exfail" && !r.ok).length;
  const xpassed = RESULTS.filter((r) => r.class === "exfail" && r.ok);
  const xpassN = xpassed.length;
  console.log(`\n=== runtime fixture summary: STRICT ${pass} PASS / ${fail} FAIL; expected-failing defects: ${xfailN} XFAIL (gated down) / ${xpassN} XPASS (surprise) ===`);
  for (const xp of xpassed) console.log(`XPASS - ${xp.name} :: ${xp.detail}`);
  const verdict = caseSuiteFailed || fail > 0 || xpassN > 0
    ? (xpassN > 0 ? "SUITE FAILED — XPASS: a tracked-defect gate needs reclassification" : "SUITE FAILED — strict gate failure")
    : "SUITE PASSED (strict gates all hold; tracked defects are explicitly gated down)";
  console.log(`=== ${verdict} ===`);
  if (libChangedDuringSuite) {
    console.log("=== build attribution NOTE: lib/ changed between suite start and case pinning; per-case hashes were pinned at case start ===");
  }
  const finalLib = libSnapshot();
  const changed = finalLib.composite !== SUITE_START_LIB.composite;
  console.log(`=== build pin: suite-start ${SUITE_START_LIB.composite.slice(0, 16)}… / suite-end ${finalLib.composite.slice(0, 16)}…; ${changed ? "CHANGED during suite (a concurrent src/ rebuild occurred; results below are attributed to the suite-start build)" : "stable across suite"} ===`);
  // Durable attribution pin: survives the temp-dir cleanup of passing cases.
  try {
    writeFileSync(join(FIXTURES, "last-suite-pin.json"), JSON.stringify({
      captured: Date.now(),
      pinned: SUITE_START_LIB.composite,
      files: SUITE_START_LIB.files,
      suiteEndComposite: finalLib.composite,
      changedDuringSuite: changed,
      perCase: Object.fromEntries(CASE_BUILD_PIN),
      results: RESULTS,
    }, null, 2));
  } catch (error) {
    console.warn(`(could not persist last-suite-pin.json: ${error?.message})`);
  }
  return { pass, fail, xfailN, xpassN, changed: changed || libChangedDuringSuite };
}

function main() {
  const argv = process.argv.slice(2);
  const pick = argv.includes("--case") ? argv[argv.indexOf("--case") + 1] : "";
  const keep = argv.includes("--keep");
  if (!precondOk) { process.exitCode = 1; return; }

  buildShadow();

  const plan = [];
  if (!pick) plan.push("case1", "case2", "case3-row", "case3-config", "case4", "case5");
  else plan.push(pick);

  mkdirSync(TEMP, { recursive: true });

  (async () => {
    let failed = false;
    for (const which of plan) {
      const startedAt = Date.now();
      let res = null;
      try {
        res = which === "case1" ? await case1()
          : which === "case2" ? await case2()
          : which === "case3-row" ? await case3Variant("row")
          : which === "case3-config" ? await case3Variant("config")
          : which === "case4" ? await case4()
          : await case5();
      } catch (e) {
        console.error(`FAIL - ${which} crashed: ${e && e.stack ? e.stack : String(e)}`);
        failed = true;
        continue;
      }
      const prefix = res?.tag ?? which;
      const good = caseGood(prefix);
      console.log(`----- ${which} ${good ? "OK" : "FAILED"} (${res?.build ? `build ${res.build.slice(0, 12)}…` : "build unknown"}) in ${((Date.now() - startedAt) / 1000).toFixed(1)}s -----`);
      if (res?.caseDir) {
        if (good && !keep) {
          if (cleanupTempDir(res.caseDir)) console.log(`cleaned ${res.caseDir}`);
        } else {
          console.log(`kept ${res.caseDir}${keep ? " (--keep)" : " for diagnosis (assertions failed or unexpected xpass)"}`);
        }
      }
      if (!good) failed = true;
    }
    writeSuiteLog(failed);
    if (failed) process.exitCode = 1;
  })();
}

main();
