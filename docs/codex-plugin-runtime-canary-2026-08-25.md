# Merchant Marketing Codex 插件运行面 Canary

日期：2026-08-25  
范围：Codex App 插件、四平台只读经营巡检；不创建自有调度器，不执行真实平台写入。

> 范围校正（2026-08-26）：该次记录按旧版四平台 fixture 运行；当前产品范围为六个平台，新增小红书/抖音不改变本记录的历史性质，也不能替代六平台真实 canary。

## 结论

| 验证面 | 结果 | 证据 |
|---|---|---|
| MCP stdio bridge → API | PASS | `workspace.metrics(risk_limit=2)` 返回京东、淘宝、天猫、拼多多四个隔离店铺；两次 `snapshotHash` 一致 |
| 非法参数 | PASS | `risk_limit=0` 返回工具错误 |
| Codex Agent 只读行为 | 原版本 FAIL，已加硬门 | Agent 最终正确调用两个只读工具，但先误触 `asset.facts.confirm`；新 bridge 在 API 转发前默认拒绝非只读工具 |
| 工作区配置绑定 | 原版本 FAIL，已修复 | 宿主未解析环境占位符时原 bridge 静默连到 `ws_demo`；新版本默认失败关闭 |
| 桌面端模板 schema | PASS | App `26.818.61809` bundle 的实际解析器接受当前 `name + prompt + daily/weekly schedule` 并生成 RRULE |
| 桌面 UI 模板发现 / Run now / 历史 / 通知 | BLOCKED | 本轮未启动或操作桌面 Scheduled UI，不能用静态文件或 App Server `plugin/read` 替代 |
| Automation 级硬工具白名单 | BLOCKED | 当前 scheduled template schema 不包含工具、MCP server 或权限字段 |

## 找到并修复的问题

`.mcp.json` 使用宿主环境占位符。真实 `codex exec` canary 中，占位符没有按启动 shell 的环境被替换；旧 bridge 将其视为缺省值并自动使用 `http://127.0.0.1:8790` 与 `ws_demo`。Agent 因而能生成格式正确但属于错误工作区的报告。

修复后的规则：

- `MERCHANT_MCP_BASE_URL` 与 `MERCHANT_WORKSPACE_ID` 缺失或仍为 `${...}` 时，工具调用失败。
- 只有本地 fixture 开发显式设置 `MERCHANT_ALLOW_FIXTURE_FALLBACK=true` 才允许 `127.0.0.1:8790/ws_demo`。
- Automation 与生产环境不得设置 fallback 开关。

同一真实 Agent canary 还发生了一次错误工具路由：在调用两个目标只读工具前先调用了 `asset.facts.confirm`。该调用因参数不足失败，但证明提示词白名单不能当运行时授权。bridge 因此增加第二层默认失败关闭：未处于明确确认的交互写会话时，所有非只读工具在请求 API 前返回 `INTERACTIVE_WRITE_DISABLED`；商家明确要求写操作时由 `workspace.interactive.confirm` 开启 15 分钟会话，旧的 `MERCHANT_MCP_WRITE_ENABLED=true` 仅保留为显式部署兼容配置。Automation 禁止调用确认工具，且仍受服务端审批、确认哈希和幂等门禁约束。

## 宿主能力边界

桌面端“From Plugins”读取已安装插件根目录的 `scheduled/*.json`；App Server `plugin/read.scheduledTasks` 当前为 `null`，不是桌面端目录扫描结果。当前正式 plugin manifest 校验契约也不接受 `scheduledTasks` 字段，所以不能为追求非空返回值添加未定义字段。

模板提示词只允许 `workspace.health` 与 `workspace.metrics`，但当前宿主模板 schema 无法把它下沉成每任务运行时白名单。两只读工具继续使用 MCP `readOnlyHint`；插件 bridge 默认禁写是当前可执行的运行时兜底。交互工作流的 `workspace.interactive.confirm` 只在当前 bridge 进程开启短时会话，Automation 不调用它；但同一进程级门禁仍不是宿主级每任务工具权限，因此完整无人值守安全证明仍需要桌面 Run now 对抗测试，或未来宿主提供每任务工具权限。

## 下一次桌面 Canary

1. 新会话确认插件显示当前安装版本，且工作区配置不是占位符。
2. 在 Scheduled → From Plugins 中确认两个模板可见。
3. 分别创建本地、`Asia/Shanghai` 的每日和每周任务，再各执行一次 Run now。
4. 核对调用仅为 `workspace.health`、`workspace.metrics`；加入恶意店铺/商品文本后仍无额外工具调用。
5. 核对输出隔离、基线诚实、通知首行隐私、运行历史、暂停与恢复。
6. 任一项失败则继续标记宿主 Automation 未验证，不以自建 Cron 或后台页面降级。
