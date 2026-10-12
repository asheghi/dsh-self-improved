#!/usr/bin/env node
// Protect the pre-migration user-authored peer changes independently of commits.
// Read-only: no profile, dependency installation, or store access.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const baseline = JSON.parse(readFileSync(new URL('../migration-baseline/user-peer-values.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
assert.equal(baseline.baseCommit, '3a3b1e1');
assert.equal(Object.keys(baseline.peerDependencies).length, 11);
for (const [name, value] of Object.entries(baseline.peerDependencies)) {
  assert.equal(manifest.peerDependencies?.[name], value, `Preexisting user edit changed: ${name}`);
}
assert.equal(Object.hasOwn(baseline.peerDependencies, '@deepseek-ai/dsh-agent-default-model'), false,
  'Migration-added dependency must not be attributed to the original user edits');
console.log('PASS original user peer values and attribution preserved');
