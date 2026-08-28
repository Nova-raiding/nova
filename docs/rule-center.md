# 规则中心最小闭环

## 当前边界

规则中心由 `packages/review/src/rule-center.ts` 提供不可变规则版本注册表，`packages/application/src/service.ts` 负责把它接入内容审核和应用层读取。

- 每个规则包可拥有多个不可变版本，版本以 `packId@version` 作为内部稳定身份。
- 每个版本包含适用范围、来源、来源核验时间、规则检查摘要、SHA-256 校验摘要、创建人和修订号。
- 同一规则包最多只有一个 `active` 版本；启用新版本会先将旧版本置为 `inactive`，再启用新版本。
- `publish` 只能创建新版本，禁止覆盖已有版本；状态变更必须带操作人和原因。
- `created`、`activated`、`deactivated`、`expired` 均写入审计事件，历史按创建顺序保留。
- 内容审核读取当前 active 版本的禁用词，并校验内容版本引用的规则版本仍然可用；不存在或已停用时 fail-closed。

## API 边界

现有 `GET /v1/rules` 继续作为商家端只读接口，返回当前规则版本及其来源和校验摘要；`GET /v1/rules/audit` 仅限规则管理员。规则维护 API 使用 `/v1/rules/{packId}/versions` 创建不可变版本，并使用 `/status` 完成启用、停用和过期。

规则维护者的应用层能力为：

- `MerchantService.publishRuleVersion(...)`
- `MerchantService.setRuleStatus(...)`
- `MerchantService.listRuleHistory(packId)`
- `MerchantService.listRuleAudit(packId?)`

管理接口已接入规则维护者 RBAC、持久化审计表和审批流：生产创建/状态变更必须由 `rules_admin` 操作，激活要求审批证据和职责分离，所有变更必须追加审计；数据库仓储不可用时写操作 fail-closed。

## 验证

- `packages/review/src/review.test.ts`：版本不可覆盖、启停互斥、历史、来源摘要、审计事件和失效规则 fail-closed。
- `packages/application/src/service.test.ts`：应用层读取规则、发布新版本、切换 active 版本及审计查询。
- 前端构建验证规则中心展示只读边界、版本修订、来源和核验时间。

## 后续生产化门禁

当前审计日志是应用层内存闭环，随进程重启不会保留。生产上线前需要将规则版本和审计事件落入 PostgreSQL（或等价不可变审计存储），并为规则维护者补充 RBAC、审批、回滚和审计查询 API；在此之前不得宣称规则中心具备生产级跨重启审计能力。
