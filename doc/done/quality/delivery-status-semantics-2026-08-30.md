# 交付状态语义修复（2026-08-30）

## 完成范围

- 商家工作台的平台字段检查不再把“有 finding 的 passed”显示为“已通过”。
- 字段检查状态统一为：`approved`、`blocked`、`unverified`。
- 运营后台的“生产发布”状态要求连接、读写权限、服务端 readiness、媒体上传 readiness 以及 production canary 同时满足；否则显示阻断。
- `/v1/platform-capabilities` 仅投影已批准、桌面端、未过期的媒体规格证据；缺失或不合格数据不会被伪造成可用。

## 代码证据

- `demo/merchant-studio/src/delivery-readiness.ts`
- `demo/merchant-studio/src/DeliveryReadinessPanel.tsx`
- `apps/ops-console/src/components/sections/overview/PlatformReadinessSection.tsx`
- `apps/api/src/platform-capability-response.ts`

## 验证证据

- 定向测试：4 个文件、13 项通过。
- TypeScript 类型检查：通过。
- Merchant Studio 生产构建：通过。
- Ops Console 生产构建：通过。
- 发布门禁：48 个文件通过、309 项通过、6 项跳过。
- `git diff --check`：通过。

## 未宣称事项

本文件只记录本地代码、测试和构建已完成的状态投影修复，不代表真实 ChatGPT 宿主、平台 OAuth、平台读写、媒体上传、支付或生产模型中转证据已经完成；这些门禁仍在对应 todo 文档中。
