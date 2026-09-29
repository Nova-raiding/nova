# 15:22 新会话未发现 Store Nova 工具：只读定位

时间：2026-09-29。本轮只读取会话日志、安装状态、进程和 CodeGraph；没有修改插件配置、凭据或生产数据。

| 核对项 | 14:53 已调用会话 | 15:22 未发现工具会话 |
| --- | --- | --- |
| 原始记录 | `rollout-2026-09-29T14-53-55-01a0ebf1-0393-7340-a194-da6267b71ad3.jsonl` | `rollout-2026-09-29T15-22-21-01a0ec0b-0855-7db3-bf7f-d6ca05e90946.jsonl` |
| 会话 cwd | `/Users/lixiaomei/Documents/Codex/2026-09-29/store-nova-116-subscription-get-canonical` | `/Users/lixiaomei/Documents/Codex/2026-09-29/store-nova-onboarding-status-catalog-image` |
| 会话插件禁用列表 | `disabled_plugin_ids=[]` | `disabled_plugin_ids=[]` |
| 实际发现 | 第 19 行有 Store Nova 工具，第 21 行发起三项调用并返回 | 第 13/15 行按三项精确名称搜索 `ALL_TOOLS` 得到 `[]`；无 Store Nova 调用 |

两个 cwd 都是 ChatGPT/Codex 创建的临时工作目录，均非项目仓库 `/Users/lixiaomei/Desktop/code/codexSkills`；但 14:53 的临时会话能调用工具，因此**cwd 差异本身不能解释工具消失**。在上述两个目录分别运行 `codex plugin list --json`，均显示本地直装 `merchant-marketing@merchant-local` 版本 `0.1.0+codex.20260929151337`、`enabled=true`；旧个人版 `merchant-marketing@personal` 为 `enabled=false`。配置文件中的本地源指向本项目 `.codex-marketplace`。

已安装版本的 `verify-installed-bridge` 返回 `ok=true`，源码和缓存各 116 项工具、54 个运行文件，没有缺失、越界或缓存漂移。单独启动该已安装 stdio bridge 的 `initialize`/`tools/list` 成功，116 项中明确包含 `onboarding.status`、`catalog.image.get`、`knowledge.brand.preference.get`，没有 API 请求。CodeGraph 状态 `complete`，2,352 files、33,851 nodes、132,751 edges，0 pending changes；`explore` 与实际安装脚本表明插件加载依赖本地 `bridge.mjs`，并在启动时读取按 API origin+工作区绑定的钥匙串凭据。

关键时间：ChatGPT 主进程 PID 26639 启动于 **14:34:41**，早于 **15:13:37** 版插件安装；当前缓存仅保留 `151337` 目录。14:53 已有会话保留其工具快照，15:22 新会话未获得工具。安装器输出明确 `restart_required:true`；校验器也说明运行中的会话可能保留旧工具快照。**最可能是宿主进程跨插件升级未完整重启，插件发现快照/启动状态未刷新。**仅凭会话日志不能再细分为宿主缓存失效还是新桥接器读取钥匙串失败；后者需图形宿主启动错误证据。

## 可执行恢复与核验

1. 在桌面端**完全退出 ChatGPT 应用**，确认旧 ChatGPT 主进程已结束，再重新打开。安装器要求重启；只新建聊天或只重启单个 app-server 子进程不足以证明插件重新加载。
2. 在 ChatGPT/Codex 中打开真实项目目录 `/Users/lixiaomei/Desktop/code/codexSkills`，从该项目新建 Work 会话，不复用 14:53 或 15:22 临时目录会话。确认会话环境显示该 cwd。
3. 在新会话先查询可用工具名，确认 `mcp__merchant_marketing__onboarding_status`、`mcp__merchant_marketing__catalog_image_get`、`mcp__merchant_marketing__knowledge_brand_preference_get` 均存在；然后先调用只读 `onboarding.status({})`，核对返回的 QA 工作区。图片查询缺 `job_id`/`visual_ref` 时只能记中文参数拒绝，不能记为图片功能成功。
4. 如完整重启后仍为空，先在新会话核对 `disabled_plugin_ids` 和工具发现；再查看图形宿主的 Store Nova MCP 启动错误及 macOS 钥匙串授权。插件在 `loadManagedToken` 阶段读取凭据失败会在 `tools/list` 前终止；此候选原因目前**未被证实**，不要据此改账号、工作区或凭据。

本报告的结论是**工具发现故障**，不改变 14:53 历史调用证据，也不能将安装缓存的 116 项清单算成 15:22 会话的真实可用工具。
