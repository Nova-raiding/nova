# 商家数据来源边界

日期：2026-08-30

## 已落地

Merchant Studio 商品列表按来源区分“官方 API、演示数据、商家导入、服务端数据”，不再把所有非官方 API 数据统称为演示数据。API 返回的商品全部为演示数据时，列表上方会明确提示：这些商品不属于商家店铺，也不会发布到真实平台。

离线模式继续使用独立的演示工作区；真实 API 读取失败时保留失败态，不回退到静态示例商品。商品表的来源、平台、店铺和事实状态同时展示，避免只靠页面底部说明判断数据真实性。

## 验证

- Merchant Studio production build 通过。
- Merchant Studio 视觉契约测试 3/3 通过。
- TypeScript 类型检查通过。
- `git diff --check` 通过。
- `npm run release:metadata:validate` 通过。
- CodeGraph 已同步：750 files、11,173 nodes、46,252 edges。

真实平台数据读取和宿主验收仍需外部证据；本文件只证明本地桌面工作台的数据来源展示和失败回退边界完成。
