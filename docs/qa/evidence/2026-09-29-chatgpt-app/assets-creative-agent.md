# 资产与创意 10 项：已安装插件门禁核验（2026-09-29）

## 范围与证据等级

本轮检查已安装的 `merchant-marketing@merchant-local 0.1.0+codex.20260929125100` 本地 stdio 桥接器。目标工作区配置为 `ws_57fd2361ed5b44c7891f3d37`，`MERCHANT_MCP_WRITE_ENABLED=false`。`launchctl getenv MERCHANT_WORKSPACE_ID` 与 `launchctl getenv MERCHANT_MCP_WRITE_ENABLED` 分别返回该工作区和 `false`。探测进程显式设为无访问令牌、无刷新令牌、严格鉴权、禁止 fixture 回退，因此不会将调用转发为有权的生产写入；未读取或输出密钥。初始化返回版本 `0.1.0+codex.20260929125100`，`tools/list` 返回 116 项。

以下是**已安装本地桥接器拒绝路径**，不是 ChatGPT App 会话证据，也不是生产 API 或业务正向验收。除 `asset.upload` 外的 9 项在本地交互写入门禁返回 `INTERACTIVE_WRITE_DISABLED`。`asset.upload` 被桥接器列为明确上传图片后制作未发布候选的例外，不受该写入开关直接阻断；本次没有提供文件或字节，且无令牌，返回 `MCP_AUTH_REQUIRED`，没有上传、模型调用或持久化证据。此项不能计作“写入门禁通过”。

## 逐项记录与 App 最小参数

| 工具 | 本地无副作用结果 | 待 owner 在 ChatGPT App 使用的最小输入 | 正向验收前置 |
| --- | --- | --- | --- |
| `asset.parse` | `INTERACTIVE_WRITE_DISABLED` | `{"asset_id":"<已有 QA 素材 ID>"}` | 真实 QA 文档素材、解析与成本证据 |
| `asset.facts.confirm` | `INTERACTIVE_WRITE_DISABLED` | `{"asset_id":"<已有 QA 素材 ID>","facts_json":"{}","reason":"QA 人工确认，勿发布"}` | 经人工核对的有效商品事实；示例空 JSON 仅提示字段形态，不应作为正向输入 |
| `asset.preference.update` | `INTERACTIVE_WRITE_DISABLED` | `{"asset_id":"<已有 QA 素材 ID>","verdict":"unrated"}` | 已有 QA 素材和版本读回 |
| `asset.upload` | `MCP_AUTH_REQUIRED`；无文件、无字节 | **没有附件时不要调用**；有明确授权 QA 文件时按 `{"name":"<QA 文件名>","mime_type":"<真实 MIME>","file_path":"<绝对路径>"}` | 专用 QA 文件、当前会话附件、QA 工作区核验、扫描/权益/对象存储证据 |
| `asset.upload.batch` | `INTERACTIVE_WRITE_DISABLED` | `{"assets_json":"[]"}` 仅用于门禁检查 | 正向需要专用文件字节及批量清单；空数组不代表上传通过 |
| `asset.generation.confirm` | `INTERACTIVE_WRITE_DISABLED` | `{"job_id":"<已有 QA 作业 ID>"}` | 同一 QA 工作区生成作业、人工权益决定及 worker/模型成本证据 |
| `asset.rights.update` | `INTERACTIVE_WRITE_DISABLED` | `{"asset_id":"<已有 QA 素材 ID>","rights_status":"pending"}` | QA 素材及真实权益证据；不得伪造 `approved` |
| `creative.brief` | `INTERACTIVE_WRITE_DISABLED` | `{"product_id":"<已有 QA 商品 ID>","asset_type":"banner"}` | 经确认 QA 商品事实和生成准入 |
| `creative.preview` | `INTERACTIVE_WRITE_DISABLED` | `{"product_id":"<已有 QA 商品 ID>","asset_type":"banner"}` | 同上，并核对 SVG 预览、用量和费用 |
| `creative.directions.update` | `INTERACTIVE_WRITE_DISABLED` | `{"task_id":"<已有 QA 任务 ID>","action":"regenerate"}` | 已有 QA 任务和明确修改指令；避免无意触发模型 |

本轮未对任何真实文件、素材、商品或任务执行写入。新 QA 工作区的只读基线为零测试素材、零商品、零店铺，且没有可核实的正向商业权益/创意点。要完成这 10 项正向路径，需先取得专用授权素材、商品/任务、权益和费用预算；当前结果只能证明 9 项在关写状态拒绝及 1 项在无鉴权状态拒绝。

## 实施依据与异常点

`apps/plugin/mcp/bridge.mjs` 中的 `SAFE_WITHOUT_INTERACTIVE_WRITE` 将 `asset.upload` 作为特殊入口；其余 9 项不在该集合。`tools/call` 的交互门禁位于参数校验与远端调用之前，因此 9 项返回为本地拒绝。`asset.upload` 在本次无令牌条件下先返回 `MCP_AUTH_REQUIRED`；不能由此推断其缺少附件时的校验或有令牌时的上传结果。正向测试须由 owner 先验证真实 ChatGPT App 会话绑定专用 QA 工作区，避免读取或写入贵人鸟租户。
