# CodeGraph 上线差距复核（2026-09-16）

范围：ChatGPT 插件入口 → MCP/API → 中转模型 → 商家与桌面运营工作流 → PostgreSQL/RLS、worker、OSS、支付与 ECS 发布门禁。此表区分代码存在、隔离验收和现网运行，不把健康接口 `ok` 当成生产 GO。

## 当前判定

**NO-GO。** CodeGraph 1.5.0 已同步当前工作区，索引 1,440 文件、20,420 节点、78,023 边。`npm run audit:ops-surface` 得到 140 个 API 契约方法与 140 个前端引用，零未引用；隔离 PostgreSQL 验收 23 文件、24 项通过，无跳过。此前当前工作区类型检查、发布门禁 611 项通过。以上是源码与隔离环境证据。现网 `/api/releasez` 返回 `ready:false` 且四个 release 字段为空；`/api/readyz` 为 fixture/local、平台写入关闭、生产门禁 false；ECS 数据库迁移最高 209，源码最高 213。

| 优先级 | 缺口 | CodeGraph/源码证据 | ECS/真实证据 | 达标条件 |
|---|---|---|---|---|
| P0 | 最终版本、镜像和迁移绑定 | `productionReleaseMetadataReadiness` 要求 release ID、Git SHA、manifest/image-set 摘要及 bundle 版本；`deploy-preflight-ecs.sh` 要求干净工作树和容器源码新鲜度 | `/api/releasez` 四字段为空；数据库只到 209，当前源码到 213；工作树仍有大量未固化变更 | 固化经审阅的版本，构建不可变 API/worker/UI 镜像，在隔离候选完成 210–213 迁移和 RLS 验收，再以相同摘要切换 ECS。 |
| P0 | ChatGPT OAuth 与真实插件会话 | `mcpOAuthClients` 要求真实 client ID 与精确 redirect allowlist；MCP token 存储、工作区绑定和 PKCE 路径已有测试 | `MCP_OAUTH_CLIENTS` 不在运行 API 环境，`MCP_OAUTH_REQUIRED` 非 true；线上 metadata 缺 `token_endpoint_auth_methods_supported`，本地修复未部署 | 从 ChatGPT 管理页取得真实 ID/回调，写入 ECS Secret，部署修复，真实 ChatGPT 完成授权码、换 token、只读工具、撤权及跨租户拒绝验收。 |
| P0 | 六平台官方链路 | `runPlatformCanary`、connector API 与 evidence gate 有代码，但现有 runner 因只构造 OAuth URL、缺逐能力负面探测/协议证据而在任何服务商 I/O 前阻断 | 六平台 `fixture_ready`，`CONNECTOR_FIXTURE_MODE=true`，凭据 provider 未配置，写入关闭 | 配置官方 OAuth/API、Vault/外部凭据；实现实际 token exchange、负面路径与服务商 transcript；每平台受控测试店完成授权、同步、媒体、创建/更新/查状态/撤权并保留真实证据。当前全六平台承诺的 release gate 不可用 fixture 降级。 |
| P0 | 知识索引生命周期 | `projectImportedProductsToKnowledge` 建文档/chunk 后保持 pending/unknown/queued；CodeGraph 的 `upsertEmbedding` 和 `transitionIndexState` 调用者只有测试，未找到生产 worker；PostgreSQL `search` 只接受 ready、approved、cleared | 尚无当前 ECS 版本的导入→审批→权益确认→索引→跨副本插件检索验收 | 接通受控索引 worker 或明确缩小知识检索承诺，并在最终版本证明重启、跨副本、租户隔离和已审批知识可被商家任务消费。 |
| P0 | 签名信任与发布证据 | ECS preflight 需要 capability、capacity、relay、Codex host、OSS、canonical cutover、payment、restore、manifest 文件及独立公钥/attester/nonce | `/run/release-evidence` 不存在；信任目录仅 nonce consumer 摘要，公钥/key ID/fingerprint/attester 摘要和受保护 attester 均缺 | 独立 provision 真正签名边界，生成绑定最终 release/镜像/nonce 的真实证据并逐项通过固定 trust gate；不得复制测试证据。 |
| P0 | OSS 运行时切换与回滚 | `LocalObjectStorage`、`S3CompatibleObjectStorage` 均实现，ECS overlay 有 RAM Role；控制面版本、生命周期、公网阻断和 4 个对象复制/回读已验证 | 现网对象存储仍是 `local`；开发模式覆盖会选择本地实现 | 最终镜像在生产模式对 OSS 真正读/写/扫描/签名展示，核对 4 个迁移对象与新增对象，保留本地卷作为可恢复回滚点，并形成 release-bound storage 证据。 |
| P0 | 支付与五模态中转当前版本证据 | `HttpPaymentProvider`、支付回调/对账和 `emitRelayUsage` 有 fail-closed 实现；隔离数据库支付幂等通过 | 健康接口支付 `configured:true`，中转五模态 `ready:true`；但 `/run/release-evidence` 为空，不能证明当前版本的真实退款、实际用量/成本 | 一笔受控真实小额支付贯通签名回调、查单、到账、回放、退款、对账；五模态在最终版本保留鉴权、请求 ID、用量、成本和错误，逐项通过生产证据门禁。 |
| P1 | 容量、恢复和最终桌面浏览器验收 | 运营 API/前端方法覆盖 140/140；隔离浏览器和 PG 历史验收存在；`capacity-evidence-gate` 与 restore gate 已定义 | 当前 release 无容量和恢复签名报告；现网 Ops `healthz=ok` 只证明进程可用 | 用实际目标负载完成 ECS 容量测试和隔离恢复；最终候选在桌面浏览器以真实后端会话重验商家/运营权限、数据、账务和错误态。容量 profile 可按真实负载调整，不必采购 Kubernetes。 |
| P1 | ECS 发布入口统一 | `infra/scripts/launch-preflight.sh` 调用通用 `deploy-preflight.sh`，后者要求 Kubernetes manifest；ECS 专用 `deploy-preflight-ecs.sh` 使用 Compose 镜像合同 | 项目目标是一套 ECS，无 Kubernetes 集群 | 上线 runbook 与唯一发布命令统一走 ECS 门禁，消除通用入口误要求 Kubernetes 的歧义。告警通知已明确关闭，不是上线阻断。 |

