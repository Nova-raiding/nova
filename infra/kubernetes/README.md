# Kubernetes 生产部署基线

这里是云厂商无关的部署合同，适用于 ACK、EKS、GKE、AKS 或其他兼容 Kubernetes 的托管集群。它不创建 PostgreSQL、Redis、KMS、Secret Manager、WAF、DNS 或证书；这些依赖必须使用托管服务，并通过 `merchant-runtime-secrets` 注入。

## 部署前必须完成

1. 将 `overlays/pilot-50/kustomization.yaml` 中的 `REPLACE_ME` 替换为不可变镜像仓库，并把最终镜像渲染为带 64 位 `@sha256:` digest 的引用；仅固定 tag 不满足生产门禁。
2. 通过云 Secret Manager/External Secrets 创建 `merchant-runtime-secrets` 和独立的 `merchant-alert-receiver-secrets`。后者的 `DATABASE_URL` 必须使用仅可执行告警回执安全函数的 `merchant_alert_receiver` 角色，不得复用租户或运营凭据。字段契约见 `secret-contract.example.yaml`（只做文档，不可 apply）；API、Merchant UI 和各 worker 只通过 `secretKeyRef` 注入自身所需字段，禁止 `envFrom.secretRef`。Secret 的完整必填 key 以该契约为准；bucket/region/endpoint 等非密配置由 `merchant-runtime` ConfigMap 提供。发布门禁拒绝内嵌 Secret、Secret 整体注入、越权 key 与未绑定到同一渲染清单的 ConfigMap。
3. 配置托管 PostgreSQL HA、Redis HA、对象存储/KMS、WAF/L7 LB、DNS 和 TLS；数据库与 Redis 不应暴露公网。当前项目域名为 `yxsona.com`，DNS/TLS 需同时覆盖 `yxsona.com` 和 `ops.yxsona.com`，后者提供独立运营台。
4. 先用与部署完全相同的参数生成渲染清单：`kubectl kustomize infra/kubernetes/overlays/pilot-50 > /secure/release/rendered.yaml`。先运行 `ruby infra/kubernetes/validate-scanner-contract.rb /secure/release/rendered.yaml`，确认 scanner 身份白名单、病毒库最低版本、双副本 quorum 与仅内部 Service 的未就绪地址发布契约完整；再通过 `infra/scripts/deploy-verified-manifest.sh` 原子执行其余门禁并 `kubectl apply -f "$RENDERED_MANIFEST_PATH"`。禁止门禁后再次 `apply -k` 或重新渲染；部署必须使用被签名证据和 SHA-256 绑定的同一份字节。
5. 以 `/healthz`、迁移版本、队列队龄、平台 capability evidence 和容量报告完成 Go/No-Go；Kubernetes manifest 本身不等价于真实云验收。

## 支付拓扑

Kubernetes 基线使用托管的 HTTPS 支付 provider：`merchant-runtime` 中的
`PAYMENT_*` 地址必须指向已经验收的生产 provider，API 通过
`merchant-runtime-secrets` 读取 provider key 和回调密钥。基线不会把
`services/payment-gateway`（支付宝签名网关）隐式注入集群；该网关目前只在
ECS pilot Compose overlay 中声明，并挂载受管密钥文件。不要把
`payments.example.com` 或其他占位地址当作生产配置，也不要在没有独立镜像
digest、Secret 合同和回调网络策略的情况下手工追加一个 payment Deployment。
如果选择在 Kubernetes 集群内运行该网关，必须先为它建立独立的发布镜像、
密钥合同、Service/NetworkPolicy、健康检查和 release evidence，并把这些
绑定纳入同一份渲染清单后再放量。

## 扩容

首发 `pilot-50` profile 使用 API 3 副本、sync/generation 各 2、publish 3、reconcile 2、automation 1，满足无状态入口的最小冗余要求。按 `infra/scripts/scale-workloads.sh` 的 `wave_100`、`wave_250`、`target_500` 调整副本，并在每一波复测数据库连接、队龄、平台/模型配额和租户公平性。

