#!/usr/bin/env node
// Isolated, genuine-Cordis regression: a warning is not cancellation/quiescence.
// No profile, filesystem, provider, or production-data access.
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { registerShutdownDrain, SHUTDOWN_DRAIN_BUDGET_MS } from "../lib/index.js";

let settled = false;
let closeWhileAcceptedWorkRunning = false;
const warnings = [];
const job = new Promise(resolve => setTimeout(resolve, SHUTDOWN_DRAIN_BUDGET_MS + 100))
  .then(() => { settled = true; });
const jobs = new Set([job]);
const ctx = new Context();
registerShutdownDrain(ctx, {
  onShutdownStart() {},
  dropIngress() {},
  preClose() {},
  jobs,
  close() { closeWhileAcceptedWorkRunning = !settled; },
  warn(message) { warnings.push(message); },
});
await ctx.fiber.dispose();
await job;
assert.equal(closeWhileAcceptedWorkRunning, false,
  "storage must not close while an accepted job still runs after the drain deadline; warning/clearing the tracking set is not cancellation");
console.log("PASS shutdown deadline preserves accepted-job quiescence before storage close");
