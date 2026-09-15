# Store Nova 上线续验记录 · 2026-09-15

时间：2026-09-15 13:08 +08:00（owner 多 agent 整合复验，尚未收口）
范围：真实 ChatGPT 插件/MCP、支付与账务、租户权限、桌面后台、知识库、五模态中转及发布门禁。

## 判定

**NO-GO。** 已依次保留远端 UI、迁移 211、七附件收集器及既有 ECS 配置审计，最新远端合并到 `47254d49`。账务源检查点为 `899a6eff`，测试清理修复为 `d7b39e1e`；正在最终同源复验，尚未推送或部署。旧分支/共享部署/不可用 artifact 不代表当前候选。本次整合既有 0.2.0，不另行发布或回退插件版本。

## owner 已验证的第一检查点

- `npm run check` 退出 0：四组 5,834 项通过（72 项真实环境测试跳过，不算通过），后台独立 97 文件/615 项通过；138 个后台前端契约引用完整，metadata 校验及两个桌面 UI 构建通过。
- 合并定向 326 项、后续 API/契约/账务 296 项、统一生产 OAuth 门禁 65 项通过。删除了重复支付 worker handler；self/workspace/platform 账务策略分离，生产 OAuth 配置不完整时静态令牌不再兜底。
- 隔离 PostgreSQL 17/Redis：20 文件、21 项通过。插件 bridge 严格返回真实余额 `available_points=500/reserved_points=0/settled_points=0`，canonical OAuth 买家、回调重放仅入账一次及另一成员订单不可见均通过。证据 `artifacts/isolated-postgres/run-kbRPAs/`，run ID `fb321582-360f-461e-93a4-22320862b0f6`，两个精确容器复查不存在。
- 最后一次 owner 支付 probe：`artifacts/payment-reconciliation/run-9UDlfU/run-result.json`，run ID `57ab363a-8874-4cb5-93f7-0742db42f4a8`，通过。行锁仍被 blocker 持有时 5,525 ms 返回原始 `55P03/attention_required`，账本不变，恢复仅入账一次；四类真实 PG 审计投影故障保留正确结算/退款/释放状态与事务 outbox。源指纹一致，两个精确 fixture 容器复查不存在。provider 是独立 localhost stub，真实支付/模型调用为 0。
- 历史失败 `artifacts/payment-reconciliation/run-uGyez2/run-result.json` 保留为失败；修复后通过不改写其结果。
- ClamAV 实际 100MiB INSTREAM 通过，压缩展开 101MiB 触发 limits-exceeded FOUND；交付产品上限仍 50MiB。仅精确 MCP/资产上传路径有较大 body budget，普通 API/支付回调保持 1m；独立 PG17 迁移镜像门禁、支付非公网/占位/canonical URL 门禁已复核。专项 agent 原始证据在 `/private/tmp/merchant-infra-runtime-evidence-wrcFi3`，不代表 ACK 已部署通过。

## 最新增量、owner 证据及仍需复验

