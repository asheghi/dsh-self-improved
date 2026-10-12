#!/usr/bin/env node
// Exact shipped binding exercised in VM; NOT a mounted/browser acceptance claim.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
let source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
assert.equal(source.split('exports.apply = apply;').length, 2);
source = source.replace('exports.apply = apply;', 'exports.__binding = bindSettingsForm; exports.__fields = FIELDS; exports.apply = apply;');
let decl; const scope = { window: { __ModuleLoader__: { load(value) { decl = value; } } } }; vm.createContext(scope); vm.runInContext(source, scope);
const module = decl.factory(() => ({ createElement() {} }));
let revision = 4, calls = []; let value = { continuity: { enabled: false, excludedSessionIds: [], excludedProjectIds: [] } };
const form = { getSnapshot() { return { revision, value, user: {}, writable: true, status: 'ready' }; }, subscribe() { return () => {}; },
  async mutate(ops, fence) { calls.push({ ops: JSON.parse(JSON.stringify(ops)), fence }); return fence === revision; } };
const binding = module.__binding({ get() { return { get() { return form; } }; } });
const edit = (key, draft) => binding.setField(module.__fields.find(field => field.key === key), draft);
const plain = item => JSON.parse(JSON.stringify(item));
let n = 0; const check = async (name, fn) => { await fn(); console.log('PASS ' + name); n++; };
await check('exact IDs with commas, spaces, quotes and Unicode survive typed array serialization', async () => {
  const ids = ['a,b', ' space ', 'quote"', '雪']; edit('continuity.excludedSessionIds', JSON.stringify(ids));
  assert.equal(await binding.saveDirty(), true); assert.deepEqual(calls.at(-1).ops[0].value, ids); assert.equal(calls.at(-1).fence, 4);
});
await check('explicit empty array clears rather than unset/inherit', async () => {
  value.continuity.excludedSessionIds = ['old']; edit('continuity.excludedSessionIds', '[]'); await binding.saveDirty();
  assert.deepEqual(calls.at(-1).ops, [{ op: 'set', path: ['continuity', 'excludedSessionIds'], value: [] }]);
});
await check('malformed or mixed-type arrays refuse ALL dirty mutation and retain drafts', async () => {
  for (const bad of ['a,b', '[1]', '{}', '']) {
    const count = calls.length; edit('continuity.enabled', true); edit('continuity.excludedSessionIds', bad);
    assert.equal(await binding.saveDirty(), false); assert.equal(calls.length, count); assert.equal(binding.dirtyCount(), 2);
  }
});
await check('stale valid draft carries original CAS fence and is not silently replayed', async () => {
  edit('continuity.excludedSessionIds', '["new"]'); revision = 5;
  assert.equal(await binding.saveDirty(), false); assert.equal(calls.at(-1).fence, 4); assert.equal(binding.dirtyCount(), 2);
});
await check('explicit rebase retains typed drafts and uses refreshed CAS revision', async () => {
  binding.rebaseDirty(); assert.equal(await binding.saveDirty(), true); assert.equal(calls.at(-1).fence, 5);
  assert.deepEqual(calls.at(-1).ops.map(op => op.value), [true, ['new']]); assert.equal(binding.dirtyCount(), 0);
});
await check('explicit continuity disable writes false without overwriting untouched concurrent exclusions', async () => {
  value.continuity.enabled = true;
  value.continuity.excludedProjectIds = ['pj-' + 'a'.repeat(32)];
  edit('continuity.enabled', false);
  assert.equal(await binding.saveDirty(), true);
  assert.deepEqual(calls.at(-1), { ops: [{ op: 'set', path: ['continuity', 'enabled'], value: false }], fence: 5 });
  assert.equal(binding.dirtyCount(), 0);
});
await check('conflicted disable stays false and requires explicit rebase before retry', async () => {
  edit('continuity.enabled', false); revision = 6;
  assert.equal(await binding.saveDirty(), false); assert.equal(calls.at(-1).fence, 5);
  assert.equal(binding.dirtyCount(), 1);
  binding.rebaseDirty(); assert.equal(await binding.saveDirty(), true);
  assert.deepEqual(calls.at(-1), { ops: [{ op: 'set', path: ['continuity', 'enabled'], value: false }], fence: 6 });
});
await check('transport rejection preserves explicit-off draft and original revision without automatic replay', async () => {
  const mutate = form.mutate, before = calls.length;
  edit('continuity.enabled', false);
  form.mutate = async (ops, fence) => { calls.push({ ops: plain(ops), fence }); throw new Error('synthetic transport rejection'); };
  try {
    assert.equal(await binding.saveDirty(), false); assert.equal(calls.length, before + 1);
    assert.equal(binding.dirtyCount(), 1); assert.equal(calls.at(-1).fence, 6);
  } finally { form.mutate = mutate; }
  revision = 7;
  assert.equal(await binding.saveDirty(), false); assert.equal(calls.at(-1).fence, 6);
  assert.equal(binding.dirtyCount(), 1);
  binding.rebaseDirty(); assert.equal(await binding.saveDirty(), true);
  assert.deepEqual(calls.at(-1), { ops: [{ op: 'set', path: ['continuity', 'enabled'], value: false }], fence: 7 });
});
await check('provider-summary consent is independently default-off and disabling never writes structural consent', async () => {
  const field = module.__fields.find(item => item.key === 'continuity.summaryEnabled');
  assert.ok(field); assert.equal(field.fallback, false);
  value.continuity.summaryEnabled = true;
  edit('continuity.summaryEnabled', false);
  assert.equal(await binding.saveDirty(), true);
  assert.deepEqual(calls.at(-1), { ops: [{ op: 'set', path: ['continuity', 'summaryEnabled'], value: false }], fence: 7 });
});
await check('invalid exclusion draft prevents partial provider-consent grant and preserves all dirty paths', async () => {
  const before = calls.length;
  edit('continuity.summaryEnabled', true); edit('continuity.excludedProjectIds', '{invalid}');
  assert.equal(await binding.saveDirty(), false); assert.equal(calls.length, before); assert.equal(binding.dirtyCount(), 2);
  edit('continuity.excludedProjectIds', '[]'); assert.equal(await binding.saveDirty(), true);
  assert.deepEqual(calls.at(-1).ops, [{ op: 'set', path: ['continuity', 'summaryEnabled'], value: true },
    { op: 'set', path: ['continuity', 'excludedProjectIds'], value: [] }]);
});
binding.unsubscribeAll(); console.log(`${n} PASS / 0 FAIL (VM binding only; browser gates pending)`);
