# 单工作区扫描回调 canary

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
export SCANNER_CANARY_ENTITLEMENT_VERIFIED=true
export SCANNER_CANARY_CONFIRM="${SCANNER_CANARY_RELEASE_ID}:${SCANNER_CANARY_WORKSPACE_ID}"
node scripts/scanner-callback-canary.mjs --execute
```

一次执行最多上传一个随机内容的合法 1×1 PNG，避免命中旧的 `trusted clean` 去重。成功条件同时包括：上传初始为 `quarantined`，候选 `/readyz` 的 `latest_callback_accepted_at` 晚于本次上传，扫描器 ready 且队列无积压/死信，以及该素材经正常鉴权下载后的 SHA-256 与上传内容相同。脚本输出是未签名的运行观察，不代替受保护发布证据、数据库中 `asset_scan_attempts.callback_status=accepted` 与签名回执、或容器健康验收。执行失败后保留素材 ID/名称与 SHA-256 核对原因，不能直接重试或把素材手工改为 clean。达到 24 小时后仍需由正式受控定时机制产生新的真实回调，旧证据自然过期是预期行为。
