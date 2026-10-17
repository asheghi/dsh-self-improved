#!/usr/bin/env node
// Authorization contract tests only: no real login or credential record writes.
import assert from 'node:assert/strict';
import { safeNotice, authorizeSubscription } from './learned-procedure-authorization-plugin.mjs';
let passed=0;
assert.equal(safeNotice({url:'https://auth.openai.com/oauth/authorize?response_type=code&state=public-test'}).url.startsWith('https://auth.openai.com/'),true);passed++;
for(const url of ['http://auth.openai.com/oauth/authorize','https://evil.example/oauth','http://localhost:1455/auth/callback?code=secret','https://auth.openai.com/callback?code=secret','https://auth.openai.com/token?access_token=secret','https://auth.openai.com/#secret']){assert.throws(()=>safeNotice({url}));passed++;}
assert.deepEqual(safeNotice({message:'arbitrary provider text',code:'never-echo'}),{message:'Subscription sign-in progress'});passed++;
let called=false;
await assert.rejects(authorizeSubscription({describe:()=>({methods:[{id:'api-key'}]}),begin:()=>{called=true;}},new AbortController().signal,()=>{}),/OAuth flow unavailable/);assert.equal(called,false);passed++;
const notices=[],controller=new AbortController();
const result=await authorizeSubscription({describe:key=>{assert.equal(key,'llm-pi-ai/openai-codex');return {methods:[{id:'oauth'}]};},begin:async request=>{assert.equal(request.method,'oauth');assert.equal(request.key,'llm-pi-ai/openai-codex');assert.equal(request.secret,undefined);request.interaction.notify({url:'https://auth.openai.com/oauth/authorize?state=test'});return {status:'authorized'};}},controller.signal,n=>notices.push(n));assert.equal(result.status,'authorized');assert.equal(notices.length,1);passed++;
console.log(`${passed} isolated OAuth helper contract checks PASS (no real login)`);
