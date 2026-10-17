#!/usr/bin/env node
/** Inspect only the isolated host's supported sign-in UI; never initiate login. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const url = new URL(process.argv[2]);
if (url.hostname !== '127.0.0.1' || url.port === '3082') throw Error('isolated localhost host required');
const base = resolve('.');
const owned = await mkdtemp(join(base, '.pe-'));
await mkdir(join(owned, 'tmp'));
const chrome = spawn('/usr/bin/chromium', ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--user-data-dir='+join(owned,'profile'), '--remote-debugging-port=0', 'about:blank'], { env: { PATH: process.env.PATH, HOME: owned, XDG_CONFIG_HOME: join(owned,'config'), XDG_CACHE_HOME: join(owned,'cache'), TMPDIR: join(owned,'tmp') }, stdio: ['ignore','pipe','pipe'] });
let ws;
try {
 const address = await new Promise((res,rej)=>{ let output=''; const timer=setTimeout(()=>rej(Error('Chromium startup timed out')),20000); chrome.stderr.on('data',d=>{ output+=d; const m=output.match(/DevTools listening on (ws:\/\/\S+)/); if(m){clearTimeout(timer);res(m[1]);} }); chrome.once('error',rej); });
 ws = new WebSocket(address); await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});
 let seq=0; const pending=new Map(); ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}}};
 const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));setTimeout(()=>{if(pending.delete(id))reject(Error('CDP timeout '+method));},15000).unref();});
 const {targetId}=await send('Target.createTarget',{url:'about:blank'}); const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
 const c=(m,p={})=>send(m,p,sessionId); await c('Page.enable');await c('Runtime.enable');
 const evaluate=async expression=>(await c('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true})).result.value;
 async function wait(expression){for(let i=0;i<200;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,100));}throw Error('DOM wait failed '+expression);}
 await c('Page.navigate',{url:url.href}); await wait(`document.querySelector('button[aria-label="Settings"]')`);
 await evaluate(`[...document.querySelectorAll('button')].find(e=>e.innerText==='Continue')?.click()`);
 await evaluate(`document.querySelector('button[aria-label="Settings"]').click()`);
 await wait(`document.body.innerText.includes('Models')`);
 await evaluate(`[...document.querySelectorAll('button')].find(e=>e.innerText==='Models')?.click()`);
 await wait(`document.body.innerText.includes('Codex') || document.body.innerText.includes('Providers')`);
 console.log(JSON.stringify(await evaluate(`({text:document.body.innerText,buttons:[...document.querySelectorAll('button')].map(e=>({text:e.innerText,aria:e.getAttribute('aria-label')})),links:[...document.querySelectorAll('a')].map(e=>({text:e.innerText,href:e.href}))})`),null,2));
 await send('Target.closeTarget',{targetId});
} finally {ws?.close();chrome.kill('SIGTERM');await new Promise(r=>{chrome.once('exit',r);setTimeout(()=>{chrome.kill('SIGKILL');r();},3000).unref();});if(await realpath(owned)!==owned||!owned.startsWith(base+'/.pe-'))throw Error('cleanup guard');await rm(owned,{recursive:true,force:true});}
