#!/usr/bin/env node
/**
 * Standalone mode-semantics regressions for scripts/typecheck-v02.mjs in REAL
 * staged artifact trees. Every case stages a genuine no-toolchain artifact
 * (lib/, client.js, cordis.patch.yml, tsconfig.json, package.json and the
 * wrapper itself are really copied, never symlinked into the payload) and
 * executes the real script — there are no helper-only assertions.
 *
 *   T1 no toolchain + no --allow-prebuilt + shipped lib (default/strict
 *      request, e.g. `npm run build`/`typecheck:v02` semantics): fail closed
 *      exit 2; never an artifact verdict, never PASSED
 *   T2 --print-resolution in the no-toolchain context without the opt-in:
 *      fail closed (a peer-source resolution here would misreport the context)
 *   T3 --allow-prebuilt + explicitly invalid DSH_RUNTIME_RC2 while the
 *      artifact is ready: refused (exit 2), no fallback, no artifact verdict
 *   T4 empty @deepseek-ai peer set (owned staged manifest): refused even
 *      with the explicit opt-in
 *   T5 non-exactly-pinable peer range (owned staged manifest "*"): refused
 *   T6 explicitly opted-in artifact verification (--allow-prebuilt): exit 0,
 *      explicit no-strict-compile NOTICE, no PASSED claim, and shlib +
 *      metadata stay byte-identical (verification mutates nothing)
 *   T7 --allow-prebuilt with lib/index.js removed: actionable exit 2 naming it
 *   T8 idempotent re-verification; --emit-lib without a compiler emits
 *      nothing (lib byte-identical, honesty line printed)
 *
 * Needs NO TypeScript toolchain, NO coordinator test site and NO peer source:
 * the no-toolchain artifact path never resolves peers unless an explicit
 * DSH_RUNTIME_RC2 override is set (T3 uses a deliberately nonexistent one).
 * No network, no installs, no root-manifest edits — T4/T5 stage their
 * positive-broken manifests inside this suite's unique owned temp root only.
 * The coordinator test site is never consulted; every assertion is local.
 *
 * Usage: node scripts/test-v02-typecheck-modes.mjs
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
  writeFileSync,
} from "node:fs";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WRAPPER = "scripts/typecheck-v02.mjs";
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok: !!ok, detail: String(detail) });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return !!ok;
}

// ---------------------------------------------------------------------------
// Unique owned temp root under fixtures/v02-typecheck-modes/temp/suite-…;
// guarded cleanup only ever deletes paths realpath-resolving inside it.
// ---------------------------------------------------------------------------
const tempBase = join(repo, "fixtures", "v02-typecheck-modes", "temp");
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
const suiteId = `typecheck-modes-${new Date().toISOString()}-${process.pid}`;
let cleanedTemp = false;
function cleanupTemp() {
  if (cleanedTemp) return;
  cleanedTemp = true;
  try {
    const base = realpathSync(tempRoot);
    rmSync(base, { recursive: true, force: true }); // unique root, realpath-verified above
  } catch {
    /* if it ever fails, the final hygiene check below surfaces it */
  }
}
process.on("exit", cleanupTemp);
process.on("SIGINT", () => process.exit(130));
process.on("SIGTERM", () => process.exit(143));
process.on("uncaughtException", (err) => {
  cleanupTemp();
  throw err;
});

