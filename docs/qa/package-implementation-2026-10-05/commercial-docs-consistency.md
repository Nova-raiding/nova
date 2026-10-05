# 套餐文档一致性核对（DX-T4/T5）

日期：2026-10-05。仅修改文档，没有修改业务实现或执行生产写入。

## 文档变更

- `README.md`：新套餐候选总览与四手册/需求/实施证据入口；人工转账独立就绪和 exact 商业恢复范围。
- `docs/product-usage-guide.md`：通知、首次两行结算、当前/未来已购、权益包、剩余期升级、改价、开户、指定客户代购、真实收款分配、余款/退款与错误恢复；商家 Web 与 Ops 工作区职责。
- `docs/store-nova-chatgpt-plugin-install-manual.md`：当前候选 manifest、实际安装与缓存区别、三组兼容矩阵、就绪环境首次只读成功目标/计时表、独立复测及没有业务标识的支持登记。
- `docs/commercial-executable-spec.md`：删除“固定5000/2000门槛”“新周期升级”“历史approved即售卖”“人工模式要求线上通道”等旧矛盾；同步价格版本、原到期升级、首购依赖、收款/返款及候选边界。修正含空格与括号的历史来源链接 Markdown 括号格式，保留其历史出处。

代码读取基线：`189135dba07232efddc1c310a0d77731256c904b`，含本轮未提交工作树实施变化。manifest：`0.1.0+codex.20261005113527`。文档明确要求最终验收重新绑定最终 SHA、镜像、实际安装插件、数据库和证据，没有宣称这一读取基线是最终发布候选。

## 已完成的静态验证

1. 读取真实 shared MCP schema、商家/运营购买 handler、`commercial-payment-mode.ts`、`merchant-support-request.ts` 及 server 支持路由。确认 `POST /v1/support/requests`、`GET /v1/support/requests/{ticket_id}`，支持仓储有/无分别 available/blocked；客户身份来自 active 成员，未知登记沿原键获取真实 receipt。
2. 两个安装手册 JSON-RPC 只读形状调用实际 `validateMcpRequest`，输出：

```text
onboarding.status readonly-schema:valid
commercial.catalog.get readonly-schema:valid
```

该验证只执行纯 schema，不调用真实 API、ChatGPT 或业务写入。

3. 新增/修改 43 个本地文档/源码链接存在性通过；四文件 fenced blocks 成对；旧固定售价/新周期升级/历史两档唯一套餐/线上通道强制等精确矛盾扫描通过。
4. 四手册 `git diff --check` 通过；没有为文档变更重复执行业务测试。

## 仍需真实验收

DX-T4 文档同步和静态一致性已经完成；DX-T5 首次成功耗时仍为 unknown，≤5分钟仅是已授权、已安装绑定及读取依赖就绪后的只读查询/桌面对照目标。安装/配置/权限准备单独计时，blocked 记录负责人。三组实际安装兼容矩阵、配置缺失/无权/非法字段恢复、无订单首次支持登记与客户回复、跨账号企业隔离、未知原键恢复待独立安装/支持人员实测。

上架通知、真实银行/启用线上支付、分配/授予、升级与续购/未来周期、worker、RLS、真实中转及生产桌面闭环独立验收。schema、路径存在、fixture 和 health 200均不替代真实完成。
