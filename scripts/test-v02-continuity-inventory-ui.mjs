import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { fixture, loadOwn, z } from './continuity-v03-provider-fixture.mjs';
const { readContinuityUiInventory, readContinuityLaneStatus } = await loadOwn('continuity-inventory-ui');
const { ContinuityStoreV02 } = await loadOwn('continuity-store-v02');
const { bindContinuityCheckpoint } = await loadOwn('continuity-checkpoint-v02');
const { initContinuityProjection, applyContinuityProjection } = await loadOwn('continuity-projection-v02');
const { createMemoryBusiness } = await loadOwn('business');
const f = await fixture(), db = new DatabaseSync(':memory:'); let inside = false, passes = 0;
const owner = { getJournalSqlite: () => db, runInImmediateTransaction(fn) {
  if (inside) return fn(); db.exec('BEGIN IMMEDIATE'); inside = true; try { const value = fn(); db.exec('COMMIT'); return value; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inside = false; }
} };
const store = new ContinuityStoreV02(owner, z);
let enabled = true, allowed = true, healthy = true; const excluded = new Set();
const gates = { enabled: () => enabled, healthy: () => healthy, allows: id => allowed && !excluded.has(id) };
const call = (id = f.root.id, signal, query = f.query) => readContinuityUiInventory(owner, query, id, gates, signal, 1000);
async function enqueue(id, projectId) {
  const lease = await f.query.observeSession(id, { projectionMode: 'none' });
  try {
    let state = initContinuityProjection(lease.header, lease.inheritedEventCount);
    for (const event of lease.events) state = applyContinuityProjection(state, event);
    const generation = store.setPolicy(id, projectId, true);
    return store.enqueue(bindContinuityCheckpoint(lease, { ver: 1, seq: lease.cursor, val: state }), projectId, generation, 'turn-end');
  } finally { lease[Symbol.dispose](); }
}
async function check(name, fn) { await fn(); assert.equal(f.count().leases, 0); passes++; console.log('PASS ' + name); }
try {
  await enqueue(f.root.id, f.projectId);
  await check('native scoped inventory is body-free and never creates the optional work namespace', async () => {
    const before = JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all());
    const result = await call(); assert.equal(result.availability, 'ready'); assert.equal(result.canContinue, false); assert.equal(result.rows.length, 1); assert.equal(result.rows[0].status, 'queued');
    assert.deepEqual(Object.keys(result.rows[0]).sort(), ['attempts', 'cut', 'id', 'sessionId', 'status', 'trigger']);
    for (const canary of ['ASSISTANT-BODY-CANARY', 'TOOL-BODY-CANARY', 'sk-provider-credential-canary-77']) assert.equal(JSON.stringify(result).includes(canary), false);
    assert.equal(JSON.stringify(db.prepare('SELECT name,sql FROM sqlite_schema ORDER BY name').all()), before); assert.equal(db.prepare("SELECT name FROM sqlite_schema WHERE name='continuity_work'").get(), undefined);
  });
  await check('disabled, excluded, unhealthy and malformed requests do not observe native source', async () => {
    const before = f.count().reads; enabled = false; assert.equal((await call()).availability, 'disabled'); enabled = true;
    allowed = false; assert.equal((await call()).availability, 'policy-denied'); allowed = true;
    healthy = false; assert.equal((await call()).availability, 'unavailable'); healthy = true;
    assert.equal((await call('bad\0id')).availability, 'source-unavailable'); assert.equal(f.count().reads, before);
  });
  await check('selected foreign project cannot borrow another project references', async () => {
    f.ctx.sessions.create('foreign-inventory-target', { meta: { cwd: '/synthetic/other-project' } });
    const result = await call('foreign-inventory-target'); assert.equal(result.availability, 'ready'); assert.equal(result.rows.length, 0);
  });
  await check('delegated native targets are unsupported without any task authority', async () => {
    f.ctx.sessions.create('delegated-inventory-target', { meta: { cwd: '/synthetic/provider-v03-project', origin: 'subagent', delegationDepth: 1 } });
    assert.equal((await call('delegated-inventory-target')).availability, 'unsupported-lineage');
  });
  await check('source exclusions filter existing processing rows independently of target scope', async () => {
    f.ctx.sessions.create('ordinary-inventory-target', { meta: { cwd: '/synthetic/provider-v03-project' } }); excluded.add(f.root.id);
    assert.equal((await call('ordinary-inventory-target')).rows.length, 0); excluded.clear();
  });
  await check('revocation and cancellation after native acquisition release the genuine lease', async () => {
    const revoking = { async observeSession(id, options) { const lease = await f.query.observeSession(id, options); allowed = false; return lease; } };
    assert.equal((await call(f.root.id, undefined, revoking)).availability, 'policy-denied'); allowed = true;
    const abort = new AbortController(), cancelled = { async observeSession(id, options) { const lease = await f.query.observeSession(id, options); abort.abort(); return lease; } };
    await assert.rejects(call(f.root.id, abort.signal, cancelled));
  });
  await check('shared business checks caller and identity before delegate; forwards carrier and rejects late cancellation', async () => {
    let calls = 0; const deps = { store: {}, skillsPrefix: () => '', episodeEnabled: () => false, enabled: () => true,
      continuityStatus: async (id, signal) => { calls++; assert.equal(id, f.root.id); assert.ok(signal); return call(id, signal); } };
    const business = createMemoryBusiness(deps); await assert.rejects(business.continuityStatus({ source: 'remote', peerId: null }, f.root.id)); assert.equal(calls, 0);
    const ac = new AbortController(); assert.equal((await business.continuityStatus({ source: 'remote', peerId: 'synthetic-gateway-peer' }, f.root.id, ac.signal)).rows.length, 1);
    const unavailable = createMemoryBusiness({ ...deps, continuityStatus: undefined }); assert.equal((await unavailable.continuityStatus({ source: 'remote', peerId: 'synthetic' }, f.root.id)).availability, 'unavailable');
    const late = createMemoryBusiness({ ...deps, continuityStatus: async () => { ac.abort(); return { availability: 'ready', canContinue: false, reason: '', rows: [] }; } });
    await assert.rejects(late.continuityStatus({ source: 'remote', peerId: 'synthetic' }, f.root.id, ac.signal));
  });
  await check('lane status names the FIRST blocking reason and reports bounded counters', async () => {
    const states = [
      [{ enabled: false, bodyEnabled: false, route: false, healthy: true }, 'off', /Structural continuity is off/],
      [{ enabled: true, bodyEnabled: false, route: true, healthy: true }, 'on', /handoff summaries are off/],
      [{ enabled: true, bodyEnabled: true, route: false, healthy: true }, 'on', /No model route resolves/],
      [{ enabled: true, bodyEnabled: true, route: true, healthy: false }, 'unavailable', /not ready/],
    ];
    for (const [state, structural, pattern] of states) {
      const lane = readContinuityLaneStatus(owner, state);
      assert.equal(lane.structural, structural, JSON.stringify(state));
      assert.match(lane.reason, pattern);
      assert.equal(typeof lane.pending, 'number'); assert.equal(typeof lane.handoffs, 'number');
    }
    const ready = readContinuityLaneStatus(owner, { enabled: true, bodyEnabled: true, route: true, healthy: true });
    // Counts must equal the durable rows (state-independent, so this holds
    // whatever the earlier checks left behind) and the reason must match the
    // branch those counts select.
    // This fixture never creates the optional work/handoff pair, so the reader
    // must treat an absent table as "no data yet" — exactly what a real lane
    // does before its first handoff.
    const countOr0 = (sql) => { try { return db.prepare(sql).get().n; } catch { return 0; } };
    const pending = countOr0("SELECT COUNT(*) AS n FROM main.continuity_jobs WHERE status='pending'");
    const handoffs = countOr0("SELECT COUNT(*) AS n FROM main.continuity_handoff");
    assert.equal(ready.pending, pending); assert.equal(ready.handoffs, handoffs);
    assert.match(ready.reason, handoffs > 0 ? /have a handoff that can be continued/ : pending > 0 ? /no handoff has been produced yet/ : /Nothing captured yet/);
    assert.ok(!JSON.stringify(ready).includes('session-'), 'lane status must never carry a session/project identity');
  });
  console.log(`${passes} actual native read-only inventory/business gates PASS; no authenticated Continue or live browser acceptance claimed`);
} finally { db.close(); await f.close(); }
