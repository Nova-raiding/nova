# 单工作区扫描回调 canary

执行候选验收前，先运行 `npm run test:scanner-callback-canary` 检查脚本契约。

`/readyz` 对扫描器要求 24 小时内真实接受的签名回调。ClamAV 容器存活、EICAR 自检通过、或将 Redis 时间戳改新，都不能代替业务素材的签名闭环。扫描 worker 的 `recoveryCapable` 状态允许在 `/readyz` 因旧回调变红时处理一个新上传；不要放宽回调时效门禁。

只用一个事先存在、具有 `asset.upload` 权益的专用测试工作区。不创建批量账号，不压测，不在商家业务工作区试。先在受保护的部署配置中核对 `worker-scan` 的 `WORKER_WORKSPACES` 包含该工作区（或使用有界的自动发现），并核对该工作区的真实登录/令牌和上传权益。不要将令牌放进命令历史、证据文件或聊天。

脚本默认只读，仅验证所访问的候选 API 的 `release_id` 和完整 Git SHA：

```sh
export SCANNER_CANARY_API_BASE_URL=https://candidate.example/api
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
export SCANNER_CANARY_CONFIRM="${SCANNER_CANARY_RELEASE_ID}:${SCANNER_CANARY_WORKSPACE_ID}"
node scripts/scanner-callback-canary.mjs --execute
```

设置 `SCANNER_CANARY_RECOVERY_VERIFIED=true` 前，须从受保护 worker 运行态证据确认目标 worker 的 `recoveryCapable=true`、其 `WORKER_WORKSPACES` 覆盖 canary workspace，且 heartbeat 中数据库、API、Redis、ClamAV、定义新鲜度、EICAR 和 callback wiring 检查通过。`/readyz` 因旧 callback 返回 503 时可以继续，但执行脚本会先要求 `/healthz` 返回 persistence 与 Redis 均 ready；否则在上传前退出。脚本本身无法从聚合 `/readyz` 摘要证明 scanner recovery capability。

一次执行最多上传一个随机内容的合法 1×1 PNG，避免命中旧的 `trusted clean` 去重。脚本仅在以下观察同时成立时返回 `status=observed`、`evidenceType=unsigned_observation`、`proof=false`：上传初始为 `quarantined`，候选 `/readyz` 的 `latest_callback_accepted_at` 晚于本次上传，扫描器 ready 且队列无积压/死信，以及该素材经正常鉴权下载后的 SHA-256 与上传内容相同。聚合回调时间可能属于另一笔并发上传，因此这个结果不能单独计入签名生产发布门禁；还必须独立核对受保护发布证据、该素材对应的数据库 `asset_scan_attempts.callback_status=accepted` 与签名回执，以及容器健康。执行失败后保留素材 ID/名称与 SHA-256 核对原因，不能直接重试或把素材手工改为 clean。达到 24 小时后仍需由正式受控定时机制产生新的真实回调，旧证据自然过期是预期行为。

canary 返回 `observed` 后，可由发布 owner 单独运行下面的只读数据库证据采集器，验证指定 workspace/asset/SHA 对应的真实 outbox event、扫描 attempt、accepted callback、可信公钥签名和 clean asset snapshot。将 `SCANNER_CANARY_DATABASE_URL` 从受保护凭据渠道注入为 `merchant_app` 连接；数据库 URL 不得放入命令行或证据。`SCANNER_CANARY_TRUSTED_KEYRING_FILE` 必须由受保护配置渠道提供，并映射可信 `key_id` 到其 public PEM；keyring 文件须归当前用户或 root 所有且不可由 group/other 写入。命令中的 `--trusted-key-id` 只会选择该映射内的公钥，不能临时传入自选 PEM；绝不使用私钥。命令只读 `merchant` 数据库中的精确 workspace/asset/event 关联行，在 `BEGIN READ ONLY` 中核对 `merchant_app`、当前 workspace scope、相关表 RLS/forced RLS 与 workspace policy、非 superuser、非 `BYPASSRLS`；输出仅包含最小摘要，不输出原始回执、签名或凭据。结果明确标记 `releaseProof=false`，不单独构成 release proof。

```sh
node --import tsx scripts/scanner-callback-canary-evidence.ts \
  --workspace-id <专用测试工作区 ID> \
  --asset-id <canary 返回的素材 ID> \
  --sha256 <canary 返回的 SHA-256> \
  --trusted-key-id <受信任扫描器 key ID>
```

这个 collector 只验证持久化 DB 证据，不创建或修改记录，也不单独证明 workspace 专用性、`asset.upload` 权益、worker scope/recovery capability、容器健康或对象存储字节；这些仍须通过受保护的独立证据核对。它不能替代正式 release manifest/evidence bundle，也不能把 unsigned canary observation 转成完整生产发布证明。
