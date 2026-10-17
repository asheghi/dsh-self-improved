# Real mounted Chromium browser gate

Final result: **8/8 PASS**, actual Chromium/CDP (not VM/DOM emulation). See [machine-readable report](<MIGRATION-BROWSER-REPORT.json>) for pinned hashes and measured values.

Run `node scripts/test-v02-browser-guards.mjs` then `node scripts/run-v02-browser.mjs` from this workspace. Chromium must exist at `/usr/bin/chromium`; Node must expose global `WebSocket`. The launcher creates an isolated synthetic mounted host using the existing fixture runner, and an isolated Chromium user profile. No live GUI or profile is used, and no runtime writes outside this workspace are required. The single launcher command should run as a managed job; collect its exit result.

The browser tests use rendered controls, actual CDP mouse/keyboard dispatch, two real browser pages, and native JavaScript confirmation dialogs. Assertions cover mounted seeded memory, keyboard tab/arrow navigation and focus-visible, unsaved draft navigation, concurrent settings stale conflict and rebase/save, narrow viewport overflow, light/dark computed colors, destructive cancellation/acceptance, and durable settings/forget effects with zero model requests.

The original 390px narrow test failed (plugin clientWidth101, scrollWidth195). Parent's responsive client change fixed it: final clientWidth/scrollWidth both101. This gate establishes no horizontal plugin overflow, not comfortable host settings-sidebar usability at this width.

Final fixture retained for reproducibility: `fixtures/v02-ui/temp/mounted-ui-1791898716084-bd8a25`. Its host/provider/browser processes have stopped; target cleanup closed both created pages. Runtime artifacts and synthetic auth facts stay in ignored fixture directories, not in this report. Prior exploratory fixture runs were likewise stopped.

Environment finding: Chromium initially refused long TMPDIR Unix socket paths. The launcher uses a short workspace-local `.bt-XXXXXX` temp directory and owner-marker/resolved-path cleanup guards. [Environment report](<MIGRATION-BROWSER-ENVIRONMENT.json>) records the resolved issue.

Focused safety checks: reject live GUI port3082, external origin, and foreign fixture home before connecting CDP. They complement the actual browser gate and do not replace it.

Additional isolated authorization UI observation (separate learning-worker host): Settings → Models → Edit openai-codex rendered API key, Customized settings, Cancel, Apply; no subscription sign-in action was present in that editor. No credentials were submitted and no provider config was applied. A later Add model provider inspection was unavailable because that isolated host had stopped (connection refused); no claim about other auth routes is made.
