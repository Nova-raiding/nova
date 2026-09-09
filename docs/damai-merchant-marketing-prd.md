# 大麦商家营销 ChatGPT App 产品 PRD

**版本**：v1.0
**日期**：2026-09-09
**状态**：开发与验收基线
**适用范围**：ChatGPT App/插件、商家运营后台、平台运营后台、API/MCP、模型中转、知识库、规则引擎、任务 worker、账务与发布链路

> **版本关系（2026-09-09）**：产品主链路以 [《大麦商家营销平台产品总文档》](damai-product-master-document.md) v2.0 为准。本文 v1.0 保留为领域需求和历史实现参考；其中关于 OIDC/企业 SSO、邀请制和“已有向量索引”的表述已被 v2.0 的账号密码、注册后待审核和“向量能力待实现”决策覆盖。

## 1. 产品定义

大麦商家营销是一个安装在 ChatGPT 中、面向电商商家的内容生产与平台运营产品。商家通过 ChatGPT 选择商品并提出自然语言需求；大麦服务端在商家授权范围内读取商品、SKU、素材、品牌和规则知识，调用大麦自有模型中转站生成商品主图、详情页和视频，随后在商家运营后台进行审核、下载或一键发布。

ChatGPT 是交互入口，不是权限、账务、模型、店铺授权或发布的事实来源。所有真实事实必须由大麦 API/MCP、数据库/RLS、worker 和平台回执确认。

## 2. 目标与非目标

### 2.1 目标

1. 商家可以在 ChatGPT App 市场安装“大麦商家营销”，完成注册并被平台开通。
2. 商家可以在商家后台绑定自己的平台店铺并同步真实商品。
3. 商家可以通过 Excel 批量导入商品、SKU、材质、卖点、图片和品类资料。
4. 导入资料经过安全扫描、权益检查、平台规则、广告法、促销和品类规则预检。
5. ChatGPT 输入商品名称后，只检索当前商家 Workspace 中匹配且已批准的知识内容。
6. 商家可以生成主图、详情页、视频和批量任务，并看到可解释的状态、来源和阻断原因。
7. 生成结果可以下载，也可以在商家后台完成审核后发布到已授权店铺。
8. 创意点、订单、支付、模型用量、成本、退款和权益全链路可审计。
9. 所有业务模型请求必须经过大麦自有模型中转站，并保留真实鉴权、请求、用量、成本和错误证据。

### 2.2 非目标

- 不在插件中让商家配置第三方模型 API Key。
- 不在商家后台暴露平台模型供应商成本、内部加价倍率或运营 Token。
- 不用本地 fixture、模拟店铺或前端状态冒充生产支付、授权、生成或发布成功。
- 不允许插件绕过服务端权限、RLS、商业准入、规则门禁或发布确认。
- 不把 ChatGPT 宿主模型替换成大麦业务模型；宿主模型和大麦业务模型是两层边界。

## 3. 用户与角色

### 3.1 商家 Owner/管理员

- 自助注册后等待平台审核，或通过可选邀请入口完成同一注册流程；随后登录商家后台和 ChatGPT App。
- 绑定平台店铺、导入商品、维护品牌和知识资料。
- 查看创意点和商家侧消费账单。
- 审核生成内容、选择素材、确认发布。

### 3.2 商家成员

- 只能访问被授予的 Workspace 和能力。
- 可以被限制为只读、内容编辑、审核或发布角色。
- 不能修改平台全局规则、模型、支付密钥或其他租户数据。

### 3.3 平台运营

- 审核商家注册与企业绑定。
- 配置套餐、点数包、平台规则、模型能力、支付和发布 readiness。
- 处理支付对账、退款、点数调整、服务履约和事故恢复。
- 只有在 platform scope、角色和审计条件满足时才能跨租户读取。

### 3.4 系统角色

- API/MCP：唯一业务事实和准入边界。
- Worker：异步解析、embedding、扫描、模型执行、发布和重试。
- 大麦模型中转站：唯一业务模型出口，负责供应商适配、鉴权、限流和用量/成本回执。
- 支付服务商：微信/支付宝 checkout 和签名回调来源。
- 电商平台：官方 OAuth、商品数据和发布回执来源。

## 4. 端到端主流程

