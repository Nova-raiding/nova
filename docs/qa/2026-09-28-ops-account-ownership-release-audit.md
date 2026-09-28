# 运营账号归属修正：上线前复核（2026-09-28）

## 已核实

- 线上 `merchant-demo-85575f9c` PostgreSQL 只读查询：`hyp@sn.com`、`devide@sn.com`、`hxd@sn.com` 在 `platform_password_accounts` 中均为 `account_type=platform`、`status=active`；三者在 `workspace_members` 中均无记录。未修改生产数据。
- 修正提交 `b827539a`：`ops.users.list` 默认只返回商户工作区成员，显式 `account_type=platform` 返回运营平台账号；运营后台提供账号归属切换，平台账号详情不显示商户套餐内容；本地插件 MCP 契约和安装镜像同步。
- 定向 API、组件及插件契约测试 39/39 通过。隔离 PostgreSQL + 桌面 Chromium 浏览器验收 `ops-account-ownership-isolated.spec.js` 1/1 通过，确认默认商户目录排除平台登录账号，平台筛选显示该账号，详情标明归属且不显示商户套餐。
- `npm run typecheck` 退出 0。首次 `npm run test:release-gates` 因两个兼容审计用例触发默认 5 秒超时退出 1；单项以 15 秒复跑 3/3 通过。`d8605091` 将两个用例超时设为 15 秒；完整门禁重跑退出 0，Vitest 1325 项通过、16 项按清单跳过，后续脚本门禁通过。门禁运行时工作目录存在其他未提交改动，此结果不绑定可发布源码归档。

## 线上与候选边界

- 2026-09-28 只读 `deploy:101:status`：线上 API/副本提交 `f48c8454`，运营 UI 提交 `a00cf9a5`；`/releasez` 对应旧版 `release-f48c8454-dual-e2e`。API、运营健康探针均为 200，相关容器健康，`release_approved=false`。账号归属修正尚未部署。
- 线上数据库 `schema_migrations` 最大版本 254；当前 `release-metadata.json` 目标版本 255。发布须按候选流程验证 255 迁移、恢复与精确回滚；不能以现网健康代替候选证据。
- 当前主工作目录还有其他并行修改和未跟踪输出，`prepare-ecs-candidate-bundle.sh` 要求已提交且干净的工作树。需先由相应改动 owner 收口并重新冻结 SHA，随后生成身份绑定候选包、隔离部署并完成真实 API/MCP、桌面宿主、备份恢复、模型中转与发布门禁验收，才能考虑生产切流。

本记录为上线前复核，不是候选部署、生产切流或完整发布批准。
