#!/usr/bin/env node
// Genuine rc.2 SessionStore/SessionQueryEngine observations + actual SQLite.
// ONLY private synthetic registered adapter; no main plugin/profile/real model.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no fallback/install/profile');
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection', 'dsh-llm']) {
  assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.1-rc.2');
}
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.4.3');
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-worker-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { MemoryStore } = await own('storage'); const { ContinuityStoreV02 } = await own('continuity-store-v02');
const { ContinuityOwnerV02 } = await own('continuity-owner-v02'); const { ContinuityWorkV02 } = await own('continuity-work-v02');
const { ContinuityHandoffV02 } = await own('continuity-handoff-v02'); const { ContinuityWorkerV02 } = await own('continuity-worker-v02');
const { registerContinuityProjection } = await own('continuity-registry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { SessionStore } = await native('dsh-session'); const { SessionQueryEngine } = await native('dsh-session-query');
const { LlmRuntime, LlmAdapter, createUserMessage } = await native('dsh-llm');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const ctx = new Context(); const fibers = [];
for (const plugin of [SessionStore, SessionProjectionRegistry, SessionQueryEngine, LlmRuntime]) { const fiber = ctx.plugin(plugin); await fiber.await(); fibers.push(fiber); }
registerContinuityProjection(ctx, z);
let handler, modelReasoning; const requests = [];
class SyntheticAdapter extends LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: 'Synthetic fixture only', ...(modelReasoning ? { reasoning: modelReasoning } : {}) }; }
  async *stream(options) { requests.push(options); yield* handler(options); }
}
const registration = ctx.llm.registerAdapter(['synthetic-continuity'], new SyntheticAdapter());
const store = new MemoryStore(join(pkg, 'data')), lane = new ContinuityStoreV02(store, z), work = new ContinuityWorkV02(store), handoffs = new ContinuityHandoffV02(store, z);
const db = store.getJournalSqlite(); let passes = 0, serial = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const check = async (name, fn) => { await fn(); passes++; console.log('PASS ' + name); };
const user = (session, text, source = { kind: 'user' }) => session.append('user/message', createUserMessage({ source, content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
async function fixture(name, messages = ['Continue fixing the synthetic unfinished parser.'], authorizedSeq) {
  const session = ctx.sessions.create('worker-' + ++serial + '-' + name, { meta: { cwd: '/synthetic/worker/' + serial } });
  for (const message of messages) {
    if (typeof message === 'string') user(session, message);
    else user(session, message.text, message.source);
  }
  session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  const project = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd));
  const owner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, ctx.sessionQuery, () => true);
  const job = await owner.capture(session, 'turn-end'); owner.dispose();
  let observes = 0, drops = 0, consent = true, now = 1000, transform = observation => observation;
  const query = { async observeSession(id, options) {
    observes++; assert.equal(options.projectionMode, 'none'); assert.ok(options.signal instanceof AbortSignal);
    const observation = await ctx.sessionQuery.observeSession(id, options);
    const view = await transform(observation);
    return { ...view, [Symbol.dispose]() { drops++; observation[Symbol.dispose](); } };
  } };
  const humanSeq = authorizedSeq ?? messages.findLastIndex(message => typeof message === 'string' || message.source.kind === 'user');
  const worker = new ContinuityWorkerV02(store, query, ctx.sessionProjections, z, ctx.llm,
    { provider: 'synthetic-continuity', model: 'fixture' }, () => consent, () => now,
    claim => claim.sessionId === session.id && claim.cut >= humanSeq, { sessionId: session.id, minimumCut: humanSeq });
  return { session, project, job: job.id, worker, get observes() { return observes; }, get drops() { return drops; },
    set consent(value) { consent = value; }, set now(value) { now = value; }, set transform(value) { transform = value; } };
}
function response(options, payload) {
  const source = JSON.parse(options.messages[0].content[0].text);
  return JSON.stringify(payload ?? { excerpts: source.excerpts.length ? [{ seq: source.excerpts[0].seq, quote: source.excerpts[0].text.slice(0, 80) }] : [] });
}
const valid = async function*(options) { yield { type: 'text-delta', index: 0, text: response(options) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
const status = f => work.readStatus(f.project, f.job)?.status;
const absent = f => { assert.equal(handoffs.read(f.project, f.job), null); assert.notEqual(status(f), 'completed'); };
try {
  await check('missing authenticated coordinate refuses before claim/source/provider despite permissive callbacks', async () => {
    const f = await fixture('unscoped'); const before = requests.length;
    const unscoped = new ContinuityWorkerV02(store, { observeSession() { throw new Error('must not observe'); } },
      ctx.sessionProjections, z, ctx.llm, { provider: 'synthetic-continuity', model: 'fixture' }, () => true, () => 1000, () => true);
    assert.equal(await unscoped.runOne(f.project), 'refused'); assert.equal(requests.length, before);
    assert.equal(status(f), undefined); unscoped.dispose(); f.worker.dispose();
  });
  await check('only exact authenticated coordinate exports; adjacent user-shaped history before and after omitted', async () => {
    const f = await fixture('exact-coordinate', ['UNAUTHENTICATED-BEFORE', 'Authorized unfinished parser request', 'UNAUTHENTICATED-AFTER'], 1);
    handler = valid; assert.equal(await f.worker.runOne(f.project), 'completed');
    const body = requests.at(-1).messages[0].content[0].text;
    assert.deepEqual(JSON.parse(body).excerpts, [{ seq: 1, text: 'Authorized unfinished parser request' }]);
    assert.ok(!body.includes('UNAUTHENTICATED')); f.worker.dispose();
  });
  await check('default body/provider consent refuses BEFORE native source/provider and never acknowledges', async () => {
    const f = await fixture('deny'); f.consent = false; const before = requests.length; handler = valid;
    assert.equal(await f.worker.runOne(f.project), 'refused'); assert.equal(f.observes, 0); assert.equal(requests.length, before); absent(f); f.worker.dispose();
  });
  await check('historical native cut generates exact extractive partial handoff atomically, no raw session binding', async () => {
    const f = await fixture('positive'); user(f.session, 'FUTURE-TAIL-NOT-IN-OLD-CUT'); handler = valid;
    let atomicChecks = 0; const originalCurrent = ContinuityWorkV02.prototype.isCurrent;
    ContinuityWorkV02.prototype.isCurrent = function(claim, now) { if (store.isInsideTransaction()) atomicChecks++; return originalCurrent.call(this, claim, now); };
    try { assert.equal(await f.worker.runOne(f.project), 'completed'); }
    finally { ContinuityWorkV02.prototype.isCurrent = originalCurrent; }
    assert.equal(atomicChecks, 1, 'final exact claim check shares owning IMMEDIATE transaction');
    assert.equal(f.drops, 1); assert.equal(status(f), 'completed');
    const saved = handoffs.read(f.project, f.job); assert.equal(saved.uncertain, true); assert.match(saved.notes[0], /^Partial unverified excerpt \[seq 0\]:/);
    const request = requests.at(-1), wire = JSON.stringify({ ...request, signal: undefined });
    for (const key of ['sessionId', 'purpose', 'tools', 'toolHistory']) assert.equal(Object.hasOwn(request, key), false);
    assert.ok(!wire.includes(f.session.id)); assert.ok(!wire.includes(f.project)); assert.ok(!wire.includes('FUTURE-TAIL-NOT-IN-OLD-CUT'));
    assert.equal(request.maxTokens, 4096); assert.equal(Object.hasOwn(request, 'reasoningEffort'), false, 'no effort requested from a model without reasoning levels'); assert.equal(request.temperature, 0); assert.equal(handoffs.read('pj-' + 'f'.repeat(32), f.job), null);
    const before = requests.length; assert.equal(await f.worker.runOne(f.project), 'idle'); assert.equal(requests.length, before); f.worker.dispose();
  });
  await check('reasoning models: least effort requested, private reasoning discarded, handoff still completes', async () => {
    modelReasoning = { efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max' }], defaultEffort: 'max' };
    const f = await fixture('reasoning');
    handler = async function*(o) {
      yield { type: 'block-start', index: 0, blockType: 'reasoning' };
      for (let i = 0; i < 3000; i++) yield { type: 'reasoning-delta', index: 0, text: 'PRIVATE-THINKING ' };
      yield { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'PRIVATE-THINKING' } };
      yield { type: 'text-delta', index: 1, text: response(o) }; yield { type: 'finish', reason: { kind: 'stop' } };
    };
    try { assert.equal(await f.worker.runOne(f.project), 'completed'); }
    finally { modelReasoning = undefined; }
    assert.equal(requests.at(-1).reasoningEffort, 'low', 'the least selectable effort is requested');
    const saved = handoffs.read(f.project, f.job); assert.ok(saved && saved.notes.length > 0);
    assert.ok(!JSON.stringify(saved).includes('PRIVATE-THINKING'), 'reasoning text never reaches the handoff');
    f.worker.dispose();
  });
  await check('oversized source and suspicious/injected material omitted; total minimized provider request bounded', async () => {
    const messages = ['HUGE-PASTE-CANARY ' + 'x'.repeat(240000), '> QUOTATION-CANARY', '```\nFENCED-PASTE-CANARY\n```',
      ...Array.from({ length: 12 }, (_, i) => 'Own short request ' + i + ': password=SECRET-EGRESS-CANARY ' + 'y'.repeat(2800)),
      // Within the SAME claimed canonical cut, these user-role sources are not
      // direct-human authority and cannot be exported as orientation evidence.
      { text: 'INJECTED-CANARY', source: { kind: 'runtime-context' } },
      { text: 'COORDINATOR-CANARY', source: { kind: 'coordinator' } },
      { text: 'TOOL-SOURCE-CANARY', source: { kind: 'tool', callId: 'synthetic-call' } }];
    const f = await fixture('oversized', messages);
    handler = valid; assert.equal(await f.worker.runOne(f.project), 'completed');
    const request = requests.at(-1), body = request.messages[0].content[0].text, parsed = JSON.parse(body);
    assert.equal(parsed.partial, true); assert.equal(parsed.unverified, true); assert.ok(parsed.excerpts.length <= 8);
    assert.ok(parsed.excerpts.reduce((n, x) => n + x.text.length, 0) <= 6000); assert.ok(body.length + request.system.length <= 12000);
    for (const canary of ['HUGE-PASTE-CANARY', 'QUOTATION-CANARY', 'FENCED-PASTE-CANARY', 'SECRET-EGRESS-CANARY', 'INJECTED-CANARY', 'COORDINATOR-CANARY', 'TOOL-SOURCE-CANARY']) assert.ok(!body.includes(canary), canary);
    assert.ok(body.includes('[REDACTED]')); assert.equal(f.drops, 1); f.worker.dispose();
  });
  await check('corrupt canonical event/hash/header or incomplete native cut fails before provider and never acknowledges', async () => {
    for (const mutate of [o => ({ ...o, events: o.events.map((e, i) => i === 0 ? { ...e, data: { ...e.data, content: [{ type: 'text', text: 'FORGED' }] } } : e) }),
      o => ({ ...o, events: o.events.slice(1) }), o => ({ ...o, header: { ...o.header, createdAt: o.header.createdAt + 1 } })]) {
      const f = await fixture('corrupt'); f.transform = mutate; const before = requests.length; handler = valid;
      assert.equal(await f.worker.runOne(f.project), 'failed'); assert.equal(requests.length, before); assert.equal(f.drops, 1); absent(f); assert.equal(status(f), 'failed'); f.worker.dispose();
    }
  });
  await check('exact isCurrent gate closes post-observation DB hash drift without provider call', async () => {
    const f = await fixture('anchor'); f.transform = o => { db.prepare('UPDATE continuity_jobs SET source_hash=? WHERE id=?').run('d'.repeat(64), f.job); return o; };
    const before = requests.length; handler = valid; assert.equal(await f.worker.runOne(f.project), 'refused'); assert.equal(requests.length, before); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
  });
  await check('malformed/forged/extra/oversized/duplicate output never acknowledged; failure stays inspectable', async () => {
    const bad = [null, { excerpts: 'wrong' }, { excerpts: [], permission: true }, { excerpts: [{ seq: 0, quote: 'FABRICATED' }] },
      { excerpts: [{ seq: 999, quote: 'Continue' }] }, { excerpts: [{ seq: 0, quote: 'x'.repeat(201) }] },
      { excerpts: [{ seq: 0, quote: 'Continue' }, { seq: 0, quote: 'Continue' }] }];
    for (const payload of bad) {
      const f = await fixture('malformed'); handler = async function*() { yield { type: 'text-delta', index: 0, text: JSON.stringify(payload) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
      assert.equal(await f.worker.runOne(f.project), 'failed'); assert.equal(f.drops, 1); absent(f); assert.equal(status(f), 'failed'); f.worker.dispose();
    }
    const f = await fixture('outputcap'); handler = async function*() { yield { type: 'text-delta', index: 0, text: 'x'.repeat(3001) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
    assert.equal(await f.worker.runOne(f.project), 'failed'); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
  });
  await check('missing stop, non-stop finishes and tool output fail closed with native lease finally disposal', async () => {
    const streams = [async function*(o) { yield { type: 'text-delta', index: 0, text: response(o) }; },
      ...['tool-calls', 'max-tokens', 'error', 'aborted'].map(kind => async function*(o) { yield { type: 'text-delta', index: 0, text: response(o) }; yield { type: 'finish', reason: { kind, failure: { code: 'SYNTHETIC', message: 'fixture' } } }; }),
      async function*() { yield { type: 'tool-call-delta', index: 0, id: 'synthetic', name: 'unauthorized', argumentsDelta: '{}' }; }];
    for (const stream of streams) { const f = await fixture('terminal'); handler = stream; assert.equal(await f.worker.runOne(f.project), 'failed'); assert.equal(f.drops, 1); absent(f); f.worker.dispose(); }
  });
  await check('revoked and cancelled held synthetic provider receives abort and cannot late commit', async () => {
    const f = await fixture('revoked'); const ready = deferred(), release = deferred(); let providerSignal;
    handler = async function*(o) { providerSignal = o.signal; ready.resolve(); await release.promise; yield { type: 'text-delta', index: 0, text: response(o) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
    const run = f.worker.runOne(f.project); await ready.promise;
    lane.ensurePolicy(f.session.id, f.project, false); f.consent = false; f.worker.cancel(); assert.equal(providerSignal.aborted, true);
    assert.equal(f.drops, 0); assert.equal(await f.worker.runOne(f.project), 'busy'); release.resolve(); assert.equal(await run, 'refused'); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
  });
  await check('live consent loss alone gates held-provider late output even before durable owner revocation', async () => {
    const f = await fixture('live'); const ready = deferred(), release = deferred(); let signal;
    handler = async function*(o) { signal = o.signal; ready.resolve(); await release.promise; yield { type: 'text-delta', index: 0, text: response(o) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
    const run = f.worker.runOne(f.project); await ready.promise; f.consent = false; release.resolve(); assert.equal(await run, 'refused'); assert.equal(signal.aborted, true); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
  });
  await check('external abort retains noncooperative provider ownership until settlement and always releases lease', async () => {
    const f = await fixture('abort'); const ready = deferred(), release = deferred(), controller = new AbortController(); let providerSignal;
    handler = async function*(o) { providerSignal = o.signal; ready.resolve(); await release.promise; yield { type: 'text-delta', index: 0, text: response(o) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
    const run = f.worker.runOne(f.project, controller.signal); await ready.promise; controller.abort(); assert.equal(providerSignal.aborted, true);
    assert.equal(f.drops, 0); assert.equal(await f.worker.runOne(f.project), 'busy'); release.resolve(); assert.equal(await run, 'refused'); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
  });
  await check('disposed held observation releases actual native lease and never reaches provider', async () => {
    const f = await fixture('observation'); const ready = deferred(), release = deferred();
    f.transform = async o => { ready.resolve(); await release.promise; return o; }; handler = valid; const before = requests.length;
    const run = f.worker.runOne(f.project); await ready.promise; f.worker.dispose(); release.resolve(); assert.equal(await run, 'refused'); assert.equal(requests.length, before); assert.equal(f.drops, 1); absent(f);
  });
  await check('trusted clock lease expiry during held provider refuses atomic commit and preserves uncertainty', async () => {
    const f = await fixture('expiry'); const ready = deferred(), release = deferred();
    handler = async function*(o) { ready.resolve(); await release.promise; yield { type: 'text-delta', index: 0, text: response(o) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
    const run = f.worker.runOne(f.project); await ready.promise; f.now = 61000; release.resolve(); assert.equal(await run, 'refused'); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
  });
  await check('foreign SQLite writer source cut/hash drift during held provider never commits old-source notes', async () => {
    for (const sql of ['UPDATE continuity_jobs SET cut=cut+1 WHERE id=?', 'UPDATE continuity_jobs SET source_hash=? WHERE id=?']) {
      const f = await fixture('foreign-source'); const ready = deferred(), release = deferred();
      handler = async function*(o) { ready.resolve(); await release.promise; yield { type: 'text-delta', index: 0, text: response(o) }; yield { type: 'finish', reason: { kind: 'stop' } }; };
      const run = f.worker.runOne(f.project); await ready.promise;
      const foreign = new DatabaseSync(join(pkg, 'data/memory.db'));
      try { foreign.exec('BEGIN IMMEDIATE'); const stmt = foreign.prepare(sql); if (sql.includes('source_hash')) stmt.run('d'.repeat(64), f.job); else stmt.run(f.job); foreign.exec('COMMIT'); }
      finally { foreign.close(); }
      release.resolve(); assert.equal(await run, 'refused'); assert.equal(f.drops, 1); absent(f); f.worker.dispose();
    }
  });
  await check('atomic handoff insertion failure cannot acknowledge, empty valid selection is distinct success', async () => {
    const f = await fixture('atomic'); handler = valid;
    db.exec("CREATE TRIGGER reject_worker_handoff BEFORE INSERT ON continuity_handoff BEGIN SELECT RAISE(ABORT,'synthetic handoff failure'); END");
    try { assert.equal(await f.worker.runOne(f.project), 'failed'); assert.equal(f.drops, 1); absent(f); } finally { db.exec('DROP TRIGGER reject_worker_handoff'); f.worker.dispose(); }
    const empty = await fixture('empty'); handler = async function*() { yield { type: 'text-delta', index: 0, text: '{"excerpts":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } }; };
    assert.equal(await empty.worker.runOne(empty.project), 'completed'); assert.deepEqual(handoffs.read(empty.project, empty.job).notes, []); assert.equal(empty.drops, 1); empty.worker.dispose();
  });
  if (process.argv.includes('--wall-timeout')) await check('real owned wall timer aborts cooperative held provider without acknowledging', async () => {
    const f = await fixture('wall-timeout'); let signal;
    handler = async function*(o) {
      signal = o.signal;
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      yield { type: 'text-delta', index: 0, text: response(o) };
      yield { type: 'finish', reason: { kind: 'stop' } };
    };
    const started = performance.now();
    assert.equal(await f.worker.runOne(f.project), 'refused');
    assert.ok(performance.now() - started >= 14000, 'actual fixed 15s owned timer, not an explicit abort/forged clock');
    assert.equal(signal.aborted, true); assert.equal(f.drops, 1); absent(f);
    assert.notEqual(status(f), 'completed'); f.worker.dispose();
  });
  console.log(`${passes} PASS / 0 FAIL; genuine native observations + SQLite; ONLY private synthetic adapter; fixture=${pkg}`);
} finally { registration(); store.close(); for (const fiber of fibers.reverse()) await fiber.dispose(); }
