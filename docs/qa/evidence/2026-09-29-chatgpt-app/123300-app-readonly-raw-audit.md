# 123300 版 ChatGPT App 只读调用原始证据

日期：2026-09-29。仅只读核对 ChatGPT 会话 `rollout-2026-09-29T12-40-07-01a0eb76-811f-71f2-9ced-5c2df399f637.jsonl` 的原始 `custom_tool_call` 与 `custom_tool_call_output`；未操作 GUI、未写生产。安装记录为本地 `merchant-marketing@merchant-local 0.1.0+codex.20260929123300`，已启用。会话工具输出不内嵌不可变插件版本标识，版本归属还需以当时安装与进程日志交叉核验；旧版调用不计入此版。

## 精确方法结果

| 时间 CST / JSONL 行 | 实际 MCP 方法 | 原始结果 | 验收解释 |
| --- | --- | --- | --- |
| 12:40，第 26/29 行 | `onboarding.status({})` | `isError=false`，中文入门说明，结构化 `status=in_progress` | 工具通达；未证明具体商品、店铺或内容流程完成。 |
| 12:40，第 33/36 行 | `brand-unit.list({})` | `isError=true`，`STORE_ONBOARDING_REQUIRED`，中文说明店铺前置 | 门禁生效；未取得品牌单元列表。 |
| 12:42，第 62/74 行 | `subscription.orders.list({})` | `isError=false`，结构化空数组 | 自有订单空态读取；无已付款订单。 |
| 同批 | `billing.export({})` | `isError=false`，`available=false`、`MERCHANT_BILLING_EXPORT_CONSOLE_ONLY`、`open_merchant_console` | 仅后台办理入口；ChatGPT 内未导出账单。 |
| 同批 | `billing.model-usage.statement({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE`、余额 unknown | 未取得模型用量账单。 |
| 同批 | `billing.recharge.list({})` | `isError=false`，`orders=[]`、`total=0` | 充值订单空态读取；无到账证据。 |
| 同批 | `catalog.categories({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 未取得商品分类。 |
| 同批 | `knowledge.rule.list({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 模型误选的知识规则工具；未取得知识列表，也不能代替 `rule.list`。 |
| 同批 | `rule.sync.status({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 未取得规则同步状态。 |
| 同批 | `brand.extract({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 未取得品牌候选字段。 |
| 同批 | `deliverable.list({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 未取得交付物列表。 |
| 同批 | `task.history({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 未取得任务历史。 |
| 12:44，第 92/95 行 | `rule.list({})` | `isError=true`，`CREATIVE_POINTS_UNAVAILABLE` | 准确规则工具已补调；仍未取得平台规则列表。 |

第 62/74 行的十项批次输出是按调用顺序的十个 `{name,result}` 对象；逐项取 `result.isError` 与 `result.structuredContent`，没有采用模型最终总结。该批次 **3 项非错误、7 项阻断**；加前后单项后，此版 **13 个不同方法已调用：4 项非错误返回、9 项明确阻断，103 项未调用**。非错误返回里有两项空列表、一项后台入口和一次入门说明，均不能算商家主流程正向完成。

`CREATIVE_POINTS_UNAVAILABLE` 的结果显示 `balance_state=unknown`；这是服务端安全停止，不是创意点余额为 0。该 QA 工作区的商品、规则、资产、任务等实际对象仍需满足数据和商业前置条件后另行验收。
