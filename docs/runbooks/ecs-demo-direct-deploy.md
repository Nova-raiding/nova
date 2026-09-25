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

客户安装尚未达到正式发布条件：Mac 单文件候选包已从干净提交 `98aea8ad` 重建，包含安装后安全打开 ChatGPT、token 刷新修复、官方 ChatGPT.app、Node 和插件，SHA-256 为 `b0a8e56ff9323788d213d93d6fd69a449773fe1d1ace6022deeb26a8bb9d13c4`；但它仍标记 `unsigned_candidate`、`ready_to_install=false`，缺 Developer ID 签名、公证和 ChatGPT 图形界面绑定验收。Windows `192.168.1.104` 当前不可达，尚无 Windows 包和目标机安装证据；现有 Windows 流程还需在线取得 Microsoft Store 客户端，并要求 ZIP 与包外签名安装脚本两个文件，未满足离线单文件交付。图片生成、图片编辑、OCR、视频虽有中转配置，但该工作区没有经确认的真实商品图片与资料，也没有四种模态的 provider 用量回执；OCR 创意点费率尚未获批准。这些项不得以配置就绪或健康探针通过替代上线证据。
