# Coordinator mounted-browser verification

Used parent-owned managed job bash-1471, fresh synthetic fixture run mounted-ui-1791419643911-59bb17, GUI origin http://127.0.0.1:37771, isolated browser context migration-coordinator-v02. Existing GUI/profile at3082 untouched. Served build289013683e08653bc662fe834c0d4e2d2dfdb873910e30c3ed17f0ddb39cd524, client64ed3265ed33d22c7d6d976d559e4a89ec372c767f8b9ef860365e3c34b71ba8.

Measured independently with actual browser controls/HTTP Gateway:

- Plugin mounts under Evolving Memory; secret password input blank and filesystem-root inputs disabled.
- PageA edits searchLimit to9 without saving. PageB saves7 through exactly one settings/mutate op with expectedRevision0; Gateway returns revision1.
- PageA immediately displays role=alert stale-conflict/rebase choices and retains draft9.
- Explicit stale Gateway mutation (attempt11 at revision0 after revision1) returns result.ok=false, settings/conflict, expected0/actual1. This proves CAS refusal, unlike an overlay-ownership rejection.
- PageA rebase then normal Save retains9, clears conflict, disables Save and displays Saved/applied-without-restart.
- PageA master OFF through normal Save, then Memory tab: all3 seeded active memories remain visible without alerts.

Worker's full interactive CRUD/keyboard/theme ledger remains separate evidence. Logical OperatorPeer is shared across local browser connections; do not claim per-connection identity isolation. Mid-flight business auxiliary cancellation remains an open gate: source business.dryReview did not forward carrier signal; workflow-16 owns genuine Gateway cancellation validation/fix.

Test-runner cleanup review found unsafe raw namespace-local PID signaling BEFORE ownership validation in down. Coordinator removed raw PID signaling, validates canonical fixture ownership and run identity first, refuses unexpected/3082 origins, and refuses removal while server responds. Actual live-down regression exits1 with the expected live-server refusal; server remains available. Originating managed job bash-1471 was stopped via job_kill and collected as killed(SIGTERM). Subsequent down --keep verified the GUI port refuses connections and retained owned evidence. Parent browser pages10/11 were closed. Stale root server.pid (namespace-local3) was read and removed at its verified absolute path without signaling any process. Cross-session worker job1456 is not addressable from parent; original worker test page was disconnected, so parent opened its own managed test server rather than trusting cached DOM.

CDP snapshot file save was denied by its configured roots. No alternative file-writing route was attempted; live in-memory snapshots and read-only DOM summaries provided evidence. No registry/profile installation, external model calls, real credentials, production data, exemptions or skill activation used.
