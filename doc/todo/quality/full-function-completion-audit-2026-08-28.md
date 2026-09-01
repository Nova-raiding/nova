# 全功能完成度审计（2026-08-28）

更新：2026-08-29 源码/契约对账。

## 当前结论

**本地集成环境可运行，但尚未达到生产上线标准。** 结论按“实现存在、契约存在、自动化测试、真实运行观察、外部生产证明”五层证据判定；源码中出现方法名或页面控件不计为功能通过。

本轮完成 Merchant URL 路由、任务恢复与创建幂等，并将充值、撤销连接、商品导入、任务组确认、主图检查、素材权益/事实和标题修改全部改为结构化交互；正式 Docker 端口上的完整浏览器矩阵已通过。

## 权威范围

| 表面 | 权威数量 | 当前证据 |
| --- | ---: | --- |
| MCP 方法 | 217 | 217/217 个唯一方法进入契约注册表；商家 bridge 当前暴露 147 个非 `ops.*` 工具。服务端/bridge 一致性由契约测试覆盖，外部平台/支付/模型回执仍需生产 canary |
| 运营后台 | 12 个一级域 | `overview/users/members/support/incidents/tasks/stores/rules/models/feature-flags/finance/audit` 均有独立路由与角色可见性；本地桌面全域深链与写操作通过；移动视口仅保留为无障碍回归，不属于产品范围，生产 OIDC/规模证据仍缺失 |
| 商家工作台 | 5 个主导航页及多个任务/发布弹层 | 45 项 Merchant 浏览器回归通过；外部平台写入仍不计为通过 |
| 外部生产能力 | 模型、六平台、支付、对象存储、部署信任链 | 本地真实五模态中转已通过；生产门禁仍为 NO-GO，缺生产 Secret、平台/支付凭据和外部控制面证明 |

## 已证实的真实运行证据

- 单元/集成回归：最新实现状态记录为 244 个测试文件通过、7 个文件跳过；1,647 个测试通过、15 个跳过。该数字必须由发布时固定命令重新生成，历史回归数字不得覆盖当前基线。
- 浏览器回归：当前矩阵 92 个场景；修复后已重新执行完整单命令回归，92/92 通过。
- 运营用户目录：真实 Postgres/API 数据渲染、`support_demo` 详情抽屉、关闭后筛选空结果均已用 shot-scraper 实际操作。
- 交互录像：`dogfood/chatgpt-all-functions/screenshots/verify-feature/ops-user-detail.webm` 和 `.mp4`。
- 关键帧：`ops-user-detail-open.png`、`ops-users-empty-filter.png`、`ops-users-form-fixed.png`。
- CodeGraph：已同步并确认 up to date，当前索引数字见最新 implementation-status；本轮源码同步由 CodeGraph 最终状态确认。
- 宿主 Codex 已通过同一中转站真实返回 `RELAY_OK`；文本、图片、图片编辑、OCR、视频五模态 canary 均取得 HTTP 200、provider/task ID、请求侧 usage 证据和版本化人民币成本快照；视频后续状态为 `succeeded` 且返回 HTTPS 成片。综合证据统一绑定 `local-owner-20260828-r3`；视频任务最初由 r2 创建并在 r3 复用查询，来源 release 单独保留。证据见 `dogfood/chatgpt-all-functions/model-relay-canary-live.json` 与 `video-relay-status-live.json`。

## MCP 逐方法运行态闭环

权威 `MCP_METHODS` 与 `MCP_METHOD_CONTRACTS` 已在运行时读取：217 个方法、217 个契约、217 个唯一名称；商家 bridge 当前暴露 147 个非 `ops.*` 工具。新增范围包含品/批量营销、支持工单、事故、feature flag、财务与审计等运营方法；该结论只证明源码契约面，不替代六平台、支付或模型中转的生产回执。

## 已确认的本地缺口

### P0

1. 模型真实成本审计发现 5 秒视频报价为 ¥544.265625。视频适配器和 provider canary 已验证，但默认商业配置必须由单请求成本门禁保持禁用；在获得可接受的模型价格、套餐定价和累计预算执法证据前，不得向商户宣称视频渲染可用。
2. 生产 P0 仍包括外部平台、支付、存储、托管 Secret 和部署信任证据缺失；本地资金账本、累计模型预算和 Kubernetes 发布合同正在按本审计发现继续收口。

