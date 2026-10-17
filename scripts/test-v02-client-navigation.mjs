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
vm.runInContext(source.replace('exports.apply = apply;', 'exports.__test = {MainSection, OverviewSection, ContinueDock, mountBusinessRemote, businessApi}; exports.apply = apply;'), sandbox);
const sut = sandbox.declaration.factory(name => { assert.equal(name, 'react'); return react; }).__test;
const walk = node => !node || typeof node !== 'object' ? [] : [node, ...(node.children || []).flatMap(walk)];
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : node && typeof node === 'object' ? (node.children || []).map(text).join(' ') : '';
const nodes = (tree, predicate) => walk(tree).filter(predicate);
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log('PASS ' + name); }
const props = api => ({ api, t: key => key });
const propsWith = (api, extra) => Object.assign({ api, t: key => key }, extra);
await check('real generated descriptor, cancellation parameter and namespace identity are retained', async () => {
  let descriptors; const remote = { $mount: async spec => { descriptors = spec.descriptors; return () => {}; } };
  const mounting = sut.mountBusinessRemote({ get: () => remote }); assert.equal(await mounting.settled, true);
  const descriptor = descriptors.find(row => row.method === 'continuityStatus'); assert.ok(descriptor); assert.equal(descriptor.parameters[0].name, 'targetSessionId'); assert.equal(descriptor.cancellation.parameter, 'signal');
  const prepare = descriptors.find(row => row.method === 'prepareContinue'); assert.ok(prepare);
  assert.equal(prepare.parameters.map(p => p.name).join(','), 'targetSessionId,jobId');
  const cont = descriptors.find(row => row.method === 'continueSession'); assert.ok(cont);
  assert.equal(cont.parameters.map(p => p.name).join(','), 'targetSessionId,jobId,authorization');
  assert.equal(cont.cancellation.parameter, 'signal');
  const namespace = Object.create({ snapshot() {} }); assert.equal(sut.businessApi({ get: () => namespace }), namespace); await mounting.dispose();
});
await check('shipped UI honours the interface-guideline rules the audit found missing', () => {
  // These were real defects: the offers/processing tables were referenced but
  // had NO rule at all, and no reduced-motion block existed anywhere.
  assert.match(source, /\.__dsi_table\{/, 'the table class must be styled, not only referenced');
  assert.match(source, /font-variant-numeric:tabular-nums/, 'numeric columns need tabular figures');
  assert.match(source, /@media \(prefers-reduced-motion: reduce\)/, 'motion must honour the user preference');
  assert.match(source, /touch-action:manipulation/, 'buttons must not wait for double-tap detection');
  assert.doesNotMatch(source, /transition:\s*all/, 'transition: all is an anti-pattern');
  assert.doesNotMatch(source, /outline:\s*none/, 'focus must never be removed without a replacement');
});
await check('actual three-tab state, panel IDs, roving focus and keyboard navigation', async () => {
  const h = harness(sut.MainSection, props({})); let tree = h.render(); const tabs = nodes(tree, n => n.props.role === 'tab'); assert.equal(tabs.length, 3);
  assert.equal(tabs.filter(n => n.props.tabIndex === 0).length, 1); const panel = nodes(tree, n => n.props.role === 'tabpanel')[0]; assert.equal(panel.props.id, tabs[0].props['aria-controls']);
  tabs[1].props.onClick(); tree = h.render(); assert.equal(nodes(tree, n => n.props.role === 'tab')[1].props['aria-selected'], true);
  let focused = -1, prevented = false; const bar = nodes(tree, n => n.props.role === 'tablist')[0];
  bar.props.onKeyDown({ key: 'End', preventDefault() { prevented = true; }, currentTarget: { querySelectorAll: () => tabs.map((_, i) => ({ focus() { focused = i; } })) } });
  assert.equal(focused, 2); assert.equal(prevented, true); tree = h.render(); assert.equal(nodes(tree, n => n.props.role === 'tab')[2].props['aria-selected'], true); h.unmount();
});
await check('Overview actually calls authorized snapshot and renders its counts', async () => {
  let calls = 0; const h = harness(sut.OverviewSection, props({ snapshot: async signal => { calls++; assert.ok(signal instanceof AbortSignal); return { ok: true, value: { memories: [{}, {}], pending: 3, episodes: { counts: { reviewed: 4 } }, skills: [{}] } }; } }));
  h.render(); await flush(); const tree = h.render(); assert.equal(calls, 1); assert.deepEqual(nodes(tree, n => n.props && n.props.className === '__dsi_statValue').map(text), ['2', '3', '4', '1']); h.unmount();
});
await check('Overview reports the continuity lane factually, including why nothing can be continued', async () => {
  const lane = { structural: 'on', body: 'off', route: true, reason: 'Capture is on, but handoff summaries are off, so nothing can be offered to continue.', pending: 2, failed: 1, handoffs: 0, lastCut: 17 };
  const h = harness(sut.OverviewSection, props({ snapshot: async () => ({ ok: true, value: { memories: [], pending: 0, episodes: { counts: { reviewed: 0 } }, skills: [], continuity: lane } }) }));
  h.render(); await flush(); const tree = h.render();
  const body = text(tree);
  assert.match(body, /Session continuity/);
  assert.match(body, /Handoff summaries/);
  assert.match(body, /Capture is on, but handoff summaries are off/);
  assert.match(body, /Unfinished tasks\s*2/); assert.match(body, /Failed attempts\s*1/);
  assert.doesNotMatch(body, /healthy/i, 'the status is facts, never a health badge');
  h.unmount();
});
await check('Overview lists the active learned skills with their evaluation state', async () => {
  const value = { memories: [], pending: 0, episodes: { counts: { reviewed: 0 } }, skills: [], continuity: null,
    learnedSkills: { available: true, deactivated: 0, active: [
      { name: 'seeded-learned-skill', evaluationVersion: 'static-eval-1', activatedAt: 1700000000000 },
      { name: 'reviewed-only-skill', evaluationVersion: null, activatedAt: 1700000000000 } ] } };
  const h = harness(sut.OverviewSection, props({ snapshot: async () => ({ ok: true, value }) }));
  h.render(); await flush(); const body = text(h.render());
  assert.match(body, /Learned skills/); assert.match(body, /2 active/);
  assert.match(body, /seeded-learned-skill/); assert.match(body, /static-eval-1/);
  assert.match(body, /reviewed-only-skill/); assert.match(body, /not evaluated/);
  assert.match(body, /Only you can invoke these/);
  h.unmount();
});
await check('Overview renders no continuity section when the host serves no lane status', async () => {
  const h = harness(sut.OverviewSection, props({ snapshot: async () => ({ ok: true, value: { memories: [], pending: 0, episodes: { counts: { reviewed: 0 } }, skills: [], continuity: null } }) }));
  h.render(); await flush(); const tree = h.render();
  assert.doesNotMatch(text(tree), /Session continuity/); h.unmount();
});
const offerValue = { ok: true, value: { availability: 'ready', canContinue: true, reason: 'One offer.', rows: [], offers: [{ jobId: 'job-1', sessionId: 'source-id', cut: 8 }] } };
const dockProps = (api, extra) => Object.assign({ api, t: key => key, sessionId: 'native-target' }, extra);
const mountDock = async p => { const h = harness(sut.ContinueDock, p); h.render(); await flush(); return { h, tree: h.render() }; };
const click = async (h, label) => { nodes(h.render(), n => n.type === 'button' && text(n) === label)[0].props.onClick(); await flush(); return h.render(); };
await check('Continue banner reads only for the open chat and renders nothing without an offer', async () => {
  const calls = []; const { h, tree } = await mountDock(dockProps({ continuityStatus: async (id, signal) => { calls.push({ id, signal }); return { ok: true, value: { availability: 'ready', canContinue: false, reason: 'No offer.', rows: [{ id: 'job', sessionId: 'source-id', cut: 8, status: 'running', attempts: 1 }], offers: [] } }; } }));
  assert.equal(calls[0].id, 'native-target'); assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(tree, null, 'no offer means no banner at all'); h.unmount();
});
await check('Review is an operator action: the click mints the peer-bound confirm then renders bounded notes', async () => {
  const calls = [];
  const api = {
    continuityStatus: async () => offerValue,
    prepareContinue: async (target, jobId) => { calls.push(['prepare', target, jobId]); return { ok: true, value: { op: 'continue', token: 'tok', ttlMs: 1000 } }; },
    continueSession: async (target, jobId, authorization) => { calls.push(['continue', target, jobId, authorization.token]); return { ok: true, value: { jobId, sessionId: 'source-id', cut: 8, notes: ['ran the tests', 'one file left'], uncertain: true } }; },
  };
  const { h, tree } = await mountDock(dockProps(api)); assert.match(text(tree), /Unfinished work in/); assert.equal(calls.length, 0, 'nothing is read before the click');
  const after = await click(h, 'Review');
  assert.deepEqual(calls, [['prepare', 'native-target', 'job-1'], ['continue', 'native-target', 'job-1', 'tok']]);
  assert.match(text(after), /ran the tests/); assert.match(text(after), /can be stale or wrong/); h.unmount();
});
await check('Review reports a withdrawn offer and a missing door instead of showing stale notes', async () => {
  const withdrawn = await mountDock(dockProps({ continuityStatus: async () => offerValue, prepareContinue: async () => ({ ok: true, value: { token: 'tok' } }), continueSession: async () => ({ ok: true, value: null }) }));
  const t1 = text(await click(withdrawn.h, 'Review')); assert.match(t1, /no longer available/); assert.doesNotMatch(t1, /can be stale or wrong/); withdrawn.h.unmount();
  const noDoor = await mountDock(dockProps({ continuityStatus: async () => offerValue }));
  assert.match(text(await click(noDoor.h, 'Review')), /browser business remote/); noDoor.h.unmount();
});
await check('Use in message fills the composer behind an honest frame and never sends', async () => {
  const inserted = [], prompts = [];
  const api = { continuityStatus: async () => offerValue, prepareContinue: async () => ({ ok: true, value: { token: 'tok' } }),
    continueSession: async () => ({ ok: true, value: { jobId: 'job-1', sessionId: 'source-id', cut: 8, notes: ['ran the tests', 'one file left'], uncertain: true } }) };
  const inputActions = { captureInsertion: () => ({ rev: 1 }), insertText: (value, span) => { inserted.push({ value, span }); return true; }, setDraft: () => { throw new Error('must not replace an existing draft'); } };
  const session = { current: { prompt: request => { prompts.push(request); return Promise.resolve({ ok: true }); } } };
  const { h } = await mountDock(dockProps(api, { inputActions, session }));
  await click(h, 'Review'); const after = await click(h, 'Use in message');
  assert.equal(prompts.length, 0, 'the banner never sends; the user does');
  assert.equal(inserted.length, 1); assert.deepEqual(inserted[0].span, { rev: 1 });
  assert.match(inserted[0].value, /machine-written, unverified/); assert.match(inserted[0].value, /- ran the tests/);
  assert.equal(after, null, 'a used handoff leaves the banner'); h.unmount();
});
await check('without composer actions the banner cannot claim to insert anything', async () => {
  const api = { continuityStatus: async () => offerValue, prepareContinue: async () => ({ ok: true, value: { token: 'tok' } }),
    continueSession: async () => ({ ok: true, value: { jobId: 'job-1', sessionId: 'source-id', cut: 8, notes: ['ran the tests'], uncertain: true } }) };
  const { h } = await mountDock(dockProps(api)); const after = await click(h, 'Review');
  assert.equal(nodes(after, n => n.type === 'button' && text(n) === 'Use in message')[0].props.disabled, true); h.unmount();
});
await check('Dismiss hides the offer without any remote call', async () => {
  let prepared = 0; const { h } = await mountDock(dockProps({ continuityStatus: async () => offerValue, prepareContinue: async () => { prepared++; return { ok: false }; } }));
  const after = nodes(h.render(), n => n.type === 'button' && n.props['aria-label'] === 'Dismiss')[0]; after.props.onClick(); await flush();
  assert.equal(h.render(), null); assert.equal(prepared, 0); h.unmount();
});
await check('superseded and unmounted reads abort and cannot admit late result or error', async () => {
  const pending = []; const p = dockProps({ continuityStatus: (id, signal) => { const d = deferred(); pending.push({ ...d, id, signal }); return d.promise; } }, { sessionId: 'first' });
  const h = harness(sut.ContinueDock, p); h.render(); await flush();
  p.sessionId = 'second'; h.render(); await flush(); assert.equal(pending[0].signal.aborted, true); assert.equal(pending[1].id, 'second');
  pending[0].resolve(offerValue); await flush(); assert.equal(h.render(), null, 'a stale offer for the previous chat never shows');
  h.unmount(); const writes = h.writes; assert.equal(pending[1].signal.aborted, true); pending[1].resolve(offerValue); await flush(); assert.equal(h.writes, writes);
});
await check('remote errors and empty inventory render nothing above the composer', async () => {
  for (const value of [{ ok: false, error: { message: 'observable error' } }, { ok: true, value: { availability: 'ready', reason: 'No dispatch capability', rows: [], canContinue: false } }]) {
    const { h, tree } = await mountDock(dockProps({ continuityStatus: async () => value })); assert.equal(tree, null); h.unmount();
  }
});
console.log(`${passes} executed client component/remote ownership gates PASS; VM React harness, not mounted browser acceptance`);
