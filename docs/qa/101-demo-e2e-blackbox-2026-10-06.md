# 101 Demo 部署后 E2E 黑盒回归

- 日期：2026-10-06（Asia/Shanghai）
- 范围：101 Demo 公网桌面入口；仅回归既有记录未覆盖的入口/边界路径
- 目标：`https://yxsona.com/`、`https://ops.yxsona.com/`
- 发布证据：`/api/releasez` 返回 `ready=true`，release `release-82151d7f`；商家与 Ops `/healthz` 均 HTTP 200
- 方法：真实 Chromium 黑盒浏览，未读取源码，未使用有效账号，不伪造登录或业务写入

## 本轮覆盖

已跳过已有记录覆盖的商家概览、知识库、商品目录、规则库、营销任务，以及已通过的上传、交付和文本生成路径。本轮只检查：

1. 商家登录页空提交、无效凭据和错误提示
2. Ops 登录页无效凭据和错误提示
3. `admin.yxsona.com` 与 `ops.yxsona.com` 的入口隔离
4. 未登录直接访问受保护路由和不存在路由
5. 首屏网络请求与控制台错误

## 结果摘要

| 项目 | 结果 |
|---|---|
| 商家空提交 | 通过：两个字段显示必填校验，未发起成功会话 |
| 商家无效凭据 | 通过：停留登录页并显示“登录未完成 / 账号或密码错误” |
| Ops 无效凭据 | 通过：停留登录页并显示“登录失败 / 账号或密码错误” |
| 未登录受保护路由 | 通过：回到对应登录表单；未获得页面数据 |
| `admin.yxsona.com/login` | 失败：展示商家登录页，未展示平台运营登录页 |
| 未登录首屏网络 | 失败：固定请求 3 个不存在的 `local-session` 路径，均 404 |

## 续测记录（2026-10-06 下午）

使用已授权的 Demo 平台运营账号进入 `ops.yxsona.com/ops/rules`，确认规则草稿表格和游标分页可见；gstack Chromium 页面无控制台错误。用户提供目录中的五个平台 ZIP 已在此前记录为解析成功，当前公共草稿仍显示“人工待审核 / 校验通过”。

尝试审批一条已核对的拼多多草稿时，服务端返回 `RULE_APPROVAL_INVALID`。API 日志显示平台工作台请求 actor 为导入者 UUID、工作区上下文为 `unknown`；Demo 审批凭证已按最小范围配置到 `unknown` 与 `ws_guirenniaoniao`，但服务端仍拒绝凭证，因此没有批量激活，也没有绕过分离职责校验。该项仍为业务阻断。

按 Demo 评估脚本尝试授予 `ws_guirenniaoniao` entitlement 时，当前连接的数据库没有该工作区记录，脚本安全终止且未写入；没有把额度不足伪装成生成能力通过。

受影响的本地回归结果：`npm run typecheck`、`npm run test:ecs-bridge-255-store`、`npm run test:pg16-migration-compatibility` 均通过。首次并行 release-gates 运行被会话以 143 中止，未将整体门禁标记为通过。

## 问题

### DEMO-E2E-001（高）：admin 登录入口错误地呈现商家工作台登录

- 复现：
  1. 在桌面浏览器打开 `https://admin.yxsona.com/login`。
  2. 页面标题/文案为“欢迎使用 Store Nova”。
  3. 表单标签为“商家账号 / 密码”，按钮为“登录商家工作台”。
- 实际：`admin.yxsona.com/login` 与 `yxsona.com/` 展示同一商家登录面。
- 预期：按当前项目的域名职责，`admin.yxsona.com` 应进入平台管理员/运营后台登录；运营登录当前在 `ops.yxsona.com/ops/overview`。
- 影响：平台管理员从约定的 admin 域名进入错误身份入口；若直接输入运营凭据，会被错误表单拒绝，造成入口职责混淆。
- 证据：[`admin-domain.png`](../../.gstack/qa-reports/screenshots/101-demo-2026-10-06/admin-domain.png)
- 复核：同一浏览器先后访问 `admin.yxsona.com/`、`admin.yxsona.com/login` 均复现；`ops.yxsona.com/ops/overview` 正确展示“平台运营账号”登录。

### DEMO-E2E-002（中）：未登录首屏固定请求不存在的 local-session 路径

- 复现：
  1. 清空当前页面错误记录。
  2. 打开或刷新 `https://yxsona.com/`。
  3. 查看网络请求。
- 实际：每次首屏至少出现以下 404：
  - `https://ops.yxsona.com/api/v1/ops/local-session`
  - `https://yxsona.com/api/v1/ops/local-session`
  - `https://ops.yxsona.com/ops/api/v1/ops/local-session`
- 预期：未登录商家页不应请求不存在的 Ops local-session 端点；若是兼容探测，应由现网提供明确的 401/404 处理并停止重复探测，避免把预期未登录状态污染为资源错误。
- 影响：首屏产生可重复 404 噪声，增加监控误报和不必要请求；当前不阻断商家登录页渲染。
- 证据：[`merchant-initial.png`](../../.gstack/qa-reports/screenshots/101-demo-2026-10-06/merchant-initial.png)
- 复核：清空 console 后 reload，3 条请求再次出现 404；`/api/v1/auth/session` 的 401 属于未登录预期，不单独计为问题。

## 阻断与未覆盖

- 本轮已用平台运营凭据完成 Ops 规则页桌面浏览；由于审批凭证分离职责仍被服务端拒绝，没有执行规则激活。商家已授权的 MCP stdio 只读探针仍显示工作区暂无可执行规则/品牌偏好，商业 entitlement 也未形成可用证据。
- 未覆盖路径：需真实账号才能验证的商家工作区数据、Ops 权限菜单、真实模型调用、支付/账务写入和发布确认；这些不是本轮可安全伪造的黑盒证据。

## 健康评分

本轮只做未覆盖路径回归，不把未登录预期 401 计为缺陷。按报告规则估算：Console 70（可复现 404 请求）；Links 100；Visual 100；Functional 85（admin 入口问题）；UX 90；Performance 90；Content 90；Accessibility 100。加权健康分：**89/100**。
