# 商家桌面图片生成入口

## 状态

本地桌面 UI、MCP 调用契约和构建验收完成；真实媒体生产链路仍需外部验收。

## 已交付

- 商品列表提供“生成图片”入口和结构化确认弹窗。
- 复用 `catalog.image.generate`，按素材是否存在选择 `optimize/create`，数量限制为 1–6。
- API 未配置、事实未确认、店铺身份异常或 canonical 状态不可用时 fail-closed。
- 提交后跳转真实 `image_job` 深链；明确显示生成不等于可发布。

## 验证

- Merchant Studio 相关契约测试：36/36 通过。
- `npm run typecheck -- --pretty false`：通过。
- `npm run build:merchant-studio`：通过。
- `git diff --check`：通过。
- 图片任务详情终态读取会正确清除 `aria-busy`，不会因停止轮询而永久禁用刷新；相关 UI 契约与轮询策略测试 6/6 通过。

## 未覆盖

真实图片模型、对象存储、扫描、生产 OIDC、ChatGPT 宿主和桌面浏览器真实环境验收仍在 `doc/todo`。
