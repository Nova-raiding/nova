# ECS demo 直接部署与上线验收

适用范围：`101` 上唯一的 Store Nova Demo `merchant-demo-85575f9c`，承载本地 ChatGPT stdio 插件、API/MCP、worker 和桌面后台。公网域名是该 Demo 的入口，不代表另有生产环境。此 runbook 只描述这一个 Compose 项目；禁止创建、选择或部署第二套环境。**只有本 runbook 所有前置门禁均通过后，才可提交待审查候选、从精确提交构建并部署到该唯一 Demo，再验证变更；任一门禁未通过即 STOP/NO-GO。当前 inventory 未获批准且仍有容器未分类，当前必须 STOP，不得提交为可部署候选或执行部署。**

本流程只要求与本次变更相称的类型检查、单元/API 测试、桌面浏览器验收和唯一 Demo 容器健康检查；不把其他环境的发布门禁作为 Demo 验收。真实模型中转鉴权、请求、用量和成本仍须保留证据；配置或凭据缺失时 fail closed，并明确阻断对应模型能力。

日常更新入口与时间预算见 [101 快速更新方案](ecs-fast-update.md)，支持只读现状检查与按组件构建。

执行本 runbook 前必须先满足 [快速更新方案的 Demo inventory 与锁证据门槛](ecs-fast-update.md)：唯一 Demo 的 `release_approved` 必须为 `true`；inventory 列出的所有运行容器（包括 Demo Compose 项目之外的容器）必须有 owner 确认的分类；同一任务还须留存该 runbook 要求的既有共享锁来源、所有权、逐级目录权限和唯一 mutator 共用证明。任一项为 false、缺失或未经确认均 **STOP/NO-GO**。当前 inventory 报告 `release_approved=false` 且仍有未获 owner 确认分类的容器，因此当前不得执行本 runbook；不得以其他环境或生产门禁替代唯一 Demo 证据。

## 1. 锁定本次改动

- 本地只用 `main` 分支和唯一主工作目录。每项独立修复做最小相关检查，通过后单独提交；不要把其他 agent 同时修改的文件一起暂存。发布前确认工作目录干净，并从已提交的精确 SHA 构建。
- 从提交的完整 SHA 用 `git archive` 生成干净源码快照，传到通过 101 只读状态和当前 Demo 受保护部署配置确认的候选暂存目录；不得从文档、旧环境记录或猜测中硬编码目录。不得从带有未提交改动的共享工作目录构建镜像。记录所用目录、快照 SHA、目标组件、镜像 digest 和构建结果。
- 仅为改动的组件构建镜像。API、Ops UI、Merchant UI、worker 各自有独立镜像；若运行中的组件来自不同提交，记录每个组件的真实提交及 digest，不把统一 release 标识误写成所有组件的源码版本。当前快速更新适配器不覆盖 gateway/payment；这两类变更必须停止并另行完成专用候选、切流、回滚和验收方案后再部署。既有 runbook/metadata 记录的 Demo 迁移基线为 1–270，但 2026-10-10 主机观察未读取 live migration chain，故该基线尚待 DB owner 逐行核实。当前源码候选链尾为 273（metadata source=270,target=273，含新增迁移 271–273）。无迁移快速更新必须以 DB owner 提供的 live 完整链与目标链逐行一致为前提；核实前不能确认无迁移路径可用。当前没有已批准的 Demo 全量 migration 执行入口或窗口，任何需要应用 271–273 的候选均须停止本 runbook 与快速更新流程；不得手动运行迁移，也不得用 metadata 数字作为批准。只有单独审批并具备受保护迁移执行器、备份与隔离恢复证据、前向迁移及旧版兼容/恢复证据后，才可另开迁移窗口。
- 密钥、数据库连接和部署环境只放 101 上当前 Demo 对应的受保护目录；以只读状态检查发现的现存配置为准，不硬编码过期目录、不复制到其他环境。不要让这些内容进入 Git、源码归档、日志、聊天或客户包。修改受保护 Compose 时保存新文件、核对目标服务和镜像 digest，并记录文件 SHA-256。

## 2. 更新目标服务并验证公网入口

