// Authenticated actual-offer replay/cross-binding/concurrent-spend checks.
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
const at = process.argv.indexOf('--run'); assert(at >= 0);
const repo = await realpath(resolve('.')), run = await realpath(process.argv[at + 1]);
assert(run.startsWith(join(repo, 'fixtures/v02-ui/temp/'))); await readFile(join(run, '.dsh-mounted-ui-owner.json'));
const facts = JSON.parse(await readFile(join(run, 'facts.json'), 'utf8'));
const state = JSON.parse(await readFile(join(run, 'restart-state.json'), 'utf8'));
const login = new URL(facts.url); assert.equal(login.hostname, '127.0.0.1'); assert.notEqual(login.port, '3082');
const index = await fetch(login, { redirect: 'manual' });
const cookie = index.headers.getSetCookie()[0].split(';')[0];
async function rpc(method, args) { const response = await fetch(login.origin + '/api/' + method, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }) }); assert.equal(response.status, 200); return (await response.json()).result; }
const bound = { targetSessionId: state.targetId, jobId: state.jobId };
async function token() { const result = await rpc('selfImproved/prepareContinue', bound); assert(result.ok); return result.value.token; }
const first = await token();
const crossed = await rpc('selfImproved/continueSession', { ...bound, jobId: 'crossed-job', authorization: { token: first } }); assert.equal(crossed.ok, false);
const second = await token();
const targetCross = await rpc('selfImproved/continueSession', { ...bound, targetSessionId: state.sourceId, authorization: { token: second } }); assert.equal(targetCross.ok, false);
const once = await token();
const results = await Promise.all([1, 2].map(() => rpc('selfImproved/continueSession', { ...bound, authorization: { token: once } })));
assert.equal(results.filter(result => result.ok).length, 1); assert.equal(results.filter(result => !result.ok).length, 1);
assert(results.find(result => result.ok).value.notes.join('\n').includes(state.marker));
const replay = await rpc('selfImproved/continueSession', { ...bound, authorization: { token: once } }); assert.equal(replay.ok, false);
console.log('PASS actual-offer cross-job/cross-target binding, simultaneous one-winner spend, exact source notes and replay refusal over authenticated whole Host HTTP.');
