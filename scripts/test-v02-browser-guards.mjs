#!/usr/bin/env node
// Focused runner safety tests; complementary to, never a replacement for CDP battery.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync,realpathSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
const root=resolve(new URL('..',import.meta.url).pathname),base=join(root,'fixtures/v02-ui/temp');mkdirSync(base,{recursive:true});
const dir=mkdtempSync(join(base,'browser-guards-'));
try{
for(const [name,url,runDir] of [['live','http://127.0.0.1:3082/',dir],['external','http://example.com:1234/',dir],['foreign-home','http://127.0.0.1:1234/','/outside']]){
const path=join(dir,name+'.json');writeFileSync(path,JSON.stringify({url,runDir}));
const result=spawnSync(process.execPath,['scripts/test-v02-browser.mjs',path,'ws://127.0.0.1:1/'],{cwd:root,encoding:'utf8'});
assert.notEqual(result.status,0,name+' must reject');assert.match(result.stderr,/Refusing nonisolated fixture/);console.log('PASS reject '+name);
}
}finally{const target=realpathSync(dir),guard=realpathSync(base);assert(target.startsWith(guard+'/browser-guards-'));rmSync(target,{recursive:true,force:true})}
