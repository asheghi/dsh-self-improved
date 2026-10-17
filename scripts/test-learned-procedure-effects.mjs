#!/usr/bin/env node
// Real bwrap + private synthetic project trees; no provider, credential or Host.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, writeCase, tree } from './learned-procedure-cases.mjs';
import { verifyCase } from './verify-learned-procedure-case.mjs';
import { assertSandboxAvailable } from './learned-procedure-sandbox.mjs';
const lane=fileURLToPath(new URL('../.tmp-import-lane/',import.meta.url));await mkdir(lane,{recursive:true});
const root=await mkdtemp(join(lane,'learned-effects-'));let serial=0,passes=0;
async function fixture(id){const task=cases.find(t=>t.id===id),project=join(root,'case-'+ ++serial);await writeCase(task,project);return {task,project};}
const goodSum='export const sumFinite = values => values.filter(value => typeof value === "number" && Number.isFinite(value)).reduce((a,b)=>a+b,0);\n';
const fsImport="import {writeFileSync} from 'node:fs';\n";
async function check(name,fn){await fn();passes++;console.log('PASS '+name);}
const probe=await fixture('unrelated-control');await assertSandboxAvailable(probe.project);
await check('genuine unrelated code repair passes without verifier file mutations',async()=>{
 const {project}=await fixture('unrelated-control');await writeFile(join(project,'src/sum.mjs'),goodSum);const before=await tree(project);
 const result=await verifyCase('unrelated-control',project);assert.equal(result.passed,true);assert.deepEqual(result.tree,before);
});
await check('candidate module import creating a new file is rejected',async()=>{
 const {project}=await fixture('unrelated-control');await writeFile(join(project,'src/sum.mjs'),fsImport+"writeFileSync('import-leak.txt','unexpected');\n"+goodSum);
 await assert.rejects(verifyCase('unrelated-control',project),/mutated project|unexpected post-verifier/);
});
await check('candidate function creating a new file is rejected',async()=>{
 const {project}=await fixture('unrelated-control');await writeFile(join(project,'src/sum.mjs'),fsImport+`export const sumFinite=values=>{writeFileSync('function-leak.txt','unexpected');return values.filter(value=>typeof value==='number'&&Number.isFinite(value)).reduce((a,b)=>a+b,0);};\n`);
 await assert.rejects(verifyCase('unrelated-control',project),/mutated project|unexpected post-verifier/);
});
for(const path of ['docs/keep.txt','package.json'])await check('candidate runtime mutation of forbidden '+path+' is rejected',async()=>{
 const {project}=await fixture('unrelated-control');const value=path==='package.json'?'{}':'modified forbidden document';
 await writeFile(join(project,'src/sum.mjs'),fsImport+`writeFileSync(${JSON.stringify(path)},${JSON.stringify(value)});\n`+goodSum);
 await assert.rejects(verifyCase('unrelated-control',project),/mutated project|changed unrelated/);
});
await check('pre-existing forbidden document edit is rejected before candidate execution',async()=>{
 const {project}=await fixture('unrelated-control');await writeFile(join(project,'src/sum.mjs'),goodSum);await writeFile(join(project,'docs/keep.txt'),'modified');
 await assert.rejects(verifyCase('unrelated-control',project),/unrelated file changed/);
});
await check('genuine package repair produces all frozen target effects under external verification',async()=>{
 const {project}=await fixture('heldout-gamma');await writeFile(join(project,'scripts/build.mjs'),`import {readFileSync,mkdirSync,copyFileSync} from 'node:fs';import {dirname} from 'node:path';const pkg=JSON.parse(readFileSync('package.json','utf8'));const flatten=v=>typeof v==='string'?[v]:v&&typeof v==='object'?Object.values(v).flatMap(flatten):[];for(const target of flatten(pkg.exports).filter(p=>p.startsWith('./dist/'))){mkdirSync(dirname(target),{recursive:true});copyFileSync(target.endsWith('.cjs')?'src/api.cjs':'src/api.mjs',target);}\n`);
 const result=await verifyCase('heldout-gamma',project);assert.equal(result.passed,true);assert.ok(Object.keys(result.tree).includes('dist/features/addon.cjs'));
});
await check('genuine current-rule check preserves ordinary branch only in disposable clone',async()=>{
 const {task,project}=await fixture('current-rule-control');await writeFile(join(project,'scripts/build.mjs'),`if(process.argv.includes('--check')){console.log('CHECK_ONLY');process.exit(0);}\n`+task.files['scripts/build.mjs']);
 const before=await tree(project),result=await verifyCase(task.id,project);assert.equal(result.passed,true);assert.deepEqual(await tree(project),before);
 assert.equal(await access(join(project,'dist')).then(()=>true,()=>false),false);
});
await check('original bytes hidden in comment cannot fake preserved executable branch',async()=>{
 const {task,project}=await fixture('current-rule-control');await writeFile(join(project,'scripts/build.mjs'),'/*\n'+task.files['scripts/build.mjs']+"*/\nconsole.log('CHECK_ONLY');\n");
 const before=await tree(project);await assert.rejects(verifyCase(task.id,project),/ordinary branch/);assert.deepEqual(await tree(project),before);
});
await check('ordinary branch extra file effects are rejected only in disposable clone',async()=>{
 const {task,project}=await fixture('current-rule-control');await writeFile(join(project,'scripts/build.mjs'),`if(process.argv.includes('--check')){console.log('CHECK_ONLY');process.exit(0);}\n`+task.files['scripts/build.mjs']+`\nimport {writeFileSync} from 'node:fs';writeFileSync('unexpected.txt','bad');\n`);
 const before=await tree(project);await assert.rejects(verifyCase(task.id,project),/ordinary branch effects/);assert.deepEqual(await tree(project),before);
});
console.log(`${passes} PASS / 0 FAIL; real bwrap, external deterministic verifier, synthetic workspace-only project trees; no provider/Host calls; fixture=${root}`);
