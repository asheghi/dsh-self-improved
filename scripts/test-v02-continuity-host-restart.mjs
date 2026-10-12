#!/usr/bin/env node
// Two OS child processes; native JSONL persistence + fresh Cordis services, not main-host acceptance.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, renameSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtime = process.env.DSH_RUNTIME_RC2;
assert.ok(runtime, 'Explicit DSH_RUNTIME_RC2 required; no install/profile/fallback');
for (const name of ['dsh-session', 'dsh-session-persistence-jsonl', 'dsh-session-query', 'dsh-session-projection']) {
  assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8')).version, '0.2.0-rc.2');
}
assert.equal(JSON.parse(readFileSync(join(runtime, 'node_modules/zod/package.json'), 'utf8')).version, '4.6.5');
const script = fileURLToPath(import.meta.url), repo = resolve(dirname(script), '..');
const mode = process.argv[2], pkg = process.argv[3];
if (!mode) {
  mkdirSync(join(repo, '.tmp-import-lane'), { recursive: true });
  const fixture = mkdtempSync(join(repo, '.tmp-import-lane/continuity-host-restart-'));
  cpSync(join(repo, 'lib'), join(fixture, 'lib'), { recursive: true });
  cpSync(join(repo, 'package.json'), join(fixture, 'package.json'));
  const manifest = JSON.parse(readFileSync(join(fixture, 'package.json'), 'utf8'));
  for (const name of [...Object.keys(manifest.peerDependencies), ...Object.keys(manifest.dependencies)]) {
    const from = name.startsWith('@deepseek-ai/') || name === 'zod' ? join(runtime, 'node_modules', name) : join(repo, 'node_modules', name);
    const target = join(fixture, 'node_modules', name); mkdirSync(dirname(target), { recursive: true }); symlinkSync(from, target);
  }
  const run = phase => {
    const child = spawnSync(process.execPath, [script, phase, fixture], { cwd: fixture, env: { ...process.env, DSH_RUNTIME_RC2: runtime }, encoding: 'utf8', timeout: 60000 });
    process.stdout.write(child.stdout ?? ''); process.stderr.write(child.stderr ?? '');
    assert.ifError(child.error); assert.equal(child.signal, null); assert.equal(child.status, 0, `${phase} child failed`);
    return child.pid;
  };
  const seedPid = run('seed');
  const saved = JSON.parse(readFileSync(join(fixture, 'restart.json'), 'utf8'));
  const checkedSourcePath = path => {
    const absolute = resolve(path), root = resolve(fixture, 'native-source') + sep;
    assert.ok(absolute.startsWith(root) && /session\.v\d+\.jsonl$/.test(absolute), 'fixture source path must stay under isolated native root');
    return absolute;
  };
  const corruptPath = checkedSourcePath(saved.corrupt.path), original = readFileSync(corruptPath, 'utf8');
  assert.ok(original.includes('RESTART-CORRUPT-ORIGINAL'));
  writeFileSync(corruptPath, original.replace('RESTART-CORRUPT-ORIGINAL', 'RESTART-CORRUPT-REWRITTEN'));
  const missingPath = checkedSourcePath(saved.missing.path);
  // Resolve and validate the exact isolated target before moving it out of native discovery.
  renameSync(missingPath, missingPath + '.unavailable');
  const verifyPid = run('verify');
  assert.notEqual(seedPid, verifyPid); assert.notEqual(seedPid, process.pid); assert.notEqual(verifyPid, process.pid);
  console.log(`PASS distinct exited seed/reinit OS processes (${seedPid}, ${verifyPid}); fixture=${fixture}`);
} else {
  assert.ok(['seed', 'verify'].includes(mode)); assert.ok(pkg && resolve(pkg).startsWith(join(repo, '.tmp-import-lane') + sep));
  const own = name => import(pathToFileURL(join(pkg, 'lib', name + '.js')).href);
  const native = name => import(pathToFileURL(join(runtime, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href);
  const { Context } = await native('cordis');
  const { SessionStore } = await native('dsh-session');
  const { default: JsonlPersistence } = await native('dsh-session-persistence-jsonl');
  const { SessionQueryEngine } = await native('dsh-session-query');
  const { SessionProjectionRegistry } = await native('dsh-session-projection');
  const { createUserMessage } = await native('dsh-llm');
  const z = await import(pathToFileURL(join(runtime, 'node_modules/zod/index.js')).href);
  const { MemoryStore } = await own('storage');
  const { ContinuityStoreV02 } = await own('continuity-store-v02');
  const { claimContinuitySummaryHumanV02, readContinuitySummaryPolicyEpochV02, syncContinuitySummaryPolicyV02 } =
    await own('continuity-summary-ledger-owner');
  const { ContinuityOwnerV02 } = await own('continuity-owner-v02');
  const { ensureContinuitySchemaV03, ensureContinuityWorkerPairV03 } = await own('continuity-owner-v03');
  const { ContinuityWorkV03 } = await own('continuity-work-v03');
  const { ContinuityPolicyV03 } = await own('continuity-policy-v03');
  const { ContinuityBoundaryV03 } = await own('continuity-boundary-v03');
  const { ContinuityCaptureV03 } = await own('continuity-capture-v03');
  const { parseContinuityCheckpointEnvelopeV03 } = await own('continuity-envelope-v03');
  const { createContinuityCheckpointEnvelopeWithLineageSnapshotV03 } = await own('continuity-source-v03');
  const { registerContinuityProjection, CONTINUITY_PROJECTION_KEY: KEY } = await own('continuity-registry-v02');
  const { continuityCanonicalDigest, continuityCanonicalHeader, recoverContinuityCheckpoint, bindContinuityCheckpoint } =
    await own('continuity-checkpoint-v02');
  const { verifyContinuitySourceReference } = await own('continuity-source-v02');
  const { verifyContinuityAncestryV02 } = await own('continuity-ancestry-v02');
  const { opaqueProjectIdFromKey, projectKeyFromCwd } = await own('capture');
  const ctx = new Context(), fibers = [], owners = [];
  const mount = async (plugin, config) => { const fiber = ctx.plugin(plugin, config); await fiber.await(); fibers.push(fiber); };
  await mount(SessionStore); await mount(SessionProjectionRegistry);
  await mount(JsonlPersistence, { root: join(pkg, 'native-source'), compression: 'none' });
  await mount(SessionQueryEngine); registerContinuityProjection(ctx, z);
  const store = new MemoryStore(join(pkg, 'memory')), lane = new ContinuityStoreV02(store, z), db = store.getJournalSqlite();
  const v3Store = new MemoryStore(join(pkg, 'memory-v3')), v3Db = v3Store.getJournalSqlite();
  let passes = 0;
  const check = async (name, fn) => { await fn(); passes++; console.log('PASS ' + name); };
  const projectOf = header => opaqueProjectIdFromKey(projectKeyFromCwd(header.cwd));
  const user = (session, text) => session.append('user/message', createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }), { surfaceOp: 'append' });
  const persist = async session => {
    const observation = await ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
    let handle;
    try { handle = await ctx.sessionPersistence.create(observation.header, { inheritedEventCount: observation.inheritedEventCount }); await handle.append(observation.events); await handle.flush(); }
    finally { await handle?.close(); observation[Symbol.dispose](); }
    return ctx.sessionPersistence.locate(session.header).path;
  };
  const sourceRef = (header, projectId, envelope) => ({ sessionId: header.id, projectId, cut: envelope.asOfSeq, sourceHash: envelope.sourceHash });
  try {
    assert.equal(ctx.get('llm'), undefined); assert.equal(ctx.get('goals'), undefined); assert.equal(ctx.get('systemPrompt'), undefined); assert.equal(ctx.get('agentLoop'), undefined);
    if (mode === 'seed') {
      const saved = { seedPid: process.pid };
      await check('native roots durably flushed with original headers and committed checkpoint/jobs', async () => {
        for (const name of ['healthy', 'corrupt', 'missing', 'defaultHeader', 'legacy']) {
          // All roots intentionally omit the native optional depth. Cold decode
          // hydrates exactly zero; binding v2 must preserve original source identity.
          const meta = { cwd: '/synthetic/restart/' + name };
          const session = ctx.sessions.create('restart-' + name, { meta });
          user(session, name === 'corrupt' ? 'RESTART-CORRUPT-ORIGINAL' : 'Own human unfinished synthetic restart request ' + name);
          session.append('turn/start', { turn: 1 });
          session.append('turn/end', { turn: 1, reason: { kind: 'interrupted' } });
          const path = await persist(session), projectId = projectOf(session.header);
          const owner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, ctx.sessionQuery, () => true); owners.push(owner);
          const job = await owner.capture(session, 'turn-end'), envelope = lane.readCheckpoint(session.id, projectId);
          assert.ok(job?.created); assert.ok(envelope); assert.equal(envelope.inheritedEventCount, 0); assert.equal(envelope.row.val.lastHumanSeq, 0);
          saved[name] = { header: session.header, events: session.snapshotEvents(), projectId, jobId: job.id, generation: lane.readPolicy(session.id).generation, envelope, path };
          if (name === 'legacy') {
            const oldDigest = value => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
            const legacy = { ...envelope, headerHash: oldDigest(session.header), sourceHash: oldDigest({ bindingVersion: 1,
              header: session.header, inheritedEventCount: 0, events: session.snapshotEvents() }) };
            // Persist a genuine experimental-v1 reference/cache fixture before exit.
            store.runInImmediateTransaction(() => {
              db.prepare('UPDATE continuity_jobs SET source_hash=? WHERE id=?').run(legacy.sourceHash, job.id);
              db.prepare('UPDATE continuity_checkpoint SET source_hash=?,envelope=? WHERE session_id=?').run(legacy.sourceHash, JSON.stringify(legacy), session.id);
            });
            saved[name].envelope = legacy;
          }
        }
      });
      await check('native inherited-only fork persisted but receives no continuity job/own authority', async () => {
        const fork = ctx.sessions.fork(ctx.sessions.get(saved.healthy.header.id), undefined, 'restart-inherited-fork');
        const path = await persist(fork), projectId = projectOf(fork.header);
        const owner = new ContinuityOwnerV02(lane, ctx.sessionProjections, z, ctx.sessionQuery, () => true); owners.push(owner);
        assert.equal(await owner.capture(fork, 'turn-end'), null);
        assert.equal(lane.readCheckpoint(fork.id, projectId), null);
        saved.fork = { header: fork.header, projectId, inheritedEventCount: fork.inheritedEventCount, path };
        assert.ok(fork.inheritedEventCount > 0);
      });
      await check('live native fork ancestry identity proof binds original omitted-depth child and parent headers', async () => {
        assert.equal(Object.hasOwn(saved.fork.header, 'delegationDepth'), false);
        assert.equal(Object.hasOwn(saved.healthy.header, 'delegationDepth'), false);
        saved.ancestry = await verifyContinuityAncestryV02(ctx.sessionQuery, saved.fork.header.id, saved.fork.projectId, new AbortController().signal);
        assert.equal(saved.ancestry.ancestors.length, 1);
        assert.equal(saved.ancestry.child.inheritedEventCount, saved.fork.inheritedEventCount);
        assert.equal(saved.ancestry.ancestors[0].prefixCut, saved.fork.inheritedEventCount - 1);
        const observation = await ctx.sessionQuery.observeSession(saved.fork.header.id, { projectionMode: 'none' });
        try {
          const built = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(ctx.sessionQuery, observation,
            saved.fork.projectId, 0, observation.cursor, new AbortController().signal);
          assert.equal(built.envelope.lineageKind, 'fork');
          assert.deepEqual(built.envelope.lineage, built.lineageSnapshot.binding);
          saved.forkV03Envelope = built.envelope;
        } finally { observation[Symbol.dispose](); }
      });
      await check('seed actual file-backed summary consent epoch and consumed human watermark', () => {
        const entry = saved.healthy;
        const generation = store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, true));
        const claim = { sessionId: entry.header.id, projectId: entry.projectId, headerHash: entry.envelope.headerHash,
          inheritedFloor: entry.envelope.inheritedEventCount, humanSeq: entry.envelope.row.val.lastHumanSeq, generation };
        assert.equal(store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(db, claim)), true);
        assert.equal(readContinuitySummaryPolicyEpochV02(db), generation);
        saved.summaryWatermark = claim;
      });
      await check('seed private v3 capture owner with fixture-attested boundary and exact-cut job', async () => {
        assert.deepEqual(ensureContinuitySchemaV03(v3Store), {
          kind: 'created-fresh', workerPair: 'absent', summaryLedgersPresent: false, summaryLedgersValidated: false,
        });
        const entry = saved.healthy, policy = new ContinuityPolicyV03(v3Store), boundary = new ContinuityBoundaryV03(v3Store);
        const capture = new ContinuityCaptureV03(v3Store);
        const headerHash = continuityCanonicalDigest(continuityCanonicalHeader(entry.header));
        const generation = policy.ensurePolicy(entry.header.id, entry.projectId, true);
        const humanSeq = entry.envelope.row.val.lastHumanSeq, turnEndSeq = entry.envelope.asOfSeq;
        assert.equal(generation, 0);
        assert.equal(boundary.recordEligibleLiveHuman({ kind: 'host-direct-user-message', sessionId: entry.header.id,
          projectId: entry.projectId, headerHash, inheritedEventCount: entry.envelope.inheritedEventCount, generation, seq: humanSeq }), true,
        'synthetic fixture coordinate represents only a pre-verified Host boundary, not real authentication');
        const request = { kind: 'host-live-turn-end', sessionId: entry.header.id, projectId: entry.projectId, generation, turnEndSeq };
        const result = await capture.captureAtTurnEnd(ctx.sessionQuery, async signal => {
          signal.throwIfAborted();
          const observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
          try { return { header: observation.header, events: observation.events, inheritedEventCount: observation.inheritedEventCount, cursor: observation.cursor }; }
          finally { observation[Symbol.dispose](); }
        }, request, new AbortController().signal);
        assert.ok(result?.created); assert.equal(result.consumedHumanSeq, humanSeq);
        const checkpoint = v3Db.prepare('SELECT envelope,source_hash FROM continuity_checkpoint WHERE session_id=?').get(entry.header.id);
        const envelope = checkpoint && parseContinuityCheckpointEnvelopeV03(JSON.parse(checkpoint.envelope));
        assert.ok(envelope); assert.equal(checkpoint.source_hash, envelope.sourceHash);
        const job = v3Db.prepare('SELECT id,status,trigger,source_hash FROM continuity_jobs WHERE session_id=?').get(entry.header.id);
        assert.deepEqual([job?.id, job?.status, job?.trigger, job?.source_hash],
          [result.jobId, 'pending', 'turn-end', envelope.sourceHash]);
        saved.v3Capture = { request, headerHash, inheritedEventCount: entry.envelope.inheritedEventCount, humanSeq, jobId: result.jobId, envelope };

        const handoffEntry = saved.defaultHeader;
        const handoffHeaderHash = continuityCanonicalDigest(continuityCanonicalHeader(handoffEntry.header));
        const handoffGeneration = policy.ensurePolicy(handoffEntry.header.id, handoffEntry.projectId, true);
        const handoffHumanSeq = handoffEntry.envelope.row.val.lastHumanSeq, handoffTurnEnd = handoffEntry.envelope.asOfSeq;
        assert.equal(handoffGeneration, 0);
        assert.equal(boundary.recordEligibleLiveHuman({ kind: 'host-direct-user-message', sessionId: handoffEntry.header.id,
          projectId: handoffEntry.projectId, headerHash: handoffHeaderHash,
          inheritedEventCount: handoffEntry.envelope.inheritedEventCount, generation: handoffGeneration, seq: handoffHumanSeq }), true);
        const handoffRequest = { kind: 'host-live-turn-end', sessionId: handoffEntry.header.id,
          projectId: handoffEntry.projectId, generation: handoffGeneration, turnEndSeq: handoffTurnEnd };
        const handoffCapture = await capture.captureAtTurnEnd(ctx.sessionQuery, async signal => {
          signal.throwIfAborted();
          const observation = await ctx.sessionQuery.observeSession(handoffEntry.header.id, { projectionMode: 'none' });
          try { return { header: observation.header, events: observation.events,
            inheritedEventCount: observation.inheritedEventCount, cursor: observation.cursor }; }
          finally { observation[Symbol.dispose](); }
        }, handoffRequest, new AbortController().signal);
        assert.ok(handoffCapture?.created);
        const workerPair = ensureContinuityWorkerPairV03(v3Store);
        assert.deepEqual(workerPair, { kind: 'created-worker-pair', summaryLedgersPresent: false, summaryLedgersValidated: false });
        const work = new ContinuityWorkV03(v3Store);
        const handoffClaim = work.claim(handoffEntry.projectId, 100, 1000);
        assert.ok(handoffClaim); assert.equal(handoffClaim.id, handoffCapture.jobId);
        const readHandoffSource = async signal => {
          signal.throwIfAborted();
          const observation = await ctx.sessionQuery.observeSession(handoffEntry.header.id, { projectionMode: 'none' });
          try { return structuredClone({ header: observation.header, events: observation.events,
            inheritedEventCount: observation.inheritedEventCount, cursor: observation.cursor }); }
          finally { observation[Symbol.dispose](); }
        };
        assert.equal(await work.completeWithFreshSource(ctx.sessionQuery, readHandoffSource, handoffClaim, () => 100,
          { notes: ['synthetic fixture handoff only'] }, new AbortController().signal), true);
        const handoffRecord = work.readCurrentHandoffRecord(handoffEntry.projectId, handoffCapture.jobId);
        assert.deepEqual(handoffRecord?.handoff.notes, ['synthetic fixture handoff only']);
        assert.equal(handoffRecord?.handoff.uncertain, true);
        const handoffCheckpoint = v3Db.prepare('SELECT envelope FROM continuity_checkpoint WHERE session_id=?').get(handoffEntry.header.id);
        const handoffEnvelope = handoffCheckpoint && parseContinuityCheckpointEnvelopeV03(JSON.parse(handoffCheckpoint.envelope));
        assert.ok(handoffEnvelope);
        saved.v3Handoff = { request: handoffRequest, headerHash: handoffHeaderHash,
          inheritedEventCount: handoffEntry.envelope.inheritedEventCount, humanSeq: handoffHumanSeq,
          jobId: handoffCapture.jobId, envelope: handoffEnvelope, notes: ['synthetic fixture handoff only'] };
      });
      writeFileSync(join(pkg, 'restart.json'), JSON.stringify(saved));
    } else {
      const saved = JSON.parse(readFileSync(join(pkg, 'restart.json'), 'utf8'));
      assert.notEqual(saved.seedPid, process.pid); assert.deepEqual(ctx.sessions.list(), []);
      await check('fresh OS process preserves summary consent epoch and consumed human watermark', () => {
        const claim = saved.summaryWatermark;
        assert.ok(claim);
        assert.equal(readContinuitySummaryPolicyEpochV02(db), claim.generation);
        assert.equal(store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(db, claim)), false,
          'the exact consumed human coordinate cannot replay in the new OS process');
        assert.equal(store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(db,
          { ...claim, humanSeq: claim.humanSeq + 1 })), true, 'a fresh later coordinate can advance after restart');
        const revokedGeneration = store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, false));
        assert.equal(revokedGeneration, claim.generation + 1);
        assert.equal(readContinuitySummaryPolicyEpochV02(db), null, 'disabled policy remains denied after process restart');
        assert.equal(store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(db,
          { ...claim, generation: revokedGeneration, humanSeq: claim.humanSeq + 2 })), false,
          'disabled consent refuses even a later coordinate');
        const resumedGeneration = store.runInImmediateTransaction(() => syncContinuitySummaryPolicyV02(db, true));
        assert.equal(resumedGeneration, revokedGeneration + 1);
        assert.equal(readContinuitySummaryPolicyEpochV02(db), resumedGeneration);
        assert.equal(store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(db,
          { ...claim, humanSeq: claim.humanSeq + 2 })), false, 'pre-revocation generation cannot regain authority');
        assert.equal(store.runInImmediateTransaction(() => claimContinuitySummaryHumanV02(db,
          { ...claim, generation: resumedGeneration, humanSeq: claim.humanSeq + 2 })), true,
          'fresh coordinate is admitted only under the new epoch');
        const row = db.prepare('SELECT session_id,project_id,header_hash,inherited_floor,human_seq FROM continuity_summary_human WHERE session_id=?')
          .get(claim.sessionId);
        assert.deepEqual([row.session_id, row.project_id, row.header_hash, row.inherited_floor, row.human_seq],
          [claim.sessionId, claim.projectId, claim.headerHash, claim.inheritedFloor, claim.humanSeq + 2]);
      });
      await check('fresh OS process reopens v3 capture checkpoint/job and refuses boundary replay', async () => {
        const savedCapture = saved.v3Capture;
        assert.ok(savedCapture);
        assert.deepEqual(ensureContinuitySchemaV03(v3Store), {
          kind: 'already-v3', workerPair: 'present', summaryLedgersPresent: false, summaryLedgersValidated: false,
        });
        const policy = new ContinuityPolicyV03(v3Store), boundary = new ContinuityBoundaryV03(v3Store);
        const capture = new ContinuityCaptureV03(v3Store);
        assert.equal(policy.ensurePolicy(savedCapture.request.sessionId, savedCapture.request.projectId, true), savedCapture.request.generation);
        const persisted = v3Db.prepare('SELECT envelope,source_hash FROM continuity_checkpoint WHERE session_id=?')
          .get(savedCapture.request.sessionId);
        const reopened = persisted && parseContinuityCheckpointEnvelopeV03(JSON.parse(persisted.envelope));
        assert.deepEqual(reopened, savedCapture.envelope);
        assert.equal(persisted.source_hash, savedCapture.envelope.sourceHash);
        const job = v3Db.prepare('SELECT id,status,trigger,source_hash FROM continuity_jobs WHERE session_id=?')
          .get(savedCapture.request.sessionId);
        assert.deepEqual([job?.id, job?.status, job?.trigger, job?.source_hash],
          [savedCapture.jobId, 'pending', 'turn-end', savedCapture.envelope.sourceHash]);
        const boundaryRow = v3Db.prepare('SELECT generation,latest_live_human_seq,last_enqueued_human_seq FROM continuity_v3_human_boundary WHERE session_id=?')
          .get(savedCapture.request.sessionId);
        assert.deepEqual([boundaryRow?.generation, boundaryRow?.latest_live_human_seq, boundaryRow?.last_enqueued_human_seq],
          [savedCapture.request.generation, savedCapture.humanSeq, savedCapture.humanSeq]);
        assert.equal(boundary.recordEligibleLiveHuman({ kind: 'host-direct-user-message', sessionId: savedCapture.request.sessionId,
          projectId: savedCapture.request.projectId, headerHash: savedCapture.headerHash,
          inheritedEventCount: savedCapture.inheritedEventCount, generation: savedCapture.request.generation, seq: savedCapture.humanSeq }), false);
        let sourceReads = 0;
        assert.equal(await capture.captureAtTurnEnd(ctx.sessionQuery, async () => { sourceReads++; throw new Error('replay must not read source'); },
          savedCapture.request, new AbortController().signal), null);
        assert.equal(sourceReads, 0);
        assert.deepEqual(ensureContinuityWorkerPairV03(v3Store), {
          kind: 'already-present', summaryLedgersPresent: false, summaryLedgersValidated: false,
        });
        const work = new ContinuityWorkV03(v3Store);
        const savedHandoff = saved.v3Handoff;
        assert.ok(savedHandoff);
        assert.equal(policy.ensurePolicy(savedHandoff.request.sessionId, savedHandoff.request.projectId, true), savedHandoff.request.generation);
        const reopenedHandoff = work.readCurrentHandoffRecord(savedHandoff.request.projectId, savedHandoff.jobId);
        assert.equal(reopenedHandoff?.job.id, savedHandoff.jobId);
        assert.deepEqual(reopenedHandoff?.handoff.notes, savedHandoff.notes);
        assert.equal(reopenedHandoff?.handoff.uncertain, true);
        assert.deepEqual(parseContinuityCheckpointEnvelopeV03(JSON.parse(v3Db.prepare(
          'SELECT envelope FROM continuity_checkpoint WHERE session_id=?').get(savedHandoff.request.sessionId).envelope)), savedHandoff.envelope);
        assert.equal(v3Db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(savedHandoff.jobId)?.status, 'completed');
        const workClaim = work.claim(savedCapture.request.projectId, 100, 1000);
        assert.ok(workClaim); assert.equal(workClaim.id, savedCapture.jobId); assert.equal(workClaim.attempts, 1);
        assert.equal(work.isCurrent(workClaim, 100), true);
        const readFreshSource = async signal => {
          signal.throwIfAborted();
          const observation = await ctx.sessionQuery.observeSession(savedCapture.request.sessionId, { projectionMode: 'none' });
          try { return structuredClone({ header: observation.header, events: observation.events,
            inheritedEventCount: observation.inheritedEventCount, cursor: observation.cursor }); }
          finally { observation[Symbol.dispose](); }
        };
        assert.equal(await work.isCurrentWithFreshSource(ctx.sessionQuery, readFreshSource, workClaim, () => 100,
          new AbortController().signal), true, 'reopened claim still matches the cold-restored native source');
        const revokedGeneration = policy.setPolicy(savedCapture.request.sessionId, savedCapture.request.projectId, false);
        assert.equal(revokedGeneration, savedCapture.request.generation + 1);
        assert.equal(v3Db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(savedCapture.jobId)?.status, 'cancelled');
        assert.equal(v3Db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(savedCapture.jobId)?.status, 'failed');
        assert.equal(v3Db.prepare('SELECT 1 FROM continuity_checkpoint WHERE session_id=?').get(savedCapture.request.sessionId), undefined);
        assert.equal(work.isCurrent(workClaim, 100), false);
        assert.equal(work.fail(workClaim, 100), false, 'revoked lease cannot settle against stale policy');
        const resumedGeneration = policy.setPolicy(savedCapture.request.sessionId, savedCapture.request.projectId, true);
        assert.equal(resumedGeneration, revokedGeneration + 1);
        assert.equal(v3Db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(savedCapture.jobId)?.status, 'cancelled',
          're-enable never resurrects the old job');
        assert.equal(work.isCurrent(workClaim, 100), false);
        assert.equal(work.hasEligibleWork(savedCapture.request.projectId, 100), false);
        assert.equal(boundary.recordEligibleLiveHuman({ kind: 'host-direct-user-message',
          sessionId: savedCapture.request.sessionId, projectId: savedCapture.request.projectId, headerHash: savedCapture.headerHash,
          inheritedEventCount: savedCapture.inheritedEventCount, generation: savedCapture.request.generation, seq: savedCapture.humanSeq }), false,
        'pre-revocation boundary cannot be replayed after policy re-enable');
        let staleSourceReads = 0;
        assert.equal(await capture.captureAtTurnEnd(ctx.sessionQuery, async () => { staleSourceReads++; throw new Error('stale generation must refuse'); },
          savedCapture.request, new AbortController().signal), null);
        assert.equal(staleSourceReads, 0);
        const handoffRevokedGeneration = policy.setPolicy(savedHandoff.request.sessionId, savedHandoff.request.projectId, false);
        assert.equal(handoffRevokedGeneration, savedHandoff.request.generation + 1);
        assert.equal(work.readCurrentHandoffRecord(savedHandoff.request.projectId, savedHandoff.jobId), null,
          'revoked completed handoff is not readable');
        assert.equal(work.readCurrentHandoffIdentity(savedHandoff.request.projectId, savedHandoff.jobId), null,
          'revoked handoff identity is denied before payload access');
        assert.equal(v3Db.prepare('SELECT status FROM continuity_jobs WHERE id=?').get(savedHandoff.jobId)?.status, 'cancelled');
        assert.equal(v3Db.prepare('SELECT status FROM continuity_work WHERE job_id=?').get(savedHandoff.jobId)?.status, 'completed');
        assert.equal(v3Db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff WHERE job_id=?').get(savedHandoff.jobId).n, 1,
          'stored payload remains only behind the failed current-policy gate');
        const handoffResumedGeneration = policy.setPolicy(savedHandoff.request.sessionId, savedHandoff.request.projectId, true);
        assert.equal(handoffResumedGeneration, handoffRevokedGeneration + 1);
        assert.equal(work.readCurrentHandoffRecord(savedHandoff.request.projectId, savedHandoff.jobId), null,
          're-enable cannot expose a handoff anchored to a cancelled job');
      });
      await check('fresh OS process native prepared observation preserves canonical original header/cut/hash and accepts checkpoint', async () => {
        const entry = saved.healthy, observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
        try {
          assert.equal(observation.source, 'prepared');
          assert.equal(Object.hasOwn(entry.header, 'delegationDepth'), false);
          assert.deepEqual(observation.header, { ...entry.header, delegationDepth: 0 });
          assert.deepEqual(observation.events, entry.events, 'native persisted events must remain exact');
          assert.equal(observation.inheritedEventCount, 0);
          assert.equal(observation.cursor, entry.envelope.asOfSeq);
           const watermark = saved.summaryWatermark;
           assert.equal(watermark.sessionId, observation.header.id);
           assert.equal(watermark.projectId, projectOf(observation.header));
           assert.equal(watermark.headerHash, continuityCanonicalDigest(continuityCanonicalHeader(observation.header)),
             'persisted human watermark remains bound to the cold-restored canonical native header');
           assert.equal(watermark.inheritedFloor, observation.inheritedEventCount);
           assert.ok(observation.events.some(event => event.seq === watermark.humanSeq && event.type === 'user/message'
             && event.data.role === 'user' && event.data.source?.kind === 'user'),
             'watermarked sequence is the restored native own-user event');
          const checkpoint = lane.readCheckpoint(entry.header.id, entry.projectId);
          assert.deepEqual(checkpoint, entry.envelope);
          const recovered = recoverContinuityCheckpoint(ctx.sessionProjections, observation, checkpoint, z);
          assert.equal(recovered.cacheAccepted, true); assert.equal(recovered.reason, 'accepted');
          const bound = bindContinuityCheckpoint(observation, recovered.checkpoint[KEY]);
          assert.deepEqual(bound, checkpoint);
          assert.deepEqual(verifyContinuitySourceReference(sourceRef(entry.header, entry.projectId, checkpoint), observation, ctx.sessionProjections, z), checkpoint);
          assert.equal(bound.row.val.lastHumanSeq, 0); assert.equal(bound.row.val.inheritedEventCount, 0);
          assert.equal(lane.ensurePolicy(entry.header.id, entry.projectId, true), entry.generation);
          assert.deepEqual(lane.enqueue(bound, entry.projectId, entry.generation, 'turn-end'), { id: entry.jobId, created: false });
          assert.equal(lane.listPending(entry.projectId).length, 1);
        } finally { observation[Symbol.dispose](); }
        assert.deepEqual(ctx.sessions.list(), [], 'cold observation does not publish a live session or inflate inherited source');
      });
      await check('binding v2 admits only native omitted-depth zero/default and ignores object insertion order', async () => {
        const entry = saved.defaultHeader, observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
        try {
          assert.equal(Object.hasOwn(entry.header, 'delegationDepth'), false); assert.equal(observation.header.delegationDepth, 0);
          assert.deepEqual(observation.header, { ...entry.header, delegationDepth: 0 });
          assert.deepEqual(observation.events, entry.events);
          const recovered = recoverContinuityCheckpoint(ctx.sessionProjections, observation, entry.envelope, z);
          assert.equal(recovered.cacheAccepted, true);
          assert.deepEqual(verifyContinuitySourceReference(sourceRef(entry.header, entry.projectId, entry.envelope), observation, ctx.sessionProjections, z), entry.envelope);
          const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
            ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
          const reordered = { ...observation, header: reorder(observation.header), events: reorder(observation.events) };
          const shuffled = recoverContinuityCheckpoint(ctx.sessionProjections, reordered, entry.envelope, z);
          assert.equal(shuffled.cacheAccepted, true);
          assert.deepEqual(bindContinuityCheckpoint(reordered, shuffled.checkpoint[KEY]), entry.envelope);
          assert.equal(lane.ensurePolicy(entry.header.id, entry.projectId, true), entry.generation);
          assert.deepEqual(lane.enqueue(entry.envelope, entry.projectId, entry.generation, 'turn-end'), { id: entry.jobId, created: false });
        } finally { observation[Symbol.dispose](); }
      });
      await check('genuine ownership/header/depth/origin/floor/source changes still refuse original binding', async () => {
        const entry = saved.healthy, observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
        try {
          const reference = sourceRef(entry.header, entry.projectId, entry.envelope);
          for (const changes of [{ delegationDepth: 1 }, { origin: 'subagent' }, { parentSession: 'foreign-parent' },
            { cwd: '/synthetic/foreign' }, { id: 'foreign-id' }, { createdAt: entry.header.createdAt + 1 }, { isSeeded: true }]) {
            const changed = { ...observation, header: { ...observation.header, ...changes } };
            assert.equal(recoverContinuityCheckpoint(ctx.sessionProjections, changed, entry.envelope, z).cacheAccepted, false);
            assert.throws(() => verifyContinuitySourceReference(reference, changed, ctx.sessionProjections, z), /ownership mismatch|source hash mismatch|own human authority/);
          }
          for (const changed of [{ ...observation, inheritedEventCount: 1 }, { ...observation, events: observation.events.map((event, i) => i ? event : { ...event, data: { ...event.data, content: [{ type: 'text', text: 'FOREIGN-SOURCE' }] } }) }]) {
            assert.equal(recoverContinuityCheckpoint(ctx.sessionProjections, changed, entry.envelope, z).cacheAccepted, false);
            assert.throws(() => verifyContinuitySourceReference(reference, changed, ctx.sessionProjections, z));
          }
        } finally { observation[Symbol.dispose](); }
      });
      await check('persisted experimental binding v1 cache refolds but actual v1 job fails closed without rebinding', async () => {
        const entry = saved.legacy, observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
        try {
          const legacy = lane.readCheckpoint(entry.header.id, entry.projectId);
          assert.deepEqual(legacy, entry.envelope);
          const recovered = recoverContinuityCheckpoint(ctx.sessionProjections, observation, legacy, z);
          assert.equal(recovered.cacheAccepted, false); assert.equal(recovered.reason, 'binding-mismatch');
          const current = bindContinuityCheckpoint(observation, recovered.checkpoint[KEY]);
          assert.deepEqual(current.row, legacy.row); assert.notEqual(current.sourceHash, legacy.sourceHash);
          const job = db.prepare('SELECT * FROM continuity_jobs WHERE id=?').get(entry.jobId);
          assert.equal(job.source_hash, legacy.sourceHash); assert.equal(job.status, 'pending');
          assert.throws(() => verifyContinuitySourceReference({ sessionId: job.session_id, projectId: job.project_id,
            cut: job.cut, sourceHash: job.source_hash }, observation, ctx.sessionProjections, z), /source hash mismatch/);
          assert.throws(() => lane.enqueue(current, entry.projectId, entry.generation, 'turn-end'), /cut regression or conflict/);
          assert.deepEqual(lane.readCheckpoint(entry.header.id, entry.projectId), legacy);
          assert.equal(db.prepare('SELECT source_hash FROM continuity_jobs WHERE id=?').get(entry.jobId).source_hash, legacy.sourceHash);
          assert.equal(lane.listPending(entry.projectId)[0].id, entry.jobId);
        } finally { observation[Symbol.dispose](); }
      });
      await check('unrelated project cannot read restarted checkpoint or enumerate pending work', async () => {
        const unrelated = 'pj-' + 'f'.repeat(32);
        assert.equal(lane.readCheckpoint(saved.healthy.header.id, unrelated), null); assert.deepEqual(lane.listPending(unrelated), []);
      });
      await check('validly rewritten native source fails original hash gate and remains unacknowledged', async () => {
        const entry = saved.corrupt, observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
        try { assert.throws(() => verifyContinuitySourceReference(sourceRef(entry.header, entry.projectId, entry.envelope), observation, ctx.sessionProjections, z), /source hash mismatch/); }
        finally { observation[Symbol.dispose](); }
        assert.equal(lane.listPending(entry.projectId)[0].id, entry.jobId);
      });
      await check('missing persisted native source refuses cold observation and remains unacknowledged', async () => {
        const entry = saved.missing;
        await assert.rejects(() => ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' }));
        assert.equal(lane.listPending(entry.projectId)[0].id, entry.jobId);
      });
      await check('restarted native inherited-only fork preserves floor without inherited human authority or checkpoint', async () => {
        const entry = saved.fork, observation = await ctx.sessionQuery.observeSession(entry.header.id, { projectionMode: 'none' });
        try {
          assert.equal(observation.source, 'prepared');
          // Native fork headers also materialize omitted delegationDepth:0 on cold read.
          assert.deepEqual(observation.header, { ...entry.header, delegationDepth: entry.header.delegationDepth ?? 0 });
          assert.equal(observation.inheritedEventCount, entry.inheritedEventCount);
          const recovered = recoverContinuityCheckpoint(ctx.sessionProjections, observation, null, z), bound = bindContinuityCheckpoint(observation, recovered.checkpoint[KEY]);
          assert.equal(bound.row.val.lastHumanSeq, -1); assert.equal(bound.row.val.inheritedEventCount, entry.inheritedEventCount);
          assert.equal(lane.readCheckpoint(entry.header.id, entry.projectId), null);
          assert.throws(() => verifyContinuitySourceReference(sourceRef(entry.header, entry.projectId, bound), observation, ctx.sessionProjections, z), /ownership mismatch|own human authority/);
          assert.ok(!lane.listPending(entry.projectId).some(job => job.sessionId === entry.header.id));
        } finally { observation[Symbol.dispose](); }
      });
      await check('fresh OS native fork ancestry proof and v3 envelope survive omitted-depth hydration and object key reorder', async () => {
        const cold = await verifyContinuityAncestryV02(ctx.sessionQuery, saved.fork.header.id, saved.fork.projectId, new AbortController().signal);
        assert.deepEqual(cold, saved.ancestry, 'all child/ancestor/header/source/prefix/proof hashes must survive native cold decode');
        const forkObservation = await ctx.sessionQuery.observeSession(saved.fork.header.id, { projectionMode: 'none' });
        try {
          const rebuilt = await createContinuityCheckpointEnvelopeWithLineageSnapshotV03(ctx.sessionQuery, forkObservation,
            saved.fork.projectId, 0, forkObservation.cursor, new AbortController().signal);
          assert.deepEqual(rebuilt.envelope, saved.forkV03Envelope,
            'v3 persisted binding must reconstruct identically from native cold observations');
          assert.deepEqual(rebuilt.envelope.lineage, rebuilt.lineageSnapshot.binding,
            'raw-ID chain remains ephemeral while only its verified hash binding is persisted');
        } finally { forkObservation[Symbol.dispose](); }
        let reads = 0, drops = 0;
        const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object'
          ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
        const reorderedQuery = { async observeSession(id, options) {
          const observation = await ctx.sessionQuery.observeSession(id, options); reads++;
          assert.equal(observation.source, 'prepared'); assert.equal(observation.header.delegationDepth, 0);
          return { ...observation, header: reorder(observation.header), events: reorder(observation.events),
            [Symbol.dispose]() { drops++; observation[Symbol.dispose](); } };
        } };
        assert.deepEqual(await verifyContinuityAncestryV02(reorderedQuery, saved.fork.header.id, saved.fork.projectId, new AbortController().signal), saved.ancestry);
        assert.equal(reads, 2); assert.equal(drops, 2);
        assert.deepEqual(ctx.sessions.list(), [], 'identity proof does not publish native sessions or grant continuation');
      });
      await check('restart inspection leaves v2 jobs pending and v3 revocation fail-closed without provider', async () => {
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM continuity_jobs WHERE status='pending'").get().n, 5);
        assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('continuity_work','continuity_handoff')").get().n, 0,
          'v2 reference store still has no worker pair');
        assert.equal(v3Db.prepare("SELECT COUNT(*) AS n FROM continuity_work WHERE status='running'").get().n, 0);
        assert.equal(v3Db.prepare("SELECT COUNT(*) AS n FROM continuity_work WHERE status='failed'").get().n, 1);
        assert.equal(v3Db.prepare("SELECT COUNT(*) AS n FROM continuity_work WHERE status='completed'").get().n, 1);
        assert.equal(v3Db.prepare('SELECT COUNT(*) AS n FROM continuity_handoff').get().n, 1,
          'completed fixture payload remains stored but its revoked current-reader gate denies access');
        for (const service of ['llm', 'goals', 'systemPrompt', 'agentLoop']) assert.equal(ctx.get(service), undefined);
      });
    }
    console.log(`${mode}: ${passes} PASS / 0 FAIL; pid=${process.pid}; isolated native persistence reinit only`);
  } finally {
    for (const owner of owners) owner.dispose(); store.close(); v3Store.close();
    for (const fiber of fibers.reverse()) await fiber.dispose();
  }
}
