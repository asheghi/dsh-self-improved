# Roadmap

Plan status, kept out of [README.md](./README.md) on purpose.

## Shipped

- strict provenance filter + mandatory verbatim evidence (high-signal by default)
- curated baseline separated from contextual recall; injection capped (relevance margin, importance floor, per-turn max)
- additive migration for existing stores; legacy rows quarantined until human-confirmed
- skill synthesis opt-in (`evolve.skillSynthesis.enabled`)

## Next

- Episode learning: capture failure-retry-success episodes and distill them into skills. Not built yet; synthesis currently distills accumulated memories only, and extraction rejects work logs.
