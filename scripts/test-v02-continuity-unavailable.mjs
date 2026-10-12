#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
const runtime = process.env.DSH_RUNTIME_RC2 ?? process.env.DSH_RUNTIME_DIR;
assert.ok(runtime, 'Explicit validated rc.2 checkout required');
const repo = fileURLToPath(new URL('../', import.meta.url)); mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-unavailable-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { MemoryStore } = await own('storage'); const { ContinuityStoreV02 } = await own('continuity-store-v02');
const { initContinuityProjection } = await own('continuity-projection-v02');
const { Context } = await native('cordis'); const { Loader } = await native('cordis-plugin-loader');
const { SessionStore } = await native('dsh-session'); const { SessionQueryEngine } = await native('dsh-session-query');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const dir = join(pkg, 'data'), id = 'previous-admitted-source', project = 'pj-' + 'a'.repeat(32);
const store = new MemoryStore(dir); const lane = new ContinuityStoreV02(store, z);
const gen = lane.setPolicy(id, project, true);
lane.enqueue({ format: 1, sessionId: id, headerHash: 'a'.repeat(64), inheritedEventCount: 0, asOfSeq: -1,
  sourceHash: 'b'.repeat(64), row: { ver: 1, seq: -1, val: initContinuityProjection({}, 0) } }, project, gen, 'turn-end'); store.close();
const root = new Context(); root.provide('settings', { configure: () => () => {} }); root.provide('systemPrompt', { section: () => {} });
root.provide('llm', { async *stream() { throw new Error('unexpected provider'); } }); root.provide('tools', { register: () => () => {} }); root.provide('commands', { register: () => () => {} });
const sf = root.plugin(SessionStore); await sf.await(); const qf = root.plugin(SessionQueryEngine); await qf.await();
// Deliberately NO sessionProjections capability, but actual query/session SDK.
let loader; const lf = root.plugin({ apply(ctx) { loader = new Loader(ctx, { baseUrl: pathToFileURL(join(pkg, 'lib') + '/').href }); } }); await lf.await();
const config = { enabled: true, debug: false, storageRoot: dir, searchLimit: 5,
  modules: { capture: true, extract: false, consolidate: false, evolve: false, recall: false, tools: false },
  extract: {}, recall: { embedding: {} }, consolidate: {}, evolve: { decay: {}, skillSynthesis: {} },
  housekeeping: {}, review: { enabled: false }, episodeLearning: { enabled: false } };
try {
  await loader.create({ id: 'self-improved', name: './index.js', config }); await loader.await();
  const db = new DatabaseSync(join(dir, 'memory.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT allowed FROM continuity_policy WHERE session_id=?').get(id).allowed, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM continuity_jobs WHERE status='pending'").get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM continuity_checkpoint').get().n, 0);
    console.log('PASS unavailable structural capability cannot bypass default-off durable denial');
  } finally { db.close(); }
  console.log('1 PASS / 0 FAIL; private fixture=' + pkg);
} finally { loader.remove('self-improved'); await loader.await(); await lf.dispose(); await qf.dispose(); await sf.dispose(); }
