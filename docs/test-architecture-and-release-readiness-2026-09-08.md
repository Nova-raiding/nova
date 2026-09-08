# 商家 ChatGPT 插件测试架构与上线验收报告

版本：2026-09-08  
责任角色：测试架构 owner / PM 复核  
当前结论：**NO-GO**。本地代码、容器、桌面浏览器主链路和发布静态门禁已通过；真实支付、六平台 OAuth/读写、生产对象存储、扫描器、告警和同一 release 的外部证据仍未齐全，因此不能宣称可生产上线。

本报告回答四个问题：测试什么、如何构造正反向数据、每轮看到什么、什么条件满足后才允许发布。它与[详细测试方案](../doc/todo/quality/test-strategy-2026-09-07.md)配套；本报告只记录当前 release 的可复核结果。

## 1. 被测系统和边界

唯一商家入口是桌面 ChatGPT 插件：

```text
ChatGPT 会话
  -> Plugin manifest / Skill
  -> stdio MCP Bridge
  -> MCP/API 鉴权、workspace scope、商业准入
  -> 模型中转 / 平台 connector
  -> PostgreSQL + RLS / Redis / Outbox
  -> Worker：同步、生成、发布、对账、扫描
  -> 商家交付证据与桌面运营后台
```

被测面分为三方：

| 参与方 | 主要能力 | 必须证明的结果 |
| --- | --- | --- |
| 商家插件 | `merchant.start`、workspace、商品/SKU、素材、生成、审核、发布查询 | 宿主调用真实可达；数据、权限、费用和证据贯通；未完成时不显示绿色成功 |
| API/MCP/Worker | 鉴权、RLS、商业目录、模型五模态、幂等、任务、回执、重试 | 跨租户拒绝、重复请求安全、未知结果可恢复、错误不伪装成功 |
| 平台运营后台 | 总览、成员权限、任务内容、平台连接、模型计费、审计、存储 | 桌面页面可滚动；状态区分 loading/empty/error/blocked/ready；服务端权限与按钮一致 |

手机、平板、未授权的外部平台成功、fixture 生成的“生产成功”均不进入上线通过分母。fixture 只能验证契约和 fail-closed 负向行为。

## 2. 测试分层

| 层级 | 测试内容 | 通过能证明什么 | 不能替代什么 |
| --- | --- | --- | --- |
| E0 静态门禁 | 类型、OpenAPI、MCP 注册表、metadata、镜像/迁移清单 | 声明和源码结构一致 | 真实身份、外部平台和公网宿主 |
| E1 确定性 | domain/service、Bridge 子进程、API stub、失败语义 | 状态机、协议、拒绝和幂等规则 | 官方平台授权和真实模型成本 |
| E2 本地集成 | PostgreSQL/RLS、Redis、API、Worker、OIDC 测试网关 | SQL、事务、租户隔离、进程间协议和桌面联动 | 正式 IdP、生产对象存储和公网宿主 |
| E3 桌面宿主 | 新 ChatGPT/Codex 会话、MCP tools/list、真实错误恢复、附件打开 | 当前宿主与安装包可调用 | 另一个宿主或另一个 release |
| E4 生产发布 | HTTPS、真实 OAuth、支付、KMS、扫描回执、容量、恢复、签名证据 | 同一 release 具备上线条件 | 自动继承到未来版本 |

状态定义：`pass` 表示该层的预期已观察到；`fail` 表示行为违反预期；`blocked` 表示缺少必要的外部配置或证据；`skipped` 表示用例按安全策略未执行。未知模型结果必须保持业务未知，不能当作失败后自动重试或成功。

## 3. 正向与反向用例矩阵

