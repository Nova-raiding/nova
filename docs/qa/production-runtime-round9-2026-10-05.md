# Production runtime round-nine read-only review

审查时间：2026-10-04 23:17:30 UTC。仅执行公网 healthz/releasez、101 SSH/Docker 及容器内 evidence `stat`/hash 只读探针；没有修改主机、容器、镜像、路由、证据挂载、Keychain 或 release metadata。本记录不包含 secret、token、cookie、密码或完整环境变量值。

## 公网 healthz/releasez

- API 与 Ops healthz 均 HTTP 200，`status=ok`，`writesEnabled=false`。
- 两端 capability evidence 仍 `state=blocked`、`configured=false`，原因 `CAPABILITY_EVIDENCE_PATH cannot be read`；capacity evidence 同样 blocked，原因 `CAPACITY_REPORT_PATH cannot be read`。
- API 与 Ops releasez 均 HTTP 200、`ready=true`，并返回相同 identity：`ecs-3dc76c93b536`、Git `3dc76c93b53652190f03454b305c86931e5f72ae`、manifest `d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`、image-set `sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`。
- 当前候选 HEAD 仍为 `59eb1e8db78005a2f9be1b8a808507422ffc82b8`，未见新的 candidate-bound runtime release identity。

## 101 containers and evidence readability

101 `docker ps` 仍显示 API/API replica、六类 worker、merchant UI、Ops UI、payment/pilot gateway、Postgres、Redis、ClamAV 与 registry running/healthy。

API 与 API replica 内 evidence mounts 仍为 `root:root`, mode `0600`, size `3`：`/run/release-evidence/platform-capability.json` 与 `/run/release-evidence/capacity-report.json`。以应用进程执行 `sha256sum` 对两者均返回 `Permission denied`。未读取或修改 source mount。

运行镜像仍为混合 provenance（API/worker、merchant/Ops UI、payment、pilot 各自不同 RepoDigest/OCI revision），不具备单一 candidate-bound image-set 证明。

## Candidate-bound evidence and decision

本轮没有观察到新的 candidate-bound capability/capacity artifact、runtime handoff、签名 release package、完整候选 image-set 或 isolated cutover preflight。现有 capability/capacity round9 审计仍结论 `BLOCKED_NO_CAPTURED_CANDIDATE_ARTIFACT`；image provenance 仍 `BLOCKED_IMAGE_SET_DRIFT`。

结论：`NO-GO` 持续有效。未执行 rebind、重启、清理、镜像替换、部署或权限绕过。原始只读输出保存在 `docs/qa/evidence/2026-10-05-runtime-round9/`。
