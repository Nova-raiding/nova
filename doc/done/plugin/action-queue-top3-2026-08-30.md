# 商家问题可执行队列

日期：2026-08-30

## 已落地

Merchant Studio 首页不再只展示“需处理问题”总数。服务端风险项现在以首屏最多三项的优先队列呈现，每项显示影响对象、平台/店铺范围、当前状态、下一动作和“查看并处理”入口；超过三项时明确提示剩余数量。没有风险时显示“暂无需要你处理的问题”。

队列只提供查看和进入商品/任务范围的动作，不自动重试、自动修复或自动发布；技术诊断仍由服务端风险证据和详情链路承载。

## 验证

- Merchant Studio production build 通过。
- Merchant Studio UI 契约测试 3/3 通过。
- TypeScript 类型检查通过。
- `git diff --check` 通过。
- `npm run release:metadata:validate` 通过。
- CodeGraph 已同步：750 files、11,173 nodes、46,253 edges。

真实 Codex App 中的风险详情跳转和通知到达仍需宿主 canary 证据，因此本文件只证明桌面工作台的本地/API 投影完成。
