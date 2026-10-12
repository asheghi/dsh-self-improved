#!/usr/bin/env node
/**
 * scripts/test-v02-mounted-ui.mjs — Phase A MOUNTED browser-acceptance fixture runner.
 *
 * This file (with fixtures/v02-ui/** and MIGRATION-MOUNTED-UI-TESTS.md) is the
 * deliverable of the mounted-UI worker. It automates the deterministic half of
 * the mounted browser gate:
 *
 *   `up`      prepare a uniquely owned isolated run dir with a SHADOW package
 *             of the repo's built lib + client.js, compose an isolated rc.2
 *             profile (`profiles/mounted-ui`) whose own patch row mounts the
 *             shadow (no config block — rc.2 settings writes are honored only
 *             on the profile-patch face, see the ledger doc), seed synthetic
 *             memory rows, and START a loopback logging provider stub +
 *             `dsh --profile mounted-ui web --no-open --port 0`, then print
 *             the run facts (URL/token/port/pinned hashes).
 *   `verify`  rerun every DURABLE side of the browser gates against a run dir:
 *             served client bundle bytes vs the repo client.js (the no-stale-
 *             bundle illusion gate), the composed boot graph row, the
 *             persisted settings overrides in the profile patch, the store
 *             state the browser produced (logical forget + supersession with
 *             user-direct provenance), and a zero-request provider log for
 *             the paused window. Auth is taken from `--cookie "dsh-auth-…=v1.…"`.
 *   `down`    kill the tracked server/stub PIDs and guarded cleanup the run
 *             dir (owner marker + guarded-root checks; kept with --keep or on
 *             verification failure).
 *
 * The INTERACTIVE half (stale-conflict banner, rebase/discard, dirty-only
 * badge behavior, dialog focus lifecycle, keyboard :focus-visible,
 * light/dark rendering, destructive-confirmation dialogs) runs over the
 * Chrome DevTools MCP against this server inside ISOLATED synthetic browser
 * contexts (context name `dsh-self-improved-mounted-ui-test`) and never the
 * existing 127.0.0.1:3082 page/profile. The full protocol and every measured
 * outcome is the ledger in MIGRATION-MOUNTED-UI-TESTS.md.
 */

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = new URL("..", import.meta.url).pathname;
const RUNTIME = "/home/bahman/github/dsh-v0.2"; // installed read-only rc.2 installation
const DSH_BIN = join(RUNTIME, "node_modules", ".bin", "dsh");
const RC2 = "0.2.0-rc.2";
const TEMP = join(ROOT, "fixtures", "v02-ui", "temp");
const OWNER_MARKER = ".dsh-mounted-ui-owner.json";

const args = process.argv.slice(2);
const mode = args[0];
const flagValue = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const keep = args.includes("--keep");
const fresh = args.includes("--fresh");

const SEED_ROWS = [
  "Mounted-UI synthetic fact: the Luna test token is LUNA-SYNTH-4102.",
  "Mounted-UI synthetic fact: the Basin test token is BASIN-SYNTH-7755.",
  "Mounted-UI synthetic fact: the Forge test token is FORGE-SYNTH-3311.",
];

/** Which top-level config keys a patch file carries (fresh-run cleanliness). */
function patchedKeysOf(patch) {
  const keys = [...patch.matchAll(/^\s+([A-Za-z][\w.]*):\s*$/gm)].map((m) => m[1]);
  return keys.join(",") || "none";
}

const SHADOW_RUNTIME_DEPS = [
  "@deepseek-ai/cordis", "@deepseek-ai/cordis-plugin-loader", "@deepseek-ai/cosmokit", "@deepseek-ai/schemastery",
  "@deepseek-ai/dsh-agent", "@deepseek-ai/dsh-agent-default-model", "@deepseek-ai/dsh-home-paths",
  "@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-schedule", "@deepseek-ai/dsh-session", "@deepseek-ai/dsh-session-query",
  "@deepseek-ai/dsh-session-projection", "zod",
  "@deepseek-ai/dsh-settings", "@deepseek-ai/dsh-skill", "@deepseek-ai/dsh-storage-domain",
  "@deepseek-ai/dsh-system-prompt", "@deepseek-ai/dsh-tools", "@deepseek-ai/dsh-typert-protocol",
];

function sha256File(p) { return createHash("sha256").update(readFileSync(p)).digest("hex"); }

