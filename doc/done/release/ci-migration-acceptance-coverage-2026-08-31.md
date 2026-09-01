# CI 数据库迁移验收覆盖（已完成代码配置）

日期：2026-08-31

## 完成内容

当前发布迁移链为 001–100。CI 的 PostgreSQL 验收步骤已覆盖新增的 `migration-083.test.ts` 至 `migration-100.test.ts`，与已有 081/082、迁移完整性和专项 PostgreSQL 验收一起执行，避免数据库迁移新增后只通过静态链路而未进入 CI。

发布入口同时由 `tests/quality-entrypoints.test.ts` 和 `tests/supply-chain-reproducibility.test.ts` 断言 CI 必须包含最新迁移 100，并自动检查 083–100 的每个迁移测试文件均出现在 CI PostgreSQL 验收命令中。

## 验收证据

- 质量入口与供应链复核：8/8 通过。
- `npm run test:release-gates`：57 个测试文件通过、1 个跳过；322 项通过、6 项跳过。
- 当前迁移尾由 `release-metadata.json` 声明为 100。
- `git diff --check` 通过。

## 边界说明

本文件证明 CI 配置和门禁覆盖已完成；真实 CI PostgreSQL 服务、生产数据库角色、锁等待、WAL/副本延迟和 PITR 仍必须在对应环境执行，不能由本地发布门禁替代。
