# Phase D isolated acceptance — operational learning

## Decision

**ACCEPTED for the isolated implementation boundary**, on the evidence below, with the boundaries in the last section stated as limits rather than waived gates. Phase A and B remain accepted in isolation; Phase C is evidenced except for the browser-only battery; **Phase E is unaccepted** and its activation/evaluation work does not follow from this document.

This is not a rollout decision: no production store was read or migrated, no profile or GUI was changed, no learned skill can be activated (there is no activation path), and no improvement claim is made.

## Scope accepted

Flat tool-result normalization, opt-in redaction before persistence, exact call pairing, verification-aware outcome labels, project/environment grouping, evidence review, expiry, purge propagation, and the bounded worker execution those depend on.

## Gate item → evidence

Every check below is a named assertion in a suite that passes in this repository against the pinned rc.2 contracts. Names are quoted exactly so the mapping can be re-verified rather than trusted.

**1. Fabricated output cannot become a user preference.**
Reviewed rows can only be derived: `1: provenance derived`, `1: source episode-review`, `1: scope project + projectId`. Non-generalizing or padded content is dropped: `16: verbatim-copy memory dropped, normal kept`, `18: >5-unique dropped, 5 kept, empty dropped`, `17: JSON + prose credentials dropped, benign kept`. Model citations cannot be padded into support: `5n: duplicate citations cannot be padded into a quorum`, `5n: none-valid citations cannot be padded into a quorum`, `5n: one-valid citations cannot be padded into a quorum`, `5d: partial citation + new episode → 1 new skill`.

**2. Interrupted, forked or unknown outcomes never become successes.**
`interrupted turn → ambiguous`, `late evidence → ambiguous + late-evidence`, `malformed result → ambiguous`, `duplicate callId → ambiguous`, `completed pairs but aborted reasonKind → ambiguous`, `blocked reasonKind → ambiguous`, `classify: unpaired → ambiguous`, `classify: empty steps → ambiguous`, `delegated session flags episode`.

**3. Provider text cannot grant permissions.**
No surface consumes model text as policy, and that is now a negative test rather than a claim: `30: provider text can only produce derived review-sourced rows`, `30: no row gains human/user authority from provider text`, `30: authority-looking fields are never persisted with a row`, `30: the review result exposes no grant surface`, `30: the reviewer parser drops unknown per-memory authority fields`, `30: the reviewer parser drops unknown top-level authority fields`. The last two are key-based, not substring-based, because prose containing the word "grant" is legitimately stored as inert data. Limit: this proves the plugin's own surfaces, not a global statement about model output anywhere in the harness.

**4. The independent quorum cannot be satisfied by forks, replays or unrelated projects.**
`5q: fork child is not an independent support source`, `5q: parent and forked child share a fingerprint`, `5p: cross-project episodes cannot satisfy one support quorum`, `5r: repeated turns from one session cannot form a quorum`, `5s: two cited turns from one session cannot fake independent support`, `direct replay idempotent`, `5t: delegated lineage is durable and unknown legacy state fails closed`, `5t: restart assembly preserves delegated status`.

**5. Consent cancellation and purge block late commits.**
`23: late model result cannot commit after revocation`, `23: queued cancellation leaves episode untouched`, `23: queued pass checks cancellation after acquiring the review lock`, `23: LLM receives the revocable signal`, `a pre-forget claim over another coordinate cannot publish the same forgotten fact late`, and on the purge lane `purge counts correct`, `purge emptied project`, `purge prep rows exist`, `unit/purge policy: cancellation triggers first with a bounded reason; an unguarded purge fails closed`.

**6. Source and lesson lineage remain inspectable.**
`5u: draft retains project and episode citations`, `5t: delegated lineage is durable and unknown legacy state fails closed`, `10: prompt has delegated fact`, journal-side lineage (`journal_derived rows exist for the derived memories (job↔memory support graph)`, `round3/forget lineage: the exact M3 is forgotten and its support spent without closing its session`). Prompt-side inspection stays bounded: `10: prompt lacks raw callId`, `10: prompt uses opaque alias`, `10: prompt has session label`.

## Suite results (this acceptance run)

| Suite | Result |
| --- | --- |
| `test-episodes` | ALL PASS |
| `test-episode-review` | ALL PASS (including the new section 30) |
| `test-episode-rollout` | PASS |
| `test-evolve` | ALL PASS |
| `test-v02-fact-policy` | 8 checks passed |
| `test-v02-revocation` | PASS |
| `test-v02-minimization` | PASS (canaries) |
| `test-v02-policy-lane` | PASS (35 gates) |
| `test-audit-skills` | ALL PASS |

## Boundaries (limits, not waivers)

- **No production data.** Every fixture is synthetic or temporary; nothing was read from, written to, or migrated into a real store, profile or GUI.
- **No browser acceptance.** These are in-process suites. Interaction-level checks (keyboard, layout, theme, destructive confirmation) remain open and belong to the browser battery.
- **No skill activation, by construction.** Drafts live in SQLite; the runtime no longer calls the legacy active-skill writers; there is no evaluation fixture, no activation and no rollback path yet. That is Phase E.
- **Project-scoped skill publication stays open.** rc.2 merges global skills into workspace views, so publishing a learned skill safely is unresolved and is not claimed here.
- **No held-out improvement measurement.** Nothing in this document asserts that learning improves task outcomes; that measurement is the Phase E gate.
- **Expiry and retention are bounded by the store's own policy**, and derived rows stay review-required and ineligible for injection regardless of these results.
