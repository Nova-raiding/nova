# 可逆写入与预期阻断：已安装插件安全拒绝核验

验收时间：2026-09-29。插件版本：`merchant-marketing@merchant-local 0.1.0+codex.20260929125100`。本轮启动**已安装插件的 stdio bridge**，依次执行 `initialize`、`tools/list`、10 次 `tools/call`。`tools/list` 返回 116 项，下表 10 项均确实对商家暴露。此轮是插件工具层证据，**不是 ChatGPT App 界面调用证据，也不计为业务正向通过**。

独立进程固定 `MERCHANT_WORKSPACE_ID=ws_57fd2361ed5b44c7891f3d37`、`MERCHANT_MCP_BASE_URL=https://yxsona.com`、`MERCHANT_MCP_WRITE_ENABLED=false`、`DEPLOY_ENV=local_desktop`、`MERCHANT_STRICT_AUTH=true`、`MERCHANT_ALLOW_FIXTURE_FALLBACK=false`。访问及刷新令牌均为空，令牌来源为 `environment`，以免调用意外进入远端业务。执行前 `launchctl getenv` 的工作区、写入开关、令牌来源分别为同一 QA 工作区、`false`、`keychain`；独立进程没有覆盖 ChatGPT App 的配置。

| 类别 | 工具名 | 本轮参数 | 实际工具层结果 | 给 App 主控的安全参数 |
| --- | --- | --- | --- | --- |
| 可逆写入 | `platform.store.alias.set` | `{}` | `isError=true`，`INTERACTIVE_WRITE_DISABLED` | `{}` |
| 可逆写入 | `catalog.product.disable` | `{}` | 同上 | `{}` |
| 可逆写入 | `catalog.product.enable` | `{}` | 同上 | `{}` |
| 预期阻断 | `commercial.service-boundary.accept` | `{}` | 同上 | `{}` |
| 预期阻断 | `workspace.invitation.accept` | `{}` | 同上 | `{}` |
| 预期阻断 | `commercial.order.create` | `{}` | 同上 | `{}` |
| 预期阻断 | `workspace.deactivate` | `{}` | 同上 | `{}` |
| 预期阻断 | `workspace.activate` | `{}` | 同上 | `{}` |
| 预期阻断 | `workspace.data.delete.request` | `{}` | 同上 | `{}` |
| 预期阻断 | `multimodal.image.edit` | `{}` | 同上 | `{}` |

每项结构化中文消息相同：“当前操作需要商家明确确认。请先确认后继续；如果创意点余额为零、待确认或不足，系统只会返回服务端授权的恢复入口。”桥接器先检查写入会话，再检查参数、调用 `callRemote`；本轮在前置门禁返回，故按此代码路径不会转发给 API。未调用 `workspace.interactive.confirm`，未打开短时写入窗口，未提供可命中业务对象的 ID，未创建订单、删除请求或模型任务。未做服务端表/审计读前后差异，因此“无副作用”结论限于插件拒绝路径，不能代替数据库审计证明。

App 主控若要复测，逐项请求精确工具名和 `{}`，并检查原始会话中真实 `tools/call` 与 `INTERACTIVE_WRITE_DISABLED` 返回；若宿主因工具 schema 拦截缺必填参数，则该项应记“App 未调用／schema 拦截”，不可记为插件拒绝。不要为了满足 schema 补真实对象、订单 SKU、删除范围或有效确认口令。正向路径需独立 QA 资源、前置确认与读回审计，当前未完成。
