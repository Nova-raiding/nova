# Store Nova 上线续验记录 · 2026-09-15

时间：2026-09-15 11:05 +08:00
范围：ChatGPT 插件入口、支付对账 worker、PostgreSQL/RLS、确定性发布门禁、桌面运营后台和共享本地运行状态。

## 判定

**NO-GO。** 本轮修复已经通过本地真实运行与隔离数据库复验，但真实 ChatGPT 插件身份链、生产支付、知识库生产检索、五模态中转成本证据和最终生产部署/canary 仍不完整。

## 本轮已通过

- 当前源码指纹下，真实 API HTTP → 签名 reconcile worker → PostgreSQL application role → Redis 工作区租约的隔离验收通过。覆盖未签名、错误角色、跨租户拒绝、支付只入账一次、退款成功/失败/未知、并发互斥、租约替换后 fail-closed 和持久审计。外部支付边界为本轮独立 localhost 状态 stub，真实支付和真实退款调用均为 0。证据：`artifacts/payment-reconciliation/run-DhXjCp/run-result.json`。
- 支付对账与迁移定向回归在最终复核时为 2 文件、46 项通过；此前发布配置相关定向回归为 9 文件、229 项通过。全项目 `npm run typecheck` 退出 0，`git diff --check` 退出 0。
- `npm run test:release-gates` 退出 0：128 文件、597 项通过。该默认入口中 7 个 PostgreSQL 文件共 14 项按设计跳过，不能作为数据库验收证据。
- 新建隔离 PostgreSQL 17 后，`npm run test:postgres:isolated` 共 20 文件、21 项全部通过，包含迁移 210 的 MCP OAuth 主体绑定、RLS/ACL 最小权限和跨成员商业支付隔离。证据：`artifacts/isolated-postgres/run-Yr6axi/`。
- 当前源码执行桌面 Chrome 1440×900 验收：签名登录名展示、工作台跨租户拒绝、平台只读客服查看客户交付共 4 项通过，无跳过或重试，并生成 shot-scraper PNG 和 WebM。证据：`artifacts/ops-jit-isolation/2026-09-15T03-02-20.977Z-6fdfe3fd-650b-4cf9-a7ba-04c9e81ededd/`。
- 以上隔离验收自建的 PostgreSQL/Redis 容器均已按精确运行标识清理，`leftRunning=[]`；没有触碰共享容器、业务数据、真实支付或真实模型。

## 当前阻断

1. 真实 ChatGPT Store Nova 连接读取引导状态和历史任务都返回权限拒绝，无法恢复商家任务；写操作保持关闭。
2. 共享本地 API、replica、六类 worker、PostgreSQL、Redis、ClamAV 和两个 UI 均为 healthy，但共享数据库迁移尾为 209，当前工作区迁移尾为 210。这只证明旧部署健康，不证明本轮源码已部署。
3. 支付对账 worker 本地链路已修复，但支付宝真实小额支付、签名 callback、查单、退款和对账回执仍缺，不能把 localhost provider stub 当作生产 canary。
4. 知识库生产 PostgreSQL/embedding/index worker/跨副本检索与插件实际消费证据仍缺。
5. 五模态真实中转鉴权、请求、用量、成本和错误证据未在本轮补齐。
6. 当前没有目标生产配置文件，未执行最终 `infra:launch-preflight`、部署后一致性检查和生产 canary。

## GO 前的唯一顺序

先恢复 ChatGPT 宿主身份与工作区授权，使只读引导和任务历史可访问；随后部署迁移 210 与当前 API/worker 镜像并复核运行版本；再使用批准的测试商家完成支付宝小额闭环、知识库跨副本检索、五模态中转成本和商家发布 canary；最后带目标生产配置运行 launch preflight。任何一步未通过都保持 NO-GO。
