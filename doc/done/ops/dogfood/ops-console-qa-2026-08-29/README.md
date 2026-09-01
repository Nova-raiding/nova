# Ops Console 浏览器 QA（部分执行）

- 状态：BLOCKED / 用户要求停止扩展
- 日期：2026-08-29
- 目标：独立 Ops Console `http://127.0.0.1:18082`
- 明确排除：商家 UI `http://127.0.0.1:18081`
- 浏览器：gstack browse（Playwright/Chromium）

## 环境证据

- `local-api-1`：`8787 -> 8787`，Docker health 为 `healthy`
- `local-ui-1`：`18081 -> 8080`，这是商家 UI，不计入本报告
- 独立 Ops Console：本地 Node 进程监听 `127.0.0.1:18082`
- Ops Console 首页请求：`GET http://127.0.0.1:18082/` 返回 HTTP 200

## 已完成检查

1. 实际打开独立 Ops Console 首页，确认不是商家 UI。
2. 获取首页可访问性树和标注截图。
3. 确认首页存在运营 API 地址、工作区 ID、操作员 ID、API Token 配置控件，以及刷新、模型服务、审计导出和告警刷新操作。
4. 首页浏览器控制台检查：`no console errors`。

截图：[initial.png](screenshots/initial.png)

## 未完成范围

以下验收尚未执行，因此不能宣称通过：

- 12 个页面逐页导航和功能状态
- 配置表单提交、校验及真实 API 请求/响应
- 每页刷新行为
- 移动端菜单打开、关闭和导航
- 375px 移动视口及桌面视口横向滚动检查
- API 失败的网络响应、鉴权、服务或持久层根因分类

## 当前结论

独立 Ops Console 服务可访问，首页渲染正常且未产生控制台错误。由于测试在首次页面取证后被主动中断，本报告仅证明首页烟测结果，不代表 12 页发布验收完成。
