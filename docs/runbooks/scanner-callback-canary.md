# 单工作区扫描回调 canary

执行候选验收前，先运行 `npm run test:scanner-callback-canary` 检查脚本契约。

`/readyz` 对扫描器要求 24 小时内真实接受的签名回调。ClamAV 容器存活、EICAR 自检通过、或将 Redis 时间戳改新，都不能代替业务素材的签名闭环。扫描 worker 的 `recoveryCapable` 状态允许在 `/readyz` 因旧回调变红时处理一个新上传；不要放宽回调时效门禁。

只用一个事先存在、具有 `asset.upload` 权益的专用测试工作区。不创建批量账号，不压测，不在商家业务工作区试。先在受保护的部署配置中核对 `worker-scan` 的 `WORKER_WORKSPACES` 包含该工作区（或使用有界的自动发现），并核对该工作区的真实登录/令牌和上传权益。不要将令牌放进命令历史、证据文件或聊天。

脚本默认只读，仅验证所访问的候选 API 的 `release_id` 和完整 Git SHA：

```sh
export SCANNER_CANARY_API_BASE_URL=https://candidate.example/api
export SCANNER_CANARY_EXPECTED_API_ORIGIN=https://candidate.example
export SCANNER_CANARY_RELEASE_ID=<候选发布 ID>
export SCANNER_CANARY_RELEASE_GIT_SHA=<40 位候选 Git SHA>
export SCANNER_CANARY_WORKSPACE_ID=<现有专用测试工作区>
node scripts/scanner-callback-canary.mjs
```

完成独立的工作区、worker 范围、权益、候选发布身份核对后，再由发布 owner 在批准的候选路由执行一次。下面的显式确认会在发出任何写请求前检查。脚本不会自动重试上传，不会修改数据库/Redis，也不会签发扫描回执：

```sh
export SCANNER_CANARY_API_TOKEN=<从受保护凭据渠道注入>
export SCANNER_CANARY_WORKER_SCOPE_VERIFIED=true
export SCANNER_CANARY_RECOVERY_VERIFIED=true
export SCANNER_CANARY_ENTITLEMENT_VERIFIED=true
export SCANNER_CANARY_CONFIRM="${SCANNER_CANARY_RELEASE_ID}:${SCANNER_CANARY_WORKSPACE_ID}:${SCANNER_CANARY_EXPECTED_API_ORIGIN}"
node scripts/scanner-callback-canary.mjs --execute
```

执行模式要求 `SCANNER_CANARY_EXPECTED_API_ORIGIN` 是单独核对的规范 HTTPS origin（不含路径、查询或凭据），且与 API base URL 的 origin 一致；显式确认值也必须绑定该 origin。这样在发出任何带 Bearer 的请求前，错误目标会被拒绝。旧版 Docker 入口固定为容器内回环 origin `http://127.0.0.1:8787`，由其精确容器身份检查提供边界。

设置 `SCANNER_CANARY_RECOVERY_VERIFIED=true` 前，须从受保护 worker 运行态证据确认目标 worker 的 `recoveryCapable=true`、其 `WORKER_WORKSPACES` 覆盖 canary workspace，且 heartbeat 中数据库、API、Redis、ClamAV、定义新鲜度、EICAR 和 callback wiring 检查通过。`/readyz` 因旧 callback 返回 503 时可以继续，但执行脚本会先要求 `/healthz` 返回 persistence 与 Redis 均 ready；否则在上传前退出。脚本本身无法从聚合 `/readyz` 摘要证明 scanner recovery capability。

一次执行最多上传一个随机内容的合法 1×1 PNG，避免命中旧的 `trusted clean` 去重。脚本仅在以下观察同时成立时返回 `status=observed`、`evidenceType=unsigned_observation`、`proof=false`：上传初始为 `quarantined`，候选 `/readyz` 的 `latest_callback_accepted_at` 晚于本次上传，扫描器 ready 且队列无积压/死信，以及该素材经正常鉴权下载后的 SHA-256 与上传内容相同。聚合回调时间可能属于另一笔并发上传，因此这个结果不能单独计入签名生产发布门禁；还必须独立核对受保护发布证据、该素材对应的数据库 `asset_scan_attempts.callback_status=accepted` 与签名回执，以及容器健康。任何上传后异常会保留随机上传名称、SHA-256 和已知素材 ID（若有），同时不自动重试；先按这些值对账后再决定是否执行新一轮。不要把素材手工改为 clean。达到 24 小时后仍需由正式受控定时机制产生新的真实回调，旧证据自然过期是预期行为。

