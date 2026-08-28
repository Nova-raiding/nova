# Kubernetes 生产部署基线

这里是云厂商无关的部署合同，适用于 ACK、EKS、GKE、AKS 或其他兼容 Kubernetes 的托管集群。它不创建 PostgreSQL、Redis、KMS、Secret Manager、WAF、DNS 或证书；这些依赖必须使用托管服务，并通过 `merchant-runtime-secrets` 注入。

## 部署前必须完成

1. 将 `overlays/pilot-50/kustomization.yaml` 中的 `REPLACE_ME` 替换为不可变镜像仓库，并把最终镜像渲染为带 64 位 `@sha256:` digest 的引用；仅固定 tag 不满足生产门禁。
2. 通过云 Secret Manager/External Secrets 创建 `merchant-runtime-secrets`。字段契约见 `secret-contract.example.yaml`（只做文档，不可 apply）；当前 Kubernetes 基线将 API 设为 `OPS_AUTH_MODE=oidc`，Secret 至少包含 `DATABASE_URL`、`REDIS_URL`、`API_AUTH_TOKENS`、`OIDC_PROXY_SIGNING_SECRET`、`WORKER_API_TOKEN`、`WORKER_API_SIGNING_SECRET`、`ASSET_STORAGE_KMS_KEY_ID`、`VAULT_TOKEN` 和 `RULE_APPROVAL_TOKENS`。bucket/region/endpoint 等非密配置由 `merchant-runtime` ConfigMap 提供。
3. 配置托管 PostgreSQL HA、Redis HA、对象存储/KMS、WAF/L7 LB、DNS 和 TLS；数据库与 Redis 不应暴露公网。DNS/TLS 需同时覆盖 `merchant.example.com` 和 `ops.merchant.example.com`，后者提供独立运营台。
4. 先用与部署完全相同的参数生成渲染清单：`kubectl kustomize infra/kubernetes/overlays/pilot-50 > /secure/release/rendered.yaml`。准备不含密钥的六平台能力证据 JSON 和容量报告，并通过 `RENDERED_MANIFEST_PATH=/secure/release/rendered.yaml CAPABILITY_EVIDENCE_PATH=/path/platform-evidence.json CAPACITY_REPORT_PATH=/path/capacity-report.json infra/scripts/deploy-preflight.sh` 检查渲染后的生产配置、能力证据、真实云容量和每个容器的镜像 digest，再执行 `kubectl apply -k infra/kubernetes/overlays/pilot-50`。
5. 以 `/healthz`、迁移版本、队列队龄、平台 capability evidence 和容量报告完成 Go/No-Go；Kubernetes manifest 本身不等价于真实云验收。

## 扩容

首发 `pilot-50` profile 使用 API 3 副本、sync/generation 各 2、publish 3、reconcile 2、automation 1，满足无状态入口的最小冗余要求。按 `infra/scripts/scale-workloads.sh` 的 `wave_100`、`wave_250`、`target_500` 调整副本，并在每一波复测数据库连接、队龄、平台/模型配额和租户公平性。

API HPA 上限为 12；sync/generation/publish/reconcile 分别声明 HPA/PDB，automation 保持单副本并使用 PDB，扩缩容边界与 `scale-workloads.sh` 保持一致。当前 HPA 使用 CPU 作为无供应商依赖的最低门槛，生产还必须接入队列深度/最老任务年龄的 custom metrics，不能把 CPU HPA 当作队列容量证据。
