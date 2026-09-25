# ECS demo 直接部署与上线验收

适用范围：`101` 上的 Store Nova 本地 ChatGPT stdio 插件 demo。此流程记录 2026-09-25 已实际运行的 `merchant-demo-85575f9c` 隔离 Compose 项目和公网接管方式。它与需要旧版回滚胶囊、扫描回调和 15 场景预发布证据的正式生产部署器分开；那些旧版门禁不作为本次 demo 修复发布的前置条件。**每项修复先提交、从精确提交构建并部署，然后在公网和服务端验证该项；失败则继续修复和重新部署。**

## 1. 锁定本次改动

- 本地只用 `codex/windows-plugin-bundle` 一个分支、一个 Git worktree。每项独立修复做最小相关检查，通过后单独提交；不要把其他 agent 同时修改的文件一起暂存。
- 从提交的完整 SHA 用 `git archive` 生成干净源码快照，传到 `/srv/merchant-releases/release-<sha>`。不得从带有未提交改动的共享工作目录构建镜像。记录快照 SHA、目标组件、镜像 digest 和构建结果。
- 仅为改动的组件构建镜像。API、Ops UI、gateway、worker 各自有独立镜像；若运行中的组件来自不同提交，记录每个组件的真实提交及 digest，不把统一 release 标识误写成所有组件的源码版本。
- 密钥、数据库连接和部署环境只放 ECS 受保护目录 `/var/lib/merchant-release-security/demo-first-install/release-85575f9c`；不要进入 Git、源码归档、日志、聊天或客户包。修改受保护 Compose 时保存新文件、核对目标服务和镜像 digest，并记录文件 SHA-256。

## 2. 更新目标服务并接管公网

本次 demo 的运行配置采用 `MCP_INTEGRATION_MODE=local_stdio`、`PUBLIC_OPS_BASE_URL=https://ops.yxsona.com`、`ASSET_SCANNER_MODE=deferred` 和 `DEMO_UNSCANNED_ASSETS_ENABLED=true`。本地直装不使用 ChatGPT 市场/OAuth；从 API、replica 和其受保护环境中**移除** `MCP_OAUTH_REQUIRED`、`OIDC_PROXY_SIGNING_SECRET` 等退役外部认证变量，不要以 `false` 或空值冒充删除。模型中转仍须真实鉴权和用量回执；缺少配置时保持阻断。

使用该 release 的受保护 Compose 文件、`candidate.local-stdio.env` 和固定项目名，只指定本次变更的服务，例如 API 修复只更新 `api api-replica`，Ops 修复只更新 `ops-ui`；确实修改 worker 或 gateway 才更新对应服务。执行前先核对 `docker compose config` 中目标服务的镜像、环境和持久卷，再运行带**明确服务列表**的 `docker compose up -d --no-deps <services>`。不得运行无服务名的 `up -d`，以免启动 `worker-scan`、ClamAV 或无关旧服务。本 demo 的素材可保留 `unscanned` 状态直接使用；如有其他 Compose 项目的扫描容器仍在运行，不应称整台主机已关闭扫描。

公网接管只操作事先核对完整 ID 的旧 gateway 容器，保留容器、卷和业务数据；新 gateway 在 80/443 生效后核对公网身份。不要用删除数据库、对象存储或容器卷掩盖问题。上传所需的持久对象目录是 `/var/lib/merchant-assets/objects`。

## 3. 部署后验收与判定

先确认新容器已经启动并承载公网，再进行下列与本次改动相关的最小回归；已通过且未改动的功能不重复测试。记录请求时间、目标域名、容器 ID、组件 digest、响应码和可脱敏的业务 ID。

