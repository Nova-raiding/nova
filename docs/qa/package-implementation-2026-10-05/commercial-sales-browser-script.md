# 真实商业桌面脚本交接（待运行）

2026-10-05。脚本已完成静态检查及受控 opt-in 单测，未启动 PG、API、worker 容器或浏览器。运行结果 pending，不作为上线、正式候选验收、真实外部银行转账、半年日历等待或 ChatGPT 插件生产链路成功证据。

## 文件与执行

- `dogfood/chatgpt-all-functions/ops-commercial-sales-isolated.spec.js`：运营目录真实草稿、提交、批准、发布；商家已发布通知；指定 active 客户首购预览和两笔冻结订单；一笔 7000 元隔离收款联合分配；当前基础套餐；两笔续期未来合同真实分区、顺序顺延及无提前点数授予；下架/再批准发布/归档影响新售且有效旧单仍按冻结金额履约；商家点数包订单和人工核验；独立尊享隔离配置及升级保持未来合同；历史半期升级；目录由 5000 改 6000 后旧报价仍按冻结价格建单；新报价读取新价；升级保持原到期；原 checkout 写已提交但响应丢失后按原 key 查询恢复。
- `dogfood/chatgpt-all-functions/commercial-sales-merchant.js`：商家 owner 提供真实桌面登录/通知/当前套餐/订单付款明细 helper。第二商家必须使用显式历史账号覆盖，不能使用首购账号替代。
- `scripts/ops-commercial-sales-lease.ts`：仅显式单一 sales spec 启用；默认其他脚本 C6 closed。源码身份包括未提交及未跟踪可执行源文件；真实 release manifest 的字节摘要作为 candidate identity；实际 merchant_app/merchant_ops 非 superuser、非 bypassRLS 的迁移完整摘要必须一致。独占已有 runner API child PID，单一 ingress 库存、loopback 地址、真实 `/internal/commercial-runtime-attestation` 的 hostname/protocol/candidate/schema 必须一致且进程存活。实际范围证明写入后才发布 policy；使用原 file verifier/fleet observer，不设置 deploymentEvidenceVerified。
- `scripts/ops-commercial-history-fixture.ts`：第二隔离企业与账号，经真实 repository 合法发布历史商品、首购、核验和授予；catalog 构造器可选 fixtureMutationClock 仅 seed 进程调用，API 无时钟 wire 字段，生产默认仍数据库 clock_timestamp。过去 verifiedAt 独立显式传入，不用 paidAt 冒充 verifiedAt，不 UPDATE 已建合同、订单或日期。约 15 天旧的自然月合同剩余占比须在 40%–60%。独立 fresh 首购不使用该历史种子。
- `scripts/run-ops-password-e2e.ts`：sales-only 分支接入上述两 helper；原 support/default 分支保持 closed。独立 fixture 的清理由既有 runner 完成，无手工删除业务数据。
- `tests/ops-commercial-sales-lease.test.ts`：8 个 fail-closed opt-in 边界用例通过；`commercial-catalog-fixture-clock.test.ts` 2 个 guard 用例及原目录 18 个用例通过。

待 root 当前 release-gates 与其他 PG/browser 所有执行终态后，QA 独占运行：

```sh
OPS_E2E_COMMERCIAL_SALES=true OPS_E2E_MERCHANT_UI=true OPS_E2E_BROWSER_TIMEOUT_MS=600000 node --import tsx scripts/run-ops-password-e2e.ts dogfood/chatgpt-all-functions/ops-commercial-sales-isolated.spec.js
```

不得同时传 delivery scan、多 spec 或非 true sales flag。需要既有 runner 的 Docker/Chrome、本机端口、构建依赖可用；其自动提供真实两端 loopback 地址、临时密码账号、OPS_E2E_OUTPUT_DIR、三个 64 位 identity 摘要、隔离银行收款引用、历史 fixture safe JSON 与第二账号环境变量。历史账号变量为 OPS_E2E_HISTORY_MERCHANT_USERNAME/PASSWORD，安全文件路径为 OPS_E2E_COMMERCIAL_HISTORY_FIXTURE。不需人工 token 或生产密码。

## 签名通知 worker 与租约

