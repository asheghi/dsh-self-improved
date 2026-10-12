#!/usr/bin/env node
/**
 * scripts/test-v02-continuity-restart-mounted.mjs — mounted proof that
 * committed continuity progress survives a REAL host restart.
 *
 * Two phases, because the server must actually be restarted between them:
 *
 *   --phase1   create a source/target pair in a project directory, send a
 *              direct-human prompt, wait for the real worker to produce a
 *              handoff, then record the identities plus the durable policy
 *              generation and handoff count into <runDir>/restart-state.json.
 *   --phase2   after `test-v02-mounted-ui.mjs restart --run <runDir>`, read the
 *              NEW url, and require that the same session is still offered,
 *              that the door still returns the same notes, and that the durable
 *              generation/counts did not regress.
 *
 * Bring the fixture up with the lane enabled, inside ONE managed job so the
 * restart can signal its own server:
 *   DSI_E2E_CONTINUITY=1 node scripts/test-v02-mounted-ui.mjs up --fresh
 *   node scripts/test-v02-continuity-restart-mounted.mjs --phase1 --run <runDir>
 *   node scripts/test-v02-mounted-ui.mjs restart --run <runDir>
 *   node scripts/test-v02-continuity-restart-mounted.mjs --phase2 --run <runDir>
 */

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const phase = args.includes("--phase1") ? 1 : args.includes("--phase2") ? 2 : 0;
const runDir = flag("--run");
const timeoutMs = Number(flag("--timeout") ?? 180000);
if (!phase || !runDir) { console.error("usage: --phase1|--phase2 --run <runDir> [--timeout ms]"); process.exit(2); }

const MARKER = "CONTINUITY-RESTART-MARKER-5544";
const PROJECT = "/tmp/dsi-e2e-restart-project";
const factsPath = join(runDir, "facts.json");
const statePath = join(runDir, "restart-state.json");
let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const facts = JSON.parse(readFileSync(factsPath, "utf8"));
const base = new URL(facts.url).origin;
const token = new URL(facts.url).searchParams.get("token");
let cookie = "";

const rpc = async (endpoint, argsObject) => {
  const body = { type: "client-request", rpcId: "restart-" + randomUUID(), method: endpoint, payload: { args: argsObject } };
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const envelope = await response.json().catch(() => null);
  return { http: response.status, result: envelope && envelope.result };
};
const offersFor = async (targetSessionId) => {
  const inventory = await rpc("selfImproved/continuityStatus", { targetSessionId });
  const offers = inventory.result?.ok === true ? inventory.result.value?.offers : null;
  return Array.isArray(offers) ? offers : [];
};
/** Durable counters straight from the fixture store (no server involvement). */
const durable = () => {
  const db = new DatabaseSync(join(facts.home, "memory", "memory.db"));
  const one = (sql) => { try { return db.prepare(sql).get(); } catch { return {}; } };
  const result = {
    generations: one("SELECT session_id, generation, allowed FROM main.continuity_policy") ?? {},
    handoffs: one("SELECT COUNT(*) AS n FROM main.continuity_handoff").n ?? 0,
    jobs: one("SELECT COUNT(*) AS n FROM main.continuity_jobs").n ?? 0,
  };
  db.close();
  return result;
};

try {
  const index = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  const raw = index.headers.getSetCookie ? index.headers.getSetCookie() : [index.headers.get("set-cookie")];
  cookie = (raw.filter(Boolean)[0] || "").split(";")[0];
  check("operator cookie acquired from the running host", cookie.startsWith("dsh-auth-"), `HTTP ${index.status}`);

  if (phase === 1) {
    const source = await rpc("session/create", { request: { cwd: PROJECT } });
    const sourceId = source.result?.ok === true ? source.result.value?.sessionId : null;
    const target = await rpc("session/create", { request: { cwd: PROJECT } });
    const targetId = target.result?.ok === true ? target.result.value?.sessionId : null;
    check("phase1 created both sessions", typeof sourceId === "string" && typeof targetId === "string", JSON.stringify(target).slice(0, 200));
    const turn = await rpc("session/prompt", {
      request: { requestId: randomUUID(), sessionId: sourceId, mode: "queue",
        content: [{ type: "text", text: `Restart durability check: ${MARKER} is still open.` }] },
    });
    check("phase1 human turn accepted", turn.result?.ok === true, JSON.stringify(turn).slice(0, 200));

    let offer = null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      offer = (await offersFor(targetId)).find((item) => item.sessionId === sourceId) ?? null;
      if (offer) break;
      await wait(1000);
    }
    check("phase1 produced a real handoff for the source session", !!offer, "no offer appeared before the deadline");
    if (!offer) process.exit(1);
    const snapshot = durable();
    const policy = snapshot.generations;
    writeFileSync(statePath, JSON.stringify({ sourceId, targetId, jobId: offer.jobId, marker: MARKER, url: facts.url,
      generation: policy.generation, allowed: policy.allowed, handoffs: snapshot.handoffs, jobs: snapshot.jobs }, null, 2));
    check("phase1 recorded the durable anchors", typeof policy.generation === "number" && snapshot.handoffs >= 1, JSON.stringify(snapshot).slice(0, 200));
  } else {
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    check("the host was actually restarted", Number(facts.restarts ?? 0) >= 1, `restarts=${facts.restarts ?? 0}`);
    check("the restarted host is a NEW process with a new origin", facts.url !== state.url, `${state.url} -> ${facts.url}`);
    const before = durable();
    check("the durable handoff row survived the restart", before.handoffs >= state.handoffs && before.handoffs >= 1, JSON.stringify(before).slice(0, 200));
    check("the durable policy generation and consent survived the restart",
      before.generations.generation === state.generation && before.generations.allowed === state.allowed,
      `${JSON.stringify(before.generations)} vs recorded ${state.generation}/${state.allowed}`);

    const offers = await offersFor(state.targetId);
    const offer = offers.find((item) => item.sessionId === state.sourceId) ?? null;
    check("after the restart the same unfinished work is STILL offered", !!offer, JSON.stringify(offers).slice(0, 240));
    if (!offer) process.exit(1);
    const prepared = await rpc("selfImproved/prepareContinue", { targetSessionId: state.targetId, jobId: offer.jobId });
    const minted = prepared.result?.ok === true ? prepared.result.value?.token : null;
    const notes = minted
      ? await rpc("selfImproved/continueSession", { targetSessionId: state.targetId, jobId: offer.jobId, authorization: { token: minted } })
      : null;
    const text = notes?.result?.ok === true ? notes.result.value?.notes?.join("\n") ?? "" : "";
    check("the operator door still returns the same notes after the restart", text.includes(state.marker), text.slice(0, 200));
    const sent = await rpc("session/prompt", { request: { requestId: randomUUID(), sessionId: state.targetId, mode: "queue",
      content: [{ type: "text", text: `Continuity handoff (post-restart) from ${state.sourceId}:\n- ${text}` }] } });
    check("the restarted host still accepts the reviewed handoff", sent.result?.ok === true, JSON.stringify(sent).slice(0, 200));
  }
} catch (error) {
  failures++;
  console.log("FAIL restart phase threw :: " + String(error && error.message || error));
}

console.log(`restart phase ${phase}: ${passes} gates PASS, ${failures} FAIL (real gateway + real host restart against the same home)`);
process.exit(failures === 0 ? 0 : 1);
