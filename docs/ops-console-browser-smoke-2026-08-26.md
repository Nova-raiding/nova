# 运营台浏览器运行态 Smoke

日期：2026-08-26（Asia/Shanghai）

## 环境

- API：`NODE_ENV=development PORT=18888 npm run dev:api`
- UI：`VITE_API_BASE=http://127.0.0.1:18888 npm run dev --workspace apps/ops-console -- --host 127.0.0.1 --port 4173`
- 浏览器：本机 Google Chrome headless，1440×1200，8 秒虚拟时间

## 结果

- 页面成功加载并读取 API 数据。
- DOM 实际包含：`钱包余额`、`充值`、`平台上线 readiness`、`生产证据 readiness`、`六平台 capability`。
- 页面实际渲染六平台生产阻断状态；未配置中转、支付、OAuth 或 capability/capacity evidence 时保持未就绪/只读，不显示生产通过。
- 自动化运营区域实际渲染，说明只同步扫描、写风险告警、禁止无人值守自动重发。
- 修复 Ant Design `Space`/`Alert` 弃用属性、表格 index rowKey 和延迟挂载表单实例后，浏览器/Vite 控制台无应用告警。

该 smoke 证明本地 API + 运营台运行态和安全口径一致，不替代真实 OIDC、DNS/TLS、支付、平台 canary 或云资源验收。
