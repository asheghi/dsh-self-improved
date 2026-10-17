// Probe-only plugin composed ONLY into workspace-owned fixtures. Exercises the
// 0.2.1 Peer model against the mounted selfImproved continuity Remote surface.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export default function apply(ctx) {
 ctx.inject(['typertGateway', 'connection'], child => {
  let ran = false;
  child.on('session/event', (session, event) => {
   if (ran || event.type !== 'user/message' || event.surfaceOp !== 'append' || event.data?.source?.rpcId === undefined) return;
   ran = true;
   setImmediate(async () => {
    const results = [];
    const call = peer => child.typertGateway.invoke({ namespace: 'selfImproved', method: 'continuityStatus', args: { targetSessionId: session.id }, ...(peer ? { peer } : {}) });
    try {
     assert.equal(event.data.source.kind, 'user', 'owner prompt is stamped user');
     assert.equal(Object.hasOwn(event.data.source, 'principal'), false, 'owner prompt carries no principal');
     results.push('authenticated owner prompt stamped {kind:user,rpcId} without principal');
     await assert.rejects(call(undefined));
     results.push('direct Gateway invoke without a Peer refused by the Host');
     const guest = child.connection.createPeer({ principal: { kind: 'probe-guest' } });
     await assert.rejects(call(guest), /denied|access|authenticated/i);
     results.push('non-owner principal refused');
     const stale = child.connection.createPeer({ principal: { kind: 'owner' } });
     await stale.dispose();
     await assert.rejects(call(stale), /peer|live|disposed/i);
     results.push('disposed owner Peer refused');
     const owner = child.connection.createPeer({ principal: { kind: 'owner' } });
     try { await call(owner); results.push('live owner Peer admitted (in-process trust, by design)'); }
     finally { await owner.dispose(); }
     await writeFile(join(process.env.DSH_HOME, 'auth-host-probe.json'), JSON.stringify({ passed: true, results }, null, 2));
    } catch (error) { await writeFile(join(process.env.DSH_HOME, 'auth-host-probe.json'), JSON.stringify({ passed: false, results, error: String(error.stack) }, null, 2)); }
   });
  });
 });
}
