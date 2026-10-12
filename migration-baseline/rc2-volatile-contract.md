# rc.2 volatile-reference contract evidence

Read installed @deepseek-ai/cosmokit/lib/types/volatile.d.ts. Cordis exports the Volatile/VolatileSnapshot types from cosmokit.

Public reference contract: `Volatile<T>.get(): VolatileSnapshot<T>` (recursively readonly current snapshot). Public helpers `createVolatile<T>(value:T):Volatile<T>` and `isVolatile(value:unknown):value is Volatile<unknown>`. The latter explicitly supports identification across ESM/CJS library copies; prefer it over enumerable-own-key heuristics.

`volatileEntries` and `updateVolatile` are documented INTERNAL owning-runtime utilities. Consumers must not mutate stable references directly to bypass Settings revisions or Loader validation.

Live Event inspection for loader/volatile-update returned no catalogued event. Exact-literal search in installed Cordis JavaScript also found no volatile-update/updateVolatile emissions. These observations do NOT prove Loader has no volatile-update mechanism: verify the mounted Loader's owning package contract and actual mutation propagation, rather than inventing an event name or assuming catalog coverage is exhaustive.

No live configuration was changed to gather this evidence.
