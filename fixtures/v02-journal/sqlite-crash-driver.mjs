/**
 * Crash-support driver consumed by scripts/test-v02-journal.mjs (plain JS .mjs).
 *
 * `sqliteCrashSupportAvailable()` verifies the runtime can spawn children and
 * probe signals — the durable suite refuses to fake crash evidence otherwise.
 *
 * `runCrashBoundaryScenario({ repo, dir, boundary })` executes one
 * fixtures/v02-journal/worker-a.mjs run in a CHILD PROCESS and returns
 * { signal, code, stdout, stderr, timedOut }. The parent (suite) then reopens
 * the SQLite file itself and asserts every invariant: durability evidence is
 * always cross-process.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

export function sqliteCrashSupportAvailable() {
  if (typeof process.kill !== "function") return false;
  if (typeof spawnSync !== "function") return false;
  try {
    process.kill(process.pid, 0); // signal-support probe (no-op signal 0)
    return true;
  } catch {
    return false;
  }
}

export function runCrashBoundaryScenario({ repo, dir, boundary, timeoutMs = 90_000 }) {
  const scenarioDir = mkdtempSync(join(tmpdir(), "journal-v02-sc-"));
  const scenarioPath = join(scenarioDir, "scenario.json");
  writeFileSync(scenarioPath, JSON.stringify({ dir, boundary }));
  const worker = join(repo, "fixtures", "v02-journal", "worker-a.mjs");
  try {
    const res = spawnSync(process.execPath, [worker, scenarioPath], {
      encoding: "utf8",
      timeout: timeoutMs,
      cwd: repo,
    });
    return {
      signal: res.signal ?? null,
      code: res.status ?? null,
      stdout: res.stdout ?? "",
      stderr: res.stderr ?? "",
      timedOut: res.error?.code === "ETIMEDOUT",
    };
  } finally {
    try { rmSync(scenarioDir, { recursive: true, force: true }); } catch { /* temp */ }
  }
}

export function assertSignalKilled(result, label) {
  if (result.timedOut) {
    throw new Error(`${label}: worker timed out instead of dying at the boundary`);
  }
  if (result.signal !== "SIGKILL") {
    throw new Error(
      `${label}: expected the worker to die by SIGKILL at the boundary, got signal=${result.signal} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
}

export function assertCleanExit(result, label) {
  if (result.code !== 0) {
    throw new Error(
      `${label}: expected clean exit 0, got code=${result.code} signal=${result.signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
    );
  }
}