function preconditions() {
  if (!existsSync(DSH_BIN)) throw new Error(`dsh binary not found: ${DSH_BIN}`);
  const dshPkg = JSON.parse(readFileSync(join(RUNTIME, "node_modules", "@deepseek-ai", "dsh", "package.json"), "utf8"));
  if (dshPkg.version !== RC2) throw new Error(`installed dsh is ${dshPkg.version}, expected ${RC2}`);
  for (const f of ["lib/index.js", "client.js"]) {
    if (!existsSync(join(ROOT, f))) throw new Error(`${f} missing — build first (node scripts/typecheck-v02.mjs --emit-lib)`);
  }
}

function guardedCleanup(dir) {
  let resolved = "";
  try { resolved = realpathSync(dir); } catch { return false; }
  let guardedRoot = "";
  try { guardedRoot = realpathSync(TEMP); } catch { return false; }
  if (!resolved.startsWith(guardedRoot + "/")) { console.warn(`cleanup skipped (outside guarded root): ${resolved}`); return false; }
  if (!existsSync(join(resolved, OWNER_MARKER))) { console.warn(`cleanup skipped (owner marker missing): ${resolved}`); return false; }
  if (resolved === guardedRoot) { console.warn("cleanup skipped (cannot remove the guarded root)"); return false; }
  rmSync(resolved, { recursive: true, force: true });
  return true;
}

function buildShadow(pluginDir) {
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, "lib"), { recursive: true });
  mkdirSync(join(pluginDir, "node_modules", "@deepseek-ai"), { recursive: true });
  mkdirSync(join(pluginDir, "node_modules", "@node-rs"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "lib")).filter((f) => f.endsWith(".js"))) {
    copyFileSync(join(ROOT, "lib", f), join(pluginDir, "lib", f));
  }
  copyFileSync(join(ROOT, "client.js"), join(pluginDir, "client.js"));
  writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
    name: "dsh-self-improved",
    version: "0.0.0-fixture-ui",
    type: "module",
    exports: { ".": "./lib/index.js", "./client": "./client.js" },
    dsh: { client: { platform: "web" } },
    // Preserve the tested dependency declaration used by guarded schema load;
    // a shadow must not silently disable C while claiming a mounted gate.
    dependencies: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies,
    peerDependencies: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).peerDependencies,
  }, null, 2));
  const runtimeNm = join(RUNTIME, "node_modules");
  for (const p of SHADOW_RUNTIME_DEPS) {
    if (!existsSync(join(runtimeNm, p))) throw new Error(`runtime dependency missing: ${p}`);
    rmSync(join(pluginDir, "node_modules", p), { force: true });
    symlinkSync(join(runtimeNm, p), join(pluginDir, "node_modules", p), "dir");
  }
  for (const spec of ["@node-rs/jieba", "sqlite-vec", "sqlite-vec-linux-x64"]) {
    const from = join(ROOT, "node_modules", spec);
    if (!existsSync(from)) throw new Error(`repo dependency missing: ${spec}`);
    rmSync(join(pluginDir, "node_modules", spec), { force: true });
    symlinkSync(from, join(pluginDir, "node_modules", spec), "dir");
  }
}

function scaffoldProfile(profileDir, pluginDir) {
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, "package.json"), JSON.stringify({
    name: "dsh-profile-mounted-ui",
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] } },
  }, null, 2));
  writeFileSync(join(profileDir, "pnpm-workspace.yaml"), "packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n");
  writeFileSync(join(profileDir, "cordis.yml"), "# dsh profile root — empty entry list; the patch below owns inserts.\n[]\n");
  writeFileSync(join(profileDir, "cordis.patch.yml"),
    "# mounted-UI fixture profile patch (owned by fixtures/v02-ui):\n" +
    "# one plugin row WITHOUT a config block — an rc.2 settings write for an\n" +
    "# entry is refused while the entry config is composition-owned\n" +
    "# (verified live: overlay-supplied config => settings/mutate refused), so\n" +
    "# the real settings UX mounts on the profile-patch face.\n" +
    "- insert:\n" +
    `    - id: dsh-self-improved\n      name: ${pathToFileURL(join(pluginDir, "lib", "index.js")).href}\n\n` +
    "- id: session-telemetry-otel\n  disabled: true\n" +
    // Opt-in fixture config for the end-to-end continuity run: the lane and its
    // body consent are ON at boot, with the aux route pointed at the loopback
    // provider stub. Only the e2e fixture sets DSI_E2E_CONTINUITY; every other
    // mounted gate keeps composing the row without a config block.
    (process.env.DSI_E2E_CONTINUITY === "1"
      ? "\n- id: dsh-self-improved\n  config:\n    extract:\n      provider: deepseek-official\n      model: deepseek-flash\n    continuity:\n      enabled: true\n      summaryEnabled: true\n"
      : ""));
}

