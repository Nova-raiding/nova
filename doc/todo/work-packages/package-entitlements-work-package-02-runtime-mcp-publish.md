# 工作包 02：全链商业门禁、MCP Bridge、Worker 与真实执行证据

主责：后端/集成 owner

唯一需求依据：[商家营销插件商业化与 AI 创意点 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

实现约束依据：[商业化架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标与冻结顺序

在工作包 01 的共享契约冻结后，将同一 `CommercialAccessDecision` 接入插件入口、MCP、全部商家 HTTP、入队点、Worker 执行前复核、重试/补偿和内部 action。固定执行顺序为：

`schema → identity/session → tenant/RBAC/object scope → exact commercial classification → access decision/quote/reservation → onboarding/readiness → business mutation/outbox/provider`

任何 knowledge hydration、业务写库、入队、对象存储预留或外部调用不得早于商业判定。

## API/MCP 与恢复白名单

- 从共享 registry 生成并校验 HTTP/MCP/Worker 全入口清单；不使用路径前缀、HTTP method、`READ_ONLY_METHODS` 或 `SAFE_WITHOUT_INTERACTIVE_WRITE` 推导商业豁免。
- 零点仅开放 PRD 精确恢复/控制白名单：身份/会话/bootstrap，商业与点数读取，购买/升级/充值/支付状态，验签支付回调与对账，自有导出/删除申请，必要客服恢复，以及具独立 capability 的 Ops 修复/审计。
- 平台连接/授权/同步、扫描、在线商品/知识库/历史读取、创建/上传/规则/生成/编辑/审核/批量/发布和服务预约均不得因“只读”或 onboarding 被零点放行。
- `merchant.start` 在零点、unknown 或 insufficient 时不得写 intent、触发扫描或返回业务 action，只返回 access decision 与允许的恢复动作。
- HTTP/MCP 错误稳定保留 code、requestId、traceId、balance state、available/quoted points、access revision、rate version 和 nextAction；unknown 不得渲染为 0。

## Bridge 与 ChatGPT 插件

- Bridge 直接消费共享 method manifest、schema 与商业分类；删除宽泛本地白名单和旧钱包错误到任意金额充值的映射。
- `CREATIVE_POINTS_EXHAUSTED`、`CREATIVE_POINTS_INSUFFICIENT`、`CREATIVE_POINTS_UNAVAILABLE`、`COMMERCIAL_ACCESS_STALE`、`RATE_CARD_UNAVAILABLE` 在 API → Bridge → ChatGPT structured content 中无损传递且安全脱敏。
- 零点恢复 UI 只展示冻结点包 SKU、升级、支付状态、余额/到期、导出和客服；不得展示 50/100 元等未授权金额或业务工具。
- 收费动作确认显示服务端费率版本、预计点数和执行后余额；无批准费率不提供确认动作。
- 保留现有生产 HTTPS、真实 token、strict auth、fixture 禁用、交互确认和发布确认门禁；创意点门禁不能替代这些门禁。

## Worker 与外部执行

- Outbox event 固化 decision id/revision、entitlement snapshot/version、rate-card version、quote、reservation/allocation 和 operation id。
- Worker 在每次 provider/scanner/platform 调用前重读并校验 access revision、权益快照、费率、reservation、租户/对象权限和 readiness；漂移返回 `COMMERCIAL_ACCESS_STALE`，不外调。
- 文本、图片、图片编辑、OCR、视频五模态必须走已配置中转；保留真实 provider request、usage、cost、error 和 settlement 证据，缺配置或证据 fail-closed。
- 六平台逐 capability 验证真实鉴权、读写、媒体上传和状态回读；一个平台或一个 capability 的证据不得代表其他项。
- provider timeout、连接断开、Worker 崩溃或回调结果不明保持 unknown/reserved，禁止盲重试和结果交付，进入幂等对账。
- 发布继续要求人工确认票据、内容/对象/remote revision、nonce、hash 和真实回执；不增加无人值守发布。

## DX、可观测与验收

1. 生成全入口 parity 报告；新增未分类 route/method/action 时构建失败。
2. 提供插件开发者与 API 集成者的请求/响应示例、错误矩阵、幂等规则、轮询终止条件和 request/trace/operation/provider id 关联方法。
3. 结构化日志和告警能区分 exhausted、insufficient、unavailable、stale、rate unavailable、provider unknown 和 readiness blocked，且不输出凭据。
4. E1 验证全入口零点一致拒绝及无 DB/outbox/queue/storage/relay/scanner/platform 副作用；验证 Bridge 错误保真和恢复动作精确性。
5. E2 使用真 PostgreSQL/Worker 验证执行前 revision drift、并发耗尽、reservation 生命周期、崩溃恢复、outbox 重放和 unknown 对账。
6. E3 使用正式安装的 ChatGPT 插件连接真实沙箱，完成阻断 → 购买点包 → 支付到账 → 新 revision → 恢复业务闭环。
7. E4 保存真实支付、五模态中转、对象存储/scanner 和六平台逐能力 canary/回读证据；缺任一证据则对应能力保持 blocked。

## 依赖、风险与完成定义

- 依赖工作包 01 的 registry、目录、账本、decision、reservation 和错误契约；工作包 05 从第一天提供迁移与证据门禁。
- 工作包 04 可基于 E1 contract fixture 并行，但 E3/E4 必须连接真实 API/MCP/沙箱。
- 完成条件：API/MCP/Bridge/Worker 同切面启用且无绕过路径，E1/E2/E3 通过；只有取得对应 E4 证据的外部能力才可进入生产放行判断。

## 不包含

新商业 SKU、未批准费率、供应商开户、平台审批等待、ERP/PIM、专项增值服务、无人值守发布，以及手机或平板适配。
