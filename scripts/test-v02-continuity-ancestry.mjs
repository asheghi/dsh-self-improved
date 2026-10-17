#!/usr/bin/env node
// Native in-memory SessionStore/SessionQuery lease tests; private source shadow
// only. No profile, GUI, production store, provider or permission changes.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no fallback/install');
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection']) assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.1-rc.2');
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-ancestry-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true }); cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)])) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { verifyContinuityAncestryV02: verify } = await own('continuity-ancestry-v02');
const { initContinuityProjectionV03, applyContinuityProjectionV03 } = await own('continuity-projection-v03');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { Context } = await native('cordis'); const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { SessionQueryEngine } = await native('dsh-session-query'); const { createUserMessage } = await native('dsh-llm');
const ctx = new Context(); const sf = ctx.plugin(SessionStore); await sf.await();
const pf = ctx.plugin(SessionProjectionRegistry); await pf.await();
const qf = ctx.plugin(SessionQueryEngine); await qf.await();
const query = ctx.sessionQuery, cwd = '/synthetic/ancestry-project', project = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
const root = ctx.sessions.create('RAW-ANCESTRY-ROOT-ID', { meta: { cwd } });
const human = session => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'PRIVATE-ANCESTRY-BODY-CANARY' }] }), { surfaceOp: 'append' });
human(root); root.append('turn/start', { turn: 1 });
root.append('tool/call', { turn: 1, step: 1, callId: 'RAW-ANCESTRY-TOOL-ID', name: 'synthetic', arguments: 'PRIVATE-ANCESTRY-ARGS-CANARY' });
const child = ctx.sessions.fork(root, undefined, 'RAW-ANCESTRY-CHILD-ID'); human(child);
let passes = 0;
const check = async (name, fn) => { await fn(); passes++; console.log('PASS ' + name); };
const signal = () => new AbortController().signal;
const tracked = (transform = x => x) => {
  const state = { reads: 0, drops: 0, ids: [] };
  return { state, async observeSession(id, options) {
    state.reads++; state.ids.push(id); assert.equal(options.projectionMode, 'none'); assert.ok(options.signal instanceof AbortSignal);
    const lease = await query.observeSession(id, options);
    return transform({ ...lease, [Symbol.dispose]() { state.drops++; lease[Symbol.dispose](); } }, id);
  } };
};
try {
  await check('state-v2 fold distinguishes an actual native fork candidate without granting admission', () => {
    const rootState = initContinuityProjectionV03(root.header, root.inheritedEventCount);
    const childState = initContinuityProjectionV03(child.header, child.inheritedEventCount);
    assert.equal(rootState.lineageKind, 'root');
    assert.equal(childState.lineageKind, 'fork-candidate');
    const ownEvents = child.ownEvents();
    const ownHuman = ownEvents.find(event => event.type === 'user/message' && event.data.source?.kind === 'user');
    assert.ok(ownHuman, 'native fork contains the appended child-owned human event');
    const folded = ownEvents.reduce(applyContinuityProjectionV03, childState);
    assert.equal(folded.lastHumanSeq, ownHuman.seq);
    assert.equal(folded.lineageKind, 'fork-candidate');
    assert.equal(Object.hasOwn(folded, 'verified'), false);
    assert.equal(Object.hasOwn(folded, 'allowed'), false);

    const directSubagent = ctx.sessions.create('native-v3-direct-subagent', {
      meta: { cwd, parentSession: root.id, isSeeded: false, origin: 'subagent', delegationDepth: 1 },
    });
    assert.equal(initContinuityProjectionV03(directSubagent.header, directSubagent.inheritedEventCount).lineageKind, 'denied');
    const childOfSubagent = ctx.sessions.fork(directSubagent, undefined, 'native-v3-fork-of-subagent');
    assert.equal(initContinuityProjectionV03(childOfSubagent.header, childOfSubagent.inheritedEventCount).lineageKind, 'fork-candidate',
      'header-only projection cannot prove parent provenance; the async ancestry verifier remains mandatory');
  });
  await check('genuine open-tail ordinary native fork verifies copied prefix excluding child marker/closers', async () => {
    const reads = tracked(); const proof = await verify(reads, child.id, project, signal());
    assert.equal(proof.ancestors.length, 1); assert.equal(proof.child.inheritedEventCount, 3);
    assert.equal(proof.ancestors[0].prefixCut, 2); assert.ok(proof.child.asOfSeq > 3);
    assert.equal(reads.state.reads, 2); assert.equal(reads.state.drops, 2);
    assert.deepEqual(Object.keys(proof).sort(), ['ancestors', 'child', 'format', 'projectId', 'proofHash'].sort());
    for (const row of [proof.child, ...proof.ancestors]) for (const key of ['sessionKey', 'headerHash', 'sourceHash', 'prefixHash']) assert.match(row[key], /^[a-f0-9]{64}$/);
    for (const raw of [root.id, child.id, 'PRIVATE-ANCESTRY', 'RAW-ANCESTRY-TOOL-ID', cwd]) assert.ok(!JSON.stringify(proof).includes(raw));
    const fresh = await verify(query, child.id, project, signal()); assert.deepEqual(proof, fresh);
    proof.ancestors[0].headerHash = 'detached'; assert.notEqual((await verify(query, child.id, project, signal())).ancestors[0].headerHash, 'detached');
  });
  await check('empty native fork and nonhuman root produce identity only, never intent/permission', async () => {
    const blank = ctx.sessions.create('blank-ancestry', { meta: { cwd } });
    const fork = ctx.sessions.fork(blank, undefined, 'empty-native-fork');
    const proof = await verify(query, fork.id, project, signal());
    assert.equal(proof.child.inheritedEventCount, 0); assert.equal(proof.ancestors[0].prefixCut, -1);
    assert.ok(!('lastHumanSeq' in proof)); assert.ok(!('allowed' in proof)); assert.ok(!('permission' in proof));
  });
  await check('direct seeded/unseeded subagents and marker-stripped fork of subagent deny', async () => {
    for (const seeded of [false, true]) {
      const sub = ctx.sessions.create('subagent-ancestry-' + seeded, { ...(seeded ? { seed: [], inheritedEventCount: 0 } : {}), meta: { cwd, parentSession: root.id, isSeeded: seeded, origin: 'subagent', delegationDepth: 1 } });
      human(sub); const guard = tracked(); await assert.rejects(verify(guard, sub.id, project, signal()), /delegated or unknown origin/);
      assert.equal(guard.state.drops, 1);
      const fork = ctx.sessions.fork(sub, undefined, 'fork-subagent-' + seeded); human(fork);
      assert.equal(fork.header.origin, undefined); assert.equal(fork.header.delegationDepth, undefined);
      const chain = tracked(); await assert.rejects(verify(chain, fork.id, project, signal()), /delegated or unknown origin/); assert.equal(chain.state.drops, 2);
    }
  });
  await check('missing ancestor and actual native cyclic headers fail closed with all acquired leases released', async () => {
    const missing = ctx.sessions.create('ancestry-missing', { seed: [], inheritedEventCount: 0, meta: { cwd, parentSession: 'unavailable-ancestor', isSeeded: true } });
    const guard = tracked(); await assert.rejects(verify(guard, missing.id, project, signal())); assert.equal(guard.state.drops, 1);
    ctx.sessions.create('ancestry-cycle-a', { seed: [], inheritedEventCount: 0, meta: { cwd, parentSession: 'ancestry-cycle-b', isSeeded: true } });
    ctx.sessions.create('ancestry-cycle-b', { seed: [], inheritedEventCount: 0, meta: { cwd, parentSession: 'ancestry-cycle-a', isSeeded: true } });
    const cycle = tracked(); await assert.rejects(verify(cycle, 'ancestry-cycle-a', project, signal()), /cycle/);
    assert.equal(cycle.state.reads, 2); assert.equal(cycle.state.drops, 2);
  });
  await check('foreign observed identity/project, unknown origin and malformed depth refuse', async () => {
    const foreign = ctx.sessions.create('foreign-ancestry-project', { meta: { cwd: '/synthetic/foreign-project' } });
    const fork = ctx.sessions.create('foreign-linked-child', { seed: [], inheritedEventCount: 0, meta: { cwd, parentSession: foreign.id, isSeeded: true } });
    const projectGuard = tracked(); await assert.rejects(verify(projectGuard, fork.id, project, signal()), /ownership mismatch/); assert.equal(projectGuard.state.drops, 2);
    for (const patch of [{ id: 'wrong-native-identity' }, { origin: 'unknown-producer' }, { origin: undefined }, { delegationDepth: undefined }, { parentSession: undefined }, { delegationDepth: -1 }, { delegationDepth: 0.5 }, { delegationDepth: NaN }, { delegationDepth: 1 }, { cwd: undefined }]) {
      const guard = tracked(lease => ({ ...lease, header: { ...lease.header, ...patch } }));
      await assert.rejects(verify(guard, child.id, project, signal())); assert.equal(guard.state.drops, 1);
    }
  });
  await check('genuine native altered or oversized inherited prefix cannot prove parent lineage', async () => {
    const observed = await query.observeSession(root.id, { projectionMode: 'none' });
    let seed; try { seed = structuredClone(observed.events); } finally { observed[Symbol.dispose](); }
    seed[0].data.content[0].text = 'FORGED-ANCESTRY-PREFIX';
    const forged = ctx.sessions.create('forged-seed-ancestry', { seed, inheritedEventCount: seed.length, meta: { cwd, parentSession: root.id, isSeeded: true } });
    const guard = tracked(); await assert.rejects(verify(guard, forged.id, project, signal()), /inherited prefix mismatch/); assert.equal(guard.state.drops, 2);
    const oversized = ctx.sessions.create('oversized-seed-ancestry', { seed: [...seed, { type: 'turn/end', seq: seed.length, time: 0, data: { turn: 1, reason: { kind: 'interrupted' } } }], inheritedEventCount: seed.length + 1, meta: { cwd, parentSession: root.id, isSeeded: true } });
    await assert.rejects(verify(query, oversized.id, project, signal()), /inherited prefix mismatch/);
  });
  await check('max16 ancestors allowed, seventeenth denied before extra acquisition; deeper subagent ancestor denied', async () => {
    let head = root;
    for (let i = 1; i <= 17; i++) head = ctx.sessions.fork(head, undefined, 'ancestry-depth-' + i);
    const exact = tracked(); assert.equal((await verify(exact, 'ancestry-depth-16', project, signal())).ancestors.length, 16);
    assert.equal(exact.state.reads, 17); assert.equal(exact.state.drops, 17);
    const exceeded = tracked(); await assert.rejects(verify(exceeded, head.id, project, signal()), /depth exceeded/);
    assert.equal(exceeded.state.reads, 17); assert.equal(exceeded.state.drops, 17);
    const subfork = ctx.sessions.fork(ctx.sessions.get('fork-subagent-true'), undefined, 'deep-fork-subagent');
    const delegated = tracked(); await assert.rejects(verify(delegated, subfork.id, project, signal()), /delegated or unknown origin/); assert.equal(delegated.state.drops, 3);
  });
  await check('already aborted caller is inert; held uncooperative ancestor acquisition cannot return late proof', async () => {
    const early = new AbortController(); early.abort(); const inert = tracked();
    await assert.rejects(verify(inert, child.id, project, early.signal), { name: 'AbortError' }); assert.equal(inert.state.reads, 0);
    let acquired, release; const ready = new Promise(resolve => { acquired = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const inner = tracked(); let ownedSignal;
    const delayed = { async observeSession(id, options) {
      ownedSignal = options.signal; const lease = await inner.observeSession(id, options);
      if (id === root.id) { acquired(); await gate; } return lease;
    } };
    const cancel = new AbortController(); const pending = verify(delayed, child.id, project, cancel.signal); await ready;
    cancel.abort(); assert.equal(ownedSignal.aborted, true); release(); await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(inner.state.drops, 2); assert.equal(inner.state.reads, 2);
  });
  await check('corrupt marker/cursor and throwing disposer refuse proof but release every accepted lease', async () => {
    for (const patch of [lease => ({ ...lease, cursor: lease.cursor + 1 }), lease => ({ ...lease, events: lease.events.map((event, i) => i === lease.inheritedEventCount ? { ...event, data: {} } : event) })]) {
      const guard = tracked(patch); await assert.rejects(verify(guard, child.id, project, signal())); assert.equal(guard.state.drops, 1);
    }
    let drops = 0; const throwing = { async observeSession(id, options) {
      const lease = await query.observeSession(id, options); return { ...lease, [Symbol.dispose]() { drops++; lease[Symbol.dispose](); if (id === root.id) throw Error('synthetic disposal failure'); } };
    } };
    await assert.rejects(verify(throwing, child.id, project, signal()), /lease disposal failed/); assert.equal(drops, 2);
  });
  console.log(`${passes} PASS / 0 FAIL; private fixture=${pkg}; identity only/no C integration or directhuman attestation`);
} finally { await qf.dispose(); await pf.dispose(); await sf.dispose(); }