对象存储身份使用 ACK RRSA，不使用节点 ECS metadata。上线前须在目标 ACK 集群启用 RRSA 和 `ack-pod-identity-webhook`，创建 `StoreNovaAckOssRole`，将信任策略的 `oidc:sub` 精确限制为 `system:serviceaccount:merchant:merchant-api-rrsa`，并只授予 `codex-image-20260914/merchant-assets/*` 所需的 OSS 权限。Webhook 必须向 API Pod 注入 `ALIBABA_CLOUD_ROLE_ARN`、`ALIBABA_CLOUD_OIDC_PROVIDER_ARN` 和 `ALIBABA_CLOUD_OIDC_TOKEN_FILE`；任一缺失时 `/readyz` 保持 503，禁止回退到共享节点角色或长期 AccessKey。

API HPA 上限为 12；sync/generation/publish/reconcile 分别声明 HPA/PDB，automation 保持单副本并使用 PDB，扩缩容边界与 `scale-workloads.sh` 保持一致。当前 HPA 使用 CPU 作为无供应商依赖的最低门槛，生产还必须接入队列深度/最老任务年龄的 custom metrics，不能把 CPU HPA 当作队列容量证据。

## 指标采集现状（未打通）

`Service/merchant-api` 上的 `prometheus.io/scrape|path|port` 注解只是**约定**：本仓库没有部署 Prometheus，也没有任何进程读取这些注解，所以**当前没有任何指标被采集**。要真正采到，必须依次补齐四项，缺一项都只会得到空序列：

1. **令牌**：`METRICS_AUTH_TOKEN` 作为 `merchant-runtime-secrets` 的 key 由托管密钥系统下发（契约见 `secret-contract.example.yaml`），并已通过 `secretKeyRef` 注入 API（`base/api.yaml`）。`NODE_ENV=production` 下缺失该值时 `GET /metrics` 固定返回 `503 METRICS_AUTH_NOT_CONFIGURED`，值不匹配返回 401。它是 Secret key 而非 ConfigMap key：发布门禁会拒绝任何形如 `*_TOKEN` 的 ConfigMap 键。
2. **采集任务**：必须携带 `Authorization: Bearer <token>`，注解本身不带凭据。可照抄的契约见 `infra/observability/prometheus-scrape.example.yaml`。
3. **网络**：`NetworkPolicy/merchant-api-ingress-boundary` 默认只放行 ingress-nginx 与本命名空间内的 UI/Worker；跨命名空间采集必须显式放行，否则请求在到达容器前即被丢弃（症状是采集超时，而不是 401）。`base/network-policies.yaml` 中已为 `monitoring` 命名空间的 `prometheus` Pod 预留了一条规则，**部署前必须按实际命名空间和标签改写**。
4. **告警通道**：`infra/observability/prometheus-alerts.example.yaml` 是未部署的规则模板，需要 Alertmanager 与真实 paging 通道才会「有人知道」。

**Worker 与 alert-receiver 现在无法靠加注解采集**：

- `alert-receiver` 只应答 `/healthz`、`/readyz`、`/internal/v1/alerts`，没有 `/metrics`。
- 已提交的 Worker 运行时也不监听任何 HTTP 端口（`apps/worker/src/main.ts` 是轮询循环），给它加 `prometheus.io/scrape` 只会指向不存在的端点。

真正可用的队列信号目前由 API 的 `/metrics` 导出（`merchant_queue_oldest_job_age_seconds`、`merchant_job_state_count`、`merchant_outbox_pending_events`）。

**即使 Worker 将来暴露了 `/metrics`，只加注解仍然不够。**以下三项必须同时成立，缺任何一项的表现都是采集超时或连接被拒（而不是 401）：

1. 端点必须绑定到 Pod 的可达地址。仓库中的 Worker 指标服务默认绑定 `127.0.0.1`（`WORKER_METRICS_HOST`/`WORKER_METRICS_PORT`），loopback 对跨 Pod 采集永远不可达，必须显式改为 `0.0.0.0`。
2. Worker Deployment 必须声明对应的 `containerPort` 并加上 `prometheus.io/scrape|path|port` 注解（当前 `base/workers.yaml` 两者都没有）。
3. 必须有一条 NetworkPolicy 放行采集方到该端口；现有策略里 Worker 只有出向规则，入向默认拒绝。

因此本次**没有**给六个 Worker Deployment 或 alert-receiver 添加采集注解：在端点本身不存在（或绑定 loopback）时加注解，等于把一个不存在的目标写成「已接入监控」，比不加更糟。补完上述三项后，注解应加到 Worker 自己的指标端口，而不是 API 的 8787。