本次 demo 的运行配置采用 `NODE_ENV=production`（保留生产加固行为）、`DEMO_RUNTIME_MODE=true`（明确唯一 demo 部署目标）、`DEPLOYMENT_PROFILE=ecs`、`MCP_INTEGRATION_MODE=local_stdio`、`PUBLIC_OPS_BASE_URL=https://ops.yxsona.com`、`ASSET_SCANNER_MODE=deferred` 和 `DEMO_UNSCANNED_ASSETS_ENABLED=true`。渲染最终受保护 Compose 配置时必须包含 `infra/local/docker-compose.ecs-pilot-release.yml` release overlay；核对最终输出中的 `api` 与 `api-replica` 两个服务都显式为字符串 `RUN_MIGRATIONS_ON_STARTUP=false`。基础 Compose 使用 `.env.example` 的默认值，漏掉 release overlay 时可能启用启动迁移；缺失、`true` 或任何其他值均为 **STOP/NO-GO**，不得用启动 API 的方式执行数据库迁移。健康接口的 `setup.mode` 必须报告 `demo`；若报告 `production`，说明 demo 标记缺失或未生效，停止发布并先修复受保护 Compose 配置。本地直装不使用 ChatGPT 市场/OAuth；从 API、replica 和其受保护环境中**移除** `MCP_OAUTH_REQUIRED`、`OIDC_PROXY_SIGNING_SECRET` 等退役外部认证变量，不要以 `false` 或空值冒充删除。模型中转仍须真实鉴权和用量回执；缺少配置时保持阻断。

使用该 release 的受保护 Compose 文件、`candidate.local-stdio.env` 和固定项目名，只指定本次变更相关的服务。API `/releasez` 读取 API 启动环境中的发布身份，因此任何新候选都必须明确更新 `api api-replica`；仅 Ops 或商家 UI 变更时沿用当前 API 镜像，仅更新其发布身份环境，再加入受影响的 `ops-ui` 或 `ui`。API 修复更新 `api api-replica` 的镜像；worker 修复按 fast-update runbook 选择完整 worker 组件并刷新 API 身份。Gateway/payment 不属于当前适配器范围，不得按本节直接部署。执行前先核对 `docker compose config` 中目标服务的镜像、环境和持久卷，再运行带**明确服务列表**的 `docker compose up -d --no-deps <services>`。不得对整个 Compose 项目运行无服务名的 `up -d`，以免启动或重建未选服务及仅兼容声明的 `migrate` 服务；ClamAV 和 worker-scan 属于运行服务集合，未被本轮选中时必须保持其现状和容器 ID，不因本次更新重建。本 demo 的素材可保留 `unscanned` 状态直接使用；如有其他 Compose 项目的扫描容器仍在运行，不应称整台主机已关闭扫描。

公网域名和现有 gateway 配置保持不变；部署前后验证域名仍指向唯一 Demo，并对照 `/releasez` 与该项目运行镜像身份。当前流程不创建或切换 gateway，也不接管 80/443。不要用删除数据库、对象存储或容器卷掩盖问题。上传所需的持久对象目录是 `/var/lib/merchant-assets/objects`。

## 3. 部署后验收与判定

先确认新容器已经启动并承载公网，再进行下列与本次改动相关的最小回归；已通过且未改动的功能不重复测试。记录请求时间、目标域名、容器 ID、组件 digest、响应码和可脱敏的业务 ID。

1. `https://yxsona.com/releasez`：`ready=true`，manifest SHA 和 image-set digest 对应实际运行容器；`https://yxsona.com/api/healthz` 与 `https://ops.yxsona.com/healthz` 返回 200。仅健康探针通过不代表业务上线。
2. 从桌面浏览器真实登录运营后台和商家工作区 `ws_guirenniaoniao`，验证租户、角色和目标操作。Ops 前端用 `/ops/build-meta.json` 对照镜像提交。
3. 对修改过的上传/交付路径，通过公网完成上传、读取和下载，校验文件字节或 SHA-256；demo `unscanned` 资产应能正常用于授权的工作流。无需等待扫描回调。
4. 对修改过的 MCP/模型路径，从实际本地 stdio 插件入口发请求，核对中转鉴权、真实 provider 回执、模型用量与成本、创意点预留/结算。仅 `/v1/models` 或简单 JSON 探针成功，不代表完整商家生成任务成功。provider 结果未知时保留待核对的预留，不盲目退款或重放；余额/点数不足时拒绝新请求。
5. 若任何一项失败，记录具体错误和证据，修复该项，单独提交并从新提交构建、部署该组件，再只复测失败项及受影响邻接路径。不得用旧版响应、静态代码或未完成的本地包证明上线。

历史候选记录（早期验证，非当前状态或本轮证据）：公网 `release-e2ae2723-full` 曾报告 `ready=true`，manifest SHA-256 为 `c4f1123a870cf8715e6d011e418f2b76df8b92a788c0c639e3ef177ec77b5ea7`，image-set digest 为 `sha256:4c8445d84baadb8e3c6ae25bf8a250c13903b34c6ca2b9273975659a6ca87f57`；当时 API 双副本镜像均为 `127.0.0.1:5000/storenova/merchant-api@sha256:449081b72e9391e3145cd019f16cc1d8eda937b5e340d46347b91323f423ee0a`，运行服务健康，公网健康探针返回 200。真实平台运营账号曾验证 `ops.commercial.readiness.report`，其输出含 `RATE_CARD_MISSING` 阻断；真实商家账号曾验证登录及 `ws_guirenniaoniao` MCP token 签发/刷新，错误身份调用 `workspace.bootstrap` 返回 403。此前 REST/MCP 上传、客户交付和文本生成也曾通过；Qwen 中转回执记录 750 tokens、成本 ¥0.003511，结算 1 个创意点。遗留 unknown 预留待中转站权威账单核对，禁止据此记录擅自释放。本段只供追溯，不能替代本轮候选验收。

