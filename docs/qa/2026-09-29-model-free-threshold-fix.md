# 模型成本免费阈值缺陷与修复记录

日期：2026-09-29。状态：源码修复已完成本轮统一测试、类型检查及 PG 临时表验证；**尚未部署，Windows 尚未复验，不代表线上计费规则已经生效。** 本报告不覆盖其他验收报告。

## 缺陷证据

真实 Windows 单次文本生成使用 `qwen3.8-flash`，provider 成本 `0.00090156 CNY`，却结算 1 创意点。服务端唯一 usage / provider request 各 1，reservation `cpr_a60d49be-70c8-491a-9ddb-d999fe9ebba1`。详见[生成回执](evidence/2026-09-29-windows-remote/generation-server-ledger.txt)和[创意点账本](evidence/2026-09-29-windows-remote/generation-points-ledger.txt)。该结果证明旧路径实际扣点，不证明本次修复已上线。

## 修复规则与范围

- 已验证实际成本 **小于 0.1 CNY** 时，模型生成创意点结算为 0；**等于或高于 0.1 CNY** 时按原预留点数结算。免费指客户创意点，provider 成本、真实用量和预算证据仍保留。
- 普通结算 `model-relay-usage-runtime.ts` 和补偿核对 `model-usage-reconciliation.ts` 共用 `model-point-settlement-policy.ts`，写入策略版本 `model.cost_cny_free_lt_0_1.v1`。
- 补偿核对使用已验证、匹配 workspace / operation / provider request / model / modality / token 的原始 provider 回执，沿用原 receipt hash。阈值按原始数值精度判断，不用六位小数的 usage 数据库列替代。例：`0.09999999` 即使入库显示 `0.100000`，仍应免费；`0.10000001` 应收费。缺失、非数值、负数、未验证或不匹配回执保持阻断，不能自动免费或重写回执掩盖差异。
- `creative-point-lifecycle-repository.ts` 的交付 SQL 增加合法 0 点结算路径：仅 text / image / image_edit / video，原始成本在 `[0,0.1)`，账本及结算操作策略版本匹配；继续核对两侧回执、成本、用量、请求、唯一性、结算状态和无撤销记录。精度比较采用原始回执，并核对六位小数入库值。
- OCR 保留现有专用规则和费率版本，不用普通模型策略替代。**零余额仍在调用前预检阻断**；本次修复没有免除预留、权限、成本上限或交付证据要求。

## 验证证据分层

| 层级 | 当前证据 | 边界 |
| --- | --- | --- |
| 源码单项测试 | [reconciliation 日志](evidence/2026-09-29-windows-remote/free-threshold/storenova-model-reconciliation-threshold.log)显示当时 1 文件 22 项通过。 | 本机源码测试；后续代码仍有变化，不代表最终集合或 Windows 通过。 |
| owner 统一源码测试 | [owner 测试日志快照](evidence/2026-09-29-windows-remote/free-threshold/sn-free-threshold-owner-tests.log)已出现 6 文件 129 项通过摘要。 | owner 已确认进程完成、exit 0，**6 文件 129 项通过**；这是源码测试，不代表线上或 Windows 已生效。 |
| 类型检查 | [初次日志](evidence/2026-09-29-windows-remote/free-threshold/sn-free-threshold-typecheck.log)、[后续日志快照](evidence/2026-09-29-windows-remote/free-threshold/sn-free-threshold-typecheck-final.log)。后者可见 worker 测试 mock 缺少 receiptHash 的 TS2345。 | 保留此前 exit 1 的失败历史；mock 补齐后，[最终完整日志](evidence/2026-09-29-windows-remote/free-threshold/sn-free-threshold-typecheck-complete.log)对应 `npm run typecheck`，owner 已等待并确认 exit 0，当前类型检查通过。 |
| worker 回执契约 | mcp_contract 报告新增真实 hash 契约覆盖的 27 项测试 exit 0。 | agent 报告层级；本报告未独立运行这些测试，不等同生产 worker 验收。 |
| 改动格式检查 | owner 确认 `git diff --check` exit 0。 | 仅格式检查，不代替业务运行。 |
| 真实 PostgreSQL 临时表 | [SQL](evidence/2026-09-29-windows-remote/free-threshold/sn-free-delivery-pg-check.sql)、[输出](evidence/2026-09-29-windows-remote/free-threshold/sn-free-delivery-pg-check.log)包含 34 项 PASS，最后 ROLLBACK。 | 真实 PG 执行交付查询，使用事务临时表与构造样例；不是生产业务数据生成测试，不是修复部署或真实 Windows 复验。 |

