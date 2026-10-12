# rc.2 client ConfigForms contract evidence

Live Client Service.listService({service:'configForms'}) returned provider-error: no catalogued Service named configForms (reported with a timeout wrapper). This does not invalidate installed contract; the service is not catalogued in the current connected client scope. No live page/settings changed to force mounting.

Read installed @deepseek-ai/dsh-client-ui-settings/lib/types/client/config-form.d.ts directly:

- Context augmentation declares `configForms: ConfigForms`.
- `ConfigForms.get<T>(entryId: string): ConfigForm<T>` returns the shared entry-addressed form owned by its provider.
- `getSnapshot(): ConfigFormSnapshot<T>` returns stable snapshot references until change.
- `subscribe(listener:()=>void):()=>void` returns consumer-owned unsubscribe.
- `set(field:string,value:unknown):Promise<boolean>` and `unset(field:string):Promise<boolean>` report whether Host accepted, after recovery.
- `mutate(ops:readonly SettingsPathOpView[],expectedRevision?:number):Promise<boolean>` supports a fixed editor-baseline revision. Pass only dirty paths; `false` is rejection, not a successful RPC result envelope.
- ConfigFormController has dispose(), but consumers of ConfigForms.get must NOT dispose the shared provider-owned controller.
- `ConfigForms.whileServed(namespaces:readonly string[],register:(served:ReadonlySet<string>)=>()=>void):()=>void` conditionally registers a contribution; caller effect-owns returned disposer.
- Provider owns transport injection and serialized writes. Do not import private Client value packages across plugin boundaries; use Cordis services.

Visible conflict/rebase, transport exception handling, preserved drafts, redacted secrets and actual mounted behavior still need tests. No invented snapshot error field or response.result.ok contract.
