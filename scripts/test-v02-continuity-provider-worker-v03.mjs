#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fixture, ContinuityProviderV03, ContinuityPolicyV03, syncContinuitySummaryPolicyV02, z, deferred } from './continuity-v03-provider-fixture.mjs';
let passes = 0;
const check = async (name, fn) => { await fn(); passes++; console.log('PASS ' + name); };
const stop = { type: 'finish', reason: { kind: 'stop' } };
function output(options) {
  const input = JSON.parse(options.messages[0].content[0].text);
  const own = input.excerpts.find(excerpt => excerpt.text.includes('Finish bounded provider migration'));
  assert.ok(own); return JSON.stringify({ excerpts: [{ seq: own.seq, quote: 'Finish bounded provider migration' }] });
}
const good = { async *stream(options) { yield { type: 'text-delta', text: output(options) }; yield stop; } };
const create = (f, llm = good, consent = () => true, query = f.query, clock = () => 1000) => new ContinuityProviderV03(f.store, query, z, llm, { provider: 'synthetic-provider', model: 'synthetic-model', sessionId: 'NEVER-FORWARD' }, consent, clock);
async function using(fn) { const f = await fixture(); let provider; try { await fn(f, p => { provider = p; return p; }); }
  finally { await provider?.dispose(); assert.equal(f.count().leases, 0); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 0, 'provider callback never commits a handoff'); await f.close(); } }
