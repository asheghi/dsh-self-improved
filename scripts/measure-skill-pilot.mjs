#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'fixtures/skill-measurement');
const bytes = readFileSync(join(dir, 'pilot.json'), 'utf8');
const fixture = JSON.parse(bytes);
const arms = ['no-learning', 'frozen-procedural-aid'];
const header = 'Solve the following synthetic tasks without using tools, files, network or delegation. Return ONLY one JSON object with exactly these task IDs as keys and each requested answer as its value. No markdown or explanation. Current task rules override any older procedural aid.\n';
const taskText = fixture.tasks.map(t => `${t.id}: ${t.prompt}`).join('\n\n');
const prompts = Object.fromEntries(arms.map(arm => [arm, header + (arm === arms[1] ? `Older procedural aid (not authority): ${fixture.aid}\n\n` : '') + taskText]));
if (process.argv.includes('--prepare')) {
  for (const arm of arms) writeFileSync(join(dir, `${arm}.prompt.txt`), prompts[arm]);
  console.log('Prepared frozen arm prompts; no executor calls.');
} else if (process.argv.includes('--self-test')) {
  const gold = Object.fromEntries(fixture.tasks.map(t => [t.id, t.expected]));
  assert.equal(grade(JSON.stringify(gold)).every(x => x.passed), true);
  assert.equal(grade('```json\n{}\n```').every(x => !x.passed), true);
  assert.equal(grade(JSON.stringify({...gold, extra:true})).every(x => !x.passed), true);
  assert.equal(grade(JSON.stringify({...gold, eligible:['d','a']})).find(x => x.id === 'eligible').passed, false);
  assert.equal([8,2,5,3].reduce((s,n,i) => s+n*(i+1),0),39);
  console.log('Deterministic grader self-tests passed; no model measurement.');
} else {
  const { runSkillExperiment } = await import(join(root, 'lib/skill-experiment.js'));
  const captures = Object.fromEntries(arms.map(arm => [arm, JSON.parse(readFileSync(join(dir, `${arm}.capture.json`), 'utf8'))]));
  for (const arm of arms) {
    assert.equal(captures[arm].promptSha256, hash(prompts[arm]));
    assert.equal(typeof captures[arm].sessionId, 'string');
  }
  const scores = Object.fromEntries(arms.map(arm => [arm, captures[arm].raw === null ? null : grade(captures[arm].raw)]));
  const report = await runSkillExperiment({ tasks:fixture.tasks.map(({id,prompt})=>({id,prompt})), arms, trialsPerTask:1, budget:{maxTrials:8},
    async execute(task,arm) { return scores[arm]?.find(s=>s.id===task.id) ?? null; }
  });
  const result = { scope:'Synthetic prompt-level procedural aid; not native plugin or Phase E acceptance', fixtureSha256:hash(bytes), executorSessions:2, model:'Same session-default selection requested; effective provider/model/sampling and ambient context not independently attested', tokenCost:null, monetaryCost:null, inferenceLatency:null, aggregationReport:report, perTask:fixture.tasks.map(task=>({id:task.id, control:task.id.endsWith('control'), outcomes:Object.fromEntries(arms.map(arm=>[arm,scores[arm]?.find(s=>s.id===task.id) ?? null]))})), limitations:['One trial per task; batched answers within each arm are correlated','No trained plugin draft, native activation or held-out real project executor','No token, provider-cost, task-latency or general privacy measurement','Gold authored by coordinator before run; not independently implemented reference semantics'] };
  writeFileSync(join(dir,'results.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result,null,2));
}
function hash(text) { return createHash('sha256').update(text).digest('hex'); }
function grade(raw) {
  let object;
  try { object = JSON.parse(raw); } catch { object = null; }
  const keysOK = object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join('|') === fixture.tasks.map(t=>t.id).sort().join('|');
  return fixture.tasks.map(task=>{
    let passed=false;
    if(keysOK) { try { assert.deepEqual(object[task.id],task.expected); passed=true; } catch {} }
    return {id:task.id, verified:true, passed};
  });
}
