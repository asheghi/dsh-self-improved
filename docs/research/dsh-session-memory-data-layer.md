# DSH 会话 / 记忆 / 压缩相关插件包调研报告

调研对象：`E:\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 下 18 个包（版本均 `0.1.0-rc.6`，`lib/index.js` 为编译产物，`lib/types/*.d.ts` 为类型声明），并结合 `E:\dsh`（DSH_HOME）实测数据与 `dsh-base`/`dsh-web-app` 的装配（cordis.patch.yml）。所有路径、签名均取自源码。

---

## 0. 总览

| 包 | 职责 | Cordis 注册 | 关键文件 |
|---|---|---|---|
| dsh-session | 事件溯源会话存储（内存） | `ctx.sessions: SessionStore`；事件 `session/created\|disposed\|event\|flush` | `lib/types/index.d.ts`、`types.d.ts` |
| dsh-session-persistence | 持久化 Service 定义 + 写协调器 | `ctx.sessionPersistence: SessionPersistence`（抽象） | `lib/types/index.d.ts`、`coordinator.d.ts`、`write-behind.d.ts` |
| dsh-session-persistence-jsonl | JSONL/zstd 持久化后端 | 实现 `ctx.sessionPersistence`（唯一后端） | `lib/types/index.d.ts`、`format.d.ts` |
| dsh-session-query | 会话查询服务定义（精确读/全文/血缘/标题） | `ctx.sessionQuery: SessionQueryEngine`（抽象） | `lib/types/index.d.ts`、`types.d.ts`、`config.d.ts` |
| dsh-session-query-sqlite | SQLite FTS5 全文索引实现 | 实现 `ctx.sessionQuery` | `lib/types/schema.d.ts`、`index.js` |
| dsh-session-reference | 跨会话引用快照（`recall` 上下文） | `ctx.sessionReferenceResolver` | `lib/types/index.d.ts`、`types.d.ts` |
| dsh-session-stats | `sessionStats` 投影单元 | 经 `ctx.sessionProjections`（无独立 service） | `lib/types/index.d.ts` |
| dsh-session-checkpoint-policy | 模型请求/工具分发前的持久性检查点 | 纯事件监听（无 service） | `lib/types/index.d.ts`、`index.js` |
| dsh-session-title | 日志背书标题服务 + provider 契约 | `ctx.sessionTitle: SessionTitleService`；事件 `session/title` | `lib/types/index.d.ts` |
| dsh-compaction | 压缩能力 seam 服务定义 | `ctx.compaction: CompactionEngine`（抽象）；事件 `compaction/start\|summary\|end\|prune` | `lib/types/index.d.ts`、`types.d.ts` |
| dsh-compaction-basic | 基础压缩后端（tokenMeter 测压 + LLM 摘要） | 实现 `ctx.compaction` | `lib/types/types.d.ts`、`index.js` |
| dsh-spill | spill 存储服务定义 | `ctx.spillStore: SpillStore`（抽象） | `lib/types/index.d.ts`、`types.d.ts` |
| dsh-spill-policy | 工具结果超限溢出策略 | `tools/post-execute` 监听（无 service） | `lib/types/index.d.ts` |
| dsh-storage | 存储 hub + 命名后端注册表 | `ctx.storage: Storage` | `lib/types/index.d.ts`、`backend.d.ts`、`registry.d.ts` |
| dsh-storage-json | `json` 文件后端 | 注册 backend `json` | `lib/types/index.d.ts` |
| dsh-storage-domain | 域数据形态（schema 校验 KV + 变更事件） | `ctx.storage.domain`、`ctx.storageDomain` | `lib/types/index.d.ts`、`domain.d.ts`、`spec.d.ts`、`events.d.ts` |
| dsh-output-retention | 输出保留纯库（head/tail 预算） | 无（纯库） | `lib/types/index.d.ts` |
| dsh-time-context | 请求时钟上下文注入 | `agent/pre-step`（prepend） | `lib/types/index.d.ts`、`index.js` |

---

## 1. 各包核心职责与 service 注册、关键 API

### dsh-session —— 事件溯源会话存储（核心模型）
- 自述："Event-sourced session service: append-only session log, in-memory store, and the derived LLM message history. **Persistence is a plugin concern (subscribe to `session/event`, drain on `session/flush`).**"
- 声明（`lib/types/index.d.ts`）：
  ```ts
  interface Context { sessions: SessionStore }
  interface Events {
    'session/created'(this: Scoped<Session>, session: Session): void;
    'session/disposed'(this: Scoped<Session>, session: Session): void;
    'session/event'(this: Scoped<Session>, session: Session, event: SessionEvent): void;
    'session/flush'(this: Scoped<Session>, session: Session): Promise<void> | void; // parallel, awaited
  }
  ```
- `SessionStore`（`extends Service`）关键方法：`create(id?, options?): Session`、`prepare(id?, options?)`、`enter(session): () => void`、`announce(session)`、`flush(session): Promise<boolean>`、`get(id)`、`list()`、`fork(source, boundary?, childSessionId?)`。
- `Session`（普通类，非 Service）：`append<T>(type, data, ...surfaceOp): SessionEvent`、`deriveMessages(): Message[]`（派生消息历史，缓存+深冻结）、`events`、`seq`、`requestHeader()`、`requestContext()`。`SessionId` 是 branded string；`SESSION_FORMAT_VERSION = 0`。
- `SessionHeader`（存储元数据，**不**进事件日志）：`{ version, id, createdAt, cwd?, parentSession?, seedLength?, origin?: 'subagent', delegationDepth?, agentPreset? }`。
- 事件词汇表（`SessionEventMap`，可被其他包 `declare module '@deepseek-ai/dsh-session/types'` 合并扩展）：`turn/start`、`turn/end`、`step/start`、`step/end`、`user/message`、`assistant/chunk`、`assistant/message`、`tool/call`、`tool/result`、`todo/write`、`request/header`、`request/context`、`session/end-seed`；仓库内合并出 `session/title`、`compaction/*`、`goal/change` 等（完整清单见 `lib/types/known-event-types.js`，共 45 种）。
- 表面（surface）机制：只有 `user/message | assistant/message | tool/result` 三类消息事件携带 `surfaceOp`（`'append'` 或 `{op:'replace', start, end}`），是"派生模型历史"的唯一来源；压缩就是用 `replace` 折叠一段 surface 节点。

### dsh-session-persistence —— 持久化服务定义 + 写协调器
- 声明 `ctx.sessionPersistence: SessionPersistence`（抽象类，`extends Service`），方法：
  ```ts
  locate(meta): SessionLocation | undefined;      // kind:'jsonl', path 绝对路径
  readonly supportsRawArtifacts: boolean;
  readRaw(id, signal?): Promise<SessionRawArtifact | undefined>;
  create(meta: SessionHeader): Promise<void>;      // 可延迟物化到首次 append
  append(id, events: readonly SessionEvent[]): Promise<void>; // 返回即持久
  prepare(id, signal?): Promise<SessionPreparation>; // resume 用
  load(id): Promise<SessionInspection>;            // 提交崩溃恢复
  inspect(id, signal?): Promise<SessionInspection>; // 非修改检查
  readFrom(id, fromSeq, signal?): Promise<{meta; events}>; // 水印续读
  list(signal?): Promise<SessionHeader[]>;
  listSnapshots(signal?): Promise<SessionPersistenceSnapshot[]>;
  ```
- `PersistenceCoordinator`（第一方后端共享编排）：每个 `session/event` 复制进 per-session write-behind 控制器，固定批窗口 `DEFAULT_WRITE_BATCH_MAX_DELAY_MS = 200`ms；`session/flush` 是共享停稳屏障；崩溃尾部修复（冷态）、HMR 接管、退役 drain。后端只需实现小接口 `PersistenceBackend<TornMarker>`：`loadStored / readStoredRevision / loadStoredFrom? / appendBatch / commitRepair / list / locate? / close?`。

### dsh-session-persistence-jsonl —— JSONL/zstd 后端
- `JsonlSessionPersistence extends SessionPersistence implements PersistenceBackend<JsonlTornMarker>`，`name = "session-persistence-jsonl"`，`supportsRawArtifacts = true`。
- `Config`：`{ root: string（必填，无默认）, packChunks?: boolean（默认 true）, compression?: 'zstd'|'none'（默认 zstd）, preparedSessionCacheSize?（默认 5）, writeBatchMaxDelayMs?（默认 200） }`。
- 物理格式：`node:zlib` 原生 zstd，**每写批一个独立可解码、带 checksum（`ZSTD_c_checksumFlag`）的帧**；`packChunks` 把连续 `assistant/chunk` 增量打包成 `text-chunks/reasoning-chunks/tool-call-chunks` 存储行（约小 60%），读取无差别。
- 崩溃恢复：`load()` 保留崩溃中断的完整 final turn，持久追加合成 `tool/result`（missing error）+ `step/end` + `turn/end {kind:'interrupted'}` 以平衡日志；只截断撕裂的尾帧。

### dsh-session-query / dsh-session-query-sqlite —— 查询与全文索引
- `ctx.sessionQuery: SessionQueryEngine`（抽象）方法：`searchSessions / searchEvents`（全文）、`listSessions / filterSessions / readSession / readTitle(s) / listEvents / filterEvents / readSurface / traceSession / traceEvent / readEvent`。
- `extractSessionEventText(event)`：从 `user/message`、`assistant/message`、`tool/result` 提取"semantic text"（此处 semantic = 可检索文本，**非向量语义**）。
- `SqliteSessionQueryEngine extends SessionQueryEngine`，`Config`：`path`（必填；`:memory:` 支持）、`openAt: 'startup'|'first-search'|'never'`、`journalMode`（默认 wal）、`defaultLimit 20 / maxLimit 100 / snippetChars 240 / persistedInspectConcurrency 4`。持久表 `search_state`、`persisted_sessions`、`persisted_docs`（FTS5 virtual table），TEMP 表 `live_sessions`、`temp.live_docs`（live 覆盖持久行，"live-preferred"）；`tokenize='unicode61'`，schema version 8，application_id 1146308689。ctx 键 `launcherSessionQueryPath` 由桌面 launcher 注入磁盘路径。

### dsh-session-reference —— "跨会话召回"（mention 驱动）
- `ctx.sessionReferenceResolver: SessionReferenceResolver`；`listCandidates(agent, query?, limit?, signal?)`、`prepare(agent, content, references, signal?): Promise<PreparedReferencedMessage>`。
- 产出 `SessionReferenceSource { kind:'session-reference', form:'recall', version:1, references:[{sessionId, label, capturedThroughSeq, compacted, originalMessages, retainedMessages, omittedMessages, omittedBytes, truncated, inputIndex}] }` —— 一条聚合的附加 `UserMessage` 注入当前请求，即 UI 中"跨会话召回"的来源（`dsh-llm` 的 `MessageSourceMap` 增加 `'session-reference'`）。

### dsh-session-stats / dsh-session-checkpoint-policy / dsh-session-title
- stats：向 `ctx.sessionProjections` 注册 `sessionStats` 投影单元（`inject: ['sessionProjections']`），值 = `{turns, steps, llmMs, toolMs, ttftMs, ttftSteps, decodeMs, decodeTokens, lastTurn, openStep, pendingCalls}`（实测见 `$DSH_HOME/storages/session_projcache.json`）。
- checkpoint-policy：在 `llm/stream`（模型请求前）、`tools/execute`（顶层工具分发前）、`agent/pre-step`（下一请求边界）调用 `await ctx.sessions.flush(agent.session)`；失败 fail-closed（不派发 adapter/tool body）。
- title：`ctx.sessionTitle: SessionTitleService`，`get/rename/refresh/register`；事件 `session/title`（log-only，最新者胜）；`SessionTitleProvider { id, automatic:'first-prompt'|'all-prompts', generate(request) }`；base 装配 `fallbackMaxWords:5, fallbackMaxBytes:40, maxTitleBytes:80`，provider 为 `dsh-session-title-first-prompt-llm`（targetWords 5 / targetCjkCharacters 10 / maxOutputTokens 64）。

### dsh-time-context
- `agent/pre-step`（`prepend: true`）向待处理消息追加一条时间快照 `user/message`（`source:{kind:'plugin', plugin:'time-context', form:'snapshot'}`），内容为时间戳+浏览器时区+距前文经过时长；`refreshIntervalMs` 节流。Config `{timeZone?, refreshIntervalMs?}`。这是"在请求前注入持久上下文消息"的现成范式。

---

## 2. 磁盘存储模型与 session/turn/message 模型

### 会话日志（权威数据）
- 根目录：`$DSH_HOME/sessions`（`dsh-home-paths`：显式配置 > `$DSH_HOME` > `~/.dsh`；base 装配 `root: !!js dshHomePath('sessions')`）。
- 路径规则（`format.ts`/`index.js`）：
  ```
  <root>/<--projectKey(cwd)-->/<encodeSegment(sessionId)>/session.jsonl[.zstd]
  ```
  - `projectKey('E:\dshPro')` → `--E-dshPro--`（`/ \ :`→`-`，非安全码点 `~XXXX`，外层包 `--`，截断 251 字符）；无 cwd → `_no-cwd`。
  - `encodeSegment(id)` 注入式安全编码（防 `../`、防碰撞）。
  - 实测 `E:\dsh\sessions\--E-dshPro--\session-7db69327-...\session.jsonl.zstd`、`--E-me-normal--\session-91094818-...\session.jsonl.zstd`、`--E-myTools--\07957e97-...\session.jsonl.zstd`（后者为无前缀旧 id）。store 默认 mint `session-<n>`，web host 用显式 `session-<uuid>`。
- 文件内容：第 1 行是 `{"type":"session", version, id, createdAt, cwd, ...}` 头记录；其后每行一个 `SessionEvent`（lossless JSON、seq 连续）；`readRaw()` 返回逐字文本（"the exact durable bytes the backend wrote"），供导出/审计。

### SQLite 派生索引（可丢弃读模型）
- web 装配默认 `path: ':memory:'`、`openAt: never`（全文搜索关闭，精确读/标题/血缘仍可用）；桌面 launcher 通过 `ctx.launcherSessionQueryPath` 提供磁盘路径。文档明确："Never point `path` at the session-persistence database"，索引是 disposable（schema 版本不匹配即重建），因此不适合放权威记忆数据。

### 通用 KV 存储（storages）
- `$DSH_HOME/storages/<unit>.json`（web 装配 storage-json `root: dshHomePath('storages')`、storage-domain `backend: json`）。实测：
  - `workspace.json`：unit `{name:"workspace", version:2}`，`global` + `tables.workspaces`（key=workspaceId，值 `{path, title, sessionIds[], createdAt, updatedAt}`）。
  - `session_projcache.json`：unit `{name:"session_projcache", version:3}`，`tables.sessions`（key=sessionId，值 `{identity:{createdAt,cwd}, rows:{sessionStats, title, goal, tokenUsage, contextPressure, contextBreakdown, subagentTiming, subagent, permissions, sessionListMetadata, imageLimits, todos, plan}}`）。

### session / turn / message 模型
- **Session** = 一个追加式事件日志（事件溯源，日志是唯一真源），`SessionHeader` 承载非可回放元数据。
- **Turn** = 一轮用户交互：`turn/start{turn}` … `turn/end{turn, reason}`（reason: completed|aborted|blocked|error|max-tokens|interrupted，可合并扩展）。
- **Step** = 一次模型调用 + 其请求的工具执行：`step/start` … `step/end`；`assistant/chunk`（token 级重放）→ `assistant/message`（组装消息 + usage）；`tool/call` ↔ `tool/result`。
- **Message** = surface 事件（`user/message`、`assistant/message`、`tool/result`）经 `deriveMessages()` 投影；`surfaceOp` 的 `replace` 使压缩摘要成为"历史的一部分"而旧节点被遮蔽。

---

## 3. 生命周期事件 / 钩子

1. **创建/销毁**：`SessionStore.create()`（或 `prepare→enter→announce`）→ `session/created`（同步 throw 可 veto 并回滚）；session 离开 store → `session/disposed`；`ctx.sessions.flush(session)` → `session/flush`（parallel、await、持久化屏障）。
2. **写路径**：每个 `session/event`（post-commit fire-and-forget）被协调器复制进 write-behind → 200ms 批窗口 → `appendBatch` 持久；`session/flush` 立即排空并作为停稳屏障；dispose 时最终 drain。
3. **恢复**：`load()`（冷：保留中断轮次并合成 closers；热：先 flush 快照、开放轮次拒绝）；`prepare()`（resume）；HMR 接管在 `session/created` 时 `adoptLivePrefix`；`inspect()` 非修改检查。
4. **请求/工具边界**：checkpoint-policy 在 `llm/stream`、`tools/execute`、`agent/pre-step` 前 `flush`。
5. **上下文注入**：`agent/pre-step`（prepend）——time-context（时间快照）、compaction-basic（压力压缩）、checkpoint-policy（flush）；`agent/request-error` —— 溢出恢复；`tools/post-execute` 瀑布 —— spill-policy。
6. **投影**：`ctx.sessionProjections` 订阅 `session/event` 一次，驱动每个已注册单元的 `apply(state, event)`；变更流 `onChanged`；`session-projection-cache` 以 `writeEveryEvents:200 / writeIntervalMs:5000` 节流写回 domain。

---

## 4. dsh-compaction / dsh-spill 详解（"上下文放不下"时发生什么）

### 谁决定压缩什么
- `dsh-compaction-basic` 是唯一自动后端（base 装配）。它用 `ctx.tokenMeter` 在同一已消费日志 revision 上计量"最新规范化 request envelope + 当前 surface"的 token。
- 两条触发路径（`_registerAutomaticCompaction`）：
  1. **压力**：`agent/pre-step`（prepend）→ `compactIfNeeded(agent, 'pressure', signal)`。阈值 = `thresholdRatio 0.8 × contextWindow`（contextWindow 从最新持久 `request/context` 事件解析，按 provider/model 精确覆盖 `modelPolicies`）；保留近期尾部 `retainRatio 0.16`（或绝对 `retainTokens`）。
  2. **溢出**：`agent/request-error` 且 `failure.code === CONTEXT_WINDOW_EXCEEDED_CODE` → `compactIfNeeded(agent, 'context-overflow', signal)`，绕过正常阈值强制做一次"有用的平衡缩减"，最多 `maxOverflowRetries(1)` 次；只有 `surface.replaceGeneration` 前进才允许 retry。这就是"上下文放不下"的标准处理。
- 压缩前的可选阶段：`dsh-compaction-tool-result-pruner`（`thresholdChars:8192, headChars:4096, tailChars:1024`，经 `ctx.toolResultPruner`）先把超大工具结果剪到预算内，重新测压后仍超才摘要。
- **摘要**：直接一次性 `ctx.llm.stream()` 调用，**逐字回放会话自身的 system prompt、tools 与被遮蔽区域消息**以复用 provider KV cache，压缩指令作为最后一条 user 消息；`GenerateOptions.purpose='compaction'`（DeepSeek 适配器发 `x-deepseek-harness-compact: 1`）；只取文本，剔除 reasoning/工具调用；`maxTokens` 默认 8192。`summarize()` 是唯一子类钩子。
- **落账**（`dsh-compaction` 契约）：先同步追加 `compaction/start`（持久锁，防并发）→ 摘要 → `compaction/summary`（含 `summary ContentBlock[]、shadowedRange、shadowedSeqs、shadowedTokenCount、provider、model、maxTokens?、usage?`）→ 紧接一个带 `surfaceOp:{op:'replace', start, end}` 的 `user/message`（带 `<compacted-summary>` 标签）遮蔽旧节点 → `compaction/end`。`dsh-command-compact` 的 `/compact` 走 `compactNow()`（`turn:null` 空闲事务）。
- 失败处理：摘要无法缩小内容则拒绝；活动未匹配 `compaction/start` 是持久锁，`busy`；`session/end-seed` 之前的陈旧标记不阻塞。

### dsh-spill —— 大文本溢出到哪
- `ctx.spillStore.saveText({owner:{sessionId}, source:{toolName, callId, label}, suggestedName, content}) → {locator: SpillLocator, bytes, retrievalHint}`；服务定义"deliberately minimal"——**无保留策略、无检索 API、无结果替换**。
- `dsh-spill-policy`（`tools/post-execute` 转换器）：纯文本工具结果 UTF-8 超 `maxInlineBytes`（装配 50000）→ 全文存 spill、模型可见结果替换为 head/tail preview + locator + retrievalHint（preview 由 `dsh-output-retention` 的 `TextRetainer` 做）；第二臂 `tools/code-dispatch-log` 限制 `tool/code-dispatch` 事件的日志副本。best-effort：save 失败保留原文，绝不把成功调用变 isError。
- `dsh-spill-local`（实现）：默认 `$TMPDIR/dsh-spill-<mkdtemp>`（0700）下 `<root>/session-<sha256(sessionId) 前12位>/<randomHex6>-<sanitizedName>`，`open('wx', 0600)` 独占写。

---

## 5. 长期记忆 / embedding / 向量检索痕迹调查

结论：**没有**。全仓库（`node_modules/@deepseek-ai/*` 的 js/d.ts/md）搜索 `embedding | vector | vectorSearch | mem0 | semantic memory | recall | long-term memory | memory store` 的结果：

- **无任何 embedding / 向量检索 / mem0 / 语义记忆库代码**。
- `recall` 只出现在两类地方：
  1. `dsh-session-reference` 的 `form:'recall'`（**用户显式 mention 驱动的跨会话引用快照**，非自动检索）；UI 将其渲染为"跨会话召回"。
  2. `dsh-session-query-sqlite` README 的 "token/phrase recall"（FTS5 词面召回，明确非子串/非语义）。
- `semantic` 一词在 session-query 里指"从事件提取的一手检索文本"（`SessionEventSearchDocument.text`），存 FTS5 做字面短语匹配（"Queries are… literal phrases. FTS5 syntax … treated as data"）。
- 唯一接近"跨会话记忆"的能力：`sessionQuery` 全文检索（默认关闭）、`sessionReference` 显式召回、`fork`（会话克隆/继承）、`projection-cache`（派生统计跨重启持久化）。
- `dsh-tool-ralph` 的 "the shared workspace is long-term memory" 是提示词表述，不是记忆系统。
- 即：**长期记忆/向量检索是完全空白地带**，是插件可插入的新能力。

---

## 6. dsh-storage / dsh-storage-json / dsh-storage-domain 通用存储抽象

- `ctx.storage: Storage` 是 hub（不做 IO）：`backend: BackendRegistry`（`register(name, backend) / get(name) / names()`）+ 数据形态挂载（`mount(form, facility) / form(form)`）。
- `StorageBackend` = `{ kv?: KvFacet, close() }`；`KvFacet.open(descriptor) → KvUnit`，`KvUnitDescriptor = { name(必须匹配 UNIT_NAME_RE), version, tables[], hasGlobal }`；`KvUnit` = `loadAll() / putRecord(table, key, value) / deleteRecord / setGlobal / close`——"值是 JSON 不透明白盒，无 schema 无事件"。
- `dsh-storage-json`：注册 backend `json`，`Config {root 必填}`，每 unit 一个 `<root>/<unit>.json`，**原子整文件重写**（temp-write + fsync + publish）。
- `dsh-storage-domain`：`ctx.storage.domain` / `ctx.storageDomain: DomainFacility`，`Config {backend 必填, routes?}`；`open(spec) → Domain<S>`（`global.get/set`、`table(name).get/put/delete/update/entries/keys/size`），记录 schema 用 zod；写链语义"先持久、再改内存、再发 `domain/changed`"，拒绝则内存不动。`defineDomain / domainTable / descriptorOf` 声明域（name/version/tables/global + zod schema）。
- **其他插件如何用它**（现成范例 `dsh-session-projection-cache`）：
  ```ts
  const spec = defineDomain({ name: 'session_projcache', version: 3, tables: { sessions: domainTable(checkpointRecord) } });
  const domain = await ctx.storageDomain.open(spec);
  ctx.effect(() => () => domain.close());
  const table = domain.table('sessions');
  await table.put(sessionId, { identity, rows });
  ```
  实测 `$DSH_HOME/storages/session_projcache.json` 即此产物；`workspace` 域同理。

---

## 7. 适合插入"长期记忆插件"的扩展点清单

1. **事件模型扩展（最底层）**：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'memory/...': ... } }` + `session.append('memory/...', data)`。事件自动进入追加日志与持久化；注意 jsonl 后端对未知**必需**事件类型会拒绝读取（`ignorable: true` 标记可让旧版本跳过），新事件需进 `known-event-types` 生成清单或带 ignorable。
2. **`session/event` 订阅**：镜像写路径，在每个已提交事件上做记忆提取（摘要、实体、embedding 候选），fire-and-forget 不影响热路径。
3. **`session/flush` 订阅**：与持久化对齐——记忆写入与日志持久化在同一屏障内，避免记忆领先/落后于日志。
4. **`agent/pre-step`（prepend）注入召回**：仿 `dsh-time-context`——把检索到的记忆渲染成一条 `user/message`（`source:{kind:'plugin', plugin:'<name>', form:'snapshot'}`）注入请求上下文，模型可见、可回放、可审计。
5. **`agent/request-error`**：在溢出恢复点（context-overflow）同步做记忆固化（把即将被压缩遮蔽的内容先存进记忆库）——这是"压缩即遗忘"的最佳钩子。
6. **`ctx.sessionQuery` 后端或消费**：把 sqlite `openAt` 从 `never` 改为 `first-search` + 持久 `path`（覆盖 `launcherSessionQueryPath`）以启用全文；或实现 `filterEvents` 字面扫描。向量检索需另建索引（当前无任何向量设施）。
7. **`ctx.sessionProjections.register`**：注册新投影单元（如 `memoryDigest`），`apply(state, event)` 纯函数折叠，`view(state)` 产出；`session-projection-cache` 会自动把它持久化进 `session_projcache` 域（`(sessionId, key, ver, seq, val)` 行），跨重启恢复。
8. **`ctx.storageDomain.open` 开自己的域**：如 `memory` 域（`defineDomain` + zod schema + `routes` 指定后端），存 KV/JSON 记忆；`domain/changed` 事件可做索引联动。这是"记忆库"最直接的持久层。
9. **`ctx.compaction` 子类 / `summarize()` 钩子**：定制压缩策略（如"压缩时顺便写记忆摘要"），`compactIfNeeded`/`compactNow` 是唯一入口。
10. **`ctx.spillStore` 子类**：把超大文本溢出到自己的介质（数据库/对象存储），返回 `SpillLocator + retrievalHint`。
11. **`tools/post-execute` 瀑布**（spill-policy 模式）：在结果进入模型上下文前改写/抽取，`next()` 委托保证可组合。
12. **离线/批处理面**：`ctx.sessionPersistence.listSnapshots/readFrom/readRaw` 提供对全部历史日志的只读访问（含水印续读），适合建 embedding 索引的批任务；`ctx.sessions.fork` 让子代理继承父会话记忆前缀。

关键限制提示：sqlite 查询索引是**可丢弃派生索引**（不要放权威数据）；jsonl 日志是权威源，记忆插件应只增不改；所有写路径都要尊重 200ms 批窗口与 `session/flush` 屏障，避免破坏持久性语义。

---

*主要源码路径（均位于 `E:\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\`）：`dsh-session\lib\types\{index,types}.d.ts`、`dsh-session-persistence\lib\types\{index,coordinator,write-behind}.d.ts`、`dsh-session-persistence-jsonl\lib\types\{index,format}.d.ts`、`dsh-session-query\lib\types\{index,types,config}.d.ts`、`dsh-session-query-sqlite\lib\types\{index,schema}.d.ts`、`dsh-session-reference\lib\types\{index,types}.d.ts`、`dsh-compaction\lib\types\{index,types}.d.ts`、`dsh-compaction-basic\lib\types\{index,types}.d.ts`、`dsh-spill\lib\types\{index,types}.d.ts`、`dsh-spill-policy\lib\types\index.d.ts`、`dsh-storage\lib\types\{index,backend,registry}.d.ts`、`dsh-storage-json\lib\types\index.d.ts`、`dsh-storage-domain\lib\types\{index,domain}.d.ts`、`dsh-output-retention\lib\types\index.d.ts`、`dsh-time-context\lib\types\index.d.ts`；装配：`dsh-base\cordis.patch.yml`、`dsh-web-app\cordis.patch.yml`；实测数据：`E:\dsh\sessions\*`、`E:\dsh\storages\*.json`。*
