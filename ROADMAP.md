# Roadmap

Plan status, kept out of [README.md](./README.md) on purpose.

## Shipped

- strict provenance filter + mandatory verbatim evidence (high-signal by default)
- curated baseline separated from contextual recall; injection capped (relevance margin, importance floor, per-turn max)
- additive migration for existing stores; legacy rows quarantined until human-confirmed
- skill synthesis opt-in (`evolve.skillSynthesis.enabled`)
- episode learning Phases 1–6 (capture/redaction, schema v2 assembly, outcome review, isolated operational recall, episode-to-skill synthesis, `/memory episodes` dry-review/purge/forget and `/memory skill-drafts`) behind `episodeLearning.*` — disabled by default
- v0.2 port: strict typecheck, journal/import, continuity lane, durable skill activation (manual only). Runs on stock DSH 0.2.1 with continuity auth built on the Host's Peer/principal model; no runtime patch. Redesigned settings page (Overview, Sessions, Settings, Memory). Packaged as `@asheghi/dsh-self-improved`. Status: [migration/README.md](./migration/README.md)

## Next

- Publish `@asheghi/dsh-self-improved` 0.2.1 to npm.
- Test opening a DSH 0.1 memory store with 0.2.1, and document the upgrade path for existing users.
- When DSH 0.2.1 reaches `latest`, rebuild against the release and confirm the caret peer ranges still resolve.
- Phase E (learning evidence): gate recorded unmet after nine OpenCode Go runs. Revisit only as a training-evidence redesign.
