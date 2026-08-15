# dsh-self-improved

DeepSeek Harness 的**长期记忆与自进化插件**（纯本地）。

> 状态：M0–M6 全部完成并部署到真实环境（web profile）。设计/调研文档仅本地保留（见 `.gitignore`）。

## 这是什么

给 DSH 补上"跨会话记忆 + 自进化"两块缺失能力：

- **记忆**：对话后自动提炼要点（事实/偏好/事件/指令）存入本地记忆库；新会话开始前把相关记忆自动注入给模型——AI 从此"记得你"。
- **自进化**：记忆会巩固、遗忘、被纠正；能从成功任务中提炼出可复用的操作流程（技能），画像随对话持续演化。

架构对齐 TencentDB Agent Memory 的四层记忆金字塔（L0 对话捕获 → L1 记忆提取 → L2 场景归纳 → L3 用户画像），但**全部复用 DSH 自有服务**（`ctx.llm` / `session` 事件 / `agent/pre-step` 注入 / `dsh-skill` / `storageDomain`），存储默认纯本地 SQLite（FTS5 + sqlite-vec），不上传任何数据。

## 功能状态（路线图）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 探针：事件捕获 / 召回注入 / 工具注册 / 设置命名空间 | ✅ 验证通过（隔离环境 headless 实测） |
| M1 | 记忆库：SQLite + FTS5 + jieba 分词 + sqlite-vec；L0 捕获落盘；记忆/对话搜索工具 | ✅ 验证通过（单元测试 + headless 集成实测） |
| M2 | 提取管线：`ctx.llm` 提取 L1 + 严格 JSON 校验/兜底 + 去重 + 防重入节流泵 | ✅ 单元测试通过；真实环境已运行 |
| M3 | 召回注入：agent/pre-step 自动注入 + 关键词/向量/混合检索（RRF） | ✅ 单元测试通过 + 端到端实测 |
| M4 | 自进化：L2/L3 归纳（场景+画像版本化）、遗忘衰减、纠正/遗忘工具、技能合成→dsh-skill | ✅ 单元测试通过；真实环境已产出合成技能 |
| M5 | UI/运维：设置面板（自动渲染）+ 随时开关热应用 + `/memory` 命令 + 记忆浏览器 | ✅ 完成并部署真实 Web 环境 |
| M6 | 成长治理（上限/清理）+ 调度模型（夜间回顾/免费维护/启动补跑） | ✅ 完成：治理上限、夜间回顾（默认 22:00）、15 分钟轮仅免费维护、总开关关闭即停全部定时器 |

## 安装

### 方式一：从 GitHub 安装（已实测）

```bash
# 1) 一次性环境准备（若报 store 不一致 / 构建被拦截）：
#    - store 指回与 node_modules 一致的目录：
#      pnpm config set store-dir E:\dshPro\.pnpm-store --global   # 或 profile 下 .npmrc 写 store-dir=...
#    - 允许 git 安装的包运行 prepare 构建（pnpm >= 10 默认禁止），在 pnpm-workspace.yaml 加：
#      allowBuilds:
#        dsh-self-improved: true

# 2) 安装（dsh plugin 转发给 profile 的 pnpm；github:owner/repo 拉取仓库快照并自动跑 prepare=tsc 构建 lib/）
dsh plugin --profile web add github:madage/dsh-self-improved

# 3) 激活：在 $DSH_HOME/profiles/web/cordis.patch.yml 的 insert 列表加：
#    - insert:
#        - id: dsh-self-improved
#          name: dsh-self-improved

# 4) 重启 dsh 生效
```

> 注意：GitHub 安装拿到的是**仓库快照**，本地改代码需 push 后重装才生效；日常开发建议用下面的方式二（本地 link）。指定分支/标签：`github:madage/dsh-self-improved#main` 或 `#<tag>`。卸载：从 `cordis.patch.yml` 移除 insert + `pnpm remove dsh-self-improved` + 重启。

### 方式二：本地开发（file: link）

