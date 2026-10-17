# Roadmap

Plan status, kept out of [README.md](./README.md) on purpose.

## Shipped

- strict provenance filter + mandatory verbatim evidence (high-signal by default)
- curated baseline separated from contextual recall; injection capped (relevance margin, importance floor, per-turn max)
- additive migration for existing stores; legacy rows quarantined until human-confirmed
- skill synthesis opt-in (`evolve.skillSynthesis.enabled`)
- episode learning Phases 1–6 (capture/redaction, schema v2 assembly, outcome review, isolated operational recall, episode-to-skill synthesis, `/memory episodes` dry-review/purge/forget and `/memory skill-drafts`) behind `episodeLearning.*` — disabled by default
- v0.2 port on the rc.2 runtime: strict typecheck, journal/import, continuity lane fail-closed behind Host auth, durable skill activation; manual only. Status: [migration/README.md](./migration/README.md)

## Next

- Decide how continuity ships: upstream Host-authenticated admission into DSH, or release memory-only with continuity disabled.
- Approved live-enablement cutover per [migration/MIGRATION-LIVE-ENABLEMENT.md](./migration/MIGRATION-LIVE-ENABLEMENT.md). Not executed.
- Phase E (learning evidence): gate recorded unmet after nine OpenCode Go runs. Revisit only as a training-evidence redesign.
