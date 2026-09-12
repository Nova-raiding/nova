# Changelog


## 0.1.2 - 2026-09-13

### Added

- 增加支付宝 provider checkout、异步通知验签、查询、退款和轮换脚本，并把支付网关纳入发布来源清单。
- 增加生产发布元数据、镜像来源证明、OpenAI Apps challenge 路由和桌面运营后台的真实运行验收。

### Changed

- 将运营台列表、商家插件桥接和发布确认流程统一到租户、权限、幂等和服务端创意点准入门禁。
- 更新 PostgreSQL 迁移链至 192，并同步插件源包、marketplace 镜像、OpenAPI、MCP 注解和法律页面。

### Fixed

- 修复跨租户发布票据、未知状态、分页、图片候选、模型中转和 API/Worker schema 漂移的 fail-closed 回归。
- 修复 HTTPS 网关的端口重定向、法律页 canonical URL、Ops UI `/ops/` 资源路径和 worker 工作区路由。

## 0.1.1 - 2026-08-28

- 完成运营后台接口契约、权限校验、审计记录和参数边界校验。
- 完成批量发布治理、数据删除审批、账务与模型用量运营能力。
- 优化运营台危险操作确认、异步生成上下文快照和租户隔离。
- 增加运营接口契约、幂等性、跨租户隔离和生产配置门禁测试。
- 增加品牌资料与品牌单元的 workspace/成员/角色授权门禁，并补齐品牌关系链与桌面状态展示。
- 增加图片生成回调、执行租约、Provider 状态对账、候选事件幂等补偿和未知状态 fail-closed 处理。
- 增加 canonical 商品链一致性报告、workspace 读取模式控制、服务端 nextAction 权限投影，以及 Merchant Studio/Ops Console 的阻断交互。
- 迁移 079–105：补齐知识 hydration 快照、存储配额、对账状态、图片执行/对账证据及运行时权限收敛；098 增加 canonical 统一链审计，099 增加 canonical→legacy 品牌复合完整性约束，100 增加告警通知投递账本，101/102 增加 canonical backfill 批次控制与人工冲突队列，103 收紧告警通知账本应用角色 ACL，104 增加一次性交互确认票据及最小权限消费约束，105 增加 durable authorization grants（持久化授权授予、撤销、JIT 时效/次数预算及双人审批约束）；具体生产证据仍按发布门禁执行。
