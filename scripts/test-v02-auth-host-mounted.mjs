// Whole stock-runtime Host battery (0.2.1 Peer model) in ONE managed job/PID namespace.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
const env = { ...process.env, DSH_AUTH_PROBE: '1' };
const children = [];
function start(script, args) { const child = spawn(process.execPath, [script, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] }); children.push(child); child.stderr.pipe(process.stderr); return child; }
async function command(script, args) { const child = start(script, args); child.stdout.pipe(process.stdout); const [code] = await once(child, 'exit'); assert.equal(code, 0, `${script} ${args.join(' ')} failed`); }
async function fixture(args, field) { const child = start('scripts/run-v02-auth-host.mjs', args); let text = ''; const facts = await new Promise((resolve, reject) => { child.stdout.on('data', chunk => { text += chunk; process.stdout.write(chunk); try { const value = JSON.parse(text); if (value[field] !== undefined) resolve(value); } catch {} }); child.once('exit', code => reject(new Error(`fixture exited before facts: ${code}`))); }); return facts; }
try {
 const facts = await fixture(['up', '--keep'], 'runDir');
 const run = facts.runDir;
 await command('scripts/test-v02-auth-mounted-negative.mjs', ['--run', run]);
 await command('scripts/test-v02-continuity-restart-mounted.mjs', ['--phase1', '--run', run, '--timeout', '45000']);
 const probe = JSON.parse(await readFile(join(facts.home, 'auth-host-probe.json'), 'utf8'));
 assert.equal(probe.passed, true, JSON.stringify(probe)); console.log('PASS whole Host probe: ' + probe.results.join('; '));
 await command('scripts/test-v02-auth-continue-adversarial.mjs', ['--run', run]);
 const login = new URL(facts.url);
 await command('scripts/test-v02-continuity-door-mounted.mjs', ['--base', login.origin, '--token', login.searchParams.get('token')]);
 await fixture(['restart', '--run', run, '--keep'], 'restarts');
 await command('scripts/test-v02-continuity-restart-mounted.mjs', ['--phase2', '--run', run]);
 await command('scripts/test-v02-auth-mounted-negative.mjs', ['--run', run]);
 console.log('PASS whole stock Host authenticated capture, durable restart, Continue and HTTP negatives; provider is synthetic; not full auth acceptance.');
} finally { for (const child of children.reverse()) if (child.exitCode === null) child.kill('SIGTERM'); }
