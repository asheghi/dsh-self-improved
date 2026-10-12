#!/usr/bin/env node
// Synthetic recall-boundary regressions required by Phase B. No store/provider I/O.
//
// Lane ownership: this file (scripts/test-v02-revocation.mjs + the revocation
// related inject/redact lanes) belongs to the Phase B recall/inject lane;
// scripts/test-phase-a.mjs carries ONE coordinated tightening (its stub now
// wires a real revision provider) encoded in the review fix commit.
import { installRecallInjection } from '../lib/inject.js';
let failures = 0;
const marker = 'SYNTHETIC_REVOKED_FACT';
const hit = { id: 'synthetic-memory', kind: 'fact', content: marker, importance: 7, score: 1 };
const payload = () => ({ step: 1, agent: { id: 'synthetic-session' }, signal: new AbortController().signal });
const next = async () => ({ kind: 'enter', messages: [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'synthetic topic' }] }] });
function install(search, enabled = () => true, memoryRevision, eligibilityPolicyFingerprint) {
  let handler;
  installRecallInjection({ on(_name, fn) { handler = fn; } }, { search, searchOperational: () => [] }, {
    enabled, maxHits: 1, maxChars: 2000,
    sessionIdOf: () => 'synthetic-session', projectKeyOf: () => 'synthetic-project',
    ...(memoryRevision ? { memoryRevision } : {}),
    ...(eligibilityPolicyFingerprint ? { eligibilityPolicyFingerprint } : {}),
  });
  return handler;
}
function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  if (!condition) failures++;
}
{
  let available = true;
  const handler = install(async () => available ? [hit] : []);
  const first = await handler(payload(), next);
  check('positive control: eligible fact is recalled', JSON.stringify(first.messages).includes(marker));
  available = false;
  const second = await handler(payload(), next);
  check('identical query cannot replay evidence no longer eligible', !JSON.stringify(second.messages).includes(marker));
}
{
  let corrected = false;
  const handler = install(async () => [{ ...hit, content: corrected ? 'SYNTHETIC_CORRECTED_FACT' : marker }]);
  await handler(payload(), next);
  corrected = true;
  const second = await handler(payload(), next);
  check('identical query receives corrected eligible evidence', JSON.stringify(second.messages).includes('SYNTHETIC_CORRECTED_FACT'));
}
{
  let enabled = true;
  const handler = install(async () => { enabled = false; return [hit]; }, () => enabled);
  const decision = await handler(payload(), next);
  check('pause during retrieval prevents late context admission', !JSON.stringify(decision.messages).includes(marker));
}
// ── Phase B fenced-cache additions (same fixture shape; synthetic only) ──
{
  // Fenced replay: with a REAL revision provider wired and an unchanged
  // revision, the identical repeat turn is served from the fence-verified
  // cache without a re-search; the unchanged snapshot is not re-admitted
  // (the earlier durable snapshot already carries that state).
  let searches = 0;
  let revision = 7;
  const handler = install(() => { searches++; return [hit]; }, () => true, () => revision);
  const first = await handler(payload(), next);
  check('fenced cache: first turn admits', JSON.stringify(first.messages).includes(marker));
  const second = await handler(payload(), next);
  check('fenced cache: unchanged revision serves cached recall without re-search', searches === 1, `searches=${searches}`);
  check('fenced cache: identical repeat does not duplicate the durable snapshot', second.messages.length === 1, `messages=${second.messages.length}`);
}
{
  // Forget/correction commits bump the revision → the identical repeat turn
  // re-searches the NEWER state instead of replaying the fenced entry.
  let searches = 0;
  let revision = 7;
  let available = true;
  const handler = install(() => { searches++; return available ? [hit] : []; }, () => true, () => revision);
  const first = await handler(payload(), next);
  check('revision bump: first turn admits', JSON.stringify(first.messages).includes(marker));
  available = false; // a forget/correction/source-revocation committed
  revision = 8;
  const second = await handler(payload(), next);
  check('revision bump invalidates the fence and re-searches the newer state', searches === 2, `searches=${searches}`);
  check('identical query after revision bump cannot replay ineligible evidence', !JSON.stringify(second.messages).includes(marker));
}
{
  // A mutation racing the async search window (deferred search): the adapter
  // requeries against the newer state and admits the post-mutation truth.
  let searches = 0;
  let revision = 1;
  let available = true;
  const handler = install(async () => {
    searches++;
    if (searches === 1) {
      // Deferred search: the mutation commits WHILE the first search is in flight.
      await new Promise((r) => setImmediate(r));
      available = false;
      revision = 2;
      return [hit]; // pre-mutation snapshot: stale, must not be trusted
    }
    return [];
  }, () => true, () => revision);
  const out = await handler(payload(), next);
  check('deferred-search race requeries against the newer state', searches === 2, `searches=${searches}`);
  check('stale pre-mutation snapshot is not admitted', !JSON.stringify(out.messages).includes(marker));
}
{
  // A policy/consent change that the store revision cannot express (e.g.
  // recall thresholds) must invalidate a fenced replay the same way: the
  // identical query re-searches, and the (still identical) rendered block is
  // NOT duplicated by the unchanged-snapshot gate.
  let searches = 0;
  let turns = 0;
  const handler0 = install(() => { searches++; return [hit]; }, () => true, () => 3,
    () => (turns >= 2 ? 'policy-v2' : 'policy-v1'));
  const handler = (...args) => { turns++; return handler0(...args); };
  await handler(payload(), next);
  const second = await handler(payload(), next);
  check('policy fingerprint change forces a fresh search on the identical query', searches === 2, `searches=${searches}`);
  check('policy change does not re-admit an unchanged snapshot', second.messages.length === 1, `messages=${second.messages.length}`);
}
{
  // Unreliable revision provider (throws on a mid-run read): fail closed —
  // no replay, no admission built on unprovable state. Three healthy reads
  // admit the first turn (turn-start, post-search fence, final gate).
  let reads = 0;
  const handler = install(() => [hit], () => true, () => { if (++reads >= 4) throw new Error('synthetic read failure'); return 5; });
  const first = await handler(payload(), next);
  check('healthy revision reads admit normally', JSON.stringify(first.messages).includes(marker), `reads=${reads}`);
  const second = await handler(payload(), next);
  check('revision read failure fails closed (no replay, no admission)', !JSON.stringify(second.messages).includes(marker));
}
{
  // Non-monotonic revision (recreated backend mid-run): the fence contract is
  // violated → refuse the admission instead of trusting the row state.
  let calls = 0;
  const handler = install(() => [hit], () => true, () => (calls++ < 3 ? 9 : 2));
  await handler(payload(), next);
  const second = await handler(payload(), next);
  check('non-monotonic revision regression is refused (fail closed)', !JSON.stringify(second.messages).includes(marker));
}
{
  // A refused generation (pause during retrieval) must leave NO side effect:
  // access attribution never runs for content that was not admitted.
  let bumped = 0;
  let enabled = true;
  const hitIds = [];
  let handler;
  installRecallInjection({ on(_n, fn) { handler = fn; } }, {
    async search() { enabled = false; return [hit]; },
    searchOperational: () => [],
  }, {
    enabled: () => enabled, maxHits: 1, maxChars: 2000,
    sessionIdOf: () => 'synthetic-session', projectKeyOf: () => 'synthetic-project',
    onInjected: (ids) => { bumped++; hitIds.push(...ids); },
  });
  const refused = await handler(payload(), next);
  check('refused generation does not bump any memory access (no side effect to roll back)', bumped === 0 && hitIds.length === 0, `bumped=${bumped}`);
  check('refused generation returns the decision untouched (same message count)', refused.messages.length === 1);
}
{
  // An unwired revision provider can never masquerade as durability: no replay
  // path is taken, each turn decides from fresh current state.
  let searches = 0;
  const handler = install(() => { searches++; return [hit]; });
  await handler(payload(), next);
  await handler(payload(), next);
  check('unwired revision: identical repeat still decides from fresh state (no replay)', searches === 2, `searches=${searches}`);
}
if (failures) process.exitCode = 1;
console.log(`Revocation boundary regressions: ${failures ? 'FAILED' : 'PASS'}`);