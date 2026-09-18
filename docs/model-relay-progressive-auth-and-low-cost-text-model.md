# 模型中转渐进式授权与低成本文本模型说明

本文说明 Store Nova 业务模型的配置边界，以及在不削弱官方鉴权和正式任务门禁的前提下，使用低成本文本模型的方式。

## 目标模型

当前中转站已声明 `glm-4.7-flash` 为 OpenAI 兼容模型，并提供 VIP 计费组价格快照。它定位为轻量、低延迟的通用文本模型，适合商品标题、卖点、详情页草稿和营销文案等常规生成任务。

平台管理员可将服务端文本模型配置为：

```env
MODEL_RELAY_BASE_URL=https://<approved-relay-host>/v1
MODEL_RELAY_ALLOWED_HOSTS=<approved-relay-host>
AI_MODEL=glm-4.7-flash
MODEL_ID=glm-4.7-flash
MODEL_RELAY_PRICING_DERIVATION_ENABLED=true
MODEL_RELAY_TEXT_PRICING_GROUP=VIP
```

`MODEL_RELAY_API_KEY` 必须由服务端密钥管理器注入，不能写入插件、前端、商家表单、提交记录或文档。`MODEL_ID` 是兼容旧部署的备用变量；代码实际优先读取 `AI_MODEL`。

切换模型前必须通过中转站 `/v1/models` 确认模型 ID，并通过 `/api/pricing` 确认当前计费组存在该模型。模型列表或价格快照不可用时，服务端必须保持阻断，不能猜测价格或静默切换到宿主模型。

## 渐进式授权

授权按风险和数据范围逐步提升：

1. **能力探测**：只读取服务端健康状态、模型配置状态和中转站声明的模型能力，不发送商家内容，不向商家索取模型 Key。
2. **工作区绑定**：确认 `workspace_id`、商家身份和租户权限；官方平台授权仍由官方页面完成，插件不接收店铺密码、Cookie 或个人 access token。
3. **内容生成**：服务端使用密钥管理器中的 relay key，通过 Store Nova 中转站调用 `glm-4.7-flash`。每次请求绑定 `workspace_id`、`action_id`、`run_key`、模型和幂等键。
4. **正式业务执行**：只有拿到 provider request id、真实 usage、成本和价格快照后，才允许完成点数结算并生成可用于正式商品任务的内容版本。

能力探测成功不代表已获准生成；工作区授权成功也不代表模型调用成功。每一级都必须保留可审计结果，失败时停在当前级别。

## 官方鉴权边界

- ChatGPT 宿主登录、插件安装和第三方平台店铺授权，必须使用各平台官方 OAuth/授权页面。
- Store Nova 业务模型调用只能走配置的 HTTPS 中转站，禁止直连供应商、借用 ChatGPT 宿主模型结果，或让商家填写模型中转地址和 API Key。
- 低成本模型只是服务端路由选择，不改变用户身份、租户隔离、官方授权和账务规则。
- 生产环境缺少 relay 地址、allowlist、服务端 key、模型、usage/cost evidence 任一项时，返回明确阻断；不得用本地规则、fixture 或未计量结果伪造内容版本。

## 变更与验收

模型切换由平台运营或发布人员完成，商家无需操作。配置变更后按顺序验证：

```text
/readyz
  → relay model/configuration gate
  → 正式 content.generate
  → provider request id + usage + cost evidence
  → 点数结算与内容版本落库
```

验收应确认：

- 正式任务能够生成 `review_required` 内容版本；
- 请求使用 `glm-4.7-flash`，而不是宿主模型或本地 fixture；
- 缺少鉴权或成本证据时仍 fail-closed；
- 审计记录不包含 API Key、Cookie 或完整敏感请求体；
- 文案质量不满足业务要求时，可在平台侧切回已审查模型，但不得在商家侧绕过中转链路。
