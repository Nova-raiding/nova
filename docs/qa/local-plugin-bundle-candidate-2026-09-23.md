# 本地插件打包候选验收（2026-09-23）

结论：**NO-GO，不能把当前候选包作为正式用户安装包或宣布生产上线。** 本记录覆盖 `codex/windows-plugin-bundle` 的本地插件包候选；各条证据以其标注的工件与 CI 运行身份为准。

## 已验证

- 本轮 macOS arm64 内部候选包：`artifacts/local-plugin/merchant-marketing-0.1.0+codex.20260923132700-darwin-arm64-candidate-r4.tar.gz`，SHA-256 `e3ff839495a63e2bc1f9246a80c8c1087d1e6afc4c2e776021415b6efe301bf5`，绑定源码提交 `1d60449ea3b31d3c977831bcd0e23afae9b38622` 且 `source_dirty=false`。固定校验官方 Node 22.16.0 摘要，包含 Keychain helper 与 67 个逐文件 SHA-256 证明；解包后来源校验、MCP 131 个工具发现、缺配置 `workspace.health` 失败关闭通过。包状态为 `unsigned_candidate`、`ready_to_install=false`、`authenticity_verified=false`，**不能交付用户**。早期未绑定源码证明的候选包已被此候选取代。
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
