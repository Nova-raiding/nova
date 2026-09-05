# 生产 readiness 与 evidence 的状态设计

生产状态由两个独立维度组成：

1. **Runtime readiness**：当前部署是否使用真实依赖并能安全处理请求。它检查运行模式、支付 provider、平台 OAuth、对象存储/KMS、scanner、告警、数据库/RLS、宿主 bridge 和模型 relay 配置。
2. **Release evidence readiness**：当前 release 是否拥有可审计的外部运行证据。它检查 release id 绑定、五模态 provider request id、usage、cost、pricing snapshot、503 recovery，以及 capability、capacity、payment、storage、restore 和 ChatGPT host evidence。

单项通过不能推导另一项通过。尤其是本地 `.env` 中的真实 relay 请求只能使 `release:model_relay_evidence=ready`，不能把 `commercial:model_relay` 或 `productionGate` 标成 ready；运行时仍为 fixture、对象存储为 local 或支付为 fixture 时，写入必须保持关闭。

生产放行条件使用以下合取关系：

```text
productionGate = runtimeReadiness
             && releaseEvidenceReadiness
             && releaseIdentityMatches
             && hostEvidenceReady
```

运营后台应分别展示：

- `运行时依赖`：当前环境、模式、provider、endpoint host 和阻断原因；不显示密钥。
- `发布证据`：release id、环境、生成时间、证据类型、过期时间、核验结果和不可变 artifact 引用。
- `最终写入状态`：只有上述合取为真时显示“可写”；否则显示“阻断”，并列出仍缺的维度。

证据生命周期固定为 `missing → observed → validated → release_bound → expired`。`observed` 只表示采集到了响应，`validated` 才表示通过 schema 和成本/用量约束，`release_bound` 才能参与生产发布门禁。过期或 release id 不一致的证据必须回到 `missing`，不能沿用历史 readiness。

五模态 relay evidence 必须来自真实 HTTPS relay，且每个 modality 都要有唯一 provider request id、usage、cost；使用 pricing snapshot 时还必须有 pricing version 和 pricing group。异步视频必须在 evidence 生成前确认最终成功状态和 HTTPS artifact，不能把 `IN_PROGRESS` 记录为成功。

本地 Compose、fixture、示例 YAML、测试 token 和 Playwright 结果只能证明开发或契约层，不得写入 production evidence，也不得解除 `PRODUCTION_CONFIG_PATH`、Secret Manager、宿主 ChatGPT evidence 或支付/平台/云资源门禁。

## Owner 审计记录（2026-09-05）

CodeGraph 本地索引当前包含 1,136 个文件、15,906 个节点和 60,408 条边；项目元数据记录的最近完整索引为 757 个源码文件。模型状态改动涉及的三个源码文件均存在于索引中，关系面覆盖 `ModelsPage`、`OverviewPage`、`ModelStatusSection`、`ModelServiceSummary` 及对应测试；新增文档和 package 脚本不属于代码图节点。gbrain CLI 当前未安装，因此没有把 gbrain 同步状态冒充为 CodeGraph 更新状态。

桌面 Playwright 体验中，Merchant Studio 场景通过；Ops Console 裸 Playwright 命令会因缺少 OIDC 环境而在认证前失败，官方 OIDC runner 则进入“权限未验证”页面并未形成成功证据。仓库新增 `npm run test:browser:ops`，统一从 OIDC runner 启动，避免把错误的启动方式当成产品回归结果；真实 OIDC/宿主证据仍需部署环境完成。
