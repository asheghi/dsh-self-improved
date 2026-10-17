#!/usr/bin/env node
// Actual private rc.2 sessions/SQLite and synthetic trusted admission/provider callbacks; no Host authority claim.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const repo = fileURLToPath(new URL('../', import.meta.url));
const runtimeRoot = process.env.DSH_RUNTIME_RC2;
assert.ok(runtimeRoot, 'Explicit pinned DSH_RUNTIME_RC2 required');
for (const name of ['cordis', 'dsh-session', 'dsh-session-query', 'dsh-session-projection']) assert.equal(
  JSON.parse(readFileSync(join(runtimeRoot, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version,
  name === 'cordis' ? '4.0.5' : '0.2.1-rc.2');
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/runtime-v03-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
for (const name of new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)])) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtimeRoot, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = n => import(pathToFileURL(join(pkg, 'lib', n + '.js')).href);
const native = n => import(pathToFileURL(join(runtimeRoot, 'node_modules/@deepseek-ai', n, 'lib/index.js')).href);
const { ContinuityRuntimeV03 } = await own('continuity-runtime-v03');
const { ContinuityCaptureV03 } = await own('continuity-capture-v03');
const { ContinuityBoundaryV03 } = await own('continuity-boundary-v03');
const { continuityV03LiveHumanReceiptFromSessionEvent } = await own('continuity-live-human-event-v03');
const { ensureContinuitySchemaV03, ensureContinuityWorkerPairV03 } = await own('continuity-owner-v03');
const { syncContinuitySummaryPolicyV02 } = await own('continuity-summary-ledger-owner');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm');
const ctx = new Context(), fibers = [];
let leases = 0, serial = 0, passes = 0;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const check = async (name, fn) => { await fn(); assert.equal(leases, 0); passes++; console.log('PASS ' + name); };
const observeLease = async (id, options) => {
  const lease = await ctx.sessionQuery.observeSession(id, options); leases++; let disposed = false;
  return { ...lease, header: lease.header, cursor: lease.cursor, events: lease.events, inheritedEventCount: lease.inheritedEventCount,
    [Symbol.dispose]() { if (!disposed) { disposed = true; leases--; lease[Symbol.dispose](); } } };
};
const query = { observeSession: observeLease };
async function fresh(id, signal) {
  const lease = await observeLease(id, { signal, projectionMode: 'none' });
  try { return { header: structuredClone(lease.header), events: structuredClone(lease.events), cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount }; }
  finally { lease[Symbol.dispose](); }
}
function fixture() {
  const cwd = '/synthetic/runtime-v03-project'; const projectId = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
  const db = new DatabaseSync(':memory:'); let inside = false;
  const store = { getJournalSqlite: () => db, isInsideTransaction: () => inside, runInImmediateTransaction(fn) {
    if (inside) return fn(); db.exec('BEGIN IMMEDIATE'); inside = true;
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; } finally { inside = false; }
  } };
  ensureContinuitySchemaV03(store); ensureContinuityWorkerPairV03(store);
  store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, true));
  const boundary = new ContinuityBoundaryV03(store); const approved = new WeakSet(); const generation = 8;
  const runtime = new ContinuityRuntimeV03(store, value => approved.has(value) ? value : null);
  function session() {
    const value = ctx.sessions.create(`runtime-v03-${++serial}`, { meta: { cwd } });
    db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)').run(value.id, projectId, generation);
    return value;
  }
  function nextReceipt(value, start = true) {
    const user = value.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: `synthetic-${++serial}` }, content: [{ type: 'text', text: 'SYNTHETIC-PRIVATE-HUMAN-TEXT' }] }), { surfaceOp: 'append' });
    const human = continuityV03LiveHumanReceiptFromSessionEvent(value, user, projectId, generation);
    assert.ok(human); assert.equal(boundary.recordEligibleLiveHuman(human), true);
    if (start) value.append('turn/start', { turn: serial });
    const end = value.append('turn/end', { turn: serial, reason: { kind: 'interrupted' } });
    const receipt = { kind: 'host-authenticated-turn-end', receiptId: `receipt-${++serial}`, request: { kind: 'host-live-turn-end', sessionId: value.id, projectId, generation, turnEndSeq: end.seq } };
    approved.add(receipt); return receipt;
  }
  const root = session(); const receipt = nextReceipt(root);
  let reads = 0, providers = 0;
  const hooks = { query, readFreshSource: async signal => { reads++; return fresh(root.id, signal); },
    summarize: async (_claim, signal) => { providers++; signal.throwIfAborted(); return { notes: ['Synthetic partial unverified orientation'] }; }, now: () => 1000, canSummarize: () => true };
  return { db, store, runtime, root, receipt, hooks, projectId, session, nextReceipt, counts: () => ({ reads, providers }), close: async () => { await runtime.dispose(); db.close(); } };
}
try {
  for (const plugin of [SessionStore, SessionProjectionRegistry, SessionQueryEngine]) { const fiber = ctx.plugin(plugin); await fiber.await(); fibers.push(fiber); }
  await check('default admission and forged cloned receipts deny before source/provider', async () => {
    const f = fixture(); try {
      const denied = new ContinuityRuntimeV03(f.store); assert.equal((await denied.onTrustedTurnEnd(f.receipt, f.hooks)).reason, 'untrusted-receipt');
      assert.equal((await f.runtime.onTrustedTurnEnd(structuredClone(f.receipt), f.hooks)).reason, 'untrusted-receipt');
      assert.deepEqual(f.counts(), { reads: 0, providers: 0 }); await denied.dispose();
    } finally { await f.close(); }
  });
  await check('structural capture survives omitted/false consent and disabled epoch without lease/provider/handoff', async () => {
    for (const [consent, enabled] of [[undefined, true], [() => false, true], [() => true, false], [() => false, false]]) {
      const f = fixture(); try {
        f.store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(f.db, enabled));
        const result = await f.runtime.onTrustedTurnEnd(f.receipt, { ...f.hooks, canSummarize: consent });
        assert.equal(result.kind, 'captured'); assert.equal(f.counts().providers, 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_jobs').get().n, 1);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_work').get().n, 0);
        assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 0);
        const checkpoint = f.db.prepare('SELECT * FROM continuity_checkpoint').get();
        assert.ok(!JSON.stringify(checkpoint).includes('SYNTHETIC-PRIVATE-HUMAN-TEXT'));
        assert.equal((await f.runtime.onTrustedTurnEnd(f.receipt, f.hooks)).reason, 'untrusted-receipt');
      } finally { await f.close(); }
    }
  });
  await check('summary consent revoke/re-enable during structural capture cannot borrow a fresh provider epoch', async () => {
    const f = fixture(); let changed = false; try {
      const result = await f.runtime.onTrustedTurnEnd(f.receipt, { ...f.hooks, readFreshSource: async signal => {
        const source = await fresh(f.root.id, signal);
        if (!changed) { changed = true; f.store.runInImmediateTransaction(() => {
          syncContinuitySummaryPolicyV02(f.db, false); syncContinuitySummaryPolicyV02(f.db, true);
        }); }
        return source;
      } });
      assert.equal(result.kind, 'captured'); assert.equal(f.counts().providers, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_work').get().n, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 0);
    } finally { await f.close(); }
  });
  await check('preabort performs no capture or source reads', async () => {
    const f = fixture(); try {
      const abort = new AbortController(); abort.abort(); assert.equal((await f.runtime.onTrustedTurnEnd(f.receipt, f.hooks, abort.signal)).kind, 'cancelled');
      assert.deepEqual(f.counts(), { reads: 0, providers: 0 }); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_jobs').get().n, 0);
    } finally { await f.close(); }
  });
  await check('actual native boundary completes a handoff, revalidates before provider, and rejects replay', async () => {
    const f = fixture(); try {
      const result = await f.runtime.onTrustedTurnEnd(f.receipt, f.hooks); assert.equal(result.kind, 'completed');
      assert.equal(f.counts().providers, 1); assert.ok(f.counts().reads >= 3);
      assert.equal(f.db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(result.jobId).status, 'completed');
      const payload = f.db.prepare('SELECT payload FROM continuity_handoff WHERE job_id=?').get(result.jobId).payload;
      assert.equal(payload.includes('SYNTHETIC-PRIVATE-HUMAN-TEXT'), false); assert.equal(JSON.parse(payload).uncertain, true);
      assert.equal((await f.runtime.onTrustedTurnEnd(f.receipt, f.hooks)).reason, 'untrusted-receipt'); assert.equal(f.counts().providers, 1);
    } finally { await f.close(); }
  });
  await check('older same-project job cannot borrow this receipt/source reader or receive a lease', async () => {
    const f = fixture(); try {
      const other = f.session(); const otherReceipt = f.nextReceipt(other, false);
      const queued = await new ContinuityCaptureV03(f.store).captureAtTurnEnd(query, signal => fresh(other.id, signal), otherReceipt.request, new AbortController().signal);
      assert.ok(queued); const result = await f.runtime.onTrustedTurnEnd(f.receipt, f.hooks); assert.equal(result.kind, 'completed');
      assert.notEqual(result.jobId, queued.jobId); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_work WHERE job_id=?').get(queued.jobId).n, 0);
    } finally { await f.close(); }
  });
  await check('source drift on pre-egress refresh denies before any provider call', async () => {
    const f = fixture(); let reads = 0; try {
      const hooks = { ...f.hooks, readFreshSource: async signal => { const source = await fresh(f.root.id, signal); if (++reads === 2) source.events[0].data.content[0].text = 'mutated'; return source; } };
      assert.equal((await f.runtime.onTrustedTurnEnd(f.receipt, hooks)).reason, 'stale'); assert.equal(f.counts().providers, 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 0);
    } finally { await f.close(); }
  });
  await check('policy epoch revocation while provider is held blocks all late handoff commits', async () => {
    const f = fixture(); const started = deferred(), release = deferred(); try {
      const pending = f.runtime.onTrustedTurnEnd(f.receipt, { ...f.hooks, summarize: async () => { started.resolve(); await release.promise; return { notes: ['late'] }; } });
      await started.promise; f.store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(f.db, false)); release.resolve();
      assert.equal((await pending).kind, 'cancelled'); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 0);
    } finally { release.resolve(); await f.close(); }
  });
  await check('dispose drains overlapping noncooperative providers and never acknowledges them', async () => {
    const f = fixture(); const started1 = deferred(), started2 = deferred(), release1 = deferred(), release2 = deferred();
    try {
      const first = f.runtime.onTrustedTurnEnd(f.receipt, { ...f.hooks, summarize: async () => { started1.resolve(); await release1.promise; return { notes: ['first late'] }; } });
      await started1.promise; const secondReceipt = f.nextReceipt(f.root);
      const second = f.runtime.onTrustedTurnEnd(secondReceipt, { ...f.hooks, summarize: async () => { started2.resolve(); await release2.promise; return { notes: ['second late'] }; } });
      await started2.promise; let disposed = false; const drain = f.runtime.dispose().then(() => { disposed = true; });
      await Promise.resolve(); assert.equal(disposed, false); release1.resolve(); assert.equal((await first).kind, 'cancelled');
      assert.equal(disposed, false); release2.resolve(); await drain; assert.equal((await second).kind, 'cancelled');
      assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 0);
      assert.equal((await f.runtime.onTrustedTurnEnd(secondReceipt, f.hooks)).reason, 'disposed');
    } finally { release1.resolve(); release2.resolve(); await f.close(); }
  });
  console.log(`${passes} actual native v3 runtime gates PASS; synthetic admission/provider only; no authenticated Host integration claimed; fixture=${pkg}`);
} finally { for (const fiber of fibers.reverse()) await fiber.dispose(); }
