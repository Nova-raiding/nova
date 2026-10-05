# Production runtime round-six read-only review

审查时间：2026-10-04 22:39:50 UTC（公网 HTTPS、101 SSH/Docker、relay 元数据和本机签名身份只读探针）。本记录不包含 secret、token、cookie、密码或完整环境变量值；未修改主机、容器、镜像、路由、证据挂载或 Keychain。

## 公网 API/Ops 健康与 release 身份

- `https://yxsona.com/api/healthz` 和 `https://ops.yxsona.com/healthz` 均 HTTP 200，`data.status=ok`，`writesEnabled=false`；Postgres/Redis 与 production controls 报 ready，授权覆盖 `336/336`，relay/payment/cost gates 报 ready。
- 健康响应中的 model readiness：text/image/image_edit/ocr/video 均 ready 且 endpoint host 为 `ai.wormholexyz.xyz`；embedding 为 `ready=false`，原因 `knowledge_vector_indexing_disabled`、`model_missing`。
- 两个健康响应仍报告 capability/capacity 证据阻断：`CAPABILITY_EVIDENCE_PATH cannot be read`、`CAPACITY_REPORT_PATH cannot be read`。HTTP 200 与其他 ready gate 不覆盖该阻断。
- 未携带凭据请求 relay `/api/log/self` 返回 HTTP 401、`AUTH_UNAUTHORIZED`；未尝试伪造或重放凭据。公网 API/Ops `/api/log/self` 访问仍需可信目标 workspace 会话。
- `/releasez`（API 与 Ops）均 HTTP 200，身份一致：
  - `release_id=ecs-3dc76c93b536`
  - `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
  - `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
  - `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

## 101 容器与镜像投影

`ssh 101 'docker ps ...'` 只读结果显示 merchant API（含 replica）、六类 worker、商家 UI、Ops UI、payment/pilot gateway、Postgres、Redis、ClamAV、registry 均 running/healthy。

应用镜像仍为混合 provenance：API/API replica 使用 `merchant-api@sha256:8b893877…`（OCI revision `fa6beb91…`），worker 使用 `merchant-worker@sha256:2aca1cf7…`（同 revision），merchant UI 使用 `merchant-ui@sha256:111c918f…`（revision `dc63e0b9…`），Ops UI 使用 `merchant-ops-ui@sha256:a904814f…`（同 revision），payment gateway 使用 `payment-gateway@sha256:af8f6a4e…`（revision `0fa18b78…`），pilot gateway 使用 `pilot-gateway@sha256:5a367cb6…`（revision `3567df1e…`）。这些 OCI revision 与公网 release SHA 及当前候选 SHA 均不一致。

当前候选源码 identity 为 `git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`，与公网 `3dc76c93…` 不一致；没有执行 metadata rebind、重启、替换或部署。

## Evidence 挂载与权限

API 与 API replica 容器内目标证据文件均为 `root:root`、`0600`、3 bytes：

- `/run/release-evidence/platform-capability.json`
- `/run/release-evidence/capacity-report.json`

容器应用进程读取和 `sha256sum` 均返回 `Permission denied`。未读取、复制或修改 host source 文件。该只读观察与健康端点的 capability/capacity blocked 原因一致。

## Relay 与本地 Keychain 门禁

- `https://ai.wormholexyz.xyz/api/status` HTTP 200（3090 bytes，body SHA-256 `1a4a3cd0…`）；`/api/pricing` HTTP 200（26993 bytes，body SHA-256 `722258c6…`）。这些只证明 relay reachability/pricing metadata，不证明 actual-cost receipt。
- relay `/api/log/self` 在无凭据下 HTTP 401；真实 provider request、actual cost、幂等结算 ledger 仍无法从可信目标 workspace 读回。
- 本机 `security find-identity -v -p codesigning` 报 `0 valid identities found`。现有 helper 继续是 ad-hoc、无 Team ID；目标 origin/workspace metadata 绑定为 `https://yxsona.com` / `ws_57fd2361ed5b44c7891f3d37`，但凭据 payload 未读取，不能据此证明可用。

## 结论

`NO-GO` 继续有效：公网探针与容器健康不能抵消候选/线上 SHA 不一致、混合镜像 provenance、不可读的 capability/capacity 证据、缺可信签名 Keychain helper 及缺 actual-cost/幂等账单回执。未执行任何发布或权限绕过操作。
