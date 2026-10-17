#!/usr/bin/env node
/** Focused executor/verifier tests. Local repairs below are test solutions, NOT
 * provider outcomes, learned episodes, synthesized drafts or efficacy evidence.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { resolve, join,relative } from 'node:path';
import { cases, writeCase, tree,sha256 } from './learned-procedure-cases.mjs';
import { verifyCase } from './verify-learned-procedure-case.mjs';
import { freezeExperiment,assertFreeze, restoreCase, NativeGateway,verifiedEffects,activateThenRecord,assertInvocationEvidence,measuredUsage } from './run-learned-procedure.mjs';
import { apply as mountBudget, createBudget, createTokenBudget, boundedNativeRequest, NATIVE_OUTPUT_TOKENS, MAX_TOTAL_TOKENS, MAX_CALLS, MAX_SESSION_CALLS } from './learned-procedure-budget-plugin.mjs';
import { runtimeFingerprint } from './learned-procedure-runtime-fingerprint.mjs';
const base=resolve('fixtures/skill-measurement/real-host');await mkdir(base,{recursive:true});
const run=await mkdtemp(join(base,'run-validator-'));let count=0;
try {
 await writeFile(join(run,'owner.json'),JSON.stringify({purpose:'isolated-real-learned-procedure',home:join(run,'home'),stub:false,seededEpisodes:0}));
 await mkdir(join(run,'home/profiles/learned-evaluation'),{recursive:true});await writeFile(join(run,'home/profiles/learned-evaluation/cordis.patch.yml'),'test-only-profile\n');
 const prior=join(run,'test-only-prior');await mkdir(join(prior,'evaluation'),{recursive:true});await writeFile(join(prior,'evaluation/freeze.json'),'test-only prior failed freeze');await writeFile(join(run,'amendment.json'),JSON.stringify({priorRun:relative(resolve('.'),prior),priorFreezeSha256:sha256('test-only prior failed freeze')}));
 await writeFile(join(run,'route.json'),JSON.stringify({provider:'test-only-provider',model:'test-only-model'}));
 await writeFile(join(run,'runtime.json'),JSON.stringify(await runtimeFingerprint('/home/bahman/github/dsh-v0.2')));
 await mkdir(join(run,'plugin/lib'),{recursive:true});await writeFile(join(run,'plugin/lib/index.js'),'// test-only build\n');
 const fixed=`import {readFileSync,mkdirSync,copyFileSync} from 'node:fs';import {dirname} from 'node:path';const walk=v=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(walk):[];for(const p of new Set(walk(JSON.parse(readFileSync('package.json','utf8')).exports))){if(!p.startsWith('./dist/'))continue;mkdirSync(dirname(p),{recursive:true});copyFileSync(p.endsWith('.cjs')?'src/api.cjs':'src/api.mjs',p);}\n`;
 for(const task of cases){
  const project=await restoreCase(run,task);
  // training-oneline deliberately ships an already-correct deterministic build:
  // its initial state verifies, so only tamper/success paths run for it.
  if(task.kind==='procedure'&&task.id!=='training-oneline')await assert.rejects(verifyCase(task.id,project));count++;
  // Reset after verifier, whose build may have created broken dist artifacts.
  await restoreCase(run,task);
  if(task.kind==='procedure')await writeFile(join(project,'scripts/build.mjs'),fixed);
  else if(task.kind==='unrelated-control')await writeFile(join(project,'src/sum.mjs'),'export const sumFinite = values => values.filter(v=>typeof v===\'number\'&&Number.isFinite(v)).reduce((a,b)=>a+b,0);\n');
  else await writeFile(join(project,'scripts/build.mjs'),"if(process.argv.includes('--check')){console.log('CHECK_ONLY');process.exit(0);}\n"+task.files['scripts/build.mjs']);
  assert.equal((await verifyCase(task.id,project)).passed,true);count++;
  await writeFile(join(project,'docs/keep.txt'),'tampered');await assert.rejects(verifyCase(task.id,project),/unrelated file changed/);count++;
 }
 const effectProject=await restoreCase(run,cases[0]);await writeFile(join(effectProject,'scripts/build.mjs'),fixed);const effects=await verifiedEffects(effectProject,cases[0].id);assert.equal(effects.passed,true);assert.ok(!Object.keys(effects.agentEndTree).some(p=>p.startsWith('dist/')));assert.ok(Object.keys(effects.finalTree).some(p=>p.startsWith('dist/')));assert.match(effects.scoring,/not claimed agent-produced/);count++;
 assert.deepEqual(measuredUsage([{usage:{inputTokens:365,outputTokens:33,cacheReadTokens:896,totalTokens:1294}}]),{promptTokens:1261,uncachedInputTokens:365,cacheReadTokens:896,cacheWriteTokens:0,outputTokens:33});assert.equal(measuredUsage([{usage:{inputTokens:1,outputTokens:2}}]).promptTokens,1);assert.equal(measuredUsage([{usage:{inputTokens:1}}]).promptTokens,null);count++;
 let activated=false,rolledBack=false;try{await activateThenRecord(async()=>({ok:true}),async()=>{throw Error('test-only evidence write failure');},()=>{activated=true;});}catch(error){assert.match(error.message,/evidence write failure/);}finally{if(activated)rolledBack=true;}assert.equal(rolledBack,true);count++;
 const skill={name:'test-procedure',published:{rendered:'test-only exact published content'}};const content=[{type:'text',text:skill.published.rendered}],invocations=[{name:skill.name,content}],calls=[{skillInvocations:[{name:skill.name,contentSha256:sha256(JSON.stringify(content))}]}];assertInvocationEvidence('learned',skill,invocations,calls);assert.throws(()=>assertInvocationEvidence('learned',skill,[{name:skill.name,content:[{type:'text',text:'stale same-name body'}]}],calls),/body differs/);count++;
 assert.throws(()=>assertInvocationEvidence('learned',skill,invocations,[{skillInvocations:[{name:skill.name,contentSha256:sha256('different provider body')}]}]),/body differs/);assertInvocationEvidence('baseline',null,[],[{skillInvocations:[]}]);count++;
 await mkdir(join(run,'evaluation'),{recursive:true});
  await writeFile(join(run,'evaluation/provider.jsonl'),JSON.stringify({kind:'budget-mounted',sourceSha256:'stale-test-only',maxTotalTokens:MAX_TOTAL_TOKENS})+'\n');
  await assert.rejects(freezeExperiment(run,'test-only-model'),/restart isolated Host/);count++;
  mountBudget({on:()=>{}},{runDir:run});
  const frozen=await freezeExperiment(run,'test-only-model');assert.equal(frozen.cases.length,cases.length);await assert.rejects(freezeExperiment(run,'another'),/no replacing/);count++;
 const routeBytes=await readFile(join(run,'route.json'));await writeFile(join(run,'route.json'),JSON.stringify({provider:'changed-after-freeze',model:'test-only-model'}));await assert.rejects(assertFreeze(run),/route changed/);await writeFile(join(run,'route.json'),routeBytes);count++;
  await writeFile(join(run,'plugin/lib/index.js'),'// mutated transitive build');await assert.rejects(assertFreeze(run),/transitive plugin module/);await writeFile(join(run,'plugin/lib/index.js'),'// test-only build\n');count++;
  const b=createBudget();for(let i=0;i<MAX_SESSION_CALLS;i++)b.admit('same');assert.throws(()=>b.admit('same'),/session-call budget/);assert.equal(b.total,MAX_SESSION_CALLS);count++;
 const recovered=createBudget(Array.from({length:MAX_SESSION_CALLS},(_,i)=>({kind:'call-start',call:i+1,sessionId:'same'})));assert.throws(()=>recovered.admit('same'),/session-call budget/);assert.equal(recovered.admit('another'),MAX_SESSION_CALLS+1);assert.throws(()=>createBudget([{kind:'call-start',call:2}]),/chronology/);count++;
 const global=createBudget();for(let i=0;i<MAX_CALLS;i++)global.admit(null);assert.throws(()=>global.admit(null),/provider-call budget/);assert.equal(global.total,MAX_CALLS);count++;
 const token=createTokenBudget();assert.throws(()=>token.reserve(undefined,10),/ceilings/);assert.throws(()=>token.reserve(10,undefined),/ceilings/);assert.throws(()=>token.reserve(MAX_TOTAL_TOKENS,1),/remaining/);assert.equal(token.reserve(1000,100),1100);assert.throws(()=>token.reserve(1,1),/concurrent/);token.finish({inputTokens:200,outputTokens:20});assert.equal(token.spent,220);count++;
  assert.equal(token.reserve(MAX_TOTAL_TOKENS-221,1),MAX_TOTAL_TOKENS-220);token.cancelBeforeDispatch();assert.throws(()=>token.reserve(MAX_TOTAL_TOKENS-220,1),/remaining/);count++;
  const unknown=createTokenBudget();unknown.reserve(10,10);assert.throws(()=>unknown.finish(null),/usage/);assert.throws(()=>unknown.reserve(1,1),/blocked/);count++;
  const exceeded=createTokenBudget();exceeded.reserve(10,10);assert.throws(()=>exceeded.finish({inputTokens:15,outputTokens:6}),/ceiling/);assert.throws(()=>exceeded.reserve(1,1),/blocked/);count++;
  const complete=[{kind:'call-start',call:1,tokenReservation:100},{kind:'call-end',call:1,usage:{inputTokens:10,outputTokens:2}}];const recoveredTokens=createTokenBudget(complete);assert.equal(recoveredTokens.spent,12);assert.equal(recoveredTokens.reserve(100,10),110);count++;
  assert.throws(()=>createTokenBudget([{kind:'call-start',call:1,tokenReservation:100}]).reserve(1,1),/unfinished/);assert.throws(()=>createTokenBudget([{kind:'call-start',call:1},{kind:'call-end',call:1,usage:{inputTokens:1,outputTokens:1}}]).reserve(1,1),/legacy/);assert.throws(()=>createTokenBudget([{kind:'call-end',call:1}]),/unmatched/);count++;
  assert.throws(()=>new NativeGateway('http://127.0.0.1:3082/?token=test'));assert.throws(()=>new NativeGateway('https://example.com'));count++;
 const originalFetch=globalThis.fetch,requests=[];globalThis.fetch=async(url,options)=>{
  if(!options?.body)return {headers:{getSetCookie:()=>['dsh-auth-test=synthetic-test-only']}};
  const body=JSON.parse(options.body);requests.push(body);const method=body.method;
  let value;
  if(method==='session/create')value={sessionId:'test-only-root'};
  else if(method==='session/modelCatalog')value={default:{provider:'openai-codex',model:'test'}};
  else if(method==='session/prompt')value={accepted:true};
  else if(method==='session/projections')value={asOfSeq:42};
   else if(method==='session/page'){assert.equal(body.payload.args.request.throughSeq,42);value={hasMore:false,records:[{event:{type:'turn/end',data:{reason:{kind:'completed'}}}}]};}
  else if(method==='commands/execute')value={result:{kind:'success',text:'test-only command'}};
  else throw Error('unexpected endpoint');
  return {status:200,json:async()=>({result:{ok:true,value}})};
 };
 try{const gateway=new NativeGateway('http://127.0.0.1:12345/?token=synthetic-test-only');await gateway.authenticate();const id=await gateway.create(join(run,'project'),'test','openai-codex');let admitted;const output=await gateway.execute(id,'task',receipt=>{admitted=receipt;});assert.equal(admitted.sessionId,id);assert.ok(admitted.requestId);assert.equal(output.turnEnd.kind,'completed');await gateway.command(id,'/memory evolve');
  const request=requests.find(r=>r.method==='session/prompt').payload.args.request;
  assert.deepEqual(Object.keys(request).sort(),['content','mode','requestId','sessionId']);assert.equal(request.source,undefined);assert.equal(request.authority,undefined);count++;
 }finally{globalThis.fetch=originalFetch;}
 const originalConfig=Object.freeze({provider:'openai-codex',model:'test-only',reasoningEffort:'low'});const bounded=await boundedNativeRequest({},async()=>originalConfig);assert.deepEqual(bounded,{...originalConfig,maxTokens:NATIVE_OUTPUT_TOKENS});assert.equal(originalConfig.maxTokens,undefined);assert.notEqual(bounded,originalConfig);assert.equal(frozen.budgets.nativeOutputTokens,NATIVE_OUTPUT_TOKENS);count++;
  let stream,requestPolicy;mountBudget({on:(event,handler,options)=>{if(event==='llm/stream')stream=handler;else{assert.equal(event,'agent/request');assert.equal(options.global,true);requestPolicy=handler;}}},{runDir:run});assert.equal(requestPolicy,boundedNativeRequest);count++;
  const modelRuntime={resolveModelInfo:async()=>({context:{contextWindow:1000}})};
  let dispatched=0;const chunks=async function*(){dispatched++;yield {type:'usage',usage:{inputTokens:10,outputTokens:2}};yield {type:'finish',reason:{kind:'stop'}};};
  const options=Object.freeze({provider:'test-only',model:'test-only',messages:Object.freeze([]),maxTokens:100});
  for await(const _ of stream.call(modelRuntime,options,chunks)){}assert.equal(dispatched,1);assert.equal(options.maxTokens,100);count++;
  await assert.rejects(async()=>{for await(const _ of stream.call(modelRuntime,{...options,maxTokens:undefined},chunks)){}},/ceilings/);assert.equal(dispatched,1);count++;
  await assert.rejects(async()=>{for await(const _ of stream.call(modelRuntime,options,async function*(){dispatched++;yield {type:'finish',reason:{kind:'stop'}};})){}},/usage/);
  await assert.rejects(async()=>{for await(const _ of stream.call(modelRuntime,options,chunks)){}},/blocked/);assert.equal(dispatched,2);count++;
  const project=join(run,'project');assert.equal(await realpath(project),project);await rm(project,{recursive:true,force:true});
 await symlink(join(run,'home'),project,'dir');await assert.rejects(restoreCase(run,cases[0]),/unexpected project symlink/);count++;
 console.log(`${count} focused learned-procedure executor/verifier checks PASS (test solutions only; no efficacy run)`);
}finally{assert.equal(await realpath(run),run);assert.ok(run.startsWith(base+'/run-validator-'));await rm(run,{recursive:true,force:true});}
