# GitHub Commerce Skill 复用审计

日期：2026-08-26

## 结论

本次检索没有发现一个可以直接接入本项目、同时覆盖京东、淘宝/天猫、拼多多、小红书、抖音的 OAuth、商品/SKU 写入、媒体上传、批量发布和远端回执闭环的现成 skill。因此没有把第三方浏览器脚本或 Shopify/Wix API 代码伪装成平台连接器。

> 该审计的产品范围已与当前六平台目标一致；文中若出现“四平台”属于引用的历史竞品/审计资料，不代表当前支持范围。

项目继续复用自己的平台无关领域合同，并只吸收外部 skill 的可迁移方法：商品/变体快照、批量操作的原子性、素材与 SKU 明确绑定、SEO/GEO 结构化字段和人工确认门禁。

## 检索结果与采用边界

| 来源 | 可借鉴内容 | 不能直接采用的原因 | 项目落点 |
|---|---|---|---|
| [wix/skills](https://github.com/wix/skills) | Catalog V3 的 options/variants、bulk products、媒体上传、SEO 字段和原子创建流程 | 依赖 Wix Catalog API/V1/V3，不能代表中国平台字段、OAuth 或回执 | `CommerceProduct`/SKU 快照、批量预检和媒体角色绑定 |
| [commercengine/skills](https://github.com/commercengine/skills) | catalog、variants、webhooks、checkout 的任务拆分方式 | 面向 Commerce Engine storefront，要求其 Store ID/API Key，不含本项目六平台 connector | 商品目录、事件和幂等设计参考 |
| [nexscope-ai/ecommerce-seo-geo-skills](https://github.com/nexscope-ai/ecommerce-seo-geo-skills) | SEO 审计、关键词缺口、商品 Listing SEO/GEO、结构化数据和 AI shopping 可见性 | 是 agent 指令/审计方法，不提供平台写入、排名保证或事实证据 | `packages/seo` 的可解释建议、关键词/事实/平台限制分离 |
| [nexscope-ai/eCommerce-Skills](https://github.com/nexscope-ai/eCommerce-Skills) | 商品描述、定价、增长和平台运营的任务化提示 | 覆盖 Amazon/Shopify/Etsy/TikTok 等通用运营，不提供本项目店铺授权与发布事务 | Skill 中的追问、人工确认和运营报告结构 |
| [ecommerce-agent-browser-skill](https://github.com/81211860/ecommerce-agent-browser-skill) | SKU 图片、规格行、主图/详情图素材绑定的输入约束 | 浏览器/PDD 特定协议，不能绕过官方 API、授权和发布回执 | `skuIds`、素材权益、`main`/`secondary` 选择哈希和发布预览 |
| [buildwithclaude/shopify-automation](https://github.com/davepoon/buildwithclaude/blob/main/plugins/all-skills/skills/shopify-automation/SKILL.md) | Shopify bulk create、库存/位置和自动化操作提示 | Shopify 专属 API，不能复用为六平台写入适配器 | 自动化策略只做按店扫描、告警、暂停和人工重试，不自动重发 |

## 与当前代码的对应检查

- 事实和 SKU：商品、SKU、价格、库存、图片与权益进入任务冻结快照；同一平台不同店铺使用不同 `account_id` 独立任务。
- 图片：素材安全/权益/事实门禁，候选图人工选择，第一张冻结为 `main`，其余为 `secondary`，发布预览携带 selection hash。
- 批量发布：批量准备全组预检，逐项 confirmation hash、店铺、失败原因、暂停/恢复/失败重试均独立保存。
- SEO/GEO：标题长度、关键词、事实证据、风险和平台限制分开输出；不宣称搜索排名或 AI 引用结果。
- 自动化：策略按 `platform + account_id` 持久化，`automation.tick` 只生成风险告警和人工动作；撤权/需续期会阻断扫描和发布，不做无人值守自动重发。

## 未被外部 skill 证明的生产能力

第三方 skill 的 README、SKILL.md 或浏览器流程不等于真实平台生产证据。六平台正式 OAuth、读写字段映射、媒体上传、限流/拒绝码、写后回读、支付 provider、真实模型和云容量仍必须通过本项目自己的 capability evidence、canary 和部署验收。
