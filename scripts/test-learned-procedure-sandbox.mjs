#!/usr/bin/env node
// Focused OS-sandbox tests. Canary values are synthetic, never real credentials.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { runSandboxed, assertSandboxAvailable, OUTPUT_LIMIT, npmFingerprint, NPM_PACKAGE } from './learned-procedure-sandbox.mjs';
const base=resolve('fixtures/skill-measurement/real-host');await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,'run-sandbox-')),project=join(root,'project');await mkdir(project);let server,passed=0;
try{
 await assertSandboxAvailable(project);passed++;
 const fingerprint=await npmFingerprint();assert.equal(fingerprint.root,await realpath(NPM_PACKAGE));
 const npmManifest=JSON.parse(await readFile(join(NPM_PACKAGE,'package.json'),'utf8'));assert.equal(npmManifest.name,'npm');assert.ok(Object.keys(fingerprint.files).length>100);
 assert.match(fingerprint.files['bin/npm-cli.js'],/^[a-f0-9]{64}$/);const originalHash=fingerprint.files['package.json'];fingerprint.files['package.json']='mutated detached result';assert.equal((await npmFingerprint()).files['package.json'],originalHash);passed++;
 await mkdir(join(project,'scripts'));await mkdir(join(project,'src'));
 await writeFile(join(project,'package.json'),JSON.stringify({name:'isolated-npm-build-fixture',version:'1.0.0',type:'module',scripts:{build:'node scripts/build.mjs'}}));
 await writeFile(join(project,'src/api.mjs'),'export const value="real-npm-build";\n');
 await writeFile(join(project,'scripts/build.mjs'),"import {mkdirSync,copyFileSync} from 'node:fs';mkdirSync('dist',{recursive:true});copyFileSync('src/api.mjs','dist/index.mjs');\n");
 const npmBuild=await runSandboxed('/usr/bin/bash',['-c',`npm --version && npm run build && node --input-type=module -e 'import {value} from "./dist/index.mjs";if(value!=="real-npm-build")process.exit(1)'`],project);
 assert.equal(npmBuild.code,0,npmBuild.stderr);assert.equal(npmBuild.stdout.split('\n')[0],npmManifest.version);assert.equal(await readFile(join(project,'dist/index.mjs'),'utf8'),'export const value="real-npm-build";\n');passed++;
 const readOnly=await runSandboxed('/usr/bin/node',['-e',"const fs=require('fs');try{fs.writeFileSync('/opt/npm/.sandbox-write-canary','bad');process.exit(31);}catch(error){if(error.code!=='EROFS'&&error.code!=='EACCES')throw error;}console.log('NPM_READ_ONLY');"],project);
 assert.equal(readOnly.code,0,readOnly.stderr);assert.equal(readOnly.stdout.trim(),'NPM_READ_ONLY');assert.equal(await access(join(NPM_PACKAGE,'.sandbox-write-canary')).then(()=>true,()=>false),false);passed++;
 const priorSecret=process.env.SYNTHETIC_SANDBOX_SECRET;process.env.SYNTHETIC_SANDBOX_SECRET='not-a-real-credential';
 try{const home=await runSandboxed('/usr/bin/node',['-e',`const fs=require('fs');for(const path of ['/home','/root',${JSON.stringify(process.env.HOME??'/home/bahman')}])if(fs.existsSync(path))process.exit(32);if(process.env.HOME!=='/tmp'||process.env.SYNTHETIC_SANDBOX_SECRET)process.exit(33);if(fs.existsSync('/tmp/.npmrc'))process.exit(34);console.log('HOME_AND_ENV_ISOLATED');`],project);assert.equal(home.code,0,home.stderr);assert.equal(home.stdout.trim(),'HOME_AND_ENV_ISOLATED');}finally{if(priorSecret===undefined)delete process.env.SYNTHETIC_SANDBOX_SECRET;else process.env.SYNTHETIC_SANDBOX_SECRET=priorSecret;}passed++;
 const canary=join(root,'credential-canary.txt'),evidence=join(root,'evidence-canary.txt');await writeFile(canary,'synthetic-private-canary');await writeFile(evidence,'unchanged');
 const attacks=`const fs=require('fs');for(const path of ${JSON.stringify([canary,evidence,'/etc/passwd','/home'])}){try{fs.readFileSync(path);process.exit(21);}catch{}}try{fs.writeFileSync(${JSON.stringify(evidence)},'tampered');process.exit(22);}catch{}console.log('DENIED');`;
 const result=await runSandboxed('/usr/bin/node',['-e',attacks],project);assert.equal(result.code,0,result.stderr);assert.equal(result.stdout.trim(),'DENIED');assert.equal(await readFile(evidence,'utf8'),'unchanged');passed++;
 let requests=0;server=createServer((req,res)=>{requests++;res.end('host-network-canary');});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}`;
 const network=await runSandboxed('/usr/bin/node',['-e',`fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(300)}).then(()=>process.exit(23),()=>console.log('NO_NETWORK'));`],project);assert.equal(network.code,0,network.stderr);assert.equal(network.stdout.trim(),'NO_NETWORK');assert.equal(requests,0);passed++;
 const bomb=await runSandboxed('/usr/bin/node',['-e',"setInterval(()=>process.stdout.write('x'.repeat(65536)),1)"],project,{timeoutMs:3000});assert.equal(bomb.outputExceeded,true);assert.ok(Buffer.byteLength(bomb.stdout)+Buffer.byteLength(bomb.stderr)<=OUTPUT_LIMIT);passed++;
 const timeout=await runSandboxed('/usr/bin/node',['-e',`require('child_process').spawn('/usr/bin/node',['-e',"setTimeout(()=>require('fs').writeFileSync('/work/grandchild-leak','bad'),700)"],{detached:true,stdio:'ignore'});setInterval(()=>{},1000);`],project,{timeoutMs:150});assert.equal(timeout.timedOut,true);await new Promise(r=>setTimeout(r,1000));assert.equal(await access(join(project,'grandchild-leak')).then(()=>true,()=>false),false);passed++;
 const cancelled=new AbortController();cancelled.abort();await assert.rejects(runSandboxed('/usr/bin/node',['-e','0'],project,{signal:cancelled.signal}));passed++;
 console.log(`${passed} real bwrap isolation/output/timeout checks PASS (no provider or real credentials)`);
}finally{if(server)await new Promise(r=>server.close(r));assert.equal(await realpath(root),root);assert.ok(root.startsWith(base+'/run-sandbox-'));await rm(root,{recursive:true,force:true});}
