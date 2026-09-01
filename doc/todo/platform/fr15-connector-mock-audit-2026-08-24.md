# FR-15 四平台连接器 Mock 审计

审计日期：2026-08-24  
范围：京东、淘宝、天猫、拼多多；仅覆盖 PRD FR-15 的授权、同步、撤权和连接器统一契约。

## 结论

四个平台均有本地 fixture/mock 流程，但仓库内没有真实平台应用 ID、测试店铺 ID、OAuth client secret、回调配置或官方沙箱回执。因此当前只能证明 connector contract 和错误边界，不能证明真实平台 OAuth、同步、撤权或发布可用。

本轮发现并修复两处不一致：

1. Fake connector 的 `revoke()` 原来是空操作，撤权后仍可同步、写入和查询状态；现在撤权后这些操作统一返回 `UNAUTHORIZED`，重新 exchange code 才恢复 fixture 会话。
2. HTTP connector 原来先调用远端 revoke、后禁用本地凭证；远端撤权失败时本地访问仍可能可用。现在改为先撤销本地凭证，再调用远端 revoke；远端失败仍返回错误，但后续本地同步会被阻断。

## 统一 contract 覆盖

每个平台均覆盖：

- mock authorize
- OAuth code exchange
- full sync 及 cursor
- OAuth 401 归一化
- remote revoke 成功
- remote revoke 503 失败
- revoke 后本地 sync 阻断
- fixture revoke 后 sync/write/query_status 阻断

## 证据边界

`fixture`、`simulated`、`fixture_verified` 不得升级为 `production_canary`。真实账号/沙箱准备仍是外部门禁，需由平台开发者账号、测试店铺、回调域名、最小 scope 和脱敏回执补齐后，才能按 `doc/todo/platform/platform-capability-preflight.md` 验收九项能力（含媒体上传）。

## 验证结果

```text
定向连接器测试：38/38 通过
全量测试：60 个文件，314/314 通过
TypeScript：通过
公开 connector 导出运行验证：4/4 平台通过
```

## 完整下游 Mock E2E

新增 API 级四平台闭环回归：

```text
Mock 授权 → 商品同步 → 事实确认 → 主图生成/审核 → 创建任务
→ 方案确认 → 详情内容生成/审核 → 版本/导出 → 内容批准
→ 发布预检 → 二次确认 → 模拟平台回执 → 工作区指标
```

京东、淘宝、天猫、拼多多各自生成 1 个商品、1 个内容任务、1 张主图和 1 个模拟发布回执。运行中所有回执均保留 `simulated=true`；撤权后同步返回 `PLATFORM_ACCOUNT_REAUTH_REQUIRED`，重新授权后恢复。

本轮同时修复 fixture 重新授权只恢复数据库状态、未刷新 Fake connector 凭证的问题。包含后续素材人工事实确认回归后，最新全量结果为 61 个测试文件、320 个测试全部通过。
