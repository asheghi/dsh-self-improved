import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { loadOwn } from './continuity-v03-provider-fixture.mjs';
const { createMemoryBusiness } = await loadOwn('business');
const { readContinuityUiOfferNotes, readContinuityUiInventory } = await loadOwn('continuity-inventory-ui');

let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log('PASS ' + name); }

const TARGET = 'native-target-session';
const JOB = 'job-1';
const REMOTE = peerId => ({ source: 'remote', peerId });
const lenientGates = { enabled: () => true, allows: () => true, healthy: () => true };
const passesInventory = { availability: 'ready', canContinue: true, reason: 'one offer', rows: [], offers: [{ jobId: JOB, sessionId: 'source-session', cut: 8 }] };

/**
 * The door is the WHOLE authorization model for Continue:
 *   - only a Gateway-dispatched call carries a peer,
 *   - and the operator's confirm is a second round trip bound to that peer
 *     AND the exact offer.
 * A message the model wrote, a tool call, or any other in-process caller has
 * no peer, so it can never open a handoff. These gates prove that.
 */
await check('Continue refuses every in-process caller before the delegate can run', async () => {
  let calls = 0;
  const business = createMemoryBusiness({ store: {}, skillsPrefix: () => '', episodeEnabled: () => false, enabled: () => true,
    continuityStatus: async () => passesInventory,
    continuityOfferNotes: async () => { calls++; return { jobId: JOB, sessionId: 'source-session', cut: 8, notes: ['x'], uncertain: true }; } });

  // The /memory command lane: a human typed it, but it travels the message path.
  assert.throws(() => business.prepareContinue({ source: 'command', peerId: null }, TARGET, JOB), /operator action/);
  await assert.rejects(business.continueSession({ source: 'command', peerId: null }, TARGET, JOB, { token: 'anything' }), /operator action/);
  // A remote call without a gateway peer is not a door either.
  assert.throws(() => business.prepareContinue(REMOTE(null), TARGET, JOB), /operator action/);
  assert.throws(() => business.prepareContinue(REMOTE(''), TARGET, JOB), /operator action/);
  // No token at all never reaches the delegate.
  await assert.rejects(business.continueSession(REMOTE('peer-1'), TARGET, JOB, { token: '' }), /one-shot token/);
  await assert.rejects(business.continueSession(REMOTE('peer-1'), TARGET, JOB, undefined), /one-shot token/);
  assert.equal(calls, 0, 'no refused caller may read a handoff body');
});

await check('Continue needs the peer-bound one-shot confirm: replay, relay and different-args all fail', async () => {
  const seen = [];
  const business = createMemoryBusiness({ store: {}, skillsPrefix: () => '', episodeEnabled: () => false, enabled: () => true,
    continuityStatus: async () => passesInventory,
    continuityOfferNotes: async (target, jobId) => { seen.push([target, jobId]); return { jobId, sessionId: 'source-session', cut: 8, notes: ['ran the tests'], uncertain: true }; } });

  const prepared = business.prepareContinue(REMOTE('peer-1'), TARGET, JOB);
  assert.equal(prepared.op, 'continue');
  assert.equal(typeof prepared.token, 'string');
  assert.ok(prepared.token.length > 0);
  assert.ok(prepared.ttlMs > 0);

  // A different connection (relayed token) is refused. The confirm is burned
  // on the attempt (one-shot, exactly like the memory mutation handshake), so
  // every negative case re-stages its own confirm.
  const forPeer2 = business.prepareContinue(REMOTE('peer-1'), TARGET, JOB).token;
  await assert.rejects(business.continueSession(REMOTE('peer-2'), TARGET, JOB, { token: forPeer2 }), /exact-args\/peer binding/);
  // The minted confirm is bound to THIS offer: another job cannot spend it.
  const forOtherJob = business.prepareContinue(REMOTE('peer-1'), TARGET, JOB).token;
  await assert.rejects(business.continueSession(REMOTE('peer-1'), TARGET, 'job-2', { token: forOtherJob }), /exact-args\/peer binding/);
  assert.equal(seen.length, 0, 'no refused confirm may read a handoff body');

  const notes = await business.continueSession(REMOTE('peer-1'), TARGET, JOB, { token: business.prepareContinue(REMOTE('peer-1'), TARGET, JOB).token });
  assert.deepEqual(seen, [[TARGET, JOB]]);
  assert.equal(notes.jobId, JOB);
  assert.deepEqual([...notes.notes], ['ran the tests']);
  assert.equal(notes.uncertain, true);

  // One shot: the same confirm can never be spent twice.
  const replay = business.prepareContinue(REMOTE('peer-1'), TARGET, JOB).token;
  await business.continueSession(REMOTE('peer-1'), TARGET, JOB, { token: replay });
  await assert.rejects(business.continueSession(REMOTE('peer-1'), TARGET, JOB, { token: replay }), /exact-args\/peer binding/);
  assert.equal(seen.length, 2, 'a replayed confirm may not read a second handoff');
});

