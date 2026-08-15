# DSH 长期记忆与自进化插件设计方案（dsh-memory）

> 状态：设计草案 v0.2（已完成 DSH 内部 API 源码调研并回填，附录 A 为实测清单）
> 目标宿主：DeepSeek Harness（`@deepseek-ai/dsh`，Cordis/Koishi 插件体系）
> 日期：2026-05

---

## 0. TL;DR（结论先行）

1. **DSH 现状**：有**会话级**的持久化、压缩、溢出、技能、目标等大量"记忆基元"，但**没有跨会话的语义记忆层**，也没有"从经验中自进化"的机制——这正是本插件的补位点。
2. **开源参照**：腾讯 **TencentDB Agent Memory**（MIT）是目前最对口的参考实现——四层语义金字塔（L0 对话录制 → L1 原子记忆提取 → L2 场景归纳 → L3 用户画像）、对话前自动召回、BM25+向量混合检索、技能抽取（SOP）、上下文卸载，官方数据可**节省约 61% token、任务通过率提升约 51%**。且社区已有移植 **`dsh-tdai-memory`**（v0.2.7，把腾讯四层搬进了 DSH）。
3. **建议方案**：**自研原生插件 `dsh-memory`**（方案 B），架构上借鉴腾讯四层金字塔与 `dsh-tdai-memory` 的移植经验，但**复用 DSH 自有服务**（`ctx.llm` 统一模型栈、`session/event`+`session/flush` 事件、`agent/pre-step`/`systemPrompt.context` 注入、`ctx.sessionQuery` 全文检索、`dsh-skill`、`dsh-schedule`、`ctx.storageDomain`），并做**可插拔存储后端**（本地 SQLite+FTS5+sqlite-vec / 可选腾讯 TCVDB）。不直接依赖 `dsh-tdai-memory`，但与其数据目录**兼容可选**（`--import tdai`）。两份 DSH 源码调研确认：**长期记忆/向量检索在 DSH 中是完全空白地带**，且已盘点出全部可挂接扩展点（见附录 A）。
4. **自进化 = 三层闭环**：① 记忆巩固（episodic→semantic 抽象与去重）；② 遗忘/衰减与用户纠正反馈；③ 技能合成（从成功轨迹抽取可复用 SOP，写入 DSH 技能系统）。

---

## 1. 背景与目标

### 1.1 DSH 现状盘点（源码调研结论）

DSH（DeepSeek Harness）是一个基于 Cordis/Koishi 的插件化 Agent 运行时。现状：

| 已有能力       | 对应包                                                                                                         | 与"记忆"的关系                         |
| ---------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------- |
| 会话事件流      | `dsh-session`（`turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/context`…） | 记忆的**原始素材来源**                    |
| 会话持久化      | `dsh-session-persistence(-jsonl)`、`dsh-session-query(-sqlite)`                                              | 原始对话落盘/查询，但**按会话隔离**             |
| 上下文压缩/溢出   | `dsh-compaction`、`dsh-spill`                                                                                | 处理"当前上下文放不下"，与记忆互补               |
| 技能         | `dsh-skill`、`dsh-skill-filesystem`                                                                          | 程序性知识（SOP）的归宿，自进化的落点             |
| 目标/工作流/子代理 | `dsh-goal`、`dsh-workflow`、`dsh-subagent`                                                                    | 长任务记忆与轨迹来源                       |
| 动态上下文注入范例  | `dsh-time-context`（`system-prompt/assemble` 钩子）                                                             | 召回注入的**现成模式**                    |
| 用户反馈       | `dsh-message-feedback`                                                                                      | 记忆修正/进化的信号源                      |
| 会话全文检索     | `dsh-session-query` + `dsh-session-query-sqlite`（`ctx.sessionQuery.searchSessions()`，FTS5）                  | **L0 对话搜索可直接复用**，无需自建全文索引        |
| LLM 服务     | `dsh-llm`（`ctx.llm.stream()` + `BlockAssembler`）                                                            | 提取/巩固/画像/技能统一走 DSH 模型栈，与用户当前模型一致 |
| 通用存储       | `dsh-storage(-json)`、`dsh-settings(-file)`                                                                  | 插件持久化与配置                         |
| 调度         | `dsh-schedule`                                                                                              | 后台管线（提取/巩固）定时器                   |
| 工具注册       | `dsh-tools`（`ctx.tools.register()` + `defineTool()`）                                                        | 记忆搜索/修正工具                        |
| 设置面板       | `dsh-settings`（`ctx.settings.register(ns, schema)`）                                                         | 配置命名空间，Web UI 自动渲染               |

**缺口**：没有任何插件做「跨会话**语义**提取 → 结构化记忆库 → 按需召回注入 → 随时间巩固/遗忘/进化」。注意：DSH 已有的 `ctx.sessionQuery` 只是**词面全文检索**（`recall` 在 DSH 语境里指显式引用快照），没有 embedding/向量检索/长期记忆库——这正是本插件的补位点。

### 1.2 用户诉求

- 给 DSH 增加**长期记忆**：跨会话记住事实、偏好、事件、指令、用户画像，并在合适时机自动注入上下文。
- 增加**自进化**：不是简单"记住聊天记录"，而是像人一样**沉淀经验、归纳规律、形成技能、逐步修正画像**。
- 尽量**基于已有开源成果**（如 TencentDB Agent Memory），避免从零造轮子。

---

## 2. 开源方案调研结论

### 2.1 TencentDB Agent Memory（主参照）

