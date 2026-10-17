// Launch the isolated mounted fixture against the stock installed runtime with
// continuity enabled, optionally composing the auth probe plugin. Never touches
// a real profile/home: the rewritten runner lives in an ignored workspace lane.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, mkdir } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
const repo = await realpath(resolve(process.cwd()));
let runner = await readFile(join(repo, 'scripts/test-v02-mounted-ui.mjs'), 'utf8');
const rootAnchor = 'const ROOT = new URL("..", import.meta.url).pathname;';
assert.equal(runner.split(rootAnchor).length, 2);
runner = runner.replace(rootAnchor, `const ROOT = ${JSON.stringify(repo + sep)};`);
if (process.env.DSH_AUTH_PROBE === '1') {
 const anchor = 'function scaffoldProfile(profileDir, pluginDir) {';
 assert.equal(runner.split(anchor).length, 2);
 runner = runner.replace(anchor, anchor + '\n  writeFileSync(join(pluginDir, "auth-probe.mjs"), readFileSync(join(ROOT, "scripts/auth-host-probe-plugin.mjs"), "utf8"));');
 const insert = '    "- id: session-telemetry-otel\\n  disabled: true\\n" +';
 assert.equal(runner.split(insert).length, 2);
 runner = runner.replace(insert, '    `- insert:\\n    - id: auth-host-probe\\n      name: ${pathToFileURL(join(pluginDir, "auth-probe.mjs")).href}\\n` +\n' + insert);
}
const lane = join(repo, '.tmp-import-lane', 'auth-host');
await mkdir(lane, { recursive: true });
const file = join(lane, 'mounted-auth-host.mjs');
await writeFile(file, runner);
const child = spawn(process.execPath, [file, ...process.argv.slice(2)], { env: { ...process.env, DSI_E2E_CONTINUITY: '1' }, stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
