# Changelog

## 未发布（2026-09-23 至 2026-09-26 并入 main）

以下条目记录 9/23 并行任务线与其后 main 演进合并回主线的内容（原存于 19 个 -923 工作区，已全部收拢，详见 archive 合并提交）。

### Added

- B 桥代码切换与两阶段恢复：`bridge_recovery_started -> bridge_runtime_recovery_verified -> bridge_recovery_verified` 状态机、签名 unlabeled 七容器接管、root-only 旧运行时证据与镜像归档绑定、外部网关拓扑契约拒绝，以及 `ecs-bridge-old-runtime-evidence` 门禁与其 node:test 入口。
- 云端 v2 候选发布链：插件发布描述符 Ed25519 签名/校验、双平台（macOS/Windows）本地测试证明、云发布清单 schema v2 `pluginReleases`、`verify-staged-plugin-release-v2` 与 cloud-only 构件校验。
- 商家首工作区受保护引导：`/v1/auth/workspace-bootstrap`（会话+CSRF+资格校验）、`createMerchantAccount` 显式 bootstrap 意图、`assertBootstrapEligible` 风控门禁与 Postgres 工作区引导仓储。
- 支付证据链：网关操作来源回执捕获、回调重放数据库快照 fail-closed 生产者；中继只读候选会话与密钥预检；PG17 恢复拓扑只读预检（未达标 NO-GO）。

### Changed

- Ops 鉴权收敛为 password-only（`ECS_OPS_AUTH_MODE=password`，镜像标签与部署期双重校验）；ECS 镜像构建增加 npm registry HTTPS 输入校验。
- 迁移链 242/244 桥兼容：`verifyBridgeMigrationPrefix` 接受“携带完整链至 244”的更长主链；部署预检主机证据门禁绑定候选清单摘要。
- 商家钱包回归测试对齐打包副本（充值入账读路径与订单展示双断言）。

### Fixed

- 修复合并期间丢失的本地插件桥模式 503 门禁（四条连接路由 fail-closed）与部署预检 `--expected-manifest-sha256` 绑定。
- 注册 `payment-callback-replay` 与 `ecs-ops-auth-mode-gate` 测试入口，消除未收集测试台账漂移。

## 0.2.1 - 2026-09-15

以下 Added/Changed/Removed 条目覆盖 2026-09-16 至 2026-09-19 期间累积到本候选版本的变更（`release-metadata.json` 为准）。

### Added

- 增加六平台 `manual_operations` 人工运营 profile：商品资料由运营人工上传、审核并分配给商家，不接入平台 OAuth/API；同步在健康检查与桌面运营后台暴露人工运营状态。
- 增加公共平台规则迁移 219 `public_platform_rules`（`public_platform_rule_versions` 与 `public_platform_rule_audits`）：商家角色只读公共规则，运营角色才能写生命周期，审计表 UPDATE/DELETE 被拒绝。
- 增加迁移 215 `customer_delivery_account_binding`、216 `workspace_content_setup`、217 `model_usage_embedding_modality`、218 `manual_publish_evidence`，补齐客户交付账号绑定、工作区内容设置、模型用量 embedding 模态与人工发布证据账本。
- 增加受保护单节点 ECS 发布 profile 与发布门禁工具链：以 SSH 作为 ECS 部署权威、支持 verified archive identities、staging 期间构建 workspace 包、发布门禁安装桌面 workspace 依赖。
- 增加商家钱包与创意点展示：付费钱包余额、canonical 充值订单号、创意点可见，运营停用用户在列表中可见并支持启用动作。
- 增加商家知识工作区与品牌工作流细化、素材库摘要卡片重组、商品目录与素材库收敛、当前店铺摘要卡片，以及会议纪要工作流补齐。

### Changed

- Ops 一级域从 12 合并为 11，平台/工作区双工作台结构保持。
- 商家 Bridge 工具面由 151 收敛为 131：这是插件范围收窄（资料整理、内容候选、审核、导出四条商家链路），不是功能回退；非商家范围的内部调试/运营辅助入口不再暴露给商家，运营能力仍在桌面运营后台完整保留。MCP 方法总数同期由 320 增至 327。
- 收敛本地商家插件 origin 绑定、本地 MCP 模式下的运营会话保持，以及人工发布列表按工作区授权过滤。
- 生产配置与密码鉴权对齐人工平台规则；容器运行时用户可访问 workspace 构建产物；重置每个 worker 构建指令；优化财务日期选择器交互并保持运营用户名单行显示。

### Removed

- 从商家总览移除钱包目录入口，钱包与账务入口收敛到财务视图。
- 从商家 Bridge 工具面移除不属于资料整理/内容候选/审核/导出四条链路的内部调试与运营辅助入口（对应 151 → 131）。

### Fixed

- 修复直接打开客户交付页面时继承旧商家工作台，导致具备权限的运营账号被误判为缺少客户交付读取权限的问题。
- 修复客户交付详情动作与只读保护、交付证据契约和客户交付/计费发布缺口。
- 修复商家 UI 容器构建（含表格导入）兼容性、workspace 通知简化与工作区内容状态展示。
- 修复运营用户与客户交付工作流、以及 QA ISSUE-001/002/003（付费钱包与创意点展示、canonical 充值订单号、商家钱包可见性）回归。

## 0.2.0 - 2026-09-14

### Added

- 增加客户交付素材上传、扫描与治理链路，并在桌面运营后台提供按工作区授权的交付控制面。
- 增加阿里云 ECS RAM Role 对象存储凭据链，以及与发布版本、镜像集和运行环境绑定的 Ed25519 平台能力证据。
- 增加 ChatGPT MCP OAuth 授权码与 PKCE 流程，将宿主身份绑定到 canonical 商家账号，并补充部署运行手册。

### Changed

- 将产品品牌从“大麦”统一更新为“Store Nova”，同步 ChatGPT 插件、商家工作台、运营后台、文档和发布配置。
- 更新生产交付、计费恢复、平台连接与支付宝结算的权限边界，保持 API、MCP、Worker 和桌面后台契约一致。
- 将支付回调、订单读取和退款操作统一绑定到 canonical 商家身份及可审计支付证据。

### Fixed

- 修复生产配置生成与真实门禁的字符串格式不兼容、条件字段遗漏和部署别名冲突；配置安装器校验受控链接及完整补丁，保留现有配置与独占备份。
- 修复插件开始入口越过工作区财务权限展示余额，以及有限临时授权绕过读取计次的问题。
- 支付回调仅允许相同已验证载荷恢复暂态入账失败；同 nonce 的不同载荷仍拒绝，并保持幂等入账。
- 修复现代支付回调未校验人民币币种的问题，错误币种在 nonce 消费及入账前拒绝。
- 修复单笔对账时支付队列可能一直得不到处理，以及并发退款完成后错误报告钱包预留已释放的问题。
- 补全迁移 211 的隔离数据库与运行角色验证，修复 PostgreSQL 测试清理阶段的连接竞态，并保留真实失败证据。
- 修复客户交付页面在只读权限和目标工作区切换时可能发起越权写入的问题。
- 修复生产对象存储可能回退到环境静态密钥，以及未签名平台能力证据可能被运行时接受的问题。
- 修复 macOS ChatGPT 插件重启后未从用户会话恢复严格鉴权配置的问题，并同步插件版本、安装测试和交付手册。
- 修复 Marketplace 镜像、PostgreSQL CI 验收分母和平台退款权限回归断言不同步的问题。
- 修复 OAuth 已登录 Cookie 可被误当成授权同意、canonical identity 历史成员匹配失败，以及支付宝网关可能接收非支付宝查单或退款的问题。


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