- 项目：`TencentCloud/TencentDB-Agent-Memory`（MIT），腾讯云开源，原为 OpenClaw 插件 `@tencentdb-agent-memory/memory-tencentdb`。
- 公开数据：最高省 **61.38% token**，任务通过率提升 **51.52%**（SWE-bench 58.4 → 64.2）。
- 核心思想：**语义金字塔 L0→L3**，把"自然语言空间"逐步蒸馏到"代码实体空间"：
  - **L0 对话录制**：拦截会话，原始消息落盘（JSONL + 存储后端），可配置保留天数/清理。
  - **L1 记忆提取**：LLM 从对话提取**原子记忆**（短结构事实），按类型区分（persona / episodic / instruction），带向量去重与冲突检测，限制单次条数。
  - **L2 场景归纳**：L1 记忆聚合成场景块（Scene Block，Markdown），形成"过去经验的目录"。
  - **L3 用户画像**：基于场景块生成/更新 persona.md，带版本备份。
- **管线调度**：全部异步、不阻塞主对话；按 `everyNConversations`（默认 5）或空闲超时触发 L1；warm-up 模式（1→2→4…翻倍）；L2/L3 有各自的延迟与最小间隔。
- **召回（双路）**：
  - 被动自动召回：对话开始前（before_prompt_build）按当前用户消息检索 L1 + 注入 L2 场景地图 + L3 画像；**动态内容 prepend 到 user 消息，稳定内容 append 到 system prompt**（缓存友好）；带超时（默认 5s）。
  - 主动工具召回：`tdai_memory_search`（L1 结构化搜索）、`tdai_conversation_search`（L0 全文搜索），并注入 `MEMORY_TOOLS_GUIDE` 使用指引。
  - 检索策略：**关键词（FTS5/BM25）｜向量（Embedding）｜混合（RRF 融合）** 三种，可配。
- **存储**：`sqlite`（本地 SQLite + sqlite-vec，`vectors.db`，纯离线）或 `tcvdb`（腾讯云向量数据库，服务端 embedding + hybridSearch）。分词用 `tcvdb-text`（BM25，中英混合）。
- **技能系统（自进化雏形）**：从 L0 对话轨迹异步抽取**可复用 SOP**（SkillExtractor，LLM 分析 + 头尾截断控制 token），支持 create/update/patch/delete，**版本化、append-only 历史**、权限控制。
- **上下文卸载**：Offload Engine + 压缩分级 + token 计量 + 本地小模型跑卸载任务；还有 Mermaid 任务画布（符号记忆）。
- **周边**：MemoryProxy（LLM 请求代理注入）、MemoryKnowledge（Wiki/CodeGraph）、MemoryPanel（Web 管理 UI）、元数据/多租户/权限、TS/Python SDK、OTel 观测。

> 结论：腾讯这套 = 「记忆管线 + 召回 + 技能进化 + 上下文治理」的完整参照系。但它是 OpenClaw 宿主插件，直接搬进 DSH 需要适配层。

### 2.2 已有 DSH 移植：`dsh-tdai-memory`（v0.2.7，MIT，作者 Scorp1o117）

npm 上已存在，正是"腾讯四层记忆移植进 DSH"：

- **做法**：复用 tdai 的 host 无关 core（tsc 编译成 ESM，零改动）+ `StandaloneHostAdapter`（直连 OpenAI 兼容接口）+ DSH shell（事件捕获、召回注入、工具注册、生命周期）。
- **已打通的关键接线**（对我们极有价值的移植经验）：
  - 捕获：监听 **`session/flush`**（必须 await 完成，headless 退出前要等 L1 收尾）；`turn/start` 时间戳作为 L0 游标下限；按 turn id 去重。
  - 召回注入：必须在 **`agent.ctx`（agent scope）** 上监听 `system-prompt/assemble`（根作用域监听不到装配过程）；在 `session/created` 后一 tick，通过 `agents` 服务解析出 agent 再注册。
  - headless 一次性运行：在 flush 内 `core.handleSessionEnd()` 等 L1 提取完成，否则 5s 关停超时会杀掉管线。
  - 工具：`tdai_memory_search`、`tdai_conversation_search`。
  - 配置：settings 命名空间驱动（profile patch 打底 + `$DSH_HOME/settings.yaml` 覆盖），Web UI 设置栏。
  - 数据目录：复用 `~/.memory-tencentdb/memory-tdai`，与腾讯系其它宿主**数据兼容**。
- **已知痛点（可作为我们自研的改进点）**：
  1. 提取模型 JSON 稳定性：`deepseek-v4-flash` 输出不合规 JSON（提取 0 条），作者只能换 `mimo-v2.5`（慢 20-30s/次）。
  2. 去重（冲突检测）LLM 输出解析不稳，默认关闭。
  3. embedding 依赖外部 OpenAI 兼容端点（本地 8088）。
  4. 内部 core 为"OpenClaw 世界观"（agent/gateway 概念），与 DSH 的 session/scope 语义有阻抗。

### 2.3 其它框架（横向对照，供设计取舍）

| 框架 | 思路 | 可借鉴点 | 与 DSH 适配难度 |
|---|---|---|---|
| **Mem0** | LLM 提取事实/偏好，ADD/UPDATE/DELETE/SEARCH API，向量库+图 | 记忆操作的**显式 API**、跨 session 合并更新 | 中（纯库，需自接宿主） |
| **Letta (MemGPT)** | 操作系统式内存层级 + **sleep-time compute**（异步后台思考/巩固） | "睡眠时巩固"的异步进化范式 | 高（自研服务器） |
| **Zep (Graphiti)** | 时序知识图谱 + 双时间轴实体/边 | 实体关系记忆、时间感知 | 中高（要图库） |
| **Cognee** | ECL 管线（Extract-Cognify-Load）做知识图谱 | 结构化抽取管线 | 中 |

