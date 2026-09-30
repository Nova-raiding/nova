# Store Nova 本地插件 182200 版 ChatGPT 验收续查

日期：2026-09-29。当前本地安装包为 `merchant-marketing/0.1.0+codex.20260929182200`，ChatGPT 配置中的 `merchant-marketing@merchant-local` 已启用。目标 QA 工作区仍为 `ws_57fd2361ed5b44c7891f3d37`。

| 检查 | 本轮结果 |
|---|---|
| 安装包 | 新版本目录存在，`.mcp.json` 包含本地 stdio bridge 配置。 |
| 凭据来源 | launchd 指向 `keychain`、目标 QA 工作区及 `https://yxsona.com`。 |
| Keychain helper | 源码和二进制 hash 匹配安装清单，`codesign --verify` 成功；读取目标工作区凭据仍返回 `MCP_KEYCHAIN_HELPER_INVALID`。没有读取或输出令牌。 |
| 服务端健康 | `https://yxsona.com/api/healthz` 与 `https://ops.yxsona.com/healthz` 均返回 `status=ok`；此结果不代表插件鉴权成功。 |
| ChatGPT App 会话 | 经现有 App 任务只读复核，当前工具清单中 Store Nova MCP 工具为 0；`onboarding.status` 与 `workspace.health` 不可调用，因此无本轮请求 ID。 |
| App 进程时序 | ChatGPT 主进程从 15:53 持续运行，早于 18:21 安装的 182200 包；现有会话不能证明新安装包已被宿主重新加载。 |

结论：182200 版目前仍无真实 ChatGPT App 商家工具调用证据；图片和视频成片未通过验收。当前可观测阻断是本地钥匙串访问与 App 插件加载。后续应在正常图形会话完成本地绑定并重启 ChatGPT，再从新的工具清单开始逐项记录结果。不得把旧版本 116 项入口调用或本地测试转记为本版本通过。
