# Phase E supplemental measurement: synthetic procedural-aid pilot

## Decision

**The pilot ran, but it demonstrated no improvement. Phase E remains unaccepted.** Both arms answered every task correctly. This is a ceiling-limited tie, not evidence that learning helps or that it never helps. Do not replace or tune these tasks after seeing that result.

The user delegated the input decisions. The coordinator chose synthetic data, no-learning versus a frozen training-rule-derived procedural aid, and a maximum of two fresh executor sessions containing four tasks each. Protocol, aid, prompts, gold answers and deterministic grader were committed and pushed at `03a92d1` before either executor started. No private data or external credentials were used.

## Observed results

| Task | No-learning | Frozen aid | Paired result |
| --- | --- | --- | --- |
| Eligible record selection | Correct | Correct | Tie |
| Independent-root quorum | Correct | Correct | Tie |
| Unrelated arithmetic control | Correct | Correct | Tie |
| Current-rule override control | Correct | Correct | Tie |

Two executor sessions returned eight task answers. Exact parsed-JSON grading verified all eight. The harness reports four pairs, zero wins, zero losses and four ties; `measured: true` means the planned pairs were all graded, **not** that improvement was established. Both controls passed in this small sample; that does not establish general privacy or instruction-precedence safety.

## Evidence

- [Frozen protocol](MIGRATION-PHASE-E-MEASUREMENT-PROTOCOL.md)
- [Tasks, aid and gold answers](fixtures/skill-measurement/pilot.json)
- [Baseline sent prompt](fixtures/skill-measurement/no-learning.prompt.txt) and [aid sent prompt](fixtures/skill-measurement/frozen-procedural-aid.prompt.txt)
- [Baseline raw capture](fixtures/skill-measurement/no-learning.capture.json), executor `9eae681e-6ade-4ed6-a22a-be6395304503`
- [Aid raw capture](fixtures/skill-measurement/frozen-procedural-aid.capture.json), executor `067514a5-b2d1-47a6-95dc-e92dbbb9768a`
- [Machine report](fixtures/skill-measurement/results.json)
- [Deterministic grader and aggregation runner](scripts/measure-skill-pilot.mjs)

The capture hashes bind the frozen prompt files; the tool-call prompt text was copied manually and omitted the terminal newline. They are not transport-side attestations. Raw final outputs were copied verbatim from returned agent messages, without correction or selective retries. Re-running `node scripts/measure-skill-pilot.mjs` regrades the captured outputs; it does not run models again. Report timestamps describe aggregation only.

## Limits and next decision

This was a **prompt-level procedural-aid pilot**, not an end-to-end learned-skill experiment. The aid was authored from separate training rules, not synthesized from independently verified episodes by the plugin. No native catalog, activation, invocation, invalidation or real held-out project work was exercised. The same default model selection was requested for both independent non-fork agents, but effective model/provider/sampling, ambient system context and cache isolation were not independently attested. Calls were started together, not sequenced through the experiment harness; the harness subsequently aggregated deterministic scores.

One trial per task with answers batched within an arm supplies no reliable population efficacy estimate. The coordinator authored both the aid and golds; golds were not produced by an independently implemented reference executor. No tokens, actual provider-call count, monetary cost or task-level latency were available. Two executor sessions are not necessarily two underlying inference requests. A design reviewer identified these fairness and interpretation limits before execution; the reviewer did not independently verify the gold implementation.

Strict pinned-rc.2 build passed, deterministic grader self-tests passed, and the measurement-harness suite passed all six checks. Those regression results are separate from the pilot's efficacy result.

Next useful work is a separately preregistered real-provider isolated-host executor with a procedure learned from verified independent training episodes and held-out project cases, including provider cost/context/error measurements. This pilot does not close that gate. Do not expand automation or restart the live host based on it. Browser acceptance, deployment and the Host-issued authenticated-receipt boundary remain open and unchanged.
