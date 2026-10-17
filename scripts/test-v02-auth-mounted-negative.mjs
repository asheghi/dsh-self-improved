// Actual candidate Host HTTP authentication negatives; private fixture only.
import assert from 'node:assert/strict';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { request as rawRequest } from 'node:http';
const at = process.argv.indexOf('--run'); assert(at >= 0 && process.argv[at + 1], '--run required');
const repo = await realpath(resolve('.')); const run = await realpath(process.argv[at + 1]);
assert(run.startsWith(join(repo, 'fixtures/v02-ui/temp/')), 'owned synthetic fixture only');
await readFile(join(run, '.dsh-mounted-ui-owner.json'));
const facts = JSON.parse(await readFile(join(run, 'facts.json'), 'utf8'));
const login = new URL(facts.url); assert.equal(login.hostname, '127.0.0.1'); assert.notEqual(login.port, '3082');
const response = await fetch(login, { redirect: 'manual' }); assert.equal(response.status, 303);
const cookie = response.headers.getSetCookie()[0].split(';')[0]; const base = login.origin;
const results = [];
async function check(label, expected, cookieValue, extra = {}) {
 const response = await new Promise((resolve, reject) => {
  const request = rawRequest(base + '/api/selfImproved/snapshot', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookieValue ? { cookie: cookieValue } : {}), ...extra } }, async response => { const chunks = []; for await (const chunk of response) chunks.push(chunk); resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }); });
  request.on('error', reject); request.end(JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'selfImproved/snapshot', payload: { args: {} } }));
 });
 assert.equal(response.status, expected, label); results.push({ label, passed: true });
 if (expected === 200) assert.equal(JSON.parse(response.body).result.ok, true, 'real snapshot dispatch succeeds');
}
await check('genuine signed cookie admits actual Gateway snapshot', 200, cookie);
await check('no cookie is rejected before dispatch', 401);
await check('forged cookie is rejected before dispatch', 401, 'dsh-auth-forged=v1.fake.signature');
await check('tampered genuine cookie is rejected', 401, cookie.slice(0, -1) + (cookie.endsWith('A') ? 'B' : 'A'));
await check('wrong authority cookie is rejected', 401, cookie, { host: '127.0.0.1:1' });
await check('cross-Origin genuine cookie is rejected', 403, cookie, { origin: 'http://evil.example' });
await check('launch token is not an API bearer substitute', 401, undefined, { authorization: 'Bearer ' + login.searchParams.get('token') });
const continued = await fetch(base + '/api/selfImproved/prepareContinue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: 'selfImproved/prepareContinue', payload: { args: { targetSessionId: 'forged-target', jobId: 'forged-job' } } }) });
assert.equal(continued.status, 401); results.push({ label: 'Continue without authenticated ingress is refused', passed: true });
await writeFile(join(run, 'auth-negative-receipt.json'), JSON.stringify({ version: 1, boundary: 'actual private copied-core Host; not physical-human-click proof', build: facts.build, client: facts.client, results }, null, 2));
console.log('PASS whole candidate Host genuine signed-cookie dispatch and no-cookie/forged/tampered/wrong-authority/cross-Origin/API-bearer/Continue negatives. No profile/settings/session mutation.');
