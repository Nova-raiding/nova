# 套餐目录与权益包持久化实施证据

日期：2026-10-05。范围：主工作区 main，目录仓储及迁移 260；无提交、无部署。

## 实现

- `packages/persistence/src/commercial-catalog-repository.ts`：不可变内容与审批版本、提交/驳回/审批/上下架/归档/删除草稿、独立当前售卖投影、乐观 revision、持久化幂等回放、规范内容 checksum、审批来源审计、批准权益包版本展开及引用快照。编辑不会替换在售版本，下架不会回退历史批准版本。
- `packages/persistence/src/migrations/260_commercial_catalog_sales_and_bundles.sql`：售卖投影、权益包身份/版本/引用、不可变事实与幂等记录。历史数据只在唯一批准可执行版本时保守建立销售指针，不推断最新版本、不补造政策批准。
- `merchant_resolve_sale_sku_v3(text, boolean, text[])`：受控 SECURITY DEFINER 读取；要求 workspace 上下文，并在调用方事务内持有销售行 SHARE 锁至建单提交。商家数据库角色不能直接读取商业目录表，传入伪造私有能力仍不能变为 Ops。
- `commercial-benefit-definitions.ts`：真实消费者定义及单位；权限权益复用 contracts 唯一注册表，存储使用规范字节值，权限数量只允许 0/1。
- `commercial-benefit-bundle-repository.ts`：权益包版本/审批/停用/归档/删除、配置校验、引用查询、批准版本不可变，杜绝嵌套包与重复权益代码。
- 发布事务写入通知 owner 的 `commercial_catalog_publish_outbox`，事件 UUID 与本次批准发布审计关联。目录事实、售卖指针、审计、outbox 和幂等结果同事务提交。

## 消费门禁

发布需要真实固定正价格、显式空 blockers、已批准订单有效窗口及注册权益消费者。开通赠点冻结已批准版本内注册政策 `commercial.onboarding/v2`，payload 与 schedule 的 policyRef 一致，UTC 月周年调度、支付核验起算，批次数 1–24、每批正安全整数。初始历史 6×500 未改；另行批准的 6×600 可发布。描述权益若存在必须与调度一致。点包只接受真实创意点消费者与购后 30 自然日到期。非月度套餐、新型独立权益消费者、未批准政策保持阻断。

权益包是版本化组合；独立售卖仍通过绑定该批准权益包版本的目录 point_pack SKU，价格与销售状态归该 SKU。批准权益包不等于上架售卖；API/UI owner 须完成真实关联商品流程。当前没有冒称资源/权限独立包已有消费器。

## 验证

1. `npx vitest run packages/persistence/src/commercial-catalog-repository.test.ts`：18 个单元测试通过，覆盖生命周期、编辑保留旧在售版本、幂等/冲突、历史歧义/下架、驳回、身份、消费政策门禁及批准 500/600 新赠点版本。
2. `npx tsc -p packages/persistence/tsconfig.json --noEmit`：最终赠点门禁更新后通过。曾遇交易 owner 在改文件的可选字符串类型问题，owner 修复后再次检查 exit 0。
3. `npm run test:postgres:isolated -- packages/persistence/src/commercial-catalog-v3.release.postgres.test.ts`：最终运行通过，1 个真实 PostgreSQL 集成测试，4.36 秒。证据：`artifacts/isolated-postgres/run-IugcKU/vitest.json` 与 `run-result.json`，runId `e9e52db5-9583-4551-9537-c4dc421da857`。

PG 验证涵盖不可变权益包引用、销售编辑保留、原子发布及幂等唯一 outbox、下架禁止历史回退、重新发布明确批准版本、销售读取同事务行锁、revision/身份冲突无部分写入、事实不可修改、商家角色表读取拒绝与受控函数执行。使用新建隔离 fixture，`inheritedBusinessEnvironment=false`、`sharedContainersTouched=false`、退出遗留运行容器数为 0。该运行发生在最后 onboarding 纯校验调整前；新增赠点门禁由上述 18 单测和最终类型检查验证，月套餐 PG 路径未变。

前次隔离启动有一次容器启动失败（`run-lULHlx`，尚未运行 Vitest）；其后完整重试上述最终运行通过。最早发现主机与数据库时间差，已修复为数据库 `clock_timestamp()` 发布生效时间。

## 集成边界

### C6 销售迁移与兼容回滚

新增 API 专属 `commercial-runtime-policy.ts` 及 8 单测，全部通过；操作与信任边界见 `docs/runbooks/commercial-sales-compatibility-rollback.md`。默认 compatibility 禁新写，sale 要求可信部署证据 verifier、人工审计 hash、candidate/schema hash、真实活跃实例 sales.v3 一致证明。loader 使用受控绝对 JSON 文件、部署 hash pin、15 分钟最多有效期及真实观察器完整 fleet 比较，拒绝 subset/重复/hash错误/过期。rollback 保留记录现金、查询、原存在合法履约/worker及已批准退款恢复。没有新增迁移，没有替代人工审批或宣称部署完成；root 负责实际 MCP/HTTP 接线与配置缺失阻断，部署层必须阻挡不调用新门禁的旧实例。全仓类型检查遇收款测试引用缺失方法，已交该 owner 处理，不报全仓通过。

### 真实运营角色 ACL 修复复验

