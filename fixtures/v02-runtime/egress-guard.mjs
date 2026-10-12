/**
 * fixtures/v02-runtime/egress-guard.mjs — fixture ONLY egress deny layer for the
 * isolated rc.2 runtime children launched by scripts/test-v02-runtime.mjs.
 *
 * Loaded through NODE_OPTIONS="--import <this file>" into the runtime child, it
 * block ALL network destinations except loopback (127.0.0.0/8, ::1, localhost)
 * and records every blocked attempt plus every (allowed) loopback connect into
 * the JSONL log at $DSH_FIXTURE_EGRESS_LOG. Guard fails closed: without an
 * explicit log path it refuses to boot.
 *
 * Layers (verified empirically on node v24.13.1 against the rc.2 runtime):
 *   - node:dns          (lookup / promises.lookup / Resolver.resolve*) — a
 *     non-loopback *hostname* can never resolve, and can never trigger a
 *     resolver query against a configured nameserver.
 *   - node:net          (Socket.prototype.connect + the connect/createConnection
 *     surface) — non-loopback *IP literals* die before any socket exists.
 *   - node:dgram        (connect/send).
 *   - node:http/node:https (request/get surface).
 *   - globalThis.fetch  (the runtime's DeepSeek Messages adapter calls global
 *     fetch; URL host is checked before the request is built).
 *
 * The patching surface is the CommonJS "node:<builtin>" module object (checked
 * against node v24.13.1: writes to the ESM import namespace of a builtin are
 * silently ignored, but writes on the CJS module object made BEFORE the
 * application imports the builtin are visible to the app's later ESM imports).
 * The runtime may reach network facilities through bundled internal code paths
 * that this surface cannot see; such attempts are covered by the dns/net layers
 * above, but a residual native or subprocess bypass (e.g. a child process that
 * drops NODE_OPTIONS) is out of scope for this layer and is recorded as a
 * documented limitation — not as a claim of OS-enforced denial.
 */

import fs from "node:fs";
import { isIP } from "node:net";
import { createRequire } from "node:module";

const logPath = process.env.DSH_FIXTURE_EGRESS_LOG ?? "";
if (!logPath) throw new Error("egress-guard: refusing to boot without DSH_FIXTURE_EGRESS_LOG");
const OPEN = typeof createRequire === "function";
const requireBuiltin = OPEN ? createRequire(import.meta.url) : null;

/** One JSONL line per entry; a broken log sink must not silently disable the guard. */
function write(entry) {
  try {
    fs.appendFileSync(logPath, JSON.stringify({ ts: Date.now(), pid: process.pid, guardVersion: "v02-runtime/1", ...entry }) + "\n");
  } catch (error) {
    console.error("[egress-guard] failed to write log:", error?.message);
  }
}
const rec = (kind, target, extra = {}) => write({ kind, target: String(target ?? ""), ...(inSelftest ? { selftest: true } : {}), ...extra });

let inSelftest = false;

function isLoopbackIP(ip) {
  if (isIP(ip) === 4 || isIP(ip) === 6) return ip === "::1" || /^127\./.test(ip);
  return false;
}
/** hostname/Host may carry brackets for v6 literals ("[::1]"). */
export function hostAllowed(host) {
  if (host === undefined || host === null || host === "") return true; // unix socket / path connect
  const h = String(host).replace(/^\[|\]$/g, "").trim();
  if (h.length === 0) return true;
  if (h.toLowerCase() === "localhost") return true;
  return isLoopbackIP(h);
}

class EgressError extends Error {
  constructor(target) {
    super(`egress-guard: non-loopback destination blocked on this child: ${target}`);
    this.name = "EgressError";
    this.code = "EGRESS_BLOCKED";
  }
}

