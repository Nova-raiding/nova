# Kubernetes 生产部署基线

这里是云厂商无关的部署合同，适用于 ACK、EKS、GKE、AKS 或其他兼容 Kubernetes 的托管集群。它不创建 PostgreSQL、Redis、KMS、Secret Manager、WAF、DNS 或证书；这些依赖必须使用托管服务，并通过 `merchant-runtime-secrets` 注入。

## 部署前必须完成

1. 将 `overlays/pilot-50/kustomization.yaml` 中的 `REPLACE_ME` 替换为不可变镜像仓库，并把最终镜像渲染为带 64 位 `@sha256:` digest 的引用；仅固定 tag 不满足生产门禁。
2. 通过云 Secret Manager/External Secrets 创建 `merchant-runtime-secrets`。字段契约见 `secret-contract.example.yaml`（只做文档，不可 apply）；API、Merchant UI 和各 worker 只通过 `secretKeyRef` 注入自身所需字段，禁止 `envFrom.secretRef`。Secret 的完整必填 key 以该契约为准；bucket/region/endpoint 等非密配置由 `merchant-runtime` ConfigMap 提供。发布门禁拒绝内嵌 Secret、Secret 整体注入、越权 key 与未绑定到同一渲染清单的 ConfigMap。
3. 配置托管 PostgreSQL HA、Redis HA、对象存储/KMS、WAF/L7 LB、DNS 和 TLS；数据库与 Redis 不应暴露公网。DNS/TLS 需同时覆盖 `merchant.example.com` 和 `ops.merchant.example.com`，后者提供独立运营台。
4. 先用与部署完全相同的参数生成渲染清单：`kubectl kustomize infra/kubernetes/overlays/pilot-50 > /secure/release/rendered.yaml`。先运行 `ruby infra/kubernetes/validate-scanner-contract.rb /secure/release/rendered.yaml`，确认 scanner 身份白名单、病毒库最低版本、双副本 quorum 与仅内部 Service 的未就绪地址发布契约完整；再通过 `infra/scripts/deploy-verified-manifest.sh` 原子执行其余门禁并 `kubectl apply -f "$RENDERED_MANIFEST_PATH"`。禁止门禁后再次 `apply -k` 或重新渲染；部署必须使用被签名证据和 SHA-256 绑定的同一份字节。
5. 以 `/healthz`、迁移版本、队列队龄、平台 capability evidence 和容量报告完成 Go/No-Go；Kubernetes manifest 本身不等价于真实云验收。

## 扩容

首发 `pilot-50` profile 使用 API 3 副本、sync/generation 各 2、publish 3、reconcile 2、automation 1，满足无状态入口的最小冗余要求。按 `infra/scripts/scale-workloads.sh` 的 `wave_100`、`wave_250`、`target_500` 调整副本，并在每一波复测数据库连接、队龄、平台/模型配额和租户公平性。

API HPA 上限为 12；sync/generation/publish/reconcile 分别声明 HPA/PDB，automation 保持单副本并使用 PDB，扩缩容边界与 `scale-workloads.sh` 保持一致。当前 HPA 使用 CPU 作为无供应商依赖的最低门槛，生产还必须接入队列深度/最老任务年龄的 custom metrics，不能把 CPU HPA 当作队列容量证据。
