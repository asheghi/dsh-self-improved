# 后续步骤（真实环境）

M0–M6 核心已全部实现：66+ 项单元测试通过，并已部署到真实 DSH 环境（web profile）。
以下为真实环境的安装/运维说明与已知限制。

## 1. 安装到真实环境（web profile）

```powershell
# 1) 构建
cd dsh-self-improved
npx tsc -p tsconfig.json

# 2) 装进 web profile（E:\dsh\profiles\web）
#    - 复制 lib/ + client.js + package.json + LICENSE + README.md 到
#      E:\dsh\profiles\web\node_modules\dsh-self-improved\
#    - package.json dependencies 加 "dsh-self-improved": "file:node_modules/dsh-self-improved"
#    - 在 profile 目录执行 pnpm install
#    - cordis.patch.yml 插入：
#      - insert:
#          - id: dsh-self-improved
#            name: dsh-self-improved

# 3) 模型配置（设置页即可，或 $DSH_HOME/settings.yaml）
#    dsh-self-improved:
#      extract:
#        provider: deepseek-official   # 或你的提供商
#        model: deepseek-chat
```

> 部署铁律：**任何改动（尤其宿主 apiproxy 白名单、settings.yaml、client.js）都必须重启 dsh 才生效**。
> settings.yaml 不要用 PowerShell 直改（编码/引号易坏），用 node 脚本 + 显式 UTF-8 无 BOM。

## 2. 运行时行为（调度模型与开关）

- **总开关关闭 = 插件彻底休眠**：停止全部后台定时器（15 分钟维护轮 / 夜间回顾 / 启动 60s 补跑），注销 `/memory` 命令与记忆工具；已存记忆保留，重新开启自动恢复（运行时热切换，无需重启）。
- **调度模型**：
  - 15 分钟定时轮：只做「提取 + 免费维护」（衰减/治理），**不调 LLM、零 token**；
  - 夜间回顾（`review.time`，默认 22:00）：排空提取 + 完整进化（场景/画像 + 技能合成 + 衰减 + 治理）；改时间/开关即时热生效；
  - 启动后约 60s：若有活跃记忆自动补跑一次完整回顾（`startupReviewDone` 保证只补一次）；
  - 手动触发：`/memory evolve`。
- **`/memory` 命令零 LLM**：handler 纯本地 SQLite 查询。命令声明了 `input`，命令系统会接管带参输入（含直接输入 `/memory status` 回车），不经过模型；建议用命令菜单（敲 `/`）触发。
- **记忆浏览器**：设置页「自进化记忆」→「记忆」Tab（数据走 `dsh-self-improved-browser` 设置命名空间快照通道，无需会话上下文）。

## 3. 验证清单

- [x] 正常对话 → 提取管线落记忆 → 设置页记忆 Tab 可见（或 `/memory list`）
- [x] 新会话提问 → 召回注入生效（模型能"想起"）
- [x] 纠正/遗忘：`/memory correct <id> <内容>` / `/memory forget <id>`，或记忆 Tab 操作
- [x] 自进化：`$DSH_HOME/skills/` 出现 `dsi-*` 合成技能；画像版本递增（当前 v4）
- [x] 设置面板开关即时生效（无需重启）
- [ ] 重启后：`/memory status` 应直接出结果（不走 LLM）；关总开关后命令菜单不再出现 `/memory`

## 4. 本地向量召回（可选，默认关闭）

### 4.1 是什么 / 要不要开

- **向量召回**：用 embedding 模型把记忆文本转成向量，按"语义相似度"检索；与关键词检索做 RRF 融合即 `hybrid`。
- **默认关闭**：召回策略默认 `keyword`（jieba 分词 + BM25，全本地、零额外调用）。向量是可选项。
- **开关**：设置页「召回 / 向量」分组 → 策略下拉 `keyword` / `hybrid`；未配置 embedding 端点时 hybrid 自动降级为关键词。

### 4.2 推荐方案：Ollama + bge-m3（全离线）

```powershell
ollama pull bge-m3
ollama serve        # 默认 http://localhost:11434/v1
```

```yaml
dsh-self-improved:
  recall:
    strategy: hybrid
    embedding:
      baseUrl: http://localhost:11434/v1
      model: bge-m3
      dimensions: 1024        # 必须与记忆库向量表一致（1024）
```

### 4.3 其它本地方案

| 方案 | 说明 |
|---|---|
| LM Studio | 图形化本地推理，OpenAI 兼容，可加载 bge-m3 |
| Xinference | 本地推理服务，支持 bge-m3 / bge-large-zh |
| node-llama-cpp | 进程内 GGUF 嵌入（不推荐优先尝试） |

### 4.4 注意事项

- **维度必须 1024**：向量表按 1024 维创建；不一致会写入失败。
- 向量写入发生在提取管线（配置后新提取的记忆自动带向量）；旧记忆需重新提取。
- 隐私：hybrid 会把记忆内容发给 embedding 服务；本地方案不出本机。
- 云端点务必确认提供 embedding 模型（此前实测阿里云百炼 compatible-mode 端点无 embedding）。

## 5. 已知限制与运维

- 提取/画像/技能需要**稳定输出 JSON 的模型**（若 flash 系提取异常，配置更强模型；提取模型可与主模型分离）。
- 向量召回需要 embedding 端点；未配置自动降级关键词。
- **设置保存 revision 冲突**：若报 `expected revision N, now M`（命名空间被其他修改），前端会自动刷新最新配置并保留草稿，再点一次保存即可；多数情况下源于运行进程内存写回 settings.yaml，重启可消除。
- 安全：
  - **泄露的百炼 API Key（`sk-sp-H.YYXLI...`）必须去控制台作废轮换**——仅清理文件/重启无法根治，进程内存会反复写回；相关技能：`dsi-rotate-leaked-dsh-api-key`。
  - settings.yaml 修改后必须重启 dsh；运行中进程可能把内存旧配置写回文件。