1. `https://yxsona.com/releasez`：`ready=true`，manifest SHA 和 image-set digest 对应实际运行容器；`https://yxsona.com/api/healthz` 与 `https://ops.yxsona.com/healthz` 返回 200。仅健康探针通过不代表业务上线。
2. 从桌面浏览器真实登录运营后台和商家工作区 `ws_guirenniaoniao`，验证租户、角色和目标操作。Ops 前端用 `/ops/build-meta.json` 对照镜像提交。
3. 对修改过的上传/交付路径，通过公网完成上传、读取和下载，校验文件字节或 SHA-256；demo `unscanned` 资产应能正常用于授权的工作流。无需等待扫描回调。
4. 对修改过的 MCP/模型路径，从实际本地 stdio 插件入口发请求，核对中转鉴权、真实 provider 回执、模型用量与成本、创意点预留/结算。仅 `/v1/models` 或简单 JSON 探针成功，不代表完整商家生成任务成功。provider 结果未知时保留待核对的预留，不盲目退款或重放；余额/点数不足时拒绝新请求。
5. 若任何一项失败，记录具体错误和证据，修复该项，单独提交并从新提交构建、部署该组件，再只复测失败项及受影响邻接路径。不得用旧版响应、静态代码或未完成的本地包证明上线。

本次已观察到：公网 `release-e2ae2723-full` 的 `ready=true`，manifest SHA-256 为 `c4f1123a870cf8715e6d011e418f2b76df8b92a788c0c639e3ef177ec77b5ea7`，image-set digest 为 `sha256:4c8445d84baadb8e3c6ae25bf8a250c13903b34c6ca2b9273975659a6ca87f57`；API 双副本运行镜像均为 `127.0.0.1:5000/storenova/merchant-api@sha256:449081b72e9391e3145cd019f16cc1d8eda937b5e340d46347b91323f423ee0a`，与完整运行集其余 9 个业务服务的镜像摘要逐一匹配清单且全部健康，两个公网健康探针返回 200。部署后真实平台运营账号调用 `ops.commercial.readiness.report` 返回 200，OCR 显示 `executable=false`、`RATE_CARD_MISSING` 并列出阻断，已批准的文本费率仍可执行。前版 `109ec223` 增加结果未知的模型请求关联记录，已在运行 API 容器中验证 `unknown:` 标识和 `outcome=unknown` 的代码产物，未人为制造付费请求的不确定结果；遗留 unknown 预留经只读复核仍 active，未误扣或退款。此前已通过真实商家账号验证登录、`ws_guirenniaoniao` MCP token 签发及刷新均为 200，错误身份调用 `workspace.bootstrap` 返回 403，正确身份复用原工作区。本次未重复已通过的 REST/MCP 上传、客户交付和文本生成；那次文本生成由 Qwen 中转返回 750 tokens、成本 ¥0.003511、1 个创意点已结算。遗留 unknown 预留仍待中转站权威账单核对，不能擅自释放。

2026-09-25 OCR 修复发布：从精确提交 `1e30307eb1450b0edc770bbf52c2cef70458e795` 构建 API 与 worker，先在 101 应用迁移 247，再分别只重建 API 双副本与 5 个业务 worker。迁移后旧 worker 镜像因只包含到 246 的迁移链而变为 unhealthy；改用同一提交构建的 worker 镜像后恢复。最终公网 `release-1e30307e-ocr-workers` 返回 `ready=true`，清单 SHA-256 为 `a452e9b85472539dbf38c21d91448b50dfbab4f48c50e3143454e099fa6ea710`，镜像集摘要为 `sha256:c8793edbc5133cd04f21455f5f87813bc750e1650fec3a9db51abdd694f3fa78`；11 个运行中的业务服务均 healthy 且镜像与清单逐项匹配，API 与 Ops 公网健康检查均为 200。平台账号从公网读取 OCR 费率为已审批可执行的 `⌈实际模型成本（CNY）× 2⌉`，最低 1 点。

