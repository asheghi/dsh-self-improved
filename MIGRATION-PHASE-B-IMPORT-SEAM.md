# MIGRATION-PHASE-B-IMPORT-SEAM.md — tx-only lossless import row-set seam in storage.ts (implemented, real-SQLite-tested)

Status: **implemented and adversarially verified.** This increment resolves the
"Blocked dependency" in [MIGRATION-PHASE-B-IMPORT-DESIGN.md](<MIGRATION-PHASE-B-IMPORT-DESIGN.md>) §11:
a storage-only transaction seam that the future Phase B importer (owned by a
different increment) will use to write preserved rows without bypassing
FTS/seq/revision invariants. **The importer itself, the backup lane, any
reader, any CLI, ledger file or receipt writer is NOT implemented and NOT
claimed here.**

## 1. Exact file ownership

| file | change |
|---|---|
| [src/storage.ts](<src/storage.ts>) | + `importMemoryInTx` seam (:717–784), `writeMemoryRowSet` shared row-set writer extracted from `insertMemoryImpl` (:665–687), `assertImportShape` (:787–819), exported `MemoryImportCollisionError` (:167–175), import-vocabulary guards (:155–159) — five additions and one behavior-preserving extraction, nothing else. `insertMemory`/`insertMemoryInTx`/journal/episode/delete/status paths are semantically unchanged. |
| [scripts/test-v02-import-seam.mjs](<scripts/test-v02-import-seam.mjs>) | new focused synthetic suite (46 assertions, real SQLite, real child-process SIGKILL). |
| [fixtures/v02-import-seam/worker-import.mjs](<fixtures/v02-import-seam/worker-import.mjs>) | new SIGKILL-boundary crash worker (parent suite reopens and asserts cross-process). |
| [lib/storage.js](<lib/storage)) | refreshed build artifact via isolated strict compile (see §6). |

`src/extract-journal-v02.ts`, `src/capture.ts`, `src/index.ts`,
`src/memory-journal-v02.ts` (Workflow27/23 files), all fixtures under
`v02-journal`/`v02-migration`, manifests, Git state, profiles: untouched.

## 2. Exact API

```ts
// collides → throws MemoryImportCollisionError (memoryId + exact disposition);
// outside tx / illegal shape → plain Error; both refuse before the first write
importMemoryInTx(input: {
  id: string;                 // preserved stable id, carried verbatim, never minted
  kind: MemoryKind;           // validated vocabulary
  content: string;
  createdAt: number;          // preserved source timestamp (non-negative integer)
  updatedAt: number;          // preserved source timestamp (non-negative integer)
  importance?: number;        // 1..10 clamp shared with insertMemory (default 5)
  status?: MemoryStatus;      // preserved verbatim; omitted = 'active' (persona policy below)
  supersedes?: string;        // preserved verbatim
}, meta: MemoryMetaInput = {}): MemoryRecord   // returned record = persisted row + meta
```

## 3. Enforced contracts (each proven by a real run, §5)

- **Tx-only.** Refuses outside `runInImmediateTransaction` (or an equivalent
  open immediate transaction on the store's single connection: journal-style
  nesting / `explicitTxDepth` both admitted via `isInsideTransaction()`). The
  seam never opens, commits, or rolls back a transaction of its own — row +
  `memories_seq` + FTS + meta + revision + any same-tx importer ledger row all
  ride the caller's one `COMMIT`/`ROLLBACK`.
- **Collision = reject, never overwrite, never dedup.** A pre-existing
  `memories` row for the id refuses (`MemoryImportCollisionError`) —
  **byte-identical duplicates included** (§5 of the design: re-running a plan
  is a refusal, not an absorb). An orphaned `memories_meta`/`memories_seq`
  entry (pre-transactional debris) refuses with its table named. All collision
  checks run before the first write, so a refusal consumes nothing: no seq,
  no revision delta, no partial row.
- **Preserved identity.** id/`createdAt`/`updatedAt`/`status`/`supersedes` and
  every carried meta field are written verbatim; nothing on the mint path runs
  except `nextMemSeq()` (target seq, strictly increasing, mapping written by
  the caller). Roundtrip-verified for ids with odd digits and 13-digit
  millisecond timestamps.
- **No automatic trusted/legacy/human provenance.** Omitted provenance stays
  fail-closed `'unknown'`; the import lane never takes the `insertMemoryImpl`
  trusted shortcut (`source` defaults to `'legacy'`, never `'user-direct'`;
  confidence defaults to the untrusted `0.3`, never `0.6`). There is no
  approval/activation field this seam can set: the only routes that give a
  row recall authority are the existing explicit user paths
  (`setMemoryStatus`: a `quarantined` persona row becomes `active` only there).
- **Persona policy.** An imported `provenance:'persona'` row requesting
  `'active'` is **demoted to `status:'quarantined'`** (row preserved,
  unindexed, not injectable; returned record + countable ledger material shows
  the effective status). Carried provenance is otherwise preserved verbatim
  (neither widened nor stripped); `derived` imports stay off the injectable
  lane by the existing recall policy, with no seam demotion.
- **FTS mirrors status.** Only effective-status `active` rows enter
  `memories_fts` — identical to `setMemoryStatus`/`rebuildFts` semantics —
  so no unindexed-at-preview row can leak into `searchMemories` (which facts
  on `status='active'` anyway) and no stale index needs repair cleanup.
- **Revision: one bump per imported row, in the same tx.** Reason string
  `'import'`; measured deltas: N rows in one chunk ⇒ revision advanced by
  exactly N inside the transaction and persisted after commit/reopen; a
  collided or failed chunk advances it by zero.
