# Merchant Studio UI

面向付费商家的商家工作台前端，覆盖概览、商品事实、营销任务、版本差异、规则检查、人工批准、平台二次确认和发布回执。

这不是仅供开发调试的演示页：本目录由 `infra/docker/ui.Dockerfile` 构建为 `merchant-ui` 镜像，在 `infra/kubernetes/base/ingress.yaml` 中绑定 `host: yxsona.com` 的 `path: /`（ECS/Compose 路径见 `infra/nginx/pilot-gateway-https.conf` 的 `location /`），商家访问 `https://yxsona.com/` 的落地页就是这里的运营概览。因此界面上的余额、额度、用量等数字必须来自服务端 API；服务端未提供的数据源必须以“未读取/待接入”呈现，不得写入看起来像真实测量值的固定数字。

## 运行

```bash
npm install
npm run dev
```

生产构建：

```bash
npm run build
npm run preview
```

本机如果同时安装了多个 Homebrew Node，需确保 `node` 与 `npm` 来自同一版本。例如：

```bash
env PATH=/opt/homebrew/opt/node@22/bin:/usr/bin:/bin npm run build
```

## 说明

- 配置 `VITE_API_BASE_URL` 后，商品列表、京东/淘宝/天猫/拼多多同步、任务创建、内容审批和发布确认会调用 API；未配置时保留明确标注的离线演示回退。
- 界面上有入口不等于当前上线档可用：当前 profile 为 `manual`，六平台不接 OAuth，运营未建立人工店铺记录时商品同步与正式任务返回 428 `STORE_ONBOARDING_REQUIRED`，平台同步返回 `NOT_CONFIGURED`；发布确认走的是 HTTP `/v1/publish-preview` 与 `/v1/publish-jobs`，但当前档的正式发布由运营在官方商家后台人工完成（这也正是插件侧把 `publish.*` 设为隐藏工具的原因）。商业准入未满足时（零创意点余额、无月付套餐权益）相关按钮会被服务端拒绝，错误码见 [产品使用介绍](../../docs/product-usage-guide.md)。
- 生产前端还需要通过 BFF/OIDC 注入工作区身份；本地联调可设置 `VITE_WORKSPACE_ID` 和短期 `VITE_API_TOKEN`，不要把长期服务 token 打进公开静态站点。
- 真实发布必须先从商品列表选择目标商品和已授权平台账号，打开弹窗时先取得服务端 `publish-preview`；没有真实预览或账号绑定时确认按钮保持禁用。
- 平台官方凭证或写入开关未配置时，API 会明确返回 `NOT_CONFIGURED`，不会产生外部写操作。
- 发布确认已演示内容批准与平台写入二次确认分离、字段 diff、远端快照、loading 和受理回执语义。
- 概览页的平台能力证据卡片显示 authorize/read/full_sync/incremental_sync/create/update/query_status/revoke 八项能力状态；`test_e2e` 和 `production_canary` 明确区分，未配置 API 时不会使用演示数据冒充证据。
- 设计依据见 `doc/ui-research-and-design-rationale.md`，设计 token 基线见 `design-system/merchant-studio/MASTER.md`。
