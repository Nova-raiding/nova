# 生产商家桌面只读巡检

时间：2026-09-29 17:37 CST。工具：gstack browse，桌面浏览器独立标签页。网址：`https://yxsona.com/`。使用商家 `demo@sn.com` 正式登录；没有选择文件、上传、登记店铺或改变业务数据。

## 实际观察

| 页面 | URL | 结果 |
| --- | --- | --- |
| 账号菜单 | `/merchant/overview` | 登录账号 `demo@sn.com`，企业主体 `QA-DO-NOT-PUBLISH-20260929-120826`，状态“已启用”；创意点余额“未读取”。账号显示名为“Store Nova 测试”。 |
| 品牌资产 | `/merchant/products?section=assets` | “上传品牌资料”可打开“上传素材”弹层；目标为“未归属工作区素材”，分类为“品牌资料”，无文件时“确认上传”禁用。弹层多文件选择器的 `accept` 包含 `.xlsx,.csv`，可选原始表格；另一个“选择文档并解析”的单文件选择器不含 `.xlsx`。这两个入口不是同一种处理流程。 |
| 财务概况 | `/merchant/finance` | 剩余创意点“未读取”，钱包 ¥0.00，最近已入账充值“未查到”，流水 0 个数据点；人工发布状态“读取失败：服务暂不可用”。未看到每月 5000 点权益证据。 |
| 店铺与商品 | `/merchant/products?section=products` | 六个平台均显示 0 家店铺，总计 0 家；点开京东后提示可登记识别信息，但登记不代表 OAuth 授权、商品读取或发布权限。 |

## 未通过项

1. **生产版本仍缺少上传前置门禁说明。** 弹层只说“上传文件仍需完成安全与权益确认后才能使用”，未告知当前创意点余额“未读取”会阻断上传。已改动的本地版本不能作为生产通过证据。
2. **生产版本仍有英文可见标题。** 观察到 `DAILY BRIEFING`、`BRAND ASSETS`、`BRAND SETTINGS`、`MATERIAL UPLOAD`、`ACCOUNT & BILLING`、`CREATIVE POINTS`、`MANUAL PUBLISH`、`PLATFORM & STORE`。与全中文要求不符。
3. **XLSX 入口语义不一致。** 素材上传接受 XLSX，而“选择文档并解析”不接受 XLSX；界面应明确原始素材入库与解析商品事实的差别。此巡检没有上传，所以不能宣称知识库成功入库。
4. **该商家没有已登记店铺，也没有可读取的创意点余额。** 店铺绑定或费用资格不可判定为通过。

## 截图

- [账号菜单](account-menu.png)
- [品牌资料上传弹层](brand-upload-modal.png)
- [财务概况](finance.png)
- [店铺列表](shop-list.png)

本报告只覆盖网页商家工作台，不能当作 ChatGPT 桌面插件调用成功证据。
