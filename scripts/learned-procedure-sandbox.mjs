/** Fail-closed OS isolation for model-written code and evaluation task tools.
 * Only distro runtime and one owned project are mounted; no credentials,
 * evidence, user home, host root, or network. No unsandboxed fallback.
 */
import { spawn } from 'node:child_process';
import { realpath,readFile } from 'node:fs/promises';
import { resolve,dirname,join } from 'node:path';
import { tree } from './learned-procedure-cases.mjs';
export const NPM_PACKAGE=resolve(process.env.DSI_EVALUATION_NPM_PACKAGE??join(dirname(process.execPath),'../lib/node_modules/npm'));
// Hash the real npm distribution (including dependencies), not invented npm
// semantics or an executable shim. Detached path/hash data is freeze evidence.
export async function npmFingerprint(){
 const root=await realpath(NPM_PACKAGE);if(root!==NPM_PACKAGE)throw Error('genuine canonical npm package directory required');
 const manifest=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
 if(manifest.name!=='npm'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version??'')||manifest.bin?.npm!=='bin/npm-cli.js')throw Error('genuine npm package shape/version required');
 const files=await tree(root); // rejects symlinks and non-regular artifacts
 for(const path of ['package.json','bin/npm-cli.js','lib/cli.js'])if(!Object.hasOwn(files,path))throw Error('npm distribution is incomplete: '+path);
 return {root,files:{...files}};
}
export const OUTPUT_LIMIT = 64 * 1024;
export function sandboxArguments(project,command,args){
 return ['--die-with-parent','--new-session','--unshare-all','--cap-drop','ALL',
  '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib','/lib64',
  '--ro-bind',NPM_PACKAGE,'/opt/npm','--dir','/tools','--symlink','/opt/npm/bin/npm-cli.js','/tools/npm',
  '--dev','/dev','--proc','/proc','--tmpfs','/tmp','--bind',project,'/work','--chdir','/work',
  '--clearenv','--setenv','PATH','/tools:/usr/bin:/bin','--setenv','HOME','/tmp','--setenv','TMPDIR','/tmp',
  command,...args];
}
export async function runSandboxed(command,args,project,{timeoutMs=10000,outputLimit=OUTPUT_LIMIT,signal}={}){
 const root=await realpath(project);if(root!==resolve(project))throw Error('sandbox project path must not be a symlink');
 if(signal?.aborted)throw signal.reason??Error('cancelled');
 return new Promise((resolvePromise,reject)=>{
  const child=spawn('/usr/bin/bwrap',sandboxArguments(root,command,args),{cwd:root,env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe']});
  let stdout=[],stderr=[],bytes=0,timedOut=false,outputExceeded=false,cancelled=false;
  const kill=()=>child.kill('SIGKILL');
  const take=(target,chunk)=>{bytes+=chunk.length;if(bytes>outputLimit){outputExceeded=true;kill();return;}target.push(chunk);};
  child.stdout.on('data',d=>take(stdout,d));child.stderr.on('data',d=>take(stderr,d));
  const timer=setTimeout(()=>{timedOut=true;kill();},timeoutMs);
  const abort=()=>{cancelled=true;kill();};signal?.addEventListener('abort',abort,{once:true});
  child.once('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error);});
  child.once('close',(code,endSignal)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolvePromise({code,signal:endSignal,stdout:Buffer.concat(stdout).toString(),stderr:Buffer.concat(stderr).toString(),timedOut,outputExceeded,cancelled});});
 });
}
export async function assertSandboxAvailable(project){
 await npmFingerprint();
 const npm=await runSandboxed('/usr/bin/bash',['-c','node --version && npm --version && test ! -e /home/bahman && test ! -e /root'],project);
 if(npm.code!==0||npm.timedOut||npm.outputExceeded)throw Error('required sandbox node/npm unavailable: '+npm.stderr.trim());
 const result=await runSandboxed('/usr/bin/node',['-e',"require('fs').writeFileSync('/work/.sandbox-probe','owned');require('fs').unlinkSync('/work/.sandbox-probe');console.log('ISOLATED')"],project);
 if(result.code!==0||result.stdout.trim()!=='ISOLATED')throw Error('required bwrap isolation unavailable: '+result.stderr.trim());return true;
}