## 2026-09-16 代码差距推进

多 agent 已补 ECS Compose 唯一发布入口和宿主工具链阻断、OAuth 配置与公网只读预检、RAM Role OSS 校验、受控 OAuth 换码与租户绑定、知识库词法索引 worker（含原子权益/版本保护）、独立受保护证据签名器。owner 复核后，全局类型检查、发布门禁 611 项和新增相关定向测试 23 项通过；隔离 PostgreSQL 验收正在复跑。本轮修改未部署。

上线判定仍为 **NO-GO**：ECS 宿主仅有 Docker，缺少发布工具链；现网仍缺真实 ChatGPT OAuth 客户端、最终 release 镜像和 210–214 迁移、签名信任与实际证据、OSS 运行时切换和桌面真实链路验收。签名器核对 transcript 结构、哈希和负面响应关联，但自哈希文件不能证明服务商来源；六平台真实采集尚缺，生产 canary 继续在服务商 I/O 前阻断。词法索引已实现；向量 embedding 已具备中转适配器、usage/cost 数据类型和 revision/hash fencing，但后台索引仍缺独立的授权、预算预留、结算与对账合同，因此没有接入生产 worker，不能作为上线能力。

## 后续多 agent 代码复核

六平台 canary 已要求回调 state 与另存的 pending state 相等、换码响应和账号绑定成功，并在失败时停止后续服务商请求；采集器在 provider I/O 前预留 0600 journal，逐能力失败响应不能复用。生产入口仍保留硬阻断：环境变量相等不证明真实 OAuth 会话来源，也没有已完成的逐能力负面探测和可信协议采集；远端写入后本地日志故障必须按服务商请求 ID 核对，不能盲目重试。

知识库复核修复了实质内容变更却沿用 `ready` 和旧审批的问题：文档或 chunk 变化会重置审批、权益、索引状态并增加版本，未变化的重试幂等；新增隔离 PostgreSQL 并发、跨租户、重启验收。nonce 消费器补充打开后目录、属主、权限和账本路径替换检查；root 并发负面测试需在隔离候选主机执行。

