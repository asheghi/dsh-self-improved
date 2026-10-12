# Phase C continuity-controls browser gate — NOT ACCEPTED

## Scope and isolation

Requested mounted browser acceptance for continuity.enabled and the two JSON string-array exclusion controls only: default off, dirty-only false/CAS, invalid-array all-or-none rejection, explicit [] clearing, stale-conflict/rebase retained drafts, keyboard/narrow/light-dark behavior. No worker/Continue/source implementation edited; no fixture code changes were needed for startup. This report does NOT accept Phase C.

Used existing [mounted fixture runner](scripts/test-v02-mounted-ui.mjs) and [coordinator methodology](MIGRATION-MOUNTED-UI-COORDINATOR.md). Started managed job bash-171 with `node scripts/test-v02-mounted-ui.mjs up`. It created owned run [mounted-ui-1791630453355-c82248](fixtures/v02-ui/temp/mounted-ui-1791630453355-c82248/facts.json), genuine rc.2 isolated mounted-ui profile, loopback GUI33715 and logging provider39709. Original GUI3082/profile/production data were not visited, installed into or changed. Fixture token/auth cookie were used internally for HTTP baseline only and are intentionally omitted here.

Pinned main build SHA256: 27e7280744e781cf5c9c131adaecf5491749cafa5a5d0acc99d16adc05945c42. Pinned client SHA256: cb8aed09a12cf9d566a94648a9d4ad0e1863c3c1a7232bb205ef090acee15f02. This is a shadow snapshot, not proof of future concurrent repository changes.

## Measured

Actual HTTP `verify --fresh` exited successfully: 11/11 checks PASS. Owner marker/run identity, current main build hash, genuine composed boot graph + plugin row, served current client bytes, clean isolated profile patch/no config override, synthetic store database/three active seed rows, zero extraction-state rows and zero real model requests were verified. Authentication cookie was acquired automatically from this fixture's token redirect; no user credentials requested.

Baseline mounts/HTTP bytes are NOT DOM/interactive settings acceptance.

## Concrete acceptance blocker

Chrome MCP `list_pages` and `new_page` (the latter targeting ONLY own GUI33715/new isolated context continuity-browser-c82248) both returned `Protocol error (Target.setDiscoverTargets): Target closed`. No test page was successfully created. Exact Client Inspect queries Service.listService({service:configForms}) and Slots.listSubTree({root:settings.section}) both timed out after10000ms. Therefore there was no usable browser/Client inspection connection. No alternate browser, unapproved installation, fabricated DOM, VM-only replacement, or original GUI navigation was used to work around the failure.

Read installed ConfigForms declaration for the known public get/subscribe/mutate(expectedRevision) contract and [saved contract evidence](migration-baseline/rc2-configforms-contract.md); this is fallback contract knowledge, NOT live Client validation.

UNMEASURED and still required: mounted controls/default-off state, false-disable dirty-only operation, actual atomic invalid-JSON handling, explicit empty-array save, genuine settings CAS stale conflict/rebase/draft retention, keyboard navigation/focus, narrow viewport, light/dark themes, DOM console/errors, and browser accessibility. Existing binding/static tests do not waive these gates.

## Cleanup

Stopped ONLY originating managed job bash-171 with job_kill and collected final killed/SIGTERM status using job_output. Runner owns and stops its server/stub children; no raw namespace PID signaling. `down --run <owned run> --keep` then succeeded, requiring connection-refused on GUI33715 and retaining evidence. No browser page was created, so none was closed. Original3082 untouched. No background job remains from this task.

## Next action

Repair/reconnect host Chrome MCP, then start a fresh owned fixture and perform the requested interactive controls/CAS/keyboard/theme checks. Do not call this baseline a browser acceptance pass. Phase C remains open; no full-phase or improvement claim.