canary 返回 `observed` 后，可由发布 owner 单独运行下面的只读数据库证据采集器，验证指定 workspace/asset/SHA 对应的真实 outbox event、扫描 attempt、accepted callback、可信公钥签名和 clean asset snapshot。将 `SCANNER_CANARY_DATABASE_URL` 从受保护凭据渠道注入为 `merchant_app` 连接；数据库 URL 不得放入命令行或证据。`SCANNER_CANARY_TRUSTED_KEYRING_FILE` 必须由受保护配置渠道提供，并映射可信 `key_id` 到其 public PEM；keyring 文件须归当前用户或 root 所有且不可由 group/other 写入。命令中的 `--trusted-key-id` 只会选择该映射内的公钥，不能临时传入自选 PEM；绝不使用私钥。命令只读 `merchant` 数据库中的精确 workspace/asset/event 关联行，在 `BEGIN READ ONLY` 中核对 `merchant_app`、当前 workspace scope、相关表 RLS/forced RLS 与 workspace policy、非 superuser、非 `BYPASSRLS`；输出仅包含最小摘要，不输出原始回执、签名或凭据。结果明确标记 `releaseProof=false`，不单独构成 release proof。

```sh
node --import tsx scripts/scanner-callback-canary-evidence.ts \
  --workspace-id <专用测试工作区 ID> \
  --asset-id <canary 返回的素材 ID> \
  --sha256 <canary 返回的 SHA-256> \
  --trusted-key-id <受信任扫描器 key ID>
```

这个 collector 只验证持久化 DB 证据，不创建或修改记录，也不单独证明 workspace 专用性、`asset.upload` 权益、worker scope/recovery capability、容器健康或对象存储字节；这些仍须通过受保护的独立证据核对。它不能替代正式 release manifest/evidence bundle，也不能把 unsigned canary observation 转成完整生产发布证明。

## 101 旧版正式扫描器恢复（仅 `qa-merchant-ec3d69e3`）

旧版正式 API 的 `/readyz` 把所有扫描实例未就绪都写成 `SCANNER_NOT_READY`，没有 `recovery_ready` 字段。正常候选 canary 不接受这个通用错误。Bridge B 又要求旧版正式 `/readyz` 先恢复为 200，因此只能使用独立的 `scripts/scanner-old-formal-docker-canary.mjs` 路径。这个入口固定旧 release ID 和完整 Git SHA，通过 `docker exec` 连接完整 ID 指定的正式 API 容器；不会访问公开 DNS、demo gateway、容器 IP 或宿主端口。

在 101 的受保护、经过复核的源码目录执行。先从旧运行态证据核对并注入完整 API/scan worker Docker ID 和各自的不可变镜像 ID（`sha256:...`）；脚本会逐请求核对容器名称、镜像标签、镜像 ID、运行状态及 `merchant-production_default` 网络 ID。先独立核对专用工作区的真实 `asset.upload` 权益和令牌，以及 scan worker 的显式 `WORKER_WORKSPACES` 范围。自动发现范围不受此一次性入口支持。不要在命令行写令牌或数据库 URL。

此路径仍需设置上述 `SCANNER_CANARY_WORKSPACE_ID`、`SCANNER_CANARY_API_TOKEN`、`SCANNER_CANARY_WORKER_SCOPE_VERIFIED`、`SCANNER_CANARY_RECOVERY_VERIFIED`、`SCANNER_CANARY_ENTITLEMENT_VERIFIED`、`SCANNER_CANARY_EXPECTED_API_ORIGIN=http://127.0.0.1:8787`、`SCANNER_CANARY_CONFIRM=qa-merchant-ec3d69e3:<专用工作区>:http://127.0.0.1:8787`，并从受保护渠道注入 `SCANNER_CANARY_DATABASE_URL`、`SCANNER_CANARY_TRUSTED_KEYRING_FILE` 和 `SCANNER_CANARY_TRUSTED_KEY_ID`。执行前用默认只读模式核对旧 release 身份，再运行一次 `--execute`。入口仅在旧版 `/readyz` 显示单实例、无积压/死信、无已接受回调，且精确 worker 容器的标记在 15 秒内、`recoveryCapable=true`、依赖/ClamAV/EICAR/回调配置有效、显式范围包含专用工作区时允许上传。上传前再次执行全部身份及恢复检查。

```sh
node scripts/scanner-old-formal-docker-canary.mjs
node scripts/scanner-old-formal-docker-canary.mjs --execute
```

脚本最多发送一次上传，不自动重试。随后它读取同一素材的 clean 下载，并调用只读数据库 collector 核对 outbox 事件、scan attempt、accepted callback 和可信签名与素材 SHA 的绑定。结果仍标记 `proof=false`、`releaseProof=false`，不能代替完整生产发布证据。失败若含 `asset`/`sha256` 或上传名称，先据此对账再考虑下一次操作。这个旧版恢复入口不用于新候选，也不解除 Bridge B 其他门禁。

此 Docker transport 使用同步子进程，不能直接响应上层 HTTP `AbortSignal`；它对每次 GET 的完整容器核对和请求共用 10 秒硬截止时间，POST 的容器核对、恢复标记复核和一次上传共用 30 秒硬截止时间。超时后的上传结果属于未知结果，须先按上传名称与 SHA 对账。
