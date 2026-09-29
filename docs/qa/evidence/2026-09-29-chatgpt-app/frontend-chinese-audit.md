# Store Nova 前端中文呈现静态审计

日期：2026-09-29。范围：本地插件技能、商家桌面工作台、平台运营桌面工作台中与插件入口、商品表格导入、状态及错误相关的用户可见文本。使用 `codegraph status/query/explore` 定位链路（索引 2,343 文件、33,762 节点），再核对源码。此轮未操作桌面浏览器或生产环境；下述为**静态发现，尚非线上复现或全量验收通过**。

| 优先级 | 发现与源码证据 | 建议及验收 |
| --- | --- | --- |
| 高 | 商家工作台的统一错误说明 `demo/merchant-studio/src/api.ts:903-932` 对未知错误和 `IMAGE_GENERATION_READ_UNAVAILABLE` 直接返回服务端原始 `message`。素材状态 `src/asset-status.ts:20-23`、表格导入 `src/ProductSpreadsheetImport.tsx:115,139,157` 也直接展示 `readiness.reasons[0]`、`parseError`、`cause.message`。这些字段可能为英文，技能的中文规则不能覆盖桌面页面。 | 在显示边界以稳定错误码映射中文说明和中文下一步；保留原始码供复制诊断，不将未识别英文直接放入说明区。用英文上游错误与未知码分别验收。 |
| 高 | 表格导入页 `demo/merchant-studio/src/ProductSpreadsheetImport.tsx:182-194` 可见 `PRODUCT IMPORT`、`revision`、`API`、`SKU` 等英文；与用户询问的 Excel/CSV 上传路径直接相关。 | 把纯装饰标题改为“商品表格导入”，`revision` 改“版本”；`Excel/CSV`、`SKU` 等格式或行业缩写可在中文解释后保留。验证草稿、真实店铺、无权限及解析失败四种状态。 |
| 中 | 商家页面仍有大量纯英文小标题：`demo/merchant-studio/src/App.tsx:4169,4366,5707,7784,10786` 等为 `KNOWLEDGE WORKSPACE`、`KNOWLEDGE BASE`、`PLATFORM & STORE`、`PRODUCT CATALOG`、`MERCHANT COPILOT`；独立组件 `src/main.tsx:37`、`src/DeliveryReadinessPanel.tsx:47`、`src/MerchantMembersPage.tsx:152` 同样如此。 | 统一替换为中文，尤其知识库、店铺选择、商品目录及插件使用提示；对全页面可见文本做桌面浏览器走查。 |
| 中 | 运营任务页 `apps/ops-console/src/pages/TasksPage.tsx:49,92,106` 显示 `WORK QUEUE`、`ACTION CENTER`、`DATA & GOVERNANCE`。 | 改“任务队列”“操作中心”“数据与治理”，保留内部枚举不动。 |
| 中 | 插件技能 `apps/plugin/skills/merchant-marketing/SKILL.md:10` 已明确简体中文规则，但这是模型行为指令；页面、API 原始错误及工具结构化字段不会被这条指令自动翻译。 | App 侧用中文真实调用并检查回复；桌面与 MCP 桥分别审计输出。技术键、方法名、原始 JSON 保持协议原样。 |

已确认的正面边界：`demo/merchant-studio/src/local-plugin-connection.ts:15-24` 对本地插件连接的主要错误码提供中文、可执行的说明；运营表格导入 `apps/ops-console/src/components/stores/ProductSpreadsheetImport.tsx:20-25` 对 ChatGPT 后续步骤也使用中文。其存在不证明整个插件链路均为中文。

本次只写审计报告，未改动正在由其他 agent/会话修改的 `App.tsx`、`api.ts`、表格导入和运营页面；也未运行测试。后续修复须由 owner 复核工作树并在真实 ChatGPT App 与桌面浏览器中验证。