owner 验证：全局类型检查通过，连接器/索引定向 24 项通过，隔离 PostgreSQL 24 文件、27 项通过；最终发布门禁 612 项通过、14 项跳过。源插件、marketplace 镜像与 `release-metadata.json` 已对齐，脚本语法和 diff 检查通过。以上均为本地或隔离验收，不代表 ECS 已部署。

## 第三批可代码化缺口（owner 复核）

CodeGraph 已增量同步至 1,453 文件、20,565 节点、78,597 边。新增无凭据 OAuth 边界探针，检查未注册 client、空 token grant 和未授权 MCP 工具列表；本机对现网复核的响应依次为 503、503、401，因此真实 ChatGPT 授权仍阻断。新增 Docker-only ECS 候选源码门禁入口，要求 digest 锁定镜像和完整 Git SHA，以无网络、无宿主挂载、无 Docker socket、非 root 权限运行测试；目前未构建/运行真实候选镜像，不替代生产预检。

知识库实质内容更新会清除旧向量，避免重新审批后复活；原有中转五模态没有 embedding 合同；本轮增加了独立 `/embeddings` 适配器、模型配置、定价分组、用量/成本类型和 migration 214，但 owner 复核发现后台索引没有可复用的原始用户动作授权与预算预留，直接接入会被 provider admission 拒绝并阻塞词法索引。因此当前 worker 只执行词法索引，向量能力保持 fail-closed，不能因配置存在而宣称完成。中转证据门禁现在逐项绑定收据的请求、endpoint、用量和成本，并限制证据有效期及路径；支付六项检查需不同证据文件，恢复检查允许复用同一备份文件。工作区同期升级插件版本与首次使用文案，owner 已对齐元数据和契约测试；本轮未部署。

## 第四批代码/脚本差距（owner 再验证）

CodeGraph 同步至 1,457 文件、20,594 节点、78,749 边。知识向量写入新增文档版本、文档/片段哈希和权益审批门槛；PostgreSQL 锁定文档后检查，拒绝撤权或重新审批后旧任务写回，隔离验收覆盖该负面路径。桌面运营后台新增只读真实 MCP smoke：分别核验工作区与平台身份、租户、成员、账务、规则、审计和五模态模型结构；可选使用另一真实租户检查明确 403/404 拒绝。没有两套真实会话，本轮未运行现网桌面验收。

ECS 候选门禁镜像增加固定基础镜像、仅归档已提交源码的构建器及 revision/source SHA-256 标签校验。owner 实测当前未提交工作树会在 Docker 构建前阻断。OAuth 503 源于现网 API 容器缺 `MCP_OAUTH_CLIENTS` 且 `MCP_OAUTH_REQUIRED` 未开启；只读宿主诊断三套 API 均 fail-closed。当前 ECS 容器显示 healthy，API 健康接口仍为六平台 fixture、写入关闭，不能替代真实插件会话。

owner 验证：新脚本/向量定向 14 项通过，全局类型检查通过；发布门禁 615 项通过、14 项跳过；隔离 PostgreSQL 24 文件、28 项通过；Shell 语法与 diff 检查通过。镜像尚未构建/推送，OAuth 客户端仍缺，未部署，本轮上线判定仍为 **NO-GO**。

## 第五批可代码化缺口（owner 复核）

CodeGraph 增量同步到 1,457 文件、20,597 节点、78,774 边。MCP OAuth 客户端注册表改为无原型映射，拒绝 `constructor`、`toString`、`__proto__` 等未注册 ID；非生产 fixture OAuth 也只允许本机回环入口，避免公开入口误发 fixture token。桌面运营后台的受管 OIDC 会话仅以服务端 `ops.session` 的 workspace ID 作为租户范围，不再读取陈旧浏览器存储作为审计、告警或商业查询目标；本地验收模式仍保留显式配置。

