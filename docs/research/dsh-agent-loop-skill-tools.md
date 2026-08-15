# DSH 运行时插件调研报告：回合循环 / 上下文组装 / 技能 / 工具注入

> 子代理交付全文存档（2026-05）。源码均来自 `E:\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 各包的 `lib/index.js` 编译产物（含完整 JSDoc），行号引用即该文件行号；DSH_HOME=`E:\dsh`。

## 0. 结论速览

- DSH **没有字面意义上的 `onBeforeSend` 钩子**（全树 grep 无 `onBeforeSend`/`BeforeSend`）。与"发请求前"等价的是四个瀑布：`system-prompt/assemble`（组装 system 文本）、`agent/pre-step`（注入/改写回合 user 消息）、`agent/request`（改写请求 config）、`llm/stream`（包装 LLM 流本身）。
- 动态文本注入有两条官方路径：① `ctx.systemPrompt.context({name,order,text})`，由 agent-loop 的 `RuntimeContextProjection` 在每次 pre-step 差分投影成一条 "Current runtime context" user 消息；② 直接在 `agent/pre-step` 瀑布里追加 `createUserMessage(...)`（`dsh-time-context`、`dsh-tmux-context`、`dsh-agent-instructions`、`dsh-tool-skill` 都是这个模式）。
- 技能 = "目录 + 按需加载"：文件系统技能（`$DSH_HOME/skills`、`.dsh/skills`、`.agents/skills` 等根下的 `SKILL.md`/`<name>.md`，YAML frontmatter）或内存运行时技能 `ctx.skills.register(...)`。技能**正文不缓存**（每次 `get()` 重新读文件），目录摘要缓存在 `SkillRegistry.collectCache`（内存、128 条上限）。
- goal / workflow / subagent 全部**事件溯源进所属 session 日志**（`goal/change`、`tool-workflow/*`、`subagent/descriptor`），落盘为 `E:\dsh\sessions\<项目键>\<sessionId>\session.jsonl.zstd`；派生状态缓存落在 `E:\dsh\storages\session_projcache.json`。
- session-projection = 在 session 事件流上"折叠"派生状态（goal、todos 等）的注册表 + 每会话水印缓存；`session-projection-cache` 落盘并支持零 I/O 冷读（缓存行 + 尾部重放 + 回写），是低成本读取/检索与后续压缩的关键基础设施。

## 1. 回合上下文组装（顺序、service、钩子签名）

### 1.1 一次 step 的组装链路（`dsh-agent-loop/lib/index.js`）

```
ReactLoopAgent.preStep()                       // L492-514
  claimed = this.inbox.claim(target, turn)     // 领取 pending 消息（next-step + 可选 next-turn）
  assembly = await loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
  // assembleContextFor(agent, signal) → { agent, scope: agent, signal }   （dsh-agent/lib/index.js L384）
  sections = renderContextSections(assembly)   // 渲染 dynamic context 段
  context  = this.runtimeContext.project(joinContextSections(sections), sections)
  // 动态上下文变化时生成一条 user 消息（source.plugin = "@deepseek-ai/dsh-system-prompt"）
  decision = await dispatch.waterfall("agent/pre-step",
              { messages: claimed, ...position, signal },
              () => Promise.resolve({ kind: "enter",
                messages: context === undefined ? claimed : [...claimed, context] }))
  // 插件在此追加/改写 messages；返回 {kind:"enter"|"reject", messages}

turn()   // L516：append("turn/start") → 每步：把 decision.messages 逐个 append("user/message",{surfaceOp:"append"})
         //       → step() → append("step/end")；回合末 serial("agent/turn-stopping")

step(assembly)   // L606
  system = renderPrompt(assembly)              // 段落按 order 排序、{{variable}} 插值后 join
  { request, preparedCall } = buildRequest(turn, step, assembly.tools, system, this.session.deriveMessages(), signal)
  stream = preparedCall?.stream(request) ?? this.loopCtx.llm.stream(request)
  // 逐 chunk append("assistant/chunk") → BlockAssembler → append("assistant/message")
  // 有 tool-call 块 → executeToolCalls()（经 ctx.tools[TOOL_RUNTIME_SCHEDULER] prepare/dispatch/finalize/finish）

buildRequest()   // L670
  seedConfig → waterfall("agent/request", {turn, step, signal}, seed)   // 插件可改 provider/model/maxTokens/reasoningEffort
  preparedCall = loopCtx.llm.prepareCall(proposedConfig, signal)        // → {config, retryPolicy, adapterDefaults, context, stream}
  header = canonicalHeader({config, adapterDefaults, system, tools})    // system/tools 来自 assembly
  append("request/header") / append("request/context")
  return markAgentLoopRequest(deepFreeze({ ...config, messages: boundaryMessages,
                                           system?, tools?, sessionId, signal }))
```

### 1.2 System prompt 组装（`dsh-system-prompt/lib/index.js`）

- Service：`SystemPrompt`（`ctx.systemPrompt`）。构造时注册内置段：`harness:identity`（order=-100，`"You are an AI agent powered by DeepSeek Harness."`）、`deployment:persona`（order=0，`config.persona`）。
- 注册 API（全部是 effect，随调用上下文 scope 生效，作用域注册遮蔽全局同名项）：
  - `section(section)`：`{name, order(有限数), text: string | (context)=>string, complete?}`，按 `order` 升序渲染。
  - `context(context)`：`{name, order, text}` —— **动态运行时上下文注册入口**（见 §5）。
  - `variable(name, provider)`：`{{name}}` 插值变量（名须匹配 `^[a-z][a-z0-9_]*$`）；agent-loop 注册了 `provider`/`model`/`cwd`。
  - `tools(provider)`：工具 schema 提供者，每次 assembly 求值，返回 `{schemas:[{name,description,parameters}], knownNames?}`。dsh-tools 构造时用 `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))` 把全部可见工具接进装配。
  - `suppressRuntimeContext()`。
- `async assemble(context = {})`：合并全局层 + scope 链层 → 求值变量/工具/段落 → `this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, default)`（L283）→ 保证 complete 段唯一。
- 渲染：`renderPrompt(assembly)`（段插值、去空段、`\n\n` 连接）；`renderContextSections` / `joinContextSections` / `renderContextSnapshot` 渲染动态上下文。
- **顺序结论**：system 文本 = sections（order 排序）；动态上下文 = contexts 投影为 user 消息；工具 schema 经 tools provider 进入 `assembly.tools` → `request.tools`。

### 1.3 instructions / presets / skills 注入到哪

- **instructions（dsh-agent-instructions）**：不走 system prompt。首次请求前把 `AGENTS.md` 链（`$DSH_HOME/AGENTS.md` + 项目根到 cwd 各层）渲染为 `<system-reminder>` 文本，作为 **user 消息**（source `{kind:"agent-instructions", form:"instructions", baseline:true, baselineIdentity, changes}`）在 `agent/pre-step` 中 `decision.messages.toSpliced(lastClaimedIndex+1, 0, desired)` 插入（L1271-1288）；文件被 read/write/edit 工具改动后经 `tools/result` 监听重新 reconcile，并通过 `agent.inbox.prepend("next-step", desired)` 走持久 inbox。
- **presets（dsh-agent-presets）**：预设 = 目录 `agent.cordis.yml`（+ `agent.preset.yml` 元数据），根为配置 roots + `$DSH_HOME/.agent-presets`（`USER_PRESET_DIR = '.agent-presets'`）。`AgentPresets.mount(agentCtx, id)`（在 agent 工厂的 `setup(agentCtx)` 中调用）先 `ensureStanding(preset)` 建**常驻 scope 挂载**（用 `cordis-plugin-include` 的子类 `PresetTree` 把整份插件清单挂到该 scope），再 `bindScopeParent(agentKey, standing.key)` 把 agent 的 scope key 挂到挂载 scope 下——于是该预设注册的 tools / prompt sections / skills provider **经 scope 链对 agent 可见**，且随 agent 生命周期卸载。`composeFrom(agentCtx, parentCtx)` 让子 agent 继承父的同一份 composition；会话记录 `agentPreset`（header）+ `agent-preset/selected` 事件。
- **skills（dsh-tool-skill）**：在 `agent/pre-step` 注入两条 user 消息——① 技能目录 `<system-reminder><available_skills>…`（source `{kind:"skill-catalog", form:"catalog", entries}`，按 digest 去重、变更时发 replacement）；② 用户消息中的 `/技能名` 手势（`SKILL_GESTURE = /(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g`）触发对应 `<skill_content>` 注入（source `{kind:"skill-invocation", name, form:"instructions"}`）。技能正文靠模型调用 `skill` 工具按需加载（见 §2）。

### 1.4 事件/钩子目录（签名）

- **瀑布**（`ctx.on(name, async (payload, next) => …)`，subject = agent 的 scope carrier，由 `agentEvents(ctx, agent, carrier)` 提供 `emit/serial/waterfall`）：
  - `agent/pre-step`：`{agent, messages, turn, step, signal}` → `{kind:"enter"|"reject", messages}`
  - `agent/request`：`{agent, turn, step, signal}` → 请求 config
  - `agent/request-error`：`{agent, turn, step, provider, failure, retryPolicy, signal}` → `{kind:"retry"}` | undefined
  - `system-prompt/assemble`：`(assembly, context, next)`（subject 为 systemPrompt 的 scope carrier）
  - `llm/stream`（dsh-llm）：`(options: GenerateOptions, next)` → `AsyncIterable<StreamChunk>`，可包装流
  - `tools/pre-execute`（gate `{kind:"allow"|"ask", reason?}`）、`tools/execute`（around dispatch）、`tools/post-execute`（`{kind:"accept"|"block", content?, value?, additionalContexts?}`）、`tools/code-dispatch-log`
- **serial**：`agent/turn-stopping`：`{agent, turn, signal}`
- **emit**：`agent/inbox/inserted|discarded|claimed`（`{agent, message[, turn]}`）、`agent/status`、`agent/error`、`agent/created`、`agent/disposed`、`agent/session-start`、`tools/result`（`(exec, result)`）、`tools/change`、`system-prompt/change`、`skills/change`、`goal/changed`（`{agent}`）、`agent-preset/selected`、`subagent/start|end|provider-added|provider-removed`、`workflow/*`、`session/event`（`(session, event)`）

## 2. 技能机制（dsh-skill / dsh-skill-filesystem）

- 注册表：`SkillRegistry`（`ctx.skills`，`dsh-skill/lib/index.js`）：
  - `registerProvider(create)`：`create(control:{signal, invalidate})` 返回 provider `{name, list(options), get(candidate, options)}`；`list` 返回数组或 `{candidates, complete}`。
  - `register(skill)`：内存运行时技能（invocation 默认 `{modelInvocable:true, userInvocable:true}`，provider 默认 `"runtime"`）。
  - `list(options)` / `snapshot(options)`（`{skills, complete}`）/ `get(name, options)`：`options = {scope, cwd, signal}`；`get` 校验 kebab-case 名后调 provider 的 `get(candidate)`。
  - 冲突消解：层内按 `compareIndexedCandidates`（rank → providerOrder → localOrder）取优胜；`RUNTIME_RANK=250`、`BUNDLED_SKILL_RANK=600`。
  - 目录缓存：`collectCache` 内存 Map，键 = `{cwd, scopeChain, revision}`，默认上限 128 条；`invalidateCache()`（revision+1、清空、emit `skills/change`）。
- 元数据形状（`validateDefinition`）：`{name, description, whenToUse?, invocation:{modelInvocable, userInvocable}, source, provider, content, path?, resourceBase?:{kind:"directory"|"url"|"opaque",…}, metadata?}`。模型可见渲染：`renderSkillContent(skill)` → `<skill_content name="…"><skill_resources>…</skill_resources><skill_instructions>…</skill_instructions></skill_content>`。
- 文件系统 provider（`dsh-skill-filesystem/lib/index.js`）：
  - 根与优先级：`<project>/.dsh/skills`(100) → `<project>/.agents/skills`(200) → `customSkillDirs`(300) → `$DSH_HOME/skills`(400，`skipSystem:true`) → `~/.agents/skills`(500) → bundled(`DSH_BUNDLED_SKILL_DIR`, 600)。
  - 发现：`list()` 对每根 `discoverRoot()`——目录型 `<name>/SKILL.md` 或平铺 `<name>.md`；`parseSkillFile()` 解析 YAML frontmatter（`---` 包裹）：必需 `name`、`description`；可选 `whenToUse`、`disable-model-invocation`、`user-invocable`、`metadata`。
  - 加载：`get(candidate)` 每次**重新读文件并解析**（有 `ctx.fs` 走 `fs.resolve/stat/readText`，否则 node fs）——**技能正文无缓存**。
  - 变更侦测：chokidar 监听根（add/change/unlink，深度≤2，命中 `SKILL.md`/`*.md`）→ `control.invalidate()` 使目录缓存失效；`fs/observed`（write/edit 工具）同样触发。

## 3. goal / workflow / subagent 的数据记录与存储

- 共性：**一切以 session 事件日志为准**（"model-visible ⟺ logged"），存储后端 dsh-session-persistence-jsonl：`E:\dsh\sessions\<项目键>\<sessionId>\session.jsonl`（本机 zstd 压缩为 `session.jsonl.zstd`；首行 header：id/cwd/createdAt；项目键形如 `--E-dshPro--`）。会话 header 含 `agentPreset`、`seedLength` 等。
- **goal**（dsh-goal）：`GoalService`（`ctx.goals`）把每次变更 append 为 `goal/change` 事件（**整值**：`{goal:{id,revision,objective,phase,blockedReason?,maxGoalRounds}, roundsStarted, createdAt, updatedAt}`，CAS ref = id+revision；`@Remote` 方法 create/edit/pause/resume/complete/clear）；同时注册 `goal` 投影单元（last-wins fold → `GoalProjection|null`）。`dsh-goal-round-driver` 监听 `goal/changed`、`agent/status`，当 active+armed 且 agent idle 时渲染 `<goal_round>` 提示，经 `agent.followup(message)`（source `{kind:"goal", goalId, revision, round}`）排队下一轮，并在 `agent/pre-step` 校验预留有效性（失效返回 `{kind:"reject"}`）。
- **workflow**（dsh-workflow + dsh-tool-workflow）：`WorkflowEngine`（`ctx.workflowEngine`）是 Service Definition，发 `workflow/*` 事件；`dsh-tool-workflow` 监听后把 `tool-workflow/run-start|run-end|agent-start|agent-end` append 到**调用方 agent 的 session**（runId、meta.name、seq、label、phase、childId、outcome、stopReason）。
- **subagent**（dsh-subagent + dsh-subagent-in-process-driver）：每个子 agent 是**独立 session**（独立日志文件）；其 session 首事件 `subagent/descriptor`（mode/label 标识，descriptor-seed 在未发布窗口 `staged.append("subagent/descriptor", …)`）；宿主侧发 `subagent/start`/`subagent/end`（runId、childId、parent Agent）。in-process 驱动在子 agent 工厂 `setup(childCtx)` 内注册子作用域工具（如 `structured_output`）、prompt section（order 190）与 `tools.guard`。
- 投影缓存：`E:\dsh\storages\session_projcache.json`（见 §4），另有 `workspace.json`。

## 4. session-projection（会话投影/缓存）

- `dsh-session-projection`：`SessionProjectionRegistry`（`ctx.sessionProjections`）。注册单元 `register({key, schema, init(), apply(state,event), view(state), stateVersion})`；订阅 `session/event` **急切驱动**每个单元（whole-value 规则：状态事件必须携带完整后置状态）。每会话 cell 内存缓存（WeakMap，水印 seq）。读面：`snapshot(session)`（一致性切面）、`checkpoint(session)`（写面 `key→{ver,seq,val}`）、`restoreFloor(checkpoint)`、`viewCheckpoint(checkpoint)`、`restore(checkpoint, events, baseSeq)`（冷读配方）。已有键：`goal`（dsh-goal）、`todos`（dsh-tool-todo：`todo/write` 整表替换 + `turn/start` 归零）。
- `dsh-session-projection-cache`：`SessionProjectionCache`（`ctx.sessionProjectionCache`）把 checkpoint 落盘到 storage-domain `session_projcache`（version 3、`sessions` 表、记录 = `{identity:{createdAt,cwd}, rows:{key→{ver,seq,val}}}`），json 后端落在 `<root>/session_projcache.json`。写：限频 write-behind（`writeEveryEvents`/`writeIntervalMs`）+ `turn/end` 与 session 释放时强制写；读：`cachedSnapshot(meta)`（零 I/O）→ `coldSnapshot(id, signal)`（缓存行 + persistence `readFrom` 尾部 + registry `restore`，再回写）。
- 含义：投影是"从事件日志折叠出的派生状态 + 按会话水印缓存"，为上下文压缩/检索提供 O(1) 读取与冷读；对记忆插件而言它是**类型化、可持久化、可恢复的会话级状态存取机制**（注册新 projection key 即可），但它是派生缓存而非权威存储——权威始终是 session 日志。

## 5. "回合开始时注入动态文本"的现有机制（最小可复制模式）

两条官方路径均已验证：

**(A) 注册动态上下文段**（自动差分投影，适合低变更频率的运行时事实）：
```js
// 插件 apply(ctx) 内
ctx.systemPrompt.context({ name: "my-context", order: 500,
  text: (context) => `...` });
```
agent-loop 的 `RuntimeContextProjection.project(current, sections)`（`dsh-agent-loop/lib/index.js` L63-83）每次 pre-step 把渲染快照与上一条比较，变化时才 append 一条 user 消息（`"Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\n…"`，source `{kind:"plugin", plugin:"@deepseek-ai/dsh-system-prompt", form:"snapshot", sections}`）。

**(B) 直接挂 `agent/pre-step` 瀑布**（`dsh-time-context` L363-393、`dsh-tmux-context` L314-347、`dsh-agent-instructions`、`dsh-tool-skill` 均为此模式）：
```js
ctx.on("agent/pre-step", async ({ agent, turn, step, signal }, next) => {
  const decision = await next();                    // 先取默认/其他监听者结果
  if (decision.kind === "reject" || signal.aborted) return decision;
  const text = computeText();                       // 时间 / tmux 位置 / 工作区指令 / 技能目录…
  return {
    kind: "enter",
    messages: [...decision.messages, createUserMessage({
      content: [{ type: "text", text }],
      source: { kind: "plugin", plugin: "your-name", form: "snapshot", sections: [{ name, text }] }
    })]
  };
}, { prepend: true });   // prepend:true → 先于其他 pre-step 监听者
```
工程要点（来自各实现）：用"扫 session 事件"的方式做变化抑制/刷新间隔（`latestInjectionTime`/`latestInjectedState`）；时间类用 `{prepend:true}` 放最前；tmux 类只在 `step === 1` 拉取（`ctx.get("shell")` 执行查询）；指令类走 `agent.inbox.prepend("next-step", msg)` 实现**持久 inbox 注入**（跨压缩/重启仍生效）。

另需澄清：`dsh-launch-environment` **不是 prompt 注入器**——它只是启动期环境快照服务（`ctx.get("launchEnvironment")`，分层 process / project-env / user-env，`createLaunchEnvironmentSnapshot` + `launchEnvironmentOf`），供其他插件在 config/装配期读取环境变量，不进入回合 prompt。

## 6. 工具注册机制（极简骨架）

- 注册表：`ToolRuntime`（`ctx.tools`，`dsh-tools/lib/types/index.js`）：
  - `register(definition)`：`{name, description, parameters(JSON Schema), output:{schema, render(args,value), presentationMeta?}, timeoutMs?, isConcurrencySafe?(args), execute(args, exec), finalizeContent?(exec,result), presentCall?, presentResult?}`；`defineTool(options)`（`schema.js`）提供类型化封装——执行前先按参数 schema 校验（违规抛 `ToolArgsError`）。
  - `restrict({allow?,deny?})`（agent 作用域掩码）、`guard((exec)=>reason|undefined)`、`presentAs(mode)`、`get(name, scope)`、`view(scope)`、`schemas(scope)`、`executionMode(exec)`、`execute(exec)`。
  - 执行管线：`tools/pre-execute`（gate）→ guard → `tools/execute`（around）→ 工具体 → `tools/post-execute` → `finalizeContent` → `tools/result` 事件；结果可带 `additionalContexts`（进入下一步 inbox）。
  - schema 送达模型：构造时 `ctx.systemPrompt.tools(context => this.wireSchemas(context.scope))` → `assembly.tools` → `request.tools`。
- **极简工具插件骨架**（参照 dsh-tool-skill / dsh-tool-todo / dsh-subagent-in-process-driver）：
```js
const { defineTool } = require("@deepseek-ai/dsh-tools");
function apply(ctx, config) {
  ctx.tools.register(defineTool({
    name: "my_tool",
    description: "...",
    parameters: { arg: { type: "string", required: true } },
    output: {
      schema: { type: "object", additionalProperties: false, properties: {} },
      render: (_args, value) => [{ type: "text", text: String(value) }]
    },
    async execute(args, exec) {
      // exec.agent / exec.signal / exec.deferContext(ctx) / exec.concludeTurn()
      return { ... };
    }
  }));
}
```
注册在全局 ctx → 所有 agent 可见；注册在 `agent.ctx` 或预设 scope → 仅该 agent / 该预设的 agent 可见，并随作用域生命周期自动卸载。

## 7. 长期记忆插件可挂接的扩展点清单

1. **回合上下文注入**
   - `ctx.systemPrompt.context({name, order, text})`——自动差分投影为 user 消息，每回合第一步生效。
   - `ctx.on("agent/pre-step", …)` 瀑布——追加/改写 `decision.messages`（可 `{prepend:true}` 抢占、可 `{kind:"reject"}` 阻止回合）。
   - `agent.inbox.prepend/append("next-step"|"next-turn", msg)`——持久 inbox 注入（事件 `agent/inbox/spliced`，跨压缩/重启）。
   - `ctx.systemPrompt.section/variable`——向 system prompt 注入段落 / `{{变量}}`。
   - `ctx.on("session/event")`——在 `step/start`、`turn/end` 等边界触发记忆整理。
2. **工具注册与执行**
   - `ctx.tools.register(defineTool({…}))`（参数/输出 JSON Schema 严格校验）。
   - `tools/pre-execute` / `tools/execute` / `tools/post-execute` 瀑布、`tools/result` 事件（工具结果后触发记忆写入，仿 dsh-agent-instructions 的 file-touch 模式）。
   - `exec.deferContext(context)`——让工具把一段上下文带进**下一步** inbox（回合内即时注入）。
3. **技能加载**
   - `ctx.skills.register({name, description, whenToUse, content, invocation,…})`——注册内存"运行时技能"，模型经 `skill` 工具加载、目录自动出现——**记忆可以伪装成技能被技能机制读取**（正文即 `content`，无需文件）。
   - 自定义 provider：`ctx.skills.registerProvider((control)=>({name, list(options), get(candidate, options)}))`，可对接任意存储/检索（`locator` 透传、`rank` 控制优先级）。
   - 文件系统侧：写 `<dshHome>/skills/<name>/SKILL.md` 或 `<project>/.dsh/skills/*.md`（frontmatter：name/description/whenToUse/metadata），watch 自动生效。
4. **会话级派生状态（投影）**
   - `ctx.sessionProjections.register({key, schema, init, apply, view, stateVersion})`——新增持久化、可冷读、随事件急切更新的会话状态（如记忆索引摘要），由 `session-projection-cache` 落盘 `session_projcache.json`；变更经 `onChanged(listener)` 通知。
5. **组合/作用域**
   - `agentPresets.mount` / `composeFrom` 与 `dsh-scope`（`createScope`/`bindScopeParent`/`scopeTarget`/`ScopedLayers.chainLayers`）：把记忆插件放进 agent preset 的 `agent.cordis.yml`，每个 agent 即获得其工具/提示段/技能 provider，且随 agent 生命周期自动卸载；scope 链保证父 preset 的监听器收到子 agent 事件。
6. **事件溯源与审计**
   - `session.append(type, data, {surfaceOp:"append", sourceEventSeqs})` 追加自定义记忆事件（如 `memory/write`），`surfaceOp` 决定模型可见性（`user/message` 可见、其余仅日志）；复用 `turn/end`、`request/header` 等边界做持久化检查点（goal-round-driver 用 `ctx.sessions.flush(session)`）。

**关键文件路径**（均相对 `@deepseek-ai\dsh\node_modules\@deepseek-ai\`）：`dsh-agent-loop/lib/index.js`、`dsh-agent/lib/index.js`、`dsh-system-prompt/lib/index.js`、`dsh-agent-instructions/lib/index.js`、`dsh-agent-presets/lib/types/{index,discovery,mount,session}.js`、`dsh-skill/lib/index.js`、`dsh-skill-filesystem/lib/index.js`、`dsh-tool-skill/lib/index.js`、`dsh-tools/lib/types/{index,schema}.js`、`dsh-goal/lib/types/index.js`、`dsh-goal-round-driver/lib/index.js`、`dsh-workflow/lib/types/*`、`dsh-tool-workflow/lib/types/index.js`、`dsh-subagent/lib/*`、`dsh-subagent-in-process-driver/lib/index.js`、`dsh-session-projection/lib/types/index.js`、`dsh-session-projection-cache/lib/index.js`、`dsh-time-context/lib/index.js`、`dsh-tmux-context/lib/index.js`、`dsh-launch-environment/lib/index.js`、`dsh-scope/lib/index.js`、`dsh-session-persistence-jsonl/lib/index.js`、`dsh-home-paths/lib/index.js`、`dsh-session/lib/index.js`、`dsh-llm/lib/index.js`。
