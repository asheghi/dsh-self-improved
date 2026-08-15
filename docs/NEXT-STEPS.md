# 后续步骤（在你的真实环境）

本仓库的 M0-M5 核心已全部实现并通过 66 项单元测试 + 隔离 headless 集成验证。
以下事项需要**你的真实 DSH 环境**（本沙箱无法验证 Web 前端构建与真实模型调用）。

## 1. 安装到真实环境（web profile）

```powershell
# 1) 构建
cd dsh-self-improved
node node_modules\typescript\bin\tsc -p tsconfig.json

# 2) 装进 web profile（E:\dsh\profiles\web）
#    - 复制 lib/ + package.json + LICENSE + README.md 到
#      E:\dsh\profiles\web\node_modules\dsh-self-improved\
#    - package.json dependencies 加 "dsh-self-improved": "file:node_modules/dsh-self-improved"
#    - 在 profile 目录执行 pnpm install
#    - cordis.patch.yml 插入：
#      - insert:
#          - id: dsh-self-improved
#            name: dsh-self-improved

# 3) 配置模型（settings.yaml 或 Web UI 设置页）
#    $DSH_HOME/settings.yaml
#    dsh-self-improved:
#      extract:
#        provider: deepseek-official   # 或你的提供商
#        model: deepseek-chat
#      recall:
#        strategy: hybrid               # 需要 embedding 端点
#        embedding:
#          baseUrl: http://127.0.0.1:8088/v1   # 本地 embedding 服务
#          model: text-embedding-3-small
#          dimensions: 1024
```

重启 Web 后：
- 设置 → dsh-self-improved：总开关/模块开关/模型/隐私参数（自动渲染）
- 聊天中可直接用 `/memory search <关键词>`、`/memory status` 等命令
- **随时开关**：设置面板改动即时生效（`settings/updated` 热应用），无需重启

## 2. 记忆浏览器页面（未实现，需 Web 环境开发）

按 DSH 客户端模块约定（`dsh-client-ui-*` 模式，参考 `dsh-tdai-memory` 的 `./client` 导出）新增前端模块：

1. 在 package.json exports 增加 `"./client": "./client.js"`；
2. 新建 `client/` 前端模块，注册一个页面/面板路由；
3. 页面数据走宿主 API（或直接调用插件 service）：
   - 记忆库 L1：`store.searchMemories/listMemories`（需暴露只读查询接口）
   - 对话 L0：复用 `ctx.sessionQuery.searchSessions`
   - 场景 L2 / 画像 L3：`store.listScenes/getPersona`
   - 技能：dsh-skill 目录
4. 前端构建产物需随 web-app 打包（本沙箱无法验证，务必在真实环境先验证客户端模块约定再写页面）。

## 3. 真实效果验证清单

- [ ] 配好 API key 后：正常对话 → 等一次提取（默认 15 分钟定时或 flush 触发）→ `/memory list` 能看到提炼的记忆
- [ ] 新会话问"我记得什么" → 自动召回注入生效（模型能"想起"）
- [ ] 修正记忆：让模型调用 memory_correct，或手动 `/memory correct <id> <内容>`
- [ ] 观察自进化：多次同类任务后 `$DSH_HOME/skills/` 出现技能；画像版本递增
- [ ] 设置面板一键关闭/开启，确认无需重启即生效

## 4. 本地向量召回（可选，默认关闭）

### 4.1 是什么 / 要不要开

- **向量召回**：用 embedding 模型把记忆文本转成向量，按"语义相似度"检索——能命中"意思相近但用词不同"的记忆；与关键词检索做 RRF 融合即 `hybrid`。
- **默认关闭，不影响任何功能**：召回策略默认 `keyword`（jieba 分词 + BM25，全本地、零额外调用）。向量是可选项，纯关键词模式完全可用。
- **开关**：设置页"召回 / 向量"分组 → **召回策略** 下拉：`keyword`（关闭向量）／`hybrid`（启用）。未配置 embedding 端点时即使选 hybrid 也会自动降级为关键词。

### 4.2 推荐方案：Ollama + bge-m3（全离线）

```powershell
# 1) 安装 Ollama（https://ollama.com）后拉取中文友好、1024 维的 bge-m3
ollama pull bge-m3
ollama serve        # 常驻服务，默认 http://localhost:11434/v1
```

设置页（或 `$DSH_HOME/settings.yaml`）：

```yaml
dsh-self-improved:
  recall:
    strategy: hybrid
    embedding:
      baseUrl: http://localhost:11434/v1
      model: bge-m3
      dimensions: 1024        # 必须与记忆库向量表一致（1024）
```

或设置页 UI：填 Base URL / 模型，策略选 hybrid，保存即生效（无需重启）。

### 4.3 其它本地方案

| 方案 | 说明 |
|---|---|
| LM Studio | 图形化本地推理，OpenAI 兼容，可加载 bge-m3 |
| Xinference | 本地推理服务，支持 bge-m3 / bge-large-zh |
| node-llama-cpp | 进程内 GGUF 嵌入，需要额外接入代码（不推荐优先尝试） |

### 4.4 注意事项

- **维度必须 1024**：记忆库的向量表按 1024 维创建；模型输出维度不一致会写入失败（bge-m3 是 1024，正好）。
- 向量写入发生在提取管线（配置后新提取的记忆自动写入向量）；旧记忆需要重新提取才会带向量（关键词检索不受影响）。
- 隐私：hybrid 会把记忆内容发送给 embedding 服务；本地方案（Ollama）不出本机。
- 云端点：务必确认该端点**提供 embedding 模型**（此前实测阿里云百炼 compatible-mode 端点只有对话/图像/音频模型，无法做向量）。

## 5. 已知限制与说明

- 提取/画像/技能需要**稳定输出 JSON 的模型**（若 flash 系模型提取异常，配置一个更强的模型；提取模型可与主模型分离配置）。
- 向量召回（hybrid）需要 embedding 端点；未配置时自动降级为关键词召回。
- 沙箱环境连不上外部 API，LLM 相关路径以单元测试（假 LLM）为权威验证；真实效果需在你的环境确认。
- 安全：记得轮换之前暴露的 Gitee 令牌。
