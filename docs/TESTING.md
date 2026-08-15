# 测试指南（M0 探针）

M0 探针在**隔离 DSH_HOME** 中验证插件与 DSH 的四个接线点，不影响真实环境（`E:\dsh` 与运行中的 Web）。

## 复现步骤

```powershell
# 1. 构建插件
cd dsh-self-improved
node node_modules\typescript\bin\tsc -p tsconfig.json

# 2. 初始化隔离测试环境（首次）
$env:DSH_HOME = 'E:\dshPro\.dsh-test'
dsh --profile headless "hello"      # 自动初始化 headless profile（无 key 报错是预期的）

# 3. 把插件装进测试 profile
#    - 复制 lib/ + package.json + LICENSE + README.md 到
#      $env:DSH_HOME\profiles\headless\node_modules\dsh-self-improved\
#    - package.json dependencies 加 "dsh-self-improved": "file:node_modules/dsh-self-improved"
#    - pnpm-workspace.yaml 设 autoInstallPeers: true
#    - cordis.patch.yml 插入：
#      - insert:
#          - id: dsh-self-improved
#            name: dsh-self-improved
#            config: { enabled: true, debug: true }
#    - 在 profile 目录执行 pnpm install --store-dir <工作区内目录>

# 4. 运行探针
$env:DSH_HOME = 'E:\dshPro\.dsh-test'
$env:DEEPSEEK_API_KEY = 'sk-test-fake'   # 假 key，让流程走得更远
dsh --profile headless "hello"
```

## 通过标准（四接线点）

| 接线点 | 期望日志 |
|---|---|
| ① 设置命名空间 | `probe: settings namespace registered` |
| ② 会话捕获（session/flush） | `probe session/flush <id> events: N`（多次，N 递增） |
| ③ 召回注入（agent/pre-step） | `probe agent/pre-step <id> turn 1 step 1` |
| ④ 工具注册 | `probe: tool memory_probe registered` |

末尾 `AUTH: ...invalid` 报错是假 key 的预期结果（M0 不调用真实模型）。

## 注意事项

- profile 的 `package.json`/`cordis.patch.yml` 必须是 **UTF-8 无 BOM**（PowerShell `Set-Content -Encoding UTF8` 会写 BOM 导致 JSON 解析失败，用 `[System.IO.File]::WriteAllText(path, text, [System.Text.UTF8Encoding]::new($false))`）。
- 插件 inject 的服务名：`sessions`（不是 session）；`schedule` 不在 headless base 装配里，M0 不要声明它。
