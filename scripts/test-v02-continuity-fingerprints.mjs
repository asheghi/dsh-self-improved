#!/usr/bin/env node
// Trusted native JSON encoding only; not an authenticator for arbitrary objects.
import assert from 'node:assert/strict';
import { continuityCanonicalDigest as digest, continuityCanonicalHeader as header } from '../lib/continuity-checkpoint-v02.js';
let n = 0;
const check = (name, fn) => { fn(); console.log('PASS ' + name); n++; };
check('native object key order is irrelevant recursively but array order and values remain bound', () => {
  assert.equal(digest({ b: [{ y: 2, x: 1 }], a: true }), digest({ a: true, b: [{ x: 1, y: 2 }] }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest({ n: 0 }), digest({ n: '0' }));
  assert.notEqual(digest({ a: null }), digest({}));
});
check('only absent native depth normalizes, without mutating original header', () => {
  const original = { id: 'synthetic', cwd: '/synthetic/project', createdAt: 1, version: 4 };
  const normalized = header(original);
  assert.equal(Object.hasOwn(original, 'delegationDepth'), false);
  assert.equal(normalized.delegationDepth, 0);
  assert.equal(digest(normalized), digest(header({ ...original, delegationDepth: 0 })));
  for (const depth of [1, -1, null, '0', undefined]) {
    const explicit = { ...original, delegationDepth: depth };
    assert.equal(header(explicit), explicit);
    assert.notEqual(digest(header(explicit)), digest(normalized));
  }
});
check('all immutable ownership fields remain fingerprinted', () => {
  const original = header({ id: 'synthetic', cwd: '/synthetic/project', createdAt: 1, version: 4 });
  for (const [key, value] of Object.entries({ id: 'other', cwd: '/other', createdAt: 2, version: 5,
    parentSession: 'ancestor', origin: 'subagent', isSeeded: true })) {
    assert.notEqual(digest(original), digest(header({ ...original, [key]: value })), key);
  }
});
console.log(`${n} PASS / 0 FAIL; trusted JSON fingerprint semantics only, no source/permission admission`);
