#!/usr/bin/env node
/** Isolated AUTH/TRAINING host bootstrap, not a completed paired executor.
 * No credential copying, seeded episodes, stub provider, detached children, or
 * production profile access. Keep this foreground command in a managed job.
 */
import { mkdir, mkdtemp, readFile, writeFile, cp, symlink, readdir, realpath, rm, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inheritedCredential } from './learned-procedure-credential-env.mjs';
import { runtimeFingerprint } from './learned-procedure-runtime-fingerprint.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
const runtime = resolve(process.env.DSI_EVALUATION_RUNTIME ?? '/home/bahman/github/dsh-v0.2');
if (runtime !== '/home/bahman/github/dsh-v0.2' && !runtime.startsWith(repo)) throw new Error('candidate runtime must stay in the workspace');
const routeIndex=process.argv.indexOf('--route');
const route=JSON.parse(await readFile(routeIndex>=0?resolve(process.argv[routeIndex+1]):join(repo,'scripts/learned-procedure-go-route.json'),'utf8'));
if(!/^[a-z][a-z0-9-]+$/.test(route.provider)||!route.model||!route.profile?.apiKeyEnv)throw Error('explicit nonsecret provider route and credential reference required');
const provider=route.provider;
const authorize = process.argv.includes('--authorize');
if(authorize)throw Error('configured API-reference route uses supported credential inheritance, not the Codex OAuth helper');
const credentialEnv=await inheritedCredential(runtime,route.profile.apiKeyEnv,process.env.DSH_HOME);
const {attributionHeaders}=await import(pathToFileURL(join(runtime,'node_modules/@deepseek-ai/dsh-llm/lib/index.js')));
const userAgent=attributionHeaders()['user-agent'];
const pkg = JSON.parse(await readFile(join(runtime, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8'));
if (pkg.version !== '0.2.0-rc.2') throw new Error('requires pinned rc.2');
const manifest = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const zod = JSON.parse(await readFile(join(runtime, 'node_modules/zod/package.json'), 'utf8'));
if (!/^4\.\d+\.\d+$/.test(manifest.dependencies?.zod ?? '') || zod.version !== manifest.dependencies.zod) {
  throw new Error(`isolated host requires exact declared Zod4 dependency; declared=${manifest.dependencies?.zod}, installed=${zod.version}`);
}
const root = join(repo, 'fixtures/skill-measurement/real-host');
await mkdir(root, { recursive: true });
const resumeAt = process.argv.indexOf('--resume');
const run = resumeAt >= 0 ? await realpath(process.argv[resumeAt + 1]) : await mkdtemp(join(root, 'run-'));
if (!run.startsWith(root + '/run-')) throw new Error('resume requires owned isolated run');
if (resumeAt >= 0) {
  const owner = JSON.parse(await readFile(join(run, 'owner.json'), 'utf8'));
  if (owner.purpose !== 'isolated-real-learned-procedure' || owner.home !== join(run, 'home') || owner.stub !== false) throw new Error('resume ownership mismatch');
  if (await access(join(run, 'evaluation/freeze.json')).then(() => true, () => false)) throw new Error('cannot rebuild a frozen evaluation home');
  const previousShadow = join(run, 'plugin');
  if (await realpath(previousShadow) !== previousShadow) throw new Error('unexpected shadow symlink');
  // Only this verified disposable shadow is replaced. The HOME containing the
  // user-authenticated credential record is neither read nor copied/deleted.
  await rm(previousShadow, {recursive:true,force:true});
}
const home = join(run, 'home'), profile = join(home, 'profiles/learned-evaluation'), plugin = join(run, 'plugin');
await mkdir(join(home, 'tmp'), { recursive: true });
await mkdir(join(run,'evaluation'),{recursive:true});
await writeFile(join(run,'amendment.json'),await readFile(join(repo,'scripts/learned-procedure-go-amendment.json')));
await writeFile(join(run,'runtime.json'),JSON.stringify(await runtimeFingerprint(runtime),null,2)+'\n');
await writeFile(join(run,'route.json'),JSON.stringify({...route,userAgent,credentialInheritance:'single explicit API reference, child environment only; no OAuth records'},null,2)+'\n');
await mkdir(profile, { recursive: true });
await mkdir(join(plugin, 'node_modules/@deepseek-ai'), { recursive: true });
await mkdir(join(plugin, 'node_modules/@node-rs'), { recursive: true });
await cp(join(repo, 'lib'), join(plugin, 'lib'), { recursive: true });
await cp(join(repo, 'client.js'), join(plugin, 'client.js'));
await writeFile(join(plugin, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.0-real-evaluation', scripts: {} }, null, 2));
for (const entry of await readdir(join(runtime, 'node_modules/@deepseek-ai'))) {
  await symlink(join(runtime, 'node_modules/@deepseek-ai', entry), join(plugin, 'node_modules/@deepseek-ai', entry), 'dir');
}
await symlink(join(runtime, 'node_modules/zod'), join(plugin, 'node_modules/zod'), 'dir');
for (const dependency of ['@node-rs/jieba', 'sqlite-vec', 'sqlite-vec-linux-x64']) {
  await symlink(join(repo, 'node_modules', dependency), join(plugin, 'node_modules', dependency), 'dir');
}
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'isolated-learned-evaluation', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\nautoInstallPeers: false\n');
await writeFile(join(profile, 'cordis.yml'), '[]\n');
// Give evaluation-only Host entries distinct package identities. Resolving
// multiple raw scripts beneath this repo's dsh.client manifest would falsely
// advertise them as competing copies of the plugin's Client package.
const evaluationEntries = {};
for (const kind of ['budget', 'authorization', 'task-tools','go-transport','skill-audit']) {
  const directory = join(run, 'evaluation-tools', kind);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'package.json'), JSON.stringify({name:`@local/phase-e-${kind}`,version:'0.0.0',type:'module',private:true}));
  await writeFile(join(directory, 'index.mjs'), `export * from ${JSON.stringify(pathToFileURL(join(repo, `scripts/learned-procedure-${kind}-plugin.mjs`)).href)};\n`);
  evaluationEntries[kind] = pathToFileURL(join(directory, 'index.mjs')).href;
}
await writeFile(join(profile, 'cordis.patch.yml'), `- insert:\n    - id: dsh-self-improved\n      name: ${pathToFileURL(join(plugin, 'lib/index.js')).href}\n      config:\n        modules:\n          extract: false\n          consolidate: false\n          recall: false\n          tools: false\n        review:\n          enabled: false\n        episodeLearning:\n          enabled: true\n          reviewEnabled: true\n          operationalRecallEnabled: false\n          skillDraftsEnabled: true\n          skillMinEpisodes: 2\n    - id: learned-evaluation-native-skill\n      name: '@deepseek-ai/dsh-tool-skill'\n    - id: learned-evaluation-go-transport\n      name: ${evaluationEntries['go-transport']}\n      config: ${JSON.stringify({runDir:run,provider,baseURL:route.profile.baseURL,userAgent})}\n    - id: learned-evaluation-skill-audit\n      name: ${evaluationEntries['skill-audit']}\n      config: ${JSON.stringify({runDir:run,runtime})}\n    - id: learned-evaluation-budget\n      name: ${evaluationEntries.budget}\n      config:\n        runDir: ${JSON.stringify(run)}\n    - id: learned-evaluation-task-tools\n      name: ${evaluationEntries['task-tools']}\n      config:\n        runDir: ${JSON.stringify(run)}\n    - id: preset-learned-evaluation\n      name: '@deepseek-ai/dsh-agent-preset'\n      config:\n        id: learned-evaluation\n        plugins:\n          - id: persona\n            name: '@deepseek-ai/dsh-persona'\n            config:\n              prefix: Use project_bash to inspect project files before changing them and verify actual effects. Commands run in /work. Network and files outside the project are unavailable.\n              complete: true\n              includeRuntimeContext: false\n${authorize ? `    - id: learned-evaluation-authorization\n      name: ${evaluationEntries.authorization}\n      config:\n        runDir: ${JSON.stringify(run)}\n` : ''}- id: session-telemetry-otel\n  disabled: true\n- id: session-title-llm\n  disabled: true\n- id: llm-pi-ai\n  config:\n    providers:\n      ${provider}: ${JSON.stringify(route.profile)}\n`);
await writeFile(join(run, 'owner.json'), JSON.stringify({ purpose: 'isolated-real-learned-procedure', home, profile, provider, seededEpisodes: 0, stub: false }, null, 2));
console.log(JSON.stringify({ run, home, provider, model:route.model,status: 'Configured provider reference inherited privately; no tasks or efficacy measurement yet' }));
const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, DSH_HOME: home, TMPDIR: join(home, 'tmp'), DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'workspace-write', ...credentialEnv, ...(process.env.LANG ? { LANG: process.env.LANG } : {}) };
const child = spawn('node', [join(runtime, 'node_modules/.bin/dsh'), '--profile', 'learned-evaluation', '--no-open', '--port', '0'], { env, cwd: run, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
const stop = () => child.kill('SIGTERM');
process.on('SIGTERM', stop); process.on('SIGINT', stop);
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { console.log(`isolated host exited ${code ?? signal}`); process.exitCode = code ?? 1; });
