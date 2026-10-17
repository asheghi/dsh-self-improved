// Real staged Connection HTTP bridge + Gateway preparation + installed prompt controller.
// Business receiver/Agent delivery are controlled probes, not mounted native Session acceptance.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import './stage-v02-auth-receipt-core-candidate.mjs';
const runtime = process.env.DSH_RUNTIME_RC2;
const requireRuntime = createRequire(resolve(runtime, 'package.json'));
const { Context } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/cordis')).href);
const lane = resolve('.tmp-import-lane/auth-receipt-core-candidate');
const c = await import(pathToFileURL(resolve(lane, 'dsh-client-connection.mjs')).href);
const { TypertGatewayService } = await import(pathToFileURL(resolve(lane, 'dsh-api-gateway.mjs')).href);
const { SessionCommandController } = await import(pathToFileURL(resolve(lane, 'dsh-api-session-controller.mjs')).href);
let record;
const auth = await c.BrowserAuth.create({}, { async modifyRecord(_key, fn) { const next = await fn(record); if (next !== undefined) record = next; return record; } }, 30);
const ctx = new Context();
const { SessionStore } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-session')).href);
const sessionFiber = ctx.plugin(SessionStore); await sessionFiber.await();
const nativeSession = ctx.sessions.create('auth-native-root', { meta: { cwd: '/synthetic/auth-receipt-project' } });
const { ContinuityPromptReceiptLedgerV03 } = await import('../lib/continuity-prompt-receipt-v03.js');
const ledger = new ContinuityPromptReceiptLedgerV03();
const admittedCoordinates = [];
const pendingFinalized = [];
let policyGeneration = 1;
const receiptGeneration = new WeakMap();
const { SessionProjectionRegistry } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-session-projection')).href);
const { SessionQueryEngine } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-session-query')).href);
const projectionFiber = ctx.plugin(SessionProjectionRegistry); await projectionFiber.await();
const queryFiber = ctx.plugin(SessionQueryEngine); await queryFiber.await();
const { verifyContinuityAncestryV02 } = await import('../lib/continuity-ancestry-v02.js');
async function drainFinalized() {
 for (const { receipt, generation } of pendingFinalized.splice(0)) {
  if (generation !== policyGeneration) continue;
  const proof = await verifyContinuityAncestryV02(ctx.sessionQuery, receipt.sessionId, projectId, new AbortController().signal);
  if (!proof || generation !== policyGeneration) continue;
  const session = ctx.sessions.get(receipt.sessionId);
  const event = session.snapshotEvents().find(event => event.type === 'user/message' && event.data.id === receipt.messageId);
  assert(ledger.acceptHostPrompt({ kind: 'host-prompt-accepted', sessionId: receipt.sessionId, projectId, messageId: receipt.messageId, requestId: receipt.requestId, generation }));
  const coordinate = ledger.observeLiveAppend(session, event, projectId, generation);
  if (coordinate) admittedCoordinates.push(coordinate);
 }
}
const { opaqueProjectIdFromKey, projectKeyFromCwd } = await import('../lib/capture.js');
const projectId = opaqueProjectIdFromKey(projectKeyFromCwd('/synthetic/auth-receipt-project'));
const connection = new c.HostConnectionService(ctx, [], auth);
let route;
const owner = { effect(fn) { return fn(); }, webServer: { register(value) { route = value; return () => {}; } } };
const events = [];
let failDelivery = false, delivered = 0;
const agent = { id: nativeSession.id, session: nativeSession, inbox: { nextTurn: [], nextStep: [] }, followup(message) { if (failDelivery) throw new Error('controlled delivery rejection'); delivered++; this.session.append('user/message', message, { surfaceOp: 'append' }); }, steer(message) { this.followup(message); } };
let admissionHold, mainAuth;
const prompt = Object.create(SessionCommandController.prototype);
prompt.resolveAgent = async () => agent;
prompt.ctx = { get: ctx.get.bind(ctx), agents: { get: () => agent }, attachments: { admitPromptContent: async content => { if (admissionHold) { admissionHold.enter(); await admissionHold.promise; } return content; } }, fileUploads: { resolve() {}, bindPrompt() { return { commit() {}, [Symbol.dispose]() {} }; } }, emit(name, payload) { if (payload.phase === 'provisional') { assert.equal(connection.consumeFinalizedPromptReceipt(payload.receipt), undefined); receiptGeneration.set(payload.receipt, policyGeneration); }
 if (payload.phase === 'finalized' && !mainAuth) { const receipt = connection.consumeFinalizedPromptReceipt(payload.receipt); assert(receipt); pendingFinalized.push({ receipt, generation: receiptGeneration.get(receipt) }); }
 events.push({ name, ...payload }); } };
