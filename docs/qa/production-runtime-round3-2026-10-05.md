# Production runtime round-three read-only review

审查时间：2026-10-04 22:21–22:23 UTC（101 主机与公网探针，SSH/HTTP 只读）。

## 公网 API/Ops 探针

- `https://yxsona.com/api/healthz`：HTTP 200，`status=ok`；Postgres、Redis、production controls、授权覆盖和 payment provider 报告 ready。
- `https://ops.yxsona.com/healthz`：HTTP 200，返回同一运行时摘要。
- 两个域名的 `/releasez` 以及 `https://yxsona.com/api/releasez` 一致返回：
  - `release_id=ecs-3dc76c93b536`
  - `release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`
  - `manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`
  - `image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`

健康摘要同时明确 `productionEvidence.capability.state=blocked`（`CAPABILITY_EVIDENCE_PATH cannot be read`）和 `productionEvidence.capacity.state=blocked`（`CAPACITY_REPORT_PATH cannot be read`）。这两个阻断不能由健康 HTTP 200 覆盖。

## 101 容器与 release identity

只读 `docker ps`：API、API replica、六个 worker、商家 UI、Ops UI、Postgres、Redis、payment gateway、pilot gateway 和 ClamAV 均 running/healthy；Registry running 但无 health 标记。

容器 inspect 显示发布身份混杂：

- API 与 API replica：镜像 `merchant-api@sha256:8b893877…`，OCI revision `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5`；环境 release 四元组与公网 `/releasez` 的 `ecs-3dc76c93b536` 一致。
- generation worker：镜像 `merchant-worker@sha256:2aca1cf7…`，OCI revision 仍为 `fa6beb91…`，没有 release 四元组环境变量。
- 商家 UI 与 Ops UI：OCI revision `dc63e0b9e05bf4761cd3fde7b1fa28c329e151eb`。
- pilot gateway：OCI revision `3567df1e2894aaf45974464f2ecad50b187971ab`。

最新本地候选 `artifacts/deployment-candidates/ecs-20261004T214923Z/candidate-identity.txt` 绑定 `git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`，与线上 `3dc76c93…` 不一致；因此没有候选/线上 identity match。

## capability/capacity 挂载与权限

API 与 replica 将以下宿主文件只读挂载到容器：

- `capability.placeholder.json` → `/run/release-evidence/platform-capability.json`
- `capacity.placeholder.json` → `/run/release-evidence/capacity-report.json`

宿主文件均为 `root:root`、`0600`、3 bytes，SHA-256 均为 `ca3d163bab055381827226140568f3bef7eaac187cebd76878e0b63e9e442356`，字节为 `{}` 加换行。worker 没有对应 evidence 挂载。`/run/release-evidence/model-relay-evidence.json` 不存在。当前不能视为真实 capability/capacity evidence。

`/run/release-security/evidence-trust` 可读目录仅包含历史 attester/hash/public-key 文件；没有当前 `ecs-3dc76c93b536` 的 capability/capacity 签名 evidence bundle。

## 主机边界与安全状态

101 监听 TCP 80/443、SSH 和 loopback registry；根分区约 80% 使用率（75G/99G，20G 可用）。本次未读取环境 secret/token，不修改容器、镜像、证据、凭据、网络或业务数据。

结论：健康端点可用且容器保持运行，但候选与线上 release 不一致，运行镜像存在跨组件 revision 混杂，capability/capacity evidence 为不可读的 `{}` 占位文件，生产仍为 NO-GO。需要在受保护 101 环境以可信候选重新生成并签署 evidence、完成 release identity 绑定和三方审查后，才可进入部署门禁。
