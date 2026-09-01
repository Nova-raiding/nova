# 外部电商 Skills 对照

日期：2026-08-26

## 检索结论

本轮检索了 GitHub 上的电商 listing skills。它们主要提供内容生产方法和平台 listing 约束，没有一个可以直接替换本项目的 Codex Plugin、钱包计费、六平台 OAuth、多店铺隔离、审计发布和 Worker 自动化架构。

参考项目：

- [DekBaCom/Claude-Skills marketplace-listing](https://github.com/DekBaCom/Claude-Skills/blob/main/E-commerce%20%26%20Products/marketplace-listing/SKILL.md)：强调不同 marketplace 不能复制粘贴同一 listing，并要求先确认平台和商品事实。
- [nexscope-ai/eCommerce-Skills product-description-generator](https://github.com/nexscope-ai/eCommerce-Skills/blob/main/product-description-generator/SKILL.md)：覆盖标题、描述、关键词和平台长度约束，并区分创建与优化两种模式。
- [nexscope-ai/eCommerce-Skills tiktok-shop-listing-optimization](https://github.com/nexscope-ai/eCommerce-Skills/blob/main/tiktok-shop-listing-optimization/SKILL.md)：覆盖 TikTok Shop 的标题、描述、属性、图片/视频和搜索优化。

## 对本项目的落地判断

- 已吸收：按平台生成建议、平台长度约束、关键词和事实证据、创建/优化分流、不承诺排名。
- 已超出外部 skill：钱包解锁、平台模型中转、商品/SKU 快照、素材权益、OAuth 店铺隔离、批量发布确认哈希、未知状态对账、自动化暂停和运营审计。
- 本地新增的 `catalog.title.accept` 将“生成建议”和“人工接受”分开；接受后重新进入商品事实确认，避免外部 listing skill 常见的直接覆盖商品事实问题。
- 外部 skills 不提供真实平台 API、支付回调、媒体上传回读或云 Worker 证据，因此这些仍必须通过本项目的生产 canary 和部署验收完成，不能仅凭 skill 文档宣称完成。
