# 101 维护窗口 traffic fence / worker drain 只读预检

本预检不安装、重载或停止生产网关，也不停止 worker。`node infra/scripts/review-ecs-traffic-fence.mjs <受保护证据 JSON>` 只列出不满足的条件，始终返回非零状态，且 `deployment_allowed` 始终为 `false`。隔离测试的 `verify` 桩只检验契约行为，不能作为生产签名证据。

## 2026-09-27 观察到的拓扑和阻断

- 公网 `80/443` 由 demo 项目 `merchant-demo-85575f9c` 的 `pilot-gateway` 容器占用；正式 API 与六 worker 是另一个、未标 Compose 标签的旧运行集。该网关与正式 API 没有共同 Docker 网络。
- 现有 `ecs-external-gateway-handoff.mjs` 会停止网关。直接调用会使公网 `80/443` 断流，不能用作本维护窗口的 traffic fence。
- 101 没有已安装的受保护 `traffic-fence` / `drain-workers` 入口。现有 gateway 快照绑定的是退役容器 ID，不能用于当前网关恢复。
- 数据库只读观察见 65 条未发布 outbox 事件、1 条 unknown outcome、0 个活动 outbox lease；这些并不等同于 65 个当前执行中的任务，但尚无完成排空与未知结果处置证明。
- 当前网关配置把 `/v1/`、`/api/` 和 `/payment-gateway/` 转发到不同上游；支付与 provider 回调的精确路由、维护期保留策略及验证证据尚未冻结。账务中还有 18 个 pending 订单。
- 242→254 的当前网关恢复签名 capsule、当前拓扑绑定的可回滚配置、经验证的 reload/rollback、两次独立 drain 观察均缺失。因此预检必须拒绝放行。

## 可审查的最小执行顺序

1. 在受保护主机锁下，只读冻结当前完整网关 ID、镜像 ID、配置哈希、监听端口、网络与旧 API/六 worker 身份；用真实信任根签名恢复 capsule。
2. 审核并签名精确回调路由清单。制作保持 `80/443` 监听、只拒绝新业务请求的候选 nginx 配置；在隔离副本中验证 `nginx -t`、reload 和按原配置回滚。当前网关不能直接停止。
3. 由受保护入口应用 fence，并从网关外部验证新请求被拒绝、已批准回调仍可用。该入口必须核对当前容器 ID、配置 SHA 和锁，原子记录恢复点；失败立即恢复原配置并验证。
4. 停止新的作业领取后，只读观察 worker cycle、HTTP 在途请求、outbox lease、provider started/unknown outcome 与未发布 outbox。至少两次间隔 30 秒、均绑定 fence 配置和网关 ID 且全部为零；未发布事件与 unknown outcome 需完成业务处置后才能宣称排空。
5. 仅在上述证据由独立受保护信任入口验证、旧运行集及数据库 242 恢复 capsule 生效后，交由主发布编排继续。此只读工具本身永远不授权部署。

生产入口仍需实现与审计。缺少回调策略、真实签名或完整 drain 证据时，保持现有公网运行状态并停止维护窗口推进。
