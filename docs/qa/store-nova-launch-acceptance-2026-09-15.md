# Store Nova 上线续验记录 · 2026-09-15

时间：2026-09-15 13:48 +08:00（owner 多 agent 整合复验，尚未推送或部署）
范围：真实 ChatGPT 插件/MCP、支付与账务、租户权限、桌面后台、知识库、五模态中转及发布门禁。

## 判定

**NO-GO。** 已保留远端 UI、迁移 211、七附件收集器、ECS 配置审计及后续商家提示/支付模块打包修复，远端固定增量整合到 `7af498b4`。主业务冻结检查点为 `dab10890`，全仓检查及后续定向/独立运行证据见“最新 owner 收口检查点”；生产配置准备工具还在有界契约复验。尚未推送或部署。以下早期失败和“待复验”文字保留为历史快照，不替代最新状态。旧分支/共享部署/不可用 artifact 不代表当前候选。本次整合既有 0.2.0，不另行发布或回退插件版本。

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

## 最新 owner 收口检查点

- `edeca1c2` 干净冻结源码的完整 `npm run check` 退出 0：八组共 **6,013 passed / 73 skipped**；另后台 97 文件/615 项通过，根级类型检查、138 个前端契约引用、metadata、商家与运营两个 UI 构建通过。跳过不算通过。日志 `artifacts/owner-integration/dab108907942-20260915/merchant-owner-same-source-check-20260915.log`。之后合并远端 4 文件增量并添加打包回归，根级类型检查和六文件 33 项定向回归另行通过；不把前轮整库结果伪称为之后所有树变化的全量重跑。
- 最新 PG17 `--all` 真实复验退出 0：`artifacts/isolated-postgres/run-Ib02Kn/`，run ID `5a337b55-88dc-4eef-a5e7-faa32245bdc2`，**72 文件/95 项通过，零跳过、零未处理连接错误**。角色初始化复用部署 SQL，不手工添加验收 GRANT；迁移/RLS 原业务断言未放宽，两个精确 fixture 容器复查不存在。此前 `run-1lxPKB` 新 callback 测试因故障注入的真实行锁等待超时、随后中断，保留为失败；仅将该测试的应用连接设置为 750ms lock timeout 后 fresh 验证，不为生产 callback 虚构 5 秒超时保证。
- 最新支付真实 API/PG/Redis probe `artifacts/payment-reconciliation/run-VdLoqk/run-result.json` 退出 0，run ID `410e7988-a792-4630-9351-455df487ccf4`。充值与商业点包两情景均为：真实锁冲突首回调 500，订单仍 pending、资金/权益事实不变；解锁后完全相同的签名载荷 200，再次重放 200 且只入账一次；同 nonce 篡改 trade ID 返回 409。充值一次 1,100 分，商业点包仅一个 payment/grant/ledger，余额严格 500/0/0。9 个被测源指纹前后一致，并与 `dab10890` 主业务源逐一匹配；两个精确容器复查不存在。provider 仍为 localhost synthetic stub，真实支付/退款发送及模型调用为 0。
- 前轮整库检查日志 `/tmp/merchant-owner-final-frozen-check-20260915.log` 的客户交付 afterAll 60 秒超时仍记失败。新增的阶段日志不改变关闭顺序、超时或断言。之后 standalone 20/20、完整整库中的 20/20、追加两轮串行 20/20 均通过，browser/Vite/cache 三阶段全部完成；追加两轮 browser.close 为 7,628/18,204ms。记录为“间歇性清理超时尚未再现定位”，不声称根因已修复。重复日志保存在 owner-integration 目录。
- 商家候选之前在 Colima 上将临时工作区的 SQL bind 识别为目录，随后又发现严格容器编译的 TS18048，均保留失败日志。修复仅限独立候选：构建时封装迁移/角色 SQL，禁止 runtime host bind，固定 PG17 和唯一 project/images；根级类型检查及候选门禁通过。未修改共享 Compose 服务或用 PG17 挂载旧 PG16 卷。
- `dab1089079429f4e6215317546b37a1a798b65fd` 新镜像实际启动通过；API/商家 UI/运营 UI/PG/Redis 五服务均 healthy，migrate 退出 0，API 和两个 UI 的 SHA/release identity 一致。实际 PG17.11，迁移尾/数量均 211；owner 在精确自有 API 容器中导入编译后的 payment-provider 与 callback-envelope，并验证合成签名稳定，零真实支付/模型调用。启动检查与浏览器使用不同随机独立 project，精确容器停止后无 leftRunning/failures，数据卷保留。
- 商家桌面浏览器四文件 **24/24 passed**，2.1 分钟，包括三个真实候选页面巡检和 21 项前端故障注入/交互检查；后者不能替代真实业务 provider、知识库检索或 ChatGPT 宿主验收。三个巡检 inventory 各保留登录前 `/v1/auth/session` 的预期 401，不宣称浏览器 console/network 全部为零。owner 查看桌面概览和健康弹窗截图，CSS 正常、概览一屏、知识库折叠菜单保留；八项新生成 tracked 测试产物及 last-run 已另存 `artifacts/owner-integration/dab108907942-20260915/browser-output/`，再精确恢复旧测试产物，不回滚 UI 源。
- 独立审查确认相对早期远端的 21,147 项删除全部溯源至既有 `39efae4b` 生成产物清理提交，仅 artifacts/screenshots/dogfood/tmp/output；无 apps/packages/services/demo/infra/scripts/tests 或 CSS/迁移源删除。原用户工作区的实际产物与未提交业务修改仍保留，不把 git untracking 称为删除业务数据。

## 真实上线阻断

1. 真实 ChatGPT 宿主安装缓存、当前令牌、初始化/151 项工具/引导/历史必须与最终 digest 一致。此前真实任务旧令牌 403 是历史观察，不以 one-shot 或浏览器替代新宿主验收。
2. 共享 101 可 SSH 连接，12:30 只读版本窗口为旧混合部署、PG16/迁移尾 209；尚无绑定本轮候选的 PG17/211 升级通过证据。需要备份与独立 PG17 恢复升级演练，再部署 211 和精确镜像并复核。旧健康探针的 200 是 fixture/写入关闭/生产门禁关闭，不是生产 GO。13:49–13:50 的新增只读检查确认受控 locator symlink/draft 已持久化、目标在 root 内且 mode 600，但状态仍 BLOCKED；不把旧“locator missing”当作最新状态。见 [101 只读核验](101-runtime-readonly-audit-2026-09-15.md)。
3. 101 provider configured=false，原始原因 `provider_refund_query_api_must_use_https`；既有 `/opt/merchant-deploy/.env` 来源存在，不能断言密钥丢失。真实支付宝小额支付、签名 callback、查单、退款及对账回执还须真实闭环。审计投影失败现明确暴露并保留事务事实，不能称自动投影补偿已经实现。
4. 知识库生产 embedding/index worker/跨副本检索和插件实际消费证据仍待验。
5. 五模态中转必须重采绑定最终 release 的鉴权、请求、用量、成本和错误证据；旧 release 证据不能复用为新版本通过。
6. ignored 生产配置 locator 只保存路径，不包含或恢复秘密配置；draft/BLOCKED 配置不等于实际目标生产配置，最终 launch preflight 与部署 canary 尚未通过。

## GO 前顺序

冻结最终候选并完成同源全量/隔离验收 → 数据库备份与恢复升级演练 → 精确镜像部署并核验 211 → 真实 ChatGPT/支付宝/知识库/中转 canary → 目标生产 launch preflight。任何一步未通过都保持 NO-GO。
