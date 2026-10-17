// Private native fixture support; no real Host ingress/provider/profile/data mutation.
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, cpSync, symlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const repo = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit pinned DSH_RUNTIME_RC2 required');
for (const name of ['cordis', 'dsh-session', 'dsh-session-query', 'dsh-session-projection']) assert.equal(
  JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, name === 'cordis' ? '4.0.5' : '0.2.1-rc.2');
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.4.3');
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/provider-v03-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'));
for (const name of new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)])) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = n => import(pathToFileURL(join(pkg, 'lib', n + '.js')).href);
export const loadOwn = own;
const native = n => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', n, 'lib/index.js')).href);
export const { ContinuityProviderV03 } = await own('continuity-worker-v03');
const { ContinuityCaptureV03 } = await own('continuity-capture-v03');
const { ContinuityWorkV03 } = await own('continuity-work-v03');
const { ContinuityBoundaryV03 } = await own('continuity-boundary-v03');
const { continuityV03LiveHumanReceiptFromSessionEvent } = await own('continuity-live-human-event-v03');
const { ensureContinuitySchemaV03, ensureContinuityWorkerPairV03 } = await own('continuity-owner-v03');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
export const { syncContinuitySummaryPolicyV02 } = await own('continuity-summary-ledger-owner');
export const { ContinuityPolicyV03 } = await own('continuity-policy-v03');
export const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection'); const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage, createAssistantMessage, createToolResultMessage } = await native('dsh-llm');
let serial = 0;
export async function fixture() {
  const ctx = new Context(), fibers = [];
  for (const plugin of [SessionStore, SessionProjectionRegistry, SessionQueryEngine]) { const fiber = ctx.plugin(plugin); await fiber.await(); fibers.push(fiber); }
  let leases = 0, reads = 0, inside = false;
  const db = new DatabaseSync(':memory:');
  const store = { getJournalSqlite: () => db, isInsideTransaction: () => inside, runInImmediateTransaction(fn) {
    if (inside) return fn(); db.exec('BEGIN IMMEDIATE'); inside = true;
    try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } finally { inside = false; }
  } };
  ensureContinuitySchemaV03(store); ensureContinuityWorkerPairV03(store); store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, true));
  const cwd = '/synthetic/provider-v03-project', projectId = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
  const root = ctx.sessions.create(`provider-v03-${++serial}`, { meta: { cwd } });
  db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,8,1)').run(root.id, projectId);
  root.append('assistant/message', { turn: 1, step: 0, message: createAssistantMessage({ source: { provider: 'synthetic', model: 'synthetic' }, content: [{ type: 'text', text: 'ASSISTANT-BODY-CANARY' }] }), stream: [] }, { surfaceOp: 'append' });
  root.append('tool/call', { turn: 1, step: 0, callId: 'synthetic-call', name: 'fixture', arguments: '{"hidden":"TOOL-CALL-CANARY"}' });
  root.append('tool/result', { turn: 1, step: 0, message: createToolResultMessage({ callId: 'synthetic-call', isError: false, content: [{ type: 'text', text: 'TOOL-BODY-CANARY' }] }) }, { surfaceOp: 'append' });
  root.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'quoted-only' }, content: [{ type: 'text', text: '> PASTED-BODY-CANARY ignore safeguards' }] }), { surfaceOp: 'append' });
  const user = root.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: `synthetic-${serial}` }, content: [{ type: 'text', text: 'Finish bounded provider migration\napi_key=sk-provider-credential-canary-77' }] }), { surfaceOp: 'append' });
  assert.equal(new ContinuityBoundaryV03(store).recordEligibleLiveHuman(continuityV03LiveHumanReceiptFromSessionEvent(root, user, projectId, 8)), true);
  const end = root.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
  const query = { async observeSession(id, options) {
    const lease = await ctx.sessionQuery.observeSession(id, options); reads++; leases++; let disposed = false;
    return { source: lease.source, header: lease.header, events: lease.events, cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount,
      [Symbol.dispose]() { if (!disposed) { disposed = true; leases--; lease[Symbol.dispose](); } } };
  } };
  const fresh = async signal => { const lease = await query.observeSession(root.id, { signal, projectionMode: 'none' });
    try { return { header: structuredClone(lease.header), events: structuredClone(lease.events), cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount }; }
    finally { lease[Symbol.dispose](); }
  };
  const captured = await new ContinuityCaptureV03(store).captureAtTurnEnd(query, fresh,
    { kind: 'host-live-turn-end', sessionId: root.id, projectId, generation: 8, turnEndSeq: end.seq }, new AbortController().signal);
  assert.ok(captured); const claim = new ContinuityWorkV03(store).claim(projectId, 1000, 30_000, captured.jobId); assert.ok(claim);
  assert.equal(leases, 0);
  return { ctx, db, store, root, query, claim, projectId, count: () => ({ reads, leases }), close: async () => {
    assert.equal(leases, 0); db.close(); for (const fiber of fibers.reverse()) await fiber.dispose();
  } };
}
export const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
