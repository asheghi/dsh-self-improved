#!/usr/bin/env node
/**
 * scripts/test-v02-recall-ledger.mjs — the "why did this appear?" inspector.
 *
 * The ledger must stay bounded and honest: it records only ids that were really
 * rendered, keeps a bounded window per session and a bounded number of sessions,
 * attributes a session-less delivery to the anonymous bucket instead of dropping
 * it, and never presents itself as evidence.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../', import.meta.url));
const { RecallLedger } = await import(join(repo, 'lib/recall-ledger.js'));
const { MemoryStore } = await import(join(repo, 'lib/storage.js'));
const { handleMemoryCommand } = await import(join(repo, 'lib/commands.js'));

let passes = 0, failures = 0;
const check = (name, fn) => {
  try { fn(); passes++; console.log('PASS ' + name); }
  catch (error) { failures++; console.log('FAIL ' + name + ' :: ' + (error && error.message)); }
};

check('the ledger records real deliveries, newest last, and ignores empty ones', () => {
  const ledger = new RecallLedger();
  ledger.record('s-1', { query: 'first', ids: ['m1'], at: 1 });
  ledger.record('s-1', { query: 'second', ids: ['m2', 'm3'], at: 2 });
  ledger.record('s-1', { query: 'nothing rendered', ids: [], at: 3 });
  const list = ledger.list('s-1');
  assert.equal(list.length, 2, 'a delivery that rendered nothing is not a delivery');
  assert.deepEqual(list.map((d) => d.ids.length), [1, 2]);
  assert.equal(list[1].query, 'second');
  assert.deepEqual(ledger.list('unknown-session'), []);
});
check('a session-less delivery is attributed, not dropped', () => {
  const ledger = new RecallLedger();
  ledger.record('', { query: 'no session scope', ids: ['m1'], at: 1 });
  assert.equal(ledger.list('').length, 1);
});
check('the window is bounded per session and evicts whole sessions', () => {
  const ledger = new RecallLedger();
  for (let i = 0; i < 30; i++) ledger.record('s-1', { query: `q${i}`, ids: [`m${i}`], at: i });
  const list = ledger.list('s-1');
  assert.equal(list.length, 20, 'only the last 20 deliveries are kept');
  assert.equal(list[0].query, 'q10'); assert.equal(list[19].query, 'q29');
  for (let s = 0; s < 60; s++) ledger.record(`session-${s}`, { query: 'q', ids: ['m1'], at: s });
  assert.equal(ledger.sessions, 50, 'the session map is bounded');
  assert.equal(ledger.list('s-1').length, 0, 'the least recently used session was evicted');
  assert.equal(ledger.list('session-59').length, 1);
});
check('long queries are clipped for display only', () => {
  const ledger = new RecallLedger();
  ledger.record('s-1', { query: 'x'.repeat(500), ids: ['m1'], at: 1 });
  assert.equal(ledger.list('s-1')[0].query.length, 160);
});
check('the command explains a session and refuses to imply the numbers mean anything', () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'dsi-ledger-')), 'store');
  const store = new MemoryStore(dir);
  const ledger = new RecallLedger();
  const opts = { recallSessionId: 's-1', recallLedger: () => ledger };
  assert.match(handleMemoryCommand(store, 'used', opts).text, /No memory has been injected/);
  ledger.record('s-1', { query: 'deploy steps', ids: ['m-alpha', 'm-beta'], at: 1700000000000 });
  ledger.record('other-session', { query: 'elsewhere', ids: ['m-other'], at: 1700000000001 });
  const shown = handleMemoryCommand(store, 'used', opts);
  assert.equal(shown.kind, 'success');
  assert.match(shown.text, /m-alpha, m-beta/);
  assert.match(shown.text, /deploy steps/);
  assert.doesNotMatch(shown.text, /m-other/, 'another session is never shown');
  assert.match(shown.text, /not evidence that any of it helped/i);
  assert.match(handleMemoryCommand(store, 'used', {}).text, /unavailable/);
  store.close();
});

console.log(`${passes} recall-ledger gates PASS, ${failures} FAIL`);
process.exit(failures === 0 ? 0 : 1);