> 腾讯四层是**唯一已证明能在 DSH 上跑通**的完整方案（经 `dsh-tdai-memory`），因此设计以它为主参照。

---

## 3. 方案选型

### 方案 A：直接用 `dsh-tdai-memory`
- 优点：零开发，开箱即用；数据与腾讯系兼容。
- 缺点：受制于其 adapter/外部 embedding 依赖、提取模型 JSON 稳定性问题、OpenClaw 世界观与 DSH 语义的错位、升级要重编译 dist、后续自定义（自进化/技能合成）要改别人的 core。

### 方案 B（推荐）：自研原生 `dsh-memory`
- **架构借鉴**：L0→L3 语义金字塔 + 双路召回 + 混合检索 + 技能进化，全部对齐腾讯设计（保持"同构"）。
- **实现原生**：捕获/注入/工具/配置全部走 DSH 自己的服务与事件（见第 4、5 节），LLM 调用复用 `ctx.llm`（与用户当前模型一致，不再需要外部端点）。
- **存储可插拔**：默认本地 SQLite（FTS5 + sqlite-vec + JSONL，纯离线）；可选 TCVDB 后端（对接腾讯云向量库，与官方生态互通）。
- **数据兼容可选**：提供 `--import tdai` 迁移命令读 `~/.memory-tencentdb/memory-tdai`，旧数据无缝续用。
- 缺点：开发量最大；需要维护。

### 方案 C：B + 临时垫片
- 在 B 落地前，先装 `dsh-tdai-memory` 应急，同时按 B 开发；B 上线后迁移。适合想立刻见效的场景。

> **推荐 B**（长期最优；若用户想"先有后优"则 C）。以下按 B 展开设计，同时把 A 的移植坑全部列成"必须绕开的雷区"。

---

## 4. 总体架构

```
┌──────────────────────────── DSH profile (cordis patch) ───────────────────────────┐
│                                                                                    │
│  ┌───────────────┐   session/event, session/flush   ┌───────────────────────────┐  │
│  │ dsh-agent-loop │ ───────────────────────────────▶ │   dsh-memory (本插件)      │  │
│  │ (每回合事件流)   │                                  │                           │  │
│  └───────────────┘                                  │  ├ Capture (L0 录制)        │  │
│  ┌───────────────┐   system-prompt/assemble(agent)  │  ├ Extract (L1 提取)        │  │
│  │ dsh-system-    │ ◀─────────────────────────────── │  ├ Consolidate (L2/L3)     │  │
│  │ prompt 装配     │   召回注入（prepend/append）        │  ├ Evolve (技能/画像进化)   │  │
│  └───────────────┘                                  │  ├ Recall (检索服务)        │  │
│  ┌───────────────┐   tool 注册（memory_search…）      │  └──┬────────────────────┘  │
│  │ dsh-tools      │ ◀─────────────────────────────── │     │                      │
│  └───────────────┘                                  │     ▼                      │
│  ┌───────────────┐   ctx.llm（提取/巩固/画像/技能）      │  ┌─────────────────────┐  │
│  │ dsh-llm       │ ◀─────────────────────────────── │  │ Store 抽象            │  │
│  └───────────────┘                                  │  │  sqlite(默认)/tcvdb   │  │
│  ┌───────────────┐   dsh-schedule 后台管线调度          │  └─────────────────────┘  │
│  │ dsh-schedule  │ ◀─────────────────────────────── │                           │
│  └───────────────┘                                  └───────────────────────────┘
└────────────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 模块划分（单包多 service，或按包拆分）

> 关键取舍：**L0 不重复造轮子**——原始对话的落盘与全文检索由 DSH 既有能力承担（`dsh-session-persistence-*` + `ctx.sessionQuery`）；本插件自建的是 **L1 语义记忆库（SQLite+向量）+ L2/L3 巩固 + 进化 + 召回注入**。自建的 `conversations/` JSONL 仅作为提取管线的**输入切片**（与腾讯数据目录同构，便于迁移/备份），不做全文索引。

| 模块 | 职责 | 对应腾讯概念 |
|---|---|---|
| `capture` | 订阅会话事件，把对话归一化为提取管线输入（L0 切片）；游标管理（`turn/start` seq 下限、按 session+turn 幂等）；`conversation_search` 直接代理到 `ctx.sessionQuery.searchSessions()` | L0 Auto-Capture |
| `extract` | 后台队列消费未处理的 L0 切片，调 `ctx.llm.stream()` 提取原子记忆（事实/偏好/事件/指令），去重+冲突检测后写入 L1 | L1 Memory Extraction |
| `consolidate` | 周期把 L1 归纳为场景块（L2），再合成/更新画像（L3，带版本） | L2/L3 |
| `evolve` | 自进化：记忆巩固抽象、衰减遗忘、技能合成（→`dsh-skill` 仓库写 Markdown+frontmatter）、画像反馈修正 | Skill System + 巩固 |
| `recall` | 检索服务：keyword(FTS5，中文分词可接 jieba)/vector(sqlite-vec)/hybrid(RRF)；对外提供 `memory.recall()` | Auto-Recall |
| `inject` | `system-prompt/assemble` 钩子（agent scope）：动态召回 prepend、稳定画像 append；超时保护 | Recall Injection |
| `tools` | 注册 `memory_search` / `conversation_search`（代理 `ctx.sessionQuery`）/ `memory_forget` / `memory_correct` 等工具 + 使用指引注入 | Agent-Callable Tools |
| `ui` | 设置命名空间（`ctx.settings.register('dsh-memory', schema)`）+ 记忆浏览器（可选前端） | MemoryPanel |
| `store` | 存储抽象（sqlite / tcvdb 后端），数据目录与迁移 | IMemoryStore |

### 4.2 数据目录（默认，本地优先）

```
$DSH_HOME/storages/memory.json      # 权威记忆域（storage-domain 落盘，仿 session_projcache.json）
$DSH_HOME/storages/memory_meta.json # manifest / schema 版本 / 迁移记录（或并入 memory.json）
$DSH_HOME/memory/                   # 派生索引与提取输入（均可重建）
├── conversations/    L0 提取输入切片 JSONL（按 session/turn 分片；权威原文仍在 sessions/ 日志）
├── records/          L1 原子记忆 JSONL（与 SQLite 双写，便于备份/迁移）
├── scenes/           L2 场景块 .md（含时间范围、来源记忆 id 列表）
├── persona.md        L3 画像（带 .bak 版本）
├── memory.db         SQLite：memories 主表 + FTS5（可丢弃派生读模型）
├── vectors.db        sqlite-vec vec0 向量表（可丢弃派生读模型）
└── .metadata/        manifest（store 绑定、schema 版本、seed/迁移记录）
```

> 权威性分层：**会话日志（sessions/*.jsonl.zstd，DSH 所有）> 记忆域（storages/memory.json，本插件所有）> 派生索引（memory.db / vectors.db / JSONL 切片，可重建）**。

### 4.3 写入路径（Capture 生命周期，关键雷区）

DSH 的会话是**追加式事件溯源日志**（`session.jsonl[.zstd]`，权威真源）；持久化由 `dsh-session-persistence-jsonl` 承担（200ms write-behind 批窗口 + `session/flush` 停稳屏障）。记忆插件**只读会话、不改写**：

```
session 创建 → 订阅 agent 的 session 事件
  每回合：user/message, assistant/message, tool/call, tool/result, request/context …
    → session/event（post-commit）→ capture 归一化 → 追加本插件的提取输入切片（异步，不阻塞热路径）
