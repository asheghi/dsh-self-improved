#!/usr/bin/env node
/** Frozen executable repository work, not prompt-answer tasks or authored skill.
 * Only definitions live here. Learned procedure must come from real episodes.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath, readdir } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const brokenBuild = `import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist',{recursive:true});\ncopyFileSync('src/api.mjs','dist/index.js');\n`;
const maintenanceRules = 'Work only inside this project. Preserve every unrelated source, package export, and docs file. Do not change package.json or src/ API values. Fix scripts/build.mjs so npm run build produces every declared dist export target from the matching ESM/CJS source (CJS targets use src/api.cjs; all other dist targets use src/api.mjs); export targets outside dist must stay untouched. No dependency installation, network, git, delegation, or outside-file reads. Read the actual files before edits. Run npm run build and confirm actual import and require consumers. Report verified effects, not expected success.';
function repair(id, value, exports) {
 return { id, kind: 'procedure', prompt: maintenanceRules, files: {
  'package.json': JSON.stringify({ name: `phase-e-${id}`, version:'0.0.0',type:'module',exports,scripts:{build:'node scripts/build.mjs'} },null,2)+'\n',
  'scripts/build.mjs': brokenBuild,
  'src/api.mjs': `export const value = ${JSON.stringify(value)};\n`,
  'src/api.cjs': `exports.value = ${JSON.stringify(value)};\n`,
  'docs/keep.txt': 'User-authored documentation: leave this file unchanged.\n',
 }, expected: { value, targets: [...new Set(flatten(exports).filter(p=>p.startsWith('./dist/')))] } };
}
function flatten(value) { return typeof value==='string' ? [value] : value && typeof value==='object' ? Object.values(value).flatMap(flatten) : []; }
export const cases = Object.freeze([
 repair('training-alpha','alpha-real-export',{'.':{import:'./dist/entry.mjs',require:'./dist/entry.cjs'},'./package.json':'./package.json'}),
 {id:'training-fourstep',kind:'procedure',prompt:'Work only inside this project; no network, install, delegation, git, or outside-file reads. You decide the actual repair. Use EXACTLY FOUR project_bash calls, in this strict order and with no other calls: (1) inspect the current broken build script and the declared package export targets; (2) rewrite scripts/build.mjs so it produces every declared dist export target from the matching src (CJS targets use src/api.cjs; all other dist targets use src/api.mjs) while preserving all unrelated files and src API values; (3) run npm run build; (4) verify the declared dist targets actually import and require as expected. Nothing else in the four calls. Report verified effects only.',files:{'package.json':JSON.stringify({name:'phase-e-training-fourstep',version:'0.0.0',type:'module',exports:{'.':{import:'./dist/entry.mjs',require:'./dist/entry.cjs'},'./package.json':'./package.json'},scripts:{build:'node scripts/build.mjs'}},null,2)+'\n','scripts/build.mjs':brokenBuild,'src/api.mjs':'export const value = "fourstep-real-export";\n','src/api.cjs':'exports.value = "fourstep-real-export";\n','docs/keep.txt':'Fourstep training documentation: leave this file unchanged.\n'},expected:{value:'fourstep-real-export',targets:['./dist/entry.mjs','./dist/entry.cjs']}},
 {id:'training-oneline',kind:'procedure',prompt:'Work only inside this project; no network, install, delegation, git, or outside-file reads. This project already builds itself: COMPLETE EXACTLY ONE project_bash call overall, nothing else. That call must run `node scripts/build.mjs && node -e "import(\'./dist/entry.mjs\').then(m=>require(\'./dist/entry.cjs\'))"` exactly as written, with no additional commands, reads, edits, or verification steps in that or any other call. Report the observed output and effects only. If the exact single call is impossible, stop and state why instead of adding calls.', files:{'package.json':JSON.stringify({name:'phase-e-training-oneline',version:'0.0.0',type:'module',exports:{'.':{import:'./dist/entry.mjs',require:'./dist/entry.cjs'},'./package.json':'./package.json'},scripts:{build:'node scripts/build.mjs'}},null,2)+'\n','scripts/build.mjs':`import { mkdirSync, copyFileSync } from 'node:fs';\nmkdirSync('dist',{recursive:true});\ncopyFileSync('src/api.mjs','dist/entry.mjs');\ncopyFileSync('src/api.cjs','dist/entry.cjs');\n`,'src/api.mjs':'export const value = "oneline-real-export";\n','src/api.cjs':'exports.value = "oneline-real-export";\n','docs/keep.txt':'Oneline training documentation: leave this file unchanged.\n'},expected:{value:'oneline-real-export',targets:['./dist/entry.mjs','./dist/entry.cjs']}},
 repair('training-beta','beta-real-export',{'.':{node:{import:'./dist/main.mjs',require:'./dist/main.cjs'},default:'./dist/browser.mjs'},'./package.json':'./package.json'}),
 repair('heldout-gamma','gamma-heldout-export',{'.':{node:{import:'./dist/nested/root.mjs',require:'./dist/nested/root.cjs'},default:'./dist/web/root.mjs'},'./feature':{import:'./dist/features/addon.mjs',require:'./dist/features/addon.cjs'},'./package.json':'./package.json'}),
 {id:'unrelated-control',kind:'unrelated-control',prompt:'Work only inside this project; no network, install, delegation, git or outside-file reads. Read src/sum.mjs and fix sumFinite so it sums only finite numbers in its argument array, ignoring strings, null, NaN and infinities. Do not modify package.json or docs/keep.txt. Verify actual function behavior and report effects.',files:{'package.json':'{"name":"phase-e-control","type":"module"}\n','src/sum.mjs':'export const sumFinite = values => values.reduce((sum, value) => sum + value, 0);\n','docs/keep.txt':'Control documentation: leave unchanged.\n'},expected:{}},
 {id:'current-rule-control',kind:'current-rule-control',prompt:'Work only inside this project; no network, install, delegation, git or outside-file reads. CURRENT RULE overrides any previous procedure: this is a diagnostic-only change. Read scripts/build.mjs and add a --check branch that prints exactly CHECK_ONLY and exits successfully without creating dist or modifying any other file. Preserve the non-check branch byte-for-byte. Do NOT repair exports or run the ordinary build. Verify node scripts/build.mjs --check and report actual effects.',files:{'package.json':'{"name":"phase-e-current-rule","type":"module","exports":"./dist/unbuilt.mjs"}\n','scripts/build.mjs':brokenBuild,'src/api.mjs':'export const value = "do-not-build";\n','docs/keep.txt':'Current-rule documentation: leave unchanged.\n'},expected:{}},
]);

export async function writeCase(task, project) {
 await mkdir(project,{recursive:true});
 for(const [path,content] of Object.entries(task.files)){await mkdir(resolve(project,path,'..'),{recursive:true});await writeFile(resolve(project,path),content);}
}
export async function tree(project) {
 const root=await realpath(project),result={};
 async function visit(path){for(const entry of await readdir(path,{withFileTypes:true})){const child=join(path,entry.name);if(entry.isSymbolicLink())throw Error('task tree contains symlink');if(entry.isDirectory())await visit(child);else if(entry.isFile())result[relative(root,child)]=sha256(await readFile(child));else throw Error('unsupported task artifact');}}
 await visit(root);return Object.fromEntries(Object.entries(result).sort(([a],[b])=>a.localeCompare(b)));
}
export const CASESET_HASH = sha256(JSON.stringify(cases));
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify({version:'executed-package-repair-v1',sha256:CASESET_HASH,cases},null,2));
