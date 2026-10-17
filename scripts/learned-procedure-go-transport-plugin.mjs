/** Isolated evaluation-only Go request-header coverage. No model messages,
 * sessionId fields or provider payloads are rewritten. Native session identity
 * is opaque and stable; detached auxiliary calls stay identity-free in DSH.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFileSync,appendFileSync } from 'node:fs';
import { resolve,join } from 'node:path';
export const name='learned-procedure-go-transport';
const digest=x=>createHash('sha256').update(x).digest('hex');
export function conversationKey(run,options){
 const identity=options.sessionId?'native:'+options.sessionId:'aux:'+JSON.stringify({provider:options.provider,model:options.model,system:options.system??null,messages:options.messages});
 return 'phase-e-'+digest(run+'\0'+identity);
}
export function goTransport({baseURL,userAgent,run,record=()=>{},fetchImpl=globalThis.fetch}){
 const endpoint=new URL(baseURL);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('configured HTTPS provider endpoint required');
 if(!userAgent.startsWith('deepseek-harness/'))throw Error('native coding-agent User-Agent required');
 const context=new AsyncLocalStorage(),prefix=endpoint.pathname.replace(/\/$/,'')+'/';
 async function wrappedFetch(input,init){
  const url=new URL(input instanceof Request?input.url:input);
  if(url.origin!==endpoint.origin||!url.pathname.startsWith(prefix))return fetchImpl(input,init);
  const session=context.getStore();if(!session)throw Error('Go provider request outside bounded evaluation stream refused');
  const original=new Request(input,init),headers=new Headers(original.headers);
  headers.set('user-agent',userAgent);headers.set('x-opencode-session',session);
  const request=new Request(original,{headers});
  record({kind:'go-header-coverage',conversationHash:digest(session),userAgent,method:request.method,path:url.pathname,hasSession:true,at:Date.now()});
  return fetchImpl(request);
 }
 async function* stream(options,next){
  const identity=conversationKey(run,options);
  const iterator=context.run(identity,()=>next()[Symbol.asyncIterator]());
  try{while(true){const item=await context.run(identity,()=>iterator.next());if(item.done)return;yield item.value;}}
  finally{if(iterator.return)await context.run(identity,()=>iterator.return());}
 }
 return {fetch:wrappedFetch,stream};
}
export function apply(ctx,config){
 const run=resolve(config.runDir),root=resolve(new URL('../fixtures/skill-measurement/real-host/',import.meta.url).pathname);
 if(!run.startsWith(root+'/run-'))throw Error('Go transport requires isolated evaluation run');
 const owner=JSON.parse(readFileSync(join(run,'owner.json'),'utf8'));if(owner.provider!==config.provider||owner.stub!==false)throw Error('Go transport ownership mismatch');
 const previous=globalThis.fetch;
 const transport=goTransport({baseURL:config.baseURL,userAgent:config.userAgent,run,fetchImpl:previous,record:r=>appendFileSync(join(run,'evaluation/go-header-receipts.jsonl'),JSON.stringify(r)+'\n',{mode:0o600})});
 globalThis.fetch=transport.fetch;
 ctx.effect(()=>()=>{if(globalThis.fetch===transport.fetch)globalThis.fetch=previous;});
 ctx.on('llm/stream',function(options,next){if(options.provider!==config.provider)throw Error('unfrozen provider route refused');return transport.stream(options,next);},{global:true});
}