// --------------------------------------------------------------------------
// node:dns — hostnames that are not loopback never resolve and never query a
// nameserver (the DNS query itself would be the external hop).
// --------------------------------------------------------------------------
{
  const bound = requireBuiltin("node:dns");
  const lookupOrig = bound.lookup;
  if (typeof lookupOrig !== "function") throw new Error("egress-guard: dns.lookup missing");
  bound.lookup = function (host, options, callback) {
    if (typeof options === "function") { callback = options; options = undefined; }
    if (!hostAllowed(host)) {
      rec("dns.lookup.blocked", host);
      if (typeof callback === "function") { process.nextTick(callback, new EgressError(host)); return; }
      return Promise.reject(new EgressError(host));
    }
    return lookupOrig.call(bound, host, options, callback);
  };
  const promisify = bound.promises;
  const lookupPromOrig = promisify.lookup;
  promisify.lookup = async function (host, options) {
    if (!hostAllowed(host)) { rec("dns.promises.lookup.blocked", host); throw new EgressError(host); }
    return lookupPromOrig.call(promisify, host, options);
  };
  for (const proto of [bound.Resolver?.prototype, promisify.Resolver?.prototype]) {
    if (!proto) continue;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (!name.startsWith("resolve") || !/^resolve/.test(name)) continue;
      const orig = proto[name];
      if (typeof orig !== "function") continue;
      try {
        proto[name] = function (hostname, ...rest) {
          if (!hostAllowed(hostname)) { rec(`dns.${name}.blocked`, hostname); throw new EgressError(hostname); }
          return orig.apply(this, [hostname, ...rest]);
        };
      } catch (error) {
        rec("patch.failed", `dns.Resolver.${name}`, { error: String(error?.message) });
      }
    }
  }
}

// --------------------------------------------------------------------------
// node:net — IP-literal destinations die before a socket FD can exist.
// --------------------------------------------------------------------------
{
  const bound = requireBuiltin("node:net");
  const sockConnect = bound.Socket.prototype.connect;
  bound.Socket.prototype.connect = function (...args) {
    const opts = args[0] !== null && typeof args[0] === "object" ? args[0] : null;
    let host;
    if (opts) host = opts.host ?? opts.hostname ?? (opts.path !== undefined ? "" : undefined);
    else if (typeof args[1] === "string" || args[1] === null) host = args[1];
    else if (typeof args[1] === "number") host = ""; // (port, callback)
    else if (typeof args[1] === "object" && args[1] !== null) host = args[1].host ?? args[1].hostname;
    if (host === undefined) {
      // net.connect(port, cb) without host connects locally on IPv6-capable hosts via "localhost" machinery — same loopback rule applies
      host = "";
    }
    if (!hostAllowed(host)) {
      const port = opts?.port ?? (this?.remotePort !== undefined ? this.remotePort : "");
      rec("net.connect.blocked", `${host}: ${port}`.replace(": ", ":"), { port: port === "" ? undefined : port });
      throw new EgressError(host);
    }
    rec("net.connect.allowed", `${host || "unix/other"}:${opts?.port ?? args[0] ?? ""}`);
    return sockConnect.apply(this, args);
  };
  for (const name of ["connect", "createConnection"]) {
    const orig = bound[name];
    if (typeof orig !== "function") continue;
    bound[name] = function (...args) {
      const opts = args[0] !== null && typeof args[0] === "object" ? args[0] : null;
      const host = opts ? (opts.host ?? opts.hostname ?? (opts.path !== undefined ? "" : "")) : "";
      if (!hostAllowed(host)) { rec(`net.${name}.blocked`, String(host)); throw new EgressError(host); }
      return orig.apply(this, args);
    };
  }
}

// --------------------------------------------------------------------------
// node:dgram (UDP send/connect surface)
// --------------------------------------------------------------------------
{
  const bound = requireBuiltin("node:dgram");
  for (const name of ["connect", "send"]) {
    const proto = bound.Socket.prototype;
    const orig = proto[name];
    if (typeof orig !== "function") continue;
    proto[name] = function (...args) {
      let host = null;
      let port = "";
      if (name === "connect") { host = args[0] != null ? String(args[0]) : null; port = args[1] ?? ""; }
      else if (args.length >= 2 && (typeof args[args.length - 1] === "number" || typeof args[args.length - 1] === "object")) {
        host = String(args[args.length - 2] ?? "");
        port = args[args.length - 1] === undefined ? "" : (typeof args[args.length - 1] === "object" ? args[args.length - 1]?.port : args[args.length - 1]);
      }
      if (host !== null && !hostAllowed(host)) { rec(`dgram.${name}.blocked`, `${host}:${port}`); throw new EgressError(host); }
      return orig.apply(this, args);
    };
  }
}

// --------------------------------------------------------------------------
// node:http / node:https request surface
// --------------------------------------------------------------------------
for (const modName of ["node:http", "node:https"]) {
  const bound = requireBuiltin(modName);
  const label = modName.replace("node:", "");
  try {
    const origRequest = bound.request;
    const wrappedRequest = function (...args) {
      const first = args[0];
      const url = typeof first === "string" || first instanceof URL ? new URL(String(first)) : null;
      const host = url ? url.hostname : first?.hostname ?? first?.host;
      if (!hostAllowed(host)) { rec(`${label}.request.blocked`, String(host ?? "unknown")); throw new EgressError(host); }
      return origRequest.apply(this, args);
    };
    bound.request = wrappedRequest;
    bound.get = wrappedRequest;
  } catch (error) {
    rec("patch.failed", `${label}.request`, { error: String(error?.message) });
  }
}

