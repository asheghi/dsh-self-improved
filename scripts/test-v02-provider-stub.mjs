#!/usr/bin/env node
/**
 * scripts/test-v02-provider-stub.mjs — fixture check for the isolated provider
 * stub (fixtures/v02-ui/provider-stub.mjs).
 *
 * The stub exists so mounted fixtures can exercise provider-consuming lanes
 * without a model. Two behaviours matter and are pinned here:
 *   - the continuity handoff worker accepts ONLY extractive quotes that are
 *     exact substrings of the supplied source text, so the stub must answer
 *     with valid `{"excerpts":[{"seq":N,"quote":"…"}]}` for that prompt;
 *   - every other provider call (and malformed input) keeps the neutral
 *     STUB-ACK that the existing mounted gates count on.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "dsi-stub-check-"));
const log = join(work, "provider.jsonl");
const proc = spawn("node", [join(ROOT, "fixtures", "v02-ui", "provider-stub.mjs"), log], { stdio: ["ignore", "pipe", "ignore"] });

let passes = 0, failures = 0;
const check = async (name, fn) => {
  try { await fn(); passes++; console.log("PASS " + name); }
  catch (error) { failures++; console.log("FAIL " + name + " :: " + (error && error.message)); }
};

try {
  let out = "";
  proc.stdout.on("data", (chunk) => { out += String(chunk); });
  for (let i = 0; i < 200 && !out.includes("STUB_READY"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const port = Number(/STUB_READY port=(\d+)/.exec(out)?.[1]);
  assert.ok(Number.isInteger(port) && port > 0, "stub reported a port");

  const call = async (text) => {
    const body = JSON.stringify({ model: "stub", messages: [{ role: "user", content: [{ type: "text", text }] }] });
    const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": "synthetic" }, body,
    });
    const sse = await response.text();
    return sse.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
      .filter((event) => event.type === "content_block_delta").map((event) => event.delta.text).join("");
  };

  const source = JSON.stringify({ partial: true, unverified: true,
    excerpts: [{ seq: 4, text: "marker 8821 and further prose the model is allowed to quote" }] });
  const answer = await call(source);
  await check("continuity prompt is answered with an extractive, substring-exact quote", () => {
    const parsed = JSON.parse(answer);
    assert.equal(parsed.excerpts.length, 1);
    assert.equal(parsed.excerpts[0].seq, 4);
    assert.ok(source.includes(parsed.excerpts[0].quote), "quote must be an exact substring of the supplied source");
    assert.ok(parsed.excerpts[0].quote.length <= 200);
  });
  await check("an empty source answers with empty excerpts rather than an invalid quote", async () => {
    const empty = await call(JSON.stringify({ partial: true, unverified: true, excerpts: [{ seq: 0, text: "   " }] }));
    assert.deepEqual(JSON.parse(empty), { excerpts: [] });
  });
  await check("every other provider call keeps the neutral STUB-ACK", async () => {
    assert.equal(await call("just a normal prompt"), "STUB-ACK");
  });
  await check("malformed provider input degrades to STUB-ACK without throwing", async () => {
    assert.equal(await call("{ not json"), "STUB-ACK");
  });
  await check("the stub logs each request for the pause-firewall checks", () => {
    const entries = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.ok(entries.length >= 5, "boot note plus one entry per request");
    assert.equal(entries[0].note.startsWith("stub booted"), true);
  });
} finally {
  proc.kill("SIGKILL");
  rmSync(work, { recursive: true, force: true });
}

console.log(`${passes} provider-stub fixture gates PASS, ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