### P1

1. Ops 已形成 12 个独立一级域，支持工单与受限 CRM 投影导出方法已进入契约，本地全域浏览器矩阵已验证；仍需以真实 OIDC、生产数据量和正式环境运行证明其上线质量。上线范围固定为支持工单所需的受限客户投影，跨租户 CDP/360° CRM 不纳入本次发布。

## 本轮已修复并验证

- 商家任务事实区不再混入硬编码规则、方向或虚假进度；API 缺失数据明确空态。
- `platform.revoke`、`platform.store.alias.set` 和 `billing.export` 已增加服务端角色/租户门禁，95 个安全定向测试通过。
- Ops 账单导出、模型结算的 UI 权限矩阵与服务端一致。
- OpenAPI `method.enum` 结构和两个 bridge 的 5 处参数漂移已修复，并用真实 stdio `tools/call` 请求验证。
- 最终发布浏览器正向、500、超时、双击和重放全部通过；真实 job ID、账号、确认哈希、远端快照哈希和稳定幂等键形成同一证据链，失败不误报成功。
- 工作区信息与任务历史弹窗已通过真实 Chrome 键盘回归：焦点进入、背景 inert、Tab 圈闭、Escape 关闭和焦点回归。
- Ops 店铺切换会加载并隔离 automation scope；筛选清空发送空参数；身份/风险/会话超时重试复用同一操作幂等键。
- Ops 导航已扩展为 12 个一级域，并将成员与权限从用户页拆成独立 `/ops/members`；路由、角色可见性、query 保留和旧 hash 兼容已有自动化契约，全域深链 14/14、用户与删除 6/6、成员生命周期 1/1、规则生命周期与独立审批浏览器用例通过。
- 发布中心后台刷新失败不再隐藏旧成功数据；恢复后更新列表并清除警告，浏览器回归通过。
- 任务反馈与时间线读取失败不再伪装成空数据；两者独立告警、保留旧记录并可独立重试，专项浏览器回归通过。
- 内容审核风险接受不再使用原生 prompt：短理由不发请求，500 保留输入可重试，成功后展示原样审计理由，专项浏览器回归通过。
- Ops 数据删除审批/取消改为必须填写具体原因的结构化 Modal，失败保留输入；批量发布支持安全暂停、恢复及带新确认哈希/幂等键的失败项重试，浏览器正反回归 4/4 通过。
- Merchant 五个一级页面、商品搜索和任务地址均支持 URL 深链、刷新、pushState、前进/后退与焦点恢复；任务地址只保存稳定 ID，并从服务端恢复商品/店铺权威身份。
- 新任务创建使用 URL intent 与服务端幂等键；重复请求返回同一任务，复用键但改变意图返回 409，刷新不会重复创建任务。
- Merchant 源码中的原生 `prompt/confirm/alert` 已归零；10 条结构化交互浏览器用例覆盖字段校验、取消零写入、500 保留输入、加载隔离、分页和成功关闭。
- 素材、品牌档案和存储健康改为独立加载与独立重试；品牌/health 同时失败时仍展示并允许操作素材元数据。
- 商品列表已实现真实分页及筛选复位；详情预览的颜色/尺码具备可点击选中状态与 `aria-pressed` 语义。
- 图片局部编辑已提供独立 MCP App 资源：可拖拽创建/移动归一化区域，使用方向键及组合键调整位置/尺寸，区分可编辑、不可修改与冲突覆盖，并保持原图不覆盖、只创建候选；宿主不可用时保留可复制请求 JSON。该交互与 bridge/multimodal 契约已有自动化验证，生产图片 provider 仍受外部门禁。
- 品牌隔离已覆盖商品/任务列表、商品详情、图片审核、任务创建及通用 MCP 商品/任务访问；受限成员只获得其品牌授权对应的 canonical product/task。数据库基础 RLS 仍以 workspace 为边界，品牌级授权由 API 与仓储查询共同执行，因此生产验收必须保留越权探针，不能把 workspace RLS 描述成品牌 RLS。
- 平台 feature flag 控制面已从租户运行凭据拆出：生产强制不同的 `DATABASE_URL`/`OPS_DATABASE_URL`，`merchant_app` 无控制面表权限，`merchant_ops` 可访问 feature flag 但不能访问 tenant tables；本地角色/ACL 探针已通过，云数据库角色仍需生产证据。
- PostgreSQL 迁移链已到 078。060 使用 `CREATE INDEX CONCURRENTLY`，062 使用 `DROP INDEX CONCURRENTLY` 清理重复索引；两者标记 `migrate:no-transaction`。063–077 补齐 listing 组合完整性、身份 bootstrap、素材解析租约、平台媒体规格和字段映射审批、campaign ACL、legacy 平台/店铺作用域、商品素材完整性、Ops 数据契约、模型用量上下文及 canonical 发布作用域；078 补齐后到达素材快照对应的同工作区商品素材关系。本地数据库应用证据须以实际 078 链尾运行记录为准；正式大表锁等待、触发器耗时、失败恢复和副本延迟仍需预生产观测。
- 只读“工作区设置”已更名为“工作区信息”，明确不会在浏览器内修改 Secret 或生产权限。
- 修复模型中转真实合同：图片生成/编辑切换到实测可用的 `qwen-image-3.0` 与 `/images/generations`，视频请求增加按时长计费必需的 `duration`，状态查询统一为 `GET /video/generations/{job_id}`；当前文本 canary 有成本证据，图片/编辑/OCR/视频仍受中转站 SVIP 计价组门禁，不能标记为生产可售。
- Docker buildx v0.36.1 已从官方摘要校验通过的 Homebrew bottle 安装，BuildKit v0.30.0 可用；arm64+amd64 无网络 OCI smoke 生成 manifest digest `sha256:9baeec957e91978671cf452e6209778dc0e88bd6def0d9d907d38843e2db7437`，生产 doctor 的 buildx 与宿主 Relay 门禁均已转绿。

