// Probe-only plugin composed ONLY into workspace-owned candidate fixtures.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
export default function apply(ctx) {
 ctx.inject(['typertGateway', 'connection'], child => {
  let ran = false;
  child.on('session/prompt-admission', event => {
   if (ran || event.phase !== 'finalized') return;
   ran = true;
   setImmediate(async () => {
    const results = [];
    try {
     assert.equal(child.connection.consumeFinalizedPromptReceipt(event.receipt), undefined, 'main already spent exact finalized receipt');
     assert.equal(child.connection.consumeFinalizedPromptReceipt({ ...event.receipt }), undefined, 'copied receipt has no authority');
     results.push('finalized exact receipt replay and copied-object claim refused');
     for (const spoof of [{}, { peer: child.connection.operator }, { peer: child.connection.operator, authenticatedAdmission: { authenticated: true }, admission: event.receipt }]) {
      await assert.rejects(child.typertGateway.invoke({ namespace: 'selfImproved', method: 'prepareContinue', args: { targetSessionId: 'probe-target', jobId: 'probe-job' }, ...spoof }), /authenticated|Host|operator/i);
     }
     results.push('direct Gateway invoke omitted-peer/operator-peer/forged-authority all refused');
     await writeFile(join(process.env.DSH_HOME, 'auth-host-probe.json'), JSON.stringify({ passed: true, results }, null, 2));
    } catch (error) { await writeFile(join(process.env.DSH_HOME, 'auth-host-probe.json'), JSON.stringify({ passed: false, results, error: String(error.stack) }, null, 2)); }
   });
  });
 });
}