```text
ChatGPT App 市场安装
  → 商家注册/登录
  → 创建 pending 商家主体
  → 平台运营审核并绑定企业
  → 订单经真实支付回调或受审计的线下到账核验完成
  → 创建 Workspace Owner、套餐和创意点权益
  → 商家登录商家后台
  → 官方平台 OAuth 绑定店铺
  → 商品同步或 Excel 导入
  → 解析、去重、事实确认，并在目标架构中建立知识索引
  → 安全/权益/平台规则扫描
  → ChatGPT 按商品名检索知识
  → 生成主图/详情页/视频
  → 内容审核与选图
  → 发布预览和二次确认
  → worker 写入平台并接收回执
  → 商家查看结果、下载和创意点消费
```

任何一步缺少真实事实时，必须返回阻断状态和下一步，不能用空数组、默认值或模拟成功替代。

## 5. 身份、注册与开通

### 5.1 安装后首次体验

1. 用户在 ChatGPT App 市场搜索“大麦商家营销”。
2. 点击安装后打开插件，插件显示“大麦账号注册/登录”。
3. 插件跳转大麦账号授权页，用户在大麦页面输入账号和密码；密码不进入 ChatGPT、插件参数或模型。OAuth/MCP authorization code 仅是宿主协议。
4. 注册完成后创建 `merchant_pending` 申请和待绑定身份。
5. 插件提示“账号已提交平台审核”，不提前显示生成或发布权限。

### 5.2 平台审核

平台运营审核申请并填写：

- 企业名称和企业主体标识；
- 申请人身份；
- 合同/订单引用；
- 套餐与点数包；
- 生效时间和到期时间；
- 审核原因与证据。

状态机：

```text
merchant_pending
  → platform_review
  → enterprise_bound
  → payment_pending
  → payment_reconciled
  → entitlement_granted
  → active
  → suspended / revoked / refunded
```

角色变更不是收入确认；权限是已审核权益的投影。

### 5.3 登录边界

- 正式用户可见登录：大麦账号 + 密码；平台运营和商家后台均使用该方式。
- ChatGPT App 仍通过标准 OAuth/MCP authorization code 让宿主获得受限 token，但登录页由大麦提供，密码不被宿主获取。
- 平台运营账号由 Owner 预置/邀请，不开放公开注册；商家可自助注册，注册后由平台运营绑定企业并开通权益。
- 本机 API 自动连接、Bearer Token 表单、企业 SSO/OIDC 直登和 fixture 登录只允许 development/test，生产 UI 不得展示。

## 6. 企业、订单、权限和创意点

### 6.1 权益模型

```text
企业/合同
  → 商业订单快照
  → 支付服务商回执
  → 对账通过
  → entitlement
  → creative_points ledger
  → capability decision
```

每次授予必须记录：`workspace_id`、`order_id`、`entitlement_id`、`points`、`effective_at`、`expires_at`、`revision`、`actor`、`evidence_ref` 和幂等键。

### 6.2 计费规则

- 生成前预留创意点。
- provider 成功且收到用量证据后结算。
- provider 失败释放预留。
- 结果记录失败进入 `settlement_pending`，不得重复调用或重复扣点。
- 余额未知时显示 unknown，不得当作 0 或可用。
- 退款、撤销和人工调整必须有原因、审批和审计。

### 6.3 商家侧账单

商家只看到：

- 可用创意点；
- 冻结创意点；
- 已消耗创意点；
- 充值订单状态；
- 消费时间和业务用途；
- 账期与余额变更。

插件不显示单次模型内部成本、供应商名称、加价倍率或平台收入。

### 6.4 平台侧账务

平台可查看：

- 合同金额、订单金额、支付渠道；
- provider 订单号和签名回调；
- 应收、已收、对账、退款和发票状态；
- 授予的套餐、权益、创意点；
- provider 用量和成本；
- 收入确认状态；
- 退款后的权益回收和审计链。

“开通权限意味着 5000 元收入”不得作为系统规则。5000 元只有在合同、支付结算、对账和适用的收入确认政策都满足后才进入财务确认；订阅服务应按服务期间处理递延确认。

## 7. 店铺授权与商品数据

### 7.1 官方 OAuth

商家在商家后台选择平台和店铺，调用 `platform.connect`：

