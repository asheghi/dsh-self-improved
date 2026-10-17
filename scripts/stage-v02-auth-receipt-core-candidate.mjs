// Workspace-only build candidate. Public runtime is never mutated.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
const runtime = process.env.DSH_RUNTIME_RC2;
assert(runtime, 'explicit DSH_RUNTIME_RC2 required');
const req = createRequire(resolve(runtime, 'package.json'));
const lane = resolve('.tmp-import-lane/auth-receipt-core-candidate');
await mkdir(lane, { recursive: true });
const names = ['dsh-client-connection', 'dsh-api-gateway', 'dsh-api-session-controller'];
const sources = {};
for (const name of names) sources[name] = await readFile(resolve(runtime, `node_modules/@deepseek-ai/${name}/lib/index.js`), 'utf8');
function replace(name, old, next) { assert.equal(sources[name].split(old).length, 2, `${name}: exact anchor ${old.slice(0,70)}`); sources[name] = sources[name].replace(old, next); }
const c = names[0], g = names[1], s = names[2];
replace(c, '\t\t/* LOCAL PATCH (dsh-v0.2 test instance): browser authentication disabled for loopback use. */\n\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\treturn void 0;', '\t\tif (!isTrustedApiRequest(request, this.trustedHosts)) return 403;\n\t\treturn this.browserAuth.isAuthenticated(request) ? void 0 : 401;');
replace(c, '\t\t/* LOCAL PATCH (dsh-v0.2 test instance): browsing index is always authorized. */\n\t\tif (process.env.DSH_DISABLE_LOCAL_AUTH === "1") return true;\n', '');
replace(c, 'const API_PATH = "/api";', `const API_PATH = "/api";
// Authority is owned exclusively by the authenticated HTTP route. None of these maps is exported.
const authenticatedNodeRequests = new WeakMap();
const authenticatedFetchRequests = new WeakMap();
const authenticatedRpcCapabilities = new WeakMap();
const authenticatedInvocationProofs = new WeakMap();
async function authenticatedBridge(req, res, handler, peer, limit) {
 const owner = { live: true, peer, authority: header(req.headers, "host"), nonce: randomUUID() };
 authenticatedNodeRequests.set(req, owner);
 try { return await bridge(req, res, handler, limit); }
 finally { owner.live = false; authenticatedNodeRequests.delete(req); }
}
function admissionHash(value) { if (value === undefined) return null; return createHash("sha256").update(JSON.stringify(value, (_key, part) => part !== null && typeof part === "object" && !Array.isArray(part) ? Object.fromEntries(Object.keys(part).sort().map(key => [key, part[key]])) : part)).digest("hex"); }
const authenticatedPromptReceipts = new WeakMap();
function consumeAuthenticatedRpcAdmission(capability, endpoint, signal, payload) {
 const record = authenticatedRpcCapabilities.get(capability);
 if (!record) return undefined;
 authenticatedRpcCapabilities.delete(capability);
 if (!record.owner.live || record.signal.aborted || signal !== record.signal || endpoint !== record.endpoint || admissionHash(payload) !== record.payloadHash) return undefined;
 const proof = Object.freeze({});
 authenticatedInvocationProofs.set(proof, record);
 return proof;
}
function issueAuthenticatedPromptReceipt(proof, request, messageId) {
 const record = authenticatedInvocationProofs.get(proof);
 if (!record || record.promptUsed || !readAuthenticatedInvocationAdmission(proof, "session/prompt") || admissionHash(request) !== record.promptHash) return undefined;
 record.promptUsed = true;
 const receipt = Object.freeze({ kind: "host-prompt-admission", receiptId: record.owner.nonce, sessionId: request.sessionId, messageId, requestId: request.requestId });
 const state = { phase: "provisional", consumed: false, peerId: record.owner.peer.id };
 authenticatedPromptReceipts.set(receipt, state);
 return { receipt, finalize() { if (!readAuthenticatedInvocationAdmission(proof, "session/prompt") || state.phase !== "provisional") return false; state.phase = "finalized"; return true; }, revoke() { state.phase = "revoked"; } };
}
function consumeFinalizedAuthenticatedPromptReceipt(receipt) {
 const state = authenticatedPromptReceipts.get(receipt);
 if (!state || state.phase !== "finalized" || state.consumed) return undefined;
 state.consumed = true;
 return receipt;
}
function readAuthenticatedInvocationAdmission(proof, endpoint, args) {
 const record = authenticatedInvocationProofs.get(proof);
 if (!record || !record.owner.live || record.signal.aborted || record.endpoint !== endpoint || (args !== undefined && admissionHash({ args }) !== record.payloadHash)) return undefined;
 return Object.freeze({ requestNonce: record.owner.nonce, peerId: record.owner.peer.id, authority: record.owner.authority });
}`);
replace(c, '\t/** Exact Fetch-route registry scoped to the Context reading this service. */', '\tconsumeRpcAdmission(capability, endpoint, signal, payload) { const proof = consumeAuthenticatedRpcAdmission(capability, endpoint, signal, payload); return proof && readAuthenticatedInvocationAdmission(proof, endpoint)?.peerId === this.operator.id ? proof : undefined; }\n\tissuePromptReceipt(proof, request, messageId) { return readAuthenticatedInvocationAdmission(proof, "session/prompt")?.peerId === this.operator.id ? issueAuthenticatedPromptReceipt(proof, request, messageId) : undefined; }\n\tconsumeFinalizedPromptReceipt(receipt) { return authenticatedPromptReceipts.get(receipt)?.peerId === this.operator.id ? consumeFinalizedAuthenticatedPromptReceipt(receipt) : undefined; }\n\treadAuthenticatedInvocationAdmission(proof, endpoint, args) { const result = readAuthenticatedInvocationAdmission(proof, endpoint, args); return result?.peerId === this.operator.id ? result : undefined; }\n\t/** Exact Fetch-route registry scoped to the Context reading this service. */');
replace(c, '\tconst response = await apiHandler.fetch(request);', '\tconst admissionOwner = authenticatedNodeRequests.get(req);\n\tif (admissionOwner) authenticatedFetchRequests.set(request, admissionOwner);\n\tconst response = await apiHandler.fetch(request);');
replace(c, '\t\t\t\tawait bridge(req, res, fetchHandler);', '\t\t\t\tawait authenticatedBridge(req, res, fetchHandler, admission.peer);');
replace(c, '\t\t\t\tawait webCtx.waterfall("connection/request", req, res, () => bridge(req, res, fetchHandler, maxRequestBodyBytes));', '\t\t\t\tawait webCtx.waterfall("connection/request", req, res, () => authenticatedBridge(req, res, fetchHandler, admission.peer, maxRequestBodyBytes));');
replace(c, '\t\t\t\tconst result = await handler(endpoint, message.payload, request.signal, peer);', `\t\t\t\tconst owner = authenticatedFetchRequests.get(request);
                const capability = owner?.live && !request.signal.aborted ? Object.freeze({}) : undefined;
                if (capability) authenticatedRpcCapabilities.set(capability, { owner, signal: request.signal, endpoint, payloadHash: admissionHash(message.payload), promptHash: admissionHash(message.payload?.args?.request) });
                let result;
                try { result = await handler(endpoint, message.payload, request.signal, peer, capability); }
                finally { if (capability) authenticatedRpcCapabilities.delete(capability); }`);
