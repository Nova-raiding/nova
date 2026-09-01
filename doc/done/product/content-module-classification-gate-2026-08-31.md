# 内容模块分类信任门禁

## 状态

本地代码与自动化验收已完成；生产模型和平台验收仍未完成。

## 已交付

- 模型生成的每个内容模块必须声明 `fact`、`creative` 或 `pending`。
- `pending` 模块必须包含非空 `pendingReason`。
- 缺失或非法分类会进入有界结构修复；无法修复时拒绝交付，避免生成结果绕过事实/创意/待确认分层。
- 旧持久化内容仍由应用层只读归一化，不改写历史版本。

## 验证

- `generator.test.ts`、`service.test.ts`、`version-vector.test.ts`：156/156 通过。
- `npm run typecheck -- --pretty false`：通过。
- `git diff --check`：通过。
- CodeGraph 已同步到 781 files / 10,912 nodes / 40,658 edges；工具仍报告 1 个 pending added file，未将索引误写为完全 clean。

## 未覆盖

真实模型质量评测、生产 relay、平台最终审核和 Codex 宿主验收仍属于 `doc/todo` 的外部门禁。
