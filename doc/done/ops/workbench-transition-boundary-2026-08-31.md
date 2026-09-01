# 双工作台切换边界

## 结论

已完成双工作台切换的本地代码切片。platform/workspace 候选只来自服务端 session 投影；切换前显式清理授权数据/session，随后取消旧请求、持久化 workbench、更新 URL，并通过 keyed runtime 获取新的 session snapshot，旧响应不能回填当前运行时。

## 验证

- workbench transition、权限 UX、load coordinator 定向回归通过。
- Ops Console 全量测试 67 files / 314 tests 通过，生产构建通过。
- TypeScript、diff check、CodeGraph index complete / `pendingRefs=0` / `worktreeMismatch=null`。

## 未闭环

当前没有统一的跨页面 dirty-form 注册机制，因此“切换前确认未保存表单”仍未声称完成；真实 OIDC 双角色、浏览器多尺寸、RLS 和生产 canary 仍待验收。
