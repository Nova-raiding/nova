# 242→254 独立桥接版本实施计划

状态：**设计输入，未实现，生产 NO-GO**。此计划服务于 `merchant-production` 旧数据库 242 到候选 C 数据库 254 的前向迁移。桥接版本必须先作为独立、可回退的发布运行并通过公网身份与业务验收；不能把现有 Bridge B 的 242/244 模式或当前 C 的 254 源码直接标为兼容桥。

## 1. 冻结源码与最小补丁

- 桥接业务代码的审阅基线固定为 `bridge/compat-242-244` 的提交 `4491ad2ee625156ca82615e475ad643a0e4e1c5a`。只用 `git show`/差异审计提取所需补丁，在唯一主目录的 `main` 集成；不切换分支或整头合并。当前 254 迁移输入的审阅起点是 `main` 提交 `d0552b975e69f4ba713ec1c003078f521b69f51a`。任何后续修改都须重新冻结完整提交、源码归档 SHA、逐文件 SQL SHA 和审查差异。
- B 基线已经包含 243/244；从 254 输入只增加 `245`–`254` 的原始 SQL、`migration.ts` 的十条读取/登记和 `release-metadata.json.expectedMigrationVersion=254`。保留 1–244 已发布名称与校验和；不得重写历史迁移、回填生产 `schema_migrations` 或让桥接容器启动时自动迁移。
- 单独实现桥接模式与受保护切流/恢复执行器。旧 `prefix_242_or_244`、Bridge B nonce、镜像和签名证据保持原合同；新版本需要新的 release ID、Git SHA、归档、经部署合同明确的完整镜像摘要、Compose、nonce 和签名证据。沿用 cloud-only 候选归档约束，排除桌面插件源码；macOS/Windows 本地插件包及签名描述仍单独验收。

首个本地审查产物由以下命令生成，输出目录必须尚不存在：

```sh
node infra/scripts/prepare-ecs-bridge-254-review.mjs \
  --migration-commit d0552b975e69f4ba713ec1c003078f521b69f51a \
  --output /绝对路径/bridge-254-review
```

工具直接读取固定 B Git 对象和指定 254 Git 对象，验证 1–244 SQL 名称与 Git blob 完全一致、245–254 连续，并以严格白名单只允许十个 SQL、`migration.ts` 的读取/登记和 metadata 迁移尾号发生变化。产物含 `bridge-base.tar`、`review-source/`、摘要和差异清单；manifest 固定 `status=review_only`、`deployable=false`。这是源码审查包，仍含 B 的本地插件源码；不能作为 cloud-only 候选、镜像构建输入、签名发布证据或生产部署输入。下游须在 `main` 上单独完成兼容补丁、cloud-only 裁剪、运行验收和正式候选身份冻结。

对该包运行静态兼容审计：

```sh
node infra/scripts/audit-ecs-bridge-254-review.mjs --review /绝对路径/bridge-254-review
```

审计先核对 B 源码归档、完整审查树和新增 SQL 的摘要，再返回 `status=blocked`、`deployable=false`、`runtime_verified=false`。当前确定阻断：B 的 `verifyBridgeMigrationPrefix` 固定要求 244 条迁移且只接受 242/244，因而携带 254 迁移的审查包在 242 和 254 均无法按旧模式就绪；247/248 发布 `integer_points=NULL` 的 OCR `variable` 费率，而 B 的 `listRates` 未校验该新枚举，`resolveApprovedRate` 只选 `fixed`。审计结果只是源代码风险定位，不能作为数据库或容器验收通过记录。

第二步产生**单独**的兼容覆盖层，输入保留原样：

```sh
node infra/scripts/overlay-ecs-bridge-254-review.mjs \
  --review /绝对路径/bridge-254-review \
  --output /绝对路径/bridge-254-overlay
```

覆盖层先验证原审查包和两项已知阻断，只允许改动 `migration.ts` 和 `commercial-catalog-repository.ts`，记录输出树摘要与逐文件摘要。它采用新的 `prefix_242_or_254` 模式，要求完整 1–254 迁移清单，只接受具有可核验历史的数据库 242 或 254；243–253 全部拒绝就绪。OCR 报价在数据库访问和扣点之前拒绝，避免 247/248 后误用旧固定费率；运营费率列表可显示新 `variable` 类型，但标为不可执行并给出阻断原因。当前 B 的素材 OCR provider 路径本就阻断，覆盖层没有声称实现新的可变计费。覆盖层的 manifest 仍为 `status=review_only`、`deployable=false`、`runtime_verified=false`；输出不能用于构建部署镜像或切流。该保护会在 242 也阻断 OCR，业务验收必须显式评估这一影响。

B 的 API/worker 源码通过 `BRIDGE_SCHEMA_COMPATIBILITY_MODE` 环境变量透传模式到共享校验器，本身未固定模式值；但旧 `infra/scripts/deploy-preflight-ecs.sh` 只放行 `prefix_242_or_244`，`infra/scripts/verify-bridge-b-package.mjs` 要求八个服务的已渲染 Compose 环境均为该旧值。旧 `infra/local/docker-compose.ecs-pilot-release.yml` 只是强制变量存在。因而该覆盖层**不能**沿用旧 B 的预检、包校验或发布证据；必须单独编写并审查 242→254 Compose/预检/包校验合同及测试，严格保留旧 B 合同不变。新的模式还必须在 API 与六 worker 的实际容器环境中逐一核对。

