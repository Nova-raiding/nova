# 图片任务 UI 契约对账

日期：2026-08-31

## 结论

已复核并更新图片任务桌面 UI 审计中的过期测试结论。当前 `task-visual-contract.test.ts` 与 Merchant Studio 实际任务对话、图片任务发现、状态播报、候选选择和恢复入口一致，专项测试 3/3 通过；文档不再保留已失效的“2 项失败”结论。

## 边界

这只是源码契约与文档状态对账完成，不代表真实 Provider、对象存储、网络故障、权限矩阵或正式 ChatGPT 宿主验收完成。完整图片 UI 审计继续保留在 `doc/todo/ops`。

## 验证证据

- `npx vitest run --no-file-parallelism demo/merchant-studio/src/task-visual-contract.test.ts`：3/3 通过。
- `npm run build:ops-console`：通过。
