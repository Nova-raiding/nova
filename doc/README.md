# 项目文档索引

本目录是项目文档唯一归档位置。旧 `docs/` 目录已迁移并删除；业务代码、测试和真实运行证据仍是完成度判断的权威来源。

## 目录规则

- `doc/done/<功能>/`：该功能已满足项目定义的上线验收条件，并保留代码、测试、运行环境和回滚证据。
- `doc/todo/<功能>/`：设计、审计、部分实现或仍缺真实外部证据的文档。只有同一功能所有验收项闭合后，才允许迁移到 `done`。
- `doc/todo/quality/implementation-status.md`：当前实现与上线门禁的累积审计日志。

## 当前权威入口

- [能力矩阵](todo/quality/capability-matrix-2026-08-30.md)
- [需求完成矩阵](todo/quality/requirements-completion-matrix-2026-08-25.md)
- [实现状态与上线门禁](todo/quality/implementation-status.md)
- [发布检查清单](todo/release/release-checklist-0.1.1.md)
- [主链路架构](done/architecture/main-chain-architecture-2026-08-30.md)
- [Canonical 切读设计](todo/data/canonical-product-cutover-design-2026-08-29.md)

## 迁移约束

本地单测、fixture、静态契约或 Compose 通过不能单独证明生产上线。涉及 PostgreSQL/RLS、对象存储、模型中转、平台 OAuth/回读、计费、Worker、正式 ChatGPT Host、备份恢复和发布 artifact 的功能，必须保留真实证据；缺失时继续放在 `todo` 并标记 `NO-GO`。
