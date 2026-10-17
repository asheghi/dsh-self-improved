#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Explicit validated rc.2 checkout required');
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-owner-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { MemoryStore } = await own('storage'); const { ContinuityStoreV02 } = await own('continuity-store-v02');
const { ContinuityOwnerV02 } = await own('continuity-owner-v02');
const { registerContinuityProjection } = await own('continuity-registry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { Session, SessionStore } = await native('dsh-session');
const { SessionQueryEngine } = await native('dsh-session-query'); const { createUserMessage } = await native('dsh-llm');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const ctx = new Context(); const sessionsFiber = ctx.plugin(SessionStore); await sessionsFiber.await();
const fiber = ctx.plugin(SessionProjectionRegistry); await fiber.await(); registerContinuityProjection(ctx, z);
const queryFiber = ctx.plugin(SessionQueryEngine); await queryFiber.await();
const query = ctx.sessionQuery;
const session = ctx.sessions.create('native-owner', { meta: { cwd: '/synthetic/project-owner' } });
session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE-CANONICAL-BODY' }] }), { surfaceOp: 'append' });
session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
const project = opaqueProjectIdFromKey(projectKeyFromCwd(session.header.cwd));
const dir = join(pkg, 'data'); let store = new MemoryStore(dir); let lane = new ContinuityStoreV02(store, z);
let allowed = true; let owner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, query, () => allowed); let passes = 0;
const check = async (name, fn) => { await fn(); passes++; console.log(`PASS ${name}`); };
try {
  await check('default admission denies and creates no work', async () => {
    const denied = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, query);
    assert.equal(await denied.capture(session, 'turn-end'), null); assert.equal(lane.listPending(project).length, 0);
  });
  let first;
  await check('trusted native session/project canonical cut persists only structural unfinished reference', async () => {
    first = await owner.capture(session, 'turn-end'); assert.equal(first.created, true);
    const saved = lane.readCheckpoint(session.id, project);
    assert.equal(saved.row.val.lastHumanSeq, 0); assert.equal(saved.row.val.turnState, 'interrupted');
    assert.equal(saved.asOfSeq, 1); assert.ok(!JSON.stringify(saved).includes('PRIVATE-CANONICAL-BODY'));
    assert.equal(lane.listPending('pj-' + 'f'.repeat(32)).length, 0);
  });
  await check('structural capture is independent of disabled summary consent epoch', async () => {
    const { syncContinuitySummaryPolicyV02 } = await own('continuity-summary-ledger-owner');
    store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(store.getJournalSqlite(), true));
    store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(store.getJournalSqlite(), false));
    assert.deepEqual(await owner.capture(session, 'turn-end'), { id: first.id, created: false });
    assert.equal(lane.listPending(project).length, 1);
    assert.equal(store.getJournalSqlite().prepare('SELECT allowed FROM continuity_summary_policy WHERE id=1').get().allowed, 0);
  });
  const before = lane.readPolicy(session.id);
  store.close(); store = new MemoryStore(dir); lane = new ContinuityStoreV02(store, z);
  owner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, query, () => allowed);
  await check('reconstructed owner preserves existing policy generation/checkpoint/job across SQLite reopen', async () => {
    assert.deepEqual(lane.readPolicy(session.id), before);
    assert.deepEqual(await owner.capture(session, 'turn-end'), { id: first.id, created: false });
    assert.deepEqual(lane.readPolicy(session.id), before);
    assert.equal(lane.listPending(project).length, 1);
  });
  await check('current denial revokes prior references and stale resume never resurrects them', async () => {
    allowed = false; assert.equal(await owner.capture(session, 'pause'), null);
    assert.equal(lane.listPending(project).length, 0); assert.equal(lane.readCheckpoint(session.id, project), null);
    allowed = true; const fresh = await owner.capture(session, 'turn-end'); assert.notEqual(fresh.id, first.id);
    assert.equal(lane.listPending(project).length, 1);
  });
  await check('disposed owner cannot rearm through late capture', async () => {
    const policy = lane.readPolicy(session.id); owner.dispose(); assert.equal(await owner.capture(session, 'finish'), null);
    assert.deepEqual(lane.readPolicy(session.id), policy); assert.equal(lane.listPending(project).length, 1);
  });
  await check('nonhuman native session cannot become an unfinished-work candidate', async () => {
    const empty = ctx.sessions.create('no-human-owner', { meta: { cwd: session.header.cwd } });
    assert.equal(await new ContinuityOwnerV02(lane, ctx.sessionProjections, z, query, () => true).capture(empty, 'turn-end'), null);
    assert.equal(lane.readCheckpoint(empty.id, project), null);
  });
  await check('missing current native project authority denies prior admitted work without guessing cwd', async () => {
    const missing = Session.create(session.id, undefined, { version: 4, id: session.id, createdAt: 0, isSeeded: false });
    const guard = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, query, () => false);
    assert.equal(await guard.capture(missing, 'pause'), null);
    assert.equal(lane.readPolicy(session.id).allowed, false);
    assert.equal(lane.readCheckpoint(session.id, project), null);
    assert.equal(lane.listPending(project).length, 0);
  });
  await check('late async observation cannot rearm disposed owner; acquired native lease is disposed', async () => {
    let release, ready; const acquired = new Promise(resolve => { ready = resolve; });
    const gate = new Promise(resolve => { release = resolve; }); let drops = 0;
    const delayed = { async observeSession(id, options) {
      const observation = await query.observeSession(id, options); ready(); await gate;
      return { ...observation, [Symbol.dispose]() { drops++; observation[Symbol.dispose](); } };
    } };
    const pendingOwner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, delayed, () => true);
    const pending = pendingOwner.capture(session, 'finish'); await acquired;
    pendingOwner.dispose(); release(); assert.equal(await pending, null); assert.equal(drops, 1);
    assert.equal(lane.listPending(project).length, 0);
  });
  await check('admission change during native async acquisition cancels old work and releases lease', async () => {
    let release, ready; const acquired = new Promise(resolve => { ready = resolve; });
    const gate = new Promise(resolve => { release = resolve; }); let drops = 0, consent = true;
    const delayed = { async observeSession(id, options) {
      const observation = await query.observeSession(id, options); ready(); await gate;
      return { ...observation, [Symbol.dispose]() { drops++; observation[Symbol.dispose](); } };
    } };
    const pendingOwner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, delayed, () => consent);
    const pending = pendingOwner.capture(session, 'finish'); await acquired;
    consent = false; release(); assert.equal(await pending, null); assert.equal(drops, 1);
    assert.equal(lane.readPolicy(session.id).allowed, false);
    assert.equal(lane.listPending(project).length, 0); pendingOwner.dispose();
  });
  await check('cold native header reordering and verified omitted delegationDepth zero preserve exact ownership', async () => {
    let drops = 0;
    const normalized = { async observeSession(id, options) { const observation = await query.observeSession(id, options);
      const header = { ...observation.header, delegationDepth: observation.header.delegationDepth ?? 0 };
      return { ...observation, header: Object.fromEntries(Object.keys(header).reverse().map(key => [key, header[key]])),
        [Symbol.dispose]() { drops++; observation[Symbol.dispose](); } };
    } };
    const guarded = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, normalized, () => true);
    assert(await guarded.capture(session, 'finish')); assert.equal(drops, 1); guarded.dispose();
    lane.ensurePolicy(session.id, project, false);
  });
  await check('foreign observed identity fails closed and disposes the actual native lease', async () => {
    let drops = 0;
    const wrong = { async observeSession(id, options) {
      const observation = await query.observeSession(id, options);
      return { ...observation, header: { ...observation.header, id: 'foreign-native-source' },
        [Symbol.dispose]() { drops++; observation[Symbol.dispose](); } };
    } };
    const guarded = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, wrong, () => true);
    await assert.rejects(guarded.capture(session, 'finish'), /ownership mismatch/);
    assert.equal(drops, 1); assert.equal(lane.listPending(project).length, 0); guarded.dispose();
  });
  console.log(`${passes} PASS / 0 FAIL; private fixture=${pkg}`);
} finally { store.close(); await queryFiber.dispose(); await fiber.dispose(); await sessionsFiber.dispose(); }