// Verify through the mounted Connection owner. Loader/HMR can import plugin
// entries with a query revision, so static module exports cannot own authority.

replace(g, '(endpoint, payload, signal, peer) => this.dispatchRpc(endpoint, payload, signal, peer)', '(endpoint, payload, signal, peer, admission) => this.dispatchRpc(endpoint, payload, signal, peer, admission)');
replace(g, 'async dispatchRpc(endpoint, payload, signal, peer) {', 'async dispatchRpc(endpoint, payload, signal, peer, admission) {');
replace(g, 'return this.invokeRpc(endpoint, payload, signal, peer);', 'return this.invokeRpc(endpoint, payload, signal, peer, admission);');
replace(g, 'async invokeRpc(endpoint, payload, signal, peer) {', 'async invokeRpc(endpoint, payload, signal, peer, admission) {');
replace(g, 'const prepared = await this.prepareInvocation(remoteRequest(endpoint, payload, signal, peer), new AbortController());', 'const authenticatedAdmission = this.ctx.get("connection")?.consumeRpcAdmission?.(admission, endpoint, signal, payload);\n\t\t\tconst prepared = await this.prepareInvocation(remoteRequest(endpoint, payload, signal, peer), new AbortController(), authenticatedAdmission);');
replace(g, 'async prepareInvocation(request, control) {', 'async prepareInvocation(request, control, authenticatedAdmission) {');
replace(g, '\t\tif (descriptor.cancellation !== void 0) args.push(signal);', '\t\tObject.defineProperty(invocation, "authenticatedAdmission", { value: authenticatedAdmission, enumerable: true });\n\t\tif (process.env.DSH_AUTH_DIAG === "1") console.warn("[auth candidate] gateway", endpoint, !!authenticatedAdmission);\n\t\tif (descriptor.cancellation !== void 0) args.push(signal);');
// Exact receipt event is core-owned, body-free, provisional until delivery succeeds.
// Prompt admission uses its actual mounted Connection service, not a second static module instance.
replace(s, 'async prompt(request) {', 'async prompt(request, authenticatedAdmission) {');
replace(s, '\t\t\treturn this.commands.prompt(request);', '\t\t\tif (process.env.DSH_AUTH_DIAG === "1") console.warn("[auth candidate] prompt wrapper", !!this.ctx.invocation, !!this.ctx.invocation?.authenticatedAdmission);\n\t\t\treturn this.commands.prompt(request, this.ctx.invocation?.authenticatedAdmission);');
replace(s, '\t\t\t\t\tif (request.mode === "steer") agent.steer(message);\n\t\t\t\t\telse agent.followup(message);\n\t\t\t\t\tbinding.commit();', `                    const connection = this.ctx.get("connection");
                    const admitted = connection?.readAuthenticatedInvocationAdmission?.(authenticatedAdmission, "session/prompt");
                    if (authenticatedAdmission && !admitted) throw new RemoteError("gateway/cancelled", "authenticated prompt carrier cancelled", {});
                    const receiptOwner = admitted ? connection.issuePromptReceipt(authenticatedAdmission, request, message.id) : undefined;
                    const receipt = receiptOwner?.receipt;
                    if (process.env.DSH_AUTH_DIAG === "1") console.warn("[auth candidate] prompt", !!authenticatedAdmission, !!admitted, !!receipt);
                    if (admitted && !receipt) throw new RemoteError("gateway/bad-request", "authenticated prompt arguments substituted or receipt already used", {});
                    if (receipt) this.ctx.emit("session/prompt-admission", Object.freeze({ phase: "provisional", receipt }));
                    try {
                        if (request.mode === "steer") agent.steer(message);
                        else agent.followup(message);
                        binding.commit();
                        if (receipt) {
                            if (!receiptOwner.finalize()) throw new RemoteError("gateway/cancelled", "authenticated prompt admission expired", {});
                            this.ctx.emit("session/prompt-admission", Object.freeze({ phase: "finalized", receipt }));
                        }
                    } catch (error) {
                        if (receipt) { receiptOwner.revoke(); this.ctx.emit("session/prompt-admission", Object.freeze({ phase: "revoked", receipt })); }
                        throw error;
                    }`);