| 领域 | 正向用例 | 反向/故障用例 | 上线断言 |
| --- | --- | --- | --- |
| 宿主链路 | 新会话发现插件 → `merchant.start` → `workspace.health` | 缺 token、旧会话、MCP 不可达、`merchant.start` 两次 | 只出现一个有效调用；返回可关联 workspace；失败显示可恢复原因 |
| 身份权限 | A 租户 owner 读取自己的店铺和任务 | 用 B 的 workspace/brand/store/product/asset ID；撤权后 worker 执行 | 拒绝或空结果；无正文、签名 URL、账务或外部副作用泄漏 |
| 商品与 SKU | 导入 Excel/CSV → 预览 → 确认 → 生成任务 | 空文件、坏列、重复 SKU、同名商品、错误客户 ID | 合并规则稳定；错误行可定位；不跨客户写入 |
| 素材与真实性 | 上传 → 扫描 → OCR/人工确认 → 交付 bundle | 恶意文件、扫描超时、OCR 失败、HTTP 200 无真实产物 | quarantine 不可下载；真实渲染、OCR、人审 attestation、bundle hash 缺失时保持未验证 |
| 模型与计费 | 五模态分别通过统一 relay，记录 request/usage/cost | 401/429/500/503/超时、usage/cost 缺失、视频 queued | 只能通过配置的中转；未知结果可查询；无成本证据不结算、不交付 |
| 账务 | 足额余额创建订单、支付回调、对账、退款 | 余额 0/unknown、同 key 重放、金额变更、重复回调、并发扣点 | 一次扣款、一条流水；金额精确；旧钱包/fixture 不能解锁商业能力 |
| 平台连接 | 真实 OAuth → 读商品/SKU → 受控写入 → 回读 → 撤权 | OAuth state 重放、错误 scope、connector 缺失、回读不一致 | 六平台每个平台都必须有真实 canary 证据；fixture 不得显示绿色完成 |
| 发布与任务 | 方案确认 → 生成 → 审核 → 批准 → prepare → confirm → 查询 | 陈旧版本、确认票据重放、平台已接收但回包丢失 | 只有真实回执和远端回读才能进入 published；unknown 不盲目重发 |
| 运营后台 | 登录后遍历 14 个桌面域，筛选、刷新、返回、未保存导航 | 未授权、401、空结果、慢请求乱序、撤权后直调 API | 页面状态和 API 一致；滚动不白屏；失败与空态不混淆 |
| 发布门禁 | 同一 SHA 绑定 metadata、镜像、迁移和证据 | 旧 SHA、错 origin、过期证据、缺支付/存储/告警 | 非零退出并保持 writes disabled；不能靠重算 fixture 绕过 |

## 4. 当前多轮执行结果

### 第 0 轮：源码和发布门禁

执行入口：

```bash
npm run typecheck
npm run release:metadata:validate
npm run test:release-gates
npm run codex:relay:validate
```

结果：

- `typecheck` 通过。
- metadata 通过：MCP 契约 **293**，商家 Bridge **144**，Ops 一级域 **14**，迁移尾 **170**。
- `test:release-gates`：**119 个测试文件通过，6 个跳过；555 个测试通过，13 个跳过**。跳过项是需要显式 PostgreSQL release 环境的专项用例，不计为生产通过。
- 本轮捕获并修复了宿主 relay 校验器误把“Codex 内置 `openai` + 文件型 ChatGPT 订阅认证”判为 provider mismatch 的问题；现在 `codex:relay:validate` 明确返回 `host_auth=chatgpt_subscription`，业务 relay 仍要求独立的真实配置。

### 第 1 轮：真实本地运行时

`/healthz` 和 `/readyz` 返回 HTTP 200；API、API replica、6 个 Worker、PostgreSQL、Redis、ClamAV、商家 UI 和 Ops UI 均为 healthy。数据库迁移尾为 169。

但 `/readyz` 的 `production_ready=false` 是正确结果：当前环境仍是 fixture/local mode。Worker 容器健康只证明进程存活，不能证明生产扫描器、对象存储、支付或平台写入已经具备。

### 第 2 轮：gstack 未授权负向验收

通过 gstack browse 访问 `/ops/overview`，无 OIDC 身份时页面显示“无权访问 `platform.summary.read`”，没有把未授权状态渲染成运营数据，也没有 console error。这一轮证明权限缺失时 fail-closed。

### 第 3 轮：桌面授权浏览器验收

命令：

```bash
npm run test:browser:merchant
npm run test:browser:ops
```

结果：

- Merchant Studio/商家侧：**22/22 passed**（2026-09-08 13:01 轮次），覆盖导航、模型 relay 可见性、任务生成、确认恢复、未知结果、规则空态、店铺身份和发布安全。
- Ops Console：**7 passed，1 skipped**（2026-09-08 13:01 轮次）。覆盖 14 个桌面运营域、无凭据诊断、401 重新认证、工作区品牌树、用户/成员治理；破坏性确认场景按安全策略跳过。
- 未观察到滚动白屏或新的 console error；Ops 的任务页此前已验证底部滚动位置可到 `2762/2762`，页面仍有内容渲染。
- Ops 隔离运行证据目录：`artifacts/ops-jit-isolation/2026-09-08T05-01-16.592Z-311f8740-9433-4b66-9e33-9a16c207a894`。

同轮补做新 Codex 宿主 smoke：线程 `01a07f59-8b1f-7b83-b852-4939d6bf727b` 只调用一次 `merchant.start` 并返回欢迎语；没有调用其他商家工具。该结果只证明本机安装插件到 loopback MCP/API 的主链路，不能替代公网 HTTPS MCP、正式 ChatGPT 外部宿主和真实平台写入证据。

