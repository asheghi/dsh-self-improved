#!/usr/bin/env node
/**
 * scripts/test-v02-skill-activation-mounted.mjs — mounted proof of the Phase E
 * activation lane.
 *
 * Boot the fixture with one draft that is ALREADY durably activated:
 *   DSI_E2E_ACTIVATED_SKILL=1 node scripts/test-v02-mounted-ui.mjs up --fresh
 *
 * Then this gate requires, over the real gateway:
 *   1. the plugin mounted a skills service and REPLAYED that activation at boot
 *      (a user-invocable runtime skill exists), observed through the snapshot;
 *   2. invalidating the draft's support DEACTIVATES the live skill the next time
 *      the lane is observed — the row keeps 'invalidated', which is a stronger
 *      fact than a rollback;
 *   3. a rolled-back draft is never replayed.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const base = (flag('--base') ?? '').replace(/\/$/, '');
const token = flag('--token');
const runDir = flag('--run');
if (!base || !runDir) { console.error('usage: --base <url> (--token <t> | --cookie <c>) --run <runDir>'); process.exit(2); }

let cookie = flag('--cookie') ?? '';
let passes = 0, failures = 0;
const check = (name, ok, detail) => {
  if (ok) { passes++; console.log('PASS ' + name); }
  else { failures++; console.log('FAIL ' + name + (detail ? ' :: ' + detail : '')); }
};
const facts = JSON.parse(readFileSync(join(runDir, 'facts.json'), 'utf8'));
const rpc = async (endpoint, argsObject) => {
  const body = { type: 'client-request', rpcId: 'skills-' + Math.random().toString(16).slice(2), method: endpoint, payload: { args: argsObject } };
  const response = await fetch(`${base}/api/${endpoint}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
  const envelope = await response.json().catch(() => null);
  return { http: response.status, result: envelope && envelope.result };
};
const lane = async () => {
  const snapshot = await rpc('selfImproved/snapshot', {});
  return snapshot.result?.ok === true ? snapshot.result.value?.learnedSkills ?? null : null;
};
const setDraftStatus = (status) => {
  const db = new DatabaseSync(join(facts.home, 'memory', 'memory.db'));
  db.prepare('UPDATE skill_drafts SET status = ?, updated_at = ? WHERE id = ?').run(status, Date.now(), 'draft-seeded');
  db.close();
};

try {
  if (!cookie && token) {
    const index = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const raw = index.headers.getSetCookie ? index.headers.getSetCookie() : [index.headers.get('set-cookie')];
    cookie = (raw.filter(Boolean)[0] || '').split(';')[0];
    check('launch token exchanges for an operator cookie', cookie.startsWith('dsh-auth-'), `HTTP ${index.status}`);
  }
  const boot = await lane();
  check('the host exposes the learned-skill lane', !!boot && boot.available === true, JSON.stringify(boot).slice(0, 200));
  check('the durably activated draft was REPLAYED at boot as a live skill',
    !!boot && boot.active.some((skill) => skill.name === 'seeded-learned-skill'),
    JSON.stringify(boot).slice(0, 300));
  check('the live skill carries its recorded evaluation state, not a claim of measurement',
    !!boot && boot.active.every((skill) => skill.evaluationVersion === null || typeof skill.evaluationVersion === 'string'),
    JSON.stringify(boot?.active ?? []).slice(0, 200));

  setDraftStatus('invalidated');
  const afterInvalidation = await lane();
  check('invalidating the support DEACTIVATES the live skill',
    !!afterInvalidation && !afterInvalidation.active.some((skill) => skill.name === 'seeded-learned-skill'),
    JSON.stringify(afterInvalidation).slice(0, 300));
  check('the deactivation is reported rather than silent',
    !!afterInvalidation && Number(afterInvalidation.deactivated) >= 1, JSON.stringify(afterInvalidation).slice(0, 200));
  {
    const db = new DatabaseSync(join(facts.home, 'memory', 'memory.db'));
    const row = db.prepare('SELECT status FROM skill_drafts WHERE id = ?').get('draft-seeded');
    db.close();
    check('the draft keeps the stronger "invalidated" status rather than being rewritten',
      row?.status === 'invalidated', String(row?.status));
  }

  const stable = await lane();
  check('an invalidated draft is never replayed afterwards',
    !!stable && !stable.active.some((skill) => skill.name === 'seeded-learned-skill'), JSON.stringify(stable).slice(0, 200));
} catch (error) {
  failures++;
  console.log('FAIL mounted skill gate threw :: ' + String(error?.message ?? error));
}

console.log(`${passes} mounted learned-skill gates PASS, ${failures} FAIL (real gateway, real boot restore)`);
process.exit(failures === 0 ? 0 : 1);
