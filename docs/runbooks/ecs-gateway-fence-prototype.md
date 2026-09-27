# 公网 gateway ingress fence 隔离原型

`infra/protected/ecs-gateway-fence-prototype.mjs` 只导出控制核心和配置渲染函数，没有生产 CLI、SSH 或 Docker 调用。调用方必须提供受保护的签名验证器与宿主操作端口；测试端口只在内存中模拟 nginx 写入、校验、reload 和回滚。原型即使通过，也始终返回 `deployment_allowed: false`。

## 101 配置事实

当前公网 gateway 的运行配置位于容器内 `/etc/nginx/conf.d/default.conf`，不是宿主配置 bind mount；唯一观察到的 bind mount 是只读证书目录。现有 nginx 配置的 `/v1/`、`/api/` 和 `/payment-gateway/` 路由各有上游。原型在 HTTP 层添加精确 `POST` 回调路径的 `map`，仅在公网 HTTPS server 中对其他新请求返回 503；它不改 `listen 8080/8443`，不停止容器。必须以实际运行配置 SHA、容器 ID、镜像 ID、Compose 标签、网络 ID 和主机 80/443 映射绑定签名 capsule。

代码可从受保护回滚 capsule 与已签名的精确回调清单生成候选配置，并要求先持久保存原配置。注入的宿主端口随后写入候选、验证读回 SHA、执行 `nginx -t`、reload，并从外部确认 80/443 仍在监听、新业务请求被拒绝、每条批准回调进入 API。任何一步失败时尝试写回原配置、校验、reload 和基线探测；回滚无法确认则抛出复合错误，不能宣称可继续发布。排空证据要求两次相隔至少 30 秒且签名、绑定同一 gateway/fence SHA 的零值快照。

## 安装生产控制器前的代码级缺口

1. 尚无 root-owned、持有生产锁的端口实现和崩溃恢复 watchdog。当前 try/catch 只能处理进程存活时的失败；`docker cp` 写入容器配置后若控制器崩溃，必须由持久 journal 和独立恢复进程识别并恢复。
2. 尚无针对当前 101 网关配置、精确回调路径和签名信任根的受保护 capsule。代码中的 `verify` 必须按文档种类、签名者范围、时效及容器/配置 SHA 验证，不能接受自报的 `signed: true`。
3. 回调路径清单要从真实支付配置与 API 契约冻结。已发现的契约包含 `/v1/billing/callback/{channel}`、`/v1/subscriptions/callback/{channel}` 和 `/v1/commercial/callback/{channel}`，但 `{channel}` 的当前生产值及 `/payment-gateway/` 的 provider 入口尚未由受保护配置证实，不能以通配符放行。
4. 真实 `nginx -t`、reload、回调代理探测和 80/443 连续性需要在隔离的同镜像容器先验证，再进行受控维护审查。当前隔离测试只验证状态转换和失败回滚，不构成生产流量安全证据。
5. 65 条未发布 outbox 和 1 个 unknown outcome 尚未完成处置；双快照零值条件当前不会通过。

因此目前不能把原型接到 101 执行，也不能用旧 `ecs-external-gateway-handoff.mjs stop` 代替它。
