# Production runtime round-two read-only review

审查时间：2026-10-04 22:11–22:12 UTC（101 主机，SSH 只读）。

## Public probes

- `https://yxsona.com/api/healthz`：HTTP 200；Postgres、Redis、production controls、authorization coverage 和 payment provider 均报告 ready。
- `https://ops.yxsona.com/healthz`：HTTP 200，返回与 API 相同的运行时状态。
- 两个域名的 `/releasez` 一致返回 `release_id=ecs-3dc76c93b536`、`release_git_sha=3dc76c93b53652190f03454b305c86931e5f72ae`、`manifest_sha256=d15e8a9175d4fb478ab145a48e17a12d038fed47c2812c6a329f4b3f8b8cee89`、`image_set_digest=sha256:eb17537f8c2824611155508c1a0c817c66a19b973ea7a090a0b66c23cfdbcd62`。

## Host/container identity

`docker ps` 显示 API、API replica、六个 worker、商家 UI、运营 UI、Postgres、Redis、支付网关、pilot gateway 和 ClamAV 均为 healthy；Registry 运行但没有 health 标记。

运行身份不是单一候选集：API 环境声明 `RELEASE_GIT_SHA=3dc76c93b536…`，而其 OCI revision label 为 `fa6beb91…`；generation worker 的 release label 是 `release-fa6batch-import`；商家 UI 和运营 UI 的 release label 是 `ecs-dc63e0b9`。最新本地候选 `artifacts/deployment-candidates/ecs-20261004T214923Z/candidate-identity.txt` 绑定 `git_sha=59eb1e8db78005a2f9be1b8a808507422ffc82b8`，与线上 `/releasez` 不一致。

## Evidence and credentials

- API 将宿主 `capability.placeholder.json` 和 `capacity.placeholder.json` 以只读方式挂载到 `/run/release-evidence`；文件为 `root:root`、0600、3 bytes，root 读取内容均为 `{}`，merchant 进程无权读取。worker 没有对应挂载。
- API 容器不存在 `/run/release-evidence/model-relay-evidence.json`。
- `npm run codex:relay:validate --silent` 仍失败：`model_provider=openai` 与唯一的 `damai_relay` provider 不一致，且 host relay 的 `base_url`、`wire_api`、`env_key` 缺失。
- Keychain service `com.merchant.codex.model-relay` 的元数据存在，但无交互读取时 `security find-generic-password -s com.merchant.codex.model-relay -w` 返回 exit 36；未形成目标 workspace 的可信凭据证据。

本次仅执行只读命令，未修改主机、容器、镜像、凭据或生产数据。结论：健康探针可用，但候选与线上身份、真实 capability/capacity evidence、relay host 配置和本地可信 Keychain 凭据仍为阻断项。
