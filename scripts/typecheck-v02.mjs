#!/usr/bin/env node
/**
 * Phase A gate: strict typecheck of this plugin against an *exactly validated*
 * rc.2 peer contract set (MIGRATION-V0.2.md Phase A gate "strict typecheck
 * against current packages"), plus a portable build/prepare entry point whose
 * behavior does not depend on this author's machine.
 *
 * Peer source resolution (contract/test evidence only; the source is never
 * modified by this script):
 *
 * 1. DSH_RUNTIME_RC2 (explicit override): the given tree must contain a
 *    node_modules/@deepseek-ai set matching this package.json's
 *    peerDependencies EXACTLY (coordinator pins like cordis@4.0.4 plus the
 *    rc.2 contracts). Explicitly set but invalid FAILS CLOSED (exit 2); it
 *    never silently falls back to any other source.
 * 2. Local declared peers (portable default): <repoRoot>/node_modules/@deepseek-ai
 *    with the same exact validation, so a checkout with the correct peers
 *    installed builds on any machine without the coordination test site.
 * 3. Coordinator test site (documented deliberate default,
 *    /home/bahman/github/dsh-v0.2): used only when no override is set AND the
 *    local peer set is absent or does not match exactly AND
 *    DSH_V02_NO_TEST_SITE=1 is not set. Legacy rc.6/rc.8 peers in a checkout
 *    with no valid rc.2 source anywhere are never silently used — the script
 *    exits 2 with the precise mismatch list.
 *
 * Modes:
 * - Strict gate (`build`, `typecheck:v02`, default/no-flags): requires a real
 *   TypeScript toolchain. With it, sources are compiled in a throwaway guarded
 *   scratch tree against the exactly validated peer set (--emit-lib replaces
 *   <repoRoot>/lib with the fresh output, guarded build-artifact directory
 *   only). WITHOUT a toolchain it fails closed (exit 2) — a shipped prebuilt
 *   lib/ is never accepted as strict rc.2 evidence in these modes.
 * - Explicit artifact verification (`--allow-prebuilt`, consumer/npm-install
 *   context only; the manifest's `prepare` carries it, never build/typecheck):
 *   no toolchain there → verifies the shipped artifact (lib/index.js,
 *   lib/index.d.ts, main/types, exports, dsh.bundle.patch, client.js) and
 *   exits 0 with an explicit NOTICE that the strict rc.2 compile did NOT run
 *   and nothing was emitted. Even this opted-in path refuses (exit 2): an
 *   explicitly invalid DSH_RUNTIME_RC2 override, an empty @deepseek-ai peer
 *   set, a peer range that cannot be pinned exactly, a peer outside the
 *   validated scope, and any missing artifact prerequisite.
 *
 * Usage:
 *   node scripts/typecheck-v02.mjs [--emit-lib]      # strict gate (needs toolchain)
 *   node scripts/typecheck-v02.mjs --allow-prebuilt  # artifact verification only (no toolchain context)
 *   node scripts/typecheck-v02.mjs --print-resolution   # JSON one-liner, no compile
 */
