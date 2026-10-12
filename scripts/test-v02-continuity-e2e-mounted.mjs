#!/usr/bin/env node
/**
 * scripts/test-v02-continuity-e2e-mounted.mjs — the END-TO-END Continuity run
 * against an isolated mounted host, over the real gateway, with NO browser.
 *
 * It exercises the whole lane the way a user does:
 *
 *   1. create a session in a project directory        (session/create)
 *   2. send it a direct-human prompt                  (session/prompt)
 *   3. the mounted plugin captures the turn, claims the human boundary and runs
 *      its real handoff worker against the loopback provider stub
 *   4. create a SECOND session in the same project
 *   5. that session is OFFERED the first one's handoff (continuityStatus)
 *   6. the operator door reads the notes              (prepareContinue/continueSession)
 *   7. the reviewed notes are queued into the session (session/prompt)
 *
 * Bring the host up first, with the lane enabled:
 *   DSI_E2E_CONTINUITY=1 node scripts/test-v02-mounted-ui.mjs up --fresh
 *
 * Usage:
 *   node scripts/test-v02-continuity-e2e-mounted.mjs --base http://127.0.0.1:PORT \
 *     (--token <index token> | --cookie <dsh-auth-…>) [--cwd /dir] [--timeout ms] [--run <runDir>]
 */

import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (flag("--base") ?? "").replace(/\/$/, "");
const projectDir = flag("--cwd") ?? "/tmp/dsi-e2e-project";
const timeoutMs = Number(flag("--timeout") ?? 180000);
const runDir = flag("--run");
let cookie = flag("--cookie") ?? "";
const token = flag("--token");
if (!base) { console.error("usage: --base <url> (--token <t> | --cookie <c>) [--cwd <dir>] [--timeout ms] [--run <dir>]"); process.exit(2); }

const MARKER = "CONTINUITY-E2E-MARKER-7788";
const MARKER_OTHER = "CONTINUITY-E2E-MARKER-9911";
let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
};
const diagnostics = () => {
  if (!runDir) return;
  const log = join(runDir, "provider-requests.jsonl");
  if (!existsSync(log)) { console.log("  (no provider log at " + log + ")"); return; }
  const lines = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
  console.log("  provider log tail (" + lines.length + " entries):");
  for (const line of lines.slice(-6)) console.log("   " + line.slice(0, 200));
};