1. 服务端先检查平台配置和凭据存储能力。
2. 创建绑定 Workspace/platform 的一次性 state 和 PKCE。
3. 跳转官方平台授权页。
4. 回调消费 state，交换 code，并把凭据写入 Vault/凭据服务。
5. 只保存 `credential_ref` 和脱敏授权摘要。
6. 返回 `account_id`、scope、token 状态和同步能力，不返回 token。

fixture 授权必须明确标注 `simulated=true`，生产环境禁止把它当成真实授权证据。

### 7.2 店铺与数据边界

所有店铺级请求必须携带并校验：

```text
workspace_id + platform + account_id
```

禁止默认使用列表第一家店铺。撤权、过期、只读或多候选时必须明确提示并阻断写入。

### 7.3 商品同步

同步任务必须记录：授权 revision、请求快照、平台回执、分页游标、最后成功时间、失败原因和数据版本。同步失败时保留旧事实，但标记 freshness，不得把旧数据说成当前实时数据。

## 8. Excel 批量导入与知识库

### 8.1 支持字段

- 商品名称、商品编码、类目；
- SKU 编码、颜色、尺码、规格；
- 价格、库存、材质、卖点、禁用词；
- 图片/视频引用；
- 平台与店铺归属；
- 品牌、详情页和品类扩展字段。

### 8.2 异步导入流程

```text
上传文件
  → 对象存储隔离区
  → 文件类型/大小/病毒扫描
  → 解析任务
  → 表头和字段校验
  → 商品/SKU 去重与关联
  → 人工确认错误与事实
  → 商品事实持久化
  → 文本切片和 embedding
  → 知识索引写入
  → 规则扫描
  → 导入报告
```

以上“切片/embedding/知识索引”是目标验收流程，不代表当前仓库已有持久向量库。当前实现主要是商品事实 + 进程内知识投影 + `knowledge_hydration_snapshots` 事件恢复；正式商用前必须新增持久 documents/chunks/embedding 存储、RLS、索引状态和重建/删除证据，并把确认后的商品字段/素材显式绑定为知识资产。

浏览器只提交文件和任务参数，不在前端一次性处理大文件。默认限制和配额由平台配置，超限时返回可恢复任务，不丢失原文件。

导入报告必须包含成功、失败、重复、缺字段、图片失效、SKU 冲突和规则阻断明细，并提供错误行下载。

### 8.3 向量数据约束

每条知识索引至少包含：

```text
workspace_id
product_id
sku_id
source_asset_id
source_version
knowledge_type
embedding_model
embedding_version
rule_snapshot_version
rights_status
approved_at
```

检索顺序必须是：

```text
Workspace/RLS 过滤
  → 商品/SKU/平台范围过滤
  → rights_status=cleared 和 approved 过滤
  → 向量相似度排序
  → 返回来源和版本
```

不得先跨租户做相似度搜索再过滤。

## 9. 自动规则扫描

扫描对象包括商品事实、SKU、图片、视频、详情页和生成提示词。规则域至少包括：

- 广告法禁词和夸大宣传；
- 平台广告与发布规则；
- 促销、价格和优惠表达；
- 品类禁限售与特殊资质；
- 素材版权、肖像和 AI 修改许可；
- 平台媒体规格和字段映射。

每次扫描输出：

```text
scan_id
workspace_id
product_id / sku_id
platform / account_id
rule_source_version
policy_checksum
findings[]
blocking / warning / pass
evidence_refs[]
expires_at
```

规则版本变化、商品事实变化、SKU 变化或目标平台变化后，旧结论自动失效。`blocking` 时禁止批准、生成或发布；`warning` 必须在审核界面显式展示。

## 10. ChatGPT 知识检索与生成

### 10.1 商品名称检索

用户输入商品名称后：

1. 插件确认当前身份和 Workspace。
2. 对同名商品列出平台、店铺、商品编码和 SKU 供选择。
3. 调用 `catalog.search`，固定当前 Workspace 和商品/SKU 范围。
4. 返回商品事实、SKU、材质、卖点、素材来源、知识版本和规则版本。
5. 缺少事实时提示补充或回到商家后台，不得编造。

### 10.2 生成前置

正式生成前必须满足：

- 商品/SKU 已明确；
- 商品事实版本已确认；
- 知识资产有来源、权限和 approved 状态；
- 素材安全扫描通过；
- AI 修改和商用权益允许；
- 平台规则预检无 blocking；
- 创意点余额可用并完成预留；
- 模型中转 readiness、成本证据和 provider 通道可用；
- 生成请求有幂等键和 action 记录。

