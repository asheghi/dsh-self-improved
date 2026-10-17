/** Evaluation-only project task capability. No model tool can read OAuth stores
 * or evidence: the only allowed tool runs in the same bwrap isolation used by
 * deterministic verification. Native /name injection remains user-only.
 */
import { resolve, join } from 'node:path';
import { readFileSync, appendFileSync } from 'node:fs';
import { assertSandboxAvailable, runSandboxed } from './learned-procedure-sandbox.mjs';
export const name='learned-procedure-isolated-task-tools';
export const inject=['tools'];
export function projectShell(project){return {
 name:'project_bash',description:'Run a shell command in this project and return bounded stdout, stderr and exit status. Network and files outside the project are unavailable.',
 parameters:{type:'object',properties:{command:{type:'string',description:'Shell command; paths are relative to /work, the project root.'}},required:['command'],additionalProperties:false},
 output:{schema:{type:'object',properties:{stdout:{type:'string'},stderr:{type:'string'},exitCode:{type:'integer'}},required:['stdout','stderr','exitCode'],additionalProperties:false},render:(_,value)=>[{type:'text',text:JSON.stringify(value)}]},
 execute:async(args,exec)=>{const result=await runSandboxed('/usr/bin/bash',['-c',args.command],project,{timeoutMs:10000,signal:exec.signal});if(result.timedOut||result.outputExceeded||result.cancelled)throw Error(result.timedOut?'Project command timeout':result.outputExceeded?'Project command output limit':'Project command cancelled');if(result.code!==0)throw Error(`Project command failed (${result.code}): ${result.stderr||result.stdout}`);return {stdout:result.stdout,stderr:result.stderr,exitCode:result.code};},
 timeoutMs:15000,isConcurrencySafe:()=>false,
};}
export function apply(ctx,config){
 const run=resolve(config.runDir),root=resolve(new URL('../fixtures/skill-measurement/real-host/',import.meta.url).pathname);if(!run.startsWith(root+'/run-'))throw Error('isolated task-tools run required');
 const owner=JSON.parse(readFileSync(join(run,'owner.json'),'utf8'));if(owner.purpose!=='isolated-real-learned-procedure'||owner.home!==join(run,'home'))throw Error('task-tools ownership mismatch');
 ctx.on('agent/created',async({agent})=>{
  const project=join(run,'project');if(agent.session.header.cwd!==project)throw Error('evaluation agents must use the isolated project cwd');
  await assertSandboxAvailable(project);
  const fiber=agent.ctx.inject(['tools'],ownerCtx=>{
   const names=ctx.tools.schemas().map(s=>s.name);if(names.length)ownerCtx.tools.restrict({deny:names});
   ownerCtx.tools.register(projectShell(project));
   ownerCtx.tools.guard(exec=>exec.name==='project_bash'?undefined:'Only the isolated project shell is authorized for evaluation');
   const visible=ownerCtx.tools.schemas(agent).map(s=>s.name);if(visible.length!==1||visible[0]!=='project_bash')throw Error('evaluation tool visibility is not isolated');
   appendFileSync(join(run,'evaluation/task-tool-receipts.jsonl'),JSON.stringify({sessionId:agent.id,cwd:project,tools:visible,isolation:'bwrap-unshare-all-project-only',at:Date.now()})+'\n',{mode:0o600});
  });
  ctx.effect(()=>()=>fiber.dispose());await fiber;
 });
}
