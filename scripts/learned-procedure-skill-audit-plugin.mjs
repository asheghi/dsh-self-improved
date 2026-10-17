/** Read-only capture of actual published skill and canonical native rendering. */
import { appendFileSync,readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export const name='learned-procedure-skill-audit';
export const inject=['skills'];
export function apply(ctx,config){
 const run=resolve(config.runDir),root=resolve(new URL('../fixtures/skill-measurement/real-host/',import.meta.url).pathname);
 if(!run.startsWith(root+'/run-'))throw Error('skill audit requires isolated run');
 const owner=JSON.parse(readFileSync(join(run,'owner.json'),'utf8'));if(owner.stub!==false)throw Error('real isolated run required');
 let pending=Promise.resolve();
 const capture=()=>{pending=pending.then(async()=>{
  const {renderSkillContent}=await import(pathToFileURL(join(config.runtime,'node_modules/@deepseek-ai/dsh-skill/lib/index.js')));
  const roster=await ctx.skills.list();
  for(const summary of roster){const skill=await ctx.skills.get(summary.name);if(skill)appendFileSync(join(run,'evaluation/published-skills.jsonl'),JSON.stringify({at:Date.now(),skill,rendered:renderSkillContent(skill)})+'\n',{mode:0o600});}
 }).catch(error=>{appendFileSync(join(run,'evaluation/published-skills.jsonl'),JSON.stringify({error:error.message,at:Date.now()})+'\n',{mode:0o600});});};
 ctx.on('skills/change',capture);capture();
}
