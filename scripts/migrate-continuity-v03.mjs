#!/usr/bin/env node
// Authorized offline-only v2→v3 launcher. Never called by plugin startup.
import { lstatSync, realpathSync, statSync } from 'node:fs';
import {
  consumeContinuityV03OfflineAuthorization,
  runContinuityV03OfflineMigration,
  validateContinuityV03OfflineStoreTarget,
} from '../lib/continuity-offline-migrator-v03.js';

const args = process.argv.slice(2);
const parsed = consumeContinuityV03OfflineAuthorization(args);
if (parsed.kind !== 'authorized') {
  console.error(`Refused: ${parsed.reason}`);
  process.exitCode = 2;
} else {
  try {
    const target = validateContinuityV03OfflineStoreTarget(parsed.authorization.storeRoot, {
      realpath: path => realpathSync(path),
      stat: path => statSync(path),
      lstat: path => lstatSync(path),
    });
    if (target.kind !== 'valid-target') {
      console.error(`Refused: ${target.reason}`);
      process.exitCode = 2;
    } else {
      // This is the first app import capable of constructing a store, and it is
      // reachable only after authorization and filesystem-target checks pass.
      const [{ MemoryStore }, z] = await Promise.all([import('../lib/storage.js'), import('zod')]);
      const result = runContinuityV03OfflineMigration(parsed.authorization, () => new MemoryStore(target.storeRoot), z);
      if (result.kind === 'migrated-v2') {
        console.log(`Migrated v2 continuity to v3; archive=${result.archiveState}; policies=${result.counts.policies}; jobs=${result.counts.jobs}; handoffs=${result.counts.handoffs}; summary-ledgers-validated=${result.summaryLedgersValidated}`);
      } else if (result.kind === 'already-v3') {
        console.log(`No-op: exact v3 schema already present; origin=${result.origin}; archive=${result.legacyArchiveState}; summary-ledgers-validated=${result.summaryLedgersValidated}`);
      } else {
        console.error(`Refused: ${result.reason}`);
        process.exitCode = 2;
      }
    }
  } catch {
    console.error('Offline migrator failed. Inspect the v3 marker and archive state before retrying.');
    process.exitCode = 1;
  }
}
