#!/usr/bin/env node
// Synthetic native current-target observation + actual compatible SQLite saved handoffs.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2; assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required');
const repo = fileURLToPath(new URL('../', import.meta.url));
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection']) assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.0-rc.2');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.6.5');
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true }); const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-archive-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const to = join(pkg, 'node_modules', name); mkdirSync(dirname(to), { recursive: true }); symlinkSync(from, to);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { MemoryStore } = await own('storage'); const { ContinuityStoreV02 } = await own('continuity-store-v02'); const { ContinuityWorkV02 } = await own('continuity-work-v02');
const { ContinuityHandoffV02 } = await own('continuity-handoff-v02'); const { ContinuityArchiveV02 } = await own('continuity-archive-v02');
const { bindContinuityCheckpoint: bind } = await own('continuity-checkpoint-v02'); const { registerContinuityProjection, CONTINUITY_PROJECTION_KEY: KEY } = await own('continuity-registry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session'); const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm'); const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const ctx = new Context(); const sf = ctx.plugin(SessionStore); await sf.await(); const pf = ctx.plugin(SessionProjectionRegistry); await pf.await(); registerContinuityProjection(ctx, z); const qf = ctx.plugin(SessionQueryEngine); await qf.await();
const cwd = '/synthetic/archive', p = opaqueProjectIdFromKey(projectKeyFromCwd(cwd)), otherCwd = '/synthetic/foreign', otherP = opaqueProjectIdFromKey(projectKeyFromCwd(otherCwd));
const target = ctx.sessions.create('archive-current-empty-target', { meta: { cwd } }), otherTarget = ctx.sessions.create('archive-other-target', { meta: { cwd: otherCwd } });
const source = ctx.sessions.create('archive-saved-source', { meta: { cwd } }); source.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'SOURCE-BODY-NEVER-ARCHIVED-OUTPUT' }] }), { surfaceOp: 'append' });
const store = new MemoryStore(join(pkg, 'data')), lane = new ContinuityStoreV02(store, z), work = new ContinuityWorkV02(store), handoffs = new ContinuityHandoffV02(store, z), db = store.getJournalSqlite();
const obs = await ctx.sessionQuery.observeSession(source.id, { projectionMode: 'none' }); const bound = bind(obs, ctx.sessionProjections.checkpoint(source)[KEY]); obs[Symbol.dispose]();
const generation = lane.ensurePolicy(source.id, p, true), job = lane.enqueue(bound, p, generation, 'turn-end'), claim = work.claim(p, 0, 100);
assert.equal(handoffs.commit(claim.token, 1, { notes: ['Saved historical note; unverified action remains uncertain.'] }), true);
let reads = 0, drops = 0, count = 0;
const tracked = { async observeSession(id, opts) { reads++; assert.notEqual(id, source.id, 'archive never observes saved source bodies'); assert.equal(opts.projectionMode, 'none');
  const o = await ctx.sessionQuery.observeSession(id, opts); return { ...o, [Symbol.dispose]() { drops++; o[Symbol.dispose](); } }; } };