### 10.3 生成结果

生成结果必须标记：

- `draft / review_required / approved / rejected`；
- 使用的商品、SKU、素材和知识版本；
- 模型中转 request id、用量和成本证据引用；
- 安全扫描状态；
- 可下载状态；
- 发布资格和下一步。

生成的图片和视频先进入隔离区，扫描通过后才可交付或发布。

## 11. 大麦自有模型中转站硬约束

### 11.1 唯一出口

所有大麦业务模型调用必须经过大麦自有中转站：

- 文案/文本生成；
- 主图生成；
- 图片编辑；
- OCR/图片事实提取；
- 视频脚本、分镜和视频渲染；
- embedding/向量化（若由模型服务执行）。

应用服务、插件 bridge、商家浏览器和 worker 不得直接访问 OpenAI、Anthropic、Gemini、供应商原生 endpoint 或第三方模型 API。

这条约束适用于所有正式商家业务环境（pilot、staging、preview、production）。development/test 可以保留依赖注入的 deterministic fixture 供自动化测试，但任何 fixture 结果都必须标记 `simulated=true`、`provider_executed=false`，不能进入商家真实账本、发布回执或上线证据。若环境需要真实业务产物，必须配置并调用大麦中转站；不存在“先用宿主模型生成、之后再补 relay 证据”的过渡路径。

### 11.2 大麦中转站职责

- 供应商凭据托管和轮换；
- 模型路由和版本控制；
- Workspace/action/run 关联；
- 内容安全和数据处理策略；
- 限流、超时、重试和熔断；
- provider request id；
- token/image/video 用量；
- 实际成本、价格快照和币种换算；
- 错误分类和可审计回执。

### 11.3 应用侧硬门禁

生产环境必须同时满足：

```text
MODEL_RELAY_BASE_URL 为 HTTPS
  AND host 在 allowlist
  AND 大麦 relay API key 可用
  AND 对应 modality model 已配置
  AND usage/cost evidence 可验证
  AND provider request id 可关联
```

任意条件不满足时返回 `MODEL_RELAY_NOT_CONFIGURED`、`MODEL_RELAY_EVIDENCE_REQUIRED` 或具体阻断码，禁止 fallback 到本地规则、fixture 或直连供应商。

### 11.4 宿主模型边界

ChatGPT 自身的对话编排模型由 ChatGPT 宿主管理，插件无法拦截或替换宿主模型请求。大麦硬约束适用于所有“大麦业务能力”调用；业务模型不得出现在 ChatGPT 模型选择器中，也不得要求商家提供个人模型 Key。

因此产品文案必须始终区分两层：ChatGPT 宿主模型负责理解对话和选择工具；大麦自有中转站负责所有商品业务模型调用和计量。宿主模型生成的自然语言建议不能被记录为大麦模型产物，也不能触发点数结算或发布。

### 11.5 relay 调用契约

每次业务模型调用必须携带：

```text
workspace_id
action_id
run_key
modality
model
request_id / idempotency_key
data_policy_version
```

中转回执必须能被服务端验证并写入 usage ledger；没有真实回执时结果不得交付、不得结算、不得宣称完成。

## 12. 审核、下载与一键发布

### 12.1 审核

商家后台必须展示：

- 商品/SKU 事实来源；
- 使用的知识、素材和版本；
- 规则扫描 findings；
- 图片/视频安全状态；
- 生成版本和差异；
- 需要人工确认的字段。

### 12.2 下载

下载只允许已归档、扫描通过且当前 Workspace 有权限的资源。下载链接应短期、带范围校验并记录审计。下载成功不等于已发布。

### 12.3 一键发布

“一键发布”实际执行：

```text
publish.prepare
  → 商品/SKU/媒体字段校验
  → 规则和授权复核
  → 远端商品快照确认
  → 商家明确二次确认
  → publish.confirm
  → worker 执行
  → 平台回执
  → delivered / failed / unknown
```

`unknown` 只能进入人工对账，不能改写为成功。每个目标必须保持 `platform + account_id + product_id` 独立状态；批量发布一个目标失败不能伪装成整批成功。

## 13. 商家后台信息架构

