#!/usr/bin/env node
// Private actual-rc.2 native-session fixture for stable historical lineage identity.
// It does not wire fork admission, call a provider, install a profile, or grant authority.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, cpSync, symlinkSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no fallback/install');
for (const name of ['dsh-session', 'dsh-session-query', 'dsh-session-projection']) {
  assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.1-rc.2');
}
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.4.3');
const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
const repo = fileURLToPath(new URL('../', import.meta.url));
mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
const pkg = mkdtempSync(join(repo, '.tmp-import-lane/continuity-lineage-binding-'));
cpSync(join(repo, 'lib'), join(pkg, 'lib'), { recursive: true });
cpSync(join(repo, 'package.json'), join(pkg, 'package.json'));
const manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8'));
for (const name of new Set([...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)])) {
  const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
  const target = join(pkg, 'node_modules', name);
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync(from, target);
}
const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
const { verifyContinuityAncestryV02: verifyCurrent,
  verifyContinuityHistoricalLineageBindingV02: bindHistorical,
  verifyContinuityHistoricalLineageSnapshotV02: verifyHistoricalSnapshot,
  CONTINUITY_HISTORICAL_LINEAGE_FORMAT: FORMAT,
  CONTINUITY_LINEAGE_BINDING_VERSION: BINDING_VERSION } = await own('continuity-ancestry-v02');
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
const { continuityCanonicalDigest: digest, continuityCanonicalHeader } = await own('continuity-checkpoint-v02');
const { createContinuityCheckpointEnvelopeV03, createContinuityCheckpointEnvelopeWithLineageSnapshotV03,
  isContinuityV03JobSourceCurrent } = await own('continuity-source-v03');
const { ContinuityBoundaryV03 } = await own('continuity-boundary-v03');
const { ContinuityCaptureV03 } = await own('continuity-capture-v03');
const { ContinuityPolicyV03 } = await own('continuity-policy-v03');
const { syncContinuitySummaryPolicyV02, readContinuitySummaryPolicyEpochV02 } = await own('continuity-summary-ledger-owner');
const { continuityV03LiveHumanReceiptFromSessionEvent } = await own('continuity-live-human-event-v03');
const { ContinuityPromptReceiptLedgerV03 } = await own('continuity-prompt-receipt-v03');
const { ContinuityWorkV03 } = await own('continuity-work-v03');
const { ContinuityPreviewV03 } = await own('continuity-preview-v03');
const { composeContinuityPreviewLineagePolicyStampV03 } = await own('continuity-lineage-policy-v03');
const { ensureContinuitySchemaV03, ensureContinuityWorkerPairV03 } = await own('continuity-owner-v03');
const { parseContinuityCheckpointEnvelopeV03, parseContinuityV03JobAnchor, parseContinuityV03HandoffPayload } = await own('continuity-envelope-v03');
const { preflightContinuityV03Rows } = await own('continuity-v03-row-preflight');
const { Context } = await native('cordis');
const { SessionStore } = await native('dsh-session');
const { SessionProjectionRegistry } = await native('dsh-session-projection');
const { SessionQueryEngine } = await native('dsh-session-query');
const { createUserMessage } = await native('dsh-llm');
const ctx = new Context();
const sf = ctx.plugin(SessionStore); await sf.await();
const pf = ctx.plugin(SessionProjectionRegistry); await pf.await();
const qf = ctx.plugin(SessionQueryEngine); await qf.await();
const query = ctx.sessionQuery;
const cwd = '/synthetic/historical-lineage-project';
const project = opaqueProjectIdFromKey(projectKeyFromCwd(cwd));
const root = ctx.sessions.create('RAW-LINEAGE-ROOT-ID', { meta: { cwd } });
const addHuman = (session, text) => session.append('user/message', createUserMessage({
  source: { kind: 'user' }, content: [{ type: 'text', text }],
}), { surfaceOp: 'append' });
const addUserRpcHuman = (session, text, rpcId) => session.append('user/message', createUserMessage({
  source: { kind: 'user', rpcId }, content: [{ type: 'text', text }],
}), { surfaceOp: 'append' });
const observe = async id => {
  const lease = await query.observeSession(id, { signal: new AbortController().signal, projectionMode: 'none' });
  try { return { cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount }; }
  finally { lease[Symbol.dispose](); }
};
const observeFullWithSignal = async (id, signal) => {
  const lease = await query.observeSession(id, { signal, projectionMode: 'none' });
  try { return { header: structuredClone(lease.header), events: structuredClone(lease.events),
    cursor: lease.cursor, inheritedEventCount: lease.inheritedEventCount }; }
  finally { lease[Symbol.dispose](); }
};
const observeFull = id => observeFullWithSignal(id, new AbortController().signal);
const sqliteOwner = (db, failAt = Number.POSITIVE_INFINITY) => {
  let inside = false;
  let transactions = 0;
  return {
    getJournalSqlite: () => db,
    isInsideTransaction: () => inside,
    runInImmediateTransaction(operation) {
      if (inside) return operation();
      db.exec('BEGIN IMMEDIATE'); inside = true;
      try {
        const value = operation();
        transactions++;
        if (transactions === failAt) throw new Error('injected handoff commit failure');
        db.exec('COMMIT'); return value;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch {}
        throw error;
      } finally { inside = false; }
    },
  };
};
const passes = [];
const check = async (name, fn) => { await fn(); passes.push(name); console.log('PASS ' + name); };
const withRewrite = (targetId, rewrite) => ({ async observeSession(id, options) {
  const lease = await query.observeSession(id, options);
  if (id !== targetId) return lease;
  return { ...lease, ...rewrite(lease), [Symbol.dispose]() { lease[Symbol.dispose](); } };
} });

