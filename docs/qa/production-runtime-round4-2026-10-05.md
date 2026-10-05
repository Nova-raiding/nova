# Production runtime round-four read-only review

审查时间：2026-10-04 22:26–22:29 UTC（101 主机与公网探针，SSH/HTTP 只读）。本记录不包含 secret、token、cookie 或完整环境变量值。

## 公网 API/Ops 状态

- `https://yxsona.com/api/healthz`：HTTP 200，`status=ok`；Postgres、Redis、production controls、授权覆盖、payment provider 和 relay 均报告 ready。
- `https://ops.yxsona.com/healthz`：HTTP 200，返回同一运行时摘要。
- 两个域名的 `/releasez` 与 API `/api/releasez` 均一致返回：
  - `release_id=ecs-3dc76c93b536`
  - `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
  - `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
  - `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`
- 健康响应仍明确 `productionEvidence.capability.state=blocked`（`CAPABILITY_EVIDENCE_PATH cannot be read`）和 `productionEvidence.capacity.state=blocked`（`CAPACITY_REPORT_PATH cannot be read`）。HTTP 200 不覆盖这两个阻断。

## 101 容器、镜像和 identity

只读 `docker ps` 显示 API、API replica、worker、商家 UI、Ops UI、数据库、Redis、payment gateway、pilot gateway 与 ClamAV 均 running/healthy；registry running。

本次 `docker inspect` 读取到的实际镜像 digest 仍为跨组件集合：

- API 与 API replica：`merchant-api@sha256:8b8938779b073a8554ba0a48d86067e96e951b53fd3c065ad072fce8319479e9`
- generation worker：`merchant-worker@sha256:2aca1cf726dfd110dbffca1e90a764794481dbe5db4a45b982435a5f8ba791ce`
- merchant UI：`merchant-ui@sha256:111c918ffc4996a3a770bb352ec670edecb4845ba749f2db4cee5ad4eeab32c9`
- Ops UI：`merchant-ops-ui@sha256:a904814fd5a152af82509b51ac885ac60498050cd7a03b2e121922e1f31995b0`
- payment gateway：`payment-gateway@sha256:af8f6a4e3501e613731012130cda6d714d2cd4560f0bd9452e825a485a807f81`
- pilot gateway：`pilot-gateway@sha256:5a367cb6236b949816eaaafeb6d7fd3f7ca50879579510faa5c2796d0dd9513b`

本地候选 `artifacts/deployment-candidates/ecs-20261004T214923Z/candidate-identity.txt` 仍绑定 `git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`，与线上 `3dc76c93b536…` 不一致；没有执行 rebind、重建或部署。

## capability/capacity 文件与挂载

API 容器继续只读挂载：

- `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capability.placeholder.json` → `/run/release-evidence/platform-capability.json`
- `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capacity.placeholder.json` → `/run/release-evidence/capacity-report.json`

两文件均为 `root:root`、`0600`、3 bytes、字节 `7b 7d 0a`（`{}\n`），SHA-256 均为 `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356`。`/run/release-security/evidence-trust` 仅见历史 attester/hash/key 文件，没有当前 `ecs-3dc76c93b536` 的 capability/capacity 签名 bundle。worker 没有相应 evidence 挂载。

## relay 配置边界

API 的环境变量名包含 release 四元组、`CAPABILITY_EVIDENCE_PATH`、`CAPACITY_REPORT_PATH` 以及 relay pricing/cost evidence 相关键；本审查仅核对变量名，不读取值。generation worker 只暴露 relay 相关变量，未发现 release/evidence 变量名。公网健康端点虽报告 relay ready，仍不能替代 provider actual-cost、幂等 receipt 和当前 release 的可审计回执。

## 结论

公网服务当前可用，101 容器保持健康，但候选与线上 release SHA 不一致，线上镜像跨组件 provenance 混杂，capability/capacity 仍为不可读 `{}` 占位文件，且 relay 的真实成本/幂等计费证据仍未形成。生产发布继续 NO-GO，需在受保护 101 环境中以可信候选完成 release identity 绑定、真实 evidence 签署、三方审查和 relay 回执核验后再考虑部署。