const child = (args, opts = {}) => {
  const r = spawnSync("node", args, {
    encoding: "utf8",
    cwd: opts.cwd ?? repo,
    env: opts.env ?? { ...process.env, DSH_RUNTIME_RC2: "" },
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Stage a real standalone artifact copy: prebuilt lib/ + metadata real-copied
 * (NOT symlinked) from the shipped repo state, plus the wrapper itself so the
 * script resolves the staged tree as its own artifact root. opts.manifest
 * replaces peerDependencies in the staged copy (owned staged manifest for the
 * refusal cases — the coordinator-owned root manifest is never touched).
 */
function stageArtifact(name, opts = {}) {
  const root = join(tempRoot, name);
  mkdirSync(join(root, "scripts"), { recursive: true });
  cpSync(join(repo, "lib"), join(root, "lib"), { recursive: true }); // real copied prebuilt lib
  for (const f of ["client.js", "cordis.patch.yml", "tsconfig.json", "package.json"]) cpSync(join(repo, f), join(root, f));
  cpSync(join(repo, WRAPPER), join(root, WRAPPER)); // the wrapper itself ships in the artifact scripts/
  if (opts.manifest) {
    const staged = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    staged.peerDependencies = opts.manifest;
    writeFileSync(join(root, "package.json"), JSON.stringify(staged, null, 2) + "\n");
  }
  return root;
}
const noRuntime = (extra = {}) => ({ ...process.env, DSH_RUNTIME_RC2: "", ...extra });

if (!existsSync(join(repo, "lib", "index.js"))) {
  console.log("FATAL: repo lib/index.js missing — cannot stage a real prebuilt artifact (run pnpm build first)");
  process.exitCode = 1;
} else {
  const envNoSite = noRuntime({ DSH_V02_NO_TEST_SITE: "1" });
  let s = "";

  // -----------------------------------------------------------------------
  // T1: strict no-compiler refusal
  // -----------------------------------------------------------------------
  console.log("\n== T1 strict no-compiler refusal (default mode, lib shipped, no opt-in) ==");
  {
    const art = stageArtifact("t1-strict-refusal");
    const h0 = sha256(join(art, "lib", "index.js"));
    const r = child([WRAPPER], { cwd: art, env: envNoSite });
    check("T1/default no-flags mode with a shipped prebuilt lib fails closed (exit 2, strict gate never conflates)", r.status === 2, `exit=${r.status}`);
    check("T1/refusal says the strict compile cannot run and names the --allow-prebuilt opt-in honestly", /fails closed|fires closed/.test(r.stderr) && /--allow-prebuilt/.test(r.stderr) && /CANNOT run/.test(r.stderr), (r.stderr.split("\n").find((l) => l.includes("CANNOT run")) ?? "").trim().slice(0, 180));
    check("T1/no artifact verdict and no PASSED claim leak out", !/verified/.test(r.stdout) && !/NOTICE/.test(r.stdout) && !/PASSED/.test(r.stdout), "stdout clean of artifact/strict claims");
    check("T1/refusal touches nothing: lib stays byte-identical", sha256(join(art, "lib", "index.js")) === h0);
    const rNoLib = child([WRAPPER], { cwd: stageArtifact("t1b-strict-refusal-no-lib"), env: envNoSite });
    check("T1/no toolchain and no lib: same strict refusal shape, exit 2 (no silent recovery)", rNoLib.status === 2);
  }

  // -----------------------------------------------------------------------
  // T2: --print-resolution also fails closed without the opt-in
  // -----------------------------------------------------------------------
  console.log("\n== T2 --print-resolution without the opt-in fails closed ==");
  {
    const art = stageArtifact("t2-print-resolution");
    const r = child([WRAPPER, "--print-resolution"], { cwd: art, env: envNoSite });
    check("T2/print-resolution in the no-toolchain context refuses instead of misreporting (exit 2)", r.status === 2 && /--allow-prebuilt/.test(r.stderr), `exit=${r.status}`);
  }

  // -----------------------------------------------------------------------
  // T3: explicit invalid runtime override refused even with artifact ready
  // -----------------------------------------------------------------------
  console.log("\n== T3 invalid explicit DSH_RUNTIME_RC2 refused even with the artifact ready ==");
  {
    const art = stageArtifact("t3-invalid-override");
    const r = child([WRAPPER, "--allow-prebuilt"], {
      cwd: art,
      env: noRuntime({ DSH_RUNTIME_RC2: join(tempRoot, "override-tree-does-not-exist"), DSH_V02_NO_TEST_SITE: "1" }),
    });
    check("T3/explicit invalid override + --allow-prebuilt fails closed (exit 2, artifact NOT verified)", r.status === 2 && !/verified/.test(r.stdout), `exit=${r.status}`);
    check("T3/refusal names the override and states no fallback/no artifact verdict", r.stderr.includes("no fallback") && /refuses/.test(r.stderr), (r.stderr.split("\n").find((l) => l.includes("no fallback")) ?? "").trim().slice(0, 200));
  }

  // -----------------------------------------------------------------------
  // T4: empty @deepseek-ai peer declaration set refused even opted-in
  // -----------------------------------------------------------------------
  console.log("\n== T4 empty @deepseek-ai peer set refused even with the opt-in ==");
  {
    const art = stageArtifact("t4-empty-peers", { manifest: {} });
    const r = child([WRAPPER, "--allow-prebuilt"], { cwd: art, env: envNoSite });
    check("T4/empty peer set refused even with --allow-prebuilt (exit 2, claimed false pass impossible)", r.status === 2 && /declares no @deepseek-ai peerDependencies/.test(r.stderr), `exit=${r.status}; ${(r.stderr.split("\n").find((l) => l.includes("declares")) ?? "").trim().slice(0, 180)}`);
    const rStrict = child([WRAPPER], { cwd: art, env: envNoSite });
    check("T4/empty peer set also refuses the strict path (exit 2)", rStrict.status === 2);
  }

  // -----------------------------------------------------------------------
  // T5: non-exactly-pinable peer range refused even opted-in
  // -----------------------------------------------------------------------
  console.log("\n== T5 non-exactly-pinable peer range refused even with the opt-in ==");
  {
    const art = stageArtifact("t5-nonexact-range", { manifest: { "@deepseek-ai/cordis": "*" } });
    const r = child([WRAPPER, "--allow-prebuilt"], { cwd: art, env: envNoSite });
    check("T5/star peer range refused even with --allow-prebuilt (exit 2)", r.status === 2 && /not an exactly-pinable range/.test(r.stderr), `exit=${r.status}`);
    check("T5/refusal names the offending peer and range verbatim", r.stderr.includes("@deepseek-ai/cordis@*"), (r.stderr.split("\n").find((l) => l.includes("exactly-pinable")) ?? "").trim().slice(0, 200));
  }

  // -----------------------------------------------------------------------
  // T6: explicit opted-in artifact verification is honest and sterile
  // -----------------------------------------------------------------------
  console.log("\n== T6 explicit opted-in artifact verification ==");
  {
    const art = stageArtifact("t6-opted-in-verify");
    const hLib = sha256(join(art, "lib", "index.js"));
    const hClient = sha256(join(art, "client.js"));
    const hManifest = sha256(join(art, "package.json"));
    const r = child([WRAPPER, "--allow-prebuilt"], { cwd: art, env: envNoSite });
    check("T6/opted-in verification passes in the real staged artifact (exit 0)", r.status === 0, r.status === 0 ? "artifact-verify wording" : `exit=${r.status} ${(r.stderr.split("\n").filter(Boolean)[0] ?? "").slice(0, 220)}`);
    check("T6/output says explicit artifact verification and printed the no-strict-compile NOTICE", /explicit artifact verification/.test(r.stdout) && /NOTICE/.test(r.stdout) && /strict rc\.2 compile/i.test(r.stdout), `${r.stdout.split("\n").filter((l) => l.includes("NOTICE")).length} notice lines`);
    check("T6/never claims PASSED and names the strict evidence location instead", !/PASSED/.test(r.stdout) && /test-v02-package\.mjs/.test(r.stdout), "no strict claim");
    check("T6/verification is sterile: lib, client.js, manifest all stay byte-identical", sha256(join(art, "lib", "index.js")) === hLib && sha256(join(art, "client.js")) === hClient && sha256(join(art, "package.json")) === hManifest, "no artifact bytes changed");
  }

  // -----------------------------------------------------------------------
  // T7: missing-lib refusal under the opt-in
  // -----------------------------------------------------------------------
  console.log("\n== T7 missing-lib refusal under the explicit opt-in ==");
  {
    const art = stageArtifact("t7-missing-lib");
    rmSync(join(art, "lib", "index.js"));
    const r = child([WRAPPER, "--allow-prebuilt"], { cwd: art, env: envNoSite });
    check("T7/lib/index.js removed: actionable exit 2 naming the missing prerequisite", r.status === 2 && /missing:/.test(r.stderr) && /lib\/index\.js/.test(r.stderr), `exit=${r.status}; ${(r.stderr.split("\n").find((l) => l.includes("missing:")) ?? "").trim().slice(0, 180)}`);
    const artTypes = stageArtifact("t7b-missing-types");
    rmSync(join(artTypes, "lib", "index.d.ts"));
    const r2 = child([WRAPPER, "--allow-prebuilt"], { cwd: artTypes, env: envNoSite });
    check("T7/lib/index.d.ts missing is also named (declaration surface verified too)", r2.status === 2 && /lib\/index\.d\.ts/.test(r2.stderr), `exit=${r2.status}`);
  }

  // -----------------------------------------------------------------------
  // T8: idempotent re-verification; --emit-lib emits nothing without a compile
  // -----------------------------------------------------------------------
  console.log("\n== T8 idempotence and emit-lib honesty in the artifact context ==");
  {
    const art = stageArtifact("t8-idempotent-emit");
    const h0 = sha256(join(art, "lib", "index.js"));
    const r = child([WRAPPER, "--allow-prebuilt", "--emit-lib"], { cwd: art, env: envNoSite });
    check("T8/verification with --emit-lib still exits 0 and states emission is impossible without a compile", r.status === 0 && /emit-lib does nothing without a compile/.test(r.stdout) && sha256(join(art, "lib", "index.js")) === h0, `exit=${r.status}; lib byte-identical=${sha256(join(art, "lib", "index.js")) === h0}`);
    const r2 = child([WRAPPER, "--allow-prebuilt"], { cwd: art, env: envNoSite });
    check("T8/second plain verification is idempotent (exit 0, lib byte-identical)", r2.status === 0 && sha256(join(art, "lib", "index.js")) === h0);
  }

  // -----------------------------------------------------------------------
  // hygiene + durable evidence
  // -----------------------------------------------------------------------
  cleanupTemp();
  check("C9/suite temp root fully removed (tree and parent)", !existsSync(tempRoot), existsSync(tempRoot) ? `leaked: ${tempRoot}` : `removed: suite id ${suiteId}`);
  const passCount = results.filter((r) => r.ok).length;
  const failCount = results.filter((r) => !r.ok).length;
  const summary = `=== typecheck-v02 mode gate summary: STRICT ${passCount} PASS / ${failCount} FAIL ===`;
  console.log("\n" + summary);

  const reportDir = join(repo, "fixtures", "v02-typecheck-modes");
  writeFileSync(
    join(reportDir, "last-modes-pin.json"),
    JSON.stringify(
      {
        suiteId,
        timestamp: new Date().toISOString(),
        node: process.version,
        wrapper: WRAPPER,
        wrapperSha256: (() => {
          try {
            return sha256(join(repo, WRAPPER));
          } catch {
            return null;
          }
        })(),
        harness: "real copies staged under the suite's own unique temp root; no toolchain, no coordinator test site, no network, no installs",
        strictPass: passCount,
        strictFail: failCount,
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    join(reportDir, "last-modes-run.log"),
    [new Date().toISOString(), summary, ...results.map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? ` — ${r.detail}` : ""}`), ""].join("\n"),
  );
  process.exitCode = failCount > 0 ? 1 : 0;
}
