#!/usr/bin/env node
// Actual native SessionQuery + SQLite handoff; cold preview only, no Agent/provider installed.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2; assert.ok(runtime, 'Explicit rc.2 runtime required');
const repo = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection']) assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.1-rc.2');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.4.3');
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true }); const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-preview-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const to = join(pkg, 'node_modules', name); mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { MemoryStore } = await own('storage'); const { ContinuityStoreV02 } = await own('continuity-store-v02');
const { ContinuityWorkV02 } = await own('continuity-work-v02'); const { ContinuityHandoffV02 } = await own('continuity-handoff-v02');
const { ContinuityPreviewV02 } = await own('continuity-preview-v02');
const { bindContinuityCheckpoint: bind } = await own('continuity-checkpoint-v02');
const { registerContinuityProjection, CONTINUITY_PROJECTION_KEY: KEY } = await own('continuity-registry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm'); const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const ctx = new Context(); const sf = ctx.plugin(SessionStore); await sf.await(); const pf = ctx.plugin(SessionProjectionRegistry); await pf.await(); registerContinuityProjection(ctx, z);
const qf = ctx.plugin(SessionQueryEngine); await qf.await();
const cwd = '/synthetic/preview', p = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
const make = (id, meta = { cwd }, human = true) => { const s = ctx.sessions.create(id, { meta });
  if (human) s.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'CANARY-NOT-FOR-PREVIEW' }] }), { surfaceOp: 'append' }); return s; };
const source = make('preview-source'), target = make('preview-target'); source.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
const store = new MemoryStore(join(pkg, 'data')), lane = new ContinuityStoreV02(store, z), work = new ContinuityWorkV02(store), handoffs = new ContinuityHandoffV02(store, z), db = store.getJournalSqlite();
const obs = await ctx.sessionQuery.observeSession(source.id, { projectionMode: 'none' });
const bound = bind(obs, ctx.sessionProjections.checkpoint(source)[KEY]); obs[Symbol.dispose]();
const generation = lane.ensurePolicy(source.id, p, true), job = lane.enqueue(bound, p, generation, 'turn-end');
const claim = work.claim(p, 0, 100); assert.equal(handoffs.commit(claim.token, 1, { notes: ['Untrusted source quote; external action remains uncertain.'] }), true);
const req = { targetSessionId: target.id, jobId: job.id };
let count = 0, reads = 0, drops = 0;
const tracked = { async observeSession(id, opts) { reads++; assert.equal(opts.projectionMode, 'none'); const o = await ctx.sessionQuery.observeSession(id, opts);
  return { ...o, [Symbol.dispose]() { drops++; o[Symbol.dispose](); } }; } };
const build = (query = tracked, operator = () => true, admitted = () => true) => new ContinuityPreviewV02(handoffs, query, ctx.sessionProjections, z, operator, admitted);
const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
const held = () => { let ready, release; const acquired = new Promise(r => { ready = r; }); const gate = new Promise(r => { release = r; });
  const query = { async observeSession(id, options) { const o = await tracked.observeSession(id, options); if (id === source.id) { ready(options.signal); await gate; } return o; } };
  return { acquired, release: () => release(), query }; };
