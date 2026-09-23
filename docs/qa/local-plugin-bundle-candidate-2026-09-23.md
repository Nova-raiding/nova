# 本地插件打包候选验收（2026-09-23）

结论：**NO-GO，不能把当前候选包作为正式用户安装包或宣布生产上线。** 本记录对应 `codex/windows-plugin-bundle` 提交 `e7d60129`。

## 已验证

- macOS arm64 内部候选包：`artifacts/local-plugin/merchant-marketing-0.1.0+codex.20260923132700-darwin-arm64.tar.gz`，SHA-256 `c137967fea80563ac1d270440967545cdbce6c6315a275dd1a02cd8d15452823`。内置 Node 22.16.0；Keychain helper 最低 macOS 11；45 个运行时文件与源码清单一致；隔离安装、MCP 初始化与工具发现通过。该 tarball **未完成 Developer ID 签名和公证**。
- [Intel Mac 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35822613692)：`macos-15-intel` 上的 x64 构建、最低系统版本、隔离安装和 MCP 发现通过。上传的工件仅供 CI 验收。
- [Windows 原生 CI](https://github.com/Nova-raiding/nova/actions/runs/35822801940)：临时测试证书下完成自包含 .NET helper 签名、ZIP 校验、包内安装入口、安装缓存中的 MCP 初始化和工具发现、Credential Manager 读写，以及安装后 JS 适配器的长令牌往返。临时测试证书不可用于用户交付。
- 受修改影响的本地 121 项测试和类型检查通过；原有发布门禁测试此前为 1042 通过、16 项按现有规则跳过，本次未因无关代码重跑整个门禁集。CodeGraph 索引已同步，用于定位打包链路及定向测试范围。
- 公网 API 和运营后台 `/healthz` 返回 `ok`；这不代替生产 readiness 或桌面宿主验收。

## 正式交付阻断

1. **macOS 签名与公证：** 发布机须有 Developer ID Application 证书、Apple notarytool Keychain profile 和 Team ID。`build-signed-macos-package.mjs` 只在签名、公证、票据装订、Gatekeeper 验证全部通过后输出正式 DMG。本机构建机没有可用签名身份，正向路径未执行。
2. **Windows 生产签名：** 须有可信 Authenticode 代码签名证书与时间戳服务，并在 Windows 发布环境执行 `build-signed-windows-package.ps1`。目前没有生产证书或签名机访问，尚无正式 ZIP。
3. **真实 ChatGPT 桌面宿主：** 须在目标用户会话按 [宿主验收清单](../chatgpt-host-canary-runbook.md) 验证插件发现、启用、商家登录、`onboarding.status`、MCP 调用、工作区权限及错误证据。当前自动化工具对 `com.openai.codex` 访问受限；CLI 和裸 MCP 通过不能替代宿主证据。[OpenAI 本地插件文档](https://developers.openai.com/plugins/build/plugins)说明 ChatGPT 从个人本地 marketplace 的 `local` 缓存加载插件，但最终仍需桌面端安装和新会话验证。
4. **生产环境 readiness：** 2026-09-23 现场检查中，`merchant-production-api-replica-1` 的 `/readyz` 返回 503 `SCANNER_NOT_READY`，扫描实例就绪数为 0；最新签名回调早于检查时间。扫描门禁保持 fail-closed，须有真实扫描回调恢复证据，不得通过删除数据或降低阈值放行。
5. **全站生产发布证据：** 同一候选版本还需模型中转五模态的真实鉴权、请求、用量、成本和错误证据，以及现有生产发布门禁要求的商家、运营、支付、数据库/RLS、worker、审计证据。参见[生产差距审计](production-launch-gap-manual-local-chatgpt-payment-relay-2026-09-21.md)。

包的安装路径仅使用本地个人 marketplace 与 stdio MCP；没有公开或团队插件市场发布，也没有 ChatGPT OAuth 配置。
