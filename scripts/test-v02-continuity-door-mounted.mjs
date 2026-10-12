#!/usr/bin/env node
/**
 * scripts/test-v02-continuity-door-mounted.mjs — mounted acceptance for the
 * operator-door Continue lane, over the REAL gateway of an isolated instance.
 *
 * This drives the same HTTP surface the browser uses: `POST /api/<endpoint>`
 * with a `client-request` envelope. It does NOT need a browser, so it can run
 * where the Chrome tooling is unavailable; the interactive half (clicking the
 * button in a rendered page) remains a separate gate.
 *
 *   node scripts/test-v02-continuity-door-mounted.mjs --base http://127.0.0.1:PORT \
 *     [--token <index token>] [--cookie <dsh-auth-…=v1.…>]
 *
 * Bring an instance up first:
 *   node scripts/test-v02-mounted-ui.mjs up --fresh
 *
 * Every check is an assertion against the RUNNING host: served client bytes,
 * the door ops over the wire, one-shot/peer/args binding, and an explicit
 * disclosure of the runtime's actual loopback authorization state so the
 * record cannot drift into claiming a boundary this runtime does not have.
 */

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (flag("--base") ?? "").replace(/\/$/, "");
const token = flag("--token");
let cookie = flag("--cookie") ?? "";
if (!base) { console.error("usage: --base <url> [--token <index token>] [--cookie <dsh-auth-…>]"); process.exit(2); }

let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log("PASS " + name); }
  else { failures++; console.log("FAIL " + name + (detail ? " :: " + detail : "")); }
};

const rpc = async (endpoint, argsObject, opts = {}) => {
  const body = { type: "client-request", rpcId: "door-" + Math.random().toString(16).slice(2), method: endpoint, payload: { args: argsObject } };
  const headers = { "content-type": "application/json" };
  if (opts.cookie !== false && cookie) headers.cookie = cookie;
  const response = await fetch(`${base}/api/${endpoint}`, { method: "POST", headers, body: JSON.stringify(body) });
  const envelope = await response.json().catch(() => null);
  return { http: response.status, result: envelope && envelope.result };
};

// ── 1. Operator cookie from the launch token (what the browser does) ─────────
if (!cookie && token) {
  const index = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: "manual" });
  const raw = index.headers.getSetCookie ? index.headers.getSetCookie() : [index.headers.get("set-cookie")];
  cookie = (raw.filter(Boolean)[0] || "").split(";")[0];
  check("launch token exchanges for an operator cookie", index.status >= 200 && index.status < 400 && cookie.startsWith("dsh-auth-"), `HTTP ${index.status}`);
}

// ── 2. The isolated host serves THIS source (no stale bundle illusion) ───────
{
  const html = await fetch(`${base}/`, { headers: cookie ? { cookie } : {} }).then(r => r.text());
  const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(u => /client\.js/.test(u));
  let served = null;
  for (const u of urls) {
    const body = await fetch(new URL(u.replace(/&amp;/g, "&"), base).href, { headers: cookie ? { cookie } : {} }).then(r => r.text()).catch(() => "");
    if (body.includes("dsh-self-improved")) { served = body; break; }
  }
  check("served client bundle carries the operator-door Continue UI",
    !!served && served.includes("prepareContinue") && served.includes("Send these notes to this session"),
    served ? "bundle found without the door UI" : "plugin client bundle not found in the index");
}

// ── 3. The inventory is served, and it is the door-shaped read ───────────────
const inventory = await rpc("selfImproved/continuityStatus", { targetSessionId: "probe-session" });
check("mounted host answers continuityStatus with the door-shaped inventory",
  inventory.http === 200 && inventory.result?.ok === true && Array.isArray(inventory.result.value?.offers),
  JSON.stringify(inventory).slice(0, 200));