- **Rollback leaks nothing.** Real SIGKILL mid-chunk (inside the writes, after
  the same-tx ledger row, before `COMMIT`) plus in-process exception rollback:
  zero `memories`/`memories_meta`/`memories_fts`/`memories_seq` rows, zero
  revision and zero ledger row for the rolled-back chunk; post-commit SIGKILL
  (WAL durability) leaves both row-sets AND the ledger row durable with
  revision = N. The seq watermark never reuses values across a rollback
  (strict increase holds; gaps after rollback are legal and cross-process
  recovery re-derives from `MAX(seq)`).

## 4. Targeted refactor (behavior-preserving, single choke point)

The row-set write block previously inside `insertMemoryImpl` moved verbatim to
`writeMemoryRowSet(record, meta, revisionReason)` with one structural change:
FTS insert is now gated on `record.status === 'active'` — a no-op for the
`insertMemory`/`insertMemoryInTx` path (they always write `'active'`) and the
required behavior for imported non-active rows. `insertMemoryImpl` keeps its
exact fail-closed defaults (`unknown`/`legacy`/0.3), its exact 0.6
asserted-provenance shortcut, and reason `'insert'`. Regression suites below
prove the old paths are unchanged.

## 5. Verification evidence (real runs, this session)

| suite | result |
|---|---|
| `node scripts/test-v02-import-seam.mjs` (new) | **46 passed, 0 failed** — tx refusal + nested use; verbatim id/timestamps/scope/supersedes/meta roundtrip incl. evidence JSON and `expiresAt`; FTS+injectableOnly recall of an active user-provenance import; conflicting AND byte-identical duplicate refused, no overwrite; orphan-meta refusal; exactly-one-bump-per-call measured inside the tx, delta N per committed chunk, reason `'import'`, persisted across reopen; unknown/'legacy'-source/0.3 defaults; no injectable widening; persona `'active'`→`'quarantined'` demotion + explicit-only reactivation; carried provenance preserved verbatim; 7 illegal shapes refused with zero rows/zero revision; in-process exception rollback leaks nothing; **real child SIGKILL at `mid` and `post` boundaries**: `signal=SIGKILL`, reopened fresh store shows (mid) zero rows/orphans, revision 0, no `import:test:ledger` key, clean resume yields seq 1 / revision 1; (post) 2 rows + ledger row durable, revision 2, timestamps/`provenance:'user'` recallable. |
| `node scripts/test-storage.mjs` (old storage regressions) | **47 passed, 0 failed** (insert/FTS/list syndrome incl. fail-closed provenance defaults of the unchanged paths). |
| `node scripts/test-recall.mjs` | **54 passed, 0 failed.** |
| `node scripts/test-v02-journal.mjs` (26 checks, real SQLite + real SIGKILL, exercises `insertMemoryInTx` through the extracted writer) | **26/26 passed.** |
| `node scripts/test-migration-v02.mjs` (storage consumer) | **44 passed, 0 failed.** |

## 6. Build gate — exact honest state

- `npx tsc --strict … --outDir lib src/storage.ts` (project flags): **OK**, clean
  emission (storage.ts imports only external modules, so this is a complete
  strict compile of the increment).
- Repository strict gate `node scripts/typecheck-v02.mjs`: **FAILED on
  11 pre-existing errors, all in `src/extract-journal-v02.ts`** (Workflow27's
  in-flight file — nothing referencing `src/storage.ts`). This failure exists
  without my change; storage.ts is variance-free in the gate output, and the
  `lib/` artifact for storage is freshly compiled. The full-gate pass therefore
  waits on Workflow27's file, not on this increment.

## 7. Deliberate deviations / notes for the importer author

1. **`meta & { seqNote? }` from the design sketch was NOT added** — there is no
   storage schema field for a per-row note and adding an unreachable field
   would be dishonest. The importer's `legacySeq → targetSeq` map is written by
   the caller from the returned record + `memories_seq` (same data, no fake
   API surface).
2. **Revision bumps once per row, including non-active-status imports**
   (`quarantined`/`migrated` etc.). The revision's own contract lists "memory
   insert" as recall-affecting categorically, over-bumping is monotonic-safe,
   and per-row identity keeps the importer's chunk accounting reconcilable.
   Extra bumps never materialize for failed/collided chunks.
3. **`MemoryMeta.legacy === true` read-back for imported rows carrying
   `source:'legacy'`** is the pre-existing `readMeta` derivation
   (`legacy: row.source === 'legacy'`, storage.ts) — a lineage label computed
   at read time, never a stored or trusted field, and identical for the
   v1-backfilled rows the store already serves. Nothing changed.
4. **Credential-shaped content demotion is NOT in the seam**: per the design §4
   table that scan + ledger reason belongs to the importer; the seam preserves
   what it is told, fails closed on omissions, and never merges or upgrades.
5. **Empty vs seeded targets**: synthetic targets are refused on ANY
   pre-existing id (§3 above) but data-row-free orphan debris also refuses —
  `repairConsistency()` is the sanctioned cleanup for debris targets, and it
   only runs on construction.

## 8. Not claimed here

No importer, no `plan.json`/`ledger.json`/`receipt.json` writer, no backup
lane, no reader or recall change, no journal/extraction/capture/index edit, no
CLI, no conversation backlog handling, no settings write, no skill/persona
activation, no live or production store, no profile, no provider or network
call, no Git operation, no data on this machine's real DSH memory. The 46
assertions ran only against synthetic temp trees under `/tmp`.