try {
  await check('durable summary privacy epoch reader is read-only and default-deny', async () => {
    const epochDb = new DatabaseSync(':memory:');
    try {
      assert.equal(readContinuitySummaryPolicyEpochV02(epochDb), null, 'absent owner state has no usable epoch');
      const epochOwner = sqliteOwner(epochDb);
      assert.equal(epochOwner.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(epochDb, true)), 0);
      assert.equal(readContinuitySummaryPolicyEpochV02(epochDb), 0);
      const beforeRead = JSON.stringify({ schema: epochDb.prepare("SELECT type,name,sql FROM main.sqlite_schema ORDER BY type,name").all(),
        rows: epochDb.prepare('SELECT * FROM main.continuity_summary_policy').all() });
      assert.equal(readContinuitySummaryPolicyEpochV02(epochDb), 0);
      assert.equal(JSON.stringify({ schema: epochDb.prepare("SELECT type,name,sql FROM main.sqlite_schema ORDER BY type,name").all(),
        rows: epochDb.prepare('SELECT * FROM main.continuity_summary_policy').all() }), beforeRead, 'epoch read performs no writes');
      assert.equal(epochOwner.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(epochDb, false)), 1);
      assert.equal(readContinuitySummaryPolicyEpochV02(epochDb), null, 'disabled summary/body policy has no usable epoch');
      assert.equal(epochOwner.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(epochDb, true)), 2);
      assert.equal(readContinuitySummaryPolicyEpochV02(epochDb), 2, 're-enable advances the durable ABA fence');
    } finally { epochDb.close(); }
  });
  addHuman(root, 'root original evidence LINEAGE-PRIVATE-CANARY');
  addHuman(root, 'second root event for a longer inherited prefix');
  addHuman(root, 'third root event for a longer inherited prefix');
  const child = ctx.sessions.fork(root, undefined, 'RAW-LINEAGE-CHILD-ID');
  addHuman(child, 'child evidence LINEAGE-PRIVATE-CANARY');
  // Copy only event 0: the descendant's inherited floor is shorter than the
  // intermediate parent's own inherited floor from the root.
  const descendant = ctx.sessions.fork(child, 0, 'RAW-LINEAGE-DESCENDANT-ID');
  addHuman(descendant, 'selected descendant evidence LINEAGE-PRIVATE-CANARY');
  const selected = await observe(descendant.id);
  const cut = selected.cursor;
  const stop = () => new AbortController().signal;
  let currentnessJobRow;

  await check('versioned binding is strict, ordered, body-free identity only', async () => {
    const nodes = await Promise.all([descendant, child, root].map(session => observeFull(session.id)));
    const binding = await bindHistorical(query, descendant.id, project, cut, stop());
    assert.equal(binding.format, FORMAT); assert.equal(binding.bindingVersion, BINDING_VERSION);
    assert.equal(binding.format, 2); assert.equal(binding.bindingVersion, 3);
    assert.deepEqual(Object.keys(binding).sort(), ['bindingHash', 'bindingVersion', 'child', 'edges', 'format', 'projectId', 'rootSessionKey'].sort());
    assert.deepEqual(Object.keys(binding.child).sort(), ['headerHash', 'inheritedEventCount', 'selectedCut', 'selectedSourceHash', 'sessionKey'].sort());
    assert.equal(binding.edges.length, 2);
    assert.deepEqual(binding.edges.map(edge => edge.childInheritedEventCount), nodes.slice(0, 2).map(node => node.inheritedEventCount));
    assert.deepEqual(binding.edges.map(edge => edge.parentInheritedEventCount), nodes.slice(1).map(node => node.inheritedEventCount));
    assert.ok(nodes[0].inheritedEventCount < nodes[1].inheritedEventCount, 'descendant must copy only part of intermediate parent inherited prefix');
    for (let index = 0; index < binding.edges.length; index++) {
      const edge = binding.edges[index];
      const expectedCut = nodes[index].inheritedEventCount - 1;
      assert.equal(edge.copiedPrefixCut, expectedCut);
      assert.equal(edge.copiedPrefixHash, digest(nodes[index + 1].events.slice(0, expectedCut + 1)));
    }
    assert.equal(binding.rootSessionKey, binding.edges.at(-1).parentSessionKey);
    for (const hash of [binding.bindingHash, binding.rootSessionKey, binding.child.headerHash, binding.child.selectedSourceHash,
      binding.child.sessionKey, ...binding.edges.flatMap(edge => [edge.childSessionKey, edge.parentSessionKey,
        edge.childHeaderHash, edge.parentHeaderHash, edge.copiedPrefixHash])]) assert.match(hash, /^[a-f0-9]{64}$/);
    for (const raw of [root.id, child.id, descendant.id, cwd, 'LINEAGE-PRIVATE-CANARY']) assert.ok(!JSON.stringify(binding).includes(raw));

    const envelope = await createContinuityCheckpointEnvelopeV03(query, nodes[0], project, 3, cut, stop());
    assert.equal(envelope.lineageKind, 'fork');
    assert.equal(envelope.lineage.bindingHash, binding.bindingHash);
    assert.equal(envelope.selectedSourceHash, binding.child.selectedSourceHash);
    assert.equal(envelope.row.val.lineageKind, 'fork-candidate');
    assert.deepEqual(parseContinuityCheckpointEnvelopeV03(envelope), envelope);
    const jobRow = {
      id: '77777777-7777-7777-7777-777777777777', session_id: envelope.sessionId, project_id: envelope.projectId,
      generation_text: '3', cut_text: String(cut), source_hash: envelope.sourceHash,
      checkpoint_format: envelope.checkpointFormat, source_binding_version: envelope.sourceBindingVersion,
      selected_source_hash: envelope.selectedSourceHash, lineage_format: envelope.lineage.format,
      lineage_binding_version: envelope.lineage.bindingVersion, lineage_kind: envelope.lineageKind,
      lineage_hash: envelope.lineageHash, trigger: 'turn-end', status: 'pending',
    };
    currentnessJobRow = jobRow;
    assert.equal(await isContinuityV03JobSourceCurrent(query, nodes[0], jobRow, stop()), true);
    assert.equal(await isContinuityV03JobSourceCurrent(query, nodes[0],
      { ...jobRow, selected_source_hash: 'f'.repeat(64) }, stop()), false);
    const envelopeText = JSON.stringify(envelope);
    for (const raw of [root.id, child.id, cwd, 'LINEAGE-PRIVATE-CANARY']) assert.ok(!envelopeText.includes(raw));
    const alteredObservation = structuredClone(nodes[0]);
    const last = alteredObservation.events.length - 1;
    alteredObservation.events[last] = { ...alteredObservation.events[last],
      data: { ...alteredObservation.events[last].data, content: [{ type: 'text', text: 'altered detached source' }] } };
    await assert.rejects(createContinuityCheckpointEnvelopeV03(query, alteredObservation, project, 3, cut, stop()),
      /differs from verified historical lineage/);
    assert.equal(await isContinuityV03JobSourceCurrent(query, alteredObservation, jobRow, stop()), false);

    const rootEnvelope = await createContinuityCheckpointEnvelopeV03(query, nodes[2], project, 3, nodes[2].cursor, stop());
    assert.equal(rootEnvelope.lineageKind, 'root');
    assert.equal(rootEnvelope.lineage.edges.length, 0);
    assert.equal(rootEnvelope.row.val.lineageKind, 'root');
  });

  await check('empty-prefix fork has a stable canonical -1 copied cut', async () => {
    const emptyRoot = ctx.sessions.create('empty-prefix-root', { meta: { cwd } });
    const emptyChild = ctx.sessions.fork(emptyRoot, undefined, 'empty-prefix-child');
    const before = await bindHistorical(query, emptyChild.id, project, -1, stop());
    assert.equal(before.child.inheritedEventCount, 0);
    assert.equal(before.child.selectedCut, -1);
    assert.equal(before.edges.length, 1);
    assert.equal(before.edges[0].copiedPrefixCut, -1);
    const fullBefore = await verifyCurrent(query, emptyChild.id, project, stop());
    addHuman(emptyRoot, 'later event beyond the empty copied prefix');
    const after = await bindHistorical(query, emptyChild.id, project, -1, stop());
    assert.deepEqual(after, before);
    assert.notEqual((await verifyCurrent(query, emptyChild.id, project, stop())).proofHash, fullBefore.proofHash);
  });

  const baseline = await bindHistorical(query, descendant.id, project, cut, stop());
  await check('ephemeral verified lineage snapshot binds ordered raw IDs to the same native cut', async () => {
    let disposed = 0;
    const trackingQuery = { async observeSession(id, options) {
      const lease = await query.observeSession(id, options);
      return { ...lease, [Symbol.dispose]() { disposed++; lease[Symbol.dispose](); } };
    } };
    const snapshot = await verifyHistoricalSnapshot(trackingQuery, descendant.id, project, cut, stop());
    assert.deepEqual(snapshot.binding, baseline);
    const sourceObservation = await observeFull(descendant.id);
    const envelopeContext = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(
      query, sourceObservation, project, 3, cut, stop());
    assert.deepEqual(envelopeContext.lineageSnapshot.binding, envelopeContext.envelope.lineage);
    assert.deepEqual(Object.keys(envelopeContext).sort(), ['envelope', 'lineageSnapshot']);
    assert.equal('sessionIds' in envelopeContext.envelope, false, 'raw ID mapping is excluded from persisted envelope');
    assert.deepEqual(snapshot.sessionIds, [descendant.id, child.id, root.id]);
    assert.deepEqual(snapshot.sessionIds.map(id => digest(id)), [snapshot.binding.child.sessionKey,
      ...snapshot.binding.edges.map(edge => edge.parentSessionKey)]);
    assert.deepEqual(Object.keys(snapshot).sort(), ['binding', 'sessionIds']);
    assert.equal(Object.isFrozen(snapshot), true); assert.equal(Object.isFrozen(snapshot.sessionIds), true);
    assert.equal(Object.isFrozen(snapshot.binding), true); assert.equal(Object.isFrozen(snapshot.binding.child), true);
    assert.equal(Object.isFrozen(snapshot.binding.edges), true);
    assert.ok(snapshot.binding.edges.every(edge => Object.isFrozen(edge)));
    assert.equal('events' in snapshot, false); assert.equal(disposed, 3, 'all accepted native leases are disposed');
  });
  const fullBefore = await verifyCurrent(query, descendant.id, project, stop());
  await check('later root and intermediate-parent tails do not change copied-prefix historical binding', async () => {
    addHuman(root, 'root appended after both forks');
    addHuman(child, 'intermediate parent appended after descendant fork');
    const current = await bindHistorical(query, descendant.id, project, cut, stop());
    assert.deepEqual(current, baseline);
    const fullAfter = await verifyCurrent(query, descendant.id, project, stop());
    assert.notEqual(fullAfter.proofHash, fullBefore.proofHash, 'current full-source ancestry proof should observe those appends');
  });

  await check('events after the selected descendant cut do not replace its historical source binding', async () => {
    addHuman(descendant, 'descendant post-cut tail');
    const current = await bindHistorical(query, descendant.id, project, cut, stop());
    assert.deepEqual(current, baseline);
    const laterSource = await observeFull(descendant.id);
    const laterCut = await observe(descendant.id);
    const advancedCheckpoint = await createContinuityCheckpointEnvelopeV03(query, laterSource, project, 3, laterCut.cursor, stop());
    assert.ok(advancedCheckpoint.asOfSeq > Number(currentnessJobRow.cut_text), 'a newer checkpoint envelope exists beyond this pending job');
    assert.equal(await isContinuityV03JobSourceCurrent(query, laterSource, currentnessJobRow, stop()), true,
      'a later checkpoint must not stale the job bound to its original verified historical cut');
    const newer = await bindHistorical(query, descendant.id, project, laterCut.cursor, stop());
    assert.notEqual(newer.bindingHash, baseline.bindingHash);
  });

  await check('omitted native delegation depth normalizes to the same stable headers', async () => {
    const omitDepth = id => withRewrite(id, lease => {
      const header = { ...lease.header };
      delete header.delegationDepth;
      return { header };
    });
    const liveShaped = {
      async observeSession(id, options) {
        const lease = await query.observeSession(id, options);
        const header = { ...lease.header }; delete header.delegationDepth;
        return { ...lease, header, [Symbol.dispose]() { lease[Symbol.dispose](); } };
      },
    };
    const normalized = await bindHistorical(liveShaped, descendant.id, project, cut, stop());
    assert.deepEqual(normalized, baseline);
    // Also ensure the helper remains usable for a root without ancestry edges.
    const rootNow = await observe(root.id);
    const rootBinding = await bindHistorical(omitDepth(root.id), root.id, project, rootNow.cursor, stop());
    assert.equal(rootBinding.edges.length, 0); assert.equal(rootBinding.rootSessionKey, rootBinding.child.sessionKey);
  });

  await check('own-undefined origin, depth, and parent metadata fail closed', async () => {
    for (const key of ['origin', 'delegationDepth']) {
      const malformed = withRewrite(descendant.id, lease => {
        const header = { ...lease.header };
        Object.defineProperty(header, key, { value: undefined, enumerable: true, configurable: true });
        return { header };
      });
      await assert.rejects(bindHistorical(malformed, descendant.id, project, cut, stop()), /delegated or unknown origin/);
    }
    const malformedRoot = withRewrite(root.id, lease => {
      const header = { ...lease.header };
      Object.defineProperty(header, 'parentSession', { value: undefined, enumerable: true, configurable: true });
      return { header };
    });
    const rootCut = (await observe(root.id)).cursor;
    await assert.rejects(bindHistorical(malformedRoot, root.id, project, rootCut, stop()), /seed lineage invalid/);
  });

  await check('relevant copied-prefix tampering refuses the native lineage proof', async () => {
    const corruptParent = withRewrite(child.id, lease => {
      const events = structuredClone(lease.events);
      events[0].data.content[0].text = 'FORGED-LINEAGE-PREFIX';
      return { events };
    });
    await assert.rejects(bindHistorical(corruptParent, descendant.id, project, cut, stop()), /inherited prefix mismatch/);
  });

  await check('changed selected child evidence and invalid cuts cannot match the stored historical binding', async () => {
    const corruptSelected = withRewrite(descendant.id, lease => {
      const events = structuredClone(lease.events);
      events[cut].data.content[0].text += ' changed';
      return { events };
    });
    const changed = await bindHistorical(corruptSelected, descendant.id, project, cut, stop());
    assert.notEqual(changed.bindingHash, baseline.bindingHash);
    assert.notEqual(changed.child.selectedSourceHash, baseline.child.selectedSourceHash);
    const latest = await observe(descendant.id);
    await assert.rejects(bindHistorical(query, descendant.id, project, selected.inheritedEventCount - 2, stop()), /invalid continuity historical cut/);
    await assert.rejects(bindHistorical(query, descendant.id, project, latest.cursor + 1, stop()), /invalid continuity historical cut/);
    await assert.rejects(bindHistorical(query, descendant.id, project, 0.5, stop()), /invalid continuity historical cut/);
  });

  await check('v3 handoff read and lineage-backed preview are strictly fenced and default-deny', async () => {
    assert.ok(currentnessJobRow);
    const db = new DatabaseSync(':memory:');
    try {
      const owner = sqliteOwner(db);
      assert.equal(ensureContinuitySchemaV03(owner).kind, 'created-fresh');
      assert.equal(ensureContinuityWorkerPairV03(owner).kind, 'created-worker-pair');
      assert.equal(owner.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, true)), 0);
      assert.equal(readContinuitySummaryPolicyEpochV02(db), 0);
      const job = parseContinuityV03JobAnchor(currentnessJobRow);
      assert.ok(job);
      const selectedSource = await observeFull(descendant.id);
      const envelope = await createContinuityCheckpointEnvelopeV03(query, selectedSource, project, job.generation, job.cut, stop());
      db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
        .run(job.sessionId, job.projectId, job.generation);
      db.prepare(`INSERT INTO continuity_checkpoint(session_id,project_id,generation,cut,source_hash,checkpoint_format,
        source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,envelope)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(envelope.sessionId, envelope.projectId, envelope.generation, envelope.asOfSeq,
        envelope.sourceHash, envelope.checkpointFormat, envelope.sourceBindingVersion, envelope.selectedSourceHash,
        envelope.lineage.format, envelope.lineage.bindingVersion, envelope.lineageKind, envelope.lineageHash, JSON.stringify(envelope));
      db.prepare(`INSERT INTO continuity_jobs(id,session_id,project_id,generation,cut,source_hash,checkpoint_format,
        source_binding_version,selected_source_hash,lineage_format,lineage_binding_version,lineage_kind,lineage_hash,trigger,status)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(job.id, job.sessionId, job.projectId, job.generation, job.cut,
        job.sourceHash, job.checkpointFormat, job.sourceBindingVersion, job.selectedSourceHash, job.lineageFormat,
        job.lineageBindingVersion, job.lineageKind, job.lineageHash, job.trigger, job.status);

      let now = 1000;
      const clock = () => now;
      const work = new ContinuityWorkV03(owner);
      const claim = work.claim(job.projectId, now, 5000);
      assert.ok(claim);
      const readFreshSource = signal => observeFullWithSignal(descendant.id, signal);
      let nestedSourceCheck;
      owner.runInImmediateTransaction(() => { nestedSourceCheck = work.isCurrentWithFreshSource(query, readFreshSource, claim, clock, stop()); });
      await assert.rejects(nestedSourceCheck, /cannot await inside a store transaction/);
      const alteredSource = async signal => {
        const source = await readFreshSource(signal);
        const events = structuredClone(source.events);
        events[job.cut] = { ...events[job.cut], data: { ...events[job.cut].data,
          content: [{ type: 'text', text: 'altered source after claim' }] } };
        return { ...source, events };
      };
      assert.equal(await work.isCurrentWithFreshSource(query, alteredSource, claim, clock, stop()), false);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_handoff').get().count, 0);
      assert.equal(await work.completeWithFreshSource(query, readFreshSource, claim, clock,
        { notes: ['bounded untrusted note'], extra: true }, stop()), false, 'unknown payload fields fail closed');

      const revokeAfterRead = async signal => {
        const source = await readFreshSource(signal);
        db.prepare('UPDATE continuity_policy SET allowed=0 WHERE session_id=?').run(job.sessionId);
        return source;
      };
      assert.equal(await work.completeWithFreshSource(query, revokeAfterRead, claim, clock,
        { notes: ['revocation race'] }, stop()), false, 'policy change during native read blocks completion');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_handoff').get().count, 0);
      db.prepare('UPDATE continuity_policy SET allowed=1 WHERE session_id=?').run(job.sessionId);

      const failingOwner = sqliteOwner(db, 3);
      const failingWork = new ContinuityWorkV03(failingOwner);
      await assert.rejects(failingWork.completeWithFreshSource(query, readFreshSource, claim, clock,
        { notes: ['rollback probe'] }, stop()), /injected handoff commit failure/);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_handoff').get().count, 0,
        'handoff insertion rolls back with completion failure');
      assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(job.id).status, 'running');

      assert.equal(await work.completeWithFreshSource(query, readFreshSource, claim, clock,
        { notes: ['bounded untrusted note'], uncertain: true }, stop()), false, 'handoff input is exact, not caller-authoritative');
      assert.equal(await work.completeWithFreshSource(query, readFreshSource, claim, clock,
        { notes: ['bounded untrusted note'] }, stop()), true);
      const row = db.prepare('SELECT payload,selected_source_hash,lineage_hash FROM continuity_handoff WHERE job_id=?').get(job.id);
      assert.ok(row);
      assert.equal(row.selected_source_hash, job.selectedSourceHash);
      assert.equal(row.lineage_hash, job.lineageHash);
      const handoff = parseContinuityV03HandoffPayload(row.payload, job);
      assert.ok(handoff);
      assert.deepEqual(handoff.notes, ['bounded untrusted note']);
      assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(job.id).status, 'completed');
      assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
      const beforeRead = JSON.stringify(db.prepare('SELECT * FROM continuity_handoff').all());
      const current = work.readCurrentHandoff(job.projectId, job.id);
      assert.deepEqual(current, handoff);
      assert.deepEqual(Object.keys(current).sort(), ['jobId','sessionId','projectId','generation','cut','sourceHash','selectedSourceHash',
        'checkpointFormat','sourceBindingVersion','lineageFormat','lineageBindingVersion','lineageKind','lineageHash','notes','uncertain'].sort());
      assert.equal('token' in current, false); assert.equal('leaseDeadline' in current, false);
      assert.equal(work.readCurrentHandoff('pj-' + 'f'.repeat(32), job.id), null);
      assert.equal(JSON.stringify(db.prepare('SELECT * FROM continuity_handoff').all()), beforeRead,
        'current handoff read leaves persisted rows unchanged');
       const record = work.readCurrentHandoffRecord(job.projectId, job.id);
       assert.deepEqual(record.job, job); assert.deepEqual(record.handoff, handoff);
        const identity = work.readCurrentHandoffIdentity(job.projectId, job.id);
        assert.deepEqual(identity, { job }); assert.equal('handoff' in identity, false);
       const previewTarget = ctx.sessions.create('RAW-PREVIEW-TARGET-ID', { meta: { cwd } });
       addHuman(previewTarget, 'preview target has its own live human event');
       const previewRequest = { targetSessionId: previewTarget.id, jobId: job.id };
       let previewQueries = 0, identityReads = 0, payloadReads = 0;
       const countingQuery = { async observeSession(id, options) {
         previewQueries++; return query.observeSession(id, options);
       } };
       const countingReader = { readCurrentHandoffIdentity(projectId, jobId) {
         identityReads++; return work.readCurrentHandoffIdentity(projectId, jobId);
       } };
       assert.equal(await new ContinuityPreviewV03(countingReader, countingQuery, z).resolve(previewRequest), null);
       assert.equal(await new ContinuityPreviewV03(countingReader, countingQuery, z, () => true).resolve(previewRequest), null);
       assert.equal(previewQueries, 0); assert.equal(identityReads, 0); assert.equal(payloadReads, 0,
          'default-deny operator and direct-policy gates do no native or handoff read');
        let invalidOperatorCalls = 0;
        const invalidRequestPreview = new ContinuityPreviewV03(countingReader, countingQuery, z, () => {
          invalidOperatorCalls++; return true;
        });
        await assert.rejects(invalidRequestPreview.resolve({ targetSessionId: 'unsafe\u0000target', jobId: job.id }));
        await assert.rejects(invalidRequestPreview.resolve({ ...previewRequest, extra: true }));
        assert.equal(invalidOperatorCalls, 0); assert.equal(previewQueries, 0);
        const truthyOperatorPreview = new ContinuityPreviewV03(countingReader, countingQuery, z, () => 'yes', () => true);
        assert.equal(await truthyOperatorPreview.resolve(previewRequest), null, 'operator must return literal true');
        assert.equal(previewQueries, 0); assert.equal(identityReads, 0);
        const noLineageAdmission = new ContinuityPreviewV03(countingReader, countingQuery, z, () => true, () => true, () => 9);
        assert.equal(await noLineageAdmission.resolve(previewRequest), null, 'missing target/ancestor lineage admission refuses');
        noLineageAdmission.dispose(); assert.equal(identityReads, 0); assert.equal(payloadReads, 0);
        const booleanLineageAdmission = new ContinuityPreviewV03(countingReader, countingQuery, z, () => true,
          () => true, () => 9, () => true);
        assert.equal(await booleanLineageAdmission.resolve(previewRequest), null, 'lineage admission requires a policy snapshot stamp');
        booleanLineageAdmission.dispose();
       const previewPreflight = (_request, role, sessionId) => role === 'target'
         ? sessionId === previewTarget.id : sessionId === job.sessionId;
       const previewGeneration = (header, role, projectId) => {
         if (projectId !== job.projectId || (role === 'target' && header.id !== previewTarget.id)
            || (role === 'source' && header.id !== job.sessionId)) return null;
         
         
         return role === 'target' ? 9 : job.generation;
        };
        const advanceGlobalPolicyEpoch = () => owner.runInImmediateTransaction(() => {
          syncContinuitySummaryPolicyV02(db, false);
          return syncContinuitySummaryPolicyV02(db, true);
        });
        db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
          .run(root.id, job.projectId, 0);
        db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
          .run(child.id, job.projectId, 1);
        db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
          .run(previewTarget.id, job.projectId, 9);
        const previewPolicyReader = new ContinuityPolicyV03(owner);
        const observedLineages = Object.create(null), observedSnapshots = Object.create(null);
         const previewLineageAdmission = (header, role, projectId, generation, lineageSnapshot) => {
          const lineage = lineageSnapshot.binding;
          if (projectId !== job.projectId || generation !== (role === 'target' ? 9 : job.generation)
          || (role === 'target' && header.id !== previewTarget.id)
          || (role === 'source' && (header.id !== job.sessionId || lineage.bindingHash !== job.lineageHash))) return null;
          observedLineages[role] = lineage; observedSnapshots[role] = lineageSnapshot;
          
                      
          return previewPolicyReader.readCurrentLineagePolicyStamp(lineageSnapshot, projectId, generation);
            
            
              
            
       };
       const previewOperator = (_request, selectedSource) => selectedSource === undefined || selectedSource === job.sessionId;
       const previewRows = () => JSON.stringify({
         policy: db.prepare('SELECT * FROM continuity_policy').all(),
         summaryPolicy: db.prepare('SELECT * FROM continuity_summary_policy').all(),
          checkpoint: db.prepare('SELECT * FROM continuity_checkpoint').all(),
         jobs: db.prepare('SELECT * FROM continuity_jobs').all(),
         work: db.prepare('SELECT * FROM continuity_work').all(),
         handoff: db.prepare('SELECT * FROM continuity_handoff').all(),
       });
       const previewRowsBefore = previewRows();
       let validSourceReads = 0, validPayloadReads = 0;
        const validQuery = { async observeSession(id, options) {
          if (id === job.sessionId) validSourceReads++;
          return query.observeSession(id, options);
        } };
        const validReader = {
          readCurrentHandoffIdentity: (projectId, jobId) => work.readCurrentHandoffIdentity(projectId, jobId),
          readCurrentHandoffRecord(projectId, jobId) {
            validPayloadReads++; return work.readCurrentHandoffRecord(projectId, jobId);
          },
        };
        const preview = new ContinuityPreviewV03(validReader, validQuery, z, previewOperator, previewPreflight,
          previewGeneration, previewLineageAdmission);
       const previewResult = await preview.resolve(previewRequest);
       preview.dispose();
       assert.ok(validSourceReads >= 2, 'source is reobserved after target refresh');
        assert.equal(validPayloadReads, 1, 'handoff notes load only after all source/target gates');
        assert.ok(previewResult);
       assert.equal(previewResult.sourceSessionId, job.sessionId);
       assert.equal(previewResult.lineageKind, 'fork');
       assert.equal(previewResult.uncertain, true); assert.equal(previewResult.untrusted, true);
       assert.equal(previewResult.orientationOnly, true);
       assert.deepEqual(previewResult.notes, handoff.notes);
       assert.ok(!JSON.stringify(previewResult).includes('LINEAGE-PRIVATE-CANARY'));
       assert.equal(previewRows(), previewRowsBefore, 'preview reads do not mutate any v3 ledger rows');
        const sourceLineage = observedLineages.source;
        assert.ok(sourceLineage && sourceLineage.edges.length > 0, 'source lineage snapshot includes the fork ancestor');
        const sourceSessionKeys = [sourceLineage.child.sessionKey, ...sourceLineage.edges.map(edge => edge.parentSessionKey)];
        const sourcePolicyRows = sourceSessionKeys.map((sessionKey, index) => ({
          sessionKey, projectId: job.projectId, generation: index === 0 ? job.generation : 1, allowed: true,
        }));
        const composedPolicyStamp = composeContinuityPreviewLineagePolicyStampV03(sourceLineage, sourcePolicyRows, 1);
        assert.ok(composedPolicyStamp); assert.equal(composedPolicyStamp.lineageBindingHash, sourceLineage.bindingHash);
        const brokenLineageEdges = sourceLineage.edges.map((edge, index) => index === 0
          ? { ...edge, childSessionKey: 'f'.repeat(64) } : edge);
        const { bindingHash: _oldBindingHash, ...brokenLineagePayload } = { ...sourceLineage, edges: brokenLineageEdges };
        const brokenLineage = { ...brokenLineagePayload, bindingHash: digest(brokenLineagePayload) };
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(brokenLineage, sourcePolicyRows, 1), null,
          'self-consistent but disconnected lineage edge refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage, sourcePolicyRows.slice(1), 1), null,
          'missing ancestor policy row defaults to deny');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(
          sourceLineage, [...sourcePolicyRows, sourcePolicyRows[0]], 1), null, 'extra policy row refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage,
          [...sourcePolicyRows.slice(0, -1), { ...sourcePolicyRows[0] }], 1), null, 'duplicate/wrong-chain row refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage,
          sourcePolicyRows.map((row, index) => index === 1 ? { ...row, projectId: 'pj-' + 'f'.repeat(32) } : row), 1), null,
          'cross-project ancestor row refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage,
          sourcePolicyRows.map((row, index) => index === 1 ? { ...row, allowed: false } : row), 1), null,
          'explicitly denied ancestor row refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage,
          sourcePolicyRows.map((row, index) => index === 1 ? { ...row, generation: -1 } : row), 1), null,
          'unsafe ancestor generation refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage,
          sourcePolicyRows.map((row, index) => index === 1 ? { ...row, extra: true } : row), 1), null,
          'extra policy-row fields refuse');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(sourceLineage, sourcePolicyRows, -1), null,
          'invalid global epoch refuses');
        assert.equal(composeContinuityPreviewLineagePolicyStampV03(
          { ...sourceLineage, bindingHash: 'f'.repeat(64) }, sourcePolicyRows, 1), null, 'tampered lineage binding refuses');
        const policySnapshotReader = new ContinuityPolicyV03(owner);
        const sourceSnapshot = observedSnapshots.source;
        const sourceSessionIds = sourceSnapshot.sessionIds;
        db.prepare('DELETE FROM continuity_policy WHERE session_id=?').run(root.id);
        const policyRowsBeforeMissingAncestor = JSON.stringify(db.prepare('SELECT * FROM continuity_policy ORDER BY session_id').all());
        assert.equal(policySnapshotReader.readLineagePolicyStamp(sourceSnapshot, job.projectId, job.generation, 1), null,
          'persisted row reader defaults missing ancestor policy to deny');
        assert.equal(JSON.stringify(db.prepare('SELECT * FROM continuity_policy ORDER BY session_id').all()),
          policyRowsBeforeMissingAncestor, 'missing-row read does not materialize/write policy');
        db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,0,1)')
          .run(root.id, job.projectId);
        const policyRowsBeforeRead = JSON.stringify(db.prepare('SELECT * FROM continuity_policy ORDER BY session_id').all());
        const materializedPolicyStamp = policySnapshotReader.readLineagePolicyStamp(
          sourceSnapshot, job.projectId, job.generation, 1);
        const persistedPolicyRows = sourceSessionIds.map(sessionId => {
          const row = db.prepare('SELECT project_id,generation,allowed FROM continuity_policy WHERE session_id=?').get(sessionId);
          return { sessionKey: digest(sessionId), projectId: row.project_id, generation: row.generation, allowed: row.allowed === 1 };
        });
        assert.deepEqual(materializedPolicyStamp,
          composeContinuityPreviewLineagePolicyStampV03(sourceLineage, persistedPolicyRows, 1),
          'read-only owner stamp matches exact persisted child/ancestor rows');
        assert.equal(JSON.stringify(db.prepare('SELECT * FROM continuity_policy ORDER BY session_id').all()), policyRowsBeforeRead,
          'successful policy snapshot read does not write');
        const currentStampBeforePause = policySnapshotReader.readCurrentLineagePolicyStamp(
          sourceSnapshot, job.projectId, job.generation);
        assert.ok(currentStampBeforePause, 'atomic current reader admits the currently allowed global epoch');
        owner.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, false));
        const rowsBeforeDeniedRead = previewRows();
        assert.equal(policySnapshotReader.readCurrentLineagePolicyStamp(sourceSnapshot, job.projectId, job.generation), null,
          'atomic current reader defaults closed while global summary policy is disabled');
        assert.equal(previewRows(), rowsBeforeDeniedRead,
          'disabled global-epoch refusal leaves all policy and preview rows unchanged');
        owner.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, true));
        const currentStampAfterResume = policySnapshotReader.readCurrentLineagePolicyStamp(
          sourceSnapshot, job.projectId, job.generation);
        assert.ok(currentStampAfterResume);
        assert.notDeepEqual(currentStampAfterResume, currentStampBeforePause,
          're-enable advances the durable global epoch bound into the returned stamp');
        assert.equal(policySnapshotReader.readLineagePolicyStamp({ binding: sourceLineage,
          sessionIds: [job.sessionId, job.sessionId] }, job.projectId, job.generation, 1), null, 'duplicate raw IDs refuse');
        const extraSessionIdProperty = [...sourceSessionIds]; extraSessionIdProperty.extra = true;
        assert.equal(policySnapshotReader.readLineagePolicyStamp({ binding: sourceLineage,
          sessionIds: extraSessionIdProperty }, job.projectId, job.generation, 1), null, 'extra raw-ID array properties refuse');
        assert.equal(policySnapshotReader.readLineagePolicyStamp({ binding: sourceLineage,
          sessionIds: [...sourceSessionIds].reverse() }, job.projectId, job.generation, 1), null, 'raw-ID order mismatch refuses');
        assert.equal(policySnapshotReader.readLineagePolicyStamp(sourceSnapshot, job.projectId, job.generation, -1), null, 'invalid external global epoch refuses');
        db.prepare('UPDATE continuity_policy SET project_id=? WHERE session_id=?').run('pj-' + 'f'.repeat(32), root.id);
        assert.equal(policySnapshotReader.readLineagePolicyStamp(sourceSnapshot, job.projectId, job.generation, 1), null,
          'persisted cross-project ancestor row refuses');
        db.prepare('UPDATE continuity_policy SET project_id=? WHERE session_id=?').run(job.projectId, root.id);
        db.prepare('UPDATE continuity_policy SET allowed=0 WHERE session_id=?').run(root.id);
        assert.equal(policySnapshotReader.readLineagePolicyStamp(sourceSnapshot, job.projectId, job.generation, 1), null,
          'persisted denied ancestor row refuses');
        db.prepare('UPDATE continuity_policy SET allowed=1 WHERE session_id=?').run(root.id);
        let disposingPreview, disposalOperatorCalls = 0;
        disposingPreview = new ContinuityPreviewV03(work, query, z, () => {
          if (++disposalOperatorCalls === 2) disposingPreview.dispose();
          return true;
        }, previewPreflight, previewGeneration, previewLineageAdmission);
        assert.equal(await disposingPreview.resolve(previewRequest), null, 'dispose during target lineage proof returns null');
        assert.equal(disposalOperatorCalls, 2);
        const callerAbort = new AbortController(); let abortOperatorCalls = 0;
        const abortingPreview = new ContinuityPreviewV03(work, query, z, () => {
          if (++abortOperatorCalls === 2) callerAbort.abort();
          return true;
        }, previewPreflight, previewGeneration, previewLineageAdmission);
        assert.equal(await abortingPreview.resolve(previewRequest, callerAbort.signal), null,
          'caller abort during target lineage proof returns null');
        assert.equal(abortOperatorCalls, 2); abortingPreview.dispose();
        let driftIdentityReads = 0, driftPayloadReads = 0;
        const driftReader = {
          readCurrentHandoffIdentity(projectId, jobId) {
            const identity = work.readCurrentHandoffIdentity(projectId, jobId);
            if (++driftIdentityReads === 2 && identity) return { job: { ...identity.job, generation: identity.job.generation + 1 } };
            return identity;
          },
          readCurrentHandoffRecord(projectId, jobId) {
            driftPayloadReads++; return work.readCurrentHandoffRecord(projectId, jobId);
          },
        };
        const driftPreview = new ContinuityPreviewV03(driftReader, query, z, previewOperator, previewPreflight,
          previewGeneration, previewLineageAdmission);
        assert.equal(await driftPreview.resolve(previewRequest), null, 'current identity drift refuses before note payload read');
        assert.equal(driftPayloadReads, 0); driftPreview.dispose();
        let malformedPayloadReads = 0;
        const malformedReader = {
          readCurrentHandoffIdentity: (projectId, jobId) => work.readCurrentHandoffIdentity(projectId, jobId),
          readCurrentHandoffRecord(projectId, jobId) {
            malformedPayloadReads++;
            const current = work.readCurrentHandoffRecord(projectId, jobId);
            return current ? { ...current, handoff: { ...current.handoff, sourceHash: 'f'.repeat(64) } } : null;
          },
        };
        const malformedPreview = new ContinuityPreviewV03(malformedReader, query, z, previewOperator, previewPreflight,
          previewGeneration, previewLineageAdmission);
        assert.equal(await malformedPreview.resolve(previewRequest), null, 'record reader cannot pair foreign handoff anchors');
        assert.equal(malformedPayloadReads, 1); malformedPreview.dispose();
       let wrongSourceReads = 0, deniedPayloadReads = 0;
        const gatedReader = {
          readCurrentHandoffIdentity: (projectId, jobId) => work.readCurrentHandoffIdentity(projectId, jobId),
          readCurrentHandoffRecord(projectId, jobId) {
            deniedPayloadReads++; return work.readCurrentHandoffRecord(projectId, jobId);
          },
        };
        const wrongSourceQuery = { async observeSession(id, options) {
          if (id === job.sessionId) wrongSourceReads++;
          return query.observeSession(id, options);
        } };
        const wrongSourcePreview = new ContinuityPreviewV03(gatedReader, wrongSourceQuery, z,
         (_request, selectedSource) => selectedSource === undefined || selectedSource !== job.sessionId,
         previewPreflight, previewGeneration, previewLineageAdmission);
       assert.equal(await wrongSourcePreview.resolve(previewRequest), null,
         'selected-source mismatch refuses before exposing notes');
       wrongSourcePreview.dispose(); assert.equal(wrongSourceReads, 0, 'selected-source mismatch precedes source observation');
        assert.equal(deniedPayloadReads, 0, 'selected-source mismatch precedes handoff note loading');
       let sourcePreflightReads = 0;
        const sourcePreflightQuery = { async observeSession(id, options) {
          if (id === job.sessionId) sourcePreflightReads++;
          return query.observeSession(id, options);
        } };
        const sourcePreflightDenied = new ContinuityPreviewV03(gatedReader, sourcePreflightQuery, z, previewOperator,
          (_request, role, sessionId) => role === 'target' ? sessionId === previewTarget.id : false,
          previewGeneration, previewLineageAdmission);
        assert.equal(await sourcePreflightDenied.resolve(previewRequest), null, 'source direct-policy denial blocks before native read');
        sourcePreflightDenied.dispose(); assert.equal(sourcePreflightReads, 0); assert.equal(deniedPayloadReads, 0);
        let abaSourcePreflightCalls = 0, abaPayloadReads = 0;
        const epochBeforeAba = readContinuitySummaryPolicyEpochV02(db);
        assert.notEqual(epochBeforeAba, null);
        const abaReader = {
          readCurrentHandoffIdentity: (projectId, jobId) => work.readCurrentHandoffIdentity(projectId, jobId),
          readCurrentHandoffRecord(projectId, jobId) {
            abaPayloadReads++; return work.readCurrentHandoffRecord(projectId, jobId);
          },
        };
        const abaPreflight = (_request, role, sessionId) => {
          if (role === 'source' && ++abaSourcePreflightCalls === 2) advanceGlobalPolicyEpoch();
          return role === 'target' ? sessionId === previewTarget.id : sessionId === job.sessionId;
        };
        const abaPreview = new ContinuityPreviewV03(abaReader, query, z, previewOperator, abaPreflight,
          previewGeneration, previewLineageAdmission);
        assert.equal(await abaPreview.resolve(previewRequest), null, 'lineage policy stamp detects revoke/re-enable ABA');
        assert.equal(abaSourcePreflightCalls, 2); assert.equal(readContinuitySummaryPolicyEpochV02(db), epochBeforeAba + 2); assert.equal(abaPayloadReads, 0);
        abaPreview.dispose(); assert.notEqual(readContinuitySummaryPolicyEpochV02(db), null);
        let rowDriftSourcePreflightCalls = 0, rowDriftPayloadReads = 0;
        const rowDriftReader = {
          readCurrentHandoffIdentity: (projectId, jobId) => work.readCurrentHandoffIdentity(projectId, jobId),
          readCurrentHandoffRecord(projectId, jobId) {
            rowDriftPayloadReads++; return work.readCurrentHandoffRecord(projectId, jobId);
          },
        };
        const rowDriftPreflight = (_request, role, sessionId) => {
          if (role === 'source' && ++rowDriftSourcePreflightCalls === 2)
            db.prepare('UPDATE continuity_policy SET generation=2 WHERE session_id=?').run(root.id);
          return role === 'target' ? sessionId === previewTarget.id : sessionId === job.sessionId;
        };
        const rowDriftPreview = new ContinuityPreviewV03(rowDriftReader, query, z, previewOperator, rowDriftPreflight,
          previewGeneration, previewLineageAdmission);
        assert.equal(await rowDriftPreview.resolve(previewRequest), null, 'ancestor policy row hash drift refuses preview');
        assert.equal(rowDriftSourcePreflightCalls, 3);
        assert.equal(db.prepare('SELECT generation FROM continuity_policy WHERE session_id=?').get(root.id).generation, 2);
        assert.equal(readContinuitySummaryPolicyEpochV02(db), epochBeforeAba + 2); assert.equal(rowDriftPayloadReads, 0);
        rowDriftPreview.dispose(); db.prepare('UPDATE continuity_policy SET generation=0 WHERE session_id=?').run(root.id);
        let postReadPayloadReads = 0;
        const postReadMutationReader = {
          readCurrentHandoffIdentity: (projectId, jobId) => work.readCurrentHandoffIdentity(projectId, jobId),
          readCurrentHandoffRecord(projectId, jobId) {
            postReadPayloadReads++;
            const current = work.readCurrentHandoffRecord(projectId, jobId);
            advanceGlobalPolicyEpoch();
            return current;
          },
        };
        const postReadMutationPreview = new ContinuityPreviewV03(postReadMutationReader, query, z, previewOperator,
          previewPreflight, previewGeneration, previewLineageAdmission);
        assert.equal(await postReadMutationPreview.resolve(previewRequest), null,
          'post-payload policy stamp prevents exposing notes after epoch change');
        assert.equal(postReadPayloadReads, 1); assert.equal(readContinuitySummaryPolicyEpochV02(db), epochBeforeAba + 4);
        postReadMutationPreview.dispose();
        const deniedSourcePreview = new ContinuityPreviewV03(gatedReader, query, z, previewOperator, previewPreflight, previewGeneration,
         (header, role, projectId, generation, lineage) => role === 'source' ? null
            : previewLineageAdmission(header, role, projectId, generation, lineage));
       assert.equal(await deniedSourcePreview.resolve(previewRequest), null, 'source/ancestor policy denial blocks preview');
       deniedSourcePreview.dispose(); assert.equal(deniedPayloadReads, 0, 'lineage denial precedes handoff note loading');
      const originalPayload = row.payload;
      const alteredPayload = JSON.stringify({ ...handoff, lineageHash: 'f'.repeat(64) });
      db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(alteredPayload, job.id);
      assert.throws(() => work.readCurrentHandoff(job.projectId, job.id), /v3 work row preflight refused/);
      db.prepare('UPDATE continuity_handoff SET payload=? WHERE job_id=?').run(originalPayload, job.id);
      new ContinuityPolicyV03(owner).setPolicy(job.sessionId, job.projectId, false);
      assert.equal(work.readCurrentHandoff(job.projectId, job.id), null,
        'revoked generation/cancelled job cannot be read as current preview content');
      assert.equal(await work.completeWithFreshSource(query, readFreshSource, claim, clock,
        { notes: ['duplicate'] }, stop()), false, 'completed handoff is not repeat-committed');
    } finally { db.close(); }
  });

  await check('exact turn/end capture atomically commits checkpoint, job, and fresh-human consumption', async () => {
    const session = ctx.sessions.create('RAW-CAPTURE-V03-ROOT-ID', { meta: { cwd } });
    addUserRpcHuman(session, 'capture boundary first live human', 'capture-prompt-1');
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    const initial = await observeFull(session.id);
    const humanEvent = initial.events.find(event => event.type === 'user/message');
    const firstEnd = initial.events.at(-1);
    assert.ok(humanEvent && firstEnd?.type === 'turn/end');
    const db = new DatabaseSync(':memory:');
    try {
      const owner = sqliteOwner(db);
      assert.equal(ensureContinuitySchemaV03(owner).kind, 'created-fresh');
      db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
        .run(session.id, project, 8);
      const boundary = new ContinuityBoundaryV03(owner);
      const receipt = event => continuityV03LiveHumanReceiptFromSessionEvent(session, event, project, 8);
      const initialReceipt = receipt(humanEvent);
      assert.ok(initialReceipt);
      assert.equal(boundary.recordEligibleLiveHuman(initialReceipt), true);
      const capture = new ContinuityCaptureV03(owner);
      const request = turnEndSeq => ({ kind: 'host-live-turn-end', sessionId: session.id, projectId: project,
        generation: 8, turnEndSeq });
      const readFreshSource = signal => observeFullWithSignal(session.id, signal);
      let nestedCapture;
      owner.runInImmediateTransaction(() => { nestedCapture = capture.captureAtTurnEnd(query, readFreshSource, request(firstEnd.seq), stop()); });
      await assert.rejects(nestedCapture, /cannot await a native source read inside a store transaction/);
      assert.equal(await capture.captureAtTurnEnd(query, readFreshSource, request(humanEvent.seq), stop()), null,
        'a human-message cut is not a turn/end trigger');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 0);
      assert.equal(db.prepare('SELECT last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get(session.id).last_enqueued_human_seq, -1);

      const failingCapture = new ContinuityCaptureV03(sqliteOwner(db, 2));
      await assert.rejects(failingCapture.captureAtTurnEnd(query, readFreshSource, request(firstEnd.seq), stop()),
        /injected handoff commit failure/);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 0,
        'checkpoint rolls back with job and boundary consumption');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_jobs').get().count, 0);
      assert.equal(db.prepare('SELECT last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get(session.id).last_enqueued_human_seq, -1);

      const first = await capture.captureAtTurnEnd(query, readFreshSource, request(firstEnd.seq), stop());
      assert.ok(first?.created);
      assert.equal(first.consumedHumanSeq, humanEvent.seq);
      assert.equal(ensureContinuityWorkerPairV03(owner).kind, 'created-worker-pair');
      const work = new ContinuityWorkV03(owner);
      const claim = work.claim(project, 2000, 5000);
      assert.equal(claim?.id, first.jobId, 'captured job is claimable by the same-store worker');
      assert.equal(await work.completeWithFreshSource(query, readFreshSource, claim, () => 2001,
        { notes: ['captured at exact native turn end'] }, stop()), true,
        'native-source revalidation and strict handoff complete the captured job');
      const capturedJobRow = db.prepare(`SELECT id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
        CAST(cut AS TEXT) AS cut_text,source_hash,checkpoint_format,source_binding_version,selected_source_hash,
        lineage_format,lineage_binding_version,lineage_kind,lineage_hash,trigger,status FROM continuity_jobs WHERE id=?`).get(first.jobId);
      const capturedJob = parseContinuityV03JobAnchor(capturedJobRow);
      assert.ok(capturedJob);
      const capturedPayload = db.prepare('SELECT payload FROM continuity_handoff WHERE job_id=?').get(first.jobId).payload;
      const parsedCapturedHandoff = parseContinuityV03HandoffPayload(capturedPayload, capturedJob);
      assert.ok(parsedCapturedHandoff);
      assert.deepEqual(parsedCapturedHandoff.notes, ['captured at exact native turn end']);
      assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(first.jobId).status, 'completed');
      const storedText = db.prepare('SELECT envelope FROM continuity_checkpoint WHERE session_id=?').get(session.id).envelope;
      assert.ok(!storedText.includes('capture boundary first live human'), 'checkpoint persists projection/anchors, not source body text');
      const stored = JSON.parse(storedText);
      const parsed = parseContinuityCheckpointEnvelopeV03(stored);
      assert.ok(parsed);
      assert.equal(parsed.asOfSeq, firstEnd.seq);
      assert.equal(parsed.row.val.lastHumanSeq, humanEvent.seq);
      assert.equal(parsed.row.val.lastBoundarySeq, firstEnd.seq);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_jobs WHERE status=\'pending\'').get().count, 1);
      assert.equal(db.prepare('SELECT last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get(session.id).last_enqueued_human_seq, humanEvent.seq);
      let reads = 0;
      const shouldNotRead = async signal => { reads++; return readFreshSource(signal); };
      assert.equal(await capture.captureAtTurnEnd(query, shouldNotRead, request(firstEnd.seq), stop()), null,
        'a consumed human boundary is one-shot');
      assert.equal(reads, 0);

      addUserRpcHuman(session, 'second human before turn end', 'capture-prompt-2');
      const afterSecondHuman = await observeFull(session.id);
      const secondHuman = afterSecondHuman.events.filter(event => event.type === 'user/message').at(-1);
      assert.ok(secondHuman);
      const secondReceipt = receipt(secondHuman);
      assert.ok(secondReceipt);
      assert.equal(boundary.recordEligibleLiveHuman(secondReceipt), true);
      session.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } });
      const secondEndSource = await observeFull(session.id);
      const secondEnd = secondEndSource.events.at(-1);
      assert.equal(secondEnd?.type, 'turn/end');
      const second = await capture.captureAtTurnEnd(query, readFreshSource, request(secondEnd.seq), stop());
      assert.ok(second?.created);
      assert.equal(second.consumedHumanSeq, secondHuman.seq, 'latest live human supersedes the earlier consumed seq');

      addUserRpcHuman(session, 'human before async-gap race', 'capture-prompt-3');
      const beforeRace = await observeFull(session.id);
      const beforeRaceHuman = beforeRace.events.filter(event => event.type === 'user/message').at(-1);
      assert.ok(beforeRaceHuman);
      const beforeRaceReceipt = receipt(beforeRaceHuman);
      assert.ok(beforeRaceReceipt);
      assert.equal(boundary.recordEligibleLiveHuman(beforeRaceReceipt), true);
      session.append('turn/end', { turn: 3, reason: { kind: 'interrupted' } });
      const raceEndSource = await observeFull(session.id);
      const raceEnd = raceEndSource.events.at(-1);
      assert.equal(raceEnd?.type, 'turn/end');
      let raceRpc = 0;
      const appendHumanDuringRead = async signal => {
        await Promise.resolve();
        addUserRpcHuman(session, 'new human arrives while native source is being read', `capture-race-${++raceRpc}`);
        const source = await observeFullWithSignal(session.id, signal);
        const latestHuman = source.events.filter(event => event.type === 'user/message').at(-1);
        assert.ok(latestHuman);
        const raceReceipt = receipt(latestHuman);
        assert.ok(raceReceipt);
        assert.equal(boundary.recordEligibleLiveHuman(raceReceipt), true);
        return source;
      };
      assert.equal(await capture.captureAtTurnEnd(query, appendHumanDuringRead, request(raceEnd.seq), stop()), null,
        'newer live human observed during async gap prevents an earlier end from consuming it');
      const afterRace = db.prepare('SELECT latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?').get(session.id);
      assert.deepEqual([afterRace.latest_live_human_seq, afterRace.last_enqueued_human_seq], [raceEnd.seq + 1, secondHuman.seq],
        'the racing newer human remains pending while the prior consumed watermark stays unchanged');
      assert.equal(db.prepare('SELECT cut FROM continuity_checkpoint WHERE session_id=?').get(session.id).cut, secondEnd.seq,
        'the denied race leaves the earlier checkpoint intact');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_jobs WHERE status=\'pending\'').get().count, 2);

      session.append('turn/end', { turn: 4, reason: { kind: 'interrupted' } });
      const finalSource = await observeFull(session.id);
      const finalEnd = finalSource.events.at(-1);
      assert.equal(finalEnd?.type, 'turn/end');
      const finalCapture = await capture.captureAtTurnEnd(query, readFreshSource, request(finalEnd.seq), stop());
      assert.ok(finalCapture?.created);
      assert.equal(finalCapture.consumedHumanSeq, raceEnd.seq + 1);
      assert.equal(db.prepare('SELECT cut FROM continuity_checkpoint WHERE session_id=?').get(session.id).cut, finalEnd.seq);
      assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
    } finally { db.close(); }
  });

  await check('capture refuses policy revocation during native read without consuming or persisting', async () => {
    const session = ctx.sessions.create('RAW-CAPTURE-POLICY-RACE-ID', { meta: { cwd } });
    addUserRpcHuman(session, 'policy race live human', 'policy-race-prompt-1');
    session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    const sourceBefore = await observeFull(session.id);
    const human = sourceBefore.events.find(event => event.type === 'user/message');
    const end = sourceBefore.events.at(-1);
    assert.ok(human && end?.type === 'turn/end');
    const db = new DatabaseSync(':memory:');
    try {
      const owner = sqliteOwner(db);
      assert.equal(ensureContinuitySchemaV03(owner).kind, 'created-fresh');
      db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
        .run(session.id, project, 2);
      const boundary = new ContinuityBoundaryV03(owner);
      const humanReceipt = continuityV03LiveHumanReceiptFromSessionEvent(session, human, project, 2);
      assert.ok(humanReceipt);
      assert.equal(boundary.recordEligibleLiveHuman(humanReceipt), true);
      const capture = new ContinuityCaptureV03(owner);
      const readerRevokingPolicy = async signal => {
        const fresh = await observeFullWithSignal(session.id, signal);
        assert.equal(new ContinuityPolicyV03(owner).setPolicy(session.id, project, false), 3);
        return fresh;
      };
      const result = await capture.captureAtTurnEnd(query, readerRevokingPolicy, {
        kind: 'host-live-turn-end', sessionId: session.id, projectId: project, generation: 2, turnEndSeq: end.seq,
      }, stop());
      assert.equal(result, null, 'the second policy gate rejects after the async native read');
      const policyRow = db.prepare('SELECT generation,allowed FROM continuity_policy WHERE session_id=?').get(session.id);
      assert.deepEqual([policyRow.generation, policyRow.allowed], [3, 0]);
      const boundaryRow = db.prepare('SELECT latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?')
        .get(session.id);
      assert.deepEqual([boundaryRow.latest_live_human_seq, boundaryRow.last_enqueued_human_seq], [human.seq, -1]);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_checkpoint').get().count, 0);
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_jobs').get().count, 0);
      assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
    } finally { db.close(); }
  });

  await check('live session-event normalizer accepts only appended user-rpc source and emits body-free coordinates', async () => {
    const session = ctx.sessions.create('RAW-LIVE-HUMAN-RPC-ID', { meta: { cwd } });
    const observed = [];
    const disposeEvent = ctx.on('session/event', (observedSession, event) => {
      if (observedSession === session) observed.push(event);
    }, { global: true });
    const db = new DatabaseSync(':memory:');
    try {
      const owner = sqliteOwner(db);
      assert.equal(ensureContinuitySchemaV03(owner).kind, 'created-fresh');
      db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
        .run(session.id, project, 7);
      const boundary = new ContinuityBoundaryV03(owner);
      const ledger = new ContinuityPromptReceiptLedgerV03(4);
      const ordinaryUser = session.append('user/message', createUserMessage({
        source: { kind: 'user' }, content: [{ type: 'text', text: 'ordinary user-kind event without Host RPC marker' }],
      }), { surfaceOp: 'append' });
      assert.strictEqual(observed.at(-1), ordinaryUser, 'Host session/event feed receives the exact post-append event');
      assert.equal(continuityV03LiveHumanReceiptFromSessionEvent(session, ordinaryUser, project, 7), null,
        'kind=user alone does not identify a SessionController prompt');
      assert.equal(ledger.observeLiveAppend(session, ordinaryUser, project, 7), null,
        'an appended user event without a prior Host admission receipt is not eligible');
      assert.equal(db.prepare('SELECT COUNT(*) AS count FROM continuity_v3_human_boundary').get().count, 0,
        'non-rpc user events do not create a boundary through the Host event normalizer');
      const malformedMessage = createUserMessage({ source: { kind: 'user' },
        content: [{ type: 'text', text: 'PRIVATE-WRONG-SOURCE-CANARY' }] });
      const wrongSourceLedger = new ContinuityPromptReceiptLedgerV03(4);
      assert.equal(wrongSourceLedger.acceptHostPrompt({ kind: 'host-prompt-accepted', sessionId: session.id,
        projectId: project, messageId: malformedMessage.id, requestId: 'not-present-in-event', generation: 7 }), true);
      const malformedAppend = session.append('user/message', malformedMessage, { surfaceOp: 'append' });
      assert.equal(wrongSourceLedger.observeLiveAppend(session, malformedAppend, project, 7), null,
        'a live append with the ticketed message id but missing user-rpc source burns the ticket and fails closed');
      assert.equal(wrongSourceLedger.pendingCount, 0);
      const apiPromptMessage = createUserMessage({
        source: { kind: 'user', rpcId: 'client-minted-prompt-rpc-14' },
        content: [{ type: 'text', text: 'PRIVATE-HOST-PROMPT-CANARY' }],
      });
      assert.equal(typeof apiPromptMessage.id, 'string');
      const acceptedPrompt = { kind: 'host-prompt-accepted', sessionId: session.id, projectId: project,
        messageId: apiPromptMessage.id, requestId: 'client-minted-prompt-rpc-14', generation: 7 };
      assert.equal(ledger.acceptHostPrompt(acceptedPrompt), true,
        'a trusted Host controller receipt pairs its accepted message identity before the append');
      assert.equal(ledger.acceptHostPrompt({ ...acceptedPrompt, messageId: 'second-message-for-same-request' }), false,
        'one in-flight client request id cannot open a second ticket for the same session');
      const capacityLedger = new ContinuityPromptReceiptLedgerV03(1);
      assert.equal(capacityLedger.acceptHostPrompt(acceptedPrompt), true);
      assert.equal(capacityLedger.acceptHostPrompt({ ...acceptedPrompt, messageId: 'capacity-overflow-message', requestId: 'capacity-overflow-rpc' }), false,
        'the pending receipt capacity fails closed');
      assert.equal(capacityLedger.pendingCount, 1);
      const wrongMessageLedger = new ContinuityPromptReceiptLedgerV03(4);
      assert.equal(wrongMessageLedger.acceptHostPrompt({ ...acceptedPrompt, messageId: 'not-the-host-message-id' }), true);
      const wrongRequestLedger = new ContinuityPromptReceiptLedgerV03(4);
      assert.equal(wrongRequestLedger.acceptHostPrompt({ ...acceptedPrompt, requestId: 'different-client-rpc' }), true);
      const wrongGenerationLedger = new ContinuityPromptReceiptLedgerV03(4);
      assert.equal(wrongGenerationLedger.acceptHostPrompt({ ...acceptedPrompt, generation: 6 }), true);
      const apiPrompt = session.append('user/message', apiPromptMessage, { surfaceOp: 'append' });
      assert.strictEqual(observed.at(-1), apiPrompt, 'the Host observer sees the exact rpc-tagged append');
      assert.equal(wrongMessageLedger.observeLiveAppend(session, apiPrompt, project, 7), null,
        'a receipt for a different generated message id cannot pair');
      assert.equal(wrongMessageLedger.pendingCount, 1, 'unmatched receipts remain pending for explicit lifecycle cleanup');
      assert.equal(wrongRequestLedger.observeLiveAppend(session, apiPrompt, project, 7), null,
        'a ticket with a different client request id cannot pair with the Host source marker');
      assert.equal(wrongRequestLedger.pendingCount, 0, 'a message-identity match consumes a request-id mismatch fail-closed');
      assert.equal(wrongGenerationLedger.observeLiveAppend(session, apiPrompt, project, 7), null,
        'a stale policy generation is rejected and consumed');
      assert.equal(wrongGenerationLedger.pendingCount, 0);
      const receipt = ledger.observeLiveAppend(session, apiPrompt, project, 7);
      assert.ok(receipt);
      assert.equal(ledger.pendingCount, 0, 'exact admission receipt is consumed once');
      assert.equal(ledger.observeLiveAppend(session, apiPrompt, project, 7), null, 'replayed append cannot reuse a consumed receipt');
      assert.deepEqual(Object.keys(receipt).sort(), ['generation','headerHash','inheritedEventCount','kind','projectId','seq','sessionId'].sort());
      assert.ok(!JSON.stringify(receipt).includes('client-minted-prompt-rpc-14'));
      assert.ok(!JSON.stringify(receipt).includes(apiPromptMessage.id), 'the generated Host message id is also omitted');
      assert.equal(boundary.recordEligibleLiveHuman(receipt), true);
      const row = db.prepare('SELECT * FROM continuity_v3_human_boundary WHERE session_id=?').get(session.id);
      assert.deepEqual([row.latest_live_human_seq, row.last_enqueued_human_seq], [apiPrompt.seq, -1]);
      assert.ok(!JSON.stringify(row).includes('PRIVATE-HOST-PROMPT-CANARY'));
      assert.ok(!JSON.stringify(row).includes('PRIVATE-WRONG-SOURCE-CANARY'));
      assert.ok(!JSON.stringify(row).includes('client-minted-prompt-rpc-14'));
      assert.equal(wrongMessageLedger.forgetSession(session.id), 1, 'session disposal clears unmatched one-time tickets');
      assert.equal(wrongMessageLedger.pendingCount, 0);
      assert.equal(capacityLedger.forgetSession(session.id), 1);
      assert.equal(capacityLedger.pendingCount, 0);
      assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
    } finally { disposeEvent(); db.close(); }
  });

  await check('fork capture binds the inherited prefix and only the new child user-rpc seq', async () => {
    const parent = ctx.sessions.create('RAW-CAPTURE-FORK-PARENT-ID', { meta: { cwd } });
    addUserRpcHuman(parent, 'PRIVATE-INHERITED-PARENT-PROMPT', 'inherited-parent-prompt-rpc');
    parent.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    const session = ctx.sessions.fork(parent, undefined, 'RAW-CAPTURE-FORK-LIVE-ID');
    const before = await observeFull(session.id);
    assert.ok(before.inheritedEventCount > 0, 'fixture must carry a copied parent prefix');
    const inheritedPrompt = before.events.find(event => event.type === 'user/message'
      && event.data.source?.rpcId === 'inherited-parent-prompt-rpc');
    assert.ok(inheritedPrompt, 'fixture must include an inherited Host-shaped prompt event');
    assert.equal(continuityV03LiveHumanReceiptFromSessionEvent(session, inheritedPrompt, project, 9), null,
      'a copied user-rpc event is history, not a fresh child boundary');
    const inheritedLedger = new ContinuityPromptReceiptLedgerV03(4);
    assert.equal(inheritedLedger.acceptHostPrompt({ kind: 'host-prompt-accepted', sessionId: session.id, projectId: project,
      messageId: inheritedPrompt.data.id, requestId: 'inherited-parent-prompt-rpc', generation: 9 }), true);
    assert.equal(inheritedLedger.observeLiveAppend(session, inheritedPrompt, project, 9), null,
      'even a caller-attested receipt cannot promote an inherited seq into a live append');
    assert.equal(inheritedLedger.pendingCount, 1);
    assert.equal(inheritedLedger.forgetSession(session.id), 1);
    const promptMessage = createUserMessage({ source: { kind: 'user', rpcId: 'fork-child-prompt-rpc' },
      content: [{ type: 'text', text: 'PRIVATE-FORK-CHILD-PROMPT' }] });
    const admissionLedger = new ContinuityPromptReceiptLedgerV03(4);
    assert.equal(admissionLedger.acceptHostPrompt({ kind: 'host-prompt-accepted', sessionId: session.id, projectId: project,
      messageId: promptMessage.id, requestId: 'fork-child-prompt-rpc', generation: 9 }), true);
    const prompt = session.append('user/message', promptMessage, { surfaceOp: 'append' });
    const end = session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
    session.append('turn/end', { turn: 2, reason: { kind: 'interrupted' } });
    const receipt = admissionLedger.observeLiveAppend(session, prompt, project, 9);
    assert.ok(receipt);
    assert.equal(admissionLedger.pendingCount, 0);
    const db = new DatabaseSync(':memory:');
    try {
      const owner = sqliteOwner(db);
      assert.equal(ensureContinuitySchemaV03(owner).kind, 'created-fresh');
      db.prepare('INSERT INTO continuity_policy(session_id,project_id,generation,allowed) VALUES(?,?,?,1)')
        .run(session.id, project, 9);
      const boundary = new ContinuityBoundaryV03(owner);
      assert.equal(boundary.recordEligibleLiveHuman(receipt), true);
      const capture = new ContinuityCaptureV03(owner);
      let observedCursor = -1;
      const result = await capture.captureAtTurnEnd(query, async signal => {
        const source = await observeFullWithSignal(session.id, signal);
        observedCursor = source.cursor;
        return source;
      }, {
        kind: 'host-live-turn-end', sessionId: session.id, projectId: project, generation: 9, turnEndSeq: end.seq,
      }, stop());
      assert.ok(observedCursor > end.seq, 'fresh source contains a later tail beyond the selected capture cut');
      assert.ok(result?.created);
      assert.equal(result.consumedHumanSeq, prompt.seq);
      const row = db.prepare('SELECT envelope FROM continuity_checkpoint WHERE session_id=?').get(session.id);
      const text = row.envelope;
      assert.ok(!text.includes('PRIVATE-FORK-CHILD-PROMPT'), 'fork checkpoint stores no child prompt text');
      assert.ok(!text.includes('fork-child-prompt-rpc'), 'fork checkpoint stores no child RPC correlation id');
      assert.ok(!text.includes('PRIVATE-INHERITED-PARENT-PROMPT'), 'fork checkpoint stores no inherited prompt text');
      assert.ok(!text.includes('inherited-parent-prompt-rpc'), 'fork checkpoint stores no inherited RPC correlation id');
      const envelope = parseContinuityCheckpointEnvelopeV03(JSON.parse(text));
      assert.ok(envelope);
      assert.equal(envelope.lineageKind, 'fork');
      assert.equal(envelope.inheritedEventCount, before.inheritedEventCount);
      assert.equal(envelope.asOfSeq, end.seq);
      assert.equal(envelope.row.val.lastHumanSeq, prompt.seq);
      assert.equal(envelope.row.val.lastBoundarySeq, end.seq);
      assert.equal(db.prepare('SELECT trigger FROM continuity_jobs WHERE id=?').get(result.jobId).trigger, 'turn-end');
      assert.equal(ensureContinuityWorkerPairV03(owner).kind, 'created-worker-pair');
      const work = new ContinuityWorkV03(owner);
      const claim = work.claim(project, 4000, 5000);
      assert.equal(claim?.id, result.jobId, 'fork capture job is claimable');
      assert.equal(await work.completeWithFreshSource(query, signal => observeFullWithSignal(session.id, signal), claim,
        () => 4001, { notes: ['fork capture remains at selected cut'] }, stop()), true,
        'fork job revalidates at its historical cut despite the later source tail');
      const jobRow = db.prepare(`SELECT id,session_id,project_id,CAST(generation AS TEXT) AS generation_text,
        CAST(cut AS TEXT) AS cut_text,source_hash,checkpoint_format,source_binding_version,selected_source_hash,
        lineage_format,lineage_binding_version,lineage_kind,lineage_hash,trigger,status FROM continuity_jobs WHERE id=?`).get(result.jobId);
      const job = parseContinuityV03JobAnchor(jobRow);
      assert.ok(job);
      assert.equal(job.lineageKind, 'fork');
      const handoffRow = db.prepare('SELECT payload,selected_source_hash,lineage_hash FROM continuity_handoff WHERE job_id=?').get(result.jobId);
      const handoff = parseContinuityV03HandoffPayload(handoffRow.payload, job);
      assert.ok(handoff);
      assert.equal(handoffRow.selected_source_hash, job.selectedSourceHash);
      assert.equal(handoffRow.lineage_hash, job.lineageHash);
      assert.deepEqual(handoff.notes, ['fork capture remains at selected cut']);
      assert.equal(db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(result.jobId).status, 'completed');
      assert.equal(preflightContinuityV03Rows(db).kind, 'safe-v3-row-preflight');
    } finally { db.close(); }
  });

  console.log(`${passes.length} PASS / 0 FAIL; private fixtures; native source and DB fence composed, no Continue admission`);
} finally {
  await qf.dispose(); await pf.dispose(); await sf.dispose();
}