2026-09-25 OCR 修复发布：从精确提交 `1e30307eb1450b0edc770bbf52c2cef70458e795` 构建 API 与 worker，先在 101 应用迁移 247，再分别只重建 API 双副本与 5 个业务 worker。迁移后旧 worker 镜像因只包含到 246 的迁移链而变为 unhealthy；改用同一提交构建的 worker 镜像后恢复。最终公网 `release-1e30307e-ocr-workers` 返回 `ready=true`，清单 SHA-256 为 `a452e9b85472539dbf38c21d91448b50dfbab4f48c50e3143454e099fa6ea710`，镜像集摘要为 `sha256:c8793edbc5133cd04f21455f5f87813bc750e1650fec3a9db51abdd694f3fa78`；11 个运行中的业务服务均 healthy 且镜像与清单逐项匹配，API 与 Ops 公网健康检查均为 200。平台账号从公网读取 OCR 费率为已审批可执行的 `⌈实际模型成本（CNY）× 2⌉`，最低 1 点。

部署后用明确标记为 QA 的合成文字图片 `asset_94c49435-82c8-4d16-87d7-f2b55019a410` 在 `ws_guirenniaoniao` 做了一次**计费技术验证**：OCR 实际调用 `agnes-2.5-flash`，回执记录输入 172、输出 28、合计 200 token；模型用量账本成本 ¥0.000068，创意点回执保留更精确的 ¥0.0000683；预留 40 点，实际结算 1 点并释放差额。重复解析返回 `replayed=true`、仍为第 1 次尝试，模型用量账本只有 1 条记录，未重复扣点。OCR 将图片上的测试文字识别错了，因此此项仅证明中转、回执、费率和扣点链路，**不能**充当贵人鸟商品事实或识别质量验收；该工作区仍缺经确认的真实商品图片。

历史安装包记录：Mac 单文件候选包曾标记 `unsigned_candidate`；Windows `192.168.1.104` 曾按用户要求暂缓。Apple Developer ID 签名、公证和 ChatGPT 宿主身份/进程绑定不属于本地直装 stdio Demo 的验收项或阻断项。若后续另有明确授权的客户安装交付，按对应用户场景验收安装和插件调用即可。该记录不表示当前 Demo 已完成真实商品工作流验收：图片生成、图片编辑、视频须有真实中转与用量回执，OCR 业务质量须有经确认的商品图片和资料；不能用配置就绪或健康探针替代。

2026-09-25 OCR 免费阈值修复发布：计费、费率目录、API 结算和运营展示分别提交为 `d387f2e5`、`b63d0c26`、`01e4503d`、`9b78e5ed`，从完整提交 `9b78e5ed049e21c42d1aae30d3b15995becd4894` 的源码归档在 101 构建 API、worker 和 Ops UI 镜像。先应用迁移 248，再只更新 API 双副本、五个业务 worker 和 Ops UI。公网 `release-9b78e5ed-ocr-free` 返回 `ready=true`，清单 SHA-256 为 `e98cdcde26d8b0c1408700ead88774845cf4e328aa26a69426cafd78cb3f115e`，镜像集摘要为 `sha256:ef7ade829676e97eaef111eaef406ab7c8d9bd15c8f1f9921d189b260a8dfc58`；11 个业务容器健康且镜像与 Compose 指定摘要逐一匹配，API 与 Ops 公网健康检查均为 200。运营后台桌面浏览器以真实平台账号登录后，OCR 卡片显示“图片文字识别”和“实际模型成本 ≤ ¥0.30 免费；超过 ¥0.30 按 ⌈成本（CNY）× 2⌉ 扣点，最低 1 点”。

部署后在 `ws_guirenniaoniao` 用明确标记为 QA 的合成文字图片 `asset_bb9f0f06-2d6f-4a83-9268-872c2e2da1e2` 经公网实际上传并解析：中转模型 `agnes-2.5-flash` 回执输入 172、输出 24、合计 196 token，真实成本证据 ¥0.00005464；账本六位小数为 ¥0.000055。创意点预留 40 点、最终结算 **0 点**；相同素材再次解析返回 200，服务端仍只有一条该动作的模型用量，未重复扣点。图片识别文字仍有误差，此项仅证明计费技术链路，不代表商家商品事实通过。当前调用前仍按 ¥20 单任务上限预留 40 点，余额不足 40 点的用户无法发起图片 OCR，即使实际成本最终可能免费；零余额免费调用需要另行设计平台垫付与超阈值待充值流程。运营后台商业化生产门禁仍显示两项既有阻断，不能据此宣称整个产品达到正式客户上线条件。
