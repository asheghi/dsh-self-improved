#!/usr/bin/env node
/**
 * Phase A gate: strict typecheck of this plugin against the installed rc.2
 * runtime type contracts (MIGRATION-V0.2.md gate "strict typecheck against
 * current packages").
 *
 * The installed runtime (default /home/bahman/github/dsh-v0.2) is contract/test
 * evidence only: the script reads its declarations through symlinks inside a
 * throwaway scratch tree and never modifies the runtime. The repo's own
 * node_modules still resolves the legacy rc.6/rc.8 peers, which the plain
 * `pnpm build` uses, so the rc.2 strict check lives here.
 *
 * Usage: node scripts/typecheck-v02.mjs [--emit-lib]
 */
import { cpSync, mkdirSync, readdirSync, symlinkSync, existsSync, rmSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = process.env.DSH_RUNTIME_RC2 ?? "/home/bahman/github/dsh-v0.2";

const runtimePkgs = join(RUNTIME, "node_modules", "@deepseek-ai");
if (!existsSync(runtimePkgs)) {
  console.error(`typecheck-v02: rc.2 runtime packages not found at ${runtimePkgs}; set DSH_RUNTIME_RC2`);
  process.exit(2);
}

// Plugin-owned runtime dependencies (not peer contracts) are resolved into the
// check tree from the repo's node_modules so dependency-less symlinks still resolve.
const PLUGIN_DEPS = ["sqlite-vec", "@node-rs/jieba"];

// Peer packages this plugin must strictly typecheck against (mirror package.json peers).
const EXPECTED_PEERS = [
  "dsh-agent",
  "dsh-agent-default-model",
  "dsh-home-paths",
  "dsh-llm",
  "dsh-schedule",
  "dsh-session",
  "dsh-session-query",
  "dsh-settings",
  "dsh-skill",
  "dsh-storage-domain",
  "dsh-system-prompt",
  "dsh-tools",
  "schemastery",
  "cordis",
];

// Guarded cleanup: only this uniquely created temp tree is ever removed.
const scratch = join(mkdtempSync(join(tmpdir(), "dsi-typecheck-v02-")), "check");
process.on("exit", () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    /* best effort; the tree lives under os.tmpdir() */
  }
});
mkdirSync(join(scratch, "src"), { recursive: true });
mkdirSync(join(scratch, "node_modules", "@deepseek-ai"), { recursive: true });
mkdirSync(join(scratch, "node_modules", "@node-rs"), { recursive: true });

cpSync(join(repo, "src"), join(scratch, "src"), { recursive: true });

// Verify the declared peers exist in the installed runtime; a stale manifest surface fails fast.
const installed = new Set(readdirSync(runtimePkgs));
const missing = EXPECTED_PEERS.filter((p) => !installed.has(p));
if (missing.length > 0) {
  console.error(`typecheck-v02: peers missing from installed rc.2 runtime: ${missing.join(", ")}`);
  process.exit(2);
}
for (const pkg of EXPECTED_PEERS) {
  symlinkSync(join(runtimePkgs, pkg), join(scratch, "node_modules", "@deepseek-ai", pkg));
}

// Explicit supported-target assertion: the migration pins 0.2.0-rc.2; any
// other runtime tree must be verified separately, not silently accepted.
const REQUIRED_VERSION = "0.2.0-rc.2";
const versions = EXPECTED_PEERS.map((pkg) => {
  const manifest = JSON.parse(readFileSync(join(runtimePkgs, pkg, "package.json"), "utf8"));
  return `${pkg}@${String(manifest.version ?? "")}`;
});
const offTarget = versions.filter((v) => v.startsWith("dsh-") && !v.endsWith(`@${REQUIRED_VERSION}`));
if (offTarget.length > 0) {
  console.error(`typecheck-v02: refusing to typecheck against an unpinned runtime: ${offTarget.join(", ")}`);
  process.exit(2);
}
for (const dep of PLUGIN_DEPS) {
  const real = existsSync(join(repo, "node_modules", dep)) ? join(repo, "node_modules", dep) : null;
  if (!real) {
    console.error(`typecheck-v02: plugin dependency not installed in repo node_modules: ${dep}`);
    process.exit(2);
  }
  symlinkSync(real, join(scratch, "node_modules", dep));
}

// Throwaway check tree: a private package root whose node_modules resolves the
// rc.2 peer contracts; sources are copied fresh so the repo tree is untouched.
writeFileSync(
  join(scratch, "package.json"),
  JSON.stringify({ name: "dsh-self-improved-rc2-typecheck", private: true, type: "module" }, null, 2),
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
        typeRoots: [join(repo, "node_modules", "@types")],
        outDir: "lib",
        declaration: true,
        noEmit: !process.argv.includes("--emit-lib"),
      },
      include: ["src"],
    },
    null,
    2,
  ),
);

const tsc = spawnSync(join(repo, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], {
  cwd: scratch,
  encoding: "utf8",
});
console.log(`# rc.2 runtime contract versions:\n#   ${versions.join("\n#   ")}`);
process.stdout.write(tsc.stdout ?? "");
process.stderr.write(tsc.stderr ?? "");
process.exitCode = tsc.status ?? 1;
if (process.exitCode === 0 && process.argv.includes("--emit-lib")) {
    cpSync(join(scratch, "lib"), join(repo, "lib"), { recursive: true });
  console.log("typecheck-v02: emitted rc.2-built lib -> repo lib/");
}
console.log(
  process.exitCode === 0
    ? "typecheck-v02: strict typecheck against rc.2 contracts PASSED (source strict; dependency declarations skipped via skipLibCheck)"
    : "typecheck-v02: strict typecheck against rc.2 contracts FAILED",
);
