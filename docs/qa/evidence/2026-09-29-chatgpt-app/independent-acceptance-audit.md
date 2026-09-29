# Store Nova 插件独立验收复核（2026-09-29）

本报告只读复核本地直装 `0.1.0+codex.20260929090000`、现网 demo 健康状态及已有证据。没有调用生产写操作、重新绑定账号、部署或迁移数据库。采用 gstack QA 的逐入口、正反路径和证据分级口径；尝试用 gstack browse 打开 `https://ops.yxsona.com/healthz` 时，现有共享 daemon 返回 `existing daemon has different config (proxy/headed mismatch)`。为避免断开其他 agent 的浏览器会话，改用 `curl` 和既存的隔离 Chromium、ChatGPT 截图证据；本报告不声称本次新做了浏览器 UI 验收。

## 独立实测

| 项目 | 本次结果 | 证明范围 |
| --- | --- | --- |
| 安装状态 | `codex plugin list --json` 显示 `merchant-marketing@merchant-local` 版本 `0.1.0+codex.20260929090000`、`installed=true`、`enabled=true`。 | 证明当前本地 Codex 安装记录；不代表 ChatGPT 内每个工具可用。 |
| 工具清单 | 分别以非生产测试令牌运行源码和安装缓存中的 stdio `tools/list`：两边各 **116** 项，`ops.*` 为 0，`upload.session.*` 为 0，包含 `merchant.start`。测试令牌没有向 API 发送。 | 证明两个本地桥接器的实际暴露面；不算业务调用。 |
| 矩阵一致性 | 131 行旧清单逐名与当前安装的 116 项比较：恰好 15 项隐藏，没有新增或状态栏错配。历史互斥状态算术成立：16 App、18 生产 MCP、26 预期阻断、3 产品门禁、1 线上缺陷、10 本地契约、57 未测试。 | 证明清单统计内部一致；历史状态不可自动继承为新版逐工具回归。 |
| 现网只读健康 | API `/api/healthz`、Ops `/healthz`、API `/api/releasez` 均成功；API release 为 `release-demo-product-code-20260929`、SHA `fd1ad6a7bd122a391350c185798ac07e92795f8c`。`ssh 101` 显示 demo API 双副本和主要 worker healthy。 | 只证明当前部署运行与健康接口；不证明 116 项逐个成功。 |
| 发布门禁 | `/api/healthz` 的 `setup.productionEvidence.capability` 和 `.capacity` 仍为 `blocked`，原因分别是配置证据路径不可读；embedding `ready=false`，理由含向量索引关闭与模型缺失。 | `status=ok` 不等于正式发布批准，也不能据此宣称五模态或知识向量链路全部运行成功。 |
| CodeGraph | `codegraph status --json` 为 1.5.0、`state=complete`、2,334 files、33,624 nodes、131,359 edges、`pendingRefs=0`；但有 2 新增、13 修改未同步。`explore loginLocalPlugin` 定位回调实现及测试；`explore UploadSessionManager` 定位 API handler/transport。 | CodeGraph 用于调用链定位；未同步改动由当前磁盘文件和运行证据复核，图索引不算功能成功。 |

## 验收差距与修正口径

1. **“当前页面弹框”的位置需要准确表达。** 黑底提示页已改为本机 loopback 回调标签页 `/merchant-mcp-callback` 内的 `<main role="dialog" aria-modal="true">` 状态卡片，处理中、成功和失败在这个标签页内更新。[隔离浏览器报告](local-plugin-callback-browser-e2e.md)证明其状态切换；[生产截图](28-production-callback-binding-success.png)和安装器结果证明真实商家授权、Keychain 保存，之后[ChatGPT 新会话截图](29-production-bound-116-tool-app-readonly.png)证明可读。当前实现并非**原商家授权页面原地弹框**。若目标是原页面内弹框，最小安全方案是：商家授权页打开一次由服务端签发的安装会话，浏览器重定向到 loopback 完成授权码交接；原页面只使用一次性会话 ID 轮询服务端或接收经 origin 校验的消息，显示“待完成/已完成/失败”，而绑定最终成功仍以安装器保存凭据并由 ChatGPT 新会话读取为准。原页面不得接触授权码、refresh token 或钥匙串材料。该方案需修改商家前端、授权状态协议并重新部署云端；本地插件页优化不能代替它。
2. **新版宿主回归范围很窄。** `0.1.0+codex.20260929090000` 完全重启 ChatGPT 后的直接截图只覆盖 `onboarding.status` 和 `catalog.search`。旧版本的 16 项 App 成功和 18 项生产 MCP 成功是有效历史证据，但不能表述为新版 116 项在 ChatGPT 中全量复验。既有[131 项矩阵](../../2026-09-29-plugin-all-tools-matrix.md)对这一点已有正确警示。
3. **隔离成功不等于线上成功。** [剩余路径清单](remaining-tool-gaps.md)写明 57 个旧矩阵“未测试”方法中 49 个有隔离正向证据、8 个无成功证据。此后新增的 [`brand.upsert` 隔离报告](brand-upsert-isolated-audit.md)及[工作区生命周期报告](workspace-lifecycle-delete-isolated-audit.md)又给出 4 个精确方法的隔离正向路径；若该清单按目前证据更新，应为 **53 个有隔离正向路径、4 个无正向路径**（`merchant.start` 与隐藏的 3 个 `upload.session.*`）。这只是报告统计更新，不改变矩阵 57 项的生产/App 状态。生命周期报告还记录跨租户取消申请错误映射问题。
4. **分片上传被正确隐藏，但功能尚未补齐。** CodeGraph 和当前 `packages/storage/src/upload-session.ts` 显示 transport 是可选依赖；[隔离 HTTP/MCP 记录](asset-upload-e2e-audit.md)对 `upload.session.create/part/complete` 均收到 `UPLOAD_TRANSPORT_NOT_CONFIGURED`。隐藏 3 项避免误导，不能算上传能力成功。普通 `asset.upload` 的隔离正向结果也未证明生产扫描、OCR 中转和权限全链路。
5. **实际现网缺陷仍存在。** [`workspace.data.export.get` 的非法 ID 500](workspace-brand-isolated-audit.md)修复仅在本地候选；生产仍是旧 API release。现网健康响应的能力、容量证据阻断也未解除。不能用本地通过的类型检查、发布测试或回调页截图推断 API 修复已上线。

## 建议的下一轮验收顺序

先在新版 ChatGPT 新会话调用 `merchant.start`，记录结果和准确工具版本。然后用专用 QA 商品逐个验证商家主流程的写入确认、商品事实、合法素材扫描与权益、低额模型中转、真实用量/成本/点数、正式内容审核与导出，并在 App 中读回。其他只读方法逐项记录真实业务对象；空列表和 404 只记为边界证据。保持发布/支付/删除等高影响路径在隔离环境验证，现网演示工作区不得用于删除或虚构平台发布。完成后更新 116 项现行工具矩阵及生产发布证据，再作上线判断。
