# Production runtime round-eight read-only review

审查时间：2026-10-04 22:59:41 UTC。仅执行公网 HTTPS 与 101 SSH/Docker 只读探针；没有修改主机、容器、镜像、路由、证据挂载、Keychain 或 release metadata。本记录不包含 secret、token、cookie、密码或完整环境变量值。

## 公网健康与 release identity

- `https://yxsona.com/api/healthz`、`https://ops.yxsona.com/healthz` 均 HTTP 200，`status=ok`，`writesEnabled=false`。
- 两端仍报告 capability/capacity evidence blocked：`CAPABILITY_EVIDENCE_PATH cannot be read`、`CAPACITY_REPORT_PATH cannot be read`；无 candidate-bound cloud evidence 出现。
- `/releasez` API/Ops 均 HTTP 200、`ready=true` 且身份一致：`release_id=ecs-3dc76c93b536`；`release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`；`manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`；`image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`。
- 本地候选 HEAD 仍为 `59eb1e8db78005a2f9be1b8a808507422ffc82b8`。新发现的 `docs/qa/capacity-plan-59eb1e8db780-20261005.json` 只是离线 capture plan，标明 `network_activity=false`、`produces_cloud_gate_evidence=false`，不存在相应 raw capture；不能改变生产证据状态。

## 101 runtime and evidence mount

`docker ps` 只读结果显示 API/API replica、六类 worker、merchant UI、Ops UI、payment/pilot gateway、Postgres、Redis、ClamAV 和 registry 均 running/healthy。应用 image/revision provenance 仍混杂，与线上 release image-set 和候选 SHA 无一致性证明。

API 与 API replica 内的两份 evidence mount 仍为 `root:root`、`0600`、3 bytes：

- `/run/release-evidence/platform-capability.json`
- `/run/release-evidence/capacity-report.json`

应用进程对两者执行 `sha256sum` 均返回 `Permission denied`。未读取、复制、替换或重启任何资源。

## Candidate-bound evidence and decision

本轮未观察到任何新的 candidate-bound capability/capacity evidence、签名 release package、完整候选 image-set 或受保护 cutover preflight。`NO-GO` 继续有效；不得通过 rebind 公网 metadata 来掩盖线上/候选漂移。原始只读输出保存于 `docs/qa/evidence/2026-10-05-runtime-round8/`。
