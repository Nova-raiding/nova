# Merchant Studio v2 架构与产品评审记录

日期：2026-09-11

本轮对 damai-merchant-studio-prd-v2.md 与 damai-merchant-studio-architecture-v2.md 进行了 CEO、工程、桌面 UX、开发者体验四个视角的评审。

## 结论

方向通过，实施前必须落实以下阻断项：

- 认证失败、workspace 范围不匹配、能力缺失和账号未激活必须使用不同 reason code 与恢复动作。
- bootstrap 必须先完成 session/context 校验，再加载业务数据；401/403 同批次请求只能触发一次状态转换。
- RulePack 分类必须由 API/MCP 强类型返回，旧数据无分类时标记 blocked，禁止前端启发式猜测。
- 无 workspace 账号必须提供审核状态、申请绑定或联系管理员动作。
- 规则治理需支持创建、审核、生效、冲突优先级、回滚和租户覆盖。
- 发布门禁和桌面浏览器验收必须提供 API trace、audit、RLS、worker 和外部配置证据。

## 评审意见合并

CEO 评审补充了商家北极星指标、M0-M3 里程碑、MCP 端到端旅程和授权自助闭环。

工程评审发现原有“所有 403 都清会话”会误伤合法但能力不足的账号，已拆分为 session expired 与 capability denied；同时要求真实 RLS、worker Redis fail-closed 和规则分类契约测试。

桌面 UX 评审要求新会话只保留知识库、错误使用弹框/阻断页而非长期 inline-error、保持焦点管理和 request ID 证据，并把规则中心做成三类 Tab/筛选。

开发者体验评审要求补充可执行命令、迁移兼容、证据模板、多标签会话和浏览器缓存场景。

## 当前实现结果

- 首页 welcome panel 与环境 banner 已移除。
- 新会话导航仅保留知识库；客服回复和帮助诊断不再作为导航标签。
- RulePackCategory 已加入 review/persistence/API/UI 契约；旧数据缺分类时不进入可执行状态。
- API 鉴权事件已区分 session expired 与 capability denied，并加入客户端短路。
- 商家 fixture 账号 merchant-demo@example.com 绑定 ws_demo，本地登录和 platform-accounts 读取已实测 200。
- 商家工作台构建、类型检查和相关回归测试已通过。
- 2026-09-11 owner 复核：Merchant Studio/API/MCP 相关 32 个测试文件、129 个用例通过；插件 MCP 核心 144 个用例通过；Ops Console 与 Merchant Studio 类型检查通过；UI 容器重建后页面 200、未认证 API 返回 401/UNAUTHENTICATED。
- 安全测试入口已增加默认超时、独立进程组和 worker 级清理，避免集成测试挂起时无限等待或残留进程。

## 尚未满足生产发布的证据

真实平台 OAuth、五模态模型中转用量/成本、对象存储/KMS、扫描器、支付回调、发布回执和多租户 RLS 运行证据仍需在预发/生产环境完成；本地 fixture 只能证明开发链路。

## 恢复最终验收所需输入

1. 提供一套独立 Compose runtime，并设置 `LOCAL_RUNTIME_TEST_RUN_ID`、`LOCAL_RUNTIME_TEST_PROJECT`、`LOCAL_RUNTIME_TEST_WORKSPACE_ID`、`LOCAL_RUNTIME_TEST_API_URL`、`LOCAL_RUNTIME_TEST_API_TOKEN`、`LOCAL_RUNTIME_TEST_COMPOSE_FILE`、`LOCAL_RUNTIME_TEST_ENV_FILE`；项目、网络、卷、数据库和 Redis 必须全部带隔离标签。
2. 提供渲染后的生产配置路径（`PRODUCTION_CONFIG_PATH`），由 `infra:production-gate` 和 `launch-preflight` 校验，禁止直接使用基础 ConfigMap 或共享 `.env`。
3. 在预发/生产环境生成 OAuth、模型中转五模态用量/成本、对象存储/KMS、扫描器、支付回调、发布回执、RLS 和 worker 的可验证 evidence artifact。
4. 依次执行 `npm run test:local-release-gate`、`npm run infra:production-gate`、`npm run launch-preflight`、`npm run test:release-gates` 和桌面浏览器验收；所有命令必须保存 stdout、trace/request ID、audit 和容器健康证据。
