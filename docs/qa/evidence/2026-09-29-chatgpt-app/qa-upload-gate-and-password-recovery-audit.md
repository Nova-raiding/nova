# 独立 QA 商家素材上传阻断与改密路径

时间：2026-09-29。账号：`demo@sn.com`；唯一工作区：`ws_57fd2361ed5b44c7891f3d37`。本次没有读取或输出会话凭据、密码或令牌，也没有直接修改数据库。

## 素材上传

- 上传前 `GET /api/v1/auth/session` 确认账号为 `demo@sn.com`、类型为 `merchant`、状态 `active`，仅绑定上述 QA 工作区。上传前 `GET /api/v1/assets` 为空。
- 桌面商家端 `uploadAsset` 使用 `POST /v1/assets/upload`，原始文件体、Excel MIME、`x-asset-name` 原文件名、同源会话 Cookie。按该合同仅尝试上传 `/Users/lixiaomei/Desktop/纪梵希.xlsx11111.xlsx` 原件一次。
- 服务端返回 HTTP 503 `CREATIVE_POINTS_UNAVAILABLE`，请求 ID `5ff39fe7-2544-49a0-bc51-e41032612215`，没有资产 ID。随后 `GET /api/v1/assets` 仍是 0 项。
- 因正式接口的商业门禁阻断，未尝试第二份 `/Users/lixiaomei/Desktop/迪奥.xlsx`，也未走其他路径或租户。两份文件均未完成上传。

## 正式改密路径

- `demo/merchant-studio/src/App.tsx` 的右上账号菜单提供“修改密码”，要求当前密码和新密码，调用 `demo/merchant-studio/src/api.ts` 的 `changeMerchantPassword`。
- 对应 `POST /v1/auth/password/change` 在 `apps/api/src/http-password-auth-routes.ts`：需要有效 `damai_session` 与 JSON `{current_password, new_password}`。成功响应 `{changed:true, login_required:true}` 并清除当前 Cookie；当前密码错误返回 403 `AUTH_CURRENT_PASSWORD_INVALID`。
- `packages/persistence/src/password-auth-repository.ts` 使用 Argon2id 存储新密码。策略为 8～256 位且包含字母与数字；用户指定的新口令符合该策略。成功时账号与身份的 `auth_epoch` 均加一、撤销此账号全部密码会话，记录 `platform_identity_events` 事件 `auth.password_changed`、`sessions_revoked:true`。此前签发的本地插件 MCP 凭据会因 epoch 不匹配而失效，需重新登录并通过正式本地插件绑定流程授权。
- `POST /v1/auth/password/reset-request` 在生产仅返回 `accepted:true`，重置 token 仅测试模式返回。代码中未发现生产 token 投递实现，也未发现 Ops 对既有账号的密码重置 UI/API；`reset-confirm` 需要有效一次性 token。此链路目前不能独立完成生产重置。
- 当前再次只读检查 `GET /api/v1/auth/session`：账号仍 active、唯一 QA 工作区、失败登录次数 2、未锁定。仓储登录逻辑在第 5 次失败后锁定 15 分钟，不应继续猜测原密码。若通过受控凭据来源合法取得现有密码，使用上述正式改密路径，然后只读验证新登录、唯一 QA 工作区、审计事件与旧凭据失效。

本次仅进行了现有会话读回及上述一次正式素材上传尝试；**没有执行改密**。
