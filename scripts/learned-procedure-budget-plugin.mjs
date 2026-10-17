/** Isolated evaluation-only provider seam observer with call/token admission caps.
 * Token bounds rely on declared model ceilings, with actual-usage reconciliation.
 * Never mount this in a production profile. No credentials or message bodies
 * are recorded, only configuration/skill body hashes and measured usage.
 */
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
export const name = 'learned-procedure-evaluation-budget';
export const inject = ['llm'];
export const MAX_CALLS = 80;
export const MAX_SESSION_CALLS = 8;
export const MAX_TOTAL_TOKENS = 8000000;
export const NATIVE_OUTPUT_TOKENS = 8192;
export async function boundedNativeRequest(_payload,next){return {...await next(),maxTokens:NATIVE_OUTPUT_TOKENS};}
// No tokenizer is exposed at this seam. Reserve the entire declared model
// input context plus explicit output ceiling; do not mutate frozen LOOP calls.
export function createTokenBudget(records=[]) {
 let spent=0,active=null,blocked=null;
 const valid=n=>Number.isSafeInteger(n)&&n>=0;
 function settle(usage,reservation){
  if(!usage||!valid(usage.inputTokens)||!valid(usage.outputTokens)||(usage.totalTokens!==undefined&&!valid(usage.totalTokens))){blocked='missing or invalid provider token usage';throw Error(blocked);}
  const measured=Math.max(usage.inputTokens+usage.outputTokens,valid(usage.totalTokens)?usage.totalTokens:0);
  spent+=measured;
  if(!Number.isSafeInteger(spent)||measured>reservation||spent>MAX_TOTAL_TOKENS){blocked='provider token ceiling exceeded';throw Error(blocked);}
 }
 const starts=new Map();
 for(const r of records){if(r.kind==='call-start'){if(starts.has(r.call))throw Error('duplicate token reservation');starts.set(r.call,r);}else if(r.kind==='call-end'){const start=starts.get(r.call);if(!start)throw Error('unmatched token completion');starts.delete(r.call);try{if(!valid(start.tokenReservation)||start.tokenReservation===0)throw Error('legacy token reservation unavailable');settle(r.usage,start.tokenReservation);}catch(e){blocked=e.message;}}}
 if(starts.size)blocked='unfinished provider call has unknown token usage';
 return {
  reserve(contextWindow,maxTokens){
   if(blocked)throw Error('evaluation token budget blocked: '+blocked);
   if(active!==null)throw Error('concurrent evaluation provider call refused');
   if(!valid(contextWindow)||contextWindow===0||!valid(maxTokens)||maxTokens===0)throw Error('explicit model context and output token ceilings required');
   const reservation=contextWindow+maxTokens;
   if(!Number.isSafeInteger(reservation)||spent+reservation>MAX_TOTAL_TOKENS)throw Error('evaluation token reservation exceeds remaining budget');
   active=reservation;return reservation;
  },
  cancelBeforeDispatch(){active=null;},
  finish(usage){if(active===null)throw Error('no active token reservation');const reserved=active;active=null;settle(usage,reserved);},
  get spent(){return spent;}
 };
}
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const loadedSourceSha256=createHash('sha256').update(readFileSync(new URL(import.meta.url))).digest('hex');
export function createBudget(previous=[]) {
 let total=0; const sessions=new Map();
 for(const call of previous){assertRecord(call);total++;if(call.sessionId)sessions.set(call.sessionId,(sessions.get(call.sessionId)??0)+1);}
 function assertRecord(call){if(call?.kind!=='call-start'||call.call!==total+1)throw Error('invalid persisted evaluation call chronology');}
 return { admit(sessionId) {
  if(total>=MAX_CALLS)throw Error(`evaluation provider-call budget exhausted (${MAX_CALLS})`);
  const n=sessions.get(sessionId)??0;
  if(sessionId&&n>=MAX_SESSION_CALLS)throw Error(`evaluation session-call budget exhausted (${MAX_SESSION_CALLS})`);
  total++; if(sessionId)sessions.set(sessionId,n+1); return total;
 }, get total(){return total;} };
}
export function apply(ctx, config) {
 const run=resolve(config.runDir);
 const allowed=resolve(new URL('../fixtures/skill-measurement/real-host/',import.meta.url).pathname);
 if(!run.startsWith(allowed+'/run-'))throw Error('evaluation observer requires owned isolated run');
 const owner=JSON.parse(readFileSync(join(run,'owner.json'),'utf8'));
 if(owner.purpose!=='isolated-real-learned-procedure'||owner.stub!==false)throw Error('evaluation run ownership mismatch');
 const out=join(run,'evaluation');mkdirSync(out,{recursive:true});
 const log=join(out,'provider.jsonl');let previous=[];
 try{previous=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
 const budget=createBudget(previous.filter(r=>r.kind==='call-start'));
 const tokens=createTokenBudget(previous);
 const record=value=>appendFileSync(log,JSON.stringify(value)+'\n',{mode:0o600});
 record({kind:'budget-mounted',sourceSha256:loadedSourceSha256,maxCalls:MAX_CALLS,maxSessionCalls:MAX_SESSION_CALLS,maxTotalTokens:MAX_TOTAL_TOKENS,nativeOutputTokens:NATIVE_OUTPUT_TOKENS,tokenReservation:'declared contextWindow plus explicit maxTokens; unknown usage blocks',at:Date.now()});
 // Supported pre-admission replacement: logged in native header before the
 // immutable model request is constructed. No message or frozen input mutation.
 ctx.on('agent/request',boundedNativeRequest,{global:true});
 ctx.on('llm/stream', async function* (options,next) {
  const model=await this.resolveModelInfo(options.provider,options.model,options.signal);
   const tokenReservation=tokens.reserve(model.context?.contextWindow,options.maxTokens);
   let call;try{call=budget.admit(options.sessionId);}catch(error){tokens.cancelBeforeDispatch();throw error;}
   const startedAt=Date.now();
  const skillInvocations=options.messages.filter(m=>m.source?.kind==='skill-invocation').map(m=>({name:m.source.name,contentSha256:hash(m.content)}));
  const configuration={provider:options.provider,model:options.model,sampling:JSON.stringify({temperature:options.temperature??null,reasoningEffort:options.reasoningEffort??null,maxTokens:options.maxTokens??null}),toolPolicySha256:hash(options.tools??[]),systemContextSha256:hash({system:options.system??null,messages:options.messages.filter(m=>m.role==='system'||m.role==='developer').map(m=>({role:m.role,content:m.content}))})};
  record({kind:'call-start',call,sessionId:options.sessionId??null,purpose:options.purpose??null,startedAt,configuration,skillInvocations,tokenReservation});
  let usage=null,finish=null;
  try { for await(const chunk of next()){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason.kind;yield chunk;} }
  finally {record({kind:'call-end',call,endedAt:Date.now(),elapsedMs:Date.now()-startedAt,usage,finish,cost:null});tokens.finish(usage);}
 });
}