QA 全迁移链发现旧目录 v2 表缺少 `merchant_ops` INSERT。已补迁移 260 和 `infra/local/ensure-app-role.sql` 闭包：旧目录 SKU/版本/权益/审计、新不可变事实仅 SELECT/INSERT；销售投影及权益包身份仅 SELECT/INSERT/UPDATE；商家角色新旧全局目录均撤权，只保留受控销售函数 EXECUTE。事实无 UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER 授权。

目录 PG 测试已改为 `SET ROLE merchant_ops` 执行整个仓储 mutation 链，不再用超级用户执行业务写入；还实际执行 bootstrap 目录 ACL 块，验证兼容全表授权后恢复最小权限。最新运行 `artifacts/isolated-postgres/run-A8TjOv/vitest.json`：1 测试通过，3.15 秒；类型检查及 diff check 通过。该复验覆盖最终动态赠点门禁代码版本。完整 bootstrap/全迁移链仍由 QA owner 的组合验收验证。

C6 模块单文件严格 NodeNext 类型检查及 diff check 通过。该 PG 测试使用最小历史 146、260 迁移及测试 outbox，不替代 owner 全迁移、API/MCP、桌面运营、商家、worker 与生产容器门禁。通知 262、交易 259、授权、售卖分页投影及 UI/API 接线由对应 owner 复核。

C6 追加真实部署文件观察器 `commercial-fleet-observer.ts` 和部署侧 `scripts/commercial-fleet-attester.ts`。生产观察文件及祖先路径 rootowned 且非可写、fresh ≤15 秒，完整库存与实际 probe 集合严格匹配；动态受控 hash pin 支持原批准期限内自动续短运行租约，原审批不自延长。两模块合计 9 测试及三个实现文件严格 NodeNext 类型检查通过、diff check 通过。部署工具尚未在 101 执行，真实 probe、Docker/Compose project完整覆盖、反代旧新购路由关闭与timer部署验证仍由发布 owner 完成。

C6 ECS Compose 接线已补：生产固定layer顺序不变，实际Docker Compose render后统一注入API/replica的runtime环境与可选整目录只读挂载；demo新增独立 `--commercial-runtime-env`，原relay-only root-env不扩宽。缺HOST_DIR无mount，普通默认启动无需不存在路径；配置source必须现存canonical/rootowned，bind create_host_path=false。`.env.example`、host installer（不创建审批/不开服务/不改live）、候选bundle依赖白名单及完整systemd准备/续租指令已补。

最终 `npx vitest run tests/commercial-runtime-compose.test.ts tests/ecs-demo-candidate-renderer.test.ts tests/ecs-production-compose-contract.test.ts --no-file-parallelism --testTimeout=30000`：51测试全通过（39生产、10demo、2实际Docker Compose新门禁配置），121秒。首轮失败包含宿主负载导致默认5秒超时、旧测试fixture未复制新helper、macOS临时目录symlink；后两项修正fixture、不降低生产路径限制，串行放宽测试执行时间后全过。测试模块strict NodeNext类型检查、三个script/shell syntax检查、diff check通过；不代表101已配置或启动timer。

owner 发现首次 installer 顺序写入可能残留半配置，已改完整 planner/preflight + apply 二次检查、exclusive open 跟踪、失败按 inode 回滚本次自建文件/空目录、变化对象保留和阶段报告。`tests/commercial-attester-install.test.ts` 5 执行测试通过（113ms）：晚目标预存在无mutation、原审批/控制路径拒绝、完整输出权限/hash、部分写入回滚和可重试、身份变化保留。实际临时文件操作仅注入 root ownership/祖先权限观察，不操作本机 /etc 或101；strict test types、syntax、diff check通过。首次安装现有目标仍拒绝；同候选新审批换代保留原业务审批独立版本，按runbook关新写、归档hash、受控atomic deployment config更换，不允许覆写/延长旧业务批准。

已向 owner 同步：商家列表只显示当前在售投影，不能挑最高批准历史；Ops 编辑安全投影须保留 policyRef/purchasePolicy/upgradePolicy/grantSchedule 及点包 expiryRule/expiryDays/product_type、价格模式和时长，不能编辑时丢弃消费政策；表单 grant_count/points_per_grant 展示须与冻结版本调度一致。

## CEO全范围复查后的发布消费校验收口

只读scope审计发现发布purchasePolicy条件与交易条件不同；按owner授权最小修复为目录publish直接复用 `commercialPurchasePolicy`、`commercialCycle`、`commercialPlanIdentity`，禁止空版本引用、超过604800秒窗口、缺明确套餐族/档位、缺新批准周期及无实现周期消费器。旧交易reader默认month1仅保持既有履约兼容，不作为新版本发布审批。未自动填rank或批准商品。

2026-10-05 12:55 targeted Vitest：commercial-catalog-repository.test.ts 26 + commercial-transaction-policy.test.ts 4，共30 passed/0failed。新增7组拒绝发布反例及三标准档独立草稿/审批/发布；明确隔离test权益值非正式商品配置。未启动PG/browser或全仓检查，当前版本需owner冻结后重跑实际范围。DX负责更新其owned fixture-clock明确批准terms。

权益包真实分页最小方案已协调DX（确认无handler并发编辑）：DB先filter后keyset分页，指定包版本直接查，references需覆盖目录及冻结订单且limit+1/next_cursor真实完整；不使用前100条再内存过滤。跨租户订单引用需平台最小受控Ops入口，不开放merchant_app全局查询。该项仍pending实际补丁/测试。
