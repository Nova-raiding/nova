# Demo 101 回归记录（2026-10-06）

## 本轮变更

- 提交：`a102ba649b8990a409e74491971b00e60e4a9e91`
- 修复 `ops-console` 规则生命周期操作的权限门禁：使用 `rule.update`（`canRules`），不再错误使用知识库编辑权限 `customer.content.update`（`canKnowledge`）。
- 新增回归断言，覆盖规则状态更新使用正确能力和错误提示。

## 验证结果

- `merchant-ops-console` 定向测试：17/17 通过。
- CodeGraph 已同步，索引为最新。
- 远端 Ops UI 生产构建（`tsc` + Vite）通过。
- Demo 101 `ops-ui` 已更新到提交 `a102ba64`，镜像：
  `127.0.0.1:5000/storenova/merchant-ops-ui@sha256:49d038b90ed39a0a9b26d603a81a96517484ae6d00e6d7e53fce572b21858373`
- `ops-ui`、API、worker、商家 UI、Redis、Postgres、ClamAV 均 healthy；`/api/readyz` 与 `/ops/healthz` 返回 200。
- gstack 浏览器回归：规则页面可访问，服务端授权已验证，账号角色为 `ops_admin、rules_admin`，六平台规则表和公共草稿分页显示正常。

## 仍然阻断（按设计 fail-closed）

- 六个平台自动签名规则清单未配置；人工导入草稿仍需独立审批和服务端审批令牌，不能仅凭同一账号自批。
- 当前公共规则仍为“人工待审核”，因此商家侧规则查询和生成能力继续阻断，这是预期安全行为。
- 品牌资料确认、真实图片/套图资产交付、真实视频 provider job/receipt 以及原生 ChatGPT 宿主刷新仍缺少正向证据；本轮未伪造成功证据。

生产环境未操作。