const build = (query = tracked, operator = () => true, owner = store) => new ContinuityArchiveV02(owner, query, z, operator);
const snapshot = () => JSON.stringify(['continuity_policy', 'continuity_jobs', 'continuity_work', 'continuity_handoff'].map(table => db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all()));
const check = async (name, fn) => { await fn(); count++; console.log('PASS ' + name); };
try {
  await check('default denial never reads native target or saved payload; absent namespace stays inert', async () => {
    const before = reads; assert.equal(await new ContinuityArchiveV02(store, tracked, z).list(target.id), null); assert.equal(reads, before);
    const fresh = new MemoryStore(join(pkg, 'fresh')); try {
      const fdb = fresh.getJournalSqlite(), names = JSON.stringify(fdb.prepare('SELECT name FROM sqlite_master ORDER BY name').all());
      assert.deepEqual(await build(tracked, () => true, fresh).list(target.id), { items: [], hasMore: false }); assert.equal(reads, before);
      assert.equal(JSON.stringify(fdb.prepare('SELECT name FROM sqlite_master ORDER BY name').all()), names);
    } finally { fresh.close(); }
  });
  await check('saved archived DTO is detached and explicitly never future-use eligible; current target may be empty', async () => {
    const before = snapshot(), oldDrops = drops, page = await build().list(target.id);
    assert.equal(page.items.length, 1); assert.equal(page.hasMore, false); assert.equal(drops, oldDrops + 1);
    const item = page.items[0]; assert.equal(item.usageEligible, false); assert.equal(item.archived, true); assert.equal(item.uncertain, true); assert.equal(item.untrusted, true);
    assert.deepEqual(Object.keys(item).sort(), ['jobId','sourceSessionId','projectId','cut','generation','sourceReferenceStatus','notes','archived','untrusted','uncertain','usageEligible'].sort());
    assert.ok(!JSON.stringify(page).includes('SOURCE-BODY')); item.notes.push('detached'); assert.equal(handoffs.read(p, job.id).notes.length, 1); assert.equal(snapshot(), before);
    assert.equal(ctx.get('agents'), undefined); assert.equal(ctx.get('llm'), undefined);
  });
  await check('paused/revoked/excluded/cancelled historical rows remain operator inspectable without any policy regrant', async () => {
    lane.ensurePolicy(source.id, p, false); assert.equal(handoffs.read(p, job.id), null); assert.deepEqual(handoffs.list(p), []);
    const before = snapshot(), page = await build().list(target.id);
    assert.equal(page.items.length, 1); assert.equal(page.items[0].sourceReferenceStatus, 'cancelled'); assert.equal(page.items[0].generation, generation); assert.equal(page.items[0].usageEligible, false);
    assert.equal(snapshot(), before); assert.equal(lane.readPolicy(source.id).allowed, false); assert.ok(lane.readPolicy(source.id).generation > generation);
  });
  await check('trusted current project scope prevents unrelated saved notes and denies current project authorization loss', async () => {
    assert.deepEqual(await build().list(otherTarget.id), { items: [], hasMore: false });
    const before = snapshot(); assert.equal(await build(tracked, (_id, project) => project !== p).list(target.id), null); assert.equal(snapshot(), before);
    const delegated = ctx.sessions.create('archive-delegated-target', { meta: { cwd, origin: 'subagent', delegationDepth: 1 } }); assert.equal(await build().list(delegated.id), null);
  });
  await check('malformed payload/forged anchors/missing job refuse rather than expose or silently rebind notes', async () => {
    const original = db.prepare('SELECT payload FROM continuity_handoff WHERE job_id=?').get(job.id).payload;
    for (const value of ['{', JSON.stringify({ ...JSON.parse(original), permission: true }), JSON.stringify({ ...JSON.parse(original), sourceHash: 'f'.repeat(64) })]) {
      db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(value, job.id); await assert.rejects(build().list(target.id));
    }
    db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(original, job.id);
    db.prepare('UPDATE continuity_jobs SET cut=cut+1 WHERE id=?').run(job.id); await assert.rejects(build().list(target.id), /anchor mismatch/);
    db.prepare('UPDATE continuity_jobs SET cut=cut-1 WHERE id=?').run(job.id);
    db.prepare('UPDATE continuity_handoff SET job_id=? WHERE job_id=?').run('missing-job', job.id); await assert.rejects(build().list(target.id), /anchor mismatch/);
    db.prepare('UPDATE continuity_handoff SET job_id=? WHERE job_id=?').run(job.id, 'missing-job');
  });
  await check('partial/incompatible schema refuses before native or saved content reads and creates nothing', async () => {
    const partial = new MemoryStore(join(pkg, 'partial')); try {
      const pdb = partial.getJournalSqlite(); pdb.exec('CREATE TABLE continuity_handoff(job_id TEXT PRIMARY KEY) STRICT');
      const beforeReads = reads, names = JSON.stringify(pdb.prepare('SELECT name FROM sqlite_master ORDER BY name').all());
      await assert.rejects(build(tracked, () => true, partial).list(target.id), /incompatible/); assert.equal(reads, beforeReads);
      assert.equal(JSON.stringify(pdb.prepare('SELECT name FROM sqlite_master ORDER BY name').all()), names);
    } finally { partial.close(); }
    db.exec('ALTER TABLE continuity_handoff RENAME COLUMN payload TO invalid_payload');
    await assert.rejects(build().list(target.id), /incompatible/); db.exec('ALTER TABLE continuity_handoff RENAME COLUMN invalid_payload TO payload');
  });
  await check('held acquired native target cancellation/disposal/operator loss releases lease and returns no saved notes', async () => {
    for (const mode of ['caller', 'owner', 'operator']) {
      let ready, release, authorized = true; const reached = new Promise(r => { ready = r; }), gate = new Promise(r => { release = r; });
      const query = { async observeSession(id, opts) { const o = await tracked.observeSession(id, opts); ready(opts.signal); await gate; return o; } };
      const resolver = build(query, () => authorized), abort = new AbortController(), oldDrops = drops, pending = resolver.list(target.id, abort.signal); const signal = await reached;
      if (mode === 'caller') abort.abort(); if (mode === 'owner') resolver.dispose(); if (mode === 'operator') authorized = false;
      if (mode !== 'operator') assert.equal(signal.aborted, true); release(); assert.equal(await pending, null); assert.equal(drops, oldDrops + 1);
    }
  });
  await check('native aborted acquisition rejects normalize only owned cancellation; ordinary I/O stays reported', async () => {
    let ready, release; const reached = new Promise(r => { ready = r; }), gate = new Promise(r => { release = r; });
    const query = { async observeSession(id, opts) { ready(); await gate; return ctx.sessionQuery.observeSession(id, opts); } };
    const resolver = build(query), abort = new AbortController(), oldDrops = drops, pending = resolver.list(target.id, abort.signal); await reached; abort.abort(); release();
    assert.equal(await pending, null); assert.equal(drops, oldDrops);
    const io = new Error('ordinary archive I/O'); await assert.rejects(build({ async observeSession() { throw io; } }).list(target.id), error => error === io);
  });
  await check('bounded newest fifty saved rows disclose hasMore without exposing another project or implying eligibility', async () => {
    for (let i = 0; i < 51; i++) {
      const id = 'archive-page-' + i, payload = { jobId: id, sessionId: 'saved-page-source', projectId: p, generation: 0, cut: i + 10, sourceHash: 'a'.repeat(64), notes: ['saved synthetic'], uncertain: true };
      db.prepare("INSERT INTO continuity_jobs VALUES(?,?,?,0,?,?,'turn-end','cancelled')").run(id, payload.sessionId, p, payload.cut, payload.sourceHash);
      db.prepare('INSERT INTO continuity_handoff VALUES(?,?,?,?,?,?,?)').run(id, payload.sessionId, p, 0, payload.cut, payload.sourceHash, JSON.stringify(payload));
    }
    const before = snapshot(), page = await build().list(target.id); assert.equal(page.items.length, 50); assert.equal(page.hasMore, true); assert.equal(page.items[0].cut, 60);
    assert.ok(page.items.every(item => item.projectId === p && item.usageEligible === false)); assert.equal(snapshot(), before);
    assert.deepEqual(await build().list(otherTarget.id), { items: [], hasMore: false });
  });
  console.log(`${count} PASS / 0 FAIL; private fixture=${pkg}; standalone operator archive only, no Remote/main/Continue acceptance`);
} finally { store.close(); await qf.dispose(); await pf.dispose(); await sf.dispose(); }
