# Merchant Studio UI 调研与设计依据

版本：v1.0  
日期：2026-08-22  
适用范围：商家营销内容助手 Codex Plugin 交互卡片及 Web Demo

## 1. 调研结论

本产品不是一个普通“AI 写文案”页面，而是一个受控的电商内容工作流。界面必须同时解决五件事：识别商品真相、区分来源与推断、让生成过程可选择、让问题可定位、让线上写操作可确认和可追踪。

因此最终采用“运营工作台 + 单任务三栏工作区”的组合：

- 运营工作台承载跨店铺状态、需处理问题、同步和发布回执。
- 单任务左栏固定展示商品事实、来源、规则和禁改范围。
- 中栏承载三个创意方向、当前内容和版本差异。
- 右栏承载规则 finding、人工批准和发布入口。
- 发布使用独立二次确认，明确平台、商品、字段 diff、不会修改的字段和远端快照时间。

## 2. 参考产品与可迁移模式

### 2.1 Shopify：商品与 SKU 的批量信息架构

Shopify 的批量编辑器以商品/变体为行、属性为列，并允许用户选择需要显示的字段；无效值必须在保存前修复。这个模式说明商品工作台应以结构化表格承载 SKU、库存、来源和状态，不把关键事实藏在卡片深层。[Shopify Bulk Editor](https://help.shopify.com/en/manual/shopify-admin/productivity-tools/bulk-editing)

迁移到本产品：商品表格保留“商品、平台、事实来源、库存、确认状态”，详情再展示平台原值、本地候选和证据，不直接在列表中进行高风险批量覆盖。

### 2.2 Google Merchant Center：按影响聚合“需处理”问题

Merchant Center 的 Needs attention 页面先展示高影响问题，再给受影响商品、原因、建议动作和历史；用户可接受单项建议，但仍被提示核对数据准确性。[Google Merchant Center Needs attention](https://support.google.com/merchants/answer/12476548?hl=en-GB)

迁移到本产品：概览突出阻断发布的 P0/P1 问题；任务内 finding 必须带等级、原因、定位动作和依据。自动建议不能静默写入事实或直接发布。

### 2.3 Canva Brand Hub：集中资产、规则和审批

Canva 将 Logo、颜色、字体、图片和品牌指南集中管理，并通过 Brand Controls 限制不合规使用、要求发布前审批。[Canva Brand Hub](https://www.canva.com/newsroom/news/home-for-every-brand/)

迁移到本产品：品牌资产是持续可用的“事实底座”，不是每次任务重复上传；规则检查和人工批准独立存在，批准内容不等于批准平台写入。

### 2.4 Jira：状态和流转必须显式

Jira 将 workflow 拆为 status、transition 和 resolution；状态说明当前位置，transition 是单向动作，完成态还需要明确结果。[Atlassian Workflow Overview](https://www.atlassian.com/software/jira/guides/workflows/overview)

迁移到本产品：界面固定展示“事实确认 → 方向选择 → 内容审核 → 确认发布”；submitted、reviewing、published、rejected、unknown 分开展示，不能把“已提交”渲染成“已发布”。

### 2.5 OpenAI 交互应用：对话与结构化 UI 结合

OpenAI 的应用模式允许对话与交互 UI 结合；具有外部影响的写操作需要清楚展示并在执行前确认。[OpenAI Apps introduction](https://openai.com/index/introducing-apps-in-chatgpt/)、[Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in)

迁移到本产品：Demo 是结构化卡片的高保真参考，生产 Plugin 中每个按钮都映射为 MCP 命令，并提供文本降级；UI 不能保存服务端未知的隐藏状态。

## 3. `ui-ux-pro-max` 设计系统决策

技能检索建议的原始方向偏“活力电商展示页”。经产品语境校正后，最终采用“Fluent 2 的平静层级 + 数据密集运营面板 + 克制的品牌绿”，不采用促销型大渐变、玻璃拟态或过度动效。

### 3.1 视觉语义

| 用途 | 颜色/处理 | 约束 |
|---|---|---|
| 主操作 | 深森林绿 `#176B4D` | 只用于当前主动作和通过态 |
| 品牌背景 | 柔和青柠 `#D8ED7A` | 仅用于欢迎区，不代表成功 |
| 平台写入 | 陶土橙/风险红 | 二次确认中强调外部影响 |
| 信息/排队 | 蓝色 | submitted/reviewing 使用蓝色而非绿色 |
| 警告/未知 | 琥珀色 | unknown、需重新授权和 P1 finding |
| 表面 | 白色 + 暖灰底 | 通过边框和少量阴影建立层级 |

### 3.2 交互与无障碍

- 正文字号不低于 16px 的基础缩放语义；密集辅助信息保持可放大且不承载唯一关键结论。
- 所有按钮可键盘聚焦，焦点环可见；状态同时使用文字、图标和颜色。
- 对话框打开后聚焦安全的“返回检查”，支持 Escape 关闭；生产实现需增加完整 focus trap。
- 异步提交按钮展示 loading，结果通过 `role=status` 播报。
- 触控主操作最小高度 42–44px；移动端重排为单列，不依赖横向 hover。
- 遵守 `prefers-reduced-motion`，装饰动画可关闭。
- 不使用 emoji 充当功能图标；统一使用 Lucide SVG 图标。

## 4. Demo 覆盖的验证场景

1. 从概览创建营销任务。
2. 查看六平台连接状态和同步新鲜度。
3. 在商品表按名称/平台过滤并识别事实异常。
4. 在三个创意方向间切换。
5. 查看内容 v4，并与 v3 比较。
6. 在未人工批准时验证发布按钮不可用。
7. 批准内容后进入平台写入二次确认。
8. 查看写入字段和明确的“不会修改”范围。
9. 提交后得到 request ID 语义的受理提示，而非假成功。
10. 在发布中心区分审核中、待对账、已生效和业务驳回。

## 5. 不应从参考产品照搬的内容

- 不复制 Shopify 的直接批量保存，因为跨平台字段和规则不同，且本产品需要不可变版本。
- 不将 Google 的自动修复默认应用到商家商品；关键事实必须由用户确认。
- 不引入 Canva 式复杂企业协作；P0 只保留编辑、内容批准、平台二次确认。
- 不把 Jira 的全部自定义工作流能力开放给试点商家；P0 状态机固定，减少不可测试组合。

