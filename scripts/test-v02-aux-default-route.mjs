#!/usr/bin/env node
// Verify aux routing through the real pinned AgentDefaultModel service and plugin helper.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, "Explicit DSH_RUNTIME_RC2 required; no runtime install/profile/fallback");
for (const name of ["cordis", "dsh-agent-default-model", "dsh-llm"]) {
  const meta = JSON.parse(readFileSync(join(runtime, "node_modules/@deepseek-ai", name, "package.json"), "utf8"));
  if (name !== "cordis") assert.equal(meta.version, "0.2.1-rc.2", `${name} must be the pinned rc.2 contract`);
}

const repo = fileURLToPath(new URL("../", import.meta.url));
const fixture = mkdtempSync(join(repo, ".tmp-import-lane/aux-default-route-"));
const pluginDir = join(fixture, "plugin");
mkdirSync(pluginDir, { recursive: true });
cpSync(join(repo, "lib"), join(pluginDir, "lib"), { recursive: true });
cpSync(join(repo, "package.json"), join(pluginDir, "package.json"));
const manifest = JSON.parse(readFileSync(join(pluginDir, "package.json"), "utf8"));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith("@deepseek-ai/") || name === "zod"
    ? join(runtime, "node_modules", name)
    : join(repo, "node_modules", name);
  const target = join(pluginDir, "node_modules", name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(from, target);
}
const native = (name) => import(pathToFileURL(join(runtime, "node_modules/@deepseek-ai", name, "lib/index.js")).href);
const { Context } = await native("cordis");
const { default: AgentDefaultModelConfig } = await native("dsh-agent-default-model");
const { makeLlmCall } = await import(pathToFileURL(join(pluginDir, "lib/index.js")).href);

const root = new Context();
root.provide("settings", { configure: () => () => {} });
const seen = [];
root.provide("llm", {
  async *stream(options) {
    seen.push({ provider: options.provider, model: options.model });
    yield { type: "text-delta", index: 0, text: "ok" };
    yield { type: "finish", reason: { kind: "stop" } };
  },
});
const fiber = root.plugin(AgentDefaultModelConfig, { provider: "synthetic-default-route", model: "default-model" });
await fiber.await();

let passes = 0;
const check = (name, ok, details = "") => {
  assert.ok(ok, `${name}${details ? `: ${details}` : ""}`);
  passes++;
  console.log(`PASS ${name}`);
};
const invoke = async (config) => {
  const call = makeLlmCall(root, config, "route-contract-test", 128);
  const result = await call({ system: "system", user: "user", signal: AbortSignal.timeout(2000) });
  return { result, request: seen.at(-1) };
};
try {
  check("real default-model service exposes pinned configured selection", root.agentDefaultModel.currentSelection().provider === "synthetic-default-route"
    && root.agentDefaultModel.currentSelection().model === "default-model");
  const fallback = await invoke({ extract: { provider: "", model: "" } });
  check("empty aux route resolves through actual AgentDefaultModel service", fallback.result === "ok"
    && fallback.request.provider === "synthetic-default-route" && fallback.request.model === "default-model");
  const explicit = await invoke({ extract: { provider: "explicit-provider", model: "explicit-model" } });
  check("complete plugin route takes precedence over deployment default", explicit.request.provider === "explicit-provider" && explicit.request.model === "explicit-model");
  const modelOnly = await invoke({ extract: { provider: "", model: "per-plugin-model" } });
  check("partial plugin route combines its model with service provider", modelOnly.request.provider === "synthetic-default-route" && modelOnly.request.model === "per-plugin-model");
  const providerOnly = await invoke({ extract: { provider: "per-plugin-provider", model: "" } });
  check("partial plugin route combines its provider with service model", providerOnly.request.provider === "per-plugin-provider" && providerOnly.request.model === "default-model");
  let missingRouteRefused = false;
  try {
    await makeLlmCall({ llm: root.llm }, { extract: { provider: "", model: "" } }, "route-contract-test", 128)(
      { system: "system", user: "user", signal: AbortSignal.timeout(2000) },
    );
  } catch (error) {
    missingRouteRefused = String(error).includes("no model provider configured");
  }
  check("missing service and route refuse visibly without fallback guessing", missingRouteRefused);
} finally {
  await fiber.dispose();
}
console.log(`${passes} PASS / 0 FAIL; actual rc.2 AgentDefaultModel service + private fake LLM; no profile/network/production access; fixture=${fixture}`);
