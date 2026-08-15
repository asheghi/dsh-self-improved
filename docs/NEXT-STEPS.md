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

## 4. 已知限制与说明

- 提取/画像/技能需要**稳定输出 JSON 的模型**（若 flash 系模型提取异常，配置一个更强的模型；提取模型可与主模型分离配置）。
- 向量召回（hybrid）需要 embedding 端点；未配置时自动降级为关键词召回。
- 沙箱环境连不上外部 API，LLM 相关路径以单元测试（假 LLM）为权威验证；真实效果需在你的环境确认。
- 安全：记得轮换之前暴露的 Gitee 令牌。
