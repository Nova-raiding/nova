# JIT 临时授权实时到期体验

## 结论

已完成 JIT 桌面状态展示的本地切片：运营台顶部对有效临时授权显示实时倒计时；到期由定时器触发会话刷新，重新获取服务端授权投影，避免继续依赖过期的前端状态。无有效或已过期授权时不显示活动授权标签。

## 实现

- `RoleScopeBar` 使用服务端 `temporary_grants`，不展示票据正文或敏感凭据。
- 倒计时按秒更新，剩余时间向上取整；到期只通知一次。
- `OpsConsoleController` 到期后先调用 `clearAuthorizationScopedData()`：使旧加载失效、取消用户请求、清空服务端数据集/筛选/选择/session，再触发 `model.load()` 重新裁剪能力和数据集。
- 授权中心执行 JIT 撤销后同样先清空当前 Ops 数据，再刷新 session；撤销当前会话或当前工作区 grant 不会继续沿用旧前端快照。
- 使用 session ref 作为加载真源，修复 React 状态更新尚未提交时 `clear -> load` 仍捕获旧 JIT session 的竞态。
- 保留现有服务端 TTL、撤销、max-use、exact workspace scope 和 worker 执行时复核。

## 验证

- 权限 UX、Header、workbench transition：15 tests passed。
- Ops Console 全量回归：67 files / 314 tests passed；生产构建通过（3197 modules transformed）。
- TypeScript 与 `git diff --check`：通过。
- session race 修复后的定向回归：10 tests passed；CodeGraph index complete / `pendingRefs=0`。

## 边界

本切片证明本地桌面倒计时与刷新触发，不等于真实浏览器读屏、生产 OIDC、生产审计 sink、真实撤销竞态和所有敏感数据清除路径已验收；整体仍为 NO-GO。
