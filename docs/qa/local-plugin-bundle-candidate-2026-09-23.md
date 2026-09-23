# 本地插件打包候选验收（2026-09-23）

结论：**NO-GO，不能把当前候选包作为正式用户安装包或宣布生产上线。** 本记录覆盖 `codex/windows-plugin-bundle` 的本地插件包候选；各条证据以其标注的工件与 CI 运行身份为准。

## 已验证

- 本轮 macOS arm64 内部候选包：`artifacts/local-plugin/merchant-marketing-0.1.0+codex.20260923132700-darwin-arm64-candidate-r5.tar.gz`，SHA-256 `a62c4bcc01ea6ca8f9a432e8ed0a74a6f9d64ba2b045d9aa0a92bfc2ba883ab5`，绑定源码提交 `5dd73dd9620bb7d1e5939941b4a0d9d04cc4869e` 且 `source_dirty=false`。固定校验官方 Node 22.16.0 摘要，包含 Keychain helper 与 67 个逐文件 SHA-256 证明；解包后来源校验、MCP 131 个工具发现、缺配置 `workspace.health` 失败关闭通过。包状态为 `unsigned_candidate`、`ready_to_install=false`、`authenticity_verified=false`，**不能交付用户**。早期未绑定源码证明的候选包已被此候选取代。
- [Intel Mac 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35825489086)：提交 `621f1765` 的 `macos-15-intel` 上通过 x64 构建、隔离安装和实际缓存 MCP 验证。后续提交 `702b472e` 的 [Intel Mac 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35825892045) 也已通过。
- [Windows 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35825998752)：提交 `844dc3fb` 的 Windows runner 完成干净长路径 checkout、自包含 .NET helper、临时 CI 证书签名与 ZIP 校验、隔离安装、MCP 初始化与工具发现、Credential Manager 读写及长令牌往返，全部通过。前两轮失败由公开 CI 注解定位：Windows checkout 未启用长路径，导致历史跟踪附件缺失；`core.longpaths=true` 与 checkout 后完整性检查修复了该问题。helper 也移入临时目录构建，避免未来 `obj/bin` 污染源码。CI 临时测试证书不可用于用户交付。
- 本轮 owner 复核受影响本地测试 102/102 通过、`npm run typecheck` 通过；定向隔离 PostgreSQL/RLS 实际断言 6/6 通过，证据保存在 `artifacts/isolated-postgres/run-D25TKV/run-result.json`。`node --check`、`git diff --check` 通过。原有发布门禁测试此前为 1042 通过、16 项按现有规则跳过；未修改的模块不重复运行整个门禁集。CodeGraph 索引已同步，用于定位链路及定向测试范围。
- 公网 API 和运营后台 `/healthz` 返回 `ok`；这不代替生产 readiness 或桌面宿主验收。

## 正式交付阻断

