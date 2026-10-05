# Roadmap

Plan status, kept out of [README.md](./README.md) on purpose.

## Shipped

- strict provenance filter + mandatory verbatim evidence (high-signal by default)
- curated baseline separated from contextual recall; injection capped (relevance margin, importance floor, per-turn max)
- additive migration for existing stores; legacy rows quarantined until human-confirmed
- skill synthesis opt-in (`evolve.skillSynthesis.enabled`)
- episode learning Phases 1–5 (capture/redaction, schema v2 assembly, outcome review, isolated operational recall, episode-to-skill synthesis) behind `episodeLearning.*` — disabled by default

## Next

- Phase 6: episode commands + browser controls (counts, evidence inspector, dry-review, forget, purge, first-enable privacy warning)
- Phase 7: rollout — real-session validation, on-disk redaction check, README behavior/privacy notes
