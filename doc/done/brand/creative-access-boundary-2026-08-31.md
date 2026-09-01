# 创意 Brief/预览品牌访问边界

## 状态

已完成本地代码与自动化验收；不代表生产上线完成。

## 已交付

- `creative.brief` 和 `creative.preview` 在同工作区商品校验后统一执行 `enforceProductBrandAccess`。
- `catalog.image.generate` 同样统一调用 `enforceProductBrandAccess`，覆盖主图生成与计费入口。
- 品牌授权校验早于插件钱包校验，未授权商品不会触发模型调用或计费扣款。
- 增加受限成员访问隐藏品牌商品的 MCP 否定测试，三个方法均返回 `PRODUCT_NOT_FOUND`。

## 验证

- `security.e2e.test.ts` + `product-image-review.e2e.test.ts` + `feature-gap.e2e.test.ts`：78/78 通过。
- `npm run typecheck -- --pretty false`：通过。
- `npm run build:ops-console`：通过。
- `git diff --check`：通过。
- CodeGraph：781 files / 10,912 nodes / 40,655 edges；仍报告 1 个待同步新增文件，需结合文档/未跟踪文件状态复核。

## 未覆盖

真实 OIDC、Postgres/RLS、模型中转、ChatGPT 宿主和生产发布门禁仍需环境验收；完整创意视觉能力继续保留在 `doc/todo`。
