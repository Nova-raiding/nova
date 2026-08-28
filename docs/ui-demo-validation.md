# Merchant Studio UI Demo 验证报告

日期：2026-08-23  
状态：PASS（前端运行回归；不代表真实平台生产连接器已通过）

## 验证环境

- React + TypeScript + Vite
- Node.js 22.23.2
- Vite production build
- gstack headless Chromium
- 视口：1440×900、375×812；额外观察 768×1024、1280×720

## 结果

| 项目 | 结果 | 证据 |
|---|---|---|
| TypeScript 与生产构建 | PASS | 1,803 modules transformed，0 error |
| 概览与五项主导航 | PASS | 可访问树包含语义按钮与页面名称 |
| 内容批准前发布禁用 | PASS | `进入发布`、`勾选后批准内容` 为 disabled |
| 内容批准与发布确认分离 | PASS | 勾选内容批准后才出现“继续确认发布” |
| 发布二次确认 | PASS | 明确平台、商品、写入字段、不修改字段、远端快照 |
| 提交结果语义 | PASS | 返回“发布请求已受理/审核中”，未显示“已发布” |
| 对话框焦点 | PASS | 打开聚焦“返回检查”，Tab 保持在 dialog，Escape 关闭并返回触发按钮 |
| 背景隔离 | PASS | dialog 打开时 `.app-content.inert = true` |
| 移动端侧栏 | PASS | 关闭态不进入可访问树，Escape 可关闭 |
| 移动端横向溢出 | PASS | 375px 下 `scrollWidth <= innerWidth` |
| 控制台错误 | PASS | gstack `console --errors` 无输出 |
| 减少动态效果 | PASS | CSS 实现 `prefers-reduced-motion` |

## 观察与边界

## 可执行运行回归

`tests/merchant-studio-smoke.ts` 提供不依赖 Playwright 的 Node smoke runner：

- 默认生产模式只读取 UI、API health、六个平台账号隔离和商品列表；未配置平台的同步必须返回 `NOT_CONFIGURED`，不会执行外部写入。
- `SMOKE_MODE=fixture` 只允许连接一次性 fixture API，并执行同步、创建任务、方向选择、内容生成、审核、发布预览和发布确认全链路。
- UI 使用 gstack headless Chromium 做真实页面回归；本项目未引入 Playwright 包，因此 CI 的最低门禁使用该 runner，浏览器回归结果另行记录。

示例：

```bash
npm run test:merchant-studio-smoke
SMOKE_MODE=fixture SMOKE_API_URL=http://127.0.0.1:8790 SMOKE_UI_URL=http://127.0.0.1:5174 npm run test:merchant-studio-smoke
```

本次实际验证记录：

| 环境 | 结果 | 覆盖 |
|---|---|---|
| Compose 生产形态 `18081 → 8787` | PASS | UI 200、API health、PostgreSQL ready、六平台独立账号行、未配置同步返回 `NOT_CONFIGURED`；生产模式只读 |
| Fixture API `8790` + Vite `5174` | PASS | 六平台隔离、淘宝同步、创建任务、方向选择、内容生成、审核、发布预览、二次确认；runner 返回 `queued` |
| gstack Chromium 桌面视口 | PASS | 实际点击上述前端主链路，发布确认后进入发布中心 |
| gstack Chromium `375×812` | PASS | `scrollWidth = 375`、无横向溢出、移动侧栏入口可访问 |
| 浏览器控制台 | PASS | 清空旧日志后重新加载，无 console error |

说明：当前 fixture API 只把淘宝标记为可读 fixture，京东、天猫、拼多多、小红书、抖音的同步按设计返回 `NOT_CONFIGURED`；这验证了平台隔离和 fail-closed，不等同于真实官方接口已验收。生产 Compose 首次重建 API 后若 UI Nginx 缓存旧容器 IP，需重启 UI 服务再做回归；这是当前 Compose/Nginx 服务发现运维缺口，不是前端交互逻辑缺陷。

- gstack `responsive` 批量截图在该环境出现 viewport 裁切异常；使用显式 `viewport 375x812` 复测后，媒体查询命中、侧栏隐藏、主内容无横向溢出，因此判定为工具批量截图问题，不是页面布局问题。
- fixture 回归使用一次性 fixture API；不会访问真实平台。生产 Compose 的真实写入开关保持关闭。
- 真正的“架构上线通过”仍需六个平台 profile、50 工作区负载、安全与故障演练证据，详见 `technical-solution-design.md` 的 Go/No-Go。
