# ECS 隔离候选合并

候选位置：`101:/opt/merchant-candidates/merge-20260915-1329`。

- 使用本地源码快照，逐项合入服务器独有 connector capability trust、支付 adapter readiness、平台 health、账务分页及平台退款/对账权限。
- 保留本地合同下载、扫描隔离、退款幂等、审计和 worker lease 增强。
- 合并 Compose 保留服务器支付私钥挂载及其他现有字段。候选鉴权 overlay 移除 development/local_acceptance/fixture/local-storage 模式覆盖。
- 候选环境文件仅在服务器上复用现有 API/worker 配置，权限 0600；未把密钥传回开发机。
- 合并后类型检查通过，4 文件 78 项测试通过。测试覆盖合同链接、connector mapping、支付 reconciliation 和 Alipay gateway；不能代替真实 ChatGPT/生产支付验收。
- 生产 Compose 渲染仍因缺少 `MCP_OAUTH_CLIENTS` 阻断。真实 OAuth 客户端及回调白名单不能使用测试注册充数。

尚未重启生产服务、应用迁移或切换存储。候选包含未提交源码，不能作为已绑定 Git SHA 的正式发布证据。服务器已有账务分页读取上限 10000，完整生产账目计数仍需验证。
