/** Isolated evaluation-only OAuth CLI surface, using the installed provider's
 * actual Authorization flow. The provider owns PKCE/state/callback validation
 * and writes credentials directly into isolated DSH_HOME through its store.
 * No API-key method, credential reads, callback code capture, or manual-code
 * relay to the model is implemented here. The human completes provider login.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
export const name='learned-procedure-isolated-authorization';
export const inject=['authorization'];
export function safeNotice(notice){
 if(!notice.url)return {message:'Subscription sign-in progress'};
 const url=new URL(notice.url);
 if(url.protocol!=='https:'||url.hostname!=='auth.openai.com')throw Error('unexpected subscription authorization origin');
 // An authorization initiation URL has public state/PKCE parameters, not a
 // token or authorization code. Never emit a callback URL or token material.
 if(url.searchParams.has('code')||url.searchParams.has('access_token')||url.searchParams.has('refresh_token')||url.hash)throw Error('refusing credential-shaped callback notice');
 return {message:'Complete the isolated subscription sign-in in your browser. Do not paste codes or credentials into chat.',url:url.href};
}
export async function authorizeSubscription(authorization,signal,notify){
 const key='llm-pi-ai/openai-codex';
 const flow=authorization.describe(key);
 if(!flow?.methods.some(m=>m.id==='oauth'))throw Error('installed openai-codex OAuth flow unavailable');
 return authorization.begin({key,method:'oauth',signal,interaction:{
  notify:notice=>notify(safeNotice(notice)),
  prompt:prompt=>{
   // The installed Codex OAuth flow first asks which login transport to use.
   // Selecting its browser option chooses a transport, not an authorization.
   if(prompt.kind==='select'){
    if(prompt.options.some(option=>option.id==='browser'))return Promise.resolve('browser');
    return Promise.reject(Error('unexpected OAuth account/method selection'));
   }
   return new Promise((_,reject)=>{
   // Callback-only surface: text fallback is not harvested or sent to the AI.
   // The installed OAuth flow withdraws this losing prompt when callback wins.
   if(prompt.kind==='secret'){reject(Error('isolated OAuth surface refuses secret prompts'));return;}
   const stop=()=>reject(Error('OAuth prompt withdrawn'));
   if(signal.aborted||prompt.signal?.aborted){stop();return;}
   signal.addEventListener('abort',stop,{once:true});prompt.signal?.addEventListener('abort',stop,{once:true});
   notify({message:'Waiting for the provider browser callback. Manual code entry is not collected by this evaluation helper.'});
  });
  },
 }});
}
export function apply(ctx,config){
 const run=resolve(config.runDir),root=resolve(new URL('../fixtures/skill-measurement/real-host/',import.meta.url).pathname);
 if(!run.startsWith(root+'/run-'))throw Error('authorization requires isolated evaluation run');
 const owner=JSON.parse(readFileSync(join(run,'owner.json'),'utf8'));if(owner.purpose!=='isolated-real-learned-procedure'||owner.stub!==false||owner.home!==join(run,'home'))throw Error('isolated authorization ownership mismatch');
 const controller=new AbortController();ctx.effect(()=>()=>controller.abort());
 const timer=setTimeout(()=>controller.abort(),10*60*1000);timer.unref();
 const out=join(run,'evaluation');mkdirSync(out,{recursive:true});
 // Run after the pi-ai fiber has registered its supported flow. No request is
 // made and no record read while waiting for the registration to become live.
 const started=Date.now();const poll=setInterval(()=>{
  if(controller.signal.aborted||Date.now()-started>10000){clearInterval(poll);clearTimeout(timer);return;}
  if(!ctx.authorization.describe('llm-pi-ai/openai-codex'))return;
  clearInterval(poll);
  authorizeSubscription(ctx.authorization,controller.signal,notice=>console.log('[isolated-subscription-sign-in] '+JSON.stringify(notice)))
   .then(outcome=>{writeFileSync(join(out,'authorization-status.json'),JSON.stringify({credentialKey:'llm-pi-ai/openai-codex',status:outcome.status,at:Date.now()},null,2)+'\n',{mode:0o600});console.log('[isolated-subscription-sign-in] '+outcome.status);})
   .catch(error=>{writeFileSync(join(out,'authorization-status.json'),JSON.stringify({credentialKey:'llm-pi-ai/openai-codex',status:controller.signal.aborted?'cancelled':'error',reason:error.code??'AUTHORIZATION_FAILED',at:Date.now()},null,2)+'\n',{mode:0o600});console.error('[isolated-subscription-sign-in] '+(error.code??'AUTHORIZATION_FAILED'));})
   .finally(()=>clearTimeout(timer));
 },50);poll.unref();ctx.effect(()=>()=>{clearInterval(poll);clearTimeout(timer);controller.abort();});
}