- 保留他人交付 Upload 的目的级 `data-testid` 与浏览器定位提交；此次远端增量没有 CSS/布局修改，不用旧组件覆盖远端 UI。
- 保留 OCR provider/cost gate、递归敏感字段脱敏、只接受已上传合同 asset 引用及视频最后操作人归因。
- metadata 迁移尾更新为 211，插件版本保留 `0.1.0+codex.20260915100904`；不回退插件或放宽余额数量断言。
- 迁移 211 门禁已由 owner 在整合后独立复测：默认 21 文件、22 项通过，`artifacts/isolated-postgres/run-vML8vY/`，run ID `a3609119-bffa-4c26-b940-17b2cc366e1d`。210→211 历史不变/幂等、跨租户 42501、账号身份错配 23503、16 类 catalog 篡改拒绝；两个精确容器复查不存在。旧门禁误判的红灯证据保留。
- 隔离 PostgreSQL `--all` 第一轮因 PG17 服务端与本机 PG16 dump/restore 工具不匹配而失败，并发现两类历史集成测试没有绑定 fixture 数据库。已安装不链接的 libpq@17 客户端，仅在测试命令 PATH 中启用，并让精确 `--all` 的历史变量指向已核验自有 fixture，不继承业务数据库。
- 第二轮 `artifacts/isolated-postgres/run-sNRgw6/` 无跳过、71 文件/94 项通过，但未处理的 57P01 导致退出 1，仍判失败；run ID `ed7fba8f-ec88-49d5-b356-0ec988ff009b`，两个精确 fixture 容器复查不存在。确定为 product RLS 测试强杀尚在关闭的连接；修复仅等待随机自有测试库连接归零，超时不删除、不吞错误，并保留原断言错误与清理错误。owner 12 项清理回归及相关门禁合计 73 项通过；最终 `--all` 正在 fresh 重跑。
- 最新支付旧 probe `artifacts/payment-reconciliation/run-wCuMwx/run-result.json` 在迁移 211 整合后通过，run ID `b62443fe-2020-495e-ad07-518b52775075`，锁仍被 blocker 持有时 5,030 ms 返回原始 55P03；容器精确复查不存在。后续独立审查发现合法 limit=1 双队列饥饿及并发关闭后虚报钱包释放，已纳入 `899a6eff`，owner 定向 HTTP/仓储 122 项通过。新增真实 PG/HTTP 两情景 probe 等待最终执行，旧支付 probe 不替代该补丁。
- 四份真实 Nginx HTTP/HTTPS 配置的 41 个代理探针通过：50MiB 文件的 base64 JSON 69,905,187 bytes 在精确 MCP 路径可达，上游一次且字节完整；超 70MiB、普通 API/回调超 1MiB 均 413 且不命中上游。临时 1m 红色控制拒绝同一合法大请求。证据 `/private/tmp/merchant-nginx-body-probe-Cgooj1/`；owner 核验请求数量/结果和六个容器不存在。这里只验证真实代理→echo 边界，不声称业务上传或 ACK 验收。
- 默认商家浏览器现使用随机独立端口、唯一 project/images、环境白名单、真实 health/SHA 身份检查及精确容器清理；必须冻结干净提交后再跑。之前默认测试误连 101 SSH 隧道，已排除出候选验收。只读 101 窗口核验未发现可归因的新增业务或密码会话，但无基线/完整请求日志，不能宣称全部副作用为 0。
- 中间全量检查退出 0，但期间新增 P1/清理源码，不能作为最终证据；最终全量检查、隔离 PG/支付/桌面验收与推送仍待完成。最终全量日志 `/tmp/merchant-owner-899a6eff-final-check-20260915.log`。没有删除业务数据或容器数据掩盖失败。

## 最新续验与新增缺陷

