# 钱包与能力状态矩阵

日期：2026-08-30

## 已落地

`billing.status` 和 `merchant.start` 现在同时返回四项独立事实：余额、套餐剩余次数、生成能力、平台发布能力。每项都有单一状态、原因和阻断编码；平台发布额外返回可用店铺时带的平台与店铺信息。

Merchant Studio 按四项矩阵展示，不再用一个“已解锁/充值后解锁”标签代表所有能力。充值入口只在余额未到账时出现，订单仍由支付回调决定是否到账。

## 门禁语义

- 余额：未到账时为 `recharge_required`。
- 套餐额度：有剩余为 `available`，用尽为 `exhausted`；钱包可承担套餐外模型行动。
- 生成能力：同时受余额和模型配置约束。
- 平台发布：同时受余额、可读取店铺和平台写入门禁约束。

## 验证

- `npm run typecheck --silent`
- `npx vitest run apps/api/src/server.e2e.test.ts demo/merchant-studio/src/delivery-readiness.test.ts --no-file-parallelism`

本项只完成状态投影和桌面展示；真实支付 provider、模型中转和六平台生产 canary 仍是上线阻断项。
