# Codex App 商家使用说明

商家只需要在 Codex App 中操作。`Merchant Studio` 是开发调试控制台，不是商家使用前置条件。

首次进入插件的固定顺序是：初始化工作区 → 立即展示六个平台授权入口并绑定所选店铺 → 授权回调后检查工作区健康 → 展示钱包余额和充值入口。钱包余额为 0 时仍可绑定店铺、查看目录、只读同步和创建充值订单；生成文案、生成图片/视频以及发布确认必须显示“充值到账后解锁”。充值订单必须按 `pending` / `paid` 分开显示，只有支付服务商回调或查单确认到账后才开放受控能力。

## 启动本地验收

首次安装/修复 LaunchAgent 时可执行：

```bash
CONNECTOR_FIXTURE_MODE=true PLUGIN_WRITE_ENABLED=true \
API_AUTH_TOKENS='{"local-dev-token":{"workspaces":["ws_demo"],"roles":["merchant"]}}' \
PORT=8790 npm run dev:api
```

当前机器已安装用户级 LaunchAgent `com.merchant.codex.api`，会自动启动并保持本地 API；商家日常不需要打开终端。API 已接入本地 PostgreSQL（端口 54329）和 Redis（端口 63799），任务、版本、素材元数据和幂等状态重启后仍可恢复。Codex App 使用本机插件 `merchant-marketing@merchant-local`，插件通过 `MERCHANT_MCP_BASE_URL`、`MERCHANT_WORKSPACE_ID` 和 `MERCHANT_MCP_TOKEN` 连接 API。修改插件或环境变量后，新建 Codex 会话让工具重新加载。

## 商家对话流程

```text
查看我的商品目录和平台连接状态
在本地演练模式连接京东店铺并显示模拟账号状态
在本地演练模式同步淘宝商品
在本地演练模式创建一次可恢复的全量同步任务，并查看同步结果
为商品“轻云防晒外套 2026”生成3张白底商品主图，生成后检查主图规则
查看这次主图生成任务的版本和审核结果
同步淘宝店铺商品；如果有失败项，只重试可重试项
读取我的素材列表并解析已完成安全扫描的商品事实文件
保存品牌档案：品牌叫云朵，定位是轻户外，语气克制清晰
上传这段商品事实文件并进入隔离扫描流程
确认商品事实后，为该商品创建淘宝详情页任务
展示三个创意方向，并选择一个方向
展示制作方案；确认制作方案后再生成正式内容
检查内容、查看版本差异并导出 ZIP 交付包
```

正式内容的最小顺序是：`task.create` → `creative.directions` → `task.select_direction` → `task.plan.confirm` → `content.generate` → `content.review`。未调用 `task.plan.confirm` 时，正式生成会被阻断；合并或修改方向会创建新方向版本，当前比较列表仍保持三个方向。

发布前必须由商家确认 `publish.prepare` 返回的字段差异和两个 hash，插件不会绕过人工确认直接写入平台。

## 真实图片生成配置

正式商品主图生成可启用素材前门禁：

```bash
REQUIRE_APPROVED_ASSET_FOR_GENERATION=true
```

启用后，`catalog.image.generate` 只会接受当前 workspace 内同时满足以下条件的图片素材：安全扫描为 `clean`、权益为 `approved`、允许 AI 修改，并且 `applicable_platforms` 包含商品所属平台。未满足时返回 `APPROVED_ASSET_REQUIRED_FOR_GENERATION`，并给出缺失条件和补齐步骤。未配置该变量（包括本地 fixture 默认模式）时不改变原有演练行为。

本地未配置图片服务时使用稳定的 SVG fixture 以验证完整交互；生产必须配置：

- `MODEL_RELAY_BASE_URL`：自有 HTTPS 中转站地址；文案、图片、OCR、图片编辑和视频请求统一经此出口转发。
- `IMAGE_MODEL`：图片模型名称。
- `MODEL_RELAY_API_KEY`：只放 Secret Manager/Kubernetes Secret，不写入插件或 Codex 对话；图片、编辑、OCR、视频和文案都共用平台中转出口。
- 对象存储：生产应把 provider 返回的图片 URL 转存到受控对象存储后再发布，避免使用短期 URL。

Codex MCP 支持单文件 50MB 以内素材的 base64 上传；超过该大小的文件应使用生产对象存储/上传网关，再通过 `asset.list` 和 `asset.parse` 继续处理。安全扫描完成后，Codex 可直接解析 JSON/CSV/TXT/Markdown、文本型 PDF、DOCX 和 XLSX；扫描 PDF 与图片 OCR 需要外部解析器。

生产未配置图片服务时，`catalog.image.generate` 会返回明确的 `IMAGE_GENERATION_NOT_CONFIGURED`，不会伪造图片已生成。

## 充值与账单

Codex 插件提供 `billing.status`、`billing.recharge.create`、`billing.recharge.get` 和 `billing.transactions`。商家可以在 Codex 对话中说“查看余额”或“充值 10 元”，选择支付宝或微信。插件必须把 `pending` 和 `paid` 分开展示，待支付订单不能当作已到账。

本地 `PAYMENT_MODE=fixture` 只生成演练订单，不会产生真实扣款。生产接入支付宝/微信前必须配置服务端 checkout provider adapter、商户号、应用标识、签名私钥、微信 API v3 密钥、HTTPS 回调地址和回调验签/解密；服务端先向 provider 下单取得真实支付链接/二维码数据，支付成功只能以服务商签名回调或查单结果入账。微信 Native 支付的官方流程是下单获取 `code_url`、用户扫码、接收支付回调、查单和对账，不能用前端“支付成功”按钮直接加余额。
