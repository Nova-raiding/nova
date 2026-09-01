# 工作包 03：接入交付与人工服务履约

主责：后端/业务流程 owner

唯一需求依据：[商家营销插件商业化与 AI 创意点 PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)

实现约束依据：[商业化架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标与边界

把 PRD 已明确的一次性接入内容、培训、1V1、效果复盘、常规响应承诺和专属服务做成可审计的人工排期、工时与交付记录。此工作包不创造预约取消、爽约、时长取整、保修、自动 SLA 赔付或容量阈值。

## 范围

- 一次性 5000 元接入订单对应的账户开通、系统部署/基础调试、固定规则接入、一次培训、上线验收、基础问题处理和首次资料录入 checklist/event/evidence。
- 首次录入受订单权益快照中的品牌/店铺上限约束；只覆盖 PRD 列明的六个平台，非标准平台和 ERP/PIM 不进入通用流程。
- 连续 6 个月每月 500 点建模为 6 笔独立、幂等、可审计 grant schedule；起算日与每笔到期日未确认前只能保存草稿，不激活生产调度。
- private test 的 1 小时 1V1、一次效果复盘和 7 天资格/抵扣事实；重复购买资格和抵扣会计规则未确认时保持阻断。
- 月套餐服务权益：基础版最多 5 小时 1V1、工作日 4 小时响应；增长版最多 10 小时、工作日 2 小时响应、每月一次复盘；定制版只读取订单/SOW 明确值。
- 人工服务事件：排期、开始、完成、实际工时、交付证据、actor、reason、revision 和 audit；服务可用性仍受统一创意点门禁和独立 capability 控制。
- 接入/知识/品牌/规则/扫描已有实现只作为执行适配器；不得以静态 checklist、fixture 或本地数据证明真实交付完成。

## 禁止冻结的规则

- 不实现 PRD 未批准的时长取整、取消/爽约扣费、跨期自动退款、保修、自动赔付、首次导入窗口或容量销售阈值。
- 不把接入验收等同于赠点起算；未确认日期必须显式显示 pending decision。
- 不把“响应承诺”扩展成全天候在线、非工作时间紧急服务或复杂 SLA 引擎。
- 不提供无限改稿、人工代做全部素材、整套营销策划、日常代运营、大量历史清洗或内部系统开发。

## 契约与验收

1. 服务 allocation/event 绑定 workspace、订单/权益快照、服务类型、账期、actor、revision 和 evidence；跨租户、超权益或 revision 冲突 fail-closed。
2. 同一接入订单的 6 笔 grant 各有稳定自然键；调度/回调重放不重复发放，且支付/grant/access revision 事务边界由工作包 01 保证。
3. 零点时服务预约和其他履约业务入口拒绝；只允许 PRD 的客服恢复入口，且其 capability、范围和审计独立验证。
4. private test 未授权用户看不到 SKU 或服务事实；授权用户也只能看到自身 workspace 的排期与证据。
5. 服务记录支持人工更正，但必须保存 before/after、reason、actor、expected revision 和审计；禁止静默覆盖历史。
6. E1 覆盖精确权益值、状态转换、幂等、权限、零点阻断和未决配置阻断。
7. E2 使用真 PostgreSQL 验证 RLS/FORCE、并发工时写入、grant schedule 重放、事务回滚和审计不可变。
8. E3 在正式 ChatGPT 插件和 1440px Ops 中验证接入/培训/1V1/复盘的真实排期与证据读取；外部交付证据缺失保持未完成。

## DX 交付

- 提供实施/客服开发者的状态表、字段字典、幂等键、未决配置说明和排障 runbook。
- 提供 pending configuration、scheduled、in progress、completed、evidence missing、revision conflict、permission denied 与 zero-points blocked 的 E1 fixture；fixture 不计真实履约。
- 值班可按 workspace/order/service event/requestId 查询完整链路，不需要读取客户内容或数据库裸表。

## 依赖与完成定义

- 依赖工作包 01 的订单/权益/点数和工作包 02 的统一门禁；工作包 04 消费服务 DTO；工作包 05 验证迁移与真实证据。
- 完成条件：没有未授权服务规则，E1/E2/E3 通过，所有“已完成”状态均有真实 actor、时间和 evidence；服务容量能否销售仍由人工运营与发布门禁判断。

## 不包含

专项增值服务产品化、平台连接器开发、ERP/PIM、私有化、人工代做、大量历史清洗、手机或平板适配。