try {
  await check('default operator and policy deny before source reads', async () => {
    const before = reads; assert.equal(await new ContinuityPreviewV02(handoffs, tracked, ctx.sessionProjections, z).resolve(req), null); assert.equal(reads, before);
    assert.equal(await new ContinuityPreviewV02(handoffs, tracked, ctx.sessionProjections, z, () => true).resolve(req), null); assert.equal(reads, before + 1);
    await assert.rejects(build().resolve({ ...req, humanSelected: true }));
  });
  await check('exact current same-project canonical preview is detached uncertain untrusted orientation only', async () => {
    const beforeRows = JSON.stringify(db.prepare('SELECT * FROM continuity_work').all()); const beforeEvents = (await ctx.sessionQuery.listEvents(source.id)).length;
    const beforeDrops = drops; const value = await build().resolve(req);
    assert.equal(drops, beforeDrops + 3); assert.equal(value.sourceSessionId, source.id); assert.equal(value.cut, bound.asOfSeq); assert.equal(value.sourceHash, bound.sourceHash);
    assert.equal(value.uncertain, true); assert.equal(value.untrusted, true); assert.equal(value.orientationOnly, true);
    assert.deepEqual(Object.keys(value).sort(), ['targetSessionId','sourceSessionId','projectId','jobId','cut','sourceHash','generation','notes','uncertain','untrusted','orientationOnly'].sort());
    assert.ok(!JSON.stringify(value).includes('CANARY')); value.notes.push('detached'); assert.equal(handoffs.read(p, job.id).notes.length, 1);
    assert.equal(JSON.stringify(db.prepare('SELECT * FROM continuity_work').all()), beforeRows); assert.equal((await ctx.sessionQuery.listEvents(source.id)).length, beforeEvents);
    assert.equal(ctx.get('agents'), undefined); assert.equal(ctx.get('llm'), undefined);
  });
  await check('actual appended source tail does not replace selected old cut or expose newer text', async () => {
    source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'FUTURE-TAIL-NOT-SELECTED' }] }), { surfaceOp: 'append' });
    const value = await build().resolve(req);
    assert.equal(value.cut, bound.asOfSeq); assert.equal(value.sourceHash, bound.sourceHash);
    assert.deepEqual(value.notes, handoffs.read(p, job.id).notes); assert.ok(!JSON.stringify(value).includes('FUTURE-TAIL'));
    assert.ok((await ctx.sessionQuery.listEvents(source.id)).length > value.cut + 1);
  });
  await check('aborted native target/source/reobserve acquisition rejects normalize to null and dispose prior leases', async () => {
    for (const stage of [1, 2, 3]) for (const mode of ['caller', 'owner']) {
      let ready, release, calls = 0, nativeRejections = 0;
      const reached = new Promise(r => { ready = r; }), gate = new Promise(r => { release = r; });
      const abort = new AbortController(); const query = { async observeSession(id, options) {
        calls++; if (calls !== stage) return tracked.observeSession(id, options);
        ready(); await gate;
        try { return await ctx.sessionQuery.observeSession(id, options); }
        catch (error) { assert.equal(error.code, 'SESSION_QUERY_ABORTED'); assert.equal(error.cause, options.signal.reason); nativeRejections++; throw error; }
      } };
      const resolver = build(query), before = drops, pending = resolver.resolve(req, abort.signal); await reached;
      if (mode === 'caller') abort.abort(); else resolver.dispose(); release();
      assert.equal(await pending, null); assert.equal(nativeRejections, 1); assert.equal(calls, stage);
      assert.equal(drops, before + stage - 1, 'all and only previously acquired native leases disposed');
    }
  });
  await check('ordinary acquisition I/O errors remain reported even when an abort races them', async () => {
    for (const stage of [1, 2, 3]) for (const racingAbort of [false, true]) {
      let calls = 0; const abort = new AbortController(); const failure = new Error('synthetic ordinary I/O failure');
      const query = { async observeSession(id, options) {
        if (++calls !== stage) return tracked.observeSession(id, options);
        if (racingAbort) abort.abort(); throw failure;
      } };
      const before = drops; await assert.rejects(build(query).resolve(req, abort.signal), error => error === failure);
      assert.equal(drops, before + stage - 1);
    }
    const bareAbortError = new DOMException('not owned acquisition cancellation', 'AbortError');
    await assert.rejects(build({ async observeSession() { throw bareAbortError; } }).resolve(req), error => error === bareAbortError);
  });
  await check('unrelated/delegated/nohuman target and source exclusion deny without returning notes', async () => {
    for (const s of [make('preview-other', { cwd: '/synthetic/other' }), make('preview-delegated', { cwd, origin: 'subagent', delegationDepth: 1 }), make('preview-nohuman', { cwd }, false)]) {
      assert.equal(await build().resolve({ ...req, targetSessionId: s.id }), null);
    }
    assert.equal(await build(tracked, () => true, (_h, role) => role === 'target').resolve(req), null);
    const before = reads;
    assert.equal(await build(tracked, (_request, selectedSource) => selectedSource !== source.id).resolve(req), null);
    assert.equal(reads, before + 1, 'selected-source exclusion refuses before canonical source body read');
  });
  await check('held source observation disposal aborts owner and late result cannot return notes', async () => {
    const gate = held(), resolver = build(gate.query), before = drops; const pending = resolver.resolve(req); const signal = await gate.acquired;
    resolver.dispose(); assert.equal(signal.aborted, true); gate.release(); assert.equal(await pending, null); assert.equal(drops, before + 2);
    const oldReads = reads; assert.equal(await resolver.resolve(req), null); assert.equal(reads, oldReads);
  });
  await check('held source caller cancellation and live operator/admission loss cannot return late notes', async () => {
    for (const mode of ['cancel', 'operator', 'admission']) {
      const gate = held(); let allowed = true; const abort = new AbortController();
      const resolver = build(gate.query, () => mode === 'operator' ? allowed : true, () => mode === 'admission' ? allowed : true);
      const before = drops, pending = resolver.resolve(req, abort.signal); await gate.acquired; allowed = false;
      if (mode === 'cancel') abort.abort(); gate.release(); assert.equal(await pending, null); assert.equal(drops, before + 2);
    }
  });
  await check('current durable generation/denial/cancellation drift while source held refuses result', async () => {
    for (const sql of ['UPDATE continuity_policy SET generation=generation+1 WHERE session_id=?', 'UPDATE continuity_policy SET allowed=0 WHERE session_id=?', "UPDATE continuity_jobs SET status='cancelled' WHERE session_id=?"]) {
      const gate = held(), resolver = build(gate.query), before = drops, pending = resolver.resolve(req); await gate.acquired;
      db.prepare(sql).run(source.id); gate.release(); assert.equal(await pending, null); assert.equal(drops, before + 2);
      db.prepare('UPDATE continuity_policy SET generation=?,allowed=1 WHERE session_id=?').run(generation, source.id);
      db.prepare("UPDATE continuity_jobs SET status='pending' WHERE session_id=?").run(source.id); // PRIVATE fixture restoration only
    }
  });
  await check('canonical old-source corruption throws and releases both actual observation leases', async () => {
    const corrupt = { async observeSession(id, options) { const o = await tracked.observeSession(id, options);
      if (id !== source.id) return o; const events = structuredClone(o.events); events[0].data.content[0].text = 'CORRUPT'; return { ...o, events }; } };
    const before = drops; await assert.rejects(build(corrupt).resolve(req), /hash mismatch/); assert.equal(drops, before + 2);
  });
  await check('target reobservation detects logical-ID header/project replacement after source await', async () => {
    let targetReads = 0;
    const changed = { async observeSession(id, options) { const o = await tracked.observeSession(id, options);
      if (id === target.id && ++targetReads === 2) return { ...o, header: { ...o.header, cwd: '/synthetic/replaced-target' } }; return o; } };
    const before = drops; await assert.rejects(build(changed).resolve(req), /ownership mismatch/); assert.equal(drops, before + 3);
  });
  await check('changed current selected payload cannot replace the preview silently', async () => {
    const original = db.prepare('SELECT payload FROM continuity_handoff WHERE job_id=?').get(job.id).payload;
    const gate = held(), pending = build(gate.query).resolve(req); await gate.acquired;
    const value = JSON.parse(original); value.notes = ['new content']; db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(JSON.stringify(value), job.id);
    gate.release(); assert.equal(await pending, null); db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(original, job.id);
  });
  console.log(`${count} PASS / 0 FAIL; private fixture=${pkg}; no Agent/provider installed, full Continue/browser not tested`);
} finally { store.close(); await qf.dispose(); await pf.dispose(); await sf.dispose(); }
