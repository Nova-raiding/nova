# 平台模型与计费策略

## 结论

本产品是安装在 Codex App 内使用的商家营销插件。Codex App 只负责自然语言入口和 MCP 调用；商品文案、商品图片、规则审核和平台运营能力由本平台服务端完成。

**平台统一持有模型中转站配置，商家不得填写、上传或绑定自己的模型地址、API Key 或模型名称。**

## 请求链路

```text
Codex App 免费版
  -> merchant-marketing MCP
  -> 平台 API / Worker
  -> 平台 Vault 中的模型凭据
  -> 平台配置的 OpenAI-compatible 中转站
  -> 文案/图片模型
```

- Codex App 原生模型请求仍由 Codex 官方宿主处理，插件不能接管或改写该链路。
- 插件业务模型请求只能从平台服务端发出。
- 原始平台 Key 不进入 MCP 参数、Codex 上下文、插件返回值、日志、导出文件或运营前端。
- `MODEL_RELAY_BASE_URL`、`MODEL_RELAY_ALLOWED_HOSTS`、`MODEL_RELAY_API_KEY`、`AI_MODEL`、`IMAGE_MODEL`、`IMAGE_EDIT_MODEL`、`OCR_MODEL` 和 `VIDEO_MODEL` 只允许由部署密钥管理系统注入；视频如需独立计费分组，可额外注入 `VIDEO_MODEL_RELAY_API_KEY`，未配置时回退到共享 Key。所有环境都只允许经 HTTPS 自有中转站；staging/production 还必须配置精确 host allowlist，并在每次请求前做 DNS/IP 检查，缺失或解析到私网时 fail-closed。`AI_BASE_URL`、`IMAGE_BASE_URL`、`VIDEO_BASE_URL` 及各类直连 Key 不再作为有效出口。
- provider 响应中的 `usage`、`cost_cny` 和 `x-request-id` 会写入工作区隔离的 `model_usage_ledger`，按 provider request id 幂等；provider 不返回成本时不猜测金额，账单会明确标记为未观测。
- 上线证据还必须把同一请求的 `context_hash/context_link_id`、provider request ID、实际 usage、实际 `cost_cny`、倍率版本和钱包流水串起来；只有 action ID 或布尔值 `usageObserved/costObserved` 不能证明上下文与扣费连续性。
- 生产生成还必须注入非 `fixture`/`local` 的 `PLUGIN_VERSION`、`SKILL_BUNDLE_VERSION`、`MCP_VERSION`、`CONNECTOR_BUILD`、`PROMPT_BUNDLE_VERSION`；缺失或使用默认值时，模型 readiness 为阻断，禁止创建可作为生产证据的内容版本。
- 生产环境的 Codex App 只作为交互和编排入口；`content.codex.prepare/commit` 的宿主模型路径仅允许本地开发/测试，生产一律要求 `content.generate` 走平台模型服务，防止用户侧模型 token 绕过平台计量。
- 生产配置 preflight 同时要求文案/图片 HTTPS endpoint、固定模型名称、Vault Key 引用、正数 RPM/TPM 和非负每日人民币成本上限；仅配置环境变量但没有发布合同不能放行。

## 商业规则

- 用户先充值人民币钱包，金额字段统一使用 `amount_cny`，展示固定两位小数，例如 `10.00`；内部账务仍使用分保存和对账。
- 充值不是模型供应商账户，也不会向用户开放模型 Key 管理。
- 用户使用平台套餐中的任务额度；文案生成按任务额度消费，图片生成、批量同步等高成本能力可配置加购。
- 平台可在运营后台调整套餐价格、月/年周期、店铺数、任务数、加购价格、灰度范围和平台开关。
- 余额、套餐、任务额度和能力开关全部按工作区隔离，并在 MCP 返回脱敏后的状态。
- 支付仅在服务商验签回调后入账；退款保留原始充值流水并生成不可变退款流水。

## 运营后台要求

运营后台使用 Ant Design，至少提供：

- 套餐、价格、周期、店铺额度、任务额度调整。
- 平台开关、店铺展示名和别名调整。
- 充值、消费、退款、对账和导出。
- 工作区、成员角色、任务用量和告警。
- 模型供应商 readiness：只显示是否配置、模型脱敏名称、配额/成本门禁和最后探活时间，不显示 Key。
- 平台模型切换必须由部署配置或平台运营审批完成，不能由商家通过 Codex MCP 修改。

## 上线门禁

生产发布前必须提供：

1. Vault/KMS 凭据引用和轮换证明。
2. 文案、图片模型的真实 HTTPS endpoint、模型额度、TPM/RPM、成本上限和数据处理条款。
3. 充值支付服务商、HTTPS 回调和验签证明。
4. 任务额度消费、幂等、失败退款和余额对账证据。
5. 日志、审计、导出和错误响应中无原始模型 Key 的扫描结果。

本策略取代任何“用户填写自己的中转站 Key”的方案。
