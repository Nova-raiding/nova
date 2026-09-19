# 上线交付执行计划

本文把 `delivery-input-checklist.md` 的 96 项输入与 `release-unblock-checklist.md` 的发布门禁，整理成**有时序、有依赖、有验收判据**的执行计划。

**每个阶段都有明确的「出口判据」**——不满足就不进入下一阶段。这样做的原因是：本仓库历史上出现过两次「客户与运营双向死锁」的缺陷（支付通道缺失、manual 档无建店途径），二者都是**某一步的输入缺失，直到最后一个环节才暴露**。按阶段验收可以在最早的时刻发现缺项。

> 每一项配置的**提供方 / 不填会怎样**见 `delivery-input-checklist.md`；本文只写**顺序、依赖与验收**。

---

## 阶段 0：数据库与角色（所有后续阶段的前置）

**做什么**
1. 迁移链跑到 **227**（`release-metadata.json` 的 `expectedMigrationVersion` 为准）。
2. 按部署 entrypoint 的**真实顺序**跑角色 bootstrap：`ensure-app-role.sql` → 迁移 → `ensure-app-role.sql`。
3. 部署 API / Worker，确认 `/healthz`、`/readyz`、`/releasez`。

**为什么顺序不能反**：迁移 146 的目录表 `REVOKE` 依赖角色已存在；第二次 bootstrap 又负责把拒绝清单钉死并对迁移新装的 `SECURITY DEFINER` 投影再授权。顺序错了会出现「权益判定读不到证据」——本会话修掉的那类静默失败。

**出口判据**
```sql
-- 目录表：运行时角色必须无权直读，运营角色必须可读
SELECT has_table_privilege('merchant_app','commercial_catalog_sku_versions','SELECT');  -- false
SELECT has_table_privilege('merchant_ops','commercial_catalog_sku_versions','SELECT');  -- true
-- 权益投影：运行时角色必须可执行
SELECT prosecdef, proconfig FROM pg_proc WHERE proname='merchant_entitlement_snapshots_v2';
```
```sh
curl -fsS https://<api>/releasez    # ready=true，且迁移版本 == 227
```

---

## 阶段 1：身份与 MCP 边界（解锁「插件能连上」）

**依赖**：阶段 0。
**填**：`merchant_bearer_hostname`、`app_base_url`、`ops_base_url`、`mcp_base_url`、`mcp_authorization_mode`、`OPS_AUTH_MODE`、`auth_enforcement`、`session_id_hash_secret_ref`、`durable_platform_assignments_required`（9 项）。

**约束（门禁强制，写错直接拒绝）**
- `mcp_base_url` 必须**逐字等于** `app_base_url`（插件自行追加 `/mcp`）
- `app_base_url` 主机 == `merchant_bearer_hostname`
- `ops_base_url` 主机**必须与商家主机不同**（运营台走独立 OIDC 边界）
- 生产要求 `mcp_authorization_mode=enforce`、`durable_platform_assignments_required=true`

**出口判据**：商家与运营两个 origin 分别可达；用真实 bearer 调 `workspace.health` 返回 200；`merchant.start` 返回商业门禁错误（402/503）而非认证错误。

---

## 阶段 2：模型中转（解锁「生成可用」）

**依赖**：阶段 1。
**填**：`model_relay_base_url`、`model_relay_api_key_ref`、5 个模型 ID、`embedding_*`、RPM/TPM 与成本上限（14 项）。

**约束**：relay 主机名必须与 `MODEL_RELAY_ALLOWED_HOSTS` **完全一致**；占位域名会被配置门禁拒绝。

**出口判据**：跑一次真实生成，`model_usage_ledger` 出现带 provider request ID 与成本的记录。**不要用 fixture 代替**。

---

## 阶段 3：支付（解锁「客户能付钱」）

**依赖**：阶段 1。可与阶段 2 并行。

**二选一，但必须明确选一个**
- **A. 在线网关**：填 13 项 `payment_*` + `commercial_payment_provider=alipay`。要求 `PAYMENT_MODE=provider` 且网关地址非占位。
- **B. 线下人工**：`commercial_payment_provider=manual_transfer`，订单会落库，客户线下转账、运营核验后发放。

**⚠️ 本仓库最容易踩的坑**：**不要**在网关未就绪时把 `commercial_payment_provider` 设成 `alipay`——订单会落库但结账失败，客户看到的是「下单成功但付款失败」。要么配齐网关，要么老实写 `manual_transfer`。

**出口判据**：下一笔真实小额订单 → `commercial_orders_v2` 有行 → `GET /v1/commercial/orders/<id>/payment` 返回 `paid` → 额度到账且**恰好一段**权益周期生效。
```sql
SELECT count(*) FROM workspace_subscription_periods_v2 WHERE workspace_id='<ws>' AND status='active';
-- 必须 ≤ 1；两段重叠会让 decide 返回 COMMERCIAL_ENTITLEMENT_AMBIGUOUS（本会话修掉的缺陷）
```
**再下一笔**（模拟续费），确认不影响服务。

