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

2026-09-28 12:56 UTC 再次运行专用隔离 runner：`OPS_E2E_MANUAL_OPERATIONS=true node --import tsx scripts/run-ops-password-e2e.ts dogfood/chatgpt-all-functions/ops-manual-import-isolated.spec.js --workers=1`，Playwright 1/1 通过。证据目录为 `artifacts/ops-jit-isolation/2026-09-28T12-56-02.338Z-73561442-fc0f-4ec2-81dc-d6a5e56d9697/`：两个错误店铺文件均被拒绝，正确 XLSX 已导入，隔离商家可见；运行时为 loopback、PostgreSQL/Redis ready、模型未配置且未调用。清理回执记录两个 fixture 容器停止、`leftRunning=[]`、`externalContainersTouched=false`。这是隔离端功能证据，不是生产写入或线上验收。

同日 12:54 UTC 的 `npm run deploy:101:status` 仍为 `release_approved=false`：公网 API 与 Ops health/release 探针成功，但容器库存含多个源码修订（API 双副本 `bb417660…`、商家 UI `f48c8454…`、Ops UI `fccee758…`、worker `ffcda399…`、payment `0fa18b78…`、pilot gateway `3567df1e…`），且正式 capability/capacity evidence 路径不可读。不得把 `/releasez ready=true` 或本次隔离导入通过写成完整部署验收。

原生 macOS 文件选择器「打开」禁用的根因尚未确定。Playwright `setInputFiles` 已验证真实 Ops 表单在 Chromium 中接受 XLSX/CSV 并触发解析预览；不能以此宣称 macOS 原生 picker 已修复。原始 03:39 UTC 记录的 101 API 为 `f48c8454...`；12:54 UTC 复核时 API 双副本已变为 `bb417660...`，但其他组件仍混合多个 SHA，故隔离代码的浏览器正向结果不能当作完整 101 部署验收。
