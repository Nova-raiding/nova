# CodeGraph 功能闭环审计（2026-09-15）

本清单来自 CodeGraph 调用关系、前端入口、API/MCP 契约、迁移和 ECS 只读快照交叉核对。状态含义：生产阻断表示代码存在但真实环境不能宣称完成；条件性表示仅在依赖未实现时触发；覆盖不足表示功能路径存在但缺少直接测试；明确不做表示按项目宪法排除。

| 功能 | 证据 | 状态 | 结论 |
|---|---|---|---|
| 六平台真实授权/同步/发布 | `healthz` 返回六个平台 `fixture_ready`；ECS `CONNECTOR_FIXTURE_MODE=true`；`docs/yxsona-payment-and-six-platform-authorization-guide.md` | 生产阻断 | 官方 OAuth/API、Vault 凭据和真实只读/写入 canary 尚未进入 ECS。 |
| 平台图片媒体发布适配器 | `apps/plugin/skills/merchant-marketing/SKILL.md`、`packages/application/src/connector-runtime.ts` 的 `IMAGE_PUBLISH_ADAPTER_UNAVAILABLE` | 条件性未完成 | 未配置对应平台官方媒体上传适配器时会失败关闭；不得把预览当成已发布。 |
| ChatGPT MCP OAuth | `docs/chatgpt-mcp-oauth-runbook.md`；ECS MCP OAuth 端点/`MCP_OAUTH_CLIENTS` 未配置 | 生产阻断 | 授权服务器路径存在，但没有真实客户端和回调白名单，未完成 ChatGPT 授权码闭环。 |
| OSS 生产对象存储 | ECS `.env` 已有 Bucket/区域/端点/RAM Role；控制面版本控制、生命周期、公网访问阻断通过；4 个 `ws_demo` 本地对象已安全复制到 OSS 并回读验哈希；隔离探针精确版本清理通过 | 部署与证据未闭环 | 当前 `NODE_ENV=development` 强制选择本地存储；OSS overlay 试运行后健康接口仍显示 `local`，已恢复原三层 Compose。本地卷保留；需在真实生产模式下验证读取、写入和绑定当前 release 的签名 canary。 |
| 模型中转五模态 | 本地有历史 `artifacts/model-relay/**`；ECS 生产证据目录缺失 | 证据未闭环 | 中转代码和历史调用存在，但证据没有绑定 ECS 当前 release、镜像摘要和 nonce。 |
| 支付真实 provider | 2026-09-15 已将 ECS `.env` 中的 HTTPS `PAYMENT_PROVIDER_REFUND_QUERY_API_URL` 注入 `api`/`api-replica`；`/api/healthz` 返回 `payment.configured=true`、`reasons=[]` | 配置已修复，证据未闭环 | 支付宝下单与支付 readiness 已就绪；实际退款查单和当前 release 的签名支付 canary 仍需真实交易证据。 |
| 恢复/备份证据 | ECS `/run/release-evidence/restore.json` 缺失 | 生产阻断 | 恢复脚本和门禁存在，但没有当前 release 的签名恢复证据。 |
| 客户交付清单批量更新 | `apps/api/src/server.ts:12883` 条件性抛出 `CUSTOMER_DELIVERY_NOT_IMPLEMENTED`；`packages/persistence/src/customer-delivery-repository.ts` 已实现批量仓储 | 条件性 | 当前内存/PostgreSQL 仓储已有实现；仅当部署的仓储未提供方法时才会 501，需保持 API/仓储版本一致。 |
| 客户交付清单动态配置 | `CustomerDeliverySection.tsx` 仍维护 `INTEGRATION_ITEMS`/`ACCEPTANCE_ITEMS` 静态数组，后端也维护同一组 key | 配置治理缺口 | 当前 key 一致且测试通过；后端新增/定制清单时前端可能漏项，后续应让 API 返回 item 元数据。 |
| 运营后台数据来源 | CodeGraph 显示 `useOpsConsoleModel`、domain clients 和 `opsClient` 统一 hydration；`npm run audit:ops-surface` 为 140/140 | 已完成 | 未发现业务页面用静态 fixture 代替后端数据。 |
| 告警通知 | 健康接口显示未启用，项目要求告警可选 | 明确不做 | 当前候选不启用告警，不作为上线阻断。 |
| Kubernetes/ACK 集群 | 项目宪法和 ECS runbook 明确排除 | 明确不做 | 当前生产目标是单套 ECS，不作为功能缺口或上线项。 |

## 结论

代码层面未发现“有页面但没有后端契约”的运营功能；当前未完成项主要是 ECS 生产配置、真实凭据和 release 绑定证据。动态交付清单属于后续配置治理改进，媒体发布适配器和批量清单 501 属于依赖未就绪时的失败关闭路径。
