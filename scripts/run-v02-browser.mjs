#!/usr/bin/env node
/** One managed-job entrypoint for isolated real-browser acceptance.
 * No live GUI/profile writes. All runtime HOME/cache/temp/profile files are workspace-local.
 * Preserve owned fixture artifacts on failure; Chromium is always stopped.
 */
import {spawn} from 'node:child_process';
import {mkdirSync,writeFileSync,realpathSync,rmSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
const root=resolve(new URL('..',import.meta.url).pathname),temp=join(root,'fixtures/v02-ui/temp');
mkdirSync(temp,{recursive:true});
const owned=join(temp,'browser-'+Date.now()+'-'+randomUUID().slice(0,6));mkdirSync(owned);writeFileSync(join(owned,'.browser-owner'),'owned\n');
// Chromium's Unix socket must fit sockaddr_un; fixture temp paths are too long.
const shortTmp=join(root,'.bt-'+randomUUID().slice(0,6));mkdirSync(shortTmp);writeFileSync(join(shortTmp,'.browser-owner'),'owned\n');
const children=new Set();
function start(command,args,env){const p=spawn(command,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});children.add(p);p.on('exit',()=>children.delete(p));return p}
function ready(p,pattern){return new Promise((res,rej)=>{let output='';const timer=setTimeout(()=>rej(Error('Startup timeout: '+output)),45000);const consume=b=>{output+=b;const match=output.match(pattern);if(match){clearTimeout(timer);res(match)}};p.stdout.on('data',consume);p.stderr.on('data',consume);p.once('error',e=>{clearTimeout(timer);rej(e)});p.once('exit',code=>{clearTimeout(timer);rej(Error('Startup exited '+code+': '+output))})})}
function stop(){for(const p of children)p.kill('SIGTERM')}
process.on('SIGTERM',()=>{stop();process.exit(143)});process.on('SIGINT',()=>{stop();process.exit(130)});
let runDir,exit=1;
try{
const fixture=start(process.execPath,['scripts/test-v02-mounted-ui.mjs','up'],process.env);
runDir=(await ready(fixture,/"runDir":\s*"([^"]+)"/))[1];
const env={...process.env,HOME:owned,XDG_CACHE_HOME:join(owned,'cache'),XDG_CONFIG_HOME:join(owned,'config'),TMPDIR:shortTmp};
const chromium=start('/usr/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--user-data-dir='+join(owned,'profile'),'--remote-debugging-port=0','about:blank'],env);
const ws=(await ready(chromium,/DevTools listening on (ws:\/\/\S+)/))[1];
const battery=start(process.execPath,['scripts/test-v02-browser.mjs',join(runDir,'facts.json'),ws],process.env);
battery.stdout.pipe(process.stdout);battery.stderr.pipe(process.stderr);
exit=await new Promise((res,rej)=>{battery.once('exit',code=>res(code??1));battery.once('error',rej)});
}catch(e){console.error(e.stack);writeFileSync(join(root,'MIGRATION-BROWSER-ENVIRONMENT.json'),JSON.stringify({actualBrowser:false,failure:String(e.stack),runDir,owned},null,2)+'\n')}
finally{stop();await Promise.all([...children].map(p=>new Promise(r=>{p.once('exit',r);setTimeout(()=>{p.kill('SIGKILL');r()},5000).unref()})));const resolved=realpathSync(owned),guarded=realpathSync(temp);if(!resolved.startsWith(guarded+'/browser-')||resolved===guarded||!existsSync(join(resolved,'.browser-owner')))throw Error('Cleanup ownership guard failed');rmSync(resolved,{recursive:true,force:true});const shortResolved=realpathSync(shortTmp);if(!shortResolved.startsWith(realpathSync(root)+'/.bt-')||shortResolved!==shortTmp||!existsSync(join(shortResolved,'.browser-owner')))throw Error('Short temp cleanup guard failed');rmSync(shortResolved,{recursive:true,force:true});}
// Fixture data stays for reproducible evidence; down can remove it after this job stops.
console.log('Browser fixture retained: '+runDir);process.exitCode=exit||0;
