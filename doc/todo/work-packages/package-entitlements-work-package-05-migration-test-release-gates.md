# 工作包 05：迁移、测试、生产证据与上线门禁

主责：开发者 5（QA/SRE/发布）
依据：[PRD](../product/package-entitlements-and-services-prd-2026-08-31.md)、[架构](../architecture/package-entitlements-and-services-architecture-2026-08-31.md)

## 目标

验证五个工作包能在真实 ChatGPT 插件、API/MCP、数据库/RLS、Worker、桌面 Ops 和外部依赖中安全运行，并把“已完成”与“可销售”严格分开。

## 范围

- 109+ expand→backfill→shadow→dual-write→workspace cutover→contract；legacy task/add-on/trialing capability/resource/import/storage opening。
- E0 静态、E1 单元/属性/契约、E2 真库/RLS/Worker、E3 staging ChatGPT/Ops 沙箱、E4 production canary/真实回执。
- 对支付、Relay 五模态、对象存储/KMS/scanner、六平台五能力、发布回执和 evidence registry 做验证与门禁；这些能力的实现责任分别归工作包 01/02/03，不在本包重复开发。
- 10,000 workspace、20 品牌/100 店铺/100,000 资产、200 并发生成、50 发布、20 Worker、24 小时 soak。
- runtime evidence release/commit/digest/workspace/capability/hash/signature/expiry/replay、销售可售矩阵和 Deal Desk 门禁。

## CodeGraph 复用证据

- migration runner、PostgreSQL workspace transaction、RLS/FORCE probes、backup/restore。
- durable Outbox、Redis queue、lease/dead-letter、公平 claim、现有 model/storage/publish/support/Ops/Plugin smoke。
- release metadata、生产 preflight、capability evidence、现有 affected tests 和桌面 dogfood 套件。

## 验收与硬门禁

1. fresh install、逐版本 upgrade、重复迁移、shadow diff、账本/资源/manual_attention 均为 0 才 cutover；V2-only workspace 禁止旧二进制回滚。
2. 跨租户、重复 grant/扣款/发布、额度超卖、unknown 自动重试、fixture/过期证据 ready、scanner 未通过发布均为 P0 fail。
3. E3 用正式 ChatGPT 插件和 1440px Ops 验证权限、刷新、409、unknown、键盘/屏幕阅读器；E4 逐供应商真实回执。
4. soak 错误率 <0.1%、账本/配额差异 0、队列 10,000→<100/15 分钟、DB 连接 <80%、replica lag p99 <5s、服务容量 ≤80%。
5. 对外字段 100% 来自 active snapshot；价格/费率/毛利、法务文案、平台/模态 evidence、SOW 和容量全部通过才允许 `production_sellable`。

## 估算、依赖与风险

- 估算：146–206 团队人日（E1–E11 的验证/门禁投入，包含五位主责的协同时间与 QA/SRE/安全/销售支持，不应误读为开发者 5 单人工作量）；关键路径约 10–14 周，取决于外部环境。
- 由第 1 天起建立 E1 契约和 E4 环境；最终 cutover/E4 验证依赖工作包 01/02/03/04 达到各自 E2/E3，不形成“实现包等待最终 E4”的循环。
- 风险：外部开户等待、旧数据缺证据、双写差异、真实成本/平台回执缺失、长稳资源成本、销售提前承诺。

## 不包含

供应商开户和平台审批等待、缺失外部适配器的开发、业务数据删除、手机/平板、ERP/DAG、用 fixture 替代生产证据。

## 五人分工总览

| 开发者 | 主工作包 | 估算 |
|---|---|---:|
| 1 | 商业目录/订阅/权益/资源核心 | 56–82 人日 |
| 2 | Runtime/MCP/平台/发布 | 45–65 人日 |
| 3 | 搭建/导入/服务/SLA | 68–91 人日 |
| 4 | Ops/ChatGPT 前端 | 78 人日 |
| 5 | 迁移/测试/证据/门禁（验证责任；不重复实现其他包） | 146–206 团队人日 |

计划：工作包 01 先冻结 shared contract；02/03 可在其后并行；04 在 DTO 冻结后并行；05 从第一天建立 E1 测试和 E4 环境，待 01–04 汇合执行 E2–E4。总工作量约 393–522 人日，表示五个工作包及其必要协同投入的总量，不是五人各自独立满负荷的简单相加；按五人主责和阶段性协同，关键路径约 16–21 周，外部等待和全链路门禁决定实际日历。