退款查询的订单、退款请求、金额及已记录退款 ID 必须与网关回执一致；支付宝网关在校验签名响应后补齐订单 ID。ECS 候选包在发起 SSH 前拒绝危险远程路径/主机参数；OSS 切换检查拒绝外层 `ok:false` 却内层声称健康的响应。非生产 readiness 提示已移除将告警列为上线必需项的误导措辞。定向 OAuth、运营后台、支付网关、ECS/OSS 脚本测试通过；owner 统一类型检查通过，发布门禁 615 项通过、14 项因无隔离 PostgreSQL 环境跳过，diff 检查通过。ECS 容器状态 healthy，API 和运营健康接口可响应。本批未部署、未做真实支付或退款，也没有真实 ChatGPT/受管运营后台会话。

现网只读健康接口仍显示六平台 fixture、写入关闭和旧告警提示，说明当前本地源码尚未部署。ChatGPT 客户端注册、最终镜像/迁移、签名证据、真实商家平台与桌面工作流仍是 **NO-GO** 条件。

## 第六批多 agent 可代码化缺口（owner 复核）

CodeGraph 增量同步至 1,457 文件、20,597 节点、78,783 边。本地回环 OAuth fixture 入口现在拒绝重复 `redirect_uri`/`state`、格式错误的地址、危险协议、非 HTTPS 外部回调和超长 state，返回 400 而非异常 500 或继续跳转；合法本机回调仍可使用。桌面平台审计聚合列表展示所属企业，分页去重、同批去重和 React 行标识均包含 workspace ID，避免不同企业相同记录 ID 被合并。ECS OSS 运行时检查按 API 响应契约拒绝非空外层 `error`，不将平台连接器的外层写入字段误作 OSS 独立能力。

owner 统一验收：相关定向 28 项通过，全局类型检查通过，发布门禁 615 项通过、14 项跳过，diff 检查通过；运营 API 方法引用审计 140/140。现网 `/api/releasez` 仍返回 `ready:false` 且四项 release 标识为空。没有真实受管桌面会话、ChatGPT OAuth 授权、OSS 切换或候选容器验收；代码修复未部署，上线判定仍为 **NO-GO**。

## 第七批多 agent 可代码化缺口（owner 复核）

CodeGraph 增量同步至 1,457 文件、20,597 节点、78,792 边。本机 OAuth fixture 的 token 端点不再对任意 POST 发 token：只接受表单编码、唯一授权码 grant 和 `fixture-code`，错误码、重复参数、JSON 或空请求均拒绝，成功响应禁止缓存。桌面成员写操作后的分页刷新在异步响应返回后再次核验请求代次和 workspace，防止切换企业后旧租户结果覆盖当前列表。

支付查单的 `paid` 回执现在必须显式绑定所查订单；owner 同步修改支付宝网关，在验证服务商响应与订单一致后返回 `order_id`，避免严格适配器拒绝所有合法查询。ECS OSS 健康信封仍以现有 `error:null` 契约为准；可选 `ok` 字段若存在则必须严格为布尔 `true`，字符串或数字不能冒充成功。本轮定向支付/网关测试 37 项、OAuth/运营/OSS 测试 33 项通过；全局类型检查、脚本语法和 diff 检查通过；发布门禁 615 项通过、14 项因没有隔离 PostgreSQL 环境跳过。

本轮没有部署、真实支付、真实 ChatGPT 授权或受管桌面会话。现网 release 标识、最终镜像/迁移、签名证据、平台 canary 和 OSS 实际切换仍未完成，因此上线判定仍为 **NO-GO**。

## 第八批多 agent 可代码化缺口（owner 复核）

CodeGraph 增量同步至 1,459 文件、20,610 节点、78,842 边。生产 MCP OAuth 自托管授权/换令牌入口现在要求 `MCP_OAUTH_REQUIRED=true`、规范 HTTPS 公共根地址及与公共地址一致的自托管 issuer/端点；生产 resource/audience 固定使用已配置公共 origin，不从请求 Host 派生。外部 OAuth 服务的 discovery 仍可在显式配置后发布，但不会把本地处理器误当外部端点。无规范公共地址时 discovery、authorize 和 token 均拒绝。

桌面客服域的列表、分页、详情、变更后刷新、SLA 月报和 correction 响应均同时绑定请求代次与 workspace，阻止企业切换后的旧响应回写。支付 `paid` 查单回执新增 workspace 绑定，网关要求并回传 workspace；订单、金额与工作区缺一不可。对象迁移脚本在调用 `ossutil` 前拒绝正文或元数据符号链接及越过 `LOCAL_OBJECT_ROOT` 的解析路径，避免目录外文件被上传。

