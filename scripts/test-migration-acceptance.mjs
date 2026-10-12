#!/usr/bin/env node
/** Reproducible isolated regression gate; NOT deployment/browser/authorization acceptance. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = process.env.DSH_RUNTIME_RC2;
if (!runtime || !isAbsolute(runtime) || !existsSync(join(runtime, 'node_modules'))) {
  console.error('An explicit absolute DSH_RUNTIME_RC2 with installed pinned peers is required. No fallback, installation, or skip-as-pass.');
  process.exit(2);
}
const groups = {
  increments: ['test-v02-continuity-runtime-v03', 'test-v02-continuity-sessions-v03', 'test-v02-continuity-provider-worker-v03', 'test-episode-evaluation'],
  memory: ['test-phase-a', 'test-storage', 'test-redact', 'test-episodes', 'test-episode-review', 'test-episode-rollout', 'test-extract', 'test-recall', 'test-evolve', 'test-commands', 'test-hermes', 'test-audit-skills', 'test-settings-ui', 'test-user-edit-preservation'],
  import: ['test-v02-import-lane', 'test-v02-import-audit', 'test-v02-import-gates', 'test-v02-import-seam', 'test-migration-v02', 'test-v02-policy-lane', 'test-v02-fact-policy', 'test-v02-minimization', 'test-v02-revocation'],
  packaging: ['test-v02-package', 'test-v02-typecheck-modes', 'test-v02-remote-cancellation', 'test-v02-client-smoke'],
  durability: ['test-v02-journal', 'test-v02-journal-integrity', 'test-v02-source-parts', 'test-v02-claim-lease-budget', 'test-v02-extract-journal', 'test-v02-extract-pending-drain', 'test-v02-capture-journal', 'test-v02-capture-privacy', 'test-v02-recall-races', 'test-v02-shutdown-safety', 'test-v02-shutdown-timeout'],
  continuity: ['test-v02-continuity-schema-v03', 'test-v02-continuity-lineage-binding', 'test-v02-continuity-ancestry', 'test-v02-continuity-projection-v03', 'test-v02-continuity-fence', 'test-v02-continuity-store', 'test-v02-continuity-work', 'test-v02-continuity-worker', 'test-v02-continuity-handoff', 'test-v02-continuity-summary-ledger-owner', 'test-v02-continuity-main-worker', 'test-v02-continuity-main-process-restart', 'test-v02-continuity-host-restart', 'test-v02-continuity-client', 'test-v02-settings', 'test-v02-aux-default-route'],
};
const args = process.argv.slice(2);
if (args.some(name => !Object.hasOwn(groups, name))) {
  console.error(`Usage: node scripts/test-migration-acceptance.mjs [${Object.keys(groups).join('|')}] ...`);
  process.exit(2);
}
const selected = args.length ? [...new Set(args)] : Object.keys(groups);
const gates = [ ['build', ['scripts/typecheck-v02.mjs', '--emit-lib']], ...selected.flatMap(group => groups[group].map(name => [group + '/' + name, ['scripts/' + name + '.mjs']])),
  ...(selected.includes('continuity') ? [['continuity/settings-route-update', ['scripts/test-v02-continuity-main-worker.mjs', '--settings-route-update']]] : []) ];
for (const [, argv] of gates) if (!existsSync(join(root, argv[0]))) {
  console.error(`Required gate does not exist: ${argv[0]}`); process.exit(2);
}
const reportDir = join(root, 'fixtures', 'migration-acceptance');
mkdirSync(reportDir, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
for (const [name, argv] of gates) {
  console.log(`\n=== ${name} ===`);
  const start = Date.now();
  const result = spawnSync(process.execPath, argv, { cwd: root, env: { ...process.env, DSH_RUNTIME_RC2: runtime }, encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  const passed = !result.error && result.signal === null && result.status === 0;
  const record = { name, argv, passed, exitCode: result.status, signal: result.signal, error: result.error?.message ?? null, durationMs: Date.now() - start };
  results.push(record);
  writeFileSync(join(reportDir, name.replaceAll('/', '-') + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  writeFileSync(join(reportDir, 'results.json'), JSON.stringify({ startedAt, runtime, selected, scope: 'isolated-regression-only', results }, null, 2) + '\n');
  console.log(`GATE ${passed ? 'PASS' : 'FAIL'}: ${name}; exit=${result.status}; signal=${result.signal}`);
  if (!passed) { console.error('Stopped at the first failed gate; remaining gates are NOT passed.'); process.exit(1); }
}
console.log(`\n${results.length} isolated regression gates passed. Full browser/Continue/authenticated Host/deployment acceptance is NOT established by this runner.`);