```bash
# 构建后复制 lib/ + client.js + package.json 到
# $DSH_HOME/profiles/web/node_modules/dsh-self-improved/
# package.json dependencies 加 "dsh-self-improved": "file:node_modules/dsh-self-improved"
# cordis.patch.yml 加 insert（同上）→ 重启
```

### 方式三：npm 发布后安装（推荐，待发布）

```bash
npm publish   # 仓库已配置 files: [lib, client.js, LICENSE, README.md] 与 prepare 脚本
dsh plugin --profile web add dsh-self-improved
```

## 配置（占位，完整见设置页）

```yaml
# $DSH_HOME/settings.yaml
dsh-self-improved:
  enabled: true
  modules:
    capture: true
    extract: true
    consolidate: true
    evolve: true
    recall: true
    tools: true
  review:
    enabled: true      # 夜间回顾（每日一次完整进化）
    time: "22:00"      # 可改 HH:MM
```

> 说明：
> - **总开关关闭 = 插件彻底休眠**：停止全部后台定时器（15 分钟维护轮 / 夜间回顾 / 启动补跑），注销 `/memory` 命令与记忆工具；已存记忆数据保留，重新开启即恢复。
> - **调度模型**：15 分钟定时轮只做「提取 + 免费维护」（衰减/治理，不调 LLM）；完整进化（场景/画像/技能）交给夜间回顾（默认 22:00）、启动 60s 补跑与手动 `/memory evolve`。
> - **`/memory` 命令零 LLM**：直接查本地记忆库，建议用命令菜单（敲 `/`）触发；命令声明了 `input`，带参输入也会被命令系统接管，不走模型。
> - 记忆浏览器（设置页「自进化记忆」→「记忆」Tab）可查看/筛选/纠正/遗忘记忆、画像、场景与合成技能。

## 合规声明

- 本插件**架构启发自** [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT 协议），为**自研独立实现**，与腾讯无隶属关系、非官方出品。
- 本插件与全部依赖组件均为 MIT 系宽松协议，纯本地运行。

## 致谢

本项目在架构与设计上参考了以下开源项目，衷心感谢它们的作者与社区：

- **[TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)**（腾讯云）—— 四层记忆金字塔（L0 对话捕获 → L1 记忆提取 → L2 场景归纳 → L3 用户画像）与记忆管理思想，是本插件记忆管线的直接启发来源；
- **[self-improving-agent](https://github.com/pskoett/self-improving-agent)**（作者 **pskoett**）—— OpenClaw 生态中的自我进化技能：从经验中提炼教训、纠正与可复用流程；本插件的自进化模块（记忆巩固 / 遗忘 / 纠正 + 技能合成）以此为设计灵感。

再次感谢以上项目与作者的开源贡献。

## 文档

- `README.md` —— 功能、用法与许可（本文件，随仓库维护）
- `docs/` 目录（安装/验证清单、测试指南、设计文档、DSH 源码调研）**仅本地保留**，`.gitignore` 已排除，不进版本库

单元测试：`node scripts/test-storage.mjs` / `test-extract.mjs` / `test-recall.mjs` / `test-evolve.mjs` / `test-commands.mjs`（全部 PASS）。

## License

本项目采用 **MIT License**（MIT 系宽松许可证），完整条款见 [LICENSE](./LICENSE)。

MIT 许可的核心内容：

- **授权**：任何人可免费获得本软件及关联文档（"软件"）的副本，并被授予使用、复制、修改、合并、发布、分发、再许可和/或出售本软件的权利；
- **条件**：软件的所有副本或实质性部分必须保留上述版权声明与本许可声明；
- **免责**：软件按"现状"提供，不附带任何明示或暗示的担保（包括但不限于适销性、特定用途适用性及不侵权）；在任何情况下，作者或版权持有人均不对因使用软件产生的任何索赔、损害或其他责任负责。

Copyright (c) 2026 mashao。`package.json` 中 `license` 字段为 `MIT`。