PG 样例覆盖免费边界、等值 0.1 拒绝 0 点交付、付费原逻辑、原始精度、OCR 排除、缺策略、未验证回执、非法数值及 worker / ledger / operation / 入库值不一致。SQL 使用 `ON_ERROR_STOP`、异常断言和最终 `ROLLBACK`，不修改真实业务账本。

## 尚未完成

1. 本次可按 [ECS demo 直接部署手册](../runbooks/ecs-demo-direct-deploy.md)执行 demo 修复发布；正式部署器的旧版回滚胶囊、15 场景证据及故障修复路径限制，不应一概作为本次 demo 修复的前置阻断。当前实际待办为：尚未冻结精确候选、尚未完成本次适用的 release gates 与迁移兼容核查、尚未部署。因此 Windows 尚未验收新免费行为；本机测试通过不表示线上规则已更新。
2. 审查并部署对应服务端候选，再在真实 Windows ChatGPT 插件链路复验免费阈值与交付，保留原始 provider、用量、成本、点数和结算证据。
3. 真实多模态和全部插件工具尚未完成验收，本机测试及 PG 临时表验证不能替代。
4. **旧调用已扣的 1 点尚未返还。历史账务补偿需要独立运营审批和可审计的返还操作，不能由源码修复自动视为退款完成。** 本报告未执行退款、部署或 GUI 操作。


## 历史扣点补偿提案

owner 已准备 [compensation-draft.json](evidence/2026-09-29-windows-remote/free-threshold/compensation-draft.json)，状态 `not_submitted`，拟通过 `ops.commercial.points.adjust.propose` 提案补偿 `+1` 创意点。`expected_revision=null` 是待真实读取的占位，不能直接提交；提交前须读取当前 revision、核查是否已有同笔补偿，并由有权限的运营人员提案、**不同的授权运营人员审批**。该文件是草案，不是已提交提案、已审批或已返还证据；不得直接修改余额。


## 后续核查补充：迁移兼容与最终舍入修复待验证

以下为 owner 本轮核查及协作进展记录，尚不构成部署或最终验证成功证据：

- 线上 `schema_migrations` 最高为 **254**；当前 main 新增 **255 品牌表迁移**，迁移 **1–254 未修改**。这说明候选与线上存在迁移差异，仍须核对本次发布兼容性，不能据此认定迁移已经执行。
- live API 的 `RUN_MIGRATIONS_ON_STARTUP=false`，但未配置 `BRIDGE_SCHEMA_COMPATIBILITY_MODE`；五个业务 worker 的这两个键均缺失。**兼容模式尚未上线**，缺键不能当作兼容配置生效。
- 最终复核发现 JavaScript `toFixed(6)` 与 PostgreSQL 十进制半入舍入结果存在边界差异。mcp_contract 已在 reconciliation 中新增基于 BigInt 的十进制舍入及边界测试；该新变更的测试仍在共享锁队列等待执行。
- **上文 129 项、worker 27 项与 typecheck 已通过记录仅对应此前代码，不覆盖这次最终舍入变化。** 新变更尚无最终测试通过结论，不应沿用旧结果称最终候选已验证。
- owner 已启动 release gates，但仍在排队、尚未完成。候选冻结、迁移兼容核查、部署及真实 Windows 免费行为复验仍未完成；补偿草案仍未执行。