turn/start  → 记录游标下限（防止与 compaction/spill 后的历史重复捕获）
session/flush → await 落盘（与日志持久化同一屏障，记忆不领先/落后于日志）
  headless 模式：flush 内同步触发 extract 收尾，避免 5s 关停超时杀管线
agent/request-error(context-overflow) → 同步把即将被压缩遮蔽的内容先固化进记忆库（"压缩即遗忘"钩子）
```

雷区清单（来自 `dsh-tdai-memory` 实战 + 两份源码调研）：
1. `session/flush` 是**持久化屏障**，监听器必须 `await`（DSH 会等待全部 flush 回调）；写路径有 200ms 批窗口，记忆写入要与之对齐。
2. 动态召回注入的**官方正路是 `agent/pre-step`（prepend）瀑布**——仿 `dsh-time-context` 追加一条 `user/message`（`source:{kind:'plugin', plugin:'<name>', form:'snapshot'}`），模型可见、可回放、可审计；或在 `ctx.systemPrompt.context({name,order,text})` 注册动态上下文段（agent-loop 自动差分投影成 "Current runtime context" user 消息）。`system-prompt/assemble`（agent scope）也可用（dsh-tdai-memory 的路线），但需要自行处理渲染细节。
3. 捕获要防**重复/回流**：compaction 用 `surfaceOp.replace` 遮蔽历史、spill 溢出大文本——都需按 (session, turn, seq) 幂等，且理解 **surface（派生消息历史）≠ 原始事件**。
4. 提取任务绝不可阻塞主对话：全部进后台队列 + `dsh-schedule` 定时器 + 空闲触发。
5. 自建记忆库的**权威数据放自己的 storage domain**（`ctx.storageDomain.open`，落 `$DSH_HOME/storages/memory.json`）；SQLite 派生索引（FTS/向量）只当**可丢弃读模型**（DSH 的 session-query 索引就是可重建的，别把权威数据放进去）。

### 4.4 召回路径（Injection，两条官方正路）

- **动态部分（每回合变，按当前 user 消息检索）**：两条官方路径，推荐前者：
  1. **`agent/pre-step`（`{prepend:true}`）瀑布**：先 `await next()` 拿默认决策，再把召回渲染成一条 `user/message` 追加进 `decision.messages`（`source:{kind:'plugin', plugin:'dsh-memory', form:'snapshot'}`）——与腾讯"prepend 到 user 消息"同构，模型可见、可回放、可审计（`dsh-time-context` 同款模式）。
  2. **`ctx.systemPrompt.context({name, order, text})`**：注册动态上下文段，agent-loop 的 `RuntimeContextProjection` 每次 pre-step 差分投影成 "Current runtime context" user 消息（变化才发）——适合**低变更频率**的稳定摘要（如画像 digest），不适合每回合都变的检索结果（避免差分噪声）。
- **稳定部分（会话级）**：L2 场景地图（目录）+ L3 画像摘要，用路径 2（`systemPrompt.context`）或 `system-prompt/assemble` append 到 system prompt，可缓存。
- **模型侧使用指引（`MEMORY_TOOLS_GUIDE`）**：`systemPrompt.section` 注入，告诉模型何时该用 `memory_search` 深挖而不是只依赖自动召回。
- 所有检索带超时（默认 5s）与失败降级（检索失败 → 跳过注入，绝不阻塞回合）。

### 4.5 配置（对齐 DSH 的 settings 模式）

```yaml
# $DSH_HOME/settings.yaml
dsh-memory:
  store: sqlite            # sqlite | tcvdb
  capture:
    enabled: true
    excludeAgents: ['bench-*']
    retentionDays: 90      # 0 = 不清理
  extract:
    enabled: true
    everyNTurns: 5         # 或空闲 60s 触发
    maxPerBatch: 20
    model: ''              # 空 = 跟随 ctx.llm 当前模型
    dedup: true
  consolidate:
    sceneMax: 15
    personaEveryN: 50
  recall:
    enabled: true
    strategy: hybrid       # keyword | embedding | hybrid
    maxResults: 5
    scoreThreshold: 0.3
    timeoutMs: 5000
  evolve:
    skillExtraction: true  # 成功轨迹 → dsh-skill SOP
    decayDays: 180         # 遗忘衰减
  tcvdb:                   # 可选后端
    url: ''
    apiKey: ''
    database: ''
