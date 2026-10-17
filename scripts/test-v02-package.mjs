#!/usr/bin/env node
/**
 * Phase A package-artifact / build-portability gate (durable companion of
 * scripts/typecheck-v02.mjs). Verifies that the package manifest, the build /
 * prepare pipeline, and the packed artifact are portable:
 *
 *   C1  manifest peer list covers every @deepseek-ai package actually imported
 *       by src/ (declared-but-unimported peers become report notes), and the
 *       wrapper resolves the manifest pins exactly on this machine
 *   C2  portable local declared-peer build: an offline symlink harness tree
 *       (exactly rc.2 peer links; DSH_V02_NO_TEST_SITE=1) builds, strict
 *       typechecks, and emits map-free lib through the wrapper
 *   C3  fail-closed against legacy repo peers (rc.6/rc.8/cordis-4.0.2 links):
 *       exit 2, precise mismatch message, no silent legacy typecheck, no lib
 *   C4  explicit DSH_RUNTIME_RC2 contract: invalid override fails closed from
 *       an otherwise valid tree; a valid override wins
 *   C5  repo `npm pack` — real pack, real prepare (the documented deliberate
 *       coordinator test-site default build on this machine)
 *   C6  staged pristine `npm pack` from the offline dev harness (NO network
 *       install): packed file list, exports/runtime-file completeness,
 *       absolute-path purity, no node_modules/fixtures/maps/junk in tarball
 *   C7  extracted-artifact offline runtime import harness (SYMBOLIC symlinks —
 *       explicitly not registry-install evidence): named exports resolve,
 *       `…/client` subpath export maps to the shipped client.js
 *   C8  consumer artifact lifecycle in the extracted artifact (no toolchain),
 *       evidence split honestly in two: a DIRECT explicit artifact
 *       verification (`node scripts/typecheck-v02.mjs --allow-prebuilt` —
 *       invoked directly, NOT a registry/installer run) and a GENUINE
 *       npm-script prepare (`npm run prepare` — npm's own runner executing
 *       the manifest's prepare command; still no registry install): both end
 *       exit 0 with the explicit no-strict-compile NOTICE and never claim
 *       PASSED, shipped lib stays byte-identical (no emission without a
 *       compile), re-verification is idempotent. The strict-gate conflation
 *       is closed: default/no-flags mode with a shipped lib now fails closed
 *       (exit 2); an incomplete artifact (`lib/index.js` removed) is an
 *       actionable exit 2 even with the --allow-prebuilt opt-in
 *   C9  temp hygiene: every wrapper run removed BOTH its check tree and its
 *       mkdtemp parent (pre-fix leak), suite temp root fully removed
 *
 * The coordinator test site (/home/bahman/github/dsh-v0.2.1) is only used
 * read-only, deliberately, and as the documented default peer source; every
 * result that depends on it says so. No active profile is touched, no network
 * install, no dependency patching, no compatibility exemptions. Durable
 * results: fixtures/v02-package/last-suite-run.log + last-suite-pin.json.
 *
 * Usage: node scripts/test-v02-package.mjs
 */
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const peerDeps = manifest.peerDependencies ?? {};
const slug = (scoped) => String(scoped).replace(/^@deepseek-ai\//, "");
const PEER_SLUGS = Object.keys(peerDeps).filter((k) => k.startsWith("@deepseek-ai/")).map(slug);
const WRAPPER = "scripts/typecheck-v02.mjs";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return !!ok;
}

// ---------------------------------------------------------------------------
// Unique owned temp roots under fixtures/v02-package/temp/<suite-…>; guarded
// cleanup only ever deletes paths realpath-resolving inside this unique root.
// Stale (crashed) roots older than 12 h are swept at start.
// ---------------------------------------------------------------------------
const tempBase = join(repo, "fixtures", "v02-package", "temp");
mkdirSync(tempBase, { recursive: true });
for (const stale of readdirSync(tempBase)) {
  const p = join(tempBase, stale);
  if (!p.startsWith(tempBase + sep)) continue;
  try {
    const ageMs = Date.now() - statSync(p).mtimeMs;
    if (ageMs > 12 * 3600_000) {
      rmSync(p, { recursive: true, force: true });
      console.log(`hygiene: swept stale suite temp root ${stale} (age ${Math.round(ageMs / 3600_000)}h)`);
    }
  } catch {
    /* skip; own run continues */
  }
}
const tempRoot = mkdtempSync(join(tempBase, "suite-"));
const suiteId = `package-${new Date().toISOString()}-${process.pid}`;
let cleanedTemp = false;
function cleanupTemp() {
  if (cleanedTemp) return;
  cleanedTemp = true;
  try {
    const base = realpathSync(tempRoot);
    rmSync(base, { recursive: true, force: true }); // unique temp root, realpath-verified above
  } catch {
    /* surfaced by the in-run assertion below if cleanup ever fails */
  }
}
process.on("exit", cleanupTemp);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("uncaughtException", (err) => {
  cleanupTemp();
  throw err;
});
const child = (cmd, args, opts = {}) => {
  // This suite deliberately tests default/local/legacy resolution separately from explicit overrides.
  // An outer acceptance runner's pinned runtime must not silently override those negative controls.
  const env = { ...(opts.env ?? process.env) };
  if (!opts.env) delete env.DSH_RUNTIME_RC2;
  const r = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd ?? repo, env });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};