/** Loopback-only provider stub (see fixtures/v02-ui/provider-stub.mjs): canned
 *  SSE completion, request log on disk, and an extractive answer for the
 *  continuity handoff worker so a fixture can exercise the real path. */
const STUB_PATH = join(ROOT, "fixtures", "v02-ui", "provider-stub.mjs");

async function spawnStub(logPath) {
  const proc = spawn("node", [STUB_PATH, logPath], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  proc.stdout.on("data", (d) => { out += String(d); });
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (out.includes("STUB_READY")) { clearInterval(timer); resolve(); }
    }, 100);
    setTimeout(() => { clearInterval(timer); resolve(); }, 5000);
  });
  const m = out.match(/port=(\d+)/);
  if (!m) throw new Error("provider stub did not report a port: " + out);
  return { proc, port: Number(m[1]) };
}

function serverEnv(home, stubPort) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
    HOME: home,
    DSH_HOME: home,
    TMPDIR: join(home, "tmp"),
    DSH_TELEMETRY_DISABLED: "1",
    DSH_PERMISSION_MODE: "workspace-write",
    DEEPSEEK_BASE_URL: `http://127.0.0.1:${stubPort}`,
    DEEPSEEK_API_KEY: "synthetic-mounted-ui-key-" + randomUUID().slice(0, 6),
  };
}

async function seedStore(storeDir) {
  const { MemoryStore } = await import(pathToFileURL(join(ROOT, "lib", "storage.js")).href);
  const store = new MemoryStore(storeDir);
  try {
    for (const content of SEED_ROWS) {
      store.insertMemory(
        { kind: "fact", content, importance: 7 },
        { provenance: "user", source: "mounted-ui-seed", scope: "project", projectId: "mounted-ui", sessionId: "seed-sess", confidence: 1, evidence: [] },
      );
    }
  } finally { store.close(); }
}

