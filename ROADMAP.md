# Roadmap

Plan status, kept out of [README.md](./README.md) on purpose.

## Shipped

- strict provenance filter + mandatory verbatim evidence (high-signal by default)
- curated baseline separated from contextual recall; injection capped (relevance margin, importance floor, per-turn max)
- additive migration for existing stores; legacy rows quarantined until human-confirmed
- skill synthesis opt-in (`evolve.skillSynthesis.enabled`)
- episode learning Phases 1–6 (capture/redaction, schema v2 assembly, outcome review, isolated operational recall, episode-to-skill synthesis, `/memory episodes` dry-review/purge/forget and `/memory skill-drafts`) behind `episodeLearning.*` — disabled by default
- v0.2 port: strict typecheck, journal/import, continuity lane, durable skill activation (manual only). Now on stock DSH 0.2.1-rc.2 with continuity auth built on the Host's Peer/principal model; no runtime patch. Status: [migration/README.md](./migration/README.md)

## Next

- Re-pin to the DSH 0.2.1 release once it reaches `latest`; run the browser battery against the stock Host.
- Approved live-enablement cutover per [migration/MIGRATION-LIVE-ENABLEMENT.md](./migration/MIGRATION-LIVE-ENABLEMENT.md). Not executed.
- Phase E (learning evidence): gate recorded unmet after nine OpenCode Go runs. Revisit only as a training-evidence redesign.
