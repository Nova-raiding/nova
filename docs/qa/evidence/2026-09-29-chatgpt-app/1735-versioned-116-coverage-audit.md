# 17:40 版 116 项功能覆盖核对

核对时间：2026-09-29 17:40 CST。对象是商家本地直装插件 116 个方法；分类为只读 46、可逆写入 3、受限写入 60、预期阻断 7。以下数字按**插件版本和实际执行层级**单独统计，不能相加为“通过数”。历史“剩余 84 项”指 13:08 时跨旧版去重后的未调用数；125100 版已把它们逐项调用，旧版调用覆盖最终达到 116/116，但大多返回门禁或错误。

| 证据层 | 方法调用覆盖 | 结果和判定 | 原始依据 |
| --- | ---: | --- | --- |
| **当前已安装 174000 版，真实 ChatGPT 桌面 App** | **0/116** | 尚无该版本的 `custom_tool_call` 与同 `call_id` 输出；安装成功不等于桌面宿主已重启、加载和执行业务。正向业务闭环 0。 | [174000 本地安装验真](174000-local-install-verification.md)；截至本次核对，没有 17:00 后 `originator=codex_work_desktop` 的新会话记录。 |
| 160709 版，历史真实桌面 App | 1/116 | `onboarding.status` 有中文正文；执行脚本未保留 `isError`、结构化工作区 ID，因此只计调用通达，不计身份或业务通过。 | [16:40 桌面原始调用](164046-desktop-onboarding-call.md) |
| 153500 版，历史真实桌面 App | 8/116 个不同方法、9 次调用 | 4 次明确非错误、3 次明确错误、2 次错误位未保存；两次 Excel `asset.upload` 均为 `CREATIVE_POINTS_UNAVAILABLE`，没有资产 ID。 | [153500 原始调用审计](153500-app-call-audit.md) |
| 143500 版，历史真实桌面 App | 116/116 | 22 项 `isError=false`，94 项 `isError=true`；22 项主要是状态、空态或后台入口读取，94 项多数为创意点门禁。**116 是调用覆盖，不是功能通过。** | [历史 116/116 审计](positive-business-coverage-matrix.md) |
| 当前 174000 版，独立 stdio | 安装器 `tools/list` 116/116；正式租户业务 `tools/call` 0/116 | 54 个运行文件与安装源一致；独立 QA 子任务没有安全传入商家会话凭据，未发起正式租户调用。无配置健康检查返回预期 `MCP_CONFIGURATION_REQUIRED`，不是租户成功。 | [174000 安装验真](174000-local-install-verification.md)、[stdio 认证前置](174000-31-readonly-stdio-auth-precondition.md) |
| 160709 版，独立 stdio | `tools/list` 116/116；31 项只读批次 `tools/call` 0/31 | 独立进程读取 Keychain helper 失败，初始化前即停在 `MCP_CREDENTIAL_SOURCE_INVALID`；不能推论桌面 App 同样失败。 | [Keychain 阻断原始记录](160709-31-readonly-stdio-keychain-block.md) |
| 生产 HTTPS `/api/mcp`，专用 QA 工作区 | 无必填参数只读 31/31 实际调用 | 31 项均返回一致工作区；21 项 HTTP 200 且 API 无错误，10 项为店铺入驻、权限、商业权益或余额门禁。21 项也只算 API 层状态/空态响应，**不是 21 个完整业务流程通过**。 | [31 项逐方法 request ID](production-api-31-readonly-20260929.md) |
| 生产 HTTPS `/api/mcp`，专用 QA 工作区 | 带参数只读 2/15 实际调用 | `brand.get({})` 返回空品牌档案；`catalog.search({scope:"workspace"})` 返回创意点门禁。其余 13 项缺本租户真实对象 ID。仍非 App 或业务正向通过。 | [带参数只读逐项证据](172900-parameterized-readonly-preconditions.md) |
| 本地/隔离测试及源码 | 按用例各自计数 | 桥接契约、桌面浏览器、隔离 API 和 UI 文案证据只适用于各自候选环境；不能折算为当前生产 App 成功。 | [本地桌面浏览器](local-desktop-browser-followup.md)、[本地视觉检查](1730-local-merchant-visual.md) |

## 当前 174000 版剩余范围

- **46 项只读**：31 项最小参数 `{}`，其中生产 `/api/mcp` 已直接调用 31 项，但当前 App 仍为 0；另 15 项中 `brand.get({})` 已返回本租户空态，`catalog.search({scope:"workspace"})` 被创意点门禁拒绝，其余 13 项缺真实订单、店铺、品牌、商品、任务、生成作业或导出申请 ID。逐项证据见 [带参数只读核查](172900-parameterized-readonly-preconditions.md)。无对象时记“前置数据缺失”，不传虚构 ID。`campaign.batch.get`、`catalog.image.get` 还须核对可能的持久副作用。
- **70 项非只读**：可逆写入 3、受限写入 60、预期阻断 7。专用 QA 工作区现无可核实的 V2 已付费权益、创意点授权、订单、店铺及商品；两份 Excel 的真实 App 上传已被余额门禁拒绝。交互写关闭时的拒绝可验证安全性，但不能代替创建→读回→审计/账本→必要时回退的正向闭环。
- **当前版验收口径**：桌面宿主完整重启后，用新会话逐项保存版本、工具调用、同 `call_id` 输出、`isError`、结构化工作区、中文用户可见答复和服务端 request ID。先做身份及无参读取；在专用资源、商业权益和模型中转成本证据可用后，再逐流程测商品、资产、知识库、任务、内容审核、导出与账务。

发布门禁另见[无数据库迁移发布核查](20260929-no-migration-release-audit.md)。目前生产 schema 254 与候选 255 不一致；本记录不把本地安装或 API 只读通达解释为云端候选已部署。