仅 sales-only helper 创建随机 reconcile API token/signing secret 并传 API 的真实 WORKER_API_CREDENTIALS。浏览器不获得 worker credential。owner node controller 通过现有 postCommercialNotificationTick 发真实签名 HTTP 请求，消耗真实 outbox，记录 eventId/scanned/delivered/complete；失败使租约 fence 并使 runner 失败，不 ACK 或构造通知。它证明此隔离 API/DB 及已有 worker 请求函数边界，完整 worker 容器和 101 的部署仍独立验收。

租约每 5 秒重新探针、15 秒过期（fleet capturedAt 同时受原 verifier freshness 约束），复核完整唯一 API child 库存和源码 identity。child exit、身份/源码变化、probe/worker 故障立即移除只属于此 helper 的 pin/evidence/fleet files，guard 失败；cleanup 清 timer，owned process 仍按 runner 生命周期退出。环境不会留下其他默认 sales 可用状态。

## 证据与网络故障

输出目录含 owned-commercial-lease 下实际 manifest、schema/candidate/source digest、controller approval/audit 范围、runtime scope PID/probe、fleet observation、runtime policy/pin、notification-worker-progress.jsonl；商业步骤和桌面图在 commercial-sales/evidence.json 与 PNG。均标 isolated-test-only/owned-test-not-production；policy refs 是隔离声明，无正式财务/法律审批效力。

unknown 场景使用 Playwright route.fetch 原样转发真实 checkout.create，并检查真实服务端成功响应，再 abort 浏览器接收一次。没有 mock endpoint、route.fulfill、伪造 JSON 或状态。UI 必须保留原幂等 key，查询真实 checkout.request.get；订单 ID 必须和实际成功响应逐一一致，create 请求次数必须为 1。记录证据不包含 headers、cookie、密码或 worker secret。

到账字段为实际现场秒级 datetime-local 时间；先从真实冻结订单读取 created_at，并等待实际墙钟的秒级时间不早于所有分项建单时间，不回填早于发布/建单的分钟时间。不修改浏览器/API 时钟。只登记收款不能提前开通；联合分配前 portfolio 仍无资格/当前合同，整批真实 confirm 后取得两条事实且真实 portfolio 有资格及当前合同。原合同 sourceOrderId 在升级后保留基础来源，升级订单另外在实际订单记录核对补差金额。

## 验证边界与待验

静态 `node --check` 通过；纯 opt-in tests 8 passed。整体脚本没有运行成功证据，首次真实 QA 执行可能发现实际 selector/契约/门禁问题，必须真实修正后复验。上面的源码/manifest 是 owned node 范围，不是构建产物封存的正式生产 candidate；正式 ECS 部署仍需按候选门禁重新建立完整 ingress 库存和迁移身份。

本脚本覆盖 basic/growth/premium/onboarding/registered point_pack 的隔离批准值。尊享独立配置为 10000 元、每月 30000 点、3 品牌、20 店铺；基础/成长分别使用 5000/12500 点及各自额度。这是经真实 Ops 草稿、提交、批准、发布的隔离测试值，不能作为生产批准商品参数或复制成长模板给尊享的证据。真实升级验证尊享当前冻结版本/额度，原到期与已付未来基础版本不变。

开通费由 5000 改 5500、包由 100 改 120、基础由 2000 改 2200，全部通过新版本独立审批发布。原开通单仍按 5000、旧包按 100 和原到期；已经开通者不会再建开通单。第一续期在基础调价前冻结 2000，下架后核验形成未来一；重新批准上架后第二续期冻结 2200，归档后核验形成未来二。两未来起止首尾衔接、冻结版本/来源分别核对；当前原起止/版本不移动，未生效续期的正数 grant 在真实完整点数账本中应不存在。已归档 UI 不能再编辑/上架，新售目录中消失。

赠点断言绑定 shared DTO：实际 available onboarding_gifts 一份原开通来源计划、6 个真实 schedule（1 已发，5 按约定未来），每笔 500、约定及到期时间、原开通版本和来源、计划身份在调价及升级后不重启。原冻结订单详情必须独立说明 6×500 不含首期费且不一次全发；点数来源账本必须以 known commercial_origin 显示开通赠点/套餐点数/权益包点数及各自实际订单和版本。技术来源放详情，脚本点击 summary 后才核对可见的来源，不把 3000 约定总量当已到账。不猜 unknown 来源，不跳过缺配置，不以余额替代来源列表。

