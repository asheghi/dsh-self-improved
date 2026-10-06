import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertSafeMemoryDir, collectSecretProbes, judgeRolloutEvidence, scanStoreArtifacts } from "./episode-rollout-utils.mjs";

const root = mkdtempSync(join(tmpdir(), "dsh-episode-rollout-test-"));
try {
  const sessions = join(root, "sessions");
  const dshHome = join(root, "dsh-home");
  const outputParent = join(root, "output");
  mkdirSync(sessions);
  mkdirSync(dshHome);
  mkdirSync(outputParent);

  const destination = assertSafeMemoryDir(join(outputParent, "fresh"), sessions, dshHome);
  assert.equal(destination, join(outputParent, "fresh"), "returns canonical new destination");
  assert.throws(() => assertSafeMemoryDir(join(sessions, "inside"), sessions, dshHome), /overlap with session storage/);
  assert.throws(() => assertSafeMemoryDir(join(dshHome, "inside"), sessions, dshHome), /overlap with DSH home/);

  const customLive = join(root, "custom-live");
  mkdirSync(customLive);
  assert.throws(
    () => assertSafeMemoryDir(join(customLive, "rollout"), sessions, dshHome, [customLive]),
    /overlap with configured live memory storage/,
  );

  const alias = join(root, "sessions-alias");
  symlinkSync(sessions, alias, "dir");
  assert.throws(() => assertSafeMemoryDir(join(alias, "through-link"), sessions, dshHome), /overlap with session storage/);

  const existing = join(outputParent, "existing");
  mkdirSync(existing);
  writeFileSync(join(existing, "keep.txt"), "do not delete");
  assert.throws(() => assertSafeMemoryDir(existing, sessions, dshHome), /refusing existing memory-dir destination/);
  assert.equal(existsSync(join(existing, "keep.txt")), true, "existing destinations are preserved");

  const noParent = join(outputParent, "missing-parent", "new-store");
  assert.throws(() => assertSafeMemoryDir(noParent, sessions, dshHome), /parent must already exist/);

  const rawToken = "sk-rollout-probe-value-123456";
  const probes = collectSecretProbes({
    data: {
      auth: { apiKey: rawToken },
      nested: [{ authorization: "Bearer bearer-probe-value-123456" }],
      text: "{\"token\":\"json-token-probe-123456\"}",
    },
  });
  assert.ok(probes.has(rawToken), "structured secret-key values are collected as probes");
  assert.ok(probes.has("Bearer bearer-probe-value-123456") || probes.has("bearer-probe-value-123456"), "nested authorization values are inspected");
  assert.ok([...probes].some((probe) => probe.includes("json-token-probe-123456")), "serialized credentials remain supported");

  const storeDir = join(root, "store");
  mkdirSync(storeDir);
  mkdirSync(join(storeDir, "conversations"));
  writeFileSync(join(storeDir, "memory.db"), "[REDACTED] persisted main db");
  writeFileSync(join(storeDir, "memory.db-wal"), "wal-secret-probe-value-123456");
  writeFileSync(join(storeDir, "memory.db-shm"), "shared memory");
  writeFileSync(join(storeDir, "conversations", "session.jsonl"), "other-secret-probe-value-123456");
  const scan = scanStoreArtifacts(storeDir, new Set(["wal-secret-probe-value-123456", "other-secret-probe-value-123456"]));
  assert.deepEqual(scan.sqliteArtifacts, ["memory.db", "memory.db-shm", "memory.db-wal"]);
  assert.equal(scan.redactionMarkersOnDisk, true);
  assert.ok(scan.leaks.some((leak) => leak.artifact === "memory.db-wal"), "WAL bytes are scanned");
  assert.ok(scan.leaks.some((leak) => leak.artifact === "conversations/session.jsonl"), "other persisted files are scanned too");

  const incomplete = judgeRolloutEvidence({ leaks: [], secretProbesChecked: 0, totalEpisodes: 0, retryEpisodes: 0, redactionMarkersOnDisk: false });
  assert.deepEqual(incomplete, {
    verdict: "inconclusive",
    inconclusiveReasons: ["no-credential-probes", "no-episodes", "no-retry-evidence"],
  });
  assert.equal(judgeRolloutEvidence({ leaks: [], secretProbesChecked: 1, totalEpisodes: 1, retryEpisodes: 1, redactionMarkersOnDisk: false }).verdict, "FAIL", "missing redaction markers fail complete evidence runs");
  assert.equal(judgeRolloutEvidence({ leaks: [], secretProbesChecked: 1, totalEpisodes: 1, retryEpisodes: 1, redactionMarkersOnDisk: true }).verdict, "pass");
  assert.equal(judgeRolloutEvidence({ leaks: [{ artifact: "memory.db-wal" }], secretProbesChecked: 0, totalEpisodes: 0, retryEpisodes: 0, redactionMarkersOnDisk: false }).verdict, "FAIL", "leaks fail even when the run is otherwise incomplete");

  const validator = readFileSync(new URL("./validate-episode-rollout.mjs", import.meta.url), "utf8");
  assert.match(validator, /assertSafeMemoryDir\(requestedMemoryDir/);
  assert.doesNotMatch(validator, /rmSync/, "validator never recursively deletes a destination");
  const checkpointAt = validator.indexOf("store.checkpoint()");
  const closeAt = validator.indexOf("store.close()", checkpointAt);
  const scanAt = validator.indexOf("scanStoreArtifacts(memoryDir", closeAt);
  assert.ok(checkpointAt >= 0 && checkpointAt < closeAt && closeAt < scanAt, "store is checkpointed and closed before disk scanning");

  console.log("test-episode-rollout: PASS");
} finally {
  rmSync(root, { recursive: true, force: true });
}
