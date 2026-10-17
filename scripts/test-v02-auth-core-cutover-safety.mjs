#!/usr/bin/env node
// Workspace-only synthetic package graph. NEVER targets installed DSH, stops a
// Host, or claims runtime acceptance. Exercises the optional cutover CLI itself.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, realpathSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const repo = fileURLToPath(new URL('../', import.meta.url));
const lane = join(repo, '.tmp-import-lane'); mkdirSync(lane, { recursive: true });
const fixture = mkdtempSync(join(lane, 'auth-cutover-safety-'));
assert(fixture.startsWith(lane + '/'));
const runtime = join(fixture, 'synthetic-runtime'), candidates = join(fixture, 'candidates');
mkdirSync(runtime); mkdirSync(candidates);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = ['dsh-client-connection/lib/index.js', 'dsh-api-gateway/lib/index.js', 'dsh-api-session-controller/lib/index.js',
  'dsh-client-connection/lib/types/index.d.ts', 'dsh-client-connection/lib/types/rpc.d.ts',
  'dsh-client-connection/lib/types/rpc-host.d.ts', 'dsh-api-session-controller/lib/types/index.d.ts'];
const target = path => join(runtime, 'node_modules/@deepseek-ai', path);
const originals = new Map(), changed = new Map();
for (const path of paths) {
  const original = Buffer.from(`// synthetic original ${path}\n`), candidate = Buffer.from(`// synthetic candidate ${path}\n`);
  originals.set(path, original); changed.set(path, candidate);
  mkdirSync(dirname(target(path)), { recursive: true }); writeFileSync(target(path), original);
  const candidatePath = join(candidates, path); mkdirSync(dirname(candidatePath), { recursive: true }); writeFileSync(candidatePath, candidate);
}
for (const name of new Set(paths.map(path => path.split('/')[0]))) writeFileSync(join(runtime, 'node_modules/@deepseek-ai', name, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.2.0-rc.2', private: true }));
const manifestPath = join(fixture, 'manifest.json');
let manifest = { version: 1, workspace: repo, installedRuntime: runtime, acceptance: 'pending', files: paths.map(path => ({ path,
  candidate: join(candidates, path), originalHash: hash(originals.get(path)), candidateHash: hash(changed.get(path)) })) };
const save = () => writeFileSync(manifestPath, JSON.stringify(manifest, null, 2)); save();
const snapshot = () => paths.map(path => hash(readFileSync(target(path))));
const originalSnapshot = snapshot();
const tree = dir => readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? tree(join(dir, entry.name)) : [join(dir, entry.name)]).sort();
let serial = 0, passes = 0;
function invoke(extra = [], success = true) {
  const result = spawnSync(process.execPath, [join(repo, 'scripts/apply-v02-auth-core-candidate.mjs'), '--manifest', manifestPath, '--runtime', runtime, ...extra], { cwd: repo, encoding: 'utf8', timeout: 30000 });
  assert.ifError(result.error); assert.equal(result.signal, null);
  assert.equal(result.status === 0, success, result.stdout + result.stderr);
  return result;
}
function confirmations(backup) { return ['--confirm-target', runtime, '--confirm-manifest-hash', hash(readFileSync(manifestPath)), '--exclusive-host-shutdown-confirmed', '--backup', backup]; }
function backup() { return join(fixture, 'backup-' + ++serial); }
function check(name, fn) { fn(); passes++; console.log('PASS ' + name); }
check('default plan is inert even for pending candidate', () => {
  const beforeFiles = tree(fixture), before = snapshot(); const result = invoke();
  assert.equal(JSON.parse(result.stdout).mode, 'read-only-plan'); assert.deepEqual(snapshot(), before); assert.deepEqual(tree(fixture), beforeFiles);
});
check('pending apply refuses before backup or runtime writes', () => {
  const dir = backup(), before = snapshot(); const result = invoke(['--apply', ...confirmations(dir)], false);
  assert.match(result.stderr, /pending candidate cannot be cut over/); assert(!existsSync(dir)); assert.deepEqual(snapshot(), before);
});
manifest.acceptance = 'verified'; save();
check('missing and inexact target/hash/shutdown confirmations refuse with no target writes', () => {
  const cases = [[], ['--confirm-target', runtime + '-wrong'], ['--confirm-target', runtime, '--confirm-manifest-hash', '0'.repeat(64)],
    ['--confirm-target', runtime, '--confirm-manifest-hash', hash(readFileSync(manifestPath))]];
  for (const flags of cases) { const dir = backup(), before = snapshot(); invoke(['--apply', ...flags, '--backup', dir], false); assert.deepEqual(snapshot(), before); assert(!existsSync(dir)); }
});
check('candidate tampering refuses before plan or writes', () => {
  const path = paths[0], file = join(candidates, path); writeFileSync(file, 'unknown candidate');
  const before = snapshot(); const result = invoke([], false); assert.match(result.stderr, /candidate modified/); assert.deepEqual(snapshot(), before); writeFileSync(file, changed.get(path));
});
check('original mismatch preflights all targets before any runtime replacement or backup receipt', () => {
  const path = paths.at(-1), dir = backup(); writeFileSync(target(path), 'unexpected installed bytes'); const before = snapshot();
  const result = invoke(['--apply', ...confirmations(dir)], false); assert.match(result.stderr, /installed bytes differ/);
  assert.deepEqual(snapshot(), before); assert(!existsSync(join(dir, '.auth-core-rollback.json'))); assert.deepEqual(tree(dir), []);
  writeFileSync(target(path), originals.get(path));
});
let appliedBackup;
check('successful apply replaces only exact targets after verified originals and backup receipt', () => {
  appliedBackup = backup(); const result = invoke(['--apply', ...confirmations(appliedBackup)]); assert.match(result.stdout, /Applied scoped core files only/);
  assert.deepEqual(snapshot(), paths.map(path => hash(changed.get(path))));
  for (const path of paths) assert.equal(hash(readFileSync(join(appliedBackup, path))), hash(originals.get(path)));
  const receipt = JSON.parse(readFileSync(join(appliedBackup, '.auth-core-rollback.json')));
  assert.equal(receipt.runtime, runtime); assert.equal(receipt.manifestHash, hash(readFileSync(manifestPath))); assert.equal(receipt.files.length, paths.length);
});
check('rollback refuses unknown subsequent runtime changes before restoring any other target', () => {
  const path = paths.at(-1); writeFileSync(target(path), 'subsequent unrelated update'); const before = snapshot();
  const result = invoke(['--rollback', ...confirmations(appliedBackup)], false); assert.match(result.stderr, /subsequent runtime changes/); assert.deepEqual(snapshot(), before);
  writeFileSync(target(path), changed.get(path));
});
check('rollback accepts partial-known original/candidate state and restores exact originals', () => {
  writeFileSync(target(paths[0]), originals.get(paths[0])); writeFileSync(target(paths[3]), originals.get(paths[3]));
  const result = invoke(['--rollback', ...confirmations(appliedBackup)]); assert.match(result.stdout, /Rolled back exact scoped originals/); assert.deepEqual(snapshot(), originalSnapshot);
});
check('rollback restores originals even with deleted and tampered disposable candidate artifacts', () => {
  const deleted = join(candidates, paths[0]);
  // Verify exact absolute workspace-owned target before deleting this fixture file.
  assert.equal(realpathSync(deleted), deleted); assert(deleted.startsWith(fixture + '/candidates/'));
  unlinkSync(deleted); writeFileSync(join(candidates, paths[1]), 'tampered disposable candidate');
  // Exercise an actual applied/partial-known runtime, not a no-op original state.
  for (const path of paths) writeFileSync(target(path), changed.get(path));
  writeFileSync(target(paths[2]), originals.get(paths[2]));
  const result = invoke(['--rollback', ...confirmations(appliedBackup)]);
  assert.match(result.stdout, /Rolled back exact scoped originals/); assert.deepEqual(snapshot(), originalSnapshot);
});
check('tampered backup refuses rollback without touching runtime targets', () => {
  writeFileSync(join(appliedBackup, paths.at(-1)), 'corrupt backup'); const before = snapshot(); invoke(['--rollback', ...confirmations(appliedBackup)], false); assert.deepEqual(snapshot(), before);
});
console.log(`${passes} PASS / 0 FAIL; synthetic workspace-only package graph; no installed runtime/Host touched; fixture=${fixture}`);