owner 复核修正了两处跨组件兼容性：网关回执同步补齐适配器要求的订单/工作区字段；OSS 健康信封保持现有 `error:null` 契约。OAuth 定向测试 21 项、运营/支付/迁移定向测试 32 项通过；全局类型检查、Python/Node 语法和 diff 检查通过；发布门禁 615 项通过、14 项跳过。本轮没有部署或调用真实供应商，现网证据缺口不变，上线仍为 **NO-GO**。

## 第九批多 agent 可代码化缺口（owner 复核）

CodeGraph 增量同步至 1,459 文件、20,612 节点、78,868 边。生产 MCP OAuth discovery 不再广告当前服务无法验证 token 的外部 provider；自托管 issuer、授权端点和 token 端点必须与规范公共 origin 一致，否则 discovery 与本地 OAuth 路由统一 503，避免 ChatGPT 进入无法完成的登录死链。

桌面平台财务权限撤销或工作台退出时会取消搜索、详情和 CSV 导出，失效所有响应代次并清除已加载的敏感数据；过期导出不能再触发下载。退款提交与退款查询现已在客户端和支付宝网关两侧绑定 workspace、订单、退款请求、金额及退款 ID，缺少 workspace 的网关请求在服务商 I/O 前被拒绝。候选门禁镜像构建器以脚本物理位置解析仓库，并对所有 Git revision/status/archive 操作使用该根目录，从仓库外按绝对路径运行时不再错误读取调用者目录。

owner 定向复核 54 项通过，全局类型检查、Shell/Node 语法和 diff 检查通过；发布门禁 615 项通过、14 项跳过。本批未部署、未调用真实支付或 ChatGPT 会话，最终镜像、迁移及签名生产证据仍未完成，上线判定保持 **NO-GO**。

## 第十批多 agent 可代码化缺口（owner 复核）

生产发布标识现在由 `/releasez` 与生产 readiness 共用严格格式校验，非法 `release_id` 会返回 503，不能仅凭非空字符串绕过发布身份门禁。桌面审计中心在平台或工作区范围变化时取消列表、详情和导出请求，并清除旧范围的记录、详情、错误和加载状态，防止权限或范围变化后的敏感数据残留与异步回写。

模型中转用量收据保留可供外部对账的 provider request ID；持久层按 workspace 隔离并校验不可变回执事实。服务商未返回 request ID 时，本地 attempt 才会与 workspace、动作、模型和模态一起做 SHA-256 绑定，避免本地重试键碰撞。OSS 本地对象迁移支持正文已上传而元数据未完成的安全恢复：重跑前下载并核对正文哈希；完整对象验证正文与元数据后幂等跳过；孤立元数据或任一冲突均 fail-closed。隔离测试清单的自检数量也已与当前 29 个非 hermetic 文件、24 个 PostgreSQL 文件对齐。

全量分片进一步发现 `content.draft.generate` 已进入共享契约和插件桥、但 API/授权/OpenAPI/发布元数据尚未完整对齐；现已补齐独立 API 路由、品牌内容写权限、OpenAPI 枚举、插件镜像及 154 个商家工具/324 个 MCP 方法的发布计数。批量表格导入测试也改为显式启用商业 fixture，避免依赖其他测试残留的全局状态。

owner 定向复核 6 个文件、141 项通过；新增契约/发布元数据复核 5 个文件、54 项通过；最终全局类型检查通过；发布门禁 615 项通过、14 项因无隔离 PostgreSQL 环境跳过；Python 语法与 diff 检查通过。CodeGraph 已同步至 1,459 文件、20,615 节点、78,903 边。全量安全分片暴露的模型结算测试仍受新增生产交付身份门禁影响，不能把该轮全量运行记为全绿；发布门禁本身已重新全量通过。本批未部署、未连接真实 OSS/模型中转/ChatGPT/支付供应商，现网生产证据缺口不变，上线判定仍为 **NO-GO**。

## 第十一批多 agent 可代码化缺口（owner 复核）