本脚本不人为推进 API 时钟或改已有日期来宣称未来期间已经到期/生效；它验当前有效与未来未生效的真实同时分区。未来真正开始时的 worker 生效、六个自然月实际执行/过期/漏窗和重放，需要独立已有 PG/worker 受控时钟验收及生产运行证据。完整 worker 容器部署与本地 ChatGPT stdio 五模态链路仍不由此脚本替代；TTHW 未计时，不能宣称 ≤5 分钟完成所有发布/通知/付款。

扩展脚本 node --check、diff check 通过，QA 已只读复核 DTO/selector；仍未启动或实际通过浏览器执行。赠点 UI owner 的 build/scoped tests 单独记录，不将其当作本脚本 runtime 成功。

## 四态通知和三企业隔离（源码新增，运行待验）

sales-only 新增第三个企业，通过真实邀请仓储生成 pending 账号，再使用一次性凭据自主设密并接受条款；正常成员激活不授商业资格。凭据仅在 runner 内存与受控 child 环境，安全证据不落密码/邀请 token。controller 的 known scope 是原始首购企业、独立历史企业、独立未开通企业，精确匹配 run-specific 三个 ID 并以真实 merchant_ops 角色和平台 RLS context 查询整个 Workspace 库存相等；任何额外或遗漏企业均失败，不能用任意数量或前缀放行。

签名 controller 每轮分别调用 catalog_publication 和这三个实际 Workspace 的 purchase_result tick，新 mode 字段进入原签名请求体。每次真实返回的 progress 按 Workspace、mode 写 JSONL，HTTP/worker 错误导致 fence。浏览器没有 worker secret，既不伪造 outbox，也不直接注入通知。

首购授予产生立即生效结果，两条续购产生未来待生效结果。第三企业联合首购只分配套餐行真实收款，开通行仍未付，因此从真实通知验证待开通依赖，同时 portfolio 无资格/当前/未来合同。另建一个独立审批的 2 秒付款窗口点数包，真实建单后等待实际墙钟超过 expires_at，登记现场迟到款并按原 UI 预览、确认，验证待处置通知且无包/正数点数授予。该短窗口仅 owned-test 政策，不改变生产规则；如果真实 UI 阻断合法迟到款登记或分配，脚本应失败交出功能缺口，不能绕 UI 修改请求或日期。

通知列表以真实返回顺序、原订单 ID、result_state 与中文结果绑定，点击查看已购与相关订单必须进入订单与恢复且预填原 ID，不新购。已读验收真实 forward POST 后 abort 一次，界面必须保留未确认并用原 idempotency_key 重试；仓储返回 replayed=true、相同 read_at，页面重载及真实列表刷新后仍已读、无再次登记按钮。安全证据保存通知/订单标识与 read_at，不保存凭据。四态与恢复目前仅脚本完整，仍需 QA 串行真实浏览器通过。

## 本地 production profile 可行性结论

本轮不增加伪 production 开关。实际 NODE_ENV=production 会同时触发 commercial runtime control files 的 root-owned 且不可组/全局写路径验证及完整 health readiness 门禁。本机 /Users/lixiaomei 和工作目录属普通用户（uid 501），owned artifact 位于该路径，因此不满足生产路径要求。当前隔离 API 地址为同一 127.0.0.1 的 HTTP 两端，生产身份要求不同主机名的 HTTPS Ops/App origin 与准确 merchant bearer hostname；不能把该配置称为生产通过。

production health 还要求真实五模态中转配置/鉴权/成本证据、对象存储及生命周期、扫描器、规则/向量/告警、真实发布版本和 image digest 等。storeless 商家没有店铺不表示可跳过这些基础设施门禁。runner 的受控 child 环境不继承生产 .env 或中转秘密，本轮没有这些真实配置与诊断证据。因此 production profile 保持 pending；生产 101 候选需使用真实配置、root-owned 控制目录、实际 image/schema/fleet ingress 库存重新验收。若将来构建专用隔离 Linux/root-owned runner，也需真实配置和绑定证据，不能改布尔 deploymentEvidenceVerified、假 release image/relay flag 或复制生产秘密进浏览器。当前 owned node development C6 验收与生产候选验收分别记录。

依据：apps/api/src/commercial-runtime-policy.ts 的部署路径验证、apps/api/src/health-readiness.ts 的 production required gates、apps/api/src/server.ts 的生产身份/对象存储/发布 readiness；上述结论来自源代码和本机路径权限读取，未运行 production profile，也未启动本轮 fixture。
