# rc.2 session projection contract discovery — round67

Read-only Cordis Inspect `Service.listService({service:"sessionProjections"})` confirms native `ctx.sessionProjections` before Phase C implementation. This is preparation only; B final policy/import acceptance sequence is still running.

- `register(definition)` is an effect-owned disposer; definition has key, Zod stateSchema, init(header,inheritedEventCount), pure synchronous apply(state,event), stateVersion; optional wire viewSchema/view requires SessionProjectionMap declaration merging. Host-only key is in SessionProjectionStateMap but not SessionProjectionMap.
- `stateOf(session,key)` materializes current host state and returns a LIVE read-only-by-contract value; never mutate it. Fold ignores irrelevant events by returning the same reference. No provider/storage writes in init/apply/view.
- `snapshot(session,keys?)` returns one consistent cut `{asOfSeq,values}`; `cachedSnapshot` is a possibly lagging hint, not complete source authority.
- `checkpoint(session)` returns DETACHED cloned state rows `{key:{ver,seq,val}}`. `restoreFloor/checkpoint`, `restore`, and `hydrate` handle cached version drift/truncated native histories; do not invent plugin event types.
- Projection service subscribes once to committed session/event, drives registered units and lazily reconstructs older sessions. `onChanged` is a client-visible view feed, not a substitute durable source reader for a host-only key.
- Session exact methods: snapshotEvents(fromSeq=0,toSeqExclusive=this.seq), ownEvents(), isOwnSeq(seq), seq exclusive next-offset, inheritedEventCount. Empty SessionSeqCursor is -1.
- Native user/message is flat UserMessage. assistant/message carries message and optional interrupted. tool/call has callId/name/arguments; tool/result carries message.toolCallId and optional error/meta. turn/end reason is a discriminated kind (completed/aborted/blocked/error/max-tokens/interrupted/forked); structural completed is not user task success.

[Plugin practices](</home/bahman/github/dsh-v0.2/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/references/practices.md>) read: projection fold pure; framework owns incremental log drive; effect registrations have owner; native history remains sole authority; no ad-hoc Session.append event types. Implementation must re-inspect any additional Service/Event/Config/Slot it uses. Native sessionQuery read/observe contracts were previously inspected, but caller-owned observation leases must be disposed if selected.