import {
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
  mkdtempSync,
  writeFileSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { resolve, dirname, join, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const DEFAULT_TEST_SITE = "/home/bahman/github/dsh-v0.2";
const PLUGIN_DEPS = ["sqlite-vec", "@node-rs/jieba", "zod"]; // plugin-owned runtime dependencies (not peer contracts)

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function fail(messages) {
  for (const m of [].concat(messages)) console.error(`typecheck-v02: ${m}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Manifest-derived peer contract (never a second hardcoded copy of the list)
// ---------------------------------------------------------------------------
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const peerDeps = manifest.peerDependencies ?? {};
/** [scoped peer name → unscoped package slug under @deepseek-ai] */
const PEERS = Object.fromEntries(
  Object.keys(peerDeps)
    .filter((scoped) => scoped.startsWith("@deepseek-ai/"))
    .map((scoped) => [scoped, scoped.slice("@deepseek-ai/".length)]),
);
if (Object.keys(PEERS).length === 0) {
  fail(`package.json declares no @deepseek-ai peerDependencies; this rc.2 gate has nothing to strictly check: ${JSON.stringify(Object.keys(peerDeps))}`);
}
// The gate validates exactly the @deepseek-ai scope; any peer outside it would
// be silently unvalidated, so it is refused in every mode (strict build and
// opted-in artifact verification alike).
for (const scoped of Object.keys(peerDeps)) {
  if (!Object.hasOwn(PEERS, scoped)) fail(`peer dependency ${scoped} is outside the @deepseek-ai scope this rc.2 gate validates`);
}
// Non-exactly-pinable ranges (e.g. "*", ">=4", "1.x", "a || b") cannot be
// compared against installed versions with EXACT equality, so they would make
// even a "pass" meaningless. Refused in every mode, fail closed.
for (const [scoped, range] of Object.entries(peerDeps)) {
  if (requiredExact(range) == null) {
    fail(`peer dependency ${scoped}@${String(range)} is not an exactly-pinable range; this rc.2 gate must compare installed peer versions EXACTLY, so it accepts only plain-version ranges (optionally ~/^ prefixed) and fails closed otherwise`);
  }
}

/** Exact version implied by a manifest peer range, or null when not exact-shaped. */
function requiredExact(range) {
  const stripped = String(range ?? "").trim().replace(/^[~^]/, "");
  return /^[0-9][0-9A-Za-z.\-+]*$/.test(stripped) ? stripped : null;
}

/** Validate a node_modules/@deepseek-ai directory against the manifest peers. */
function validatePeerSet(rootPkgs) {
  const versions = {};
  const problems = [];
  if (!existsSync(rootPkgs)) {
    problems.push(`peer directory not found: ${rootPkgs}`);
  } else {
    const installed = new Set(readdirSync(rootPkgs));
    for (const [scoped, slug] of Object.entries(PEERS)) {
      if (!installed.has(slug)) {
        versions[slug] = "(absent)";
        problems.push(`${scoped}: not installed in ${rootPkgs}`);
        continue;
      }
      let actual = null;
      try {
        actual = JSON.parse(readFileSync(join(rootPkgs, slug, "package.json"), "utf8")).version;
      } catch {
        actual = null;
      }
      versions[slug] = actual == null ? "(unreadable)" : String(actual);
      const req = requiredExact(peerDeps[scoped]);
      if (actual == null) problems.push(`${scoped}: package.json unreadable in ${rootPkgs}/${slug}`);
      else if (req && actual !== req) problems.push(`${scoped}@${actual} does not match the manifest-required ${scoped}@${req}`);
    }
  }
  return { ok: problems.length === 0, versions, problems, rootPkgs };
}

const printResolution = process.argv.includes("--print-resolution");
const emitLib = process.argv.includes("--emit-lib");
// Explicit consumer-install opt-in for artifact verification. The coordinator
// pins it to `prepare` only; build/typecheck:v02 must never carry it.
const allowPrebuilt = process.argv.includes("--allow-prebuilt");
const explicitOverride = (process.env.DSH_RUNTIME_RC2 ?? "").trim();

// ---------------------------------------------------------------------------
// Peer source resolution (explicit override → local declared peers →
// documented coordinator test site; legacy peers never used silently)
// ---------------------------------------------------------------------------
const localNodeRoot = join(repo, "node_modules");
const localRes = validatePeerSet(join(localNodeRoot, "@deepseek-ai"));

// Consumer/artifact prepare: no TypeScript toolchain in the install context.
const tscBin = join(localNodeRoot, ".bin", "tsc");
const toolchainPresent = existsSync(tscBin) && existsSync(join(localNodeRoot, "typescript"));
const shippedLibReady = existsSync(join(repo, "lib", "index.js")) && existsSync(join(repo, "lib", "index.d.ts"));

if (!toolchainPresent) {
  // Two no-compiler contexts that are never conflated:
  //  - the consumer artifact-verification context, reachable ONLY through the
  //    explicit --allow-prebuilt opt-in (the manifest's `prepare` carries it);
  //  - a developer checkout lacking its toolchain, which is a strict-gate
  //    request (build / typecheck:v02 / no-flags) and therefore FAILS CLOSED —
  //    even when a shipped prebuilt lib is present. A prebuilt artifact is
  //    never accepted as strict rc.2 evidence.
  if (!allowPrebuilt) {
    fail([
      printResolution
        ? "--print-resolution: no TypeScript toolchain in this checkout and no --allow-prebuilt opt-in;"
        : "no TypeScript toolchain (node_modules/typescript + node_modules/.bin/tsc) in this checkout;",
      ...(printResolution
        ? ["resolving a peer source here would misreport this context, so it fails closed (exit 2).",
           "Artifact verification exists only through the explicit --allow-prebuilt opt-in."]
        : [
          `the requested strict rc.2 ${emitLib ? '--emit-lib build' : 'typecheck'} CANNOT run without a compiler, so this fails closed (exit 2).`,
          ...(shippedLibReady
            ? [
                "A shipped prebuilt lib/ is present, but it is NEVER accepted as strict rc.2 evidence by",
                "build / typecheck:v02 / default modes. The only no-compiler path is the consumer-install",
                "context, whose manifest `prepare` opt-in (--allow-prebuilt) verifies the shipped artifact",
                "and prints an explicit no-strict-compile notice instead of ever claiming this gate.",
              ]
            : ["There is no shippable prebuilt artifact either (lib/index.js missing) — nothing to verify or compile."]),
          "fix it by installing the package manager's devDependencies (plus the exact manifest peers) here,",
          "or point DSH_RUNTIME_RC2 at a tree that also carries a TypeScript toolchain.",
        ]),
    ]);
  }
  // Explicit artifact verification. Fail closed even here on an explicitly
  // invalid runtime override (never fall back, never issue an artifact verdict
  // from an unvalidated source) — the guards above (empty / non-exactly-pinable
  // / out-of-scope peer declarations) already refused unsupported manifests.
  if (explicitOverride) {
    const res = validatePeerSet(join(explicitOverride, "node_modules", "@deepseek-ai"));
    if (!res.ok) {
      fail([
        `DSH_RUNTIME_RC2 explicitly set to ${explicitOverride} but it is not a valid peer source;`,
        "the --allow-prebuilt artifact verification refuses it too (fail closed, no fallback, no artifact verdict):",
        ...res.problems.map((p) => `  - ${p}`),
      ]);
    }
  }
  const artifactFiles = ["lib/index.js", "lib/index.d.ts", "client.js", "cordis.patch.yml"];
  const targets = [];
  for (const rel of [manifest.main, manifest.types]) if (rel) targets.push(String(rel));
  for (const mapped of Object.values(manifest.exports ?? {})) {
    for (const rel of typeof mapped === "string" ? [mapped] : [mapped?.types, mapped?.default, mapped?.import, mapped?.require])
      if (rel) targets.push(String(rel));
  }
  targets.push(manifest.dsh?.bundle?.patch ?? "./cordis.patch.yml");
  const missing = [...new Set([...artifactFiles, ...targets].map((rel) => rel.replace(/^\.\//, "")))].filter((rel) => !existsSync(join(repo, rel)));
  if (missing.length > 0) {
    fail(`artifact verification (--allow-prebuilt) refused: shipped artifact incomplete; missing: ${missing.join(", ")}`);
  }
  const peerNote = explicitOverride ? `explicit DSH_RUNTIME_RC2 ${explicitOverride}, exactly validated` : "the consumer host supplies the rc.2 peers at runtime";
  if (printResolution) {
    console.log(
      JSON.stringify({ mode: "explicit-artifact-verification", peerRoot: null, allowPrebuilt: true, strictCompile: false }, null, 2),
    );
  } else {
    console.log(`typecheck-v02: explicit artifact verification (--allow-prebuilt; ${peerNote}): shipped prebuilt lib verified`);
    console.log("typecheck-v02: (main/types, exports, dsh bundle patch, client.js all present and readable).");
    console.log("typecheck-v02: NOTICE: NO strict rc.2 compile ran here and none is claimed: there is no TypeScript toolchain in a");
    console.log("typecheck-v02: NOTICE: consumer-install context, and no build output was emitted (--emit-lib does nothing without a compile).");
    console.log("typecheck-v02: NOTICE: strict evidence lives in the source build (pnpm build) and scripts/test-v02-package.mjs —");
    console.log("typecheck-v02: NOTICE: never report this run as the rc.2 gate.");
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Guarded scratch tree: uniquely created under os.tmpdir(); on exit BOTH the
// check subdir and the mkdtemp parent are removed, verified owned.
// ---------------------------------------------------------------------------
const tmpRootBase = mkdtempSync(join(tmpdir(), "dsi-typecheck-v02-"));
const scratch = join(tmpRootBase, "check");
let cleaned = false;
function ownedTempTree(p) {
  let base;
  try {
    base = realpathSync(tmpRootBase);
  } catch {
    return false;
  }
  return (p === base || p.startsWith(base + sep)) && realpathSync(tmpdir()).startsWith(tmpdir());
}
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of [scratch, tmpRootBase]) {
    if (!ownedTempTree(p)) continue; // guarded ownership: only this run's unique tree
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort; tree lives under os.tmpdir() */
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("uncaughtException", (err) => {
  cleanup();
  throw err; // rethrow so the real crash is still reported loudly
});

// Resolve the peer source now, but only create symlinks after the scratch dir.
let peerRes;
const explicit = explicitOverride;
if (explicit) {
  const res = validatePeerSet(join(explicit, "node_modules", "@deepseek-ai"));
  if (!res.ok) {
    fail([
      `DSH_RUNTIME_RC2 explicitly set to ${explicit} but it is not a valid peer source; failing closed, no fallback:`,
      ...res.problems.map((p) => `  - ${p}`),
    ]);
  }
  peerRes = { ...res, mode: "explicit-override", label: explicit };
} else if (localRes.ok) {
  peerRes = { ...localRes, mode: "local-declared-peers", label: localNodeRoot };
} else {
  const noSite = process.env.DSH_V02_NO_TEST_SITE === "1";
  const siteRes = existsSync(join(DEFAULT_TEST_SITE, "node_modules", "@deepseek-ai"))
    ? validatePeerSet(join(DEFAULT_TEST_SITE, "node_modules", "@deepseek-ai"))
    : null;
  if (noSite || !siteRes || !siteRes.ok) {
    fail([
      "no valid exactly-matching rc.2 peer source available; legacy peers were NOT silently used:",
      ...localRes.problems.map((p) => `  - local: ${p}`),
      ...(siteRes && !siteRes.ok ? siteRes.problems.map((p) => `  - test-site: ${p}`) : []),
      ...(noSite ? ["  - (DSH_V02_NO_TEST_SITE=1 disables the coordinator test-site fallback on purpose)"] : []),
      ...(noSite || !siteRes
        ? [
            "",
            "fix it by either:",
            `  - installing the exact manifest peer versions into ${join(localNodeRoot, "@deepseek-ai")}`,
            "  - or setting DSH_RUNTIME_RC2 to a valid exactly-matching tree",
          ]
        : []),
    ]);
  }
  peerRes = { ...siteRes, mode: "coordinator-test-site-default", label: DEFAULT_TEST_SITE };
  console.log(
    `typecheck-v02: peer source [documented coordinator test site ${DEFAULT_TEST_SITE}] (deliberate default; local node_modules rejected as peer source: ${localRes.problems.slice(0, 3).join("; ")}${localRes.problems.length > 3 ? "; …" : ""})`,
  );
}

const modeLog =
  peerRes.mode === "explicit-override"
    ? `typecheck-v02: peer source [explicit override ${peerRes.label}] (exactly validated rc.2 set)`
    : peerRes.mode === "local-declared-peers"
      ? `typecheck-v02: peer source [local declared peers ${peerRes.label}] (exactly validated rc.2 set; machine-portable)`
      : peerRes.mode === "coordinator-test-site-default"
        ? `typecheck-v02: peer source [documented coordinator test site ${peerRes.label}] (exactly validated rc.2 set; deliberate default)`
        : `typecheck-v02: peer source [peer resolution failed?]`;

if (printResolution) {
  console.log(
    JSON.stringify(
      { mode: peerRes.mode, peerRoot: peerRes.rootPkgs, peers: peerRes.versions, strictCompile: false },
      null,
      2,
    ),
  );
  cleanup();
  process.exit(0);
}
console.log(modeLog);
if (allowPrebuilt) {
  console.log("typecheck-v02: --allow-prebuilt noted: it applies only to the no-toolchain artifact-verification context;");
  console.log("typecheck-v02: this run performs a real strict rc.2 compile against the resolved peer source.");
}

// ---------------------------------------------------------------------------
// Scrub-tree build: copy sources fresh, symlink exactly validated contracts.
// ---------------------------------------------------------------------------
mkdirSync(join(scratch, "src"), { recursive: true });
mkdirSync(join(scratch, "node_modules", "@deepseek-ai"), { recursive: true });
cpSync(join(repo, "src"), join(scratch, "src"), { recursive: true });

for (const dep of PLUGIN_DEPS) {
  // Plugin-owned runtime deps are peer-independent: repo node_modules first,
  // then the validated peer source's own node_modules.
  const candidates = [join(localNodeRoot, dep), join(dirname(peerRes.rootPkgs), dep)];
  const real = candidates.find((c) => {
    if (!existsSync(c)) return false;
    // Native projection states require the tested Zod4 contract, not an
    // unrelated older local SDK dependency. This does not install anything.
    if (dep !== "zod") return true;
    try { return JSON.parse(readFileSync(join(c, "package.json"), "utf8")).version === manifest.dependencies?.zod; }
    catch { return false; }
  });
  if (!real) fail(`plugin dependency not installed in any resolvable node_modules: ${dep} (tried ${candidates.join(", ")})`);
  mkdirSync(dirname(join(scratch, "node_modules", dep)), { recursive: true });
  symlinkSync(real, join(scratch, "node_modules", dep));
}

for (const [scoped, slug] of Object.entries(PEERS)) {
  symlinkSync(join(peerRes.rootPkgs, slug), join(scratch, "node_modules", "@deepseek-ai", slug));
}
// Out-of-scope and non-exactly-pinable peer ranges are already refused at the
// manifest guard above, before any context choice.

// Throwaway check tree: a private package root whose node_modules resolves the
// exactly validated rc.2 peer contracts; sources are copied fresh so the repo
// tree is untouched.
writeFileSync(
  join(scratch, "package.json"),
  JSON.stringify({ name: `${manifest.name}-rc2-typecheck`, private: true, type: "module" }, null, 2),
);
writeFileSync(
  join(scratch, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2023"],
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        types: ["node"],
        typeRoots: [join(localNodeRoot, "@types")],
        outDir: "lib",
        declaration: true,
        noEmit: !emitLib,
      },
      include: ["src"],
    },
    null,
    2,
  ),
);

const tsc = spawnSync(tscBin, ["-p", "tsconfig.json"], {
  cwd: scratch,
  encoding: "utf8",
});
console.log(`# exactly validated rc.2 contract versions (${peerRes.mode}):\n#   ${Object.entries(PEERS).map(([scoped, slug]) => `${scoped}@${peerRes.versions[slug]}`).join("\n#   ")}`);

if (tsc.error) {
  console.error(`typecheck-v02: failed to spawn the TypeScript compiler at ${tscBin}: ${tsc.error.message}`);
  process.exitCode = 1;
} else {
  process.stdout.write(tsc.stdout ?? "");
  process.stderr.write(tsc.stderr ?? "");
  process.exitCode = tsc.status ?? 1;
}

if (process.exitCode === 0 && emitLib) {
  // Build-artifact replacement, guarded: only <repoRoot>/lib under this repo.
  const targetLib = join(repo, "lib");
  let realRepo = repo;
  try {
    realRepo = realpathSync(repo);
  } catch {
    /* repo always exists */
  }
  if (!targetLib.startsWith(realRepo + sep) || targetLib === realRepo) {
    fail(`refusing to emit: unexpected build-artifact target ${targetLib}`);
  }
  try {
    if (lstatSync(targetLib).isSymbolicLink()) fail(`refusing to emit through a symlinked build directory: ${targetLib}`);
  } catch {
    /* lib absent: fresh build */
  }
  try {
    rmSync(targetLib, { recursive: true, force: true });
  } catch (err) {
    fail(`could not clear the previous build output ${targetLib}: ${err.message}`);
  }
  cpSync(join(scratch, "lib"), targetLib, { recursive: true });
  console.log("typecheck-v02: emitted rc.2-built lib -> repo lib/ (stale build output replaced; emitted output is map-free)");
}

console.log(
  process.exitCode === 0
    ? `typecheck-v02: strict typecheck against exactly validated rc.2 contracts PASSED (${peerRes.mode}; source strict; dependency declarations skipped via skipLibCheck)`
    : "typecheck-v02: strict typecheck against rc.2 contracts FAILED",
);
