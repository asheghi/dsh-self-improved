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

## 安装（占位，M0 验证后补充正式步骤）

```bash
# 在你的 DSH profile 目录安装
dsh plugin --profile web add dsh-self-improved
# 或本地开发：在 profile 的 node_modules 里 link 本仓库
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

## 文档

- `README.md` —— 功能与用法总览（本文件）
- `docs/NEXT-STEPS.md` —— 真实环境安装/验证清单与已知限制
- `docs/TESTING.md` —— 测试指南
- 设计文档（`docs/design/`）与 DSH 源码调研（`docs/research/`）**仅本地保留**（`.gitignore` 排除，不进版本库）

## License

MIT © 2026 mashao