for (const name of names) {
 await writeFile(resolve(lane, `${name}.candidate.js`), sources[name]);
 const executable = sources[name].replace(/from "([^"\n]+)"/g, (all, spec) => {
  if (spec.startsWith('node:')) return all;
  const localName = spec.startsWith('@deepseek-ai/') ? spec.slice('@deepseek-ai/'.length) : '';
  return `from ${JSON.stringify(pathToFileURL(names.includes(localName) ? resolve(lane, `${localName}.mjs`) : spec === 'ws' ? resolve(runtime, 'node_modules/ws/wrapper.mjs') : req.resolve(spec)).href)}`;
 });
 await writeFile(resolve(lane, `${name}.mjs`), executable + (name === c ? '\nexport { BrowserAuth };\n' : name === s ? '\nexport { SessionCommandController };\n' : ''));
}
const declarationRoot = resolve(lane, 'declarations');
await mkdir(declarationRoot, { recursive: true });
const declaration = `
declare const authenticatedRpcBrand: unique symbol;
declare const authenticatedInvocationBrand: unique symbol;
export interface AuthenticatedRpcAdmission { readonly [authenticatedRpcBrand]: true }
export interface AuthenticatedInvocationAdmission { readonly [authenticatedInvocationBrand]: true }
export interface AuthenticatedPromptReceipt { readonly kind: 'host-prompt-admission'; readonly receiptId: string; readonly sessionId: string; readonly messageId: string; readonly requestId: string }
declare module '@deepseek-ai/dsh-typert-protocol' { interface RemoteInvocation { readonly authenticatedAdmission?: AuthenticatedInvocationAdmission } }
`;
for (const [name, file] of [[c, 'index.d.ts'], [c, 'rpc.d.ts'], [c, 'rpc-host.d.ts'], [s, 'index.d.ts']]) {
 let text = await readFile(resolve(runtime, `node_modules/@deepseek-ai/${name}/lib/types/${file}`), 'utf8');
 if (name === c && file === 'index.d.ts') text += declaration;
 if (name === c && file === 'rpc.d.ts') {
 text = text.replace('signal: AbortSignal, peer: PeerScope) =>', 'signal: AbortSignal, peer: PeerScope, admission?: import("./index.ts").AuthenticatedRpcAdmission) =>');
 text = text.replace('export interface HostConnectionHandle {', 'export interface HostConnectionHandle {\n    consumeRpcAdmission(capability: unknown, endpoint: string, signal: AbortSignal, payload: unknown): import("./index.ts").AuthenticatedInvocationAdmission | undefined;\n    issuePromptReceipt(proof: unknown, request: { sessionId: string; requestId: string }, messageId: string): { receipt: import("./index.ts").AuthenticatedPromptReceipt; finalize(): boolean; revoke(): void } | undefined;\n    consumeFinalizedPromptReceipt(receipt: unknown): import("./index.ts").AuthenticatedPromptReceipt | undefined;\n    readAuthenticatedInvocationAdmission(proof: unknown, endpoint: string, args: Readonly<Record<string, unknown>>): Readonly<{ requestNonce: string; peerId: string; authority: string }> | undefined;');
 }
 if (name === c && file === 'rpc-host.d.ts') text = text.replace('    private registerFetchRoute;', '    consumeRpcAdmission(capability: unknown, endpoint: string, signal: AbortSignal, payload: unknown): import("./index.ts").AuthenticatedInvocationAdmission | undefined;\n    issuePromptReceipt(proof: unknown, request: { sessionId: string; requestId: string }, messageId: string): { receipt: import("./index.ts").AuthenticatedPromptReceipt; finalize(): boolean; revoke(): void } | undefined;\n    consumeFinalizedPromptReceipt(receipt: unknown): import("./index.ts").AuthenticatedPromptReceipt | undefined;\n    readAuthenticatedInvocationAdmission(proof: unknown, endpoint: string, args: Readonly<Record<string, unknown>>): Readonly<{ requestNonce: string; peerId: string; authority: string }> | undefined;\n    private registerFetchRoute;');
 if (name === s) text += `\ndeclare module '@deepseek-ai/cordis' { interface Events { /** Host-only unary authenticated prompt lifecycle; use the Connection finalized-receipt verifier, never copied event data. @mode emit */ 'session/prompt-admission'(event: { readonly phase: 'provisional' | 'finalized' | 'revoked'; readonly receipt: import('@deepseek-ai/dsh-client-connection').AuthenticatedPromptReceipt }): void } }\n`;
 await writeFile(resolve(declarationRoot, `${name}.${file}`), text);
}
const fingerprint = bytes => createHash('sha256').update(bytes).digest('hex');
const files = [];
for (const name of [c, g, s]) { const path = `${name}/lib/index.js`, candidate = resolve(lane, `${name}.candidate.js`); files.push({ path, candidate, originalHash: fingerprint(await readFile(resolve(runtime, `node_modules/@deepseek-ai/${path}`))), candidateHash: fingerprint(await readFile(candidate)) }); }
for (const [name, file] of [[c, 'index.d.ts'], [c, 'rpc.d.ts'], [c, 'rpc-host.d.ts'], [s, 'index.d.ts']]) { const path = `${name}/lib/types/${file}`, candidate = resolve(declarationRoot, `${name}.${file}`); files.push({ path, candidate, originalHash: fingerprint(await readFile(resolve(runtime, `node_modules/@deepseek-ai/${path}`))), candidateHash: fingerprint(await readFile(candidate)) }); }
const packages = await Promise.all([c,g,s].map(async name => { const bytes = await readFile(resolve(runtime, `node_modules/@deepseek-ai/${name}/package.json`)); return { name: `@deepseek-ai/${name}`, version: JSON.parse(bytes).version, manifestHash: fingerprint(bytes) }; }));
await writeFile(resolve(lane, 'cutover-manifest.json'), JSON.stringify({ version: 1, workspace: resolve('.'), installedRuntime: resolve(runtime), acceptance: 'pending', packages, files }, null, 2));
console.log(`Staged exact candidate copies under ${lane}; installed runtime unchanged. Unary HTTP only; contracts/types/plugin integration and stream parity pending.`);