async function stageUp() {
  preconditions();
  const runid = `mounted-ui-${Date.now()}-${randomUUID().slice(0, 6)}`;
  mkdirSync(TEMP, { recursive: true });
  const runDir = join(TEMP, runid);
  const home = join(runDir, "home");
  mkdirSync(join(home, "tmp"), { recursive: true });
  writeFileSync(join(runDir, OWNER_MARKER), JSON.stringify({ created: Date.now(), runid, pid: process.pid }, null, 2));
  const pluginDir = join(runDir, "plugin");
  buildShadow(pluginDir);
  const profileName = "mounted-ui";
  const profileDir = join(home, "profiles", profileName);
  scaffoldProfile(profileDir, pluginDir);
  await seedStore(join(home, "memory"));
  const stub = await spawnStub(join(runDir, "provider-requests.jsonl"));
  // The server runs INDEPENDENTLY of this process (so `verify`/`down` can use
  // it later): spawn it detached and record its pid.
  const env = serverEnv(home, stub.port);
  const argv = [DSH_BIN, "--profile", profileName, "--no-open", "--port", "0"];
  const proc = spawn("node", argv, { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  // The server's own console is the ONLY place most mounted failures explain
  // themselves (plugin warnings, refusals, provider errors). Tee both streams
  // to <runDir>/server.log so `verify` and a human can read them, and never
  // leave a piped stream unread (an unread pipe blocks the child).
  const serverLog = join(runDir, "server.log");
  const serverLogStream = createWriteStream(serverLog, { flags: "w" });
  let out = "";
  const url = await new Promise((resolve) => {
    const timer = setInterval(() => { const m = out.match(/dsh web: (http\S+)/); if (m) { clearInterval(timer); resolve(m[1]); } }, 100);
    proc.stdout.on("data", (d) => { const text = String(d); out += text; serverLogStream.write(text); });
    proc.stderr.on("data", (d) => { serverLogStream.write(String(d)); });
    setTimeout(() => { clearInterval(timer); resolve(null); }, 40000);
  });
  if (!url) throw new Error("test GUI server did not report a URL\n" + out);
  const facts = {
    runid, runDir, home, pluginDir, profileDir, profileName,
    stub: { port: stub.port, pid: stub.proc.pid, log: join(runDir, "provider-requests.jsonl") },
    server: { pid: proc.pid, log: serverLog },
    url,
    build: sha256File(join(ROOT, "lib", "index.js")),
    client: sha256File(join(ROOT, "client.js")),
    seeded: SEED_ROWS.length,
  };
  writeFileSync(join(runDir, "facts.json"), JSON.stringify(facts, null, 2));
  proc.unref(); stub.proc.unref();
  console.log(JSON.stringify(facts, null, 2));
  // IMPORTANT: this runner process must STAY ALIVE for as long as the spawned
  // server lives — the session sandbox tears down its children with the
  // runner's death. Idling also keeps `down` findable in the same job.
  process.on("SIGTERM", () => { try { proc.kill("SIGKILL"); } catch {} try { stub.proc.kill("SIGKILL"); } catch {} process.exit(0); });
  setInterval(() => {}, 1 << 30);
}

/** Fetch with a cookie header, tolerating the redirect issuing the session. */
function authHeader(cookieFlag) {
  const raw = flagValue(cookieFlag) ?? flagValue("--cookie");
  if (!raw) throw new Error("verify needs --cookie \"dsh-auth-<name>=v1.…\" (from an authenticated fixture page)");
  return raw.trim();
}

async function stageVerify() {
  preconditions();
  const runDir = realpathSync(flagValue("--run") ?? "");
  const facts = JSON.parse(readFileSync(join(runDir, "facts.json"), "utf8"));
  const results = [];
  const check = (name, cond, detail = "") => { results.push({ name, ok: Boolean(cond), detail }); console.log(`${cond ? "PASS" : "FAIL"} - ${name}${detail ? " :: " + detail : ""}`); };

  check("run dir owns its owner marker", existsSync(join(runDir, OWNER_MARKER)));
  check("pinned build hash matches the current repo build", facts.build === sha256File(join(ROOT, "lib", "index.js")), `${facts.build.slice(0, 12)}…`);

  const cookie = authHeader();
  const baseUrl = facts.url.match(/(http:\/\/127\.0\.0\.1:\d+)/)?.[1];

  // ── no-stale client bundle illusion ──
  try {
    const html = await fetch(baseUrl + "/", { headers: { cookie } }).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); });
    const bootMatch = html.match(/globalThis\["__DSH_BOOT__"\]\s*=\s*(\{.*?\})\s*</s);
    check("composed boot graph parsed", Boolean(bootMatch));
    const row = bootMatch ? JSON.parse(bootMatch[1]).entries.find((e) => e.id === "dsh-self-improved") : null;
    check("boot graph carries the plugin row", Boolean(row), row ? `rev=${row.rev}` : "missing");
    if (row) {
      const servedBuf = await fetch(new URL(row.url.replace(/&amp;/g, "&"), baseUrl).href, { headers: { cookie } }).then((r) => r.arrayBuffer());
      const served = Buffer.from(servedBuf).toString("utf8").trimEnd();
      const repoStr = readFileSync(join(ROOT, "client.js"), "utf8").trimEnd();
      // The server raw-serves the bundle plus one sourcemap trailer line; the
      // plugin's own bytes must be a prefix of the response bytes.
      check("served client bundle is the CURRENT client.js (no stale illusion)", served.startsWith(repoStr) || repoStr.startsWith(served.replace(/;\n\/\/# sourceMappingURL=\S+$/, "")), `boot rev ${row.rev}, served ${servedBuf.byteLength}B`);
    }
  } catch (e) {
    check("served-bundle gate", false, String(e.message ?? e));
  }

  // ── durable settings face ──
  if (existsSync(join(facts.profileDir, "cordis.patch.yml"))) {
    const patch = readFileSync(join(facts.profileDir, "cordis.patch.yml"), "utf8");
    check("plugin row persists WITHOUT a config block unless a settings save ran",
      patch.includes("dsh-self-improved") && (/^\s+searchLimit:/m.test(patch) || !patch.includes("searchLimit:")),
      patch.trim().split("\n").slice(-5).join(" | "));
    if (!fresh) {
      if (patch.includes("searchLimit:")) {
        check("the browser save persisted its override (searchLimit in the profile patch)", /searchLimit:\s*9/.test(patch), "expected the ledger's 9");
      }
      if (patch.includes("maxResults:")) check("the second peer's write persisted (recall.maxResults)", /maxResults:\s*3/.test(patch));
      if (patch.includes("intervalMinutes:")) check("the conflict-winner field persisted (extract.intervalMinutes=16)", /intervalMinutes:\s*16/.test(patch));
    } else {
      check("fresh run: the profile patch stays clean (no config override block yet)", !patch.includes("searchLimit:"), patchedKeysOf(patch));
    }
  }

  // ── durable store truth (ledger flow) ──
  const dbPath = join(facts.home, "memory", "memory.db");
  check("store database exists", existsSync(dbPath));
  if (existsSync(dbPath)) {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db.prepare("select m.status, m.content, mk.provenance, mk.source from memories m left join memories_meta mk on mk.memory_id = m.id").all();
      const find = (needle, status, source) => rows.some((r) => String(r.content).includes(needle) && r.status === status && (source ? r.source === source : true));
      if (!fresh) {
        check("browser forget executed (seed row logically forgotten)", find("LUNA-SYNTH-4102", "forgotten"), `${rows.filter((r) => r.status === "forgotten").length} forgotten`);
        check("browser corrections executed (user-direct supersession present)",
          rows.some((r) => r.source === "user-direct" && r.status === "active"),
          `${rows.filter((r) => r.source === "user-direct").length} user-direct row(s)`);
      } else {
        const seeded = SEED_ROWS.filter((c) => rows.some((r) => String(r.content).includes(c.slice(-32)) && r.status === "active")).length;
        check("fresh run: seeded rows present and active", seeded === SEED_ROWS.length, `${seeded}/${SEED_ROWS.length}`);
      }
      let st = [];
      try { st = db.prepare("select session_id, processed_seq, pending_seq from extract_state").all(); } catch { /* no table */ }
      check("no extraction state rows (no capture/model work happened)", st.length === 0);
    } finally { db.close(); }
  }

  // ── paused firewall: provider log ──
  if (existsSync(facts.stub.log)) {
    const entries = readFileSync(facts.stub.log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const real = entries.filter((e) => e.bodyBytes > 0);
    check("provider log has ZERO real model requests during the whole session", real.length === 0, `entries=${entries.length} (only the fixture's own curl probe, bodyBytes=0)`);
  } else {
    check("provider log present", false, "missing provider-requests.jsonl");
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`mounted-ui verify: ${results.length - failed.length}/${results.length} PASS${failed.length ? " — " + failed.length + " FAIL" : ""}`);
  process.exitCode = failed.length ? 1 : 0;
}

async function stageDown() {
  const run = flagValue("--run") ?? "";
  let runDir, guardedRoot;
  try { runDir = realpathSync(run); guardedRoot = realpathSync(TEMP); }
  catch { throw new Error("bad owned run path"); }
  // Validate ownership BEFORE reading PID metadata or taking any action.
  if (!runDir.startsWith(guardedRoot + "/") || !existsSync(join(runDir, OWNER_MARKER)))
    throw new Error("down refuses a path outside the owned fixture tree");
  const facts = JSON.parse(readFileSync(join(runDir, "facts.json"), "utf8"));
  if (facts.runDir !== runDir) throw new Error("run identity mismatch");
  const url = new URL(facts.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.port === "3082")
    throw new Error("down refuses an unexpected GUI origin");
  // PIDs are namespace-local and may be reused. Only the originating managed
  // job may signal its children; never signal integers read from a fixture file.
  try {
    await fetch(new URL("/", url.origin), { signal: AbortSignal.timeout(1500) });
    throw new Error("fixture server is live: stop its originating managed job first");
  } catch (error) {
    if (error?.cause?.code !== "ECONNREFUSED") throw error;
  }
  if (keep) { console.log("down: kept stopped fixture per --keep"); return; }
  const cleaned = guardedCleanup(runDir);
  console.log(cleaned ? `down: cleaned ${runDir}` : `down: guarded kept ${runDir}`);
}

await (mode === "up" ? stageUp() : mode === "verify" ? stageVerify() : mode === "down" ? stageDown() : Promise.reject(new Error("usage: up | verify --run <dir> | down --run <dir>")));
