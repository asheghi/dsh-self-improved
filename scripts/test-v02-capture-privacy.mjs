#!/usr/bin/env node
// Phase B privacy regression: inspect the actual plugin persistence boundary.
// All evidence and secrets here are synthetic; no files, providers, or profiles.
import { installCapture } from '../lib/capture.js';
let failures = 0;
for (const lane of ['user/message', 'assistant/message', 'tool/result']) {
  let flush;
  let records = [];
  const secret = 'SYNTHETIC_PASSWORD_123456';
  const content = [{ type: 'text', text: `password=${secret}` }];
  const data = lane === 'user/message'
    ? { role: 'user', source: { kind: 'user' }, content }
    : { message: { role: lane === 'assistant/message' ? 'assistant' : 'tool', source: { kind: lane === 'assistant/message' ? 'model' : 'tool' }, content, ...(lane === 'tool/result' ? { toolCallId: 'synthetic-call' } : {}) } };
  const store = {
    appendConversationSlice(_id, value) { records.push(...value); },
    markPending() {}, setSessionProject() {},
  };
  installCapture({ on(_name, handler) { flush = handler; } }, store, { enabled: () => true });
  await flush({ id: 'synthetic-privacy', header: { cwd: '/synthetic/project' }, inheritedEventCount: 0,
    ownEvents: () => [{ type: lane, seq: 0, time: 1, data }] });
  const safe = !JSON.stringify(records).includes(secret);
  console.log(`${safe ? 'PASS' : 'FAIL'} ${lane}: no raw synthetic credential reaches plugin persistence`);
  if (!safe) failures++;
}
if (failures) process.exitCode = 1;
console.log(`Capture persistence privacy: ${failures ? 'FAILED' : 'PASS'}`);
