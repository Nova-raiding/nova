# 批量任务未知状态的受控交互

## 结论

已完成：Merchant Studio 的批量任务控制在 `unknown` 或 `reconciling` 状态下不再显示暂停、恢复或重试入口，只保留刷新状态，并明确提示平台结果尚未确认。

这样可以避免把“结果未知”误当成失败，进而重复提交或改变仍可能在外部执行的任务。

## 代码与测试

- `demo/merchant-studio/src/CampaignLifecyclePanel.tsx`
- `demo/merchant-studio/src/campaign-lifecycle.test.ts`

覆盖：

- `unknown`：所有变更操作关闭
- `reconciling`：所有变更操作关闭
- `paused`：只允许恢复，不显示暂停
- 未知状态使用独立中文状态和人工核对提示

## 验证

- Merchant Studio 生命周期测试：8/8 通过
- Merchant Studio 任务视觉契约：通过
- Merchant Studio 生产构建：通过
- Ops Console：58 个测试文件、255 项通过

## 边界

这是桌面工作台交互门禁；真实 Codex App 宿主中的未知状态展示和真实平台对账仍需外部证据。