// --------------------------------------------------------------------------
// globalThis.fetch — the runtime LLM adapter's documented transport.
// --------------------------------------------------------------------------
{
  const origFetch = globalThis.fetch;
  if (typeof origFetch !== "function") throw new Error("egress-guard: globalThis.fetch missing");
  globalThis.fetch = function (input, init) {
    let host = null;
    let target = "";
    try {
      const raw = typeof input === "string" || input instanceof URL ? String(input) : input?.url;
      if (raw !== undefined) {
        const url = new URL(raw);
        host = url.hostname;
        target = url.toString();
      }
    } catch {
      rec("fetch.parse-failed", String(raw));
      throw new Error(`egress-guard: unresolvable fetch target "${String(raw)}" is not allowed`);
    }
    if (host !== null && !hostAllowed(host)) {
      rec("fetch.blocked", target);
      return Promise.reject(new EgressError(target));
    }
    return origFetch(input, init);
  };
}

// --------------------------------------------------------------------------
// Self-test: proves the layers are actually armed before the runtime boots.
// Every selftest record is tagged selftest:true and excluded from the
// parent's "violations" assertions; the parent asserts every selftest
// `ok:true` instead.
// --------------------------------------------------------------------------
async function selftest() {
  inSelftest = true;
  rec("selftest", "dns.lookup(localhost) allowed path", { selftest: true, started: true });
  {
    const out = {};
    try {
      await new Promise((resolve) => {
        requireBuiltin("node:dns").lookup("localhost", {}, (err, addr) => { out.err = err?.code ?? null; out.addr = addr; resolve(); });
      });
      rec("selftest", "dns.lookup(localhost) resolves", { selftest: true, ok: out.err === null && typeof out.addr === "string" && out.addr.length > 0, result: `${out.addr}` });
    } catch (error) {
      rec("selftest", "dns.lookup(localhost) resolves", { selftest: true, ok: false, error: String(error?.message) });
    }
  }
  {
    // Denied path: a non-loopback HOSTNAME must fail without touching a resolver.
    let deniedClean = false;
    try {
      await new Promise((resolve) => {
        requireBuiltin("node:dns").lookup("egress-probe-external.test.invalid", {}, (err) => { deniedClean = err?.code === "EGRESS_BLOCKED"; resolve(); });
      });
    } catch { deniedClean = false; }
    rec("selftest", "dns.lookup denies external hostname", { selftest: true, ok: deniedClean });
  }
  {
    // Denied path: a non-loopback IP literal must fail before any socket exists.
    let deniedClean = false;
    try {
      await new Promise((resolve) => {
        let socket = null;
        try {
          socket = requireBuiltin("node:net").connect({ host: "198.51.100.7", port: 9, timeoutMs: 300 } , () => {});
          socket.once("error", () => resolve());
          socket.once("close", () => resolve());
        } catch { deniedClean = true; resolve(); }
      });
    } catch { deniedClean = true; }
    rec("selftest", "net.connect denies external IP literal", { selftest: true, ok: deniedClean });
  }
  {
    let deniedClean = false;
    try {
      await fetch("http://198.51.100.7:9/egress-selftest").then(() => { deniedClean = false; }, () => { deniedClean = true; });
    } catch { deniedClean = true; }
    rec("selftest", "globalThis.fetch denies external URL", { selftest: true, ok: deniedClean });
  }
  {
    let deniedClean = false;
    try {
      await new Promise((resolve, reject) => {
        try { requireBuiltin("node:https").request({ host: "203.0.113.77", port: 443, path: "/egress-selftest" }, () => {}); resolve(); }
        catch (error) { deniedClean = true; reject(error); }
      }).catch(() => {});
    } catch { deniedClean = true; }
    rec("selftest", "node:https.request denies external IP literal", { selftest: true, ok: deniedClean });
  }
  rec("selftest", "complete", { selftest: true, complete: true });
  inSelftest = false;
}

write({ kind: "guard.ready", layers: ["dns", "net", "dgram", "http", "https", "fetch"] });
await selftest();
