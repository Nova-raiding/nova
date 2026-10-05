# Production runtime round-seven read-only review

审查时间：2026-10-04 22:53:28 UTC。仅执行公网 HTTPS、101 SSH/Docker 和容器内只读 stat/hash 探针；没有修改主机、容器、镜像、路由、证据挂载、Keychain 或 release metadata。本记录不包含 secret、token、cookie、密码或完整环境变量值。

## 公网健康与 release identity

- `https://yxsona.com/api/healthz`、`https://ops.yxsona.com/healthz` 均 HTTP 200，`status=ok`，`writesEnabled=false`。
- 两端均报告 capability evidence `state=blocked`, `configured=false`, reason `CAPABILITY_EVIDENCE_PATH cannot be read`；capacity 同样 `state=blocked`, reason `CAPACITY_REPORT_PATH cannot be read`。健康 HTTP 200 不覆盖这两个阻断。
- text/image/image_edit/ocr/video model readiness 为 ready；embedding 仍 not ready，原因 `knowledge_vector_indexing_disabled`、`model_missing`。
- API/Ops `/releasez` 均 HTTP 200 且身份一致：`release_id=ecs-3dc76c93b536`，`release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`，`manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`，`image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`。
- 本地候选 HEAD 仍为 `59eb1e8db78005a2f9be1b8a808507422ffc82b8`，与线上 release SHA 不一致。

## 101 runtime

`ssh 101 'docker ps ...'` 显示 API/API replica、六类 worker、merchant UI、Ops UI、payment/pilot gateway、Postgres、Redis、ClamAV 和 registry 均 running/healthy。

应用镜像与 OCI revision 仍为混合集合：API `merchant-api@sha256:8b893877…` / `fa6beb91…`；workers `merchant-worker@sha256:2aca1cf7…` / `fa6beb91…`；merchant UI `merchant-ui@sha256:111c918f…` / `dc63e0b9…`；Ops UI `merchant-ops-ui@sha256:a904814f…` / `dc63e0b9…`；payment `payment-gateway@sha256:af8f6a4e…` / `0fa18b78…`；pilot `pilot-gateway@sha256:5a367cb6…` / `3567df1e…`。这些均无法证明与公网 release image-set digest 或候选 SHA 等价。

## Evidence 可读性

API 与 API replica 内：

- `/run/release-evidence/platform-capability.json`：`root:root`, mode `0600`, size `3`；应用进程 `sha256sum` 返回 `Permission denied`。
- `/run/release-evidence/capacity-report.json`：`root:root`, mode `0600`, size `3`；应用进程 `sha256sum` 返回 `Permission denied`。

因此真实 capability/capacity evidence 仍不可读；没有读取、复制或替换 host source 文件。

## Runtime blockers and decision

`NO-GO` 继续有效：线上 release 与候选不一致；101 应用镜像 provenance 混杂；证据文件为 root-only 3-byte mounts 且应用无法读取；embedding 未就绪。未执行 rebind、重启、清理、镜像替换或部署。原始只读投影保存于 `docs/qa/evidence/2026-10-05-runtime-round7/`。