### 第 4 轮：生产 doctor 和上线判断

在受控 shell 中显式注入 Bridge endpoint/token 后运行：

```bash
env MERCHANT_MCP_BASE_URL="$(launchctl getenv MERCHANT_MCP_BASE_URL)" \
  MERCHANT_MCP_TOKEN="$(launchctl getenv MERCHANT_MCP_TOKEN)" \
  npm run dev:doctor:production
```

未注入变量的普通终端会多出一个环境阻断（39 pass / 1 warn / 13 fail）；按上面的受控 shell 显式注入 launchd 中的 loopback endpoint/token 后，当前结果为：**40 pass / 1 warn / 12 fail**。这 12 个 fail 仍是上线阻断，且不是把本地 endpoint 当成公网生产配置的理由。

剩余 12 个 fail 是上线阻断，不是代码测试失败：

1. 未提供真实 `PRODUCTION_CONFIG_PATH`。
2. `/readyz` 没有 `production_ready=true`。
3. 支付仍为 fixture，缺真实 provider、签名、防重、查询、退款和对账证据。
4. 六个平台 `jd`、`taobao`、`tmall`、`pinduoduo`、`xiaohongshu`、`douyin` 的 OAuth 配置全部缺失。
5. 五模态 relay 的生产用量/成本证据尚未绑定 release；本地 relay contract 通过不等于生产证据通过。
6. 对象存储仍为 local，缺生产 S3/KMS、版本恢复和 attestation。
7. 扫描器缺生产签名回执、新鲜度和非 fixture 证据；ClamAV healthy 不足以放行。
8. 生产告警 webhook/secret 和真实投递验证缺失。
9. `productionGate=false`、writes disabled，`releasez.ready=false`。
10. `MODEL_RELAY_EVIDENCE_PATH` 缺失。
11. `CODEX_APP_HOST_EVIDENCE_PATH` 缺失，尚没有外部宿主 503/error-recovery 证据。
12. 上述证据未被同一不可变 release manifest 绑定。

本轮进一步执行了 `npm run infra:launch-preflight`、`npm run evidence:validate` 和 `npm run capacity:evidence:validate`：生产预检因没有 `PRODUCTION_CONFIG_PATH` 正确阻断；能力与容量文件只验证了 example 的 schema，并明确标记为 fixture/non-production，不能升级为生产证据。下一轮必须由受控生产环境提供渲染配置、真实云容量报告和平台能力 evidence，再执行同一组门禁。

## 5. 修复闭环规则

每轮按以下顺序执行，任何一项失败都不得跳到下一层：

1. 记录输入数据、身份、workspace、release SHA、容器镜像和环境变量来源。
2. 先跑反向用例，确认缺配置时拒绝且无副作用。
3. 再跑正向用例，保存 response、request/trace/provider ID、usage/cost、回执、远端回读和截图。
4. 发现问题后只修复对应源文件，并补一条针对真实触发条件的回归测试。
5. 重跑该用例、相邻模块、桌面浏览器和发布门禁；没有新的失败才进入下一轮。
6. 证据按 release SHA、环境、时间、操作者和文件 hash 归档；模型预览、脚本输出或人工口头确认不能独立成为交付证据。

## 6. 生产放行清单

只有以下条件全部满足才把结论从 NO-GO 改为 GO：

- 新 ChatGPT 会话中 `merchant.start` 连续两次均成功，工具清单唯一且与安装包 hash 一致。
- 五模态均通过真实 relay canary，保存真实 request/usage/cost/error evidence。
- 六个平台分别完成 OAuth、只读同步、受控写入、回读、撤权 canary；每个平台有独立 evidence ref。
- 真实支付完成 checkout、callback 验签、防重、query、reconciliation、refund。
- 对象存储启用版本、KMS、公开访问阻断、扫描隔离和删除保护，并完成独立恢复抽样。
- 生产扫描器有签名回执和新鲜度校验；EICAR/恶意文件/超时/重试均有证据。
- 容量、长稳、备份恢复、告警投递和回滚演练与同一 release SHA 绑定。
- `productionGate=true`、`writes=true` 只能由发布控制面配置；`dev:doctor:production` 和 `releasez` 同时通过。

## 7. 复验入口

- [详细测试方案](../doc/todo/quality/test-strategy-2026-09-07.md)
- [产品使用介绍](product-usage-guide.md)
- [ChatGPT 宿主链路报告](../doc/todo/plugin/codex-app-e2e-report.md)
- [六平台授权 runbook](../doc/todo/platform/four-platform-authorization-runbook.md)
- [release metadata](../release-metadata.json)
- [relay validator](../scripts/validate-codex-relay.ts)
- [production doctor](../scripts/dev-doctor.ts)