模型结算测试不再绕过生产交付身份门禁：仅在 Vitest 环境提供显式 provider dispatch 复核上下文，生产调用仍保持 fail-closed。ECS 发布预检新增数据库迁移链核验，同时校验候选 SQL 连续性以及 `DATABASE_URL`、`OPS_DATABASE_URL` 中已应用迁移的版本、名称和 SHA-256，避免仅凭最高版本号放行。平台 transcript 与受保护签名器新增时间窗口、未来时间、严格 UTC、单调顺序和 exchange 时间约束，过期或重放材料不能进入发布证据。

CI PostgreSQL 分母补齐图片生成 provider 前置门禁、知识索引 CAS、迁移 212 和工作区内容配置仓储四类真实数据库测试。当前插件范围统一为资料整理、内容候选、审核与导出；店铺连接、同步、自动化和发布入口保持隐藏。发布工具数统计不再维护容易漂移的副本清单，而是从当前 bridge 的隐藏集和禁用集计算；真实 `tools/list`、源插件、marketplace 镜像和 `release-metadata.json` 现统一为 132 个商家工具。

owner 验证：CodeGraph 已同步至 1,460 文件、20,629 节点、78,988 边，索引状态最新；全局类型检查通过；发布门禁 129 个文件、613 项通过，14 项因当前未提供 PostgreSQL URL 跳过。全量 8 个安全分片中 6 个直接通过；其余两个分片只暴露 3 条已过期的插件文案/范围断言，修正为当前真实契约后，相关 4 文件、16 项定向复跑全部通过。桌面客户交付页 32 项通过，包括此前不稳定的账号搜索重试。上述仍是本地与隔离证据，本批没有部署最终镜像、执行 ECS 生产迁移、配置真实 ChatGPT OAuth 客户端或生成 release-bound 的 OSS、支付、模型中转和恢复证据，上线判定保持 **NO-GO**。

## 第十二批多 agent 可代码化缺口（owner 复核）

ECS 候选包现在拒绝任何未提交或未跟踪文件，并使用 `git archive` 打包完整的 40 位 HEAD 提交树；`candidate-identity.txt` 同时绑定 Git SHA、源码摘要、比较清单摘要和同步计划摘要，且源码摘要必须与候选镜像标签一致。ECS 主 preflight 会先对同一份最终 rendered Compose 执行生产安全合同，再计算摘要和验收生产证据。根据插件现有 challenge 路由契约，生产 OpenAI Apps challenge token 改为必填，缺失或使用 placeholder 会在 Compose/OAuth 门禁中阻断。

五模态中转证据从布尔 `usageObserved` 提升为数值和身份绑定：文本/OCR 保存 token，图片与图片编辑保存计费单元，视频保存 provider 回执时长；`usageProviderRequestId` 必须与 `providerRequestId` 一致。请求参数中的数量或时长不得冒充 provider 实际用量。canonical cutover、Codex host、restore 和 OSS 证据新增 24 小时时效、未来时间、时间顺序、artifact 文件 SHA-256、路径逃逸和引用复用约束。所有修改只加强 fail-closed，没有生成生产证据。

运营后台的租户、用户、账务、规则、模型和审计数据仍全部来自后端 RPC/REST；发现的角色策略硬编码已移除，`ops.authorization.matrix.get` 现在返回服务端可分配角色并排除 `platform_owner`，契约缺失时前端禁用分配。插件安装镜像新增 host contract 和安装校验脚本的逐字节镜像检查，避免旧 Automation 范围或 token discovery 逻辑重新混入。

owner 统一验证：类型检查通过；发布门禁扩大至 132 个文件、631 项通过，14 项因当前没有 PostgreSQL URL 跳过；运营/API/插件组合复跑 5 个文件、42 项通过；Shell 语法及 diff 检查通过。CodeGraph 增量同步后的规模为 1,460 文件、20,650 节点、79,048 边。本批仍未部署或调用真实 ChatGPT、OSS、支付与模型供应商。剩余主要代码设计项是 ECS 原子部署/回滚执行器以及 capacity/model/host/cutover 证据签名方式统一；真实上线条件仍包括干净已提交版本、不可变镜像、生产迁移和 release-bound 运行证据，因此判定保持 **NO-GO**。

