# Phase C increment1 — pure structural continuity projection

## Implementation boundary

[src/continuity-projection-v02.ts](src/continuity-projection-v02.ts) adds a pure immutable JSON fold compatible with the inspected native ProjectionDefinition init/apply shape. This module is NOT yet registered in the running plugin. No provider call, persistence job, Continue action, goal resume, handoff injection, or UI destination is added by this increment.

The fold tracks only owned source coordinates, last eligible human input, native turn-end state, pending native tool-call hashes/coordinates and recent exact-paired executions. It stores no human message body, tool name/arguments/result body or verbatim call id. Hashing call ids permits deterministic matching without retaining potentially credential-shaped identifiers. User-kind delegated briefs and snapshot/recall injections never become human intent. Inherited prefixes and replayed coordinates do not inflate progress.

Pending calls are bounded32, recent executions16. Overflow and malformed pairing set a sticky coverageIncomplete marker, so bounded omission never becomes a false complete-confidence report. Returned/failed tool execution is ALWAYS verified:false. Native turn/end completed means only a structural turn ended; there is no taskCompleted field or task-success inference. Unknown/new turn-end kinds preserve uncertainty. Pending external actions survive interrupted/error/forked/completed boundaries; nothing automatically repeats them.

## Verification

Guarded strict rc.2 compile/emit bash-2461 PASS; initial new suite passed11cases then genuinely failed the native integration fixture because it incorrectly imported createUserMessage from dsh-session. Verified the existing adapter imports it from dsh-llm and repaired only the test import. Subsequent12cases PASS, original user peer values/attribution PASS, whitespace clean.

Final bash-2464 exit0: guarded strict compile/emit, all12cases PASS, whitespace clean. [Test suite](scripts/test-v02-continuity-projection.mjs) covers seq0, inherited prefix, delegation/header authority, coordinator/unknown/injected user sources (including kind:user with snapshot/recall form), exact call/result/source id matching, native errors, all turn-end kinds, unknown-kind fallback, both capacity bounds, replay/duplicate calls, frozen-input immutability, deterministic JSON/no credential-shaped bodies or ids, and an actual installed rc.2 Session append/ownEvents fold from seq0 through an interrupted turn with pending external action.

Independent scoped read-only review PASS: no material uncertainty/authority/fork/privacy/boundedness blocker in this helper; exact call-id pairing matches native contract and bounded omission stays uncertain. Review warns empty own-only pending calls cannot prove the inherited parent had no unresolved external action; future explicit fork continuation must consult canonical/parent sources. No Phase C acceptance is inferred.

No external provider/profile/runtime write or live-GUI mutation occurred. Native Session integration is in-memory, not a mounted continuity registration/restore/checkpoint acceptance test. Phase B accepted archive is unchanged. Phase C remains OPEN.

## Next implementation and gates

Use the [inspected native projection contract](migration-baseline/rc2-session-projection-contract.md) for effect-owned typed registration and versioned JSON stateSchema. Read current manifest before adding required tested SDK peer(s). A runtime source cut uses the native snapshot/checkpoint watermark, not lastOwnSeq (which is merely the last structurally relevant owned event and can trail ignored native events).

Outside the pure fold, durable turn-end and explicit Pause/Finish should enqueue/deduplicate continuity jobs on a separate lane. Provider summaries consume only bounded minimized native source cuts; auxiliary transport stays detached from native raw-log extensions. Human summaries cannot upgrade uncertain external actions into verified success or permission. Native history/goals remain authority; no invented Session.append event types.

Add same-project unfinished-work browsing and explicit selected Continue; unrelated projects invisible, delegated/fork evidence not independent support, generic continue does not trigger broad personal recall. Explicit continuation may orient from selected related parent context but must not repeat potentially completed external actions, wake abandoned tasks or re-arm goals without native human authorization.

Complete Overview/Memories/Sessions, evidence inspector and privacy/Advanced controls in typed maintainable Client modules on existing native slots. Keyboard/narrow/light-dark/save-conflict/unsaved-draft/destructive-action mounted browser gates are still pending. Current GUI/profile remains untouched until an approved isolated verification path; installing into the user's active profile or starting a replacement GUI is not authorized.
