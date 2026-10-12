# Live rc.2 Settings contract evidence

Coordinator successfully queried Host Service.listService with input `{ "service": "settings" }` through cordis_inspect_query. Earlier external-agent transport errors are not a failure of the runtime Settings contract or an inability to inspect it from this session.

Service: `settings`. Hard dependency inject `settings`; optional `ctx.get("settings")` requires undefined check.

- `configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void`: owns the calling plugin instance's page policy, not its Config. Effect-own returned disposer. Duplicate policy for an instance throws.
- `describe(options?: { redactSecrets?: boolean }): SettingsDescriptor[]`: remote callers must request redaction. Descriptors are keyed by unique profile entry ids and contain ns, autoGenerate, schema, value, revision, optional base/user, applies:'live', optional secrets.
- `update(ns: string, patch: object, expectedRevision?: number): Promise<void>`: merges editable fields.
- `replace(ns: string, section: object, expectedRevision?: number): Promise<void>`: resets live fields then supplies complete form values; ordinary config preserved.
- `mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>`: field edits without restating redacted secrets.

SettingsPathOp: `{op:'set', path:readonly string[], value:unknown}` or `{op:'unset', path:readonly string[]}`. Secret descriptor is presence-only `{path:string[], set:boolean}`. Use edit-baseline revision and only dirty paths; do not transmit a whole stale draft or secret placeholders.

This evidence does not establish a mounted plugin, correct client ConfigForms lifecycle, authorization, visible conflicts, or acceptance of nonvolatile fields. Those still require implementation/tests.
