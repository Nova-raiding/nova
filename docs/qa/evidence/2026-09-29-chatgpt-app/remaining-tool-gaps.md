# Store Nova 剩余工具成功路径清单（2026-09-29）

## 统计口径

以[131 项历史工具矩阵](../../2026-09-29-plugin-all-tools-matrix.md)中状态为“未测试”的 **57 项**为分母，逐行核对本轮隔离 HTTP/MCP、插件桥接器及 PostgreSQL fixture 报告。其中 **46 项有隔离成功路径证据，11 项仍无成功路径证据**。隔离成功不等于生产或 ChatGPT App 成功；本文件不改变矩阵中的互斥线上状态。当前已安装本地插件为 **116 项**，这 57 项中有 **54 项仍暴露、3 项 `upload.session.*` 已隐藏**。

“隔离成功”要求报告明确记录该精确方法的正向业务结果。schema 校验、负向拒绝、配置健康或代码存在均不计入。图片生成与解析的模拟结果单独注明，不能用来证明真实模型中转、用量及成本结算。

## 已有隔离成功证据：46 项

| 域 | 数量 | 精确方法 | 证据与线上缺口 |
| --- | ---: | --- | --- |
| 账务与条款 | 2 | `commercial.service-boundary.accept`, `commercial.order.create` | [隔离 PostgreSQL 与支付 fixture](billing-write-isolated-audit.md)：条款接受、幂等及待支付订单成功；没有真实支付或生产写入。 |
| 品牌与店铺归属 | 5 | `brand-unit.create`, `brand-unit.bind-store`, `brand-unit.product.create`, `brand-unit.listing.create`, `brand-unit.access.grant` | [工作区/品牌隔离审计](workspace-brand-isolated-audit.md)：创建、绑定、授权和跨范围边界通过；仍需正式商家对象与 App 交互确认。 |
| 邀请与数据导出 | 2 | `workspace.invitation.accept`, `workspace.data.export.request` | [工作区/品牌隔离审计](workspace-brand-isolated-audit.md)：匹配受邀人激活、申请幂等及角色拒绝；生产没有对应成功请求，导出 worker 完成路径未证实。 |
| 商品目录 | 9 | `catalog.title.optimize`, `catalog.title.accept`, `catalog.import`, `catalog.import.batch`, `catalog.sku.update`, `catalog.product.update`, `catalog.facts.confirm`, `catalog.product.disable`, `catalog.product.enable` | [目录隔离 E2E](catalog-write-isolated-audit.md)：37/37，更新闭环追加 26/26；运营后台 CSV 导入不替代这些插件方法的 App 验收。 |
| 图片候选 | 3 | `catalog.image.generate`, `catalog.image.select`, `catalog.image.review` | [模型/多模态隔离审计](model-multimodal-isolated-audit.md)、[正式内容隔离 E2E](formal-content-isolated-audit.md)：生成使用模拟 provider，选择和审阅验证归档/ticket 门禁；没有生产图片模型请求、用量或成本。 |
| 素材 | 5 | `asset.parse`, `asset.facts.confirm`, `asset.upload`, `asset.upload.batch`, `asset.rights.update` | [素材隔离审计](asset-upload-e2e-audit.md)：本地上传、解析、事实确认和权益更新成功；解析模拟标记 `providerExecuted=false`，生产扫描及 OCR 中转未证实。 |
| 反馈 | 2 | `feedback.list`, `feedback.submit` | [任务/反馈隔离审计](campaign-task-feedback-isolated-round.md)：基于隔离任务及内容版本提交后读回；生产正式任务当前为空。 |
| 创意计划 | 3 | `creative.brief`, `creative.preview`, `creative.directions.update` | [任务/创意隔离审计](campaign-task-feedback-isolated-round.md)：banner/video brief、预览和方向更新有正向 fixture；无对应生产 App 结果。 |
| 内容审核与导出 | 5 | `content.review.decide`, `content.visual.select`, `content.export`, `content.approve`, `content.restore` | [正式内容隔离 E2E](formal-content-isolated-audit.md)：隔离任务版本与审核流通过；导出证据覆盖 manifest，正式生产版本、完整导出及 App 展示待验。 |
| 知识库 | 9 | `knowledge.rule.create`, `knowledge.asset.create`, `knowledge.asset.update`, `knowledge.brand.preference.update`, `knowledge.feedback.record`, `knowledge.learning.confirm`, `knowledge.learning.dismiss`, `knowledge.competitor.create`, `knowledge.competitor.reference` | [知识库隔离 E2E](knowledge-write-isolated-audit.md)：HTTP/MCP 21/21、桥接器 98/98；尚无生产 App 写入、读回及审计证据。 |
| 图片编辑 | 1 | `multimodal.image.edit` | [模型/多模态隔离审计](model-multimodal-isolated-audit.md)：fixture 验证素材权益与安全候选；真实生产 relay、归档和成本结算待验。 |

以上 46 项应按一个明确标记的 QA 商品和工作区串成 App → 本地 stdio 插件 → 生产 API → 持久化/模型中转 → App 可见结果的逐方法验收链。先完成商品事实、素材扫描与权益，再执行小额生成；每次记录实际请求、用量、成本、创意点和未发布状态。隔离报告中的 37、21、98、106 等数字是测试用例数，不是生产工具通过数。

## 仍无成功路径证据：11 项

| 优先级 | 精确方法 | 已知事实 | 下一步验收 |
| --- | --- | --- | --- |
| P0 | `merchant.start` | 131 项矩阵无成功调用证据；`onboarding.status` 成功不能代替此入口。 | 在新版 ChatGPT App 的新会话实际调用，核对工作区状态、授权入口和服务端审计。 |
| P0 | `content.generate` | 一次 `content.draft.generate` 有真实中转与结算证据；正式版本生成仍无成功路径。 | 先建立已确认 QA 商品、正式任务和审核前置，再受控调用并核对模型请求、用量、成本、点数、正式版本及 App 可见结果。 |
| P0 | `upload.session.create`, `upload.session.part`, `upload.session.complete` | [隔离 HTTP/MCP 审计](asset-upload-e2e-audit.md)三项均返回 `UPLOAD_TRANSPORT_NOT_CONFIGURED`（503），当前 116 工具版已隐藏；这是已知产品缺陷而非“未调用”。 | 实现可持久化、按租户授权的分片传输和最终资产注册/扫描后，在隔离环境做完整上传，再决定是否重新暴露与上线验收。 |
| P1 | `brand.upsert` | 没有本轮正向运行证据。 | 使用隔离品牌资料测试确认版本、来源及跨租户边界，然后在 App 用 QA 品牌执行交互写入/读回。 |
| P1 | `asset.preference.update`, `asset.generation.confirm` | 没有本轮正向运行证据。 | 先用隔离素材和候选验证偏好更新、生成确认与重复提交；生产需合格扫描/权益素材、显式确认及审计。 |
| P2 | `workspace.activate`, `workspace.deactivate` | 仅列在旧插件面，尚无本轮成功路径证据。 | 在隔离工作区测试状态切换、角色和恢复；生产仅在有可恢复 QA 工作区及明确操作窗口时验收。 |
| P2 | `workspace.data.delete.request` | 没有本轮成功路径证据；该动作可能触发真实数据删除流程。 | 先在隔离租户验证双人审批、宽限期、取消及审计；生产不对商家演示工作区创建删除申请。 |

优先级表示解除真实商家主流程阻断的顺序，不表示把隔离通过折算为线上通过。矩阵的 57 项状态保持原样，另有其他 74 项的线上成功、负向或门禁结果仍须按原矩阵解释。