## 第十三批 ECS 部署闭环与统一证据签名（owner 复核）

新增 ECS/Docker Compose 受验证部署执行器：在任何运行时变更前核对人工确认、candidate identity、Git/source 摘要、Compose 与配置的 TOCTOU、完整 ECS preflight 和外部状态/回滚路径；消费 nonce 后先迁移，再仅启动 digest-pinned 服务，并核对 livez、readyz、releasez 四元组、鉴权数据库路由及 production canary。任何变更后失败都调用宿主保护的回退入口，不执行 `down`、删除卷、数据库降级或 OSS 清理。

新增 ECS Compose 回滚执行器：计划同时绑定当前与目标 release identity、Compose SHA 和镜像集合；变更前核对线上 `/releasez` 防止并发覆盖，使用只读数据库探针确认实时迁移版本，并用目标 API 镜像验证其 migration registry 对现有前向 schema 的兼容性。回滚只切换明确服务，失败时原子记录 `health_failed` 与 `requires_manual_recovery`，保留现场和数据。

生产 Compose 层链改为单一受控清单：base → pilot → OSS → production migration → release identity。渲染器拒绝环境变量替换清单、绝对路径、路径穿越、缺层、旧 auth-hardening 层以及错误首尾顺序。最终 Compose 对全部服务禁止 privileged、host network/PID/IPC、Docker socket 和敏感宿主挂载；应用服务要求非 root、`no-new-privileges`、`cap_drop: ALL`，兼容的 Node 服务使用只读根文件系统和受限 `/tmp`。

新增统一 release evidence bundle attestation。受保护 Ed25519 attester 对 capability、capacity、modelRelay、payment、restore、objectStorage、codexAppHost、canonicalCutover 八类 artifact 的精确 SHA-256 和共同 release/image-set/manifest/Git/nonce/key 进行签名，并限制 24 小时时效；验证器拒绝重复引用、kind 交换、路径逃逸、符号链接、非部署时精确文件和签名篡改。这样未独立签名的 capacity/model/host/cutover 也被统一可信边界覆盖，采集器不接触生产私钥。

owner 统一验证：类型检查通过；发布门禁已纳入 bundle、ECS deploy 和 rollback 测试，共 135 个文件、645 项通过，14 项因当前没有 PostgreSQL URL 跳过；部署/回滚/Compose/证据定向组合 5 个文件、76 项通过；Shell/Node 语法和 diff 检查通过。所有执行器仅在本地做静态和隔离契约验证，没有连接 SSH 或修改生产。代码闭环已完成，但当前脏工作树本身会被候选包门禁拒绝；仍需固化提交、构建不可变镜像、配置真实凭据并在 ECS 生成签名运行证据，因此判定保持 **NO-GO**。

## 第十四批对抗复核与 embedding 闭环（owner 复核）

部署/回滚执行器经过对抗审查后补齐共同 canonical `flock`、固定 Compose project、受保护路径父链、独占 `0600` 状态文件、`0400` 冻结输入、nonce 与每次 mutation 前的摘要复核、严格批准 origin、有界启动等待和健康重试。rollback capsule 绑定当前/目标发布身份、Compose、环境、镜像摘要、project、24 小时时效、前向数据库策略和卷保留；目标 API 镜像在只读事务中核验实时迁移的版本、名称与校验和。自动回退不再只传状态路径：部署前必须冻结完整旧版本 capsule，失败时通过受保护 wrapper 显式传齐回滚器所需输入，并由真实 stub 执行测试验证。

Release manifest 与 evidence bundle 已双向互证：manifest 强制声明 `release-evidence-bundle/1`，bundle 验证精确 manifest 字节、release/Git 绑定和八类证据引用完全一致；objectStorage 恢复独立 Ed25519 验签。候选比较清单和 release manifest 也新增 render/deploy/rollback、bundle attester/verifier 及运行手册摘要，避免发布时遗漏门禁代码。

