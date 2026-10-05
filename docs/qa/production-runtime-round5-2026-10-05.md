# Production runtime round-five read-only review

审查时间：2026-10-04 22:33 UTC（公网 HTTPS 探针与 101 SSH/Docker 只读）。本记录不包含 secret、token、cookie 或完整环境变量值。

## 公网 API/Ops 健康与 release 身份

- `https://yxsona.com/api/healthz`：HTTP 200，`status=ok`，Postgres/Redis ready，production controls ready，授权覆盖为 336/336，relay/payment/cost gates ready。
- `https://ops.yxsona.com/healthz`：HTTP 200，返回同一运行时摘要。
- 未携带凭据访问 `https://yxsona.com/api/log/self` 和 `https://ops.yxsona.com/api/log/self` 均 HTTP 401，错误码 `UNAUTHENTICATED`；响应只返回 request/trace id 与通用错误，不泄露审计数据。未尝试伪造或重放凭据。
- 未携带凭据访问 API `/readyz` 与 Ops `/api/healthz` 为公开 HTTP 200 探针；其响应仍保留 capability/capacity blocked 状态，不能作为授权或发布批准。
- `/releasez`、`/api/releasez`（API）和 Ops `/releasez` 均 HTTP 200 且身份一致：
  - `release_id=ecs-3dc76c93b536`
  - `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
  - `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
  - `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`
- 健康响应仍报告 `productionEvidence.capability.state=blocked`（`CAPABILITY_EVIDENCE_PATH cannot be read`）及 `productionEvidence.capacity.state=blocked`（`CAPACITY_REPORT_PATH cannot be read`）。HTTP 200 不覆盖这两个阻断。

## 101 容器与镜像投影

`ssh 101 'docker ps ...'` 只读结果：API、API replica、六个 worker、商家 UI、Ops UI、payment gateway、pilot gateway、Postgres 16、Redis 7、ClamAV 和 registry 均 running；应用容器均 healthy。

实际 immutable image / OCI revision 仍是跨组件集合：

| 组件 | 镜像 digest | OCI revision |
| --- | --- | --- |
| API/API replica | `merchant-api@sha256:8b8938779b073a8554ba0a48d86067e96e951b53fd3c065ad072fce8319479e` | `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5` |
| worker generation（其他 worker 同族） | `merchant-worker@sha256:2aca1cf726dfd110dbffca1e90a764794481dbe5db4a45b982435a5f8ba791ce` | `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5` |
| merchant UI | `merchant-ui@sha256:111c918ffc4996a3a770bb352ec670edecb4845ba749f2db4cee5ad4eeab32c9` | `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb` |
| Ops UI | `merchant-ops-ui@sha256:a904814fd5a152af82509b51ac885ac60498050cd7a03b2e121922e1f31995b0` | `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb` |
| payment gateway | `payment-gateway@sha256:af8f6a4e3501e613731012130cda6d714d2cd4560f0bd9452e825a485a807f81` | `0fa18b78a65de8c5b07f09488f416a6ed08bfe08` |
| pilot gateway | `pilot-gateway@sha256:5a367cb6236b949816eaaafeb6d7fd3f7ca50879579510faa5c2796d0dd9513b` | `3567df1e2894aaf45974464f2ecad50b187971ab` |

候选 identity 仍为 `git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`，与公网 release SHA 不一致。未执行 rebind、重建或部署。

## Evidence 挂载与权限

API 与 API replica 均以只读 bind mount 使用：

- `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capability.placeholder.json` → `/run/release-evidence/platform-capability.json`
- `/var/lib/merchant-release-security/demo-first-install/release-85575f9c/capacity.placeholder.json` → `/run/release-evidence/capacity-report.json`

容器内 `stat` 显示两个目标均为 `root:root`、`0600`、3 bytes；非 root 应用进程无法读取（`sha256sum`/`od` 返回 Permission denied）。这与公网健康端点的两个 `cannot be read` 阻断一致。worker 没有对应 evidence mount。未读取、复制或修改 host source 文件。

## 结论

公网服务可响应且容器健康，但候选与线上 SHA 不一致，线上镜像 provenance 仍混杂，当前 capability/capacity 仍是不可读的 root-only `{}` 占位挂载。生产发布继续 `NO-GO`；本审查未授权部署或 metadata rebind。
