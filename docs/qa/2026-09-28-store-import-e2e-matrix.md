# 101 店铺与人工代导入专项复核

2026-09-28。101 查询通过运行中的 API 容器以 `merchant_app` 身份执行 `BEGIN READ ONLY`，设置 `app.workspace_id=ws_guirenniaoniao`，查询后 `ROLLBACK`。隔离浏览器运行使用独立 PG17、Redis、密码会话和本机 loopback 网关；合成身份 `hyp@sn.com` 仅存在于临时 fixture，和生产同名账号无关。

| 检查项 | 101 只读事实 | 隔离真实 API + Ops Playwright | 结论 |
| --- | --- | --- | --- |
| JD 店铺登记与授权 | `42169`「贵人鸟官方旗舰店」，`token_state=manually_registered`；`credential_ref` 精确等于 `manual-store-record:no-credential:42169` 哨兵，`granted_scopes`、最近授权时间、刷新能力和到期时间均为空 | 运营以 `ops_admin` 权限登记合成 JD 店铺，后台可选择 | 人工登记可用；尚无京东官方授权或自动同步 |
| 品牌绑定 | `brand_guirenniao`「贵人鸟」active，active 绑定 JD 42169 | 本轮未改生产品牌 | 品牌与登记店铺绑定存在，但不代表平台授权 |
| 现有商品归属 | 1 件 `source=csv`、`store_name=贵人鸟母婴旗舰店`、`platform_account_id=null`、`brand_id=null`、`facts_confirmed=true`；旧审计为 `catalog.import.batch`，无 `source_ref`、源文件摘要和 `import_mode` | 错店铺名 XLSX、CSV 均进入浏览器预览，提交按钮禁用 | 这件商品不能算作「贵人鸟官方旗舰店」导入；现有母婴店 XLSX 不得用于目标店铺 |
| 正确来源代导入 | 101 无目标店铺的可核实商品来源资料，本轮不写入生产商品 | 合成 XLSX 中店铺名称与登记别名一致，运营明确确认归属、填写来源和原因后实际 MCP 导入；独立商家密码会话 `GET /v1/products` 读到同一商品 | 隔离端到端通过；101 目标店铺仍待真实核实资料 |
| 平台规则 | `public_platform_rule_versions` 为 0；贵人鸟工作区 `rule_pack_versions` 为 0 | 本轮未创建或审批规则 | 现网未取得可用于生产发布的规则证据 |

隔离浏览器最新运行：`artifacts/ops-jit-isolation/2026-09-28T03-39-04.824Z-e0454b75-00a4-47ee-94fb-1f81312fe275/`。`manual-import-browser-evidence.json` 的 `wrong_xlsx_rejected`、`wrong_csv_rejected`、`correct_xlsx_imported`、`merchant_visible` 均为 `true`；`runtime.json` 记载 `http://127.0.0.1:...`、PG/Redis ready、严格授权；`fixture-disposal-*.json` 记载两容器停止、`leftRunning=[]`、`externalContainersTouched=false`。定向 API/UI/隔离门禁共 54 项通过。

原生 macOS 文件选择器「打开」禁用的根因尚未确定。Playwright `setInputFiles` 已验证真实 Ops 表单在 Chromium 中接受 XLSX/CSV 并触发解析预览；不能以此宣称 macOS 原生 picker 已修复。101 当前运行的 API 为 `f48c8454...`，本轮隔离代码的浏览器正向结果也不能当作 101 已部署验收。