## 2. 数据库与运行时兼容审计

- 在签名的生产 242 备份所恢复的隔离 PG17 中，逐版运行 243–254，并记录每一个完整前缀的名称/SQL SHA/数据库历史 SHA。审查 245 的授权时间约束、247/248 的 OCR 可变费率和历史预留、249 的重复 `workspace_id/action_key` 拒绝、250–253 的新 claim/attempt 表及函数、254 的 entitlement v3 函数。B 基线只认识 `fixed`、`starts_at`、`unresolved` 费率且调用 entitlement v2；要证明其在 254 上读取新增费率时按审定策略处理，旧 entitlement v2 仍可用，不能靠 TypeScript 类型断言。
- 列出桥接 API、六个 worker 在每个可能暴露的数据库前缀上执行的 SQL 和外部请求。迁移期间若继续承载流量，桥接运行时及回退目标必须在 **242–254 每一个可能停留的前缀**保持业务安全；只接受 242 和 254 的就绪校验不足以覆盖中途失败。若采用维护窗口阻断中间流量，先实现并验证明确的流量冻结、作业排空和失败后前向完成/恢复流程，不得把健康检查 503 当作可恢复切流。
- API/worker 在桥接模式下明确关闭启动迁移；对尚未存在的表、函数和新收费/模型路径做前缀保护，并保证保护发生在扣点、入队、调用中转或写业务状态之前。不能通过把核心生成、商家鉴权或商业权限长期返回 503 来宣称桥接业务验收通过。

隔离 PG17 验证的最小实现：在 B 派生源码上增加**独立于**旧 `prefix_242_or_244` 的 242→254 桥接模式，使 1–254 清单可在 242/254 和审定的中间前缀严格核对名称与 SQL 校验和；增加 OCR v3/v4 可变费率读取、选择与扣点/回补契约（包括 0.30 CNY 免费阈值），并给旧 OCR 路径明确的前缀保护。用固定 `postgres:17-alpine` 镜像和当前 `tests/isolated-ops-fixture.ts` 的私有容器、生成凭证及空白库，先在 242 跑 B 派生 API 和六 worker，再在同一库执行 243–254 后重跑同一镜像。可复用 `tests/bridge-image-smoke.mjs` 的容器拓扑，但该脚本目前硬编码 244 清单及旧模式，且只验证健康和容器存活，须新建独立的 254 运行测试，不可改名复用旧通过结果。以 `packages/persistence/src/migration-247-ocr-rate.postgres.test.ts` 的费率/结算断言为起点，增加 B 派生 repository 的真实 SQL、`merchant_app` 工作区 RLS 下的 entitlement v2 查询、API 收费 OCR 请求和六 worker 任务行为；每项证据绑定同一不可变 API/worker 镜像摘要、B 派生源码 SHA、数据库 242/254 历史及实际中转回执。254 SQL 只新增 entitlement v3、文本上保留 v2，真实角色权限和业务查询仍待 PG17 验证。

## 3. 隔离验证与发布身份

- 用桥接版本自己的不可变镜像，在独立 Compose 项目和隔离 PG17 242 恢复库上运行真实 API、六 worker、scanner callback、租户/RLS、桌面插件 MCP、商家与运营、收费生成、支付和恢复 canary；再按受控迁移链到 254，在同一桥接镜像上重跑。覆盖 247/248 OCR 计价、250–253 并发/未知结果恢复及 254 entitlement 查询；验证中间前缀或维护窗口的失败恢复路径。测试必须绑定该桥的 Git SHA、源码/镜像/Compose 摘要和数据库历史，旧 B 的隔离结果不得复用。
- 先修复并核对 101 旧正式 API 不健康、七个无 Compose 归属容器、外部 80/443 网关与公网演示路由分离的问题；恢复或审核真实旧运行 spec、受保护 env、不可变旧镜像、网关路由和回退 capsule。公网 `/releasez` 必须与签名旧目标一致，旧 `/readyz`、真实业务和原容器 ID 回退须经演练。只有候选桥在隔离环境通过后，才审查单独的旧运行时接管与流量切换。

## 4. 生产回滚合同与切流门禁

- 桥接切流使用新受保护执行器及同一把生产锁；签名 journal 记录旧容器完整 ID/镜像/网络/网关、旧公网四元组、数据库 242 历史、桥接身份和 nonce。失败恢复必须在实际数据库前缀上执行并校验公网业务，不能复用 Bridge B 仅在 242 可恢复的 journal。
- 候选 C 的 24 小时 forward-only rollback capsule 绑定当前 C 身份、目标桥身份、受保护 Compose/env/镜像摘要、`target_migration_tail=254`、真实 `live_migration_version` 以及从实时版本至 254 每一前缀的 `allowed_prefix_sha256`。目标桥镜像必须带完整 1–254 迁移清单，并在实际停留的数据库版本上通过只读链校验、API/worker、业务和回滚后公网身份；数据库、卷和对象数据均不倒退。
- 生产顺序：冻结并签署桥接证据 → 受保护旧拓扑接管/桥接切流 → 核对公网桥接 `/releasez`、`/readyz`、真实业务和桌面宿主 → 重新冻结 C 的证据及 rollback capsule → C preflight、前向迁移、候选切流 → 公网 C 身份及完整业务验收。任一身份、前缀、证据、旧拓扑或回退演练不符即停在该阶段，保持 **NO-GO**。
