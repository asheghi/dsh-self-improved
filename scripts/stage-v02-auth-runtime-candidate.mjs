// Isolated copied Harness package graph: no runtime/profile changes and no install scripts.
// Copies DSH-owned packages so nested bare imports resolve the candidate owners;
// third-party dependencies are read-only symlinks. No --preserve-symlinks tricks.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, readdir, cp, symlink, copyFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import './stage-v02-auth-receipt-core-candidate.mjs';
const installed = process.env.DSH_RUNTIME_RC2;
assert(installed, 'explicit installed runtime required');
const repo = resolve(process.cwd());
const lane = resolve(repo, '.tmp-import-lane/auth-receipt-core-candidate');
const target = await mkdtemp(join(repo, '.tmp-import-lane/auth-runtime-'));
await mkdir(join(target, 'node_modules/@deepseek-ai'), { recursive: true });
await copyFile(join(installed, 'package.json'), join(target, 'package.json'));
await writeFile(join(target, '.auth-runtime-owner.json'), JSON.stringify({ workspace: repo, installedRuntime: installed, createdAt: Date.now() }));
for (const entry of await readdir(join(installed, 'node_modules'), { withFileTypes: true })) {
 if (entry.name === '@deepseek-ai' || entry.name === '.bin') continue;
 await symlink(join(installed, 'node_modules', entry.name), join(target, 'node_modules', entry.name));
}
for (const entry of await readdir(join(installed, 'node_modules/@deepseek-ai'), { withFileTypes: true })) {
 const source = join(installed, 'node_modules/@deepseek-ai', entry.name);
 await cp(source, join(target, 'node_modules/@deepseek-ai', entry.name), { recursive: true, dereference: true });
}
await mkdir(join(target, 'node_modules/.bin'));
await symlink('../@deepseek-ai/dsh/lib/bin.js', join(target, 'node_modules/.bin/dsh'));
for (const name of ['dsh-client-connection', 'dsh-api-gateway', 'dsh-api-session-controller']) {
 await copyFile(join(lane, `${name}.candidate.js`), join(target, 'node_modules/@deepseek-ai', name, 'lib/index.js'));
}
for (const [name, file] of [['dsh-client-connection','index.d.ts'],['dsh-client-connection','rpc.d.ts'],['dsh-client-connection','rpc-host.d.ts'],['dsh-api-session-controller','index.d.ts']]) {
 await copyFile(join(lane, 'declarations', `${name}.${file}`), join(target, 'node_modules/@deepseek-ai', name, 'lib/types', file));
}
await writeFile(join(lane, 'runtime-candidate-path.txt'), target + '\n');
console.log(target);
console.log('Candidate graph copied inside workspace only. Public runtime untouched; do not use a real profile/home. Auth/Continue/full process acceptance still requires tests.');
