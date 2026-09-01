# 知识 hydration 的快照与游标架构

状态：第一阶段已实现；哈希/CAS 与真实 PostgreSQL 验收待完成

## 目标

知识规则、品牌资料、反馈学习建议和竞品观察需要跨 API 副本、进程重启和长时间运行保持一致。当前内存投影只能作为运行缓存，不能作为事实源；最近 5,000 条事件窗口只是安全上限，不能替代完整恢复。

## 数据分层

```text
PostgreSQL outbox_events
        │  (workspace + (created_at, id) cursor)
        ▼
knowledge_hydration_snapshots  ──>  KnowledgeModule 内存投影
        │                                  │
        └── context generation ────────────┘
```

- `outbox_events` 是知识变更的事实事件源。
- `knowledge_hydration_snapshots` 是 workspace 级可丢弃投影快照，不替代事件源。
- `KnowledgeModule` 只保存当前进程的查询索引；重启必须先恢复快照，再回放游标之后的事件。
- 商品事实、规则版本和任务上下文仍按既有 context snapshot 单独冻结，不能由 hydration 快照替代。

## 当前表结构（migration 079）

```sql
CREATE TABLE knowledge_hydration_snapshots (
  workspace_id text PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id text NOT NULL,
  cursor_created_at timestamptz NOT NULL,
  cursor_event_id text NOT NULL,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

当前实现已启用 workspace RLS/强制 RLS，并使用 `(workspace_id, cursor_created_at, cursor_event_id)` 索引；快照写入与 cursor 更新在同一事务内完成，并以 revision、旧 cursor 和单调性条件写拒绝并发覆盖/游标回退。projection hash、schema 校验和跨副本 lease 仍是生产前置增强项。

## 恢复算法

1. 读取 workspace 最新快照；没有快照时从空投影开始。
2. 当前版本校验快照 workspace、事件 envelope/payload 归属和 JSON 数组结构；schema version、projection hash 校验仍待补齐。
3. 从 `(cursor_created_at, cursor_event_id)` 之后按升序读取知识相关事件，单批最多 5,000 条。
4. 若返回 5,000 条且仍有下一页，暂不前移 cursor，继续读取下一批；若存储不可用或事件顺序不连续，fail-closed。
5. 所有增量事件应用成功后写新的 workspace 快照和最后事件游标；快照提交成功后才更新进程内 watermark。
6. 生成请求只使用已完成恢复的投影；恢复中不得使用旧进程投影冒充最新状态。

游标比较必须使用 `(created_at > cursor.created_at) OR (created_at = cursor.created_at AND id > cursor.event_id)`，不能只比较时间戳。事件重复回放必须幂等，不能重复创建规则、学习建议或竞品记录。

## 上下文与成本边界

- hard rules 保留原文、版本、来源和 hash，不截断、不用模型摘要替代。
- 规则检索可以使用摘要/索引，但命中的完整规则才进入生成上下文。
- 任务级输入默认不超过 4,000 tokens；未绑定商品的知识资产不注入任务。
- 快照恢复不把完整历史事件发送给模型；模型只接收当前任务硬事实、适用规则和少量可选参考。
- provider 实际 token usage 以 `action_id + context_hash` 记账；重放同一 context 不得产生无法归属的 usage。

## 一致性与故障策略

| 故障 | 处理 | 禁止行为 |
|---|---|---|
| 快照 hash 不匹配 | 丢弃快照，按游标重建；事件不全则阻断 | 使用未校验投影 |
| 事件窗口满 | 继续 cursor 分页 | 标记恢复完成或静默丢旧事件 |
| 快照写入失败 | 保留旧 cursor，重试 | 只更新内存 watermark |
| 两个副本同时恢复 | workspace lease/single-flight；提交使用版本条件 | 后写快照覆盖前写快照 |
| 事件重复 | 以事件 ID 幂等应用 | 重复追加业务实体 |
| 规则版本过期 | 重新读取适用规则并阻断旧任务生成 | 用旧规则继续发布 |

## 迁移和上线顺序

```text
079 expand table/index/RLS
→ dual-write snapshot（无持久化快照时保留兼容窗口）
→ shadow restore + hash/cursor consistency report
→ feature flag 按 workspace 切换增量恢复
→ 观察重启、并发、失败重试和成本指标
→ cutover 后删除窗口完成 watermark 的兼容逻辑
```

每一步都必须可回滚。快照是派生数据，删除快照不会删除 outbox 事件或商品事实；回滚只关闭新恢复器，不回退业务事件。

## 验收清单

- fresh install 和旧版本升级执行 migration 079，RLS/角色探针通过。
- 5,001 条事件分两批恢复，游标不漏不重。
- 同一时间戳不同 ID 的事件顺序稳定。
- 错误 workspace、事件缺页和窗口上限 fail-closed；快照 hash/CAS/错误 schema 仍待验收。
- 两个 API 副本并发恢复只产生一个有效版本。
- 重启后快照 + 增量事件与全量 replay 结果 hash 相同。
- context snapshot、model usage、task/listing scope 能反查到同一 workspace。
- 本地、Compose、CI PostgreSQL、真实 PostgreSQL 证据分开记录；未配置真实依赖只能标记 skipped。

当前实现状态：已实现 workspace 快照仓储、复合游标增量分页、20 页上限、事件 workspace 校验、revision/旧 cursor 条件写、cursor 单调性和迁移 079；本地回归、类型检查、完整构建和 CodeGraph 通过。快照 hash、schema 校验、真实 PostgreSQL RLS、跨副本恢复和生产数据量演练仍未完成，因此不能宣称知识恢复已达到生产完整性。
