#!/usr/bin/env node
/**
 * Cross-process SIGKILL worker for the Phase B import lane crash-oracles
 * (scripts/test-v02-import-lane.mjs). Loads the REAL compiled engine
 * (lib/import-v02.js), reads dest/plan.json and applies with the test-only
 * crash points enabled. A named crash point kills THIS process with SIGKILL at
 * exactly that boundary (inside an open immediate transaction, or right after
 * a commit boundary) so rollback/durability behavior is real, not simulated.
 *
 *   node fixtures/v02-import/worker-apply.mjs --dest <dir> --crash-points <a,b>
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyImportPlan } from "../../lib/import-v02.js";

const here = dirname(fileURLToPath(import.meta.url));
let dest = "";
const crashPoints = new Set();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--dest") dest = resolve(argv[++i]);
  else if (argv[i] === "--crash-points") for (const p of String(argv[++i]).split(",")) if (p) crashPoints.add(p);
}
if (!dest) {
  console.error("worker-apply: --dest required");
  process.exit(2);
}
const planDoc = JSON.parse(readFileSync(join(dest, "plan.json"), "utf8"));
try {
  applyImportPlan(planDoc, {
    sourceRoot: planDoc.source.storeRoot,
    destinationRoot: dest,
    approvalToken: planDoc.approvalToken,
    resume: true, // crash-oracle reruns always declare the resume contract
    testCrashPoints: crashPoints,
  });
  console.log("worker-apply: completed");
  process.exit(0);
} catch (error) {
  console.error(`worker-apply: refusal: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
