# DSH v0.2 migration: status

This folder holds the records for the port of DSH to the rc.2 runtime
(DeepSeek harness v0.2): journal and legacy import, continuity lane, durable
skill activation, and the live-enablement runbook.

## Status

| Area | Status |
| --- | --- |
| Phases A–D | Accepted in isolation, each with its own evidence record. |
| Phase C auth boundary | Passes only on a privately staged Host-authenticated runtime. Stock rc.2 runs with continuity disabled and fail-closed. |
| Phase E real-learning gate | Recorded **unmet** by user decision after nine OpenCode Go runs (v1–v9). No model-generated draft or measured improvement was produced. |
| Live deployment | Not executed. No installed runtime or production profile has been migrated. |

How continuity ships is still open: either upstream Host-authenticated admission
lands in DSH, or memory-only is released with continuity disabled. Enabling it on
a stock runtime is not supported.

## Start here

- [MIGRATION-V0.2.md](./MIGRATION-V0.2.md): the full migration plan.
- [MIGRATION-FINALIZATION.md](./MIGRATION-FINALIZATION.md): current execution
  checkpoint and the Phase E decision.
- [MIGRATION-LIVE-ENABLEMENT.md](./MIGRATION-LIVE-ENABLEMENT.md): reversible
  live-enablement runbook. Deployment is gated and needs explicit approval.
- [MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md](./MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md):
  Host-auth receipt audit behind the Phase C boundary.
- [MIGRATION-PHASE-E-REAL-EVALUATION.md](./MIGRATION-PHASE-E-REAL-EVALUATION.md):
  real-provider evaluation record for the learning gate.
- [MIGRATION-PROGRESS.md](./MIGRATION-PROGRESS.md): long historical round log.
  Read it for detail, not as a summary.

## Other files

The remaining `MIGRATION-*.md`, `MIGRATION-*.json` and `TAKEOVER-*.md` files are
per-phase evidence records. Each one names the commands run, the results, and
the review findings for one slice of the work.
