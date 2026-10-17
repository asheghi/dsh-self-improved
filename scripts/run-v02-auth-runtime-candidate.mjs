// Launch the existing isolated mounted fixture against a private copied core graph.
// Never launches against the installed runtime or a real profile/home.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { spawn } from 'node:child_process';
const repo = await realpath(resolve(process.cwd()));
const runtime = await realpath(process.env.DSH_AUTH_CANDIDATE_RUNTIME ?? '');
assert(runtime.startsWith(join(repo, '.tmp-import-lane', 'auth-runtime-')) && runtime !== repo, 'explicit private copied candidate runtime required');
const marker = JSON.parse(await readFile(join(runtime, '.auth-runtime-owner.json'), 'utf8'));
assert.equal(marker.workspace, repo);
let runner = await readFile(join(repo, 'scripts/test-v02-mounted-ui.mjs'), 'utf8');
const rootAnchor = 'const ROOT = new URL("..", import.meta.url).pathname;';
const runtimeAnchor = 'const RUNTIME = "/home/bahman/github/dsh-v0.2"; // installed read-only rc.2 installation';
assert.equal(runner.split(rootAnchor).length, 2); assert.equal(runner.split(runtimeAnchor).length, 2);
runner = runner.replace(rootAnchor, `const ROOT = ${JSON.stringify(repo + sep)};`).replace(runtimeAnchor, `const RUNTIME = ${JSON.stringify(runtime)}; // workspace copied authenticated candidate only`);
runner = runner.replace('    DSH_PERMISSION_MODE: "workspace-write",', '    DSH_PERMISSION_MODE: "workspace-write",\n    DSH_AUTH_DIAG: process.env.DSH_AUTH_DIAG ?? "",');
if (process.env.DSH_AUTH_PROBE === '1') {
 const anchor = 'function scaffoldProfile(profileDir, pluginDir) {';
 assert.equal(runner.split(anchor).length, 2);
 runner = runner.replace(anchor, anchor + '\n  writeFileSync(join(pluginDir, "auth-probe.mjs"), readFileSync(join(ROOT, "scripts/auth-host-probe-plugin.mjs"), "utf8"));');
 const insert = '    "- id: session-telemetry-otel\\n  disabled: true\\n" +';
 assert.equal(runner.split(insert).length, 2);
 runner = runner.replace(insert, '    `- insert:\\n    - id: auth-host-probe\\n      name: ${pathToFileURL(join(pluginDir, "auth-probe.mjs")).href}\\n` +\n' + insert);
}
const file = join(runtime, 'mounted-auth-candidate.mjs');
await writeFile(file, runner);
const child = spawn(process.execPath, [file, ...process.argv.slice(2)], { env: { ...process.env, DSI_E2E_CONTINUITY: '1' }, stdio: 'inherit' });
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGTERM'));
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
