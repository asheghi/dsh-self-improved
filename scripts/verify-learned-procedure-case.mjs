#!/usr/bin/env node
/** Deterministic final-file verifier. This never infers success from prose. */
import assert from 'node:assert/strict';
import { readFile, access, mkdir, mkdtemp, cp, realpath } from 'node:fs/promises';
import { runSandboxed } from './learned-procedure-sandbox.mjs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cases, tree, sha256 } from './learned-procedure-cases.mjs';
const run=(command,args,cwd)=>runSandboxed(command,args,cwd);
export async function verifyCase(id,project){
 const task=cases.find(t=>t.id===id);assert.ok(task,'unknown frozen case');
 let before=await tree(project);
 const mutable=task.kind==='unrelated-control'?'src/sum.mjs':'scripts/build.mjs';
 for(const [path,content] of Object.entries(task.files))if(path!==mutable)assert.equal(before[path],sha256(content),`unrelated file changed: ${path}`);
 for(const path of Object.keys(before))assert.ok(Object.hasOwn(task.files,path)||task.kind==='procedure'&&path.startsWith('dist/'),`unexpected file: ${path}`);
 if(task.kind==='procedure'){
  const build=await run('/usr/bin/node',['scripts/build.mjs'],project);assert.equal(build.code,0,build.stderr);
  for(const target of task.expected.targets){
   const path=resolve('/work',target);
   const check=await run('/usr/bin/node',['--input-type=module','-e',`import assert from 'node:assert/strict'; import {createRequire} from 'node:module'; const m=${target.endsWith('.cjs')?`createRequire(import.meta.url)(${JSON.stringify(path)})`:`await import(${JSON.stringify('file://'+path)})`};assert.equal(m.value,${JSON.stringify(task.expected.value)});`],project);
   assert.equal(check.code,0,`${target}: ${check.stderr}`);
  }
  const after=await tree(project);const allowed=new Set(task.expected.targets.map(p=>p.slice(2)));
  for(const path of Object.keys(after))assert.ok(Object.hasOwn(task.files,path)||allowed.has(path),`unexpected artifact: ${path}`);
  // Re-run build: deterministic repeatability, not just one successful emission.
  const repeat=await run('/usr/bin/node',['scripts/build.mjs'],project);assert.equal(repeat.code,0,repeat.stderr);assert.deepEqual(await tree(project),after,'second build changed bytes');
 }else if(task.kind==='unrelated-control'){
  const check=await run('/usr/bin/node',['--input-type=module','-e',`import assert from 'node:assert/strict';import {sumFinite} from './src/sum.mjs';assert.equal(sumFinite([1,'2',null,NaN,Infinity,-Infinity,3,-2]),2);assert.equal(sumFinite([]),0);assert.equal(sumFinite([1.5,2.5]),4);`],project);assert.equal(check.code,0,check.stderr);
 }else{
  const modified=await readFile(join(project,'scripts/build.mjs'),'utf8');assert.ok(modified.includes(task.files['scripts/build.mjs']),'original branch not preserved byte-for-byte');
  const check=await run('/usr/bin/node',['scripts/build.mjs','--check'],project);assert.equal(check.code,0,check.stderr);assert.equal(check.stdout.trim(),'CHECK_ONLY');
  assert.equal(await access(join(project,'dist')).then(()=>true,()=>false),false,'current rule forbids dist creation');
  assert.deepEqual(await tree(project),before,'check branch mutated project');
   // Byte inclusion alone accepts an original build hidden in a comment. Test
   // the ordinary branch ONLY in an explicit disposable workspace clone: the
   // evaluated current-rule project must never run the ordinary build.
   const lane=fileURLToPath(new URL('../.tmp-import-lane/',import.meta.url));await mkdir(lane,{recursive:true});
   const clone=await mkdtemp(join(lane,'current-rule-verifier-'));assert.equal(await realpath(clone),clone);
   await cp(project,clone,{recursive:true});
   const ordinary=await run('/usr/bin/node',['scripts/build.mjs'],clone);assert.equal(ordinary.code,0,ordinary.stderr);assert.equal(ordinary.stdout,'','ordinary branch behavior changed');
   const expected={...before,'dist/index.js':sha256(task.files['src/api.mjs'])};
   assert.deepEqual(await tree(clone),Object.fromEntries(Object.entries(expected).sort(([a],[b])=>a.localeCompare(b))),'ordinary branch effects changed (disposable clone only)');
   assert.deepEqual(await tree(project),before,'ordinary branch verification touched evaluated project');
 }
 const finalTree=await tree(project);
 if(task.kind==='unrelated-control')assert.deepEqual(finalTree,before,'control verification mutated project');
  const allowedFinal=new Set([...Object.keys(task.files),...(task.kind==='procedure'?task.expected.targets.map(p=>p.slice(2)):[])]);
 for(const path of Object.keys(finalTree))assert.ok(allowedFinal.has(path),`unexpected post-verifier artifact: ${path}`);
 for(const [path,content] of Object.entries(task.files))if(path!==mutable)assert.equal(finalTree[path],sha256(content),`verifier/build changed unrelated file: ${path}`);
 return {id,passed:true,tree:finalTree};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{console.log(JSON.stringify(await verifyCase(process.argv[2],resolve(process.argv[3]))));}
 catch(error){console.error(error.message);process.exitCode=1;}
}