1. **首页/开通状态**：账号、企业、套餐、创意点、店铺、知识库、模型和发布 readiness。
2. **平台连接**：平台和店铺 OAuth、授权范围、同步状态和重新授权。
3. **商品与 SKU**：同步商品、Excel 导入、事实确认、SKU 关系。
4. **知识库与素材**：上传、扫描、规则结果、版本、权益和向量索引状态。
5. **任务与生成**：主图、详情页、视频、批量任务、失败重试。
6. **审核与发布**：差异、规则阻断、选图、预览、确认和回执。
7. **钱包与账单**：只显示创意点余额、冻结、消耗和订单状态。
8. **成员与权限**：成员、角色、邀请、停用和 Workspace 范围。

## 14. 平台运营后台信息架构

1. **商家与企业**：注册申请、企业绑定、Owner、状态和审批证据。
2. **商业目录**：套餐、点数包、Add-on、优惠、灰度和版本。
3. **订单与支付**：checkout、回调、对账、退款、发票和异常。
4. **权益与点数**：授予、冻结、结算、调整、回收和双人审批。
5. **平台连接治理**：六平台 OAuth readiness、API、媒体规格和发布适配器。
6. **规则中心**：规则来源、同步、审批、版本、checksum 和扫描覆盖。
7. **模型中转治理**：五模态 readiness、调用、用量、成本和错误证据。
8. **知识与扫描治理**：队列、ClamAV、embedding、失败任务和重试。
9. **发布与事故**：发布任务、平台回执、unknown 对账、告警和恢复。
10. **审计**：跨租户操作、授权、账务、模型、规则和发布事件。

运营后台不得把“连接诊断”“本机 API”“fixture”展示给生产商家，也不得让普通运营人员编辑密钥。

## 15. 关键接口契约

### 身份与开通

- `workspace.bootstrap`
- `auth.login / auth.callback`
- `merchant.registration.create`
- `ops.merchant.review`
- `ops.enterprise.bind`
- `ops.entitlement.grant`

### 店铺与商品

- `platform.connect`
- `platform.store.list`
- `catalog.sync.start / catalog.sync.get`
- `catalog.search`
- `catalog.import.batch`
- `catalog.sku.list`

### 知识与规则

- `knowledge.asset.upload/list`
- `knowledge.rule.list`
- `knowledge.learning.list`
- `knowledge.index.status`
- `platform.rule.preflight`
- `platform.mapping.preflight`

### 生成与发布

- `catalog.image.generate / catalog.image.get`
- `multimodal.image.edit`
- `multimodal.video.request / multimodal.video.get`
- `content.review / content.approve`
- `publish.prepare / publish.confirm`
- `publish.batch.prepare / publish.batch.confirm`

### 商业与账务

- `commercial.catalog.get`
- `commercial.order.create`
- `commercial.order.payment.get`
- `billing.status`
- `creative-points.balance.get`
- `creative-points.statement.list`
- `ops.commercial.order.payment.verify`
- `ops.commercial.refund.*`

正式充值只允许购买平台发布的创意点 SKU。客户端不得传入任意金额、点数、价格或权益。

## 16. 验收标准

### P0 端到端验收

- ChatGPT App 市场真实安装并能启动。
- 首次打开进入大麦账号密码注册/登录；OAuth/MCP 只作为宿主授权协议，不出现本机 API 配置。
- 注册申请能在平台后台审核、绑定企业并开通权益。
- 支付仅在真实 provider 签名回调后授予权益和创意点。
- 商家完成官方平台 OAuth 后才能读取对应店铺数据。
- Excel 导入 1 条、1000 条和错误混合数据均有可下载报告。
- 向量检索不会跨 Workspace、商品或 SKU 泄漏。
- 商品名称检索能返回正确商品、SKU、材质、来源和版本。
- 规则阻断时生成和发布均停止，并显示具体 finding。
- 文案、图片、编辑、OCR、视频全部产生大麦 relay request/usage/cost 证据。
- relay 缺失或证据缺失时不调用供应商、不交付结果、不扣点。
- 生成结果可下载，且只有审核通过和发布确认后才能发布。
- 一键发布能获得真实平台回执；unknown 不得标记成功。
- 商家后台只看到创意点余额和消费明细；插件只显示余额是否足够、支付/任务状态和充值恢复动作，不显示实际扣点、费率或供应商成本；平台能看到订单、成本、退款和收入证据。

