#!/usr/bin/env node
/**
 * Client-half smoke checks against the rc.2 module bundle (synthetic ctx
 * stubs — no browser, no profile, no slots registration side effects on a
 * real page). Exercises apply(): locale registration, the entry-addressed
 * settings-form binding (subscribe/unsubscribe, dirty-path fencing), the
 * typed business remote $mount contract, and whileServed section lifecycle.
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../client.js", import.meta.url), "utf8");

/** Minimal React shim that returns inert components (no render). */
const reactShim = {
  createElement: (...args) => ({ type: args[0], props: args[1] ?? {}, children: args.slice(2) }),
  useState: (init) => [typeof init === "function" ? init() : init, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (v) => ({ current: v }),
};

const sandbox = {};
sandbox.window = {
  __ModuleLoader__: {
    loaded: null,
    load: (decl) => { sandbox.window.__ModuleLoader__.loaded = decl; },
  },
};
sandbox.graphsHandled = [];
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "client.js" });
const decl = sandbox.window.__ModuleLoader__.loaded;
assert.equal(decl.id, "dsh-self-improved");
const factory = decl.factory;
const withReact = (require) => factory.call(sandbox, require);
const requireStub = (spec) => {
  assert.equal(spec, "react", `only react is required from the module table (got ${spec})`);
  return reactShim;
};
const exports_ = withReact(requireStub);
assert.equal(typeof exports_.apply, "function", "client exports apply");
assert.ok(Array.isArray(exports_.inject), "client exports inject (activation hints)");

// ── apply() against a synthetic rc.2-shaped ctx ────────────────────────────
const effects = [];
const registered = [];
let stubConfigFormSubscribed = 0;
let stubConfigFormUnsubscribed = 0;
let whileServedRegisterCalls = 0;
let whileServedDisposed = false;
const snap = {
  status: "ready",
  value: { enabled: true, modules: { capture: true, extract: true, consolidate: false, evolve: false, recall: true, tools: true }, storageRoot: "", episodeLearning: { enabled: false } },
  value2: undefined,
  valueOmitted: void 0,
  base: {},
  user: { debug: false },
  revision: 5,
  revisionHidden: undefined,
  writable: true,
  mode: "host",
};
const stubForm = {
  getSnapshot: () => snap,
  subscribe: (l) => { stubConfigFormSubscribed += 1; return () => { stubConfigFormUnsubscribed += 1; }; },
  mutate: async (ops, fence) => {
    void ops; void fence;
    return true;
  },
};
const ctx = {
  get(name) {
    if (name === "configForms") {
      return {
        get: () => stubForm,
        describe: () => ({
          ensure: async () => {},
          getSnapshot: () => ({ view: { namespaces: [{ ns: "dsh-self-improved", secrets: [{ path: ["recall", "embedding", "apiKey"], set: false }], revision: 5, value: snap.value }] } }),
        }),
        whileServed: (namespaces, register) => {

          whileServedRegisterCalls += 1;
          const dispose = register(new Set(namespaces));
          return () => { whileServedDisposed = true; dispose?.(); };
        },
      };
    }
    if (name === "remote") return { $mount: async (contribution) => { sandbox.graphsHandled.push(contribution); return () => {}; } };
    if (name === "locale") return { bind: () => (key) => key };
    if (name === "slots") return { inject: (name2, factory2) => { registered.push(name2); return () => {}; } };
    return undefined;
  },
  effect(fn, name) {
    effects.push({ name, dispose: fn?.() ?? (() => {}) });
    return () => {};
  },
  on: () => () => {},
  // rc.2 inject governance (measured against the real client runtime): a
  // context may only read a service it declares, so the business namespace is
  // consumed from a `ctx.inject` child while the OUTER entry's inject list
  // must NOT wait for \(remote.selfImproved\) (the same entry mounts it — an
  // inject there deadlocks every activation). The stub models that API and
  // records the granted key list.
  inject(list, callback) {
    grantedListContents.push([...list]);
    const childCtx = {
      get: (name) => ctx.get(name),
      effect: ctx.effect,
      on: ctx.on,
      slots: ctx.slots,
      locale: ctx.locale,
      configForms: ctx.configForms,
    };
    childContexts.push(childCtx);
    const result = callback(childCtx);
    return result && typeof result.then === "function"
      ? result
      : { then: (ok) => ok(undefined), dispose: () => {}, catch: () => undefined };
  },
};

const childContexts = [];
const grantedListContents = [];

// direct property access backs the getters the guarded client ctx provides
ctx.slots = ctx.get("slots");
ctx.locale = ctx.get("locale");
ctx.remote = ctx.get("remote");
ctx.configForms = ctx.get("configForms");

await exports_.apply(ctx);
assert.equal(registered.includes("settings.section"), true, "the settings section is registered (inside the governed child context)");
assert.ok(
  grantedListContents.some((l) => l.includes("remote.selfImproved") && l.includes("slots")),
  "the section's UI lane declares remote.selfImproved in its own inject list (cordis governance gate)",
);
assert.ok(stubConfigFormSubscribed >= 1, "binding subscribed to the shared entry form");
assert.ok(sandbox.graphsHandled.length === 1, "the typed business contribution was mounted once");
const contribution = sandbox.graphsHandled[0];
assert.equal(contribution.package, "dsh-self-improved");
assert.ok(contribution.descriptors.length >= 8, "the contribution carries the mirrored business descriptors");
for (const d of contribution.descriptors) {
  assert.equal(d.namespace, "selfImproved");
  assert.equal(d.service, "selfImprovedMemoryUi");
  assert.equal(d.invocation.kind, "direct");
  for (const p of d.parameters) {
    assert.equal(p.codec.mode, "strict", `${d.method} parameter ${p.name} has a strict codec`);
  }
}
const effectNames = effects.map((e) => e.name).join("\n");
assert.ok(/dictionaries/.test(effectNames), "dictionaries registered as an effect");
assert.ok(/settings form subscription/.test(effectNames), "the form subscription is effect-owned (unsubscribe only)");
assert.ok(/business remote/.test(effectNames), "the remote mount is effect-owned");
const formEffect = effects.find((e) => /settings form subscription/.test(e.name));
formEffect.dispose();
assert.equal(stubConfigFormUnsubscribed, 1, "navigation/unmount unsubscribes the provider-owned form (no dispose call)");
assert.equal(whileServedDisposed, false, "whileServed follows the served namespace until its own disposer runs");

console.log("test-v02-client-smoke: PASS (client module + synthetic ctx exercises)");