部署后用明确标记为 QA 的合成文字图片 `asset_94c49435-82c8-4d16-87d7-f2b55019a410` 在 `ws_guirenniaoniao` 做了一次**计费技术验证**：OCR 实际调用 `agnes-2.5-flash`，回执记录输入 172、输出 28、合计 200 token；模型用量账本成本 ¥0.000068，创意点回执保留更精确的 ¥0.0000683；预留 40 点，实际结算 1 点并释放差额。重复解析返回 `replayed=true`、仍为第 1 次尝试，模型用量账本只有 1 条记录，未重复扣点。OCR 将图片上的测试文字识别错了，因此此项仅证明中转、回执、费率和扣点链路，**不能**充当贵人鸟商品事实或识别质量验收；该工作区仍缺经确认的真实商品图片。

客户安装尚未达到正式发布条件：Mac 单文件候选包已从干净提交 `98aea8ad` 重建，包含安装后安全打开 ChatGPT、token 刷新修复、官方 ChatGPT.app、Node 和插件，SHA-256 为 `b0a8e56ff9323788d213d93d6fd69a449773fe1d1ace6022deeb26a8bb9d13c4`；但它仍标记 `unsigned_candidate`、`ready_to_install=false`，缺 Developer ID 签名、公证和 ChatGPT 图形界面绑定验收。Windows `192.168.1.104` 按用户要求暂缓，尚无 Windows 包和目标机安装证据；现有 Windows 流程还需在线取得 Microsoft Store 客户端，并要求 ZIP 与包外签名安装脚本两个文件，未满足离线单文件交付。图片生成、图片编辑、视频仍无本工作区的真实 provider 用量回执；OCR 虽已完成 QA 计费技术验证，该工作区仍没有经确认的真实商品图片与资料，不能宣称商家 OCR 业务验收完成。这些项不得以配置就绪或健康探针通过替代上线证据。

2026-09-25 OCR 免费阈值修复发布：计费、费率目录、API 结算和运营展示分别提交为 `d387f2e5`、`b63d0c26`、`01e4503d`、`9b78e5ed`，从完整提交 `9b78e5ed049e21c42d1aae30d3b15995becd4894` 的源码归档在 101 构建 API、worker 和 Ops UI 镜像。先应用迁移 248，再只更新 API 双副本、五个业务 worker 和 Ops UI。公网 `release-9b78e5ed-ocr-free` 返回 `ready=true`，清单 SHA-256 为 `e98cdcde26d8b0c1408700ead88774845cf4e328aa26a69426cafd78cb3f115e`，镜像集摘要为 `sha256:ef7ade829676e97eaef111eaef406ab7c8d9bd15c8f1f9921d189b260a8dfc58`；11 个业务容器健康且镜像与 Compose 指定摘要逐一匹配，API 与 Ops 公网健康检查均为 200。运营后台桌面浏览器以真实平台账号登录后，OCR 卡片显示“图片文字识别”和“实际模型成本 ≤ ¥0.30 免费；超过 ¥0.30 按 ⌈成本（CNY）× 2⌉ 扣点，最低 1 点”。

部署后在 `ws_guirenniaoniao` 用明确标记为 QA 的合成文字图片 `asset_bb9f0f06-2d6f-4a83-9268-872c2e2da1e2` 经公网实际上传并解析：中转模型 `agnes-2.5-flash` 回执输入 172、输出 24、合计 196 token，真实成本证据 ¥0.00005464；账本六位小数为 ¥0.000055。创意点预留 40 点、最终结算 **0 点**；相同素材再次解析返回 200，服务端仍只有一条该动作的模型用量，未重复扣点。图片识别文字仍有误差，此项仅证明计费技术链路，不代表商家商品事实通过。当前调用前仍按 ¥20 单任务上限预留 40 点，余额不足 40 点的用户无法发起图片 OCR，即使实际成本最终可能免费；零余额免费调用需要另行设计平台垫付与超阈值待充值流程。运营后台商业化生产门禁仍显示两项既有阻断，不能据此宣称整个产品达到正式客户上线条件。
