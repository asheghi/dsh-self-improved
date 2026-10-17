// Guarded optional cutover/rollback tool. DEFAULT IS READ-ONLY PLAN.
// Do not run --apply/--rollback from an active Host or without separately approved outside-workspace access.
import assert from 'node:assert/strict';
import { readFile, writeFile, realpath, readdir, mkdir, rename, access } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const args = process.argv.slice(2);
const flag = name => { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifestPath = await realpath(flag('--manifest') ?? '.tmp-import-lane/auth-receipt-core-candidate/cutover-manifest.json');
const manifestBytes = await readFile(manifestPath);
const manifest = JSON.parse(manifestBytes);
const root = await realpath(flag('--runtime') ?? manifest.installedRuntime);
assert.equal(root, await realpath(manifest.installedRuntime), 'runtime must match reviewed manifest');
assert.equal(manifest.version, 1);
const apply = args.includes('--apply'), rollback = args.includes('--rollback'); assert(!(apply && rollback));
const allowed = new Set(['dsh-client-connection/lib/index.js','dsh-api-gateway/lib/index.js','dsh-api-session-controller/lib/index.js',
 'dsh-client-connection/lib/types/index.d.ts','dsh-client-connection/lib/types/rpc.d.ts','dsh-client-connection/lib/types/rpc-host.d.ts','dsh-api-session-controller/lib/types/index.d.ts']);
assert.equal(manifest.files.length, allowed.size, 'exact scoped candidate file set');
for (const item of manifest.files) {
 assert(allowed.delete(item.path), 'duplicate or unreviewed target');
 const target = join(root, 'node_modules/@deepseek-ai', item.path);
 assert.equal(await realpath(target), target, 'resolved target must be exact intended regular package file, not an escaping symlink');
 item.target = target;
 assert.equal(JSON.parse(await readFile(join(root, 'node_modules/@deepseek-ai', item.path.split('/')[0], 'package.json'), 'utf8')).version, '0.2.0-rc.2');
 // Rollback uses verified originals, not disposable staged candidates.
  if (!rollback) {
  const candidate = await readFile(item.candidate);
 assert.equal(hash(candidate), item.candidateHash, 'candidate modified since manifest review');
 item.candidateBytes = candidate;
  }
}
if (!apply && !rollback) {
 console.log(JSON.stringify({ mode: 'read-only-plan', runtime: root, manifestHash: hash(manifestBytes), files: manifest.files.map(({ path, originalHash, candidateHash }) => ({ path, originalHash, candidateHash })), requires: ['separately approved outside-workspace access', 'explicit exact resolved runtime and manifest hash confirmation', 'exclusive Host shutdown', 'verified originals and workspace-owned backups', 'restart and fresh authenticated positive/negative acceptance'] }, null, 2));
} else {
 if (apply) assert.equal(manifest.acceptance, 'verified', 'pending candidate cannot be cut over; isolated whole-process acceptance and independent review required');
 assert.equal(flag('--confirm-target'), root, 'type the exact resolved runtime target; never infer consent');
 assert.equal(flag('--confirm-manifest-hash'), hash(manifestBytes), 'explicit reviewed manifest hash required');
 assert(args.includes('--exclusive-host-shutdown-confirmed'), 'exclusive shutdown confirmation required; tool never stops a Host');
 // Detect known runtime launches; this complements, never replaces, exclusive shutdown acknowledgment.
 for (const entry of await readdir('/proc')) {
  if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
  let command;
  try { command = (await readFile(`/proc/${entry}/cmdline`)).toString(); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; throw error; }
  if (!command) continue;
  const argv = command.split('\0');
  if (argv.some(value => value.startsWith(root + '/') && (value.includes('/dsh/') || value.endsWith('/dsh'))) && !argv.includes('--manifest')) throw new Error(`known runtime process ${entry} remains active; no files changed`);
 }
 const workspace = await realpath(manifest.workspace);
 const backup = resolve(flag('--backup') ?? ''); assert(flag('--backup'), 'explicit workspace backup directory required');
 assert(backup.startsWith(workspace + '/.tmp-import-lane/'), 'backup must stay in workspace private lane');
 await mkdir(backup, { recursive: true }); assert.equal(await realpath(backup), backup, 'backup path must not escape through symlinks');
 const receiptFile = join(backup, '.auth-core-rollback.json');
 if (apply) {
  try { await access(receiptFile); throw new Error('backup already owns another application; use a fresh directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  // Validate every target BEFORE writing any target. No profile/data/credentials are modified.
  for (const item of manifest.files) assert.equal(hash(await readFile(item.target)), item.originalHash, 'installed bytes differ from reviewed originals');
  for (const item of manifest.files) { const file = join(backup, item.path); await mkdir(dirname(file), { recursive: true }); await writeFile(file, await readFile(item.target), { flag: 'wx' }); assert.equal(hash(await readFile(file)), item.originalHash); }
  await writeFile(receiptFile, JSON.stringify({ runtime: root, manifestHash: hash(manifestBytes), files: manifest.files.map(({ path, originalHash, candidateHash }) => ({ path, originalHash, candidateHash })) }, null, 2), { flag: 'wx' });
  for (const item of manifest.files) { const temp = item.target + '.auth-candidate-' + randomUUID(); assert(temp.startsWith(dirname(item.target) + '/')); await writeFile(temp, item.candidateBytes, { flag: 'wx' }); assert.equal(await realpath(item.target), item.target); await rename(temp, item.target); }
  console.log('Applied scoped core files only. Restart Host, reopen its authenticated launch URL, and rerun all acceptance; backups retained.');
 } else {
  const receipt = JSON.parse(await readFile(receiptFile, 'utf8')); assert.equal(receipt.runtime, root); assert.equal(receipt.manifestHash, hash(manifestBytes));
  for (const item of manifest.files) { assert([item.candidateHash, item.originalHash].includes(hash(await readFile(item.target))), 'refuse to overwrite subsequent runtime changes; partial application permits only known original/candidate bytes'); assert.equal(hash(await readFile(join(backup, item.path))), item.originalHash); }
  for (const item of manifest.files) { const temp = item.target + '.auth-rollback-' + randomUUID(); assert(temp.startsWith(dirname(item.target) + '/')); await writeFile(temp, await readFile(join(backup, item.path)), { flag: 'wx' }); assert.equal(await realpath(item.target), item.target); await rename(temp, item.target); }
  console.log('Rolled back exact scoped originals. Restart Host; gate returns unavailable in the stricter plugin until a verified core capability is restored.');
 }
}