/** npm pack --json stdout mixes prepare-script output with the trailing JSON array. */
function extractPackJson(stdout) {
  const trimmed = stdout.trimEnd();
  // The JSON array is the last printable block; parse candidates back-to-front.
  for (let start = trimmed.lastIndexOf("\n["); start >= 0; start = trimmed.lastIndexOf("\n[", start - 1)) {
    try {
      return JSON.parse(trimmed.slice(start + 1));
    } catch {
      /* previous candidate */
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

function buildHarness({ name, peersFrom, offlineDev, copy }) {
  // peersFrom: "repo" (legacy tree) or an @deepseek-ai dir with exact peers.
  // offlineDev also links toolchain + plugin runtime deps + a node_modules/.bin
  // tsc shim shaped like the one real package managers write.
  const root = join(tempRoot, name);
  mkdirSync(join(root, "node_modules", "@deepseek-ai"), { recursive: true });
  if (peersFrom === "repo") {
    for (const s of PEER_SLUGS) {
      const from = join(repo, "node_modules", "@deepseek-ai", s);
      if (existsSync(from)) symlinkSync(from, join(root, "node_modules", "@deepseek-ai", s));
    }
  } else if (peersFrom) {
    for (const s of PEER_SLUGS) symlinkSync(join(peersFrom, s), join(root, "node_modules", "@deepseek-ai", s));
  }
  if (offlineDev) {
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@types"), { recursive: true });
    mkdirSync(join(root, "node_modules", "@node-rs"), { recursive: true });
    symlinkSync(join(repo, "node_modules", "typescript"), join(root, "node_modules", "typescript"));
    symlinkSync(join(repo, "node_modules", "@types", "node"), join(root, "node_modules", "@types", "node"));
    symlinkSync(join(repo, "node_modules", "sqlite-vec"), join(root, "node_modules", "sqlite-vec"));
    symlinkSync(join(repo, "node_modules", "@node-rs", "jieba"), join(root, "node_modules", "@node-rs", "jieba"));
    // Newly declared schema dependency: stage its exact tested installed copy,
    // not a registry install or modification of the user's dependency tree.
    symlinkSync(join(resolution.peerRoot, "..", "zod"), join(root, "node_modules", "zod"));
    writeFileSync(join(root, "node_modules", ".bin", "tsc"), [
      "#!/bin/sh",
      'exec node "$(dirname "$0")/../typescript/bin/tsc" "$@"',
      "",
    ].join("\n"), { mode: 0o755 });
  }
  for (const f of copy ?? []) {
    const from = join(repo, f);
    const to = join(root, f);
    if (statSync(from).isDirectory()) cpSync(from, to, { recursive: true });
    else cpSync(from, to);
  }
  return root;
}
function countTempRootsSince(sinceMs) {
  let n = 0;
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith("dsi-typecheck-v02-")) continue;
    try {
      if (statSync(join(tmpdir(), name)).mtimeMs >= sinceMs) n += 1;
    } catch {
      /* vanished mid-scan */
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// C1: manifest ↔ actually-imported packages; exact on-machine resolution
// ---------------------------------------------------------------------------
console.log("\n== C1 manifest/peer coverage and on-machine resolution ==");
let resolution = null;
const repoTgzAtStart = readdirSync(repo).filter((f) => f.endsWith(".tgz"));
{
  const imported = new Set();
  const walk = (dir) => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.ts$/.test(f.name)) {
        for (const m of readFileSync(p, "utf8").matchAll(/@deepseek-ai\/[a-z0-9-]+/g)) imported.add(m[0]);
      }
    }
  };
  walk(join(repo, "src"));
  for (const extra of ["client.js", "cordis.patch.yml"]) {
    for (const m of readFileSync(join(repo, extra), "utf8").matchAll(/@deepseek-ai\/[a-z0-9-]+/g)) imported.add(m[0]);
  }
  const declared = new Set(Object.keys(peerDeps));
  const undeclared = [...imported].filter((s) => !declared.has(s));
  check("C1/every @deepseek-ai package imported by src (and client/patch surfaces) is a declared peer", undeclared.length === 0, undeclared.length ? `undeclared: ${undeclared.join(", ")}` : `${imported.size} imported packages all declared`);

  const r = child("node", [WRAPPER, "--print-resolution"]);
  const start = r.stdout.indexOf("{");
  const jsonOk = r.status === 0 && start >= 0;
  if (!jsonOk) {
    check("C1/wrapper --print-resolution resolves and prints exact JSON", false, r.status !== 0 ? (r.stderr.split("\n")[0] ?? "") : r.stdout.slice(0, 120));
  } else {
    resolution = JSON.parse(r.stdout.slice(start));
    check("C1/wrapper resolves on this machine (mode coordinator-test-site-default, the documented deliberate default)", resolution.mode === "coordinator-test-site-default", `mode=${resolution.mode}`);
    check("C1/resolved peer root is the documented coordinator test site", resolution.peerRoot === "/home/bahman/github/dsh-v0.2.1/node_modules/@deepseek-ai", resolution.peerRoot);
    const mismatch = Object.entries(resolution.peers ?? {}).filter(([k, v]) => {
      const req = String(peerDeps[`@deepseek-ai/${k}`] ?? "").replace(/^[~^]/, "");
      return req && v !== req;
    });
    check("C1/every resolved peer version matches the manifest pins exactly", mismatch.length === 0, mismatch.map(([k, v]) => `${k}@${v}`).join("|") || `${Object.keys(resolution.peers ?? {}).length}/17 exact`);
    const declaredOnly = relativeManifestNotes(declared, imported);
    // Recorded MANIFEST NOTE for the coordinator (not a strict failure): peers
    // declared but never imported by src are still validated/installed for
    // every consumer. Reported unchanged; manifest is coordinator-owned.
    check("C1/declared-but-unimported peers recorded as manifest note (expected finding list)", true, declaredOnly.length ? `declared but never imported in src — manifest recommendation recorded in MIGRATION-PACKAGE-TESTS.md: ${declaredOnly.join(", ")}` : "none (no declared peer is unimported)");
  }
}
function relativeManifestNotes(declared, imported) {
  return [...declared].filter((p) => p.startsWith("@deepseek-ai/") && !imported.has(p));
}

// ---------------------------------------------------------------------------
// C2–C4: wrapper resolution contract in offline harnesses
// ---------------------------------------------------------------------------
let stagePkg = null; // set by C6 for C7/C8
console.log("\n== C2–C4 wrapper resolution contract in offline harnesses ==");
const osEnvWithoutRuntime = { ...process.env };
delete osEnvWithoutRuntime.DSH_RUNTIME_RC2;
delete osEnvWithoutRuntime.DSH_V02_NO_TEST_SITE;
if (resolution === null) {
  console.log("SKIP C2–C8 (C1 resolution failed)");
} else {
  const dev = buildHarness({ name: "portable-dev", peersFrom: resolution.peerRoot, offlineDev: true, copy: ["package.json", "tsconfig.json", "client.js", "cordis.patch.yml", "src", "scripts"] });
  {
    const env = { ...osEnvWithoutRuntime, DSH_V02_NO_TEST_SITE: "1" };
    const r = child("node", [WRAPPER, "--emit-lib"], { cwd: dev, env });
    const firstErr = (r.stderr.split("\n").find((l) => l.trim() !== "") ?? "").trim();
    check("C2/portable local declared-peer build succeeds fully offline (no test site, no override)", r.status === 0, r.status === 0 ? "exit=0" : `exit=${r.status} ${firstErr.slice(0, 220)}`);
    check("C2/peer source mode is local-declared-peers", /peer source \[local declared peers/.test(r.stdout), (r.stdout.match(/peer source \[[^\]]+\]/) ?? [""])[0]);
    const libFiles = existsSync(join(dev, "lib")) ? readdirSync(join(dev, "lib")) : [];
    check("C2/--emit-lib produced a fresh, map-free lib", libFiles.includes("index.js") && !libFiles.some((f) => f.endsWith(".map")), `${libFiles.length} files${libFiles.some((f) => f.endsWith(".map")) ? "; maps present!" : "; no maps"}`);
    const t0 = Date.now();
    child("node", [WRAPPER], { cwd: dev, env });
    check("C9/after a wrapper run, no dsi-typecheck-v02-* root remains under os.tmpdir() (mkdtemp parent leak eliminated)", countTempRootsSince(t0) === 0, `${countTempRootsSince(t0)} newly created leftovers`);
  }
  {
    const r = child("node", [WRAPPER], { cwd: dev, env: { ...process.env, DSH_RUNTIME_RC2: join(tempRoot, "no-such-tree") } });
    check("C4/explicit invalid DSH_RUNTIME_RC2 fails closed (exit 2) even although this tree has valid local peers", r.status === 2 && !/PASSED/.test(`${r.stdout}\n${r.stderr}`), `exit=${r.status}; first: ${(r.stderr.split("\n")[0] ?? "").slice(0, 160)}`);
    const r2 = child("node", [WRAPPER], { cwd: dev, env: { ...process.env, DSH_RUNTIME_RC2: "/home/bahman/github/dsh-v0.2.1" } });
    check("C4/valid explicit override wins over local peers and passes strictly", r2.status === 0 && /peer source \[explicit override/.test(r2.stdout), `exit=${r2.status} ${(r2.stdout.match(/peer source \[[^\]]+\]/) ?? [""])[0]}`);
  }
  const legacy = buildHarness({ name: "legacy-peers", peersFrom: "repo", offlineDev: true, copy: ["package.json", "tsconfig.json", "client.js", "cordis.patch.yml", "src", "scripts"] });
  {
    const r = child("node", [WRAPPER], { cwd: legacy, env: { ...osEnvWithoutRuntime, DSH_V02_NO_TEST_SITE: "1" } });
    check("C3/legacy rc.6/rc.8 peer tree fails closed with exit 2 (no silent legacy typecheck)", r.status === 2, `exit=${r.status}`);
    check("C3/failure names the exact version mismatches", /does not match the manifest-required/.test(r.stderr) && /(4\.0\.2|0\.1\.0-rc\.[68])/.test(r.stderr), (r.stderr.split("\n").find((l) => l.includes("does not match")) ?? "").trim().slice(0, 180));
    check("C3/no lib emitted in the legacy harness", !existsSync(join(legacy, "lib")));
  }

  // -----------------------------------------------------------------------
  // C5: real npm pack in the repo (prepare = documented deliberate test-site build)
  // -----------------------------------------------------------------------
  console.log("\n== C5 repo npm pack (real pack + real prepare) ==");
  // npm 11 writes cache/log data into $HOME/.npm by default; inside this
  // sandbox HOME is not writable, so every pack child gets an owned cache.
  const npmCache = join(tempRoot, "npm-cache");
  mkdirSync(npmCache, { recursive: true });
  const outRepo = join(tempRoot, "out-repo");
  mkdirSync(outRepo, { recursive: true });
  let repoPacked = null;
  {
    const env = { ...osEnvWithoutRuntime, npm_config_cache: npmCache };
    delete env.npm_config_ignore_scripts;
    delete env.npm_ignore_scripts;
    const t0 = Date.now();
    const r = child("npm", ["pack", "--json", "--pack-destination", outRepo], { env });
    const parsed = extractPackJson(r.stdout);
    const ok = r.status === 0 && Array.isArray(parsed) && parsed.length > 0;
    check("C5/npm pack succeeds in the repo (prepare = the strict build pipeline runs)", !!ok, ok ? "" : `exit=${r.status} ${(r.stderr.split("\n").filter(Boolean)[0] ?? "").slice(0, 240)}`);
    check("C9/wrapper temp tree cleaned after the pack prepare run", countTempRootsSince(t0) === 0, `${countTempRootsSince(t0)} newly created leftovers`);
    const info = parsed?.[0];
    repoPacked = info ? resolve(join(outRepo, info.filename ?? "")) : null;
    check("C5/packed tarball written to the owned temp dir (repo root stays clean)", !!repoPacked && existsSync(repoPacked) && readdirSync(repo).filter((f) => f.endsWith(".tgz")).length === repoTgzAtStart.filter((f) => f.endsWith(".tgz")).length, repoPacked);
    check("C5/prepare rebuilt repo lib (gitignored build output — the pipeline's intended behavior)", existsSync(join(repo, "lib", "index.js")));
    check("C5/pack prepare resolved peers exactly as documented on this machine (coordinator-test-site-default, deliberate)", /coordinator-test-site-default/.test(r.stdout) && !/local-declared-peers/.test(r.stdout), (r.stdout.match(/peer source \[[^\]]+\]/) ?? ["no peer line"])[0]);
  }

  // -----------------------------------------------------------------------
  // C6: staged pristine npm pack from the offline dev harness (no network)
  // -----------------------------------------------------------------------
  console.log("\n== C6 staged offline pack + artifact completeness/purity ==");
  const stage = buildHarness({ name: "stage", peersFrom: resolution.peerRoot, offlineDev: true, copy: ["package.json", "tsconfig.json", "client.js", "cordis.patch.yml", "src", "scripts", "README.md", "LICENSE", "ROADMAP.md", "TROUBLESHOOTING.md"] });
  const outStage = join(tempRoot, "out-stage");
  mkdirSync(outStage, { recursive: true });
  {
    const env = { ...osEnvWithoutRuntime, DSH_V02_NO_TEST_SITE: "1", npm_config_cache: join(tempRoot, "npm-cache") };
    delete env.npm_config_ignore_scripts;
    delete env.npm_ignore_scripts;
    const r = child("npm", ["pack", "--json", "--pack-destination", outStage], { cwd: stage, env });
    const parsed = extractPackJson(r.stdout);
    const ok = r.status === 0 && Array.isArray(parsed) && parsed.length > 0;
    check("C6/offline staged npm pack succeeds (prepare = full strict rc.2 build in the stage)", r.status === 0, r.status === 0 ? `exit=0; prepare used the offline local-peer tree` : `exit=${r.status} ${(r.stderr.split("\n").filter(Boolean)[0] ?? "").slice(0, 240)}`);
    check("C6/prepare actually ran in the stage (lib emitted before packing)", existsSync(join(stage, "lib", "index.js")));
    const packedName = `${manifest.name}-${manifest.version}.tgz`;
    let list = null;
    if (ok) {
      const info = parsed[0];
      check("C6/pack reports the canonical tarball name", info.filename === packedName, info.filename);
      list = info.files.map((f) => f.path);
    }
    if (list) {
      check("C6/packed file list stays inside the manifest's declared files surface", list.every((p) => /^(package\.json|lib\/.+|src\/.+|scripts\/.+|tsconfig\.json|client\.js|cordis\.patch\.yml|LICENSE|README\.md|ROADMAP\.md|TROUBLESHOOTING\.md)$/.test(p)), list.filter((p) => !/^(package\.json|lib\/|src\/|scripts\/|tsconfig\.json|client\.js|cordis\.patch\.yml|LICENSE|README\.md|ROADMAP\.md|TROUBLESHOOTING\.md)/.test(p)).slice(0, 6).join(", ") || `${list.length} files, all allowed`);
      const banned = list.filter((p) => /(node_modules|\/fixtures\/|^fixtures\/|scratch-review|^\.diag|\.map$|^dist\/|^\.git)/.test(p));
      check("C6/no dependencies/junk/maps/fixtures/scratch material in the tarball", banned.length === 0, banned.slice(0, 5).join(", ") || "clean");
      for (const need of ["lib/index.js", "lib/index.d.ts", "package.json", "README.md", "LICENSE", "ROADMAP.md", "TROUBLESHOOTING.md", "client.js", "cordis.patch.yml", "tsconfig.json", "scripts/typecheck-v02.mjs"]) {
        check(`C6/required file ships: ${need}`, list.includes(need));
      }
      const stagedLib = readdirSync(join(stage, "lib"));
      const dangling = [];
      for (const f of stagedLib.filter((x) => x.endsWith(".js"))) {
        const text = readFileSync(join(stage, "lib", f), "utf8");
        for (const m of text.matchAll(/from "\.\/([^"]+)"/g)) if (!stagedLib.includes(m[1])) dangling.push(`${f} -> ./${m[1]}`);
      }
      check("C6/emitted lib is self-contained (every relative import resolves inside lib/)", dangling.length === 0, dangling.slice(0, 5).join(" | ") || `${stagedLib.filter((x) => x.endsWith(".js")).length} modules chained`);
      check("C6/stage lib is map-free", !stagedLib.some((f) => f.endsWith(".map")));

      // extract and scan for embedded external absolute paths
      const extractRoot = join(tempRoot, "extract");
      mkdirSync(extractRoot, { recursive: true });
      const tar = child("tar", ["-xzf", join(outStage, packedName), "-C", extractRoot]);
      check("C6/tarball extracts cleanly", tar.status === 0, tar.stderr.slice(0, 140));
      const pkg = join(extractRoot, "package");
      stagePkg = pkg;
      {
        const textPaths = [];
        for (const d of [join(pkg, "lib"), join(pkg, "src")].filter((d) => existsSync(d))) {
          for (const f of readdirSync(d, { withFileTypes: true })) if (!f.isDirectory()) textPaths.push(join(d, f.name));
        }
        for (const f of ["client.js", "cordis.patch.yml", "package.json", "tsconfig.json"]) textPaths.push(join(pkg, f));
        const found = {};
        for (const p of textPaths) {
          const text = readFileSync(p, "utf8");
          for (const marker of ["/home/", "/Users/", "drive-letter"]) {
            const hit = marker === "drive-letter" ? /(?<!\b[A-Za-z])[A-Z]:\\/.test(text) : text.includes(marker);
            if (hit) found[`${basename(dirname(p))}/${basename(p)}`] = marker;
          }
        }
        check("C6/no external absolute dev paths embedded in lib/src/manifest/patch payload", Object.keys(found).length === 0, Object.entries(found).map(([f, re]) => `${f}: ${re}`).join(" | ") || "clean");
        const scriptsWithSite = readdirSync(join(pkg, "scripts")).filter((f) => readFileSync(join(pkg, "scripts", f), "utf8").includes("/home/bahman/github/dsh-v0.2.1"));
        // Expected-finding list (informational, coordinator-owned manifest files
        // choice): ring test scripts default to the documented coordinator site
        // unless overridden, and validate-episode-rollout.mjs still carries the
        // undocumented legacy /home/bahman/github/dsh/node_modules default.
        const documentedDefaults = new Set(["typecheck-v02.mjs", "test-v02-package.mjs", "test-v02-mounted-ui.mjs", "test-v02-policy-lane.mjs", "test-v02-remote-cancellation.mjs", "test-v02-runtime.mjs", "test-v02-settings.mjs", "test-v02-shutdown-safety.mjs", "run-v02-auth-runtime-candidate.mjs", "test-learned-procedure-executor.mjs", "test-learned-procedure-go.mjs", "start-learned-procedure-host.mjs"]);
        const undocumented = scriptsWithSite.filter((f) => !documentedDefaults.has(f));
        // Audit exact documented inventory, not a stale arbitrary file-count
        // allowance. New test scripts must not add hidden machine defaults.
        check("C6/document machine-default site references in packaged scripts (expected-finding list)", undocumented.length === 0, `documented: ${scriptsWithSite.join(", ")}; undocumented: ${undocumented.join(", ") || "none"} — see MIGRATION-PACKAGE-TESTS.md`);
        const anyHome = readdirSync(join(pkg, "scripts")).filter((f) => readFileSync(join(pkg, "scripts", f), "utf8").includes("/home/") && !scriptsWithSite.includes(f));
        // Expected finding (recorded, coordinator-owned files/scripts decision):
        // validate-episode-rollout.mjs ships with the undocumented legacy
        // default /home/bahman/github/dsh/node_modules (not the rc.2 site).
        check("C6/undocumented machine defaults inside shipped ops scripts surfaced verbatim (recorded finding, see report)", true, anyHome.length ? `the tarball carries /home/ defaults in: ${anyHome.join(", ")}` : "none beyond the documented site");
      }
      // manifest truthfulness inside the artifact
      const pkgManifest = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8"));
      {
        const targetOf = (spec) => {
          const m = (pkgManifest.exports ?? {})[spec];
          return typeof m === "string" ? m : (m?.default ?? m?.import ?? null);
        };
        const missing = [".", "./client", "./package.json"].filter((spec) => {
          const rel = targetOf(spec) ?? spec;
          return !existsSync(join(pkg, String(rel)));
        });
        check("C6/manifest exports targets all exist in the payload", missing.length === 0, missing.join("|") || "., ./client, ./package.json all resolve");
        check("C6/dsh bundle patch ships and matches the manifest pointer", existsSync(join(pkg, pkgManifest.dsh?.bundle?.patch ?? "cordis.patch.yml")));
        check("C6/packaged manifest is byte-identical to the repo manifest (coordinator-owned file untouched by the pipeline)", Buffer.compare(readFileSync(join(pkg, "package.json")), readFileSync(join(repo, "package.json"))) === 0);
        check("C6/engines require node >=22.16 (node:sqlite + sqlite-vec runtime floor)", pkgManifest.engines?.node === manifest.engines?.node, pkgManifest.engines?.node);
      }

      // -------------------------------------------------------------------
      // C7: extracted-artifact offline runtime import harness (SYMBOLIC)
      // -------------------------------------------------------------------
      console.log("\n== C7 extracted-artifact offline runtime harness (symbolic links, NOT install evidence) ==");
      const cons = join(tempRoot, "cons");
      mkdirSync(join(cons, "node_modules", "@deepseek-ai"), { recursive: true });
      mkdirSync(join(cons, "node_modules", "@node-rs"), { recursive: true });
      symlinkSync(join(repo, "node_modules", "sqlite-vec"), join(cons, "node_modules", "sqlite-vec"));
      symlinkSync(join(repo, "node_modules", "@node-rs", "jieba"), join(cons, "node_modules", "@node-rs", "jieba"));
      symlinkSync(join(resolution.peerRoot, "..", "zod"), join(cons, "node_modules", "zod"));
      for (const s of PEER_SLUGS) symlinkSync(join(resolution.peerRoot, s), join(cons, "node_modules", "@deepseek-ai", s));
      symlinkSync(pkg, join(cons, "node_modules", manifest.name));
      writeFileSync(join(cons, "package.json"), JSON.stringify({ name: "offline-harness-consumer", private: true, type: "module" }, null, 2));
      writeFileSync(join(cons, "launcher.mjs"), [
        "const m = await import(\"dsh-self-improved\");",
        "const client = import.meta.resolve(\"dsh-self-improved/client\");",
        "const { existsSync } = await import(\"node:fs\");",
        "if (typeof client !== \"string\") throw new Error(\"client subpath did not resolve\");",
        "console.log(JSON.stringify({",
        "  name: m.name,",
        "  keys: Object.keys(m).sort(),",
        "  clientResolved: existsSync(new URL(client)),",
        "}));",
        "",
      ].join("\n"));
      const imp = child("node", ["launcher.mjs"], { cwd: cons });
      let info = null;
      const mobj = imp.stdout.trim().match(/\{[\s\S]*\}/);
      try {
        info = JSON.parse(mobj[0]);
      } catch {
        info = null;
      }
      check("C7/extracted artifact's lib/index.js imports cleanly through the offline peer harness", imp.status === 0 && info !== null, imp.status !== 0 ? imp.stderr.slice(0, 400) : "named import OK");
      check("C7/plugin module keeps its exported Cordis name (self-improved, matching src/index.ts; the bundle row id remains dsh-self-improved) and plugin surface", info && info.name === "self-improved" && ["name", "apply", "Config"].every((k) => (info.keys ?? []).includes(k)), `name=${info?.name} keys=${((info?.keys ?? []).length)} (${(info?.keys ?? []).slice(0, 6).join(",")}${(info?.keys?.length ?? 0) > 6 ? "…" : ""})`);
      check("C7/`dsh-self-improved/client` exports subpath maps to the shipped client.js present inside the tarball", info && info.clientResolved === true, `clientResolved=${info?.clientResolved}`);

      // -------------------------------------------------------------------
      // C8: consumer artifact lifecycle in the extracted artifact (honest
      // split: direct explicit --allow-prebuilt verification + genuine
      // npm-script lifecycle prepare; the strict gate is no longer conflated
      // with prepare — default/no-flags mode fails closed without a compiler)
      // -------------------------------------------------------------------
      console.log("\n== C8 consumer artifact lifecycle (no toolchain: explicit verification + genuine npm prepare) ==");
      {
        const p1 = copyPackageOnly(pkg, join(tempRoot, "prepare1"));
        // (1) DIRECT explicit artifact verification: the wrapper is invoked
        // directly with the opt-in flag — artifact evidence only, NOT a
        // registry/network install, and it is labeled that way everywhere.
        const envNoRuntime = { ...osEnvWithoutRuntime };
        const r = child("node", [join(p1, "scripts", "typecheck-v02.mjs"), "--allow-prebuilt"], { cwd: p1, env: envNoRuntime });
        check("C8/direct explicit artifact verification (--allow-prebuilt, wrapper run directly — NOT installer evidence): exit 0", r.status === 0 && /explicit artifact verification/.test(r.stdout), r.status === 0 ? "opted-in artifact-verify mode" : `exit=${r.status} ${(r.stderr.split("\n").filter(Boolean)[0] ?? "").slice(0, 220)}`);
        check("C8/verification explicitly says NO strict rc.2 compile and never claims PASSED", /NOTICE/.test(r.stdout) && /strict rc\.2 compile/i.test(r.stdout) && !/PASSED/.test(r.stdout), `${r.stdout.split("\n").filter((l) => l.includes("NOTICE")).length} notice lines, and no PASSED claim`);
        const h0 = sha256(join(p1, "lib", "index.js"));
        // (2) GENUINE npm-script lifecycle prepare: npm's own runner executes
        // the manifest's prepare command inside the artifact (coordinator-pinned
        // `--emit-lib --allow-prebuilt`). Still not a registry install;
        // devDependencies absent by construction — exactly the consumer
        // context the notice describes.
        const rnp = child("npm", ["run", "prepare", "--silent"], { cwd: p1, env: { ...envNoRuntime, npm_config_cache: join(tempRoot, "npm-cache") } });
        check("C8/genuine npm-run prepare inside the artifact: the manifest prepare command runs, exit 0", rnp.status === 0 && /explicit artifact verification|shipped prebuilt lib verified/.test(rnp.stdout), rnp.status === 0 ? "real npm lifecycle runner (no registry install)" : `exit=${rnp.status} ${(rnp.stderr.split("\n").filter(Boolean)[0] ?? "").slice(0, 240)}`);
        check("C8/genuine npm prepare prints the no-strict-compile NOTICE and never claims PASSED", /NOTICE/.test(rnp.stdout) && !/PASSED/.test(rnp.stdout), `${rnp.stdout.split("\n").filter((l) => l.includes("NOTICE")).length} notice lines`);
        check("C8/verification + prepare emit nothing: shipped lib stays byte-identical (no compile, no emission)", sha256(join(p1, "lib", "index.js")) === h0);
        const r2 = child("node", [join(p1, "scripts", "typecheck-v02.mjs"), "--allow-prebuilt"], { cwd: p1, env: envNoRuntime });
        check("C8/second explicit verification is idempotent (lib byte-identical)", r2.status === 0 && sha256(join(p1, "lib", "index.js")) === h0);
        // strict-gate conflation closed: default/no-flags mode (old behavior
        // exited 0 as artifact verification) now fails closed even with lib.
        const rdef = child("node", [join(p1, "scripts", "typecheck-v02.mjs")], { cwd: p1, env: envNoRuntime });
        check("C8/default no-flags strict mode with a shipped lib now FAILS CLOSED (compilerless conflation closed)", rdef.status === 2 && /fails closed/.test(rdef.stderr) && !/verified/.test(rdef.stdout), `exit=${rdef.status}`);
        // missing-lib refusal stands for the opted-in path too
        const p2 = copyPackageOnly(pkg, join(tempRoot, "prepare2"));
        rmSync(join(p2, "lib", "index.js"));
        const r3 = child("node", [join(p2, "scripts", "typecheck-v02.mjs"), "--allow-prebuilt"], { cwd: p2, env: envNoRuntime });
        check("C8/opted-in verification with lib/index.js removed: actionable exit 2 naming it, never a pass", r3.status === 2 && /missing:/.test(r3.stderr) && /lib\/index\.js|lib\/index\.d\.ts/.test(r3.stderr), `exit=${r3.status}`);
        const p3 = copyPackageOnly(pkg, join(tempRoot, "prepare3"));
        rmSync(join(p3, "lib", "index.js"));
        const r4 = child("node", [join(p3, "scripts", "typecheck-v02.mjs")], { cwd: p3, env: envNoRuntime });
        check("C8/no opt-in and no lib: strict refusal exits 2 with no artifact verdict", r4.status === 2 && !/verified/.test(r4.stdout), `exit=${r4.status}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// C9: suite-level temp hygiene
// ---------------------------------------------------------------------------
console.log("\n== C9 temp hygiene ==");
check("C9/repo root gained no stray tarball from this suite (packs went to owned temp dirs)", readdirSync(repo).filter((f) => f.endsWith(".tgz")).length === repoTgzAtStart.filter((f) => f.endsWith(".tgz")).length, `repo-root tgz delta: ${readdirSync(repo).filter((f) => f.endsWith(".tgz")).length - repoTgzAtStart.filter((f) => f.endsWith(".tgz")).length}`);
cleanupTemp();
check("C9/suite temp root fully removed (tree and parent)", !existsSync(tempRoot), existsSync(tempRoot) ? `leaked: ${tempRoot}` : `removed: suite id ${suiteId}`);

const passCount = results.filter((r) => r.ok).length;
const failCount = results.filter((r) => !r.ok).length;
const summary = `=== package-artifact gate summary: STRICT ${passCount} PASS / ${failCount} FAIL ===`;
console.log(summary);

// Durable evidence under the owned fixture directory
const reportDir = join(repo, "fixtures", "v02-package");
// Pinned-build attribution: C5/C6 prepare runs strict-compile the checkout's
// CURRENT src (other workers may have in-flight edits), so the evidence file
// records exactly which src paths were dirty at run time.
let srcStateAtRun = "unknown (git unavailable)";
try {
  const g = spawnSync("git", ["status", "--porcelain", "src"], { encoding: "utf8", cwd: repo });
  if (g.status === 0) {
    const lines = (g.stdout ?? "").trim().split("\n").filter(Boolean).map((l) => l.replace(/^\s*[A-Z?@]{1,4}\s+/, "").trim()).sort();
    srcStateAtRun = lines.length ? `dirty: ${lines.join(", ")}` : "clean";
  }
} catch {
  /* attribution stays unknown rather than fabricated */
}
writeFileSync(join(reportDir, "last-suite-pin.json"), JSON.stringify({
  suiteId,
  timestamp: new Date().toISOString(),
  node: process.version,
  peerMode: resolution?.mode ?? "n/a",
  peerRoot: resolution?.peerRoot ?? null,
  harness: "offline symlink links to the exactly rc.2 peer tree; npm pack ran with real scripts; NO registry install, NO dependency patch, NO profile changes",
  srcStateAtRun,
  srcStateNote: "the strict build behind C5/C6 compiled the src state above (build attribution is that state, not one named lane)",
  strictPass: passCount,
  strictFail: failCount,
}, null, 2) + "\n");

writeFileSync(join(reportDir, "last-suite-run.log"), [
  new Date().toISOString(),
  summary,
  ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`),
  "",
].join("\n"));

process.exitCode = failCount > 0 ? 1 : 0;

function copyPackageOnly(pkg, dest) {
  mkdirSync(dest, { recursive: true });
  for (const f of readdirSync(pkg, { withFileTypes: true })) {
    const from = join(pkg, f.name);
    const to = join(dest, f.name);
    if (f.isDirectory()) cpSync(from, to, { recursive: true });
    else cpSync(from, to);
  }
  return dest;
}