1. **macOS 签名与公证：** 发布机须有 Developer ID Application 证书、Apple notarytool Keychain profile 和 Team ID。`build-signed-macos-package.mjs` 只在签名、公证、票据装订、Gatekeeper 验证全部通过后输出正式 DMG。本机构建机没有可用签名身份，正向路径未执行。
2. **Windows 生产签名：** 须有可信 Authenticode 代码签名证书与时间戳服务，并在 Windows 发布环境执行 `build-signed-windows-package.ps1`。目前没有生产证书或签名机访问，尚无正式 ZIP。ZIP 内的 JS 与安装脚本不受 helper/Node 的 Authenticode 签名覆盖，正式分发须通过可信渠道公布并核验 ZIP 的 SHA-256。
3. **真实 ChatGPT 桌面宿主：** 须在目标用户会话按 [宿主验收清单](../chatgpt-host-canary-runbook.md) 验证插件发现、启用、商家登录、`onboarding.status`、MCP 调用、工作区权限及错误证据。当前自动化工具对 `com.openai.codex` 访问受限；CLI 和裸 MCP 通过不能替代宿主证据。[OpenAI 本地插件文档](https://developers.openai.com/plugins/build/plugins)说明 ChatGPT 从个人本地 marketplace 的 `local` 缓存加载插件，但最终仍需桌面端安装和新会话验证。
4. **生产环境 readiness：** 2026-09-23 现场只读检查中，`merchant-production-api-replica-1` 的 `/readyz` 返回 503 `SCANNER_NOT_READY`，扫描实例就绪数为 0。正式 `merchant-production-worker-scan-1` heartbeat 唯一不就绪原因是 `scanner_callback_stale`：最近一次 API 接受的签名回调为 2026-09-22 02:48:35.858 UTC，检查时已超过 96,600 秒，越过 86,400 秒门槛。数据库、API、Redis、ClamAV、EICAR 与扫描队列检查均通过，队列 backlog/dead-letter 均为 0，`recoveryCapable=true`。同机旧 `local-worker-scan-1` 使用不同迁移版本，不能混入正式环境判断。恢复须在受控隔离 workspace 产生真实素材扫描，确认 API 接受签名回调，再观察 heartbeat `ready=true` 与 `/readyz` 200；不得直接改写 Redis、数据库、heartbeat 或放宽阈值。现场未创建生产素材。
5. **ClamAV 定义新鲜度：** 现场 `local-clamav-1` healthy，`freshclam` 报告 `daily.cld` 28131 为最新；该定义的发布时间为 2026-09-22 06:27:06 UTC。扫描 worker 的默认 86,400 秒定义门槛会在 2026-09-23 06:27:06 UTC 后失效，届时还会出现 `definitions_stale`。恢复前须核实上游是否发布新定义、下载链路和 worker 实际读取版本；若上游仍无新定义，保持发布阻断。参见[扫描回调发布清单](../runbooks/release-unblock-checklist.md)。
6. **全站生产发布证据：** 当前公网 `/api/releasez` 绑定旧提交 `ec3d69e3`，不能代表本分支候选。最终候选还需模型中转五模态的真实鉴权、请求、用量、成本和错误证据，以及现有生产发布门禁要求的商家、运营、支付、数据库/RLS、worker、审计证据，全部绑定同一 release identity。参见[生产差距审计](production-launch-gap-manual-local-chatgpt-payment-relay-2026-09-21.md)。

包的安装路径仅使用本地个人 marketplace 与 stdio MCP；没有公开或团队插件市场发布，也没有 ChatGPT OAuth 配置。

## 2026-09-23 06:28 UTC 只读复核与解阻顺序

本节是当时的状态快照，不是后续发布可复用的证据。`/api/releasez` 返回旧 release `qa-merchant-ec3d69e3`、Git SHA `ec3d69e37809c0d622c8f38057a072245217004f`、`ready=true`；同一分钟 `/api/readyz` 返回 HTTP 503 `SCANNER_NOT_READY`，扫描实例 `live_instances=1`、`ready_instances=0`、`backlog=0`、`dead_letter=0`，最近接受的回调仍为 `2026-09-22T02:48:35.858Z`。`releasez.ready` 不能替代服务 readiness，更不能证明本分支候选已部署。正式扫描 worker 容器仍运行，API replica 容器显示 unhealthy，ClamAV 容器显示 healthy。运营 `/healthz` 为 `ok`，但同时显示 `writesEnabled=false`、capability evidence 文件不可读、capacity report 未配置；支付 `provider` enabled 和中转 configured 只是配置状态，不是六类支付回执或五模态实际用量/成本证据。现场没有改动容器、数据库或生产素材。

| 门禁 | 当前缺口 | 最小可核验下一步 |
| --- | --- | --- |
| 候选身份与包 | 本地 Git 当前有并行开发改动；r5 是绑定旧提交的内部未签名候选 | 冻结干净完整提交和 release ID；重新生成 Mac/Windows 包，逐项核对 `bundle-provenance`、逐文件哈希、Node 官方摘要和候选源码身份。旧 r5 不得改标为正式包。 |
| Mac/Windows 客户安装包 | 缺生产 Mac 签名/公证和 Windows 生产 Authenticode/时间戳 | 在各平台受控发布机执行现有签名脚本；验收 Gatekeeper/Authenticode、安装后插件缓存、MCP 工具发现和无配置失败关闭，并通过可信渠道发布包 SHA-256。 |
| ChatGPT 真实宿主 | 当前 release/bridge 的 15 场景证据缺失 | 在真实桌面宿主安装正式包，按[宿主清单](../chatgpt-host-canary-runbook.md)采集所有截图、日志、请求摘要和 503 恢复轨迹，再运行 `--require-artifacts` 门禁。 |
| Scanner 与定义 | `/readyz` 为 503；旧签名 callback 过期；定义 28131 发布时间已超过默认 24 小时门槛，是否出现 `definitions_stale` 须读取最新 heartbeat 核定 | 先核实真实定义更新与 worker 读取版本，再在隔离 workspace 发起真实素材扫描，核对签名 callback、heartbeat `ready=true` 和 `/readyz` 200；不改写状态或放宽阈值。 |
| 中转、支付、商家/运营 | 当前 release 的五模态 usage/cost/错误恢复、支付六回执、租户与业务运行证据未齐 | 使用同一候选 release、受保护 artifact root 和真实 provider/宿主采集；依[解阻清单](../runbooks/release-unblock-checklist.md)和[支付 runbook](payment-provider-production-runbook.md)签署证据，缺项保持阻断。 |
| ECS 切换 | 公网仍是旧 Git SHA；候选不可变镜像和签名证据未部署 | 在上述证据齐全后运行 `npm run typecheck && npm run test:release-gates`、ECS preflight；按[安全同步 runbook](../runbooks/ecs-candidate-safe-sync.md)执行受控发布，并核对 `/api/releasez` 全量身份、`/api/readyz`、运营健康与回滚状态。 |

源码已通过且未修改的定向测试不因这次只读复核重复执行；任何后续代码修改须由 owner 按受影响范围重新验收。上述任一项缺失时判定仍为 **NO-GO**。

## 06:42 UTC 后续开发验收（尚非用户交付包）

- Mac DMG 增加 `install-all.command`，校验本机原版 ChatGPT.app 的签名、公证和架构；缺失时引导到 OpenAI 官方下载页。真实本机原版校验通过，临时未签名 DMG 的挂载布局通过；空工作区明确返回待绑定状态。Windows ZIP 的 `install.cmd` 增加 Microsoft Store 官方应用身份校验与官方安装入口。这两个包均不包含 OpenAI 客户端二进制，也不能替代真实用户机的 ChatGPT 宿主验收。新 Mac 定向测试 3/3、插件安装测试 27/27 通过；新版 Windows 入口的原生 CI 尚未运行。
- 文案草稿生成改为中转调用前按已批准 `text.generate` 费率预留 1 创意点，写入同一 action 的持久授权；确定失败释放、结果未知保持预留。OCR 尚无已批准创意点费率，只有在本地解析失败、即将进入模型 OCR 时返回 503，测试观测中转请求为零。新增 HTTP 定向测试 5/5，相关测试 158/158 通过；OCR 模型能力仍属发布阻断，待费率决策与真实结算验收。
- 中转配置校验不再把配置当作宿主运行成功，也不强制实际 Codex CLI 不发送的 `/models` 请求。隔离 Codex CLI 对自定义 Responses provider 的 SSE 探针通过；尚无工作区计费 Responses 网关，也没有 ChatGPT 桌面 UI 继承该配置的真实证据，不能承诺宿主基础模型请求按创意点扣费或免订阅。
- 运营桌面退款面板经隔离 OIDC/Chrome 验证了平台角色可指定工作区读取记录、工作区角色不发起退款请求，以及不存在记录时服务端拒绝写操作。完整双人退款、真实支付和正式 ECS release 尚未验收。owner 整合后的 `npm run typecheck` 与 `git diff --check` 通过。

上述开发改动尚未重新生成绑定当前干净提交的 Mac/Windows 候选，旧 r5 的哈希和旧 CI 不覆盖这些改动。正式结论仍为 **NO-GO**。

## 07:01 UTC 候选与剩余链路更新

- 安装入口与扣点门禁提交为 `651e85a45fb882f052381a493e5c26b93970aa64`。此提交的 [Windows 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35828068646) 与 [Intel Mac 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35828068871) 均通过；通用 CI 仍在运行，不能算通过。
- 从独立干净源码生成新的 Mac arm64 内部候选 `artifacts/local-plugin/merchant-marketing-0.1.0+codex.20260923132700-darwin-arm64-candidate-651e85a4.tar.gz`，SHA-256 `ce6d32b01e5010c012eb884280ae05bd5cb7beeaa3148eefbe203bbb4825312b`；逐文件来源校验 72/72，`source_dirty=false`，`authenticity_verified=false`，`ready_to_install=false`。临时构建工作树已清理。它仍不能发给客户。
- 多工作区连接的后续开发现已在工作树中完成定向验证：用户显式选工作区；API、授权码、刷新和访问令牌按当前账号绑定及成员状态重验；撤销工作区后旧令牌失效。目标单元/API、隔离 PostgreSQL、类型检查及桌面 Chromium 选择流程通过。生产网页没有安装实例 ID 时明确禁用一键按钮；包内 CLI 登录仍需用户完成授权。该改动尚未形成新的干净提交或生产证据。
- 宿主 Responses 网关仅有**未挂载**的隔离安全框架。真实 Codex CLI 默认发送数组输入、工具字段且没有 `max_output_tokens`，该框架会在发出中转请求前拒绝它。项目也没有已批准的宿主对话创意点费率、专属工作区短期凭据和持久预算适配；不能把此框架当成可使用的 ChatGPT 宿主模型链路。
- 扫描容器只读复核：生产定义已更新到 28132，ClamAV 与 EICAR 检查通过；正式扫描 worker 仍因最近签名 callback 过期而不就绪，公网 `/api/readyz` 仍为 503 `SCANNER_NOT_READY`。须通过受控隔离工作区的真实素材扫描恢复签名回调，不能合成心跳。

这些事实均不改变正式 **NO-GO** 结论。上节 06:42 快照的“尚未重新生成”描述只适用于当时；本节记录了其后的新内部候选。