知识向量检索没有缩小承诺，而是补齐真实中转闭环。新增 OpenAI-compatible `/embeddings` 客户端，要求 HTTPS/host allowlist/Bearer/idempotency、受限输入和向量形状、provider admission、request ID、数值 usage/cost 持久结算；结算成功后才返回向量。Worker 将向量绑定 document revision、文档 hash 和 chunk hash；未完整配置时继续使用词法索引，不虚构向量能力。迁移 214 将 embedding 纳入模型用量及每日预算账本。

owner 验证：全局类型检查通过；发布门禁 135 个文件、652 项通过，14 项因没有 PostgreSQL URL 跳过；embedding、知识索引、迁移、bundle/manifest、部署/回滚组合 7 个文件、33 项通过；Shell/Node 语法与 diff 检查通过。本批未部署或调用真实 embedding provider，生产仍需配置模型、维度和成本证据并应用迁移 214。当前工作树未固化且真实外部配置/证据未生成，上线判定保持 **NO-GO**。

## 建议执行顺序

先固化当前工作树与不可变候选镜像，并补 210–213 迁移；接着解决真实 ChatGPT 客户端和知识索引 worker；随后配置六平台、OSS、支付/中转的真实运行链路；最后独立签署 release 证据，跑 ECS 专用 preflight、桌面验收、受控 canary 和健康/回滚检查。若想先做有限试点，应先明确缩小对外承诺及对应门禁合同，不能在全六平台 release gate 下把 fixture 宣称为完成。

## 第十五至十六批：确定性发布与 embedding 真实执行合同

第十四批报告中“Worker 已接入向量”的表述经只读调用图复核后被纠正：当时只有 relay 适配器、持久层字段和迁移，生产 worker 仍明确执行 lexical-only。本批补齐了缺失的真实执行链。API 新增 generation worker HMAC 专用的 embedding admission/outcome 接口，将 workspace、文档、revision、内容哈希、action 与 run key 绑定；调用前重新核验审批、权利和索引状态，并建立持久 action authorization 与 embedding 预算预留。Provider 成功后必须先通过 `/v1/internal/model-usage` 原子记录真实用量、成本证据并结算预算，之后 worker 才写入向量；明确未发出请求时释放预算，结果未知时保留预算进入对账，不写向量也不盲目重试。向量开关关闭时保留词法索引，开启但中转、版本、签名或成本配置不完整时启动失败。

候选发布增加 `stage-verified-ecs-release.sh`，从完整、已验证的 Git archive 构造仓库外隔离 release checkout。执行器验证四项候选身份、归档和比较清单摘要及内嵌 40 位提交；拒绝路径穿越、链接、特殊文件、重复路径、特权位和超限展开，使用 `npm ci --ignore-scripts`，并以原子移动创建不可覆盖的 release 目录。对抗复核进一步加入同 release ID 并发锁、release root 属主/权限、祖先符号链接检查，以及部署前逐文件比对暂存源码和绑定归档。部署与回滚控制面脚本及证据 attester 类型声明已进入 release manifest、候选比较和必需工件。

迁移 214 的 PostgreSQL 验收现覆盖 213→214、旧账务不变、embedding 用量与预算预留以及幂等尾版本，并进入 CI。Kubernetes 保留为 legacy 全量测试，但已从 ECS 生产发布门禁移除；告警继续允许显式关闭，不属于当前上线要求。owner 最终复核：全局类型检查通过；API/worker/知识索引组合 200 项通过；候选暂存与部署安全回归 12 项通过；发布门禁 135 个文件、632 项通过，14 项因当前未提供 PostgreSQL URL 跳过。此前全量八分片发现的告警、readiness 与 legacy Kubernetes 断言均已定向修复并复测 71 项通过。

本批仍未部署生产，也没有调用真实 embedding、ChatGPT、OSS、支付宝或商家平台。当前代码级 P0 已收口，但工作树尚未固化，真实 OAuth 客户端、不可变镜像、ECS migration 214、生产凭据与 release-bound 证据、桌面真实会话和 canary 仍是 **NO-GO** 条件。建议顺序更新为：固化干净提交并生成受验证候选包；构建和推送不可变镜像；在 ECS 暂存隔离 release；应用 migration 214；注入真实 OAuth、OSS、支付和模型中转配置；采集并签署八类 release 证据；最后执行 ECS preflight、受管桌面验收、受控 canary 和回滚演练。