- `899a6eff` 支付补丁的 owner 真实 HTTP/PG/Redis probe 已退出 0：`artifacts/payment-reconciliation/run-I4XJyH/run-result.json`，run ID `60ac700f-806c-43e4-a394-f91fca93b820`。合法 limit=1 连续两轮访问退款/支付队列；退款查单失败与真实仓储完成退款并发时，不虚报释放、不新增释放账本；源码指纹前后一致。两个精确 fixture 容器复查不存在。provider 是 localhost synthetic stub，真实支付/退款发送及模型调用均为 0，不能替代真实支付宝闭环。
- `npm run check` 退出 0：八组共 5,932 项通过、72 项跳过，另桌面运营后台 615 项通过，metadata/前端契约及两个 UI 构建通过。日志 `/tmp/merchant-owner-899a6eff-final-check-20260915.log`。执行末期新增了后述缺陷补丁，故这是中间检查，不作为最终同源验收。
- 第三轮 PG `--all`：`artifacts/isolated-postgres/run-ygJriO/`，run ID `ac0daf7b-96ad-47fc-b81d-386f799cc630`，71 文件/94 断言通过但迁移 210 清理产生未处理 57P01，整体退出 1。两个精确 fixture 容器复查不存在。已确认多个独立测试库采用同一强杀竞态，统一改为精确 UUID 前缀校验、连接有界归零再 DROP，超时不强删；owner 独立核验 51 个修改文件中 71 个原 try 代码块逐字不变（包含嵌套 try），不改迁移/RLS 业务断言。最终 PG 复验待执行。
- 新发现两项 P1：`merchant.start` 的引导权限不能替代工作区财务权限，普通运营成员/显式拒绝身份不应读取工作区余额；临时授权须经专用读取端点计次。支付 nonce 独立消费后若入账事务暂态失败，同一有效签名不能被永久拒绝；恢复仅允许与持久记录完全相同的签名载荷，不同载荷仍须拒绝。两项均在补充红绿回归与 owner 复核中，未宣称最终通过。
- 以上两项源修复已纳入 `84d16cc2`，owner 六文件 285 项目标检查通过。之后 PG `run-zhWcV7` 的原 71 文件/94 项全部通过、无未处理 57P01，但新增 callback fixture 未执行真实数据库级角色初始化，因 `billing_orders` 权限不足失败；全量仍退出 1，不算通过。两个精确容器复查不存在。已改为复用运行环境的 `infra/local/ensure-app-role.sql` 在迁移前后初始化，并验证应用角色非 superuser/bypass，不手工追加验收专用 GRANT；须 fresh 重验。
- 现代回调币种又确认 P1：正确重签 USD/空串/缺失币种的真实 HTTP red 三项均错误返回 200。共同验签入口现于 nonce 消费前拒绝非 CNY，旧本地测试签名兼容保留；green 三项及相关六文件 215 项通过。同 nonce 的有效 CNY 恢复通知可成功且重放只入账一次。owner 最终同源验收待完成。
- 桌面运营后台独立 OIDC/PG/Redis 浏览器检查点 10/10 通过、零跳过/重试；`artifacts/ops-jit-isolation/2026-09-15T05-11-06.050Z-9b2558a4-b60c-4a9d-ac7a-de2e30ac5af0/playwright.json`，run ID `737268de-9cb1-40ac-9df0-7983494d4ca4`。只验证该独立候选，不代表 101/真实 ChatGPT。owner 查看用户目录桌面截图，保留本轮八项生成产物于 `browser-output/` 并恢复旧 tracked 测试产物，不改 UI 源；两个精确 fixture 容器复查不存在。

## 真实上线阻断

1. 真实 ChatGPT 宿主安装缓存、当前令牌、初始化/151 项工具/引导/历史必须与最终 digest 一致。此前真实任务旧令牌 403 是历史观察，不以 one-shot 或浏览器替代新宿主验收。
2. 共享 101 可 SSH 连接，但仍为旧混合部署、PG16/迁移尾 209；需要备份与独立 PG17 恢复升级演练，再部署 211 和精确镜像并复核。当前健康探针的 200 是 fixture/写入关闭/生产门禁关闭，不是生产 GO。见 [101 只读核验](101-runtime-readonly-audit-2026-09-15.md)。
3. 101 provider configured=false，原始原因 `provider_refund_query_api_must_use_https`；既有 `/opt/merchant-deploy/.env` 来源存在，不能断言密钥丢失。真实支付宝小额支付、签名 callback、查单、退款及对账回执还须真实闭环。审计投影失败现明确暴露并保留事务事实，不能称自动投影补偿已经实现。
4. 知识库生产 embedding/index worker/跨副本检索和插件实际消费证据仍待验。
5. 五模态中转必须重采绑定最终 release 的鉴权、请求、用量、成本和错误证据；旧 release 证据不能复用为新版本通过。
6. ignored 生产配置 locator 只保存路径，不包含或恢复秘密配置；draft/BLOCKED 配置不等于实际目标生产配置，最终 launch preflight 与部署 canary 尚未通过。

## GO 前顺序

冻结最终候选并完成同源全量/隔离验收 → 数据库备份与恢复升级演练 → 精确镜像部署并核验 211 → 真实 ChatGPT/支付宝/知识库/中转 canary → 目标生产 launch preflight。任何一步未通过都保持 NO-GO。
