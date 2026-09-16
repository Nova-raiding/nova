# 共享本地 API／worker 版本同步

状态：DONE_WITH_CONCERNS。2026-09-15 14:14:45 CST，当前本地版本同步运行验收通过；不代表生产发布或真实付费模型验收。主分支 `main`，本轮开始时相对 `origin/main` 未推送提交数为 0；工作区已有业务改动予以保留，本轮未提交／推送。

## 根因与处理范围

14:02 实际旧 worker 日志持续报错：`worker database schema mismatch: expected complete migration chain through 211, found 212 migrations through 212`。数据库完整链已经为 212，六个运行 worker 仍使用 211 镜像。旧 API 副本虽然健康，源码／镜像也落后；API 的最小版本检查不能代替全链与源码一致性检查。

按 investigate 先复现并核实根因；两位独立 agent 分别只读审查构建／配置路线与队列副作用，owner 复核后执行。没有放宽迁移、鉴权或扫描门禁，没有重跑迁移／seed，没有删除业务数据或数据卷。

只更新 `local` 项目的 `api`、`api-replica` 与 `worker-sync/generation/publish/reconcile/automation/scan`，使用 `up -d --no-deps --no-build --force-recreate`。保留原 API 资产卷 `local_merchant-assets`，DB／Redis／ClamAV／桌面 UI 容器不重建；StoryForge 的 11 个原容器均保持 exited。独立 QA 项目未操作。

先独立构建并验证 immutable image ID，再替换服务；未直接使用会初始化 scanner key 的启动 wrapper。运行容器的原环境值仅在内存中传给 Compose，逐值验证未变，未将密钥写入报告。副本增加当前 Compose 的两个默认键 `OPS_ALERT_NOTIFICATIONS_ENABLED`、`PAYMENT_PROVIDER_REFUND_QUERY_API_URL`；原有值不覆盖。API／worker 数据卷映射前后完全相同。

更新后，将 `local-api`／`local-worker` 本地标签指向通过验收的镜像，避免后续启动重新拿到 211；修改前先核实原标签未被并发替换。旧镜像仍保留，未 push registry。注意：DB 212 上的 worker 211 不是可用回滚版本，不得降级数据库掩盖不兼容。

## 镜像与源码证据

| 构件 | 当前镜像 ID | 源码清单摘要 |
|---|---|---|
| 两个 API | `sha256:f8248a12d9dce3477531a5196b72f74233947cc516cca3b1d04ee3ca6f7b9d8c` | `sha256:7c15d11b71eff9b1b517101adfcea4a6a64f7a98fe5e3f011a088d4482a54068`，520 文件 |
| 六个 worker | `sha256:86e79559dc63d656ff176959ca6bad1c4a38a3831932babe5a94e088f4399d41` | `sha256:61577fd227890cbb4f75aeb82b23f29eefc63c238b147c8140fafcb85f09a928`，473 文件 |

两个镜像完整构建成功；现有 `verify-container-source-freshness.sh` 用上述两个 immutable ID 验证通过，运行前后源码清单不变，SQL 212 摘要为 `f15f31e0c123521b5096d5c65f172a5b94aa6638f8db392dc90a489a8bf96e04`。当前运行容器又逐一读取清单核对，真实 DB 全部 version/name 与源码 212 条逐条匹配。

## 启动前安全检查

现有 worker 只覆盖原来的四个工作区；没有改成 `auto` 扫描所有历史租户。查询使用现有本地 DBA 连接的 `BEGIN READ ONLY` 跨范围汇总，明确不是用 RLS 隐藏数据得出零结果；运行服务仍保留原 merchant_app／merchant_ops 角色配置。

初筛发现 10 条图片事件未发布，但完整 `claimPending` 条件还包括 `last_error.retryable/unknown/terminal`；精确查询可领取生成、发布、同步、扫描事件为 **0**。没有修改这批错误记录。仅看 unpublished／attempts 不足以判断是否会被执行。

待结算模型台账、启用自动化策略、运营计划、新客点数计划、孤儿对象及待支付 provider 订单均为 0。对账 worker 没有模型 key，因此不创建图片 provider 查询器；API 图片对账仅按既有 job 的权威成功／失败记录整理 execution 状态，不重排生成。Redis 提示执行前须匹配有效数据库租约，旧终态／unknown／过期消息不进入生成 handler。本轮未制造真实模型或平台写入任务，也未将 `WORKER_ONCE` 当只读探针。

## 真实运行验证

按 verify-feature 在实际共享运行面验收，非只靠测试结果：

- 8 个更新服务全部 healthy，另外 DB／Redis／ClamAV／两桌面 UI 也 healthy。
- 14:14:42–14:14:45 收集启动以来 1,036 次成功 worker 轮询：sync 206、generation 206、publish 207、reconcile 203、automation 7、scan 207；错误数均 0，processed 均 0。不是付费 provider 调用成功证据。
- 两 API `/healthz`、`/readyz` 均 200，PostgreSQL 与 Redis 实际就绪；`/releasez` 仍准确返回 `ready:false`，生产门禁未被伪装成通过。
- 两 API 用原有本地 workspace 凭据实际调用原生 MCP `tools/list`，均返回 163 个工具，完整 schema 摘要相同：`b639677e88834ec917954f39c9241e644d2e371049ad05256f82d2f55ee4022b`。本次未重新进行密码／OAuth 登录，原完整隔离证据见账号专项报告。
- 反向探针：无认证 products／MCP 均 401；无 worker 签名调用内部 automation tick 均 403。没有执行自动化动作。
- scanner 新鲜心跳 ready，DB／API／Redis／ClamAV 正常，EICAR 检测通过；真实引擎 1.4.6、病毒库 28123。历史死信 1 条仍可见，未删除／重新投递。
- 真实共享桌面路由 `/ops/customer-delivery` 使用 shot-scraper 获取 1440×900 截图，owner 逐图查看确认显示正常的账号登录门禁；此截图不冒充已登录交付表单交互。
- 与版本更新风险对应的 4 文件 120/120 回归通过，8.48 秒：worker、scanner heartbeat、container source freshness／manifest。构建同时完成 API 全量 TypeScript 编译及 worker 依赖图编译；本轮不重算此前 616 项业务与 112 项桌面测试为新增证据。

证据目录：`artifacts/local-worker-sync/run-20260915-1410/`。

- `rollout.mjs`／`rollout-result.json`：精确旧／新容器、两次限定服务替换、原环境值保持与卷映射证明；脚本固定旧 ID，不能无审查重复运行。
- `verify.mjs`／`verification-result.json`：真实服务、14 个 API/MCP 探针、迁移、轮询与 StoryForge 状态。
- `desktop-login.png`：实际桌面截图。
- `regression.json`：120 个测试，0 失败／0 跳过。

## 仍保留的边界

- 共享服务版本不一致阻断已关闭；未修改新的业务逻辑，本轮主要是构建、部署本地服务与运行复核。
- API replica 原有模型／scanner 配置缺项被保留，未未经选择扩大配置；同镜像不等于配置等价，也不证明可用于生产负载均衡。
- 1 条历史扫描死信需要按现有审计恢复流程单独处理，不能通过删除记录把告警变绿。
- 实际五模态中转调用、外部支付／平台能力和完整生产发布门禁仍须独立证据；此次没有发布生产或提交／推送代码。