```

---

## 5. 数据模型

### 5.1 L1 原子记忆（核心表 `memories`）

| 字段 | 说明 |
|---|---|
| `id` | uuid |
| `session_id` / `turn` / `seq` | 来源定位（可追溯） |
| `kind` | `fact` / `preference` / `event` / `instruction` / `persona` |
| `content` | 结构化事实文本（原子、可独立检索） |
| `embedding` | vec0 列（维度随 embedding 模型配置） |
| `keywords` / FTS | BM25 索引列 |
| `importance` | 1-10（LLM 提取时给出，参与衰减） |
| `access_count` / `last_access` | 召回命中计数，用于遗忘 |
| `created_at` / `updated_at` | 时间 |
| `source` | `capture` / `extract` / `evolve` / `user` |
| `status` | `active` / `decayed` / `forgotten` / `corrected` |
| `supersedes` | 指向被替代的记忆 id（去重/修正链） |

### 5.2 检索（三策略复用腾讯设计）

- **keyword**：SQLite FTS5 + BM25 排名（中文分词：可选 `@node-rs/jieba` 或 tcvdb-text）；会话级全文可直连 `ctx.sessionQuery.searchSessions()`（DSH 自带）。
- **embedding**：`vectors.db` vec0 表 + 余弦距离；embedding 服务抽象（默认复用 ctx.llm 提供商或本地端点；可选 TCVDB 服务端 embedding）。
- **hybrid**：RRF 融合两路 top-k。

### 5.3 持久层实现要点（对齐 DSH 惯例）

- **权威数据**：`ctx.storageDomain.open(defineDomain({name:'memory', version:1, tables:{ memories: domainTable(memorySchema), scenes: …, meta: … }}))`——仿 `dsh-session-projection-cache`（`$DSH_HOME/storages/session_projcache.json` 即其产物），JSON 后端原子整文件重写，`domain/changed` 事件可做索引联动。
- **派生索引**：SQLite（FTS5 + vec0）只做检索读模型，schema 版本不匹配即重建（对齐 DSH 自己的 session-query 索引语义）；重建源 = memory 域 + records/ JSONL。
- **会话级派生状态**：`ctx.sessionProjections.register({key:'memoryDigest', …})` 注册投影单元，`session-projection-cache` 自动持久化到 `session_projcache` 域，跨重启 O(1) 冷读（如"本会话已抽取的记忆摘要"）。
- **自定义事件**：`declare module '@deepseek-ai/dsh-session/types' { interface SessionEventMap { 'memory/write': … } }` + `session.append('memory/write', data, {surfaceOp:'append', sourceEventSeqs})`——记忆写入进会话日志（审计/回放），`surfaceOp` 控制模型可见性。

### 5.4 自进化的数据流（三层闭环）

```
L0 对话轨迹
  │  extract（LLM）
  ▼
L1 原子记忆 ──去重/冲突检测──▶ 更新 or 新增（supersedes 链）
  │  consolidate（LLM 归纳）
  ▼
L2 场景块（Markdown，来源 id 列表）
  │  synthesize
  ▼
L3 persona.md（版本化，.bak 轮换）
  ▲
  │ 反馈修正：memory_correct / message-feedback / goal 完成
  │
技能进化（独立支线）：
L0 成功轨迹（goal 完成 / 用户确认 / 轨迹评分高）
  │  evolve.skill（LLM 抽取 SOP：触发条件+步骤+注意事项）
  ▼