// ── 4. Door step 1: a real gateway caller mints a peer/args-bound confirm ────
const prepared = await rpc("selfImproved/prepareContinue", { targetSessionId: "probe-session", jobId: "job-1" });
const minted = prepared.result?.ok === true ? prepared.result.value : null;
check("prepareContinue mints a one-shot confirm for a gateway caller",
  !!minted && minted.op === "continue" && typeof minted.token === "string" && minted.token.length > 0 && minted.ttlMs > 0,
  JSON.stringify(prepared).slice(0, 200));

// ── 5. Door step 2: the confirm works once and never invents notes ───────────
if (minted) {
  const spent = await rpc("selfImproved/continueSession", { targetSessionId: "probe-session", jobId: "job-1", authorization: { token: minted.token } });
  check("continueSession spends the confirm and returns no invented notes",
    spent.result?.ok === true && spent.result.value === null, JSON.stringify(spent).slice(0, 200));
  const replay = await rpc("selfImproved/continueSession", { targetSessionId: "probe-session", jobId: "job-1", authorization: { token: minted.token } });
  check("a replayed confirm is refused", replay.result?.ok === false && /replayed|binding/.test(replay.result.error?.message ?? ""), JSON.stringify(replay).slice(0, 200));
}
{
  const again = await rpc("selfImproved/prepareContinue", { targetSessionId: "probe-session", jobId: "job-1" });
  const otherToken = again.result?.ok === true ? again.result.value.token : null;
  const crossed = otherToken
    ? await rpc("selfImproved/continueSession", { targetSessionId: "probe-session", jobId: "job-OTHER", authorization: { token: otherToken } })
    : null;
  check("a confirm minted for one offer cannot spend another",
    !!crossed && crossed.result?.ok === false, JSON.stringify(crossed).slice(0, 200));
}
{
  const missing = await rpc("selfImproved/continueSession", { targetSessionId: "probe-session", jobId: "job-1", authorization: { token: "" } });
  check("Continue without a confirm token is refused", missing.result?.ok === false && /one-shot token/.test(missing.result.error?.message ?? ""), JSON.stringify(missing).slice(0, 200));
  const malformed = await rpc("selfImproved/prepareContinue", { targetSessionId: "", jobId: "job-1" });
  check("Continue refuses an empty target identity", malformed.result?.ok === false && /target session identity/.test(malformed.result.error?.message ?? ""), JSON.stringify(malformed).slice(0, 200));
}

// ── 6. The Overview lane status rides the snapshot: facts + counts only ─────
{
  const snapshot = await rpc("selfImproved/snapshot", {});
  const lane = snapshot.result?.ok === true ? snapshot.result.value?.continuity : null;
  check("the Overview snapshot carries the continuity lane status",
    !!lane && typeof lane.structural === "string" && typeof lane.reason === "string"
      && typeof lane.pending === "number" && typeof lane.handoffs === "number",
    JSON.stringify(snapshot).slice(0, 260));
  const serialized = JSON.stringify(lane ?? {});
  check("the lane status carries no session or project identity",
    !!lane && !serialized.includes("session-") && !serialized.includes("pj-"), serialized.slice(0, 200));
}

// ── 6. Boundary disclosure (NOT a gate this plugin can pass) ────────────────
// The installed rc.2 runtime admits every loopback /api request as the single
// OperatorPeer (its browser-authentication call is patched off in this
// installation). Record what the running host actually does, so no report can
// quietly claim the door is an authentication boundary. Closing this needs a
// Host-side authenticated receipt, not plugin code.
{
  const anonymous = await rpc("selfImproved/continuityStatus", { targetSessionId: "probe-session" }, { cookie: false });
  const admitted = anonymous.result?.ok === true;
  console.log(`BOUNDARY: loopback request WITHOUT an operator cookie is ${admitted ? "ADMITTED as the operator peer (this runtime disables browser auth for loopback)" : "refused (browser auth is enforced here)"}`);
}

console.log(`${passes} mounted operator-door gates PASS, ${failures} FAIL (real gateway over HTTP; rendered-page interaction remains a separate gate)`);
process.exit(failures === 0 ? 0 : 1);