await check('default-off, preabort and expired claims deny before any native source/provider work', () => using(async (f, own) => {
  let calls = 0; const llm = { async *stream() { calls++; yield stop; } }; const before = f.count().reads;
  const denied = own(new ContinuityProviderV03(f.store, f.query, z, llm, { provider: 'synthetic', model: 'synthetic' }));
  await assert.rejects(denied.summarize(f.claim, new AbortController().signal)); await denied.dispose();
  const preabort = new AbortController(); preabort.abort(); const p = own(create(f, llm)); await assert.rejects(p.summarize(f.claim, preabort.signal)); await p.dispose();
  const expired = own(create(f, llm, () => true, f.query, () => 32_000)); await assert.rejects(expired.summarize(f.claim, new AbortController().signal));
  assert.equal(f.count().reads, before); assert.equal(calls, 0);
}));
await check('actual native source-backed happy quote and strictly minimized provider wire', () => using(async (f, own) => {
  let calls = 0; const llm = { async *stream(options) {
    calls++; assert.deepEqual(Object.keys(options).sort(), ['maxTokens', 'messages', 'model', 'provider', 'signal', 'system', 'temperature']);
    const wire = JSON.stringify({ ...options, signal: undefined });
    for (const forbidden of [f.root.id, f.projectId, 'NEVER-FORWARD', 'ASSISTANT-BODY-CANARY', 'TOOL-CALL-CANARY', 'TOOL-BODY-CANARY', 'PASTED-BODY-CANARY', 'sk-provider-credential-canary-77']) assert.equal(wire.includes(forbidden), false, forbidden);
    assert.ok(wire.includes('Finish bounded provider migration')); assert.equal(options.maxTokens, 768);
    yield { type: 'block-start', blockType: 'text' }; yield { type: 'text-delta', text: output(options) };
    yield { type: 'block-end', block: { type: 'text', text: '' } }; yield stop;
  } };
  const p = own(create(f, llm)); assert.deepEqual(await p.summarize(f.claim, new AbortController().signal), { notes: [`Partial unverified excerpt [seq 4]: Finish bounded provider migration`] }); assert.equal(calls, 1);
}));
await check('source mutation cannot reach provider and always releases native leases', () => using(async (f, own) => {
  let calls = 0; const malformedQuery = { async observeSession(id, options) {
    const lease = await f.query.observeSession(id, options); const events = structuredClone(lease.events);
    events.find(event => event.type === 'user/message' && event.data.source.rpcId.startsWith('synthetic-')).data.content[0].text = 'mutated source';
    return { ...lease, events };
  } };
  const p = own(create(f, { async *stream() { calls++; yield stop; } }, () => true, malformedQuery));
  await assert.rejects(p.summarize(f.claim, new AbortController().signal)); assert.equal(calls, 0);
}));
await check('disabled durable summary epoch denies before protected source acquisition', () => using(async (f, own) => {
  f.store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(f.db, false)); const before = f.count().reads;
  const p = own(create(f)); await assert.rejects(p.summarize(f.claim, new AbortController().signal)); assert.equal(f.count().reads, before);
}));
await check('policy revocation during stream prevents returned notes', () => using(async (f, own) => {
  const llm = { async *stream(options) { const text = output(options); new ContinuityPolicyV03(f.store).setPolicy(f.root.id, f.projectId, false); yield { type: 'text-delta', text }; yield stop; } };
  const p = own(create(f, llm)); await assert.rejects(p.summarize(f.claim, new AbortController().signal), /continuity provider refused/);
}));
await check('summary epoch and explicit live consent revocation reject late output', async () => {
  for (const mode of ['epoch', 'live']) await using(async (f, own) => {
    let allowed = true; const llm = { async *stream(options) {
      const text = output(options); if (mode === 'epoch') f.store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(f.db, false)); else allowed = false;
      yield { type: 'text-delta', text }; yield stop;
    } };
    const p = own(create(f, llm, () => allowed)); await assert.rejects(p.summarize(f.claim, new AbortController().signal));
  });
});
await check('malformed, duplicate, extra-key, wrong-sequence and invented quotes are refused', async () => {
  const payloads = ['not-json', '{"excerpts":[{"seq":4,"quote":"invented task success"}]}', '{"excerpts":[],"approved":true}', '{"excerpts":[{"seq":99,"quote":"Finish bounded provider migration"}]}', '{"excerpts":[{"seq":4,"quote":"Finish bounded provider migration"},{"seq":4,"quote":"Finish bounded provider migration"}]}'];
  for (const text of payloads) await using(async (f, own) => { const p = own(create(f, { async *stream() { yield { type: 'text-delta', text }; yield stop; } })); await assert.rejects(p.summarize(f.claim, new AbortController().signal)); });
});
await check('tools, reasoning, unknown controls, non-stop finish and post-finish data are refused', async () => {
  const variants = [[{ type: 'tool-call-delta', text: '{}' }], [{ type: 'reasoning-delta', text: 'secret reasoning' }], [{ type: 'unknown' }], [{ type: 'finish', reason: { kind: 'max-tokens' } }], [stop, { type: 'text-delta', text: '{}' }]];
  for (const chunks of variants) await using(async (f, own) => { const p = own(create(f, { async *stream() { yield* chunks; } })); await assert.rejects(p.summarize(f.claim, new AbortController().signal)); });
});
await check('oversized output, excessive chunk count and missing finish are refused', async () => {
  for (const mode of ['size', 'chunks', 'finish']) await using(async (f, own) => {
    const p = own(create(f, { async *stream() {
      if (mode === 'size') yield { type: 'text-delta', text: 'x'.repeat(3001) };
      else if (mode === 'chunks') for (let i = 0; i < 2049; i++) yield { type: 'text-delta', text: '' };
      else yield { type: 'text-delta', text: '{"excerpts":[]}' };
    } })); await assert.rejects(p.summarize(f.claim, new AbortController().signal));
  });
});
await check('dispose aborts and drains noncooperative provider while retaining its source lease', () => using(async (f, own) => {
  const started = deferred(), release = deferred(); let pending;
  const p = own(create(f, { async *stream() { started.resolve(); await release.promise; yield { type: 'text-delta', text: '{"excerpts":[]}' }; yield stop; } }));
  try {
    pending = p.summarize(f.claim, new AbortController().signal); await started.promise; assert.ok(f.count().leases > 0);
    await assert.rejects(p.summarize(f.claim, new AbortController().signal), /busy/);
    let disposed = false; const drain = p.dispose().then(() => { disposed = true; }); await Promise.resolve(); assert.equal(disposed, false);
    release.resolve(); await assert.rejects(pending, /cancelled/); await drain; assert.equal(f.count().leases, 0);
  } finally { release.resolve(); if (pending) await pending.catch(() => {}); }
}));
console.log(`${passes} actual native v3 provider-callback gates PASS; fake LlmRuntime.stream only; no real provider/authenticated Host/browser/activation acceptance`);