### P1 验收

- 多店铺、多成员、停用成员和撤销授权隔离。
- 批量生成/发布可暂停、恢复和幂等重试。
- 规则版本、商品版本、知识版本变化会使旧任务失效或要求重审。
- 生成和发布页面列表每页 20 条，显示总数、加载状态和边界状态。
- 生产配置缺失时后台显示阻断原因和管理员下一步。

以上是目标验收标准；当前是否完成以总文档 §17、§24–§25 和本次运行证据为准。视觉上显示 20 行不等于已完成服务端分页。

## 17. 性能与可靠性要求

本节是目标要求，不表示当前所有列表、向量索引或异步链路已经完成。

- 大文件导入、embedding、扫描、生成和发布全部异步化。
- 列表 API 默认服务端分页，桌面端每页 20 条；游标接口必须返回 `next_cursor` 和快照时间。
- 向量检索必须先做租户/商品过滤，再执行相似度排序。
- 模型请求必须有超时、限流、指数退避、幂等和熔断。
- 批量任务设置 Workspace、平台和模态级并发配额。
- 所有异步 worker 在执行前重新检查授权、规则、素材、商业和 relay readiness。
- 结果写入与点数结算使用可重放的 immutable receipt，不依赖前端重试。

## 18. 安全与隐私要求

- OAuth state/PKCE/nonce 一次性消费并绑定 Workspace/platform。
- 凭据只存 Vault/凭据服务，API、插件和模型上下文不返回 token。
- API、RLS、worker 三层重复验证 Workspace scope。
- 大麦 relay 是唯一业务模型出口，外部供应商密钥只在 relay 侧存在。
- 上传文件先隔离和扫描，隔离文件不可被模型或下载接口读取。
- 日志脱敏，不记录密码、token、原始支付签名或不必要的商品隐私数据。
- 商家导出、下载、批量发布、点数调整、退款和权限变更全部审计。

## 19. 上线门禁

以下任一项未通过，生产保持 NO-GO：

- ChatGPT App Host/marketplace 安装证据；
- 生产账号密码认证、ChatGPT authorization code 和宿主回调证据；
- 六平台真实 OAuth、API 和发布 canary；
- 微信/支付宝真实 checkout、签名回调和对账；
- 大麦 relay 五模态真实鉴权、用量和成本证据；
- PostgreSQL/RLS、Redis、Vault、对象存储和 KMS；
- ClamAV/扫描 worker 与告警；
- 生产规则来源、版本、checksum 和审批；
- 备份恢复、并发容量、故障演练和发布签名；
- merchant、ops、API/MCP、worker 的 E2E 和跨租户隔离测试。

本地 fixture 只能用于开发与演示，必须在界面、响应和测试报告中明确标识，不能作为上线证据。

中转证据必须带有当前 release 标识、provider request id、usage、cost、pricing/rate 版本、观察时间和不可变 artifact digest，并在 `expires_at` 后重新执行五模态 canary。历史探针即使曾经成功，也不能替代当前 release 的有效证据。

## 20. 当前仓库对照结论

仓库已经具备较多基础：MCP bridge、Workspace scope、有界/词法知识上下文、素材扫描、创意点预留/结算、图片/视频生成、发布预览和运营账务读模型。持久向量检索仍是待实现目标。现有模型适配器也已经以 `MODEL_RELAY_BASE_URL`、allowlist、provider request id、usage/cost evidence 和 fail-closed 门禁为主线。

仍必须在正式商用前补齐或验证：

1. ChatGPT App 市场真实安装和 OAuth 宿主证据；
2. 商家注册申请、企业绑定、审核、权益开通的完整状态机；
3. 微信/支付宝真实支付到权益授予的闭环；
4. 六平台真实 OAuth/API/canary，而不是 fixture 连接；
5. Excel 大批量异步导入、embedding 索引和错误报告；
6. 规则来源和自动扫描的生产数据；
7. 五模态 relay 的生产证据与供应商数据处理协议；
8. 发布适配器、真实平台回执和 unknown 对账；
9. 生产配置、容量、备份、告警和发布门禁。

这份 PRD 与 `docs/plugin-chain-audit.md`、`apps/plugin/README.md`、商业执行规格和生产 readiness 文档共同构成评审基线；若实现与本 PRD 冲突，以服务端事实、权限和安全门禁优先。
