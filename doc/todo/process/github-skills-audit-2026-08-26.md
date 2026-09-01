# GitHub Skills 对照审计（2026-08-26）

本次检索用于架构对照，不直接安装第三方仓库代码。第三方 Skill、MCP 和 CLI 在进入生产前必须经过来源、权限、依赖、网络出口和凭据边界审计。

## 对当前项目有用的模式

| 外部项目 | 可复用的产品模式 | 当前项目的落地/边界 |
|---|---|---|
| [Wix Skills](https://github.com/wix/skills/blob/main/skills/wix-manage/SKILL.md) | 图片建品、带 options/variants 的商品创建、批量创建、媒体上传和 draft/publish 状态分离 | 已落地 `catalog.import`、SKU 事实与版本绑定、`publish.prepare/confirm`、批量发布和媒体适配器；仍要求官方平台映射与 canary |
| [multi-platform-auto-upload](https://github.com/cjccd/multi-platform-auto-upload) | 平台账号、商品 ID、封面/素材、定时发布和日志回执都作为独立范围管理 | 已落地 `workspace + platform + account_id` 隔离、批量发布、自动化扫描/同步和 unknown/reconciliation 状态；禁止把浏览器自动化当作官方授权替代 |
| [generate-ecommerce-product-images](https://github.com/xiaotiezhuer/generate-ecommerce-product-images) | 从真实商品照片出发，按平台生成图片组并做商品保真检查 | 已落地素材权益/扫描门禁、主副图候选、人工选图、SKU 作用域和发布前冻结；真实图片 provider 与平台像素回读仍是外部门禁 |
| [sellerpilot-product-image-industrial](https://github.com/ninemouth/sellerpilot-product-image-industrial) | 生成图批量 QA、自然度/漂移检查、平台图片包和品牌视觉记忆 | 已落地确定性审核、运营候选队列、品牌视觉规则和外部未验证边界；未把第三方的图片判断当作平台审核证明 |
| [ecommerce-seo-geo-skills](https://github.com/nexscope-ai/ecommerce-seo-geo-skills) | 商品 listing 同时面向传统搜索和 AI shopping/GEO 可见性优化 | 已落地 `catalog.title.optimize` 的事实证据、平台长度限制、SEO/GEO 建议和风险字段；不承诺排名、收录或转化 |

## 结论

外部项目共同验证了四个应保留的架构原则：商品与 SKU 变体必须显式建模；图片生成必须保留原图和候选状态；账号/店铺必须是每次读写的作用域；发布必须保留可查询回执和失败日志。本项目已有这些本地代码路径，因此没有把第三方仓库未经审计地复制进插件包。

仍需外部环境完成的不是 Skill 缺失，而是官方授权、真实平台字段/媒体映射、支付服务商、模型与对象存储、云 Worker 和 Codex App 宿主验收。