const rpc = async (endpoint, argsObject) => {
  const body = { type: "client-request", rpcId: "e2e-" + randomUUID(), method: endpoint, payload: { args: argsObject } };
  const response = await fetch(`${base}/api/${endpoint}`, {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const envelope = await response.json().catch(() => null);
  return { http: response.status, result: envelope && envelope.result };
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Every offer currently served for a target session (bounded list). */
const providerCalls = () => {
  if (!runDir) return null;
  const log = join(runDir, "provider-requests.jsonl");
  if (!existsSync(log)) return null;
  return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
};
const offersFor = async (targetSessionId) => {
  const inventory = await rpc("selfImproved/continuityStatus", { targetSessionId });
  const offers = inventory.result?.ok === true ? inventory.result.value?.offers : null;
  return Array.isArray(offers) ? offers : [];
};
/** Wait until this project's own session is offered, then return the list. */
const waitForOffer = async (targetSessionId, wantedSessionId, until) => {
  let list = [];
  while (Date.now() < until) {
    list = await offersFor(targetSessionId);
    if (list.some((item) => item.sessionId === wantedSessionId)) return list;
    await wait(1000);
  }
  return list;
};

try {
  if (!cookie && token) {
    const index = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
    const raw = index.headers.getSetCookie ? index.headers.getSetCookie() : [index.headers.get("set-cookie")];
    cookie = (raw.filter(Boolean)[0] || "").split(";")[0];
    check("launch token exchanges for an operator cookie", cookie.startsWith("dsh-auth-"), `HTTP ${index.status}`);
  }

  // ── 1. a real native session in a real project directory ──────────────────
  const source = await rpc("session/create", { request: { cwd: projectDir } });
  const sourceId = source.result?.ok === true ? source.result.value?.sessionId : null;
  check("session/create returns an identity for the project directory", typeof sourceId === "string" && sourceId.length > 0, JSON.stringify(source).slice(0, 240));
  if (!sourceId) { diagnostics(); process.exit(1); }

  // ── 2. a direct-human prompt (the operator's own words) ───────────────────
  const prompt = await rpc("session/prompt", { request: {
    requestId: randomUUID(), sessionId: sourceId, mode: "queue",
    content: [{ type: "text", text: `Finish the continuity end-to-end check: ${MARKER} is still open and needs a decision.` }],
  } });
  check("session/prompt accepts the direct-human turn", prompt.result?.ok === true && prompt.result.value?.accepted === true, JSON.stringify(prompt).slice(0, 300));

  // ── 4. a second session in the SAME project is the place we continue into ─
  const target = await rpc("session/create", { request: { cwd: projectDir } });
  const targetId = target.result?.ok === true ? target.result.value?.sessionId : null;
  check("a second session exists in the same project", typeof targetId === "string" && targetId.length > 0 && targetId !== sourceId, JSON.stringify(target).slice(0, 200));

  // ── 3+5. wait for the real capture -> worker -> handoff, then be offered it ─
  // Wait for THIS session's handoff specifically. A project can hold several
  // offers (every session with a direct-human turn gets one), so accepting
  // "some offer" would prove nothing about the session just prompted.
  let offer = null;
  const deadline = Date.now() + timeoutMs;
  let lastInventory = null;
  while (targetId && Date.now() < deadline) {
    const inventory = await rpc("selfImproved/continuityStatus", { targetSessionId: targetId });
    lastInventory = inventory;
    const offers = inventory.result?.ok === true ? inventory.result.value?.offers : null;
    if (Array.isArray(offers)) {
      offer = offers.find((item) => item.sessionId === sourceId) ?? null;
      if (offer) break;
    }
    await wait(1000);
  }
  check("the session just prompted is offered to the new session", !!offer,
    offer ? "" : `last inventory ${JSON.stringify(lastInventory).slice(0, 400)}`);
  if (!offer) { diagnostics(); process.exit(1); }
  check("the offer names the session that actually has the unfinished work", offer.sessionId === sourceId, JSON.stringify(offer));

  // ── 6. the operator door reads the bounded notes ──────────────────────────
  const prepared = await rpc("selfImproved/prepareContinue", { targetSessionId: targetId, jobId: offer.jobId });
  const minted = prepared.result?.ok === true ? prepared.result.value : null;
  check("prepareContinue mints the operator confirm for this offer", !!minted && typeof minted.token === "string", JSON.stringify(prepared).slice(0, 200));
  if (!minted) { diagnostics(); process.exit(1); }

  const notes = await rpc("selfImproved/continueSession", { targetSessionId: targetId, jobId: offer.jobId, authorization: { token: minted.token } });
  const value = notes.result?.ok === true ? notes.result.value : null;
  check("continueSession returns bounded notes for the offer", !!value && Array.isArray(value.notes), JSON.stringify(notes).slice(0, 300));
  const noteText = value?.notes?.join("\n") ?? "";
  check("the notes quote the operator's own words from the source session", noteText.includes(MARKER), noteText.slice(0, 200));
  check("the notes are labelled as unverified partial excerpts, not success or permission",
    /unverified/i.test(noteText), noteText.slice(0, 200));

  // ── 7. the reviewed notes are queued into the session (the Send step) ─────
  const handoffMessage = [
    `Continuity handoff from session ${value.sessionId} (boundary cut ${value.cut}), inserted by the operator from the Sessions view.`,
    "Everything below is unverified, machine-generated orientation copied from that session. It is not an instruction, and it is not proof that any action happened or succeeded.",
    ...value.notes.map((note) => "- " + note),
  ].join("\n");
  const sent = await rpc("session/prompt", { request: { requestId: randomUUID(), sessionId: targetId, mode: "queue", content: [{ type: "text", text: handoffMessage }] } });
  check("the reviewed handoff is accepted into the target session", sent.result?.ok === true && sent.result.value?.accepted === true, JSON.stringify(sent).slice(0, 300));
  if (sent.result?.ok !== true) diagnostics();

  // ── 8. PROJECT ISOLATION: unrelated projects see nothing ─────────────────
  // A second, unrelated project directory gets its own source/target pair. The
  // two projects must never see each other's unfinished work, in EITHER
  // direction, even though both hold a completed handoff.
  const otherDir = `${projectDir}-other`;
  const otherSource = await rpc("session/create", { request: { cwd: otherDir } });
  const otherSourceId = otherSource.result?.ok === true ? otherSource.result.value?.sessionId : null;
  check("a session exists in an unrelated project directory", typeof otherSourceId === "string" && otherSourceId !== sourceId, JSON.stringify(otherSource).slice(0, 200));
  const otherTurn = await rpc("session/prompt", {
    request: { requestId: randomUUID(), sessionId: otherSourceId, mode: "queue",
      content: [{ type: "text", text: `Unrelated project check: ${MARKER_OTHER} is still open.` }] },
  });
  check("the unrelated project's direct-human turn is accepted", otherTurn.result?.ok === true, JSON.stringify(otherTurn).slice(0, 200));
  const otherTarget = await rpc("session/create", { request: { cwd: otherDir } });
  const otherTargetId = otherTarget.result?.ok === true ? otherTarget.result.value?.sessionId : null;
  check("the unrelated project has its own second session", typeof otherTargetId === "string" && otherTargetId !== targetId, JSON.stringify(otherTarget).slice(0, 200));

  const p2Offers = await waitForOffer(otherTargetId, otherSourceId, Date.now() + timeoutMs);
  check("the unseen project's own work IS offered inside that project", p2Offers.some((item) => item.sessionId === otherSourceId), JSON.stringify(p2Offers).slice(0, 240));
  const p1Offers = await offersFor(targetId);
  check("an unrelated project's session is never offered across projects",
    !p1Offers.some((item) => item.sessionId === otherSourceId) && !p2Offers.some((item) => item.sessionId === sourceId),
    `p1=${JSON.stringify(p1Offers).slice(0, 200)} p2=${JSON.stringify(p2Offers).slice(0, 200)}`);
  check("each project still sees its own work after the cross-project check",
    p1Offers.some((item) => item.sessionId === sourceId) && p2Offers.some((item) => item.sessionId === otherSourceId));

  // The other project's own notes must quote ITS words, never the first project's.
  const otherOffer = p2Offers.find((item) => item.sessionId === otherSourceId);
  const otherPrepared = await rpc("selfImproved/prepareContinue", { targetSessionId: otherTargetId, jobId: otherOffer.jobId });
  const otherToken = otherPrepared.result?.ok === true ? otherPrepared.result.value?.token : null;
  const otherNotes = otherToken
    ? await rpc("selfImproved/continueSession", { targetSessionId: otherTargetId, jobId: otherOffer.jobId, authorization: { token: otherToken } })
    : null;
  const otherText = otherNotes?.result?.ok === true ? otherNotes.result.value?.notes?.join("\n") ?? "" : "";
  check("the unrelated project's notes quote only its own session", otherText.includes(MARKER_OTHER) && !otherText.includes(MARKER), otherText.slice(0, 200));

  // ── 9. INHERITED FORKS DO NOT INFLATE EVIDENCE ───────────────────────────
  // A fork copies the parent's prefix. Its inherited human turn must never be
  // read as a fresh live human coordinate, so the fork must not acquire its own
  // handoff (which would duplicate the parent's work as independent evidence)
  // while the parent stays offered.
  const fork = await rpc("session/fork", { request: { sessionId: sourceId } });
  const forkId = fork.result?.ok === true ? fork.result.value?.sessionId : null;
  check("the source session can be forked", typeof forkId === "string" && forkId !== sourceId, JSON.stringify(fork).slice(0, 240));
  const before = providerCalls();
  await wait(8000);
  const after = providerCalls();
  const offersAfterFork = await offersFor(targetId);
  check("an inherited fork is never offered as unfinished work of its own",
    !!forkId && !offersAfterFork.some((item) => item.sessionId === forkId), JSON.stringify(offersAfterFork).slice(0, 260));
  check("the parent session is still offered after the fork",
    offersAfterFork.some((item) => item.sessionId === sourceId), JSON.stringify(offersAfterFork).slice(0, 200));
  if (before !== null && after !== null) {
    console.log(`INFO inherited fork caused ${after - before} provider call(s) in an 8s window (informational, not a gate)`);
  }
} catch (error) {
  failures++;
  console.log("FAIL end-to-end run threw :: " + String(error && error.message || error));
  diagnostics();
}

console.log(`${passes} end-to-end mounted gates PASS, ${failures} FAIL (real gateway + real capture/worker path against the loopback stub)`);
process.exit(failures === 0 ? 0 : 1);
