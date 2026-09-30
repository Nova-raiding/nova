# 插件升级后钥匙串读取失败与授权工作区不一致：只读调查

时间：2026-09-29，调查范围为本地直装 Store Nova 插件与独立商家 `demo@sn.com` 的 QA 工作区 `ws_57fd2361ed5b44c7891f3d37`。没有读取或打印访问令牌、刷新令牌或密码；没有修改钥匙串、浏览器会话、插件配置或生产数据。

## 已证事实

- Owner 在 15:27:48 版直接启动插件 bridge 时见 `MCP_CREDENTIAL_SOURCE_INVALID`；下层 `readKeychainCredential` 见 `MCP_KEYCHAIN_HELPER_INVALID`。辅助程序已经构建。本调查没有重试读取其凭据内容。
- 按代码规定的 `SHA-256(api_origin + "\\n" + workspace_id)` 算出钥匙串 account，仅查询 `com.storenova.merchant-mcp` 条目**元数据**，返回存在；创建时间约 12:20，最近更新时间约 14:54。条目并非被安装升级自动删除。
- 当前 15:35 版缓存中的 `keychain-credential-helper` 通过 `codesign --verify`；签名类型为 `adhoc`，无 TeamIdentifier。安装脚本每次在版本化缓存中调用 `swiftc` 重新编译并替换 helper。旧版缓存已移除，无法比较旧/新二进制身份或重现旧版读取。
- `defaultHelper` 仅给子进程 2 秒；任何非零退出、超时或启动错误都统一包装成 `MCP_KEYCHAIN_HELPER_INVALID`。Swift helper 也只输出笼统的 `keychain operation failed`，不保留 `SecItemCopyMatching` 的 OSStatus。因此现有错误**不能证明**具体是 Keychain ACL、锁屏、用户授权弹框超时、辅助程序运行环境还是其他 Security.framework 错误。版本化路径与 adhoc 签名使 ACL/授权失配成为明确候选。
- CodeGraph `explore readKeychainCredential MCP_OAUTH_WORKSPACE_AMBIGUOUS` 定位 Keychain 凭据按 API origin+workspace 隔离，`loadManagedToken` 在 bridge `tools/list` 之前加载它；读取失败会让插件发现中断。这能解释“已安装但 App 工具不可见”，但不能把它视为已证明的唯一原因。
- 既有 `demo@sn.com` 商家 HTTP 会话再次读回 `active` 且只拥有 QA 工作区。Chrome 的浏览器会话与此 cookie 文件独立。服务端 `MCP_OAUTH_WORKSPACE_AMBIGUOUS` 在已登录账号不拥有请求中的工作区、工作区参数缺失，或授权 resource/workspace 不匹配时返回。Chrome 当前在登录界面；之前的该错误与浏览器曾用其他商家身份或旧授权链接一致，但具体历史身份没有只读证据，不能断言。

## 合法恢复顺序

1. 在当前浏览器登录**商家** `demo@sn.com`，在商家后台核对账号及唯一 QA 工作区；不要使用 `demo@ys.com` 或贵人鸟工作区。不要沿用先前失败的授权 URL，它包含一次性 PKCE 状态。
2. 从**当前已安装**插件目录重新发起本地登录 CLI：`node scripts/login-local-macos.mjs --base-url https://yxsona.com --workspace ws_57fd2361ed5b44c7891f3d37`。若使用商家后台一键连接，需先确认服务端一键连接开关、安装实例与 QA 工作区均匹配；当前 README 明确 CLI 是本地开发/旧版安装维护路径，不将其误报为面向全部商家的正式一键入口。
3. 授权页必须显示 `demo@sn.com` 和 QA 工作区；授权完成以本地 CLI 报告 Keychain 保存成功为准。若再次得到 `MCP_KEYCHAIN_HELPER_INVALID`，停止重试并记录辅助程序在**图形用户会话**下的退出状态/Keychain 系统错误码；不要删除已有条目、关闭严格鉴权、改用环境变量明文令牌或借用其他商家工作区。
4. 只有凭据保存成功后才完整退出并重开 ChatGPT，在真实项目新 Work 会话先调用 `onboarding.status({})`，核对 QA 工作区及账号，再继续业务测试。

后续代码改进方向：为 helper 使用升级间稳定的可信签名身份；把 Keychain 返回的错误码转为不含凭据的诊断；为真实用户授权弹框留出合理等待时间并保留 fail-closed。上述为根因候选的改进建议，本轮未修改代码或部署。
