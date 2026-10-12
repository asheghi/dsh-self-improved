# MIGRATION-PHASE-B-RECALL.md — redact short-labeled-credential recall fix

Owner: delegated Phase B recall lane. Scope honored: `src/redact.ts` +
`scripts/test-v02-minimization.mjs` (+ one justified one-line expectation
correction in `scripts/test-redact.mjs`, see §3). No edits to capture/index,
journal/storage/extract/inject/business/client/manifest or Git state. All data
in this lane is synthetic; no profile, provider, network, or production store
was touched.

## 1. Defect

Explicit labeled credentials with short values persisted: `token: ab`,
`pwd=xy`, `password=x`, `pin=1`, short quoted JSON secrets, short
header/env/URI-auth values. The free-text patterns set a 4-char floor on *all*
labeled forms, so any credential ≤3 chars passed the redactor.

## 2. Fix (`src/redact.ts` only)

- **Labeled forms now have value length floor 0** (`VALUE_ANY = "[^\\s,]+"`):
  `token=…`, `password=…`, `passwd=…`, `pwd=…`, `api[_-]?key=…`, `secret=…`,
  `authorization:…`, `cookie:…`, the generic `label[:=]value` rule, the
  Phase-B extended header/env vocabulary (`X-Api-Key:`, `client_secret=`,
  `Set-Cookie:`, `DB_PWD=`, `pin=`, `authkey=`, …), the quoted-label value
  (`"password": "x"`), and URI userinfo on every scheme (`postgres://u:p@`).
- **New labels**: `pin`/`pincode`, `auth`/`authkey` in the sep-form label run
  and in the key-based lists. `pin` is deliberately **not** a substring/ends-
  with key hint: `pinned`/`spinning`/`unpin`/`pin-slot` keys are never redacted;
  only the exact keys `pin`, `pincode`, `authkey` are sensitive.
- **Unlabeled forms keep their floors** (unchanged): `Bearer <value>`,
  `Basic <base64 run>` — "bearer"/"basic" are ordinary English words; the floors
  limit destruction of benign prose. Labeled short secrets do not travel
  through those shapes anyway.

## 3. Changed-expectations justification

Prior agents (18/20) reported these canaries as passing with `null` results —
the superseding recall directive makes the old "short labeled value untouched"
expectations wrong. Two expectation changes, both forced by the directive and
both documented in-suite:

1. `scripts/test-redact.mjs`: `labeled short value untouched` →
   `labeled short value redacted` (`token: ab` → `[REDACTED]`).
2. `scripts/test-v02-minimization.mjs` §8: `token: ab\npwd=xy` now expected
   `[REDACTED]\n[REDACTED]`; benign-word scenes unchanged.

Everything else in both suites kept its previous expectation.

## 4. Helper contract (actual, as consumed by capture/extractor)

- **`redactFreeText(text) -> string`**: sequential global pattern replaces; ids
  `[REDACTED]`, private keys `[REDACTED-PRIVATE-KEY]`, URI userinfo keeps the
  scheme+`[REDACTED]@` while dropping the rest.
- **`redactObject(value) -> unknown`**: deep walk; sensitive-key values (any
  length) are **replaced, not dropped** (`[REDACTED]`), benign keys/shapes
  preserved; string leaves still get pattern redaction; cycles `[CYCLIC]`;
  no input mutation.
- **`redactJsonString(raw) -> string`**: parse → object redaction; parse-fail →
  free text; primitive-string result → free text on that string.
- **`redactAndBoundArguments(raw, maxChars)` / `redactAndBoundResult(text,
  maxChars)` / `redactAndBoundMetadata(value, maxChars)` -> `{text,
  truncated}`**: always **redact before bound**; `truncated:false` iff no
  slice; `maxChars` is the final defense against pattern misses.

Wiring status — **verified by executed suites**, not by reading:
- `capture` message lanes now run content through the helpers
  (`installCapture` → `appendConversationSlice` persistence boundary checked by
  `scripts/test-v02-capture-privacy.mjs`, which executes real persisted records).
- **Helpers passing here does NOT mean all persistent/provider writes are
  wired.** Not proven by any suite in this lane: provider-side episode
  delivery, export/backup writers, review payloads, debug logging, and any
  future stores. Every such writer must call
  `redactObject`/`redactJsonString`/`redactAndBoundMetadata`/`boundText`
  composition itself; the redactor cannot enforce callers.

## 5. Known limitations (declared)

1. Pattern redaction is deny-list shaped: unlabelled hex/base64 secrets and
   unknown token vocabularies can persist inside prose; `maxChars` bounding is
   the residual mitigation.
2. Value runs may consume a single trailing quote/backtick when a header/env
   assignment appears quoted inside prose (pre-existing shape; the closing
   quote of the assignment is dropped). Secrets never survive; only the
   character is lost. Documented in-suite on the `X-Api-Key: ab` scene.
3. Label-adjacent prose with separators may be over-redacted — the required
   1-char floor makes forms like `auth: something-long descriptive phrase`
   consume to the next comma/space. This is the intended
   recall/privacy trade of the directive.
4. Unlabeled `Bearer`/`Basic` short values are not redacted (English-word risk).
5. No catch-all: ordinary `sha512`-style hex, clocks, `tokenizer=on`,
   `pinned`, hashing, `opinion:` etc. are kept — see the endurance scenes that
   must continue passing.

## 6. Executed results (this lane, current build)

| Suite (executed check count) | Result |
| --- | --- |
| `scripts/test-redact.mjs` (65 checks) | all PASS (1 expectation updated) |
| `scripts/test-v02-minimization.mjs` (70 checks incl. new adversarial) | all PASS |
| `scripts/test-v02-recall-races.mjs` — the 23 recall-race checks | **rerun this session: STRICT 23 PASS / 0 FAIL, 0 XFAIL/XPASS** |
| `scripts/test-v02-capture-privacy.mjs` (persistence boundary) | PASS at final rerun (was 0/3 FAIL earlier this session before the concurrent journal/capture wiring landed; I did not edit capture) |
| `scripts/test-v02-safety.mjs` (60 checks) | 59/60, 1 FAIL — verified **unrelated to this lane** (same failure with HEAD `redact.ts`; caused by the concurrently-active workflow-23 journal/capture wiring) |
| `scripts/test-recall.mjs`, `scripts/test-extract.mjs` | ALL PASS |
| `node scripts/typecheck-v02.mjs` (strict rc.2 contracts) | PASSED at lane snapshot; one transient FAILED observed inside the stash-bisect window while workflow-23 was mid-edit on `src/capture.ts` (e.g. `JournalClaim` unknown assignment) — attributed to that lane |

Suites NOT run in this lane are not summarized; no run, no claim.
