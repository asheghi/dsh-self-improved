import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
let current;
const equalDeps = (a, b) => a && b && a.length === b.length && a.every((value, i) => value === b[i]);
const react = {
  createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) }; },
  useState(initial) { const harness = current, index = harness.index++; if (!harness.slots[index]) harness.slots[index] = { value: typeof initial === 'function' ? initial() : initial };
    return [harness.slots[index].value, value => { assert.equal(harness.alive, true, 'no state write after unmount'); harness.writes++; harness.slots[index].value = typeof value === 'function' ? value(harness.slots[index].value) : value; }]; },
  useRef(initial) { const index = current.index++; if (!current.slots[index]) current.slots[index] = { current: initial }; return current.slots[index]; },
  useCallback(fn, deps) { const index = current.index++; const old = current.slots[index]; if (old && equalDeps(old.deps, deps)) return old.fn; current.slots[index] = { fn, deps }; return fn; },
  useEffect(fn, deps) { const harness = current, index = harness.index++, old = harness.slots[index]; if (old && equalDeps(old.deps, deps)) return;
    harness.pending.push(() => { old?.cleanup?.(); harness.slots[index] = { deps, cleanup: fn() }; }); },
};
function harness(component, props) { return { slots: [], alive: true, index: 0, writes: 0, pending: [],
  render() { current = this; this.index = 0; const tree = component(props); current = null; for (const effect of this.pending.splice(0)) effect(); return tree; },
  unmount() { for (const slot of this.slots) slot?.cleanup?.(); this.alive = false; },
}; }
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
assert.equal(source.split('exports.apply = apply;').length, 2);
const sandbox = { AbortController, window: { __ModuleLoader__: { load: value => { sandbox.declaration = value; } } } };
vm.createContext(sandbox);
// Test-only access to actual private components/hooks. The shipped client is unchanged by this instrumentation.
vm.runInContext(source.replace('exports.apply = apply;', 'exports.__test = {MainSection, OverviewSection, SessionsSection, mountBusinessRemote, businessApi}; exports.apply = apply;'), sandbox);
const sut = sandbox.declaration.factory(name => { assert.equal(name, 'react'); return react; }).__test;
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(walk)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' ? (node.children || []).map(text).join(' ') : '';
const nodes = (tree, predicate) => walk(tree).filter(predicate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log('PASS ' + name); }
const props = api => ({ api, t: key => key });
await check('real generated descriptor, cancellation parameter and namespace identity are retained', async () => {
  let descriptors; const remote = { $mount: async spec => { descriptors = spec.descriptors; return () => {}; } };
  const mounting = sut.mountBusinessRemote({ get: () => remote }); assert.equal(await mounting.settled, true);
  const descriptor = descriptors.find(row => row.method === 'continuityStatus'); assert.ok(descriptor); assert.equal(descriptor.parameters[0].name, 'targetSessionId'); assert.equal(descriptor.cancellation.parameter, 'signal');
  const namespace = Object.create({ snapshot() {} }); assert.equal(sut.businessApi({ get: () => namespace }), namespace); await mounting.dispose();
});
await check('actual four-tab state, panel IDs, roving focus and keyboard navigation', async () => {
  const h = harness(sut.MainSection, props({})); let tree = h.render(); const tabs = nodes(tree, n => n.props.role === 'tab'); assert.equal(tabs.length, 4);
  assert.equal(tabs.filter(n => n.props.tabIndex === 0).length, 1); const panel = nodes(tree, n => n.props.role === 'tabpanel')[0]; assert.equal(panel.props.id, tabs[0].props['aria-controls']);
  tabs[1].props.onClick(); tree = h.render(); assert.equal(nodes(tree, n => n.props.role === 'tab')[1].props['aria-selected'], true);
  let focused = -1, prevented = false; const bar = nodes(tree, n => n.props.role === 'tablist')[0];
  bar.props.onKeyDown({ key: 'End', preventDefault() { prevented = true; }, currentTarget: { querySelectorAll: () => tabs.map((_, i) => ({ focus() { focused = i; } })) } });
  assert.equal(focused, 3); assert.equal(prevented, true); tree = h.render(); assert.equal(nodes(tree, n => n.props.role === 'tab')[3].props['aria-selected'], true); h.unmount();
});
await check('Overview actually calls authorized snapshot and renders bounded counts', async () => {
  let calls = 0; const h = harness(sut.OverviewSection, props({ snapshot: async signal => { calls++; assert.ok(signal instanceof AbortSignal); return { ok: true, value: { memories: [{}, {}], pending: 3, episodes: { counts: { reviewed: 4 } }, skills: [{}] } }; } }));
  h.render(); await flush(); const tree = h.render(); assert.equal(calls, 1); assert.match(text(tree), /bounded/); assert.deepEqual(nodes(tree, n => n.type === 'dd').map(text), ['2', '3', '4', '1']); h.unmount();
});
await check('Sessions sends exact selected identity with signal, renders rows and never enables Continue', async () => {
  const calls = []; const h = harness(sut.SessionsSection, props({ continuityStatus: async (id, signal) => { calls.push({ id, signal }); return { ok: true, value: { availability: 'ready', canContinue: false, reason: 'Authenticated ingress absent.', rows: [{ id: 'job', sessionId: 'source-id', cut: 8, status: 'running', attempts: 1 }] } }; } }));
  let tree = h.render(); nodes(tree, n => n.type === 'input')[0].props.onChange({ target: { value: 'native-target' } }); tree = h.render();
  nodes(tree, n => n.type === 'button' && text(n) === 'browserRefresh')[0].props.onClick(); await flush(); tree = h.render();
  assert.equal(calls[0].id, 'native-target'); assert.ok(calls[0].signal instanceof AbortSignal); assert.match(text(tree), /source-id/); assert.match(text(tree), /running/);
  assert.equal(nodes(tree, n => n.type === 'button' && text(n).startsWith('Continue'))[0].props.disabled, true); h.unmount();
});
await check('superseded and unmounted reads abort and cannot admit late result or error', async () => {
  const pending = []; const h = harness(sut.SessionsSection, props({ continuityStatus: (id, signal) => { const d = deferred(); pending.push({ ...d, id, signal }); return d.promise; } }));
  let tree = h.render(); nodes(tree, n => n.type === 'input')[0].props.onChange({ target: { value: 'first' } }); tree = h.render(); nodes(tree, n => n.type === 'button' && text(n) === 'browserRefresh')[0].props.onClick(); await flush();
  tree = h.render(); nodes(tree, n => n.type === 'input')[0].props.onChange({ target: { value: 'second' } }); assert.equal(pending[0].signal.aborted, true);
  tree = h.render(); nodes(tree, n => n.type === 'button' && text(n) === 'browserRefresh')[0].props.onClick(); await flush();
  pending[0].resolve({ ok: true, value: { reason: 'STALE-RESULT', rows: [] } }); await flush(); assert.doesNotMatch(text(h.render()), /STALE-RESULT/);
  h.unmount(); const writes = h.writes; assert.equal(pending[1].signal.aborted, true); pending[1].resolve({ ok: false, error: { message: 'late failure' } }); await flush(); assert.equal(h.writes, writes);
});
await check('remote errors, unavailable capability and genuinely empty inventory are explicit', async () => {
  for (const value of [{ ok: false, error: { message: 'observable error' } }, { ok: true, value: { availability: 'ready', reason: 'No dispatch capability', rows: [], canContinue: false } }]) {
    const h = harness(sut.SessionsSection, props({ continuityStatus: async () => value })); let tree = h.render(); nodes(tree, n => n.type === 'input')[0].props.onChange({ target: { value: 'target' } }); tree = h.render(); nodes(tree, n => n.type === 'button' && text(n) === 'browserRefresh')[0].props.onClick(); await flush(); tree = h.render();
    if (!value.ok) assert.equal(nodes(tree, n => n.props.role === 'alert').length, 1); else assert.match(text(tree), /No current eligible/); h.unmount();
  }
});
console.log(`${passes} executed client component/remote ownership gates PASS; VM React harness, not mounted browser acceptance`);