---

## 阶段 4：素材扫描器 + 对象存储（解锁「素材链路」）

**依赖**：阶段 1。
**填**：扫描器 14 项 + 对象存储 6 项。

**已修复（原为部署阻塞）**：scan pod 曾设 pod 级 `runAsNonRoot: true`，而固定的 ClamAV 镜像以 root 运行，kubelet 会拒绝该容器。现已改为：`runAsUser/runAsGroup: 10001` + 镜像自带的 `/init-unprivileged` 入口 + 把生效的 `clamd.conf` 作为 ConfigMap（`infra/kubernetes/base/clamav-config.yaml`）挂载到 `/etc/clamav/clamd.conf` + 探针改为从该文件实读断言。

**同时修掉了一个更深的静默削弱**：原先 `CLAMD_CONF_*` 环境变量依赖 root 的 `sed -i` 才能生效，而镜像编译默认里 `MaxScanSize` 是 400M、`AlertExceedsMax` 是关闭的——超限归档会被判为 `OK` 而不是 `Heuristics.Limits.Exceeded.* FOUND`。现在四项指令由配置文件承载，并由部署门禁逐条断言（`validate-kubernetes-release.rb` 的 `validate_clamav_daemon_config`），另有 `validate_pod_container_identity` 保证 `runAsNonRoot` 的 Pod 内不会再有解析为 root 的容器。

**仍存在的运维风险（未改）**：`startupProbe` 预算为 30×10s = 300s，而冷启动需下载约 113 MB 病毒库。上生产前建议单独评估该预算。

**出口判据**：上传一份隔离素材 → 扫描完成 → `asset.parse` 返回 200；对象出现在 bucket 且带版本；扫描回执可验签。

---

## 阶段 5：运营建店（解锁「平台侧能力」）

**依赖**：阶段 0–4。
**做什么**：运营用 `ops.platform.store.record.create` 为商家登记人工店铺范围（`platform` + `account_id` + `reason`）。

**出口判据**：登记后客户 `catalog.import` 成功、商品绑定到该店铺、`task.create` 返回成功（**既不是 428 `STORE_ONBOARDING_REQUIRED`，也不是 409 `PLATFORM_ACCOUNT_REAUTH_REQUIRED`**）。

**注意**：manual 档下 `catalog.sync` 与 `publish.confirm` 会以 503 拒绝，这是**设计**——人工发布走 `publish.manual.*` 与交付包导出，不是缺陷。

---

## 阶段 6：可观测性与告警通道（当前 NO-GO，可与前几阶段并行）

**填**：`alert_notifications_enabled`（+ 通道 secret）、监控栈。

**必须先补齐的六项**（见 `production-ops-runbook.md` 3.4）：部署 Prometheus、部署 Alertmanager（或等价）、**一条真实 paging 通道**、值班表、**至少一次触发→送达→人工确认的演练记录**、dead-man's switch 接收方。

**出口判据**：制造一次真实告警 → 有人被叫醒 → 记录时间戳、确认人、耗时。**没有演练记录的告警通道不算成立。**

**这一项是 Go/No-Go 清单里明确的 NO-GO**，不得用「已配置 webhook」或「规则文件已提交」替代。

---

## 阶段 7：生产签名证据与 release manifest

**依赖**：阶段 0–5（部分需要生产环境实际运行）。
**要求**：以下证据必须**由生产环境生成并签名**，禁止用 fixture / example / test 文件替代：
- 平台 capability canary（六平台，按 manual 运营模式如实记录，不虚构 OAuth 成功）
- capacity report
- model relay / Codex app host / object storage / payment / restore 证据
- release manifest 与 evidence bundle，全部绑定**同一 `RELEASE_ID`**，并由固定 trust anchor 以 Ed25519 签名

**出口判据**：`deploy-preflight-ecs.sh` 与 `deploy-verified-ecs-compose.sh` 全绿。

---

## 阶段 8：验收

```sh
curl -fsS https://yxsona.com/api/healthz
curl -fsS https://ops.yxsona.com/healthz
curl -fsS https://yxsona.com/api/releasez     # ready=true
```

**只有以下全部成立才可向商家开放真实使用**：`/api/releasez` 返回 `ready=true`、数据库迁移版本等于 227、素材扫描器 healthy、候选 release 身份一致。

---

## 最短路径（只想尽快让第一个客户走通）

按依赖序，**只需四组**即可让第一个付费客户完成「导入商品 → 生成内容 → 人工交付」：

**阶段 1（身份/MCP）→ 阶段 2（模型中转）→ 阶段 3（支付，可用 `manual_transfer`）→ 阶段 4（扫描器 + 对象存储）**，然后阶段 5 建店。

**阶段 6（告警通道）与阶段 7（签名证据）** 可在灰度期并行推进，但**不能在发布判定时以「已配置」替代**——它们是 Go/No-Go 的组成项，不是可选项。
