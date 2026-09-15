# Store Nova 上线续验记录 · 2026-09-15

时间：2026-09-15 12:27 +08:00（owner 最新代码整合复验）
范围：真实 ChatGPT 插件/MCP、支付与账务、租户权限、桌面后台、知识库、五模态中转及发布门禁。

## 判定

**NO-GO。** 第一合并检查点为 `67308854`（保留远端 `cc2fd361` UI 与 owner 修复）；现继续合并固定远端 `d457fea6` 及迁移 211 门禁补丁，尚未推送或部署。最终版本必须重新验收，旧分支/共享部署/不可用 artifact 不代表当前候选。

## owner 已验证的第一检查点

- `npm run check` 退出 0：四组 5,834 项通过（72 项真实环境测试跳过，不算通过），后台独立 97 文件/615 项通过；138 个后台前端契约引用完整，metadata 校验及两个桌面 UI 构建通过。
- 合并定向 326 项、后续 API/契约/账务 296 项、统一生产 OAuth 门禁 65 项通过。删除了重复支付 worker handler；self/workspace/platform 账务策略分离，生产 OAuth 配置不完整时静态令牌不再兜底。
- 隔离 PostgreSQL 17/Redis：20 文件、21 项通过。插件 bridge 严格返回真实余额 `available_points=500/reserved_points=0/settled_points=0`，canonical OAuth 买家、回调重放仅入账一次及另一成员订单不可见均通过。证据 `artifacts/isolated-postgres/run-kbRPAs/`，run ID `fb321582-360f-461e-93a4-22320862b0f6`，两个精确容器复查不存在。
- 最后一次 owner 支付 probe：`artifacts/payment-reconciliation/run-9UDlfU/run-result.json`，run ID `57ab363a-8874-4cb5-93f7-0742db42f4a8`，通过。行锁仍被 blocker 持有时 5,525 ms 返回原始 `55P03/attention_required`，账本不变，恢复仅入账一次；四类真实 PG 审计投影故障保留正确结算/退款/释放状态与事务 outbox。源指纹一致，两个精确 fixture 容器复查不存在。provider 是独立 localhost stub，真实支付/模型调用为 0。
- 历史失败 `artifacts/payment-reconciliation/run-uGyez2/run-result.json` 保留为失败；修复后通过不改写其结果。
- ClamAV 实际 100MiB INSTREAM 通过，压缩展开 101MiB 触发 limits-exceeded FOUND；交付产品上限仍 50MiB。仅精确 MCP/资产上传路径有较大 body budget，普通 API/支付回调保持 1m；独立 PG17 迁移镜像门禁、支付非公网/占位/canonical URL 门禁已复核。专项 agent 原始证据在 `/private/tmp/merchant-infra-runtime-evidence-wrcFi3`，不代表 ACK 已部署通过。

## 最新增量及仍需复验

- 保留他人交付 Upload 的目的级 `data-testid` 与浏览器定位提交；此次远端增量没有 CSS/布局修改，不用旧组件覆盖远端 UI。
- 保留 OCR provider/cost gate、递归敏感字段脱敏、只接受已上传合同 asset 引用及视频最后操作人归因。
- metadata 迁移尾更新为 211，插件版本保留 `0.1.0+codex.20260915100904`；不回退插件或放宽余额数量断言。
- 迁移 211 新增真实 PG 门禁由独立 agent 验证：210→211 历史不变/幂等、跨租户更新 42501、账号身份错配 23503、16 类 catalog 篡改拒绝。原旧门禁误判保留红灯证据。owner 尚须整合后在最终源码重跑，不能将独立工作树结果当 owner 最终通过。
- 默认商家浏览器现使用随机独立端口、唯一 project/images、环境白名单、真实 health/SHA 身份检查及精确容器清理；必须冻结干净提交后再跑。之前默认测试误连 101 SSH 隧道，已排除出候选验收。只读 101 窗口核验未发现可归因的新增业务或密码会话，但无基线/完整请求日志，不能宣称全部副作用为 0。
- 最终全量检查、隔离 PG/支付/桌面验收及最终合并提交/推送仍待完成。没有删除业务数据或容器数据掩盖失败。

## 真实上线阻断

1. 真实 ChatGPT 宿主安装缓存、当前令牌、初始化/151 项工具/引导/历史必须与最终 digest 一致。此前真实任务旧令牌 403 是历史观察，不以 one-shot 或浏览器替代新宿主验收。
2. 共享 101 仍为旧部署、迁移尾 209；需要备份与恢复升级演练，再部署 211 和精确镜像并复核。
3. 支付 provider、真实支付宝小额支付、签名 callback、查单、退款及对账回执还须真实闭环。审计投影失败现明确暴露并保留事务事实，不能称自动投影补偿已经实现。
4. 知识库生产 embedding/index worker/跨副本检索和插件实际消费证据仍待验。
5. 五模态中转必须重采绑定最终 release 的鉴权、请求、用量、成本和错误证据；旧 release 证据不能复用为新版本通过。
6. ignored 生产配置 locator 只保存路径，不包含或恢复秘密配置；draft/BLOCKED 配置不等于实际目标生产配置，最终 launch preflight 与部署 canary 尚未通过。

## GO 前顺序

冻结最终候选并完成同源全量/隔离验收 → 数据库备份与恢复升级演练 → 精确镜像部署并核验 211 → 真实 ChatGPT/支付宝/知识库/中转 canary → 目标生产 launch preflight。任何一步未通过都保持 NO-GO。
