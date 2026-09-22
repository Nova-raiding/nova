# Store Nova 本地插件一键连接计划

## 目标

把商家后台“连接本地插件”弹窗中的手工命令，升级为可见、可验证的一键连接流程：网页按钮唤起已安装的 macOS 或 Windows Store Nova 连接助手，助手完成浏览器授权、系统凭据库写入和本地插件绑定，页面显示最终连接状态。

## 已确认前提

- ChatGPT 侧继续采用本地直装、stdio 插件链路，不接入公开或团队插件市场。
- 网页不能直接执行 shell；一键连接通过已安装助手注册的自定义 URL 协议完成。
- URL 只携带一次性连接请求标识、工作区和回跳信息，不携带密码、access token、refresh token 或 API 密钥。
- 服务端授权必须短时效、单次消费、绑定当前商家账号、单一工作区、PKCE/nonce 和本地安装实例。
- 长期凭据只由本地助手写入 macOS Keychain 或 Windows Credential Manager；网页只显示状态和恢复路径。
- 服务端连接协议、安装实例公钥绑定和审计字段必须平台无关，明确支持 `macos` 与 `windows`。

## 用户流程

1. 商家点击“连接 ChatGPT 本地插件”。
2. 页面向服务端创建一次性连接请求。
3. 页面打开 `storenova://connect?...`；macOS 或 Windows 要求用户确认打开 Store Nova Helper。
4. Helper 读取请求，生成 PKCE，打开同源浏览器确认页并完成授权。
5. Helper 用一次性 code 换取本地凭据，写入钥匙串，并运行本地 bridge 验证。
6. 页面轮询连接请求状态并显示“已连接 / 需安装 / 已过期 / 被拒绝 / 验证失败”。
7. 成功后提示重启 ChatGPT 或重新加载本地插件，并提供 `onboarding.status` 验证说明。

## 实现范围

- 商家后台：按钮、安装检测、连接状态机、错误恢复和无障碍交互。
- API/MCP：一次性连接请求、状态查询、交换与消费门禁、审计事件。
- 本地插件：macOS/Windows URL scheme helper、系统凭据库写入、bridge 自检、安装/升级注册。
- 打包：助手随本地插件安装包交付，不进入云端前端镜像。
- 测试：契约、重放、跨租户、过期、取消、未安装、钥匙串失败、浏览器 E2E 和安装包验证。

## 不在范围

- ChatGPT OAuth、插件市场上架、Linux helper、手机和平板适配。
- 自动保存用户密码、在 URL 中暴露凭据、网页远程执行本地命令。

## 验收

- 已安装用户从点击到钥匙串写入不需要复制命令。
- 未安装用户得到明确下载/安装路径，不误报“已连接”。
- 同一连接请求只能消费一次，换账号、换工作区、过期或重放全部 fail-closed。
- 浏览器页面、API 审计、本地 helper 和 MCP `onboarding.status` 四处证据一致。

## GSTACK REVIEW REPORT

**结论：DONE_WITH_CONCERNS。** 一键连接的网页、请求状态机、PKCE/Keychain Helper、安装包校验和跨层测试已经实现；但不得在生产默认开启。

- 架构评审：复用既有 loopback PKCE 与 macOS Keychain，不创建第二套 OAuth；浏览器只持有不透明 `request_id`，任何长期凭据只返回本地 Helper。
- 安全评审：`storenova://` 自定义协议可被其他 macOS 或 Windows 应用抢占。签名/公证或 Authenticode 只能证明应用来源，不能单独解决 scheme 劫持。跨平台生产路径采用“安装实例公钥绑定 + 挑战签名 + 已签名 Helper”；系统支持时可再叠加 Universal/App Link。
- 产品评审：页面的 `exchanged` 只表示本地凭据已就绪，不能宣称 ChatGPT 已加载插件；真实完成仍需重启/新会话并调用 `onboarding.status`。
- 发布策略：`LOCAL_PLUGIN_ONE_CLICK_ENABLED` 默认关闭；未显式启用时创建请求返回 503。当前 CLI 登录仍是生产正式路径，Helper 仅为开发与恢复预览。
- 数据与权限：连接请求短时效、单次消费、绑定账号/身份/工作区；RLS、CAS 状态迁移和身份审计均落库，重放、跨账号与跨租户 fail-closed。

## 当前运行态复核

- 发布门禁复跑：154 个测试文件通过、7 个既有 PostgreSQL 测试文件按清单跳过；1023 项断言通过、16 项按清单挂起。
- 全量 TypeScript 检查通过，`git diff --check` 通过。
- 线上 `https://yxsona.com/api/healthz` 与 `https://ops.yxsona.com/healthz` 当前返回 `status=ok`；本次未把未签名 Windows Helper 或默认关闭的一键连接开关部署到线上。
- 线上健康输出仍显示 embedding provider 缺失、production evidence 路径未配置；这些不是本次连接功能的成功证据。
