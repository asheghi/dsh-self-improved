# DSH v0.2 migration: status

This folder holds the records for the port of this plugin to the DSH v0.2
runtime line (built on rc.2, now ported to 0.2.1): journal and legacy import,
continuity lane, durable skill activation, and the live-enablement runbook.

## Status

| Area | Status |
| --- | --- |
| Phases A–D | Accepted in isolation, each with its own evidence record. |
| Runtime | Ported to stock DSH `0.2.1-rc.2`. No Host patch. See [the 0.2.1 port](./MIGRATION-DSH-0.2.1-PORT.md). |
| Phase C auth boundary | Passes on the stock 0.2.1 Host using its Peer/principal model. Pre-0.2.1 runtimes fail closed. |
| Phase E real-learning gate | Recorded **unmet** by user decision after nine OpenCode Go runs (v1–v9). No model-generated draft or measured improvement was produced. |
| Live deployment | Not executed. No installed runtime or production profile has been migrated. |

Continuity ships on DSH 0.2.1 or later. It trusts in-process plugins, as DSH
itself does; the trust boundary is recorded in the port record.

## Start here

- [MIGRATION-V0.2.md](./MIGRATION-V0.2.md): the full migration plan.
- [MIGRATION-DSH-0.2.1-PORT.md](./MIGRATION-DSH-0.2.1-PORT.md): port to stock
  DSH 0.2.1, the auth redesign and its evidence.
- [MIGRATION-FINALIZATION.md](./MIGRATION-FINALIZATION.md): rc.2 execution
  checkpoint and the Phase E decision.
- [MIGRATION-LIVE-ENABLEMENT.md](./MIGRATION-LIVE-ENABLEMENT.md): reversible
  live-enablement runbook. Deployment is gated and needs explicit approval.
- [MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md](./MIGRATION-AUTH-HOST-RECEIPT-AUDIT.md):
  rc.2-era Host-auth receipt audit (superseded by the 0.2.1 port).
- [MIGRATION-PHASE-E-REAL-EVALUATION.md](./MIGRATION-PHASE-E-REAL-EVALUATION.md):
  real-provider evaluation record for the learning gate.
- [MIGRATION-PROGRESS.md](./MIGRATION-PROGRESS.md): long historical round log.
  Read it for detail, not as a summary.

## Other files

The remaining `MIGRATION-*.md`, `MIGRATION-*.json` and `TAKEOVER-*.md` files are
per-phase evidence records. Each one names the commands run, the results, and
the review findings for one slice of the work.
