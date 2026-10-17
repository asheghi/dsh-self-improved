// Executable declaration-contract check against explicit private candidate graph.
import assert from 'node:assert/strict';
import { mkdir, writeFile, realpath, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import ts from 'typescript';
const repo = await realpath(resolve('.'));
const root = await realpath(process.env.DSH_AUTH_CANDIDATE_RUNTIME ?? '');
assert(root.startsWith(join(repo, '.tmp-import-lane/auth-runtime-')), 'private candidate graph required');
assert.equal(JSON.parse(await readFile(join(root, '.auth-runtime-owner.json'), 'utf8')).workspace, repo);
const dir = join(root, 'contract-test'); await mkdir(dir, { recursive: true });
const file = join(dir, 'contract.ts');
await writeFile(file, `
import type { Context } from '@deepseek-ai/cordis';
import type { HostConnectionHandle, AuthenticatedRpcAdmission, AuthenticatedInvocationAdmission, ConnectionRpcHandler } from '@deepseek-ai/dsh-client-connection';
import type { RemoteInvocation } from '@deepseek-ai/dsh-typert-protocol';
import type { InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway';
import '@deepseek-ai/dsh-api-session-controller';
declare const connection: HostConnectionHandle;
declare const invocation: RemoteInvocation;
declare const ctx: Context;
const proof = connection.consumeRpcAdmission({ forged: true }, 'session/prompt', new AbortController().signal, { args: {} });
const live = connection.readAuthenticatedInvocationAdmission(invocation.authenticatedAdmission, 'session/prompt', invocation.request.args);
// @ts-expect-error authentication authority is readonly on the invocation
invocation.authenticatedAdmission = proof;
const provisional = connection.issuePromptReceipt(proof, { sessionId: 'root', requestId: 'request' }, 'host-message');
provisional?.finalize(); provisional?.revoke();
const receipt = connection.consumeFinalizedPromptReceipt(provisional?.receipt);
ctx.on('session/prompt-admission', event => { if (event.phase === 'finalized') connection.consumeFinalizedPromptReceipt(event.receipt); });
const handler: ConnectionRpcHandler = async (endpoint, payload, signal, peer, capability) => { const proof = connection.consumeRpcAdmission(capability, endpoint, signal, payload); return { ok: true, value: proof !== undefined }; };
// Public direct invoke accepts no caller-created authentication field.
// @ts-expect-error opaque authority cannot be created from a public flag
const forged: AuthenticatedRpcAdmission = {};
// @ts-expect-error opaque proof cannot be created from a public flag
const forgedProof: AuthenticatedInvocationAdmission = { authenticated: true };
// @ts-expect-error direct invocation carries no authenticatedAdmission input
const direct: InvokeRemoteRequest = { namespace: 'session', method: 'prompt', args: {}, authenticatedAdmission: proof };
`);
const program = ts.createProgram([file], { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, typeRoots: [join(repo, 'node_modules/@types')] });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) { console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: file => file, getCurrentDirectory: () => repo, getNewLine: () => '\n' })); process.exitCode = 1; }
else console.log('PASS candidate Connection owner APIs, exact lifecycle Event, readonly invocation proof, opaque capability types and absence of direct-invoke auth fields. Dependency declaration checking uses same skipLibCheck policy as strict rc.2 workspace gate.');