dsh-skill 仓库（可复用、可版本、可被 agent 加载）
```

---

## 6. 自进化设计（用户核心诉求）

1. **记忆巩固（Consolidation）**：定期用 LLM 把高相似度、低价值的 episode 抽象成一条语义记忆（episodic → semantic），原 episode 降权；与腾讯/Letta 的"睡眠时计算"对齐——在 `dsh-schedule` 空闲时段跑。
2. **遗忘与衰减（Forgetting）**：`importance × recency × access_count` 评分，低于阈值标记 `decayed` → 定期清理；可配置保留策略（对齐腾讯 `l0l1RetentionDays`）。
3. **"压缩即遗忘"钩子**：监听 `agent/request-error`（`CONTEXT_WINDOW_EXCEEDED`）与 `compaction/*` 事件，在 compaction 用 `surfaceOp.replace` 遮蔽旧内容**之前**，把即将被遮蔽的对话先固化进记忆库——上下文压缩与长期记忆在此交汇，压缩不再等于丢失。
4. **用户纠正闭环（Feedback）**：`memory_correct(old, new)` / `memory_forget(id)` 工具 + 监听 `dsh-message-feedback`——纠正后沿 `supersedes` 链传播，画像下次合成时纳入修正。
5. **技能合成（Skill Synthesis）**：把"目标达成 + 用户正向反馈"的轨迹交给 LLM 提炼为 SOP（触发条件/步骤/注意事项/反例），写入 `dsh-skill` 仓库（`$DSH_HOME/skills/<name>/SKILL.md`，frontmatter：name/description/whenToUse）并版本化；agent 后续遇到同类任务时通过技能目录+`skill` 工具自动获得程序性记忆——这是"自进化"最直观的形态。
6. **画像演化（Persona Drift）**：L3 画像随新记忆增量更新而非整体重写，保留历史版本便于回溯与回滚。
7. **可观测**：`session.append('memory/write', …)` 自定义事件进会话日志（回放/审计），`memoryDigest` 投影单元经 `session-projection-cache` 跨重启恢复。

---

## 7. 安全与隐私

- 默认**全本地**：SQLite + JSONL 均在 `$DSH_HOME` 下，无外部网络（除非启用 TCVDB/云端 embedding）。
- 召回注入范围控制：`excludeAgents` / `scopes` 过滤；敏感内容类型（如凭据）由提取提示词排除 + 正则过滤。
- 可选：`memory.db` 加密（SQLCipher 派生），L0 保留期强制下限防误删。
- 遗忘即删除：`forget` 同时清 FTS/向量/JSONL 引用，遵循"可被遗忘"。

---

## 8. 实施路线图

| 里程碑 | 内容 | 验收 |
|---|---|---|
| **M0 探针** | 最小插件：监听 `session/event`/`session/flush` 落 L0 JSONL；`system-prompt/assemble` 注入一行占位；注册一个空工具 | 在 web profile 安装后，观察事件与注入生效；headless 退出不丢数据 |
| **M1 记忆库** | SQLite schema + FTS5 + sqlite-vec；capture 幂等；`memory_search`/`conversation_search` 工具 | 跨会话搜索到已记录的对话/记忆 |
| **M2 提取管线** | `ctx.llm` 提取 L1（含 JSON 校验/重试/回退）；去重+冲突检测；后台调度 | 多轮对话后 L1 有条目且无重复 |
| **M3 召回注入** | agent scope 装配钩子：动态 prepend + 稳定 append；hybrid 检索；超时保护；使用指引 | 新会话开头模型"记得"相关历史 |
| **M4 自进化** | L2/L3 归纳与画像版本；巩固/衰减/遗忘；`memory_correct`/`memory_forget`；技能合成写入 `dsh-skill` | 画像随对话演化；重复任务一次比一次顺；技能可被复用 |
| **M5 打磨** | Web UI 记忆浏览器与设置；`--import tdai` 迁移；TCVDB 后端；文档 | 可交付给普通用户 |

> 建议先做 M0（1-2 天）验证接线，再决定是否继续。

---

## 9. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 提取 LLM JSON 不稳定（`dsh-tdai-memory` 的教训：flash 提取 0 条） | 结构化输出约束/JSON schema 校验 + 重试 + 坏输出回退到"原文摘要"；提取模型可独立配置 |
| 注入上下文膨胀 | 稳定/动态分流、token 预算与超时、召回阈值、按需工具深挖 |
| 与 compaction/spill 的相互干扰 | 幂等游标；召回基于持久化存储而非会话内存 |
| 后台 LLM 成本/延迟 | 空闲触发 + warm-up 翻倍调度；批量合并；可关 |
| 多会话/多 scope 一致性 | 数据按 session 溯源，画像按用户维度聚合；`excludeAgents` |
| headless 关停丢管线 | flush 内 await 收尾（学 dsh-tdai-memory 的接线） |

---

## 10. 参考资料

- TencentDB Agent Memory 开源仓库：<https://github.com/TencentCloud/TencentDB-Agent-Memory>
- ClawHub 文档（配置/原理）：<https://docs.clawhub.ai/tencentdb-agent-memory/plugins/memory-tencentdb>
- DeepWiki 架构文档（Memory Pipeline / Recall / Skill System / Context Offload）：<https://deepwiki.com/TencentCloud/TencentDB-Agent-Memory>
- 腾讯开源报道（token 降 61%）：<https://cloud.tencent.com.cn/developer/article/2668918>
- DSH 移植插件：<https://www.npmjs.com/package/dsh-tdai-memory>（GitHub: Scorp1o117/dsh-tdai-memory）
- 横向对照：<https://forum.letta.com/t/agent-memory-solutions-letta-vs-mem0-vs-zep-vs-cognee/85>

## 11. 配套调研文件（本工作区）

- `design/dsh-memory-detailed-design.md` —— **细化设计**：全套架构图（上下文/组件/时序/流程/ER/状态机）、UI 交互设计（设置面板+记忆浏览器）、运行时随时启停机制
- `research/dsh-session-memory-data-layer.md` —— DSH 会话/记忆/压缩数据层完整调研（18 个包：事件模型、磁盘布局、持久化/查询/压缩/spill/存储域 API、12 个扩展点）
- `research/dsh-agent-loop-skill-tools.md` —— 回合循环/上下文组装/技能/工具注入完整调研（事件钩子签名、注入范式、扩展点清单）

---

## 12. 合规与开源许可说明（通俗版结论）

**结论：方案 B（自研原生插件）+ 纯本地存储 → 法律风险很低，不违反开源协议**，只需遵守几条简单规则（见 12.4 行动清单）。本插件、DSH、全部拟依赖组件均为 MIT 系宽松协议，无传染性、可商用、可闭源。

### 12.1 各相关方许可实测

| 对象 | 协议 | 实测来源 |
|---|---|---|
| DSH（`@deepseek-ai/*` 全部包） | MIT（© 2026 DeepSeek） | 本机 `LICENSE` 与 `package.json` |
| TencentDB Agent Memory | MIT | 官方仓库/ClawHub 文档 |
| dsh-tdai-memory（社区移植） | MIT | npm README |
| sqlite-vec（向量检索） | MIT OR Apache-2.0 | npm registry |
| @node-rs/jieba（中文分词） | MIT | npm registry |
| node-llama-cpp（本地 embedding，可选） | MIT | npm registry |

### 12.2 为什么不违规（三层逻辑）

1. **抄"思路"不需要许可**：四层金字塔（L0-L3）、混合检索（BM25+向量+RRF）、画像/场景这些是**设计概念**，不受版权保护。方案 B 采纳腾讯的设计思路，不复制其代码。
2. **MIT 协议几乎不设限**：允许使用、复制、修改、合并、商用、闭源、再分发。唯一硬性义务：**如果复制/分发他人代码（或其中实质性部分），必须保留其版权声明**。方案 B 用 DSH 自有零件重新实现，基本不触发该义务；若代码中确实引用了腾讯/dsh-tdai-memory 的片段，保留其版权注释即可。
3. **依赖全宽松，无传染性**：与 GPL 不同，MIT 不要求你把自己的代码开源。即使闭源商用也合法。

### 12.3 需要小心的点（不是违规，但要规避）

- **商标**：不要用 "Tencent"、"腾讯云"、"TencentDB" 作为插件名或宣传语（避免"官方背书"的误导）。建议命名 `dsh-memory`，并在 README 注明"架构启发自 TencentDB Agent Memory（MIT），与腾讯无隶属关系、非官方出品"。
- **专利**：MIT 不含 Apache 2.0 那种明确专利授权条款。理论上腾讯可就相关技术主张专利，但"开源即默许"是行业惯例，实际风险极低；可在文档中加一句免责说明。
- **数据合规（与开源无关）**：记忆数据存在本地（纯本地模式无传输风险）；但"提炼记忆"调用大模型时，若用云端模型（如 DeepSeek API），对话内容会发往模型服务商——这与 DSH 本身行为一致。涉敏场景建议：配置本地 embedding（node-llama-cpp）实现完全离线，或在提示词中脱敏。
- **第三方内容**：记忆库若提取到他人版权内容（长文/代码），仅作个人记忆用途、不对外传播。

### 12.4 行动清单（落到仓库）

1. 项目根放 `LICENSE`（MIT）+ `NOTICE`（若引用他人代码，列明来源与版权声明）；
2. README 声明：灵感来源（TencentDB Agent Memory, MIT）+ 非官方声明；
3. 依赖锁全部为 MIT 系（已核实）；
4. 发布到 npm 时 `license: MIT`。

> 免责声明：以上为基于常见开源许可常识的通俗分析，非法律意见；涉及重大商业决策请咨询专业律师。

---

## 附录 A：DSH 集成点实测清单（源码验证）

> 以下 API 均已在 `E:\npm-global\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\` 对应包源码中确认存在。

| 能力 | 源码位置 | 关键签名 / 用法 |
|---|---|---|
| 会话事件流 | `dsh-session` | `session/event`（追加式事件溯源日志）；事件类型见 `SessionEventMap`：`turn/start{turn}`、`turn/end`、`step/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`request/context`、`approval/*`、`goal/change`…（共 45 种，可 `declare module` 扩展） |
| 持久化屏障 | `dsh-session` / `dsh-session-persistence` | `ctx.on("session/flush", (session) => …)`（parallel、await）；JSONL/zstd 后端 200ms write-behind 批窗口；`ctx.sessions.flush(session)` 是唯一 flush 入口 |
| 回合前注入（正路①） | `dsh-agent-loop` / `dsh-time-context` | `ctx.on("agent/pre-step", async ({agent, turn, step, signal}, next) => { const d = await next(); return {kind:"enter", messages:[...d.messages, createUserMessage({…})]}; }, {prepend:true})` |
| 回合前注入（正路②） | `dsh-system-prompt` | `ctx.systemPrompt.context({name, order, text})` —— 自动差分投影成 "Current runtime context" user 消息；`section()` / `variable()` / `tools()` / `suppressRuntimeContext()` |
| system prompt 装配 | `dsh-system-prompt` | `ctx.waterfall(scope, "system-prompt/assemble", assembly, context, next)`；在 **agent scope** 上 `agentCtx.on("system-prompt/assemble", …)`；渲染按 `order` 排序 |
| 请求改写 | `dsh-agent-loop` | `agent/request` 瀑布（改 provider/model/maxTokens）；`llm/stream` 瀑布（包装流）；`agent/request-error`（溢出恢复点） |
| LLM 调用 | `dsh-llm` | `ctx.llm.stream({ provider, model, messages, system, maxTokens, sessionId, purpose, signal })` + `BlockAssembler` 聚合块（参考 `dsh-session-title-llm`、`dsh-compaction-basic`） |
| 会话全文检索 | `dsh-session-query` + `-sqlite` | `ctx.sessionQuery.searchSessions/searchEvents/listSessions/readSurface/traceSession`；SQLite FTS5 `unicode61`（schema v8）——**可丢弃派生索引**，默认 `openAt: never`，可配置启用 |
| 工具注册 | `dsh-tools` | `ctx.tools.register(defineTool({ name, description, parameters, output, execute }))`；执行管线 `tools/pre-execute`→guard→`tools/execute`→`tools/post-execute`→`tools/result`；`exec.deferContext()` 可带上下文进下一步 |
| 技能仓库 | `dsh-skill` + `dsh-skill-filesystem` | `ctx.skills.registerProvider(...)` / `register(skill)`（内存运行时技能）/ `list/get/snapshot`；文件技能 = `<root>/<name>/SKILL.md` 或 `<name>.md`（YAML frontmatter），watch 自动生效；正文每次 `get()` 重读 |
| 设置命名空间 | `dsh-settings` | `ctx.settings.register(ns, schema, { base })`，ns 为小写 kebab-case；用户层在 `$DSH_HOME/settings.yaml`，Web UI 自动渲染 |
| 调度 | `dsh-schedule` | `createEveryScheduleRecord` / `createAtScheduleRecord` 等；`MIN_EVERY_INTERVAL_SECONDS` 有下限 |
| 通用存储 | `dsh-storage-domain` | `ctx.storageDomain.open(defineDomain({name, version, tables}))` → `domain.table(name).put/get/delete`；JSON 后端原子整文件重写，落 `$DSH_HOME/storages/<unit>.json` |
| 会话投影 | `dsh-session-projection(-cache)` | `ctx.sessionProjections.register({key, schema, init, apply, view, stateVersion})`；checkpoint 落盘 `session_projcache.json`，支持零 I/O 冷读 |
| 压缩/溢出 | `dsh-compaction(-basic)` / `dsh-spill` | `ctx.compaction`（`compaction/start|summary|end` 事件）；`ctx.spillStore.saveText()`；`agent/request-error` 的 `context-overflow` 是记忆固化钩子 |
| Agent 服务 | `dsh-agent` | `ctx.agents.register(agent)`；`agentCtx` 携带 agent 作用域；agent 事件在 agent scope carrier 上 emit/serial/waterfall |

**M0 探针验证清单**（实现第一步前先跑通）：
1. web profile 下挂插件，`session/flush` 能等到并落盘 JSONL；
2. agent scope 的 `system-prompt/assemble` 能改到最终 system prompt（用 dsh-time-context 同类代码对比）；
3. `ctx.llm.stream` 一次带 JSON 约束的提取调用返回可解析结果；
4. `ctx.tools.register` 的工具出现在模型可见的工具列表；
5. headless 模式退出前 flush 收尾不丢数据。

---

## 附录 B：最小插件骨架草图（M0 探针，TypeScript）

DSH 插件导出约定：`export { Config, apply, inject, name }`（Cordis/Koishi 风格），包结构参考 `dsh-time-context`（`type: module`，main → `lib/index.js`，依赖 `@deepseek-ai/schemastery`，peer 依赖 cordis/dsh-*）。

```ts
// src/index.ts —— M0 探针骨架（示意，非最终实现）
import z from "@deepseek-ai/schemastery";
import type { Context } from "@deepseek-ai/cordis";

export const name = "dsh-memory";
export const inject = ["session", "llm", "tools", "settings", "skills", "schedule"];

export const Config = z.object({
  capture: z.object({ enabled: z.boolean().default(true) }).default({}),
  extract: z.object({ everyNTurns: z.number().default(5) }).default({}),
  recall: z.object({ maxResults: z.number().default(5) }).default({}),
});
export type Config = z.infer<typeof Config>;

export function apply(ctx: Context, config: Config) {
  // 1) L0 捕获：会话事件 → 提取管线输入（幂等游标）
  ctx.on("session/event", (session, event) => {
    if (event.type === "user/message" || event.type === "assistant/message") {
      void capture.append(session, event); // 异步入队，绝不阻塞主流程
    }
  });

  // 2) 持久化屏障：flush 时 await 落盘（headless 退出前必须收尾）
  ctx.on("session/flush", async (session) => {
    await capture.flush(session);
    if (ctx.lifecycle === "headless") await extract.drain(session); // 防 5s 关停超时
  });

  // 3) 召回注入：必须挂在 agent scope（根 ctx 监听不到装配）
  ctx.on("session/created", async (session) => {
    const agent = await ctx.agents.get(session.agentId); // 解析 agent
    const agentCtx = agent.ctx;
    agentCtx.on("system-prompt/assemble", async (assembly, assembleCtx, next) => {
      if (config.recall.enabled) {
        const mem = await recall.search(assembleCtx.userMessage); // 5s 超时保护
        if (mem) assembly.system.push(`【相关记忆】\n${mem.render()}`);
      }
      return next(); // waterfall：必须调用 next 继续后续装配
    });
  });

  // 4) 工具注册
  ctx.tools.register(defineTool({
    name: "memory_search",
    description: "搜索长期记忆库中的结构化记忆（事实/偏好/事件/指令）",
    parameters: z.object({ query: z.string(), k: z.number().default(5) }),
    execute: async ({ query, k }) => recall.search(query, { k }),
  }));

  // 5) 后台管线调度（提取/巩固/进化）
  const job = ctx.schedule.createEveryScheduleRecord({ minutes: 15 }, async () => {
    await extract.pump();      // L1
    await consolidate.pump();  // L2/L3
    await evolve.pump();       // 巩固/衰减/技能合成
  });
  ctx.on("dispose", () => job.cancel?.());
}
```

> 注意：`assembly.system.push(...)` 仅为示意；最终注入位（user 消息 prepend vs system append）需按附录 A 的 `PromptAssembly` 结构实测确认。
