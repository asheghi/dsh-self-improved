#!/usr/bin/env node
/** Test-only credentials and captured fake transport requests, never efficacy. */
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,rm,realpath } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { goTransport,conversationKey } from './learned-procedure-go-transport-plugin.mjs';
import { inheritedCredential } from './learned-procedure-credential-env.mjs';
const base=resolve('fixtures/skill-measurement/real-host');await mkdir(base,{recursive:true});const run=await mkdtemp(join(base,'run-go-test-'));let count=0;
try{
 const calls=[],receipts=[];const originalFetch=async request=>{calls.push(request);return new Response('{}');};
 const t=goTransport({baseURL:'https://configured.example/go/v1',userAgent:'deepseek-harness/test (+https://example.test)',run,record:r=>receipts.push(r),fetchImpl:originalFetch});
 const native=Object.freeze({provider:'go-opencode',model:'test-only',sessionId:'private-native-root',messages:Object.freeze([])});
 const body=JSON.stringify({model:'test-only',messages:[{role:'user',content:'test-only task'}]});
 const send=async function*(){await t.fetch('https://configured.example/go/v1/chat/completions',{method:'POST',headers:{authorization:'Bearer test-only-secret'},body});yield {type:'finish'};};
 for await(const _ of t.stream(native,send)){}for await(const _ of t.stream({...native,messages:[{role:'user',content:'later-turn'}]},send)){}
 assert.equal(calls.length,2);assert.equal(calls[0].headers.get('x-opencode-session'),calls[1].headers.get('x-opencode-session'));assert.ok(!calls[0].headers.get('x-opencode-session').includes('private-native-root'));count++;
 assert.equal(calls[0].headers.get('user-agent'),'deepseek-harness/test (+https://example.test)');assert.equal(calls[0].headers.get('authorization'),'Bearer test-only-secret');assert.equal(await calls[0].text(),body);assert.equal(native.sessionId,'private-native-root');count++;
 const aux=Object.freeze({provider:'go-opencode',model:'test-only',system:'test-only review',messages:[{role:'user',content:'test-only evidence'}]});
 for await(const _ of t.stream(aux,send)){}for await(const _ of t.stream(aux,send)){}
 assert.equal(aux.sessionId,undefined);assert.equal(calls[2].headers.get('x-opencode-session'),calls[3].headers.get('x-opencode-session'));assert.notEqual(calls[0].headers.get('x-opencode-session'),calls[2].headers.get('x-opencode-session'));count++;
 assert.notEqual(conversationKey(run,{...aux,system:'different'}),conversationKey(run,aux));assert.notEqual(conversationKey(run,{...native,sessionId:'different'}),conversationKey(run,native));count++;
 await assert.rejects(t.fetch('https://configured.example/go/v1/chat/completions',{method:'POST',body}),/outside bounded/);assert.equal(calls.length,4);count++;
 assert.equal(receipts.length,4);assert.ok(!JSON.stringify(receipts).includes('test-only-secret'));assert.ok(!JSON.stringify(receipts).includes('test-only evidence'));count++;
 const home=join(run,'credential-home');await mkdir(home);const credentialFile=join(home,'.credentials.yaml');const fixture='version: 1\nrefs:\n  PHASE_E_TEST_KEY: test-only-in-memory-inheritance\n';await writeFile(credentialFile,fixture,{mode:0o600});
 const env=await inheritedCredential('/home/bahman/github/dsh-v0.2','PHASE_E_TEST_KEY',home);assert.equal(env.PHASE_E_TEST_KEY,'test-only-in-memory-inheritance');assert.equal(await readFile(credentialFile,'utf8'),fixture);count++;
 console.log(`${count} Go header/privacy/credential-reference checks PASS (no provider call, test-only secret)`);
}finally{assert.equal(await realpath(run),run);assert.ok(run.startsWith(base+'/run-go-test-'));await rm(run,{recursive:true,force:true});}