const receiver = { async prompt(request) {
 const proof = this.ctx.invocation.authenticatedAdmission;
 assert.equal(Object.getOwnPropertyDescriptor(this.ctx.invocation, 'authenticatedAdmission').writable, false);
 const admitted = connection.readAuthenticatedInvocationAdmission(proof, 'session/prompt');
 if (!admitted) return { authenticated: false };
 await prompt.prompt(request, proof);
 assert.equal(connection.issuePromptReceipt(proof, request, 'second-message'), undefined, 'proof is one-use for prompt issuance');
 return { authenticated: true };
} };
receiver.typertRemote = { service: receiver, serviceKey: 'probe', namespace: 'session' };
const gateway = Object.create(TypertGatewayService.prototype);
gateway.ctx = ctx;
gateway.operatorPeer = () => connection.operator;
gateway.resolveDescriptor = () => ({ service: 'probe', namespace: 'session', method: 'prompt', parameters: [{ wire: 'request', source: 'json', codec: { mode: 'src-json' } }], invocation: { kind: 'direct' }, result: { mode: 'src-json' } });
gateway.resolveReceiverContext = async () => ({ get: () => receiver, extend: ({ invocation }) => ({ get: () => Object.assign(Object.create(receiver), { ctx: { invocation } }) }) });
let capturedCap, capturedSignal, substitutePayload = false, handlerCompletion;
connection.register(owner, '/probe', async (_endpoint, payload, signal, peer, capability) => {
 capturedCap = capability; capturedSignal = signal;
 if (substitutePayload) payload = { args: { request: { ...payload.args.request, sessionId: 'substituted-session' } } };
 let complete; handlerCompletion = new Promise(resolve => { complete = resolve; });
 try { return await gateway.invokeRpc(_endpoint, payload, signal, peer, capability); } finally { complete(); }
});
// Channel endpoint binds capability: use /probe/session/prompt.
const server = createServer((req, res) => Promise.resolve(route.handler(req, res)).catch(error => { res.writeHead(500); res.end(String(error)); }));
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let status, headers;
auth.authorizeIndex({ headers: { host: new URL(base).host }, method: 'GET', url: new URL(auth.authenticatedUrl(base + '/')).pathname + new URL(auth.authenticatedUrl(base + '/')).search }, { writeHead(s, h) { status = s; headers = h; }, end() {} });
assert.equal(status, 303);
const cookie = headers['set-cookie'].split(';')[0];
const args = () => ({ request: { sessionId: agent.id, requestId: 'request-' + delivered, content: [{ type: 'text', text: 'probe human input' }], mode: 'followup' } });
async function post(cookieValue, signal) { return fetch(base + '/probe/session/prompt', { method: 'POST', signal, headers: { 'content-type': 'application/json', ...(cookieValue ? { cookie: cookieValue } : {}) }, body: JSON.stringify({ type: 'client-request', rpcId: 'probe-rpc', method: 'session/prompt', payload: { args: args() } }) }); }
try {
 assert.equal((await post()).status, 401);
 assert.equal((await post('forged=value')).status, 401);
 const success = await post(cookie); const data = await success.json();
 assert.equal(data.result.ok, true, JSON.stringify(data)); assert.equal(data.result.value.authenticated, true);
 assert.deepEqual(events.map(x => x.phase), ['provisional', 'finalized']);
 assert.equal(events[0].receipt.messageId, agent.session.snapshotEvents().find(event => event.type === 'user/message').data.id);
 assert(!JSON.stringify(events).includes('probe human input'));
 assert.equal(connection.consumeFinalizedPromptReceipt({ ...events[1].receipt }), undefined);
 await drainFinalized(); assert.equal(admittedCoordinates.length, 1, 'native root append receives exactly one finalized authenticated boundary');
 assert.equal(connection.consumeFinalizedPromptReceipt(events[1].receipt), undefined);
 const replay = await gateway.invokeRpc('session/prompt', { args: args() }, capturedSignal, connection.operator, capturedCap);
 assert.equal(replay.value.authenticated, false);
 const forged = await gateway.invokeRpc('session/prompt', { args: args() }, new AbortController().signal, connection.operator, { requestNonce: 'forged', authenticated: true });
 assert.equal(forged.value.authenticated, false);
 const direct = await gateway.invoke({ namespace: 'session', method: 'prompt', args: args(), peer: connection.operator, authenticatedAdmission: capturedCap });
 assert.equal(direct.authenticated, false);
 substitutePayload = true;
 const substituted = await (await post(cookie)).json(); assert.equal(substituted.result.value.authenticated, false); assert.equal(delivered, 1); substitutePayload = false;
 failDelivery = true;
 const failed = await post(cookie); const failure = await failed.json(); assert.equal(failure.result.ok, false);
 assert.deepEqual(events.slice(-2).map(x => x.phase), ['provisional', 'revoked']);
 assert.equal(delivered, 1);
 assert.equal(connection.consumeFinalizedPromptReceipt(events.at(-1).receipt), undefined, 'revoked receipt never grants boundary');
 failDelivery = false;
 const child = ctx.sessions.fork(nativeSession, undefined, 'auth-native-fork');
 const inherited = child.snapshotEvents().find(event => event.type === 'user/message');
 assert(inherited.seq < child.firstLiveSeq);
 assert.equal(ledger.observeLiveAppend(child, inherited, projectId, policyGeneration), null, 'inherited native append cannot become child human support');
 agent.id = child.id; agent.session = child;
 assert.equal((await (await post(cookie)).json()).result.value.authenticated, true);
 await drainFinalized(); assert.equal(admittedCoordinates.length, 2); assert.equal(admittedCoordinates.at(-1).sessionId, child.id);
 const delegated = ctx.sessions.create('auth-native-subagent', { meta: { cwd: '/synthetic/auth-receipt-project', parentSession: nativeSession.id, isSeeded: false, origin: 'subagent', delegationDepth: 1 } });
 agent.id = delegated.id; agent.session = delegated;
 assert.equal((await (await post(cookie)).json()).result.value.authenticated, true);
 await assert.rejects(drainFinalized(), /delegat|subagent/); assert.equal(admittedCoordinates.length, 2, 'Host-authenticated operator prompt cannot convert delegated ancestry into eligible continuity');
 agent.id = nativeSession.id; agent.session = nativeSession;
 assert.equal((await (await post(cookie)).json()).result.value.authenticated, true);
 policyGeneration++; await drainFinalized(); assert.equal(admittedCoordinates.length, 2, 'policy drift drops finalized receipt before durable boundary');
 const beforeCancel = { delivered, events: events.length, coordinates: admittedCoordinates.length };
 let enter, release;
 const entered = new Promise(resolve => { enter = resolve; });
 admissionHold = { enter, promise: new Promise(resolve => { release = resolve; }) };
 const cancel = new AbortController();
 const cancelledPost = post(cookie, cancel.signal); const rejection = assert.rejects(cancelledPost);
 await entered;
 const aborted = capturedSignal.aborted ? Promise.resolve() : new Promise(resolve => capturedSignal.addEventListener('abort', resolve, { once: true }));
 cancel.abort(); await aborted; release(); await rejection; await handlerCompletion; admissionHold = undefined;
 assert.equal(delivered, beforeCancel.delivered); assert.equal(events.length, beforeCancel.events); assert.equal(admittedCoordinates.length, beforeCancel.coordinates);
 const { mountContinuityHostAuthV02, authenticatedContinuityInvocation } = await import('../lib/continuity-host-auth-v02.js');
 mainAuth = mountContinuityHostAuthV02(ctx, () => policyGeneration, () => true);
 const priorEmit = prompt.ctx.emit;
 prompt.ctx.emit = (name, event) => { ctx.emit(name, event); priorEmit(name, event); };
 assert.equal((await (await post(cookie)).json()).result.value.authenticated, true);
 const rootHuman = nativeSession.snapshotEvents().filter(event => event.type === 'user/message').at(-1);
 assert(mainAuth.has(nativeSession, rootHuman.seq, policyGeneration), 'mounted v2 auth owner pairs finalized native message');
 assert.equal(authenticatedContinuityInvocation(ctx), false, 'plain Context and shared operator do not authenticate Continue');
 const { createUserMessage } = await import(pathToFileURL(requireRuntime.resolve('@deepseek-ai/dsh-llm')).href);
 const forgedAppend = nativeSession.append('user/message', createUserMessage({ source: { kind: 'user', rpcId: 'forged-automation-rpc' }, content: [{ type: 'text', text: 'unauthenticated automation' }] }), { surfaceOp: 'append' });
 assert.equal(mainAuth.has(nativeSession, forgedAppend.seq, policyGeneration), false, 'projection human-looking append cannot acquire auth');
 policyGeneration++; assert.equal(mainAuth.has(nativeSession, rootHuman.seq, policyGeneration), false, 'mounted owner rejects stale epoch');
 ctx.emit('session/prompt-admission', { phase: 'finalized', receipt: { ...events.at(-1).receipt } });
 assert.equal(mainAuth.has(nativeSession, forgedAppend.seq, policyGeneration), false);
 mainAuth.dispose();
 if (process.argv.includes('--loader')) {
  mainAuth = {}; // The actual main-plugin owner now consumes finalized receipts.
  const { runAuthReceiptLoaderCandidate } = await import('./auth-receipt-loader-candidate-fixture.mjs');
  await runAuthReceiptLoaderCandidate({ ctx, gateway, agent, prompt, runtime, nativeSession, async request(endpoint, namedArgs) {
   const response = await fetch(base + '/probe/' + endpoint, { method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify({ type: 'client-request', rpcId: 'loader-rpc', method: endpoint, payload: { args: namedArgs } }) });
   return response.json();
  } });
 }
 console.log('PASS actual HTTP signed admission -> real GatewayInvocation -> installed prompt controller; body-free Host message receipt; no-cookie/forged/direct-invoke/capability-replay refusal; failed delivery revocation.');
 console.log('PASS native Session/fork ancestry and finalized-only existing plugin ledger pairing, inherited/delegated refusal, stale policy and held-prompt cancellation. Partial unary candidate: controlled Agent driver/reflection, no mounted main/Continue/browser/generated-contract/full auth acceptance.');
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await connection.operator.dispose(); }
for (const name of ['dsh-client-connection', 'dsh-api-gateway', 'dsh-api-session-controller']) assert.equal((await readFile(resolve(runtime, `node_modules/@deepseek-ai/${name}/lib/index.js`), 'utf8')).includes('authenticatedNodeRequests'), false, 'runtime untouched');