### P2

1. 当前已识别的本地 P2 已闭环；运营 Token、商品分页/规格选择及只读工作区信息均已用 Chromium 复验。

## 生产 NO-GO 外部条件

- 业务 Relay 与宿主 Codex 已通过同一安全环境恢复，并完成本地 release-bound 五模态/成本证据；仍缺托管生产 Secret、正式 release 绑定和生产控制面签署。
- 京东、拼多多、淘宝、天猫、抖音、小红书官方 sandbox/production 凭据与 canary。
- 真实支付商户、退款、查询和对账。
- S3 versioning/lifecycle/KMS、数据库 PITR、告警、容量和 Worker OIDC。
- 正式环境在固定路径 `/run/release-security/evidence-trust` 配置 root 管理的 Ed25519 公钥、key ID、公钥指纹和 nonce consumer 摘要；在固定路径 `/usr/local/libexec/merchant/consume-production-evidence-nonce` 与 `/usr/local/libexec/merchant/attest-capability-evidence` 配置受保护执行器，并完成跨 runner 原子消费和签名演练。
- 发布证据链的代码门禁已闭环：deploy preflight 强制 capability `--require-signed-production` 并绑定 release/image-set/manifest/Git/nonce；部署后验证 `/releasez`、认证数据库业务路径和六平台签名 canary；rollback 强制签名 known-good bundle、不可变 artifact 与资源 kind 限制；生产恢复强制签名 backup attestation。当前 NO-GO 原因是这些固定控制面和签名 artifacts 尚未在真实生产 release 中配置、签署和演练，不是上述代码路径未实现。

在这些条件完成前，任何“可以上线”结论都属于超出证据。
# 当前校正（2026-08-29）

本报告中的历史本地五模态 canary 记录不等于当前生产可售证据。当前权威运行状态显示媒体 SVIP 计价组仍有门禁；文本有成本证据，图片、图片编辑、OCR、视频不得标记为生产可售。数据库迁移链已推进至 073；本地数据库应用和真实生产数据库应用必须分别提供证据。下文历史记录按原时间点保留，当前上线判断以本校正和实时 healthz 为准。