await check('a withdrawn offer returns null instead of stale notes, and invalid identities are refused', async () => {
  const business = createMemoryBusiness({ store: {}, skillsPrefix: () => '', episodeEnabled: () => false, enabled: () => true,
    continuityStatus: async () => passesInventory, continuityOfferNotes: async () => null });
  const prepared = business.prepareContinue(REMOTE('peer-1'), TARGET, JOB);
  assert.equal(await business.continueSession(REMOTE('peer-1'), TARGET, JOB, { token: prepared.token }), null);

  const noDelegate = createMemoryBusiness({ store: {}, skillsPrefix: () => '', episodeEnabled: () => false, enabled: () => true });
  const staged = noDelegate.prepareContinue(REMOTE('peer-1'), TARGET, JOB);
  assert.equal(await noDelegate.continueSession(REMOTE('peer-1'), TARGET, JOB, { token: staged.token }), null);

  assert.throws(() => business.prepareContinue(REMOTE('peer-1'), '', JOB), /target session identity/);
  assert.throws(() => business.prepareContinue(REMOTE('peer-1'), TARGET, ''), /handoff job identity/);
  assert.throws(() => business.prepareContinue(REMOTE('peer-1'), `${TARGET}\0`, JOB), /target session identity/);
  assert.throws(() => business.prepareContinue(REMOTE('peer-1'), TARGET, `${JOB}\0`), /handoff job identity/);
  assert.throws(() => business.prepareContinue(REMOTE('peer-1'), 'x'.repeat(513), JOB), /target session identity/);
});

await check('the notes reader stays fail-closed without a validated lane or an offered job', async () => {
  const db = new DatabaseSync(':memory:');
  const owner = { getJournalSqlite: () => db };
  const lease = () => Promise.resolve({ header: { id: TARGET, cwd: '/synthetic/project' }, inheritedEventCount: 0, cursor: 0, events: [],
    [Symbol.dispose]() {} });
  const query = { observeSession: () => lease() };
  const handoffs = { list: () => [], read: () => ({ jobId: JOB, sessionId: 'source-session', cut: 8, projectId: 'pj-' + 'a'.repeat(32), generation: 1, sourceHash: 'f'.repeat(64), notes: ['secret'], uncertain: true }) };
  // No reader at all: nothing to read.
  assert.equal(await readContinuityUiOfferNotes(owner, query, TARGET, JOB, lenientGates, undefined), null);
  // No validated continuity lane in this store: refuse rather than guess.
  assert.equal(await readContinuityUiOfferNotes(owner, query, TARGET, JOB, lenientGates, handoffs), null);
  // Policy denial never reads source or notes.
  const denied = { enabled: () => true, allows: () => false, healthy: () => true };
  assert.equal(await readContinuityUiOfferNotes(owner, query, TARGET, JOB, denied, handoffs), null);
  // Malformed job identity is refused before any work.
  assert.equal(await readContinuityUiOfferNotes(owner, query, TARGET, '', lenientGates, handoffs), null);
  assert.equal(await readContinuityUiOfferNotes(owner, query, TARGET, 'bad\0id', lenientGates, handoffs), null);
  // The inventory stays body-free and offer-shaped, and never reports ready
  // for a target the lineage classifier does not positively accept.
  const inventory = await readContinuityUiInventory(owner, query, TARGET, lenientGates, undefined, 1000, handoffs);
  assert.notEqual(inventory.availability, 'ready');
  assert.deepEqual(inventory.offers, []);
  assert.equal(inventory.canContinue, false);
  db.close();
});

console.log(`${passes} operator-door Continue gates PASS (business door + fail-closed reader; mounted browser Continue remains a separate gate)`);
