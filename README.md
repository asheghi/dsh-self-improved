# dsh-self-improved

DeepSeek Harness 的**长期记忆与自进化插件**（纯本地）。

> 状态：M0 探针阶段（骨架 + 接线验证中）。设计文档见 `docs/`。

## 这是什么

给 DSH 补上"跨会话记忆 + 自进化"两块缺失能力：

- **记忆**：对话后自动提炼要点（事实/偏好/事件/指令）存入本地记忆库；新会话开始前把相关记忆自动注入给模型——AI 从此"记得你"。
- **自进化**：记忆会巩固、遗忘、被纠正；能从成功任务中提炼出可复用的操作流程（技能），画像随对话持续演化。

架构对齐 TencentDB Agent Memory 的四层记忆金字塔（L0 对话捕获 → L1 记忆提取 → L2 场景归纳 → L3 用户画像），但**全部复用 DSH 自有服务**（`ctx.llm` / `session` 事件 / `agent/pre-step` 注入 / `dsh-skill` / `storageDomain`），存储默认纯本地 SQLite（FTS5 + sqlite-vec），不上传任何数据。

## 功能状态（路线图）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | 探针：事件捕获 / 召回注入 / 工具注册 / 设置命名空间 | ✅ 验证通过（隔离环境 headless 实测） |
| M1 | 记忆库：SQLite + FTS5 + jieba 分词 + sqlite-vec；L0 捕获落盘；记忆/对话搜索工具 | ✅ 验证通过（16 项单元测试 + headless 集成实测） |
| M2 | 提取管线：`ctx.llm` 提取 L1 + 去重 + 后台调度 | ⬜ |
| M3 | 召回注入：agent/pre-step 自动注入 + 混合检索 | ⬜ |
| M4 | 自进化：L2/L3 归纳、巩固/遗忘/纠正、技能合成 | ⬜ |
| M5 | UI：设置面板 + 记忆浏览器 + CLI | ⬜ |

## 安装（占位，M0 验证后补充正式步骤）

```bash
# 在你的 DSH profile 目录安装
dsh plugin --profile web add dsh-self-improved
# 或本地开发：在 profile 的 node_modules 里 link 本仓库
```

## 配置（占位）

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
```

## 合规声明

- 本插件**架构启发自** [TencentDB Agent Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)（MIT 协议），为**自研独立实现**，与腾讯无隶属关系、非官方出品。
- 本插件与全部依赖组件均为 MIT 系宽松协议，纯本地运行。

## 文档

- `docs/design/dsh-memory-plugin-design.md` —— 主设计文档（架构、数据模型、自进化、路线图、合规）
- `docs/design/dsh-memory-detailed-design.md` —— 细化设计（架构图集、UI 交互、运行时启停）
- `docs/research/` —— DSH 内部 API 源码调研报告

## License

MIT © 2026 mashao
