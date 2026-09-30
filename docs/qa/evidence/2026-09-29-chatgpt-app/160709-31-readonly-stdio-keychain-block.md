# 160709 版 31 项无必填参数只读工具：Keychain 门禁阻断

时间：2026-09-29。目标：本机已安装 `merchant-marketing@merchant-local` 版本 `0.1.0+codex.20260929160709`，生产 API origin `https://yxsona.com`，`demo@sn.com` 专用 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`。本轮只运行**独立本地 stdio bridge**；不是 ChatGPT App 内调用记录。

## 凭据门禁实测

- `launchctl` 非敏感配置指向上述 origin、工作区，令牌源为 `keychain`，严格鉴权为 `true`。
- 在当前安装缓存中，`assertKeychainHelperReady()` 通过文件可执行性、源码与二进制 manifest 哈希校验。对**同一 origin 和工作区**调用 `readKeychainCredential()` 时，返回 `MCP_KEYCHAIN_HELPER_INVALID`；探测程序没有输出凭据内容。
- 用该安装缓存的 `mcp/bridge.mjs` 启动独立 stdio 进程，固定同一 origin 与工作区、`MERCHANT_MCP_TOKEN_SOURCE=keychain`、严格鉴权、禁用 fixture 回退及交互写，并在子进程环境中移除显式访问令牌、刷新令牌、actor 与 role。发送标准 MCP `initialize` 一次。进程退出码 `1`，标准输出 0 行，错误代码 `MCP_CREDENTIAL_SOURCE_INVALID`，所以没有收到 `initialize`、`tools/list` 或任何 `tools/call` 响应。
- `MCP_KEYCHAIN_HELPER_INVALID` 是 helper 执行结果的统一包装，当前日志无法确定底层 macOS Keychain OSStatus、ACL、图形会话授权或超时中的哪一个原因。凭据条目曾存在的历史元数据不能证明本次可读取。

因此按同工作区凭据约束停止业务调用。没有读取或打印令牌、密码；没有借用其他工作区、伪造令牌、写业务数据、生成内容或购买套餐。此处的 `0/31` 是**本轮执行数**；不把历史 160709 版 ChatGPT App 的 `onboarding.status` 调用重复计入本轮。

## 逐项结果

31 项来自当前 [116 工具矩阵](160709-next-tool-matrix.md) 中标为只读且最小参数为 `{}` 的行。下列每项的本轮结果相同：**未调用；Keychain 凭据读取门禁阻断**。没有 API 响应、业务空态、权限判定或正向功能结论。

| 序号 | 工具 | 本轮 stdio `tools/call` |
| ---: | --- | --- |
| 1 | `onboarding.status` | 未调用，凭据门禁阻断 |
| 2 | `brand-unit.list` | 未调用，凭据门禁阻断 |
| 3 | `brand-unit.listing.list` | 未调用，凭据门禁阻断 |
| 4 | `canonical.product.consistency` | 未调用，凭据门禁阻断 |
| 5 | `campaign.batch.list` | 未调用，凭据门禁阻断 |
| 6 | `workspace.health` | 未调用，凭据门禁阻断 |
| 7 | `workspace.invitations.list` | 未调用，凭据门禁阻断 |
| 8 | `workspace.metrics` | 未调用，凭据门禁阻断 |
| 9 | `commercial.access.get` | 未调用，凭据门禁阻断 |
| 10 | `commercial.catalog.get` | 未调用，凭据门禁阻断 |
| 11 | `creative-points.balance.get` | 未调用，凭据门禁阻断 |
| 12 | `creative-points.statement.list` | 未调用，凭据门禁阻断 |
| 13 | `subscription.get` | 未调用，凭据门禁阻断 |
| 14 | `subscription.orders.list` | 未调用，凭据门禁阻断 |
| 15 | `billing.export` | 未调用，凭据门禁阻断 |
| 16 | `billing.status` | 未调用，凭据门禁阻断 |
| 17 | `billing.model-usage.statement` | 未调用，凭据门禁阻断 |
| 18 | `billing.recharge.list` | 未调用，凭据门禁阻断 |
| 19 | `billing.transactions` | 未调用，凭据门禁阻断 |
| 20 | `catalog.categories` | 未调用，凭据门禁阻断 |
| 21 | `rule.list` | 未调用，凭据门禁阻断 |
| 22 | `rule.sync.status` | 未调用，凭据门禁阻断 |
| 23 | `asset.list` | 未调用，凭据门禁阻断 |
| 24 | `brand.extract` | 未调用，凭据门禁阻断 |
| 25 | `deliverable.list` | 未调用，凭据门禁阻断 |
| 26 | `task.history` | 未调用，凭据门禁阻断 |
| 27 | `knowledge.rule.list` | 未调用，凭据门禁阻断 |
| 28 | `knowledge.asset.list` | 未调用，凭据门禁阻断 |
| 29 | `knowledge.brand.preference.get` | 未调用，凭据门禁阻断 |
| 30 | `knowledge.learning.list` | 未调用，凭据门禁阻断 |
| 31 | `knowledge.competitor.list` | 未调用，凭据门禁阻断 |

恢复前提：在同一图形用户会话下诊断 helper 的非敏感退出状态和 Keychain OSStatus，或用当前安装版的合法本地授权流程重新绑定 `demo@sn.com` 与上述 QA 工作区。只有凭据可用并读回结构化身份与工作区后，才能继续逐项只读调用。以上属于 stdio 认证阻断；不能推论 ChatGPT App 入口或 API 业务功能已通过或失败。
