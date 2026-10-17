#!/usr/bin/env node
/** Genuine isolated Host executor. Staged CLI: freeze -> train -> pipeline -> evaluate.
 * Does not export credentials, invent sources, hand-author a skill, or set human
 * source metadata. Native authenticated Host ingress owns admission provenance.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, realpath, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { cases, CASESET_HASH, sha256, writeCase, tree } from './learned-procedure-cases.mjs';
import { verifyCase } from './verify-learned-procedure-case.mjs';
import { assertSandboxAvailable, npmFingerprint } from './learned-procedure-sandbox.mjs';
import { runtimeFingerprint } from './learned-procedure-runtime-fingerprint.mjs';
import { MAX_CALLS, MAX_SESSION_CALLS, MAX_TOTAL_TOKENS, NATIVE_OUTPUT_TOKENS } from './learned-procedure-budget-plugin.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url));
const sources=['learned-procedure-cases.mjs','verify-learned-procedure-case.mjs','learned-procedure-budget-plugin.mjs','learned-procedure-sandbox.mjs','learned-procedure-task-tools-plugin.mjs','run-learned-procedure.mjs','learned-procedure-go-transport-plugin.mjs','learned-procedure-skill-audit-plugin.mjs','learned-procedure-credential-env.mjs','start-learned-procedure-host.mjs','learned-procedure-runtime-fingerprint.mjs','learned-procedure-go-amendment.json'];
const exists=path=>access(path).then(()=>true,()=>false);
export async function freezeExperiment(runDir,model){
 const run=await ownedRun(runDir);assert.ok(typeof model==='string'&&model.trim(),'explicit frozen model required');
 const out=join(run,'evaluation');await mkdir(out,{recursive:true});
 assert.equal(await exists(join(out,'freeze.json')),false,'freeze exists: no replacing tasks after outputs');
 if(await exists(join(out,'provider.jsonl')))assert.equal((await providerRecords(run)).some(r=>r.kind==='call-start'),false,'freeze must precede every evaluation provider call');
 await mkdir(join(run,'project'),{recursive:true});await assertSandboxAvailable(join(run,'project'));
 const sourceSha256={};for(const name of sources)sourceSha256[name]=sha256(await readFile(join(repo,'scripts',name)));
 const mounted=(await providerRecords(run)).filter(r=>r.kind==='budget-mounted').at(-1);
 assert.equal(mounted?.sourceSha256,sourceSha256['learned-procedure-budget-plugin.mjs'],'restart isolated Host with current budget plugin before freeze');
 assert.equal(mounted.maxTotalTokens,MAX_TOTAL_TOKENS,'mounted token budget mismatch');
 assert.equal(mounted.nativeOutputTokens,NATIVE_OUTPUT_TOKENS,'mounted native request budget mismatch');
 const route=JSON.parse(await readFile(join(run,'route.json'),'utf8'));assert.equal(route.model,model,'explicit selected model must match frozen configured route');
 const runtime=JSON.parse(await readFile(join(run,'runtime.json'),'utf8'));assert.deepEqual(await runtimeFingerprint(runtime.root),runtime,'candidate runtime changed since bootstrap');
 const amendment=JSON.parse(await readFile(join(run,'amendment.json'),'utf8'));assert.equal(sha256(await readFile(join(repo,amendment.priorRun,'evaluation/freeze.json'))),amendment.priorFreezeSha256,'prior failed pilot freeze changed');
 const frozen={amendment,amendmentSha256:sha256(await readFile(join(run,'amendment.json'))),metricsPolicy:'promptTokens = uncached input + optional cacheRead + optional cacheWrite; absent optional cache counts=0, missing required usage=null',runtime,pluginLibTree:await tree(join(run,'plugin/lib')),version:'executed-package-repair-v2-infrastructure-corrected',createdAt:Date.now(),model,provider:route.provider,route,routeSha256:sha256(await readFile(join(run,'route.json'))),casesSha256:CASESET_HASH,sourceSha256,npmFingerprint:await npmFingerprint(),
  benefitRule:{primary:'verified task-effect paired wins must exceed losses',controls:'both arms must pass unrelated and current-rule controls',safety:'independent scope/privacy/native-lineage review must find no violations',rollout:'no automation expansion unless benefits exceed measured error/context/provider-cost regressions',tie:'report ties without replacement tasks or retries',cost:'unavailable subscription monetary cost is null, never zero'},
  budgets:{providerCalls:MAX_CALLS,perSessionProviderCalls:MAX_SESSION_CALLS,totalTokens:MAX_TOTAL_TOKENS,nativeOutputTokens:NATIVE_OUTPUT_TOKENS,nativeRequestPolicy:'agent/request replacement before header logging; no GenerateOptions mutation',tokenAdmission:'reserve declared model contextWindow plus explicit maxTokens; serialize; unknown usage blocks subsequent calls'},armOrder:[['baseline','learned'],['learned','baseline'],['baseline','learned']],
  profileSha256:sha256(await readFile(join(run,'home/profiles/learned-evaluation/cordis.patch.yml'))),
  buildSha256:sha256(await readFile(join(run,'plugin/lib/index.js'))),
  cases:cases.map(c=>({id:c.id,kind:c.kind,promptSha256:sha256(c.prompt),initialTree:Object.fromEntries(Object.entries(c.files).map(([p,v])=>[p,sha256(v)]).sort(([a],[b])=>a.localeCompare(b)))})),
  limits:['Task-effect evidence only; no statistical generalization','Unknown subscription cost remains null','Operator/native admission receipts and raw lineage require review']};
 await writeFile(join(out,'freeze.json'),JSON.stringify(frozen,null,2)+'\n',{flag:'wx'});return frozen;
}
export async function ownedRun(runDir){
 const run=await realpath(runDir),root=await realpath(join(repo,'fixtures/skill-measurement/real-host'));
 assert.ok(run.startsWith(root+'/run-'),'not an isolated evaluation run');
 const owner=JSON.parse(await readFile(join(run,'owner.json'),'utf8'));
 assert.equal(owner.purpose,'isolated-real-learned-procedure');assert.equal(owner.stub,false);assert.equal(owner.seededEpisodes,0);assert.equal(owner.home,join(run,'home'));
 return run;
}
export async function restoreCase(run,task){
 const project=join(run,'project');
 if(await exists(project)){const target=await realpath(project);assert.equal(target,project,'unexpected project symlink');assert.equal(resolve(project),join(await ownedRun(run),'project'));await rm(target,{recursive:true,force:true});}
 await writeCase(task,project);assert.deepEqual(await tree(project),Object.fromEntries(Object.entries(task.files).map(([p,v])=>[p,sha256(v)]).sort(([a],[b])=>a.localeCompare(b))));return project;
}
export async function assertFreeze(run){
 const frozen=JSON.parse(await readFile(join(run,'evaluation/freeze.json'),'utf8'));
 assert.equal(frozen.casesSha256,CASESET_HASH,'case definitions changed after freeze');
 assert.deepEqual(await tree(join(run,'plugin/lib')),frozen.pluginLibTree,'transitive plugin module changed after freeze');
 assert.deepEqual(await runtimeFingerprint(frozen.runtime.root),frozen.runtime,'candidate runtime compiled boundary changed after freeze');
 assert.equal(sha256(await readFile(join(run,'amendment.json'))),frozen.amendmentSha256,'infrastructure amendment changed after freeze');
 assert.equal(sha256(await readFile(join(run,'route.json'))),frozen.routeSha256,'provider/header/credential-reference route changed after freeze');
 assert.deepEqual(await npmFingerprint(),frozen.npmFingerprint,'sandboxed npm distribution changed after freeze');
 for(const name of sources)assert.equal(sha256(await readFile(join(repo,'scripts',name))),frozen.sourceSha256[name],'executor/verifier changed after freeze');
 assert.equal(sha256(await readFile(join(run,'plugin/lib/index.js'))),frozen.buildSha256,'plugin changed after freeze');
 assert.equal(sha256(await readFile(join(run,'home/profiles/learned-evaluation/cordis.patch.yml'))),frozen.profileSha256,'profile changed after freeze');return frozen;
}
export class NativeGateway {
 constructor(url){this.url=new URL(url);assert.equal(this.url.hostname,'127.0.0.1');assert.notEqual(this.url.port,'3082');this.cookie='';}
 async authenticate(){const response=await fetch(this.url,{redirect:'manual'});const cookies=response.headers.getSetCookie();this.cookie=(cookies[0]??'').split(';')[0];assert.ok(this.cookie.startsWith('dsh-auth-'),'isolated launch cookie missing');this.url.search='';}
 async rpc(endpoint,args){const response=await fetch(new URL('/api/'+endpoint,this.url),{method:'POST',headers:{'content-type':'application/json',cookie:this.cookie},body:JSON.stringify({type:'client-request',rpcId:randomUUID(),method:endpoint,payload:{args}}),signal:AbortSignal.timeout(240000)});
  const envelope=await response.json();assert.equal(response.status,200,endpoint+' HTTP failure');assert.equal(envelope.result?.ok,true,endpoint+' failed: '+JSON.stringify(envelope.result?.error));return envelope.result.value;
 }
 async create(cwd,model,provider){const catalog=await this.rpc('session/modelCatalog',{});assert.equal(catalog.default?.provider,provider,'select isolated default provider BEFORE freeze');assert.equal(catalog.default?.model,model,'select isolated default model BEFORE freeze');const session=await this.rpc('session/create',{request:{cwd,agentPreset:'learned-evaluation'}});assert.ok(session.sessionId);return session.sessionId;}
 async command(sessionId,line){const execution=await this.rpc('commands/execute',{agentId:sessionId,line,submittedAttachments:[]});assert.ok(execution?.result&&execution.result.kind!=='error',line+' refused: '+execution?.result?.text);return execution;}
 async execute(sessionId,prompt,onAdmitted=async()=>{}){
  const startedAt=Date.now();const requestId=randomUUID();const ack=await this.rpc('session/prompt',{request:{requestId,sessionId,mode:'queue',content:[{type:'text',text:prompt}]}});assert.equal(ack.accepted,true);try{await onAdmitted({sessionId,requestId,startedAt});
  let records=[];const deadline=startedAt+180000;
  while(Date.now()<deadline){const projection=await this.rpc('session/projections',{request:{sessionId}});assert.ok(Number.isSafeInteger(projection?.asOfSeq),'current native cursor unavailable');const page=await this.rpc('session/page',{request:{address:{kind:'session',sessionId},throughSeq:projection.asOfSeq,maxMessages:256,turnWindow:{minMessages:1,minTurns:2}}});assert.equal(page.hasMore,false,'capture page incomplete');records=page.records;
   const end=records.find(r=>r.event?.type==='turn/end');if(end)return {sessionId,requestId,startedAt,endedAt:Date.now(),records,turnEnd:end.event.data.reason};
   await new Promise(r=>setTimeout(r,250));
  }
  await this.rpc('session/cancel',{request:{sessionId}});throw Error('native task timed out; cancelled, no retry');
  }catch(error){try{await this.rpc('session/cancel',{request:{sessionId}});}catch{}throw error;}
 }
}
function dbRead(run,fn){const db=new DatabaseSync(join(run,'home/memory/memory.db'),{readOnly:true});try{return fn(db);}finally{db.close();}}
function providerRecords(run){return readFile(join(run,'evaluation/provider.jsonl'),'utf8').then(text=>text.trim().split('\n').filter(Boolean).map(JSON.parse));}
async function save(out,name,value){const bytes=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';await writeFile(join(out,name),bytes,{flag:'wx',mode:0o600});return {path:name,sha256:sha256(bytes)};}
export function measuredUsage(ends){
 const keys=['inputTokens','outputTokens','cacheReadTokens','cacheWriteTokens'];
 if(!ends.length||!ends.every(e=>e?.usage&&keys.every(k=>(k.startsWith('cache')&&e.usage[k]===undefined)||Number.isSafeInteger(e.usage[k])&&e.usage[k]>=0)))return {promptTokens:null,uncachedInputTokens:null,cacheReadTokens:null,cacheWriteTokens:null,outputTokens:null};
 const sum=k=>ends.reduce((n,e)=>n+(e.usage[k]??0),0);
 return {promptTokens:sum('inputTokens')+sum('cacheReadTokens')+sum('cacheWriteTokens'),uncachedInputTokens:sum('inputTokens'),cacheReadTokens:sum('cacheReadTokens'),cacheWriteTokens:sum('cacheWriteTokens'),outputTokens:sum('outputTokens')};
}
export async function verifiedEffects(project,taskId,verify=verifyCase){
 const agentEndTree=await tree(project);let passed=false,error=null;
 try{await verify(taskId,project);passed=true;}catch(e){error=e.message;}
 return {agentEndTree,finalTree:await tree(project),passed,error,scoring:'external verifier executes repaired program; post-verifier generated artifacts are not claimed agent-produced'};
}
export async function activateThenRecord(activate,record,markActive){const receipt=await activate();markActive();await record(receipt);}
export function assertInvocationEvidence(arm,skill,invocations,calls){
 assert.equal(invocations.length,arm==='learned'?1:0,'native skill invocation mismatch');
 const expected=arm==='learned'?[{type:'text',text:skill.published.rendered}]:null;
 if(expected){assert.equal(invocations[0].name,skill.name);assert.deepEqual(invocations[0].content,expected,'native invoked skill body differs from published exact draft');}
 for(const call of calls){assert.equal(call.skillInvocations?.length,arm==='learned'?1:0,'provider skill invocation mismatch');if(expected){assert.equal(call.skillInvocations[0].name,skill.name);assert.equal(call.skillInvocations[0].contentSha256,sha256(JSON.stringify(expected)),'provider invoked skill body differs from published exact draft');}}
}
async function publishedSkill(run,draft,since){
 const {activationRequestFromDraft}=await import(pathToFileURL(join(run,'plugin/lib/skill-activation-runtime.js')));
 const {renderLearnedSkillBody}=await import(pathToFileURL(join(run,'plugin/lib/skill-activation.js')));
 const request=activationRequestFromDraft({...draft,sourceEpisodeIds:JSON.parse(draft.source_episode_ids),evaluationVersion:draft.evaluation_version});
 for(let i=0;i<50;i++){
  const records=await readFile(join(run,'evaluation/published-skills.jsonl'),'utf8').then(t=>t.trim().split('\n').filter(Boolean).map(JSON.parse),()=>[]);
  const record=records.filter(r=>r.at>=since&&r.skill?.name===draft.name).at(-1);
  if(record){const stamp=/Activated: ([^\n]+)/.exec(record.skill.content)?.[1];const activatedAt=Date.parse(stamp??'');assert.ok(Number.isSafeInteger(activatedAt),'published activation timestamp missing');
   assert.equal(record.skill.content,renderLearnedSkillBody({...request,activatedAt}),'published same-name skill differs from approved draft transform');return record;}
  await new Promise(r=>setTimeout(r,100));
 }
 throw Error('actual published skill artifact missing; no efficacy prompt submitted');
}
export async function runCase(run,gateway,frozen,task,arm,skill,repeat=null){
  // Repeated identical tasks must never collide on evidence filenames: each
  // execution gets its own repeat stamp while keeping arm/task identity.
  const prefix=repeat===null?`${task.id}-${arm}`:`${task.id}-${arm}-repeat-${repeat}`;
 const project=await restoreCase(run,task);await assertSandboxAvailable(project);
 const sessionId=await gateway.create(project,frozen.model,frozen.provider);
 const toolReceipts=(await readFile(join(run,'evaluation/task-tool-receipts.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
 assert.ok(toolReceipts.some(r=>r.sessionId===sessionId&&r.cwd===project&&r.isolation==='bwrap-unshare-all-project-only'&&r.tools.length===1&&r.tools[0]==='project_bash'),'native isolated task capability receipt missing; no prompt submitted');
 const prompt=arm==='learned'?`/${skill.name}\n\n${task.prompt}`:task.prompt;
 const out=join(run,'evaluation');
 const capture=await gateway.execute(sessionId,prompt,receipt=>save(out,prefix+'.admission.json',receipt));
 const invocations=capture.records.filter(r=>r.event?.type==='user/message'&&r.event.data?.source?.kind==='skill-invocation').map(r=>({name:r.event.data.source.name,content:r.event.data.content}));
 const raw=await save(out,prefix+'.capture.json',capture);
 const effects=await verifiedEffects(project,task.id);
 const agentEndTree=await save(out,prefix+'.agent-end-tree.json',effects.agentEndTree);
 const finalTree=await save(out,prefix+'.final-tree.json',effects.finalTree);
 const {passed,error}=effects;
 const verification=await save(out,prefix+'.verification.json',{captureSha256:raw.sha256,agentEndTreeSha256:agentEndTree.sha256,finalTreeSha256:finalTree.sha256,scoring:effects.scoring,verifierSha256:frozen.sourceSha256['verify-learned-procedure-case.mjs'],exitCode:passed?0:1,passed,error,verifiedAt:Date.now()});
 const calls=(await providerRecords(run)).filter(r=>r.kind==='call-start'&&r.sessionId===sessionId);
 assert.ok(calls.length>0,'no genuine provider seam calls');assertInvocationEvidence(arm,skill,invocations,calls);const all=await providerRecords(run);const ends=calls.map(c=>all.find(r=>r.kind==='call-end'&&r.call===c.call));
 const usage=measuredUsage(ends);
 const nativeCalls=await save(out,prefix+'.native-calls.json',{calls,ends,invocations});
 const configurations=calls.map(c=>c.configuration);const configuration=configurations[0];
 assert.ok(configurations.every(c=>JSON.stringify(c)===JSON.stringify(configuration)),'configuration changed within task');
 return {rootSessionId:sessionId,promptSha256:sha256(task.prompt),initialStateSha256:sha256(JSON.stringify(frozen.cases.find(t=>t.id===task.id).initialTree)),configuration,capture:raw,verification,agentEndTree,finalTree,invocationCapture:nativeCalls,
  invokedSkills:invocations.map(i=>({name:i.name,draftId:skill.id,draftSha256:sha256(skill.markdown),publishedContentSha256:sha256(skill.published.rendered)})),
  // Do not invent a zero privacy/scope violation count. Review raw calls and trees.
  safetyViolations:null,metrics:{...usage,providerCalls:calls.length,cost:null,elapsedMs:capture.endedAt-capture.startedAt},passed,completed:capture.turnEnd?.kind==='completed'};
}
export async function prepare(run,gateway,model){
 assert.ok(typeof model==='string'&&model.trim(),'explicit model required');assert.equal(await exists(join(run,'evaluation/freeze.json')),false,'prepare model before freeze only');
 const route=JSON.parse(await readFile(join(run,'route.json'),'utf8'));assert.equal(route.model,model,'prepare exact configured model');
 const project=join(run,'project');await mkdir(project,{recursive:true});await assertSandboxAvailable(project);
 const session=await gateway.rpc('session/create',{request:{cwd:project,agentPreset:'learned-evaluation'}});
 await gateway.rpc('session/selectModel',{request:{sessionId:session.sessionId,provider:route.provider,model,...(route.reasoningEffort?{reasoningEffort:route.reasoningEffort}:{})}});
 const deadline=Date.now()+5000;let catalog;do{catalog=await gateway.rpc('session/modelCatalog',{});if(catalog.default?.provider===route.provider&&catalog.default?.model===model)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
 assert.equal(catalog.default?.provider,route.provider);assert.equal(catalog.default?.model,model);return {prepared:true,model,provider:route.provider,note:'No prompt or provider task call submitted; now freeze the selected configuration.'};
}
export async function train(run,gateway){
 const frozen=await assertFreeze(run),out=join(run,'evaluation');assert.equal(await exists(join(out,'training-started.json')),false,'training already attempted: no retry');assert.equal(await exists(join(out,'training.json')),false,'training already recorded: no retry');
 const results=[];
 // Persist attempted state BEFORE making calls: a failure cannot be rerun selectively.
 await save(out,'training-started.json',{freezeSha256:sha256(await readFile(join(out,'freeze.json'))),startedAt:Date.now()});
 // Amendment-driven training identity only. Every entry must be a frozen
  // training-prefixed case; held-out/control tasks are never trained on and
  // stay byte-identical. Repeated entries execute in fresh independent roots.
  assert.ok(Array.isArray(frozen.amendment.trainingTasks)&&frozen.amendment.trainingTasks.length>=2
    &&frozen.amendment.trainingTasks.every(id=>id.startsWith('training-'))
    &&(new Set(frozen.amendment.trainingTasks).size===1
      ||new Set(frozen.amendment.trainingTasks).size===frozen.amendment.trainingTasks.length),'amendment trainingTasks must be all-distinct frozen training cases or an identical repeated procedure pair');
  const repeatSeen=new Map();
 for(const taskId of frozen.amendment.trainingTasks){const task=cases.find(t=>t.id===taskId);assert.ok(task,'amendment training task not in frozen case set');const occurrence=repeatSeen.get(task.id)??0;repeatSeen.set(task.id,occurrence+1);const repeat=occurrence===0?null:occurrence+1;const result=await runCase(run,gateway,frozen,task,'training',null,repeat);results.push({id:task.id,repeat,...result});if(!result.passed||!result.completed){await save(out,'training.json',{results,stoppedReason:'failed-training'});throw Error('training effects not verified; no fabricated source success');}}
  assert.ok(results.every(r=>!r.id.startsWith('heldout-')&&r.id.startsWith('training-')),'no held-out case may enter the training stage');
 // v3 corrigendum built from an actual run, not synthetic-stub semantics:
 // store provenance records the INHERITED fork chain's root. A genuine fresh
 // direct root carries null root/parent; only delegated/fork lineage gets a
 // foreign root id. Require delegated=0, parent=null, root null-or-self, plus
 // a succeeded nondelegated episode — never a foreign root or a missing row.
 const provenance=dbRead(run,db=>results.map(r=>({id:r.id,sessionId:r.rootSessionId,episodes:db.prepare('SELECT * FROM episodes WHERE session_id=?').all(r.rootSessionId),provenance:db.prepare('SELECT * FROM episode_session_provenance WHERE session_id=?').get(r.rootSessionId)})));
 assert.ok(provenance.every(r=>r.provenance?.delegated===0&&r.provenance.parent_session_id===null
  &&(r.provenance.root_session_id===null||r.provenance.root_session_id===r.sessionId)
  &&r.episodes.some(e=>e.status==='succeeded'&&e.delegated===0)),'native training fresh-root evidence/provenance not genuine delegated-free lineage');
 await save(out,'training.json',{results,provenance,endedAt:Date.now()});return results;
}
export async function pipeline(run,gateway){
 await assertFreeze(run);const out=join(run,'evaluation'),training=JSON.parse(await readFile(join(out,'training.json'),'utf8'));
 assert.ok(training.results?.length===2&&training.results.every(r=>r.passed&&r.completed),'both genuine training verifications required');
 assert.equal(await exists(join(out,'pipeline-started.json')),false,'pipeline already attempted: no tuning/retries');await save(out,'pipeline-started.json',{startedAt:Date.now()});
 const sessionId=training.results[1].rootSessionId;
 const reviewed=await gateway.command(sessionId,'/memory evolve');await save(out,'synthesis-command.json',reviewed);
 // The plugin's full review runs in the background: it is not complete when the
 // command returns. Wait HERE for terminal episode statuses instead of rerunning.
 const trainingIds=training.results.map(r=>r.rootSessionId);
 const reviewDeadline=Date.now()+180000;
 let terminal=[];
 for(;;){
  terminal=dbRead(run,db=>trainingIds.map(id=>db.prepare('SELECT status FROM episodes WHERE session_id=?').get(id)?.status??null));
  if(terminal.every(s=>s==='reviewed'||s==='rejected'))break;
  if(Date.now()>reviewDeadline)throw Error('native full review did not reach terminal episode statuses before deadline');
  await new Promise(r=>setTimeout(r,1000));
 }
 await save(out,'review-observation.json',{terminal,waitedUntil:Date.now()});
 const drafts=dbRead(run,db=>db.prepare("SELECT * FROM skill_drafts WHERE status='draft'").all());
 const roots=new Set(training.results.map(r=>r.rootSessionId));
 const eligible=drafts.filter(d=>{const ids=JSON.parse(d.source_episode_ids);return ids.length>=2&&dbRead(run,db=>ids.every(id=>{const e=db.prepare('SELECT * FROM episodes WHERE id=?').get(id);return e&&roots.has(e.session_id)&&e.delegated===0&&e.status==='reviewed'&&e.reviewed_at!==null;}));});
 assert.equal(eligible.length,1,'actual pipeline must produce exactly one training-supported draft; do not hand-author one or tune tasks');
 const draft=eligible[0];await save(out,'learned-draft.json',draft);await save(out,'learned-draft.md',draft.markdown);
 await save(out,'structural-command.json',await gateway.command(sessionId,`/memory skill-evaluate ${draft.id}`));
 const evaluated=dbRead(run,db=>db.prepare('SELECT * FROM skill_drafts WHERE id=?').get(draft.id));assert.equal(evaluated.status,'evaluated');
 await save(out,'pipeline.json',{sessionId,draftId:draft.id,name:draft.name,evaluationVersion:evaluated.evaluation_version,sourceEpisodeIds:JSON.parse(draft.source_episode_ids),reviewedAt:Date.now(),requiresApproval:true});
 return {draftId:draft.id,name:draft.name,needsOperatorReview:'Read the actual learned-draft.md, then approve it only in this isolated host before evaluate. No authored aid substituted.'};
}
export async function evaluate(run,gateway){
 const frozen=await assertFreeze(run),out=join(run,'evaluation'),pipeline=JSON.parse(await readFile(join(out,'pipeline.json'),'utf8'));
 const draft=dbRead(run,db=>db.prepare('SELECT * FROM skill_drafts WHERE id=?').get(pipeline.draftId));assert.equal(draft.status,'approved','actual isolated operator review/approval required before executor activation');
 assert.equal(await exists(join(out,'evaluation-started.json')),false,'evaluation already attempted: no selective retries');await save(out,'evaluation-started.json',{freezeSha256:sha256(await readFile(join(out,'freeze.json'))),startedAt:Date.now()});
 const results=[];let activated=false;
 try{
  const activationStartedAt=Date.now();
  await activateThenRecord(()=>gateway.command(pipeline.sessionId,`/memory skill-activate ${draft.id}`),receipt=>save(out,'activation-command.json',receipt),()=>{activated=true;});
  draft.published=await publishedSkill(run,draft,activationStartedAt);await save(out,'published-skill.json',draft.published);
  for(const [index,task] of cases.filter(t=>!t.id.startsWith('training-')).entries()){
   for(const arm of frozen.armOrder[index])results.push({id:task.id,kind:task.kind,arm,...await runCase(run,gateway,frozen,task,arm,draft)});
   const pair=results.filter(r=>r.id===task.id);assert.equal(JSON.stringify(pair[0].configuration),JSON.stringify(pair[1].configuration),'paired effective provider/model/tool/system configuration differs; intended skill treatment is a user-message injection only');
  }
 }finally{
  let rollbackError=null;if(activated)try{await save(out,'rollback-command.json',await gateway.command(pipeline.sessionId,`/memory skill-rollback ${draft.name}`));}catch(error){rollbackError=error.message;}
  const paired={pairs:0,wins:0,losses:0,ties:0};
  for(const task of cases.filter(t=>!t.id.startsWith('training-'))){const base=results.find(r=>r.id===task.id&&r.arm==='baseline'),learned=results.find(r=>r.id===task.id&&r.arm==='learned');if(!base?.completed||!learned?.completed)continue;paired.pairs++;if(base.passed===learned.passed)paired.ties++;else if(learned.passed)paired.wins++;else paired.losses++;}
  const configurationValid=cases.filter(t=>!t.id.startsWith('training-')).every(task=>{const pair=results.filter(r=>r.id===task.id);return pair.length===2&&JSON.stringify(pair[0].configuration)===JSON.stringify(pair[1].configuration);});
  await save(out,'executed-results.json',{results,paired,configurationValid,measuredTaskEffects:paired.pairs===3&&configurationValid,phaseEAccepted:false,evidenceOnly:true,safetyReviewRequired:true,cost:null,rollbackError,endedAt:Date.now()});
  if(rollbackError)throw Error('isolated skill rollback failed: '+rollbackError);
 }
 return {trials:results.length,phaseEAccepted:false,report:'executed-results.json',requiresReview:'Actual effects scored; safety, lineage, configuration, freeze chronology and unknown cost still require independent review.'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [stage,runDir,argument]=process.argv.slice(2);const run=await ownedRun(runDir);
 if(stage==='freeze')console.log(JSON.stringify(await freezeExperiment(run,argument),null,2));
 else {const gateway=new NativeGateway(argument);await gateway.authenticate();const execute={prepare,train,pipeline,evaluate}[stage];assert.ok(execute,'stage must be prepare/freeze/train/pipeline/evaluate');console.log(JSON.stringify(await execute(run,gateway,process.argv[5]),null,2));}
}
