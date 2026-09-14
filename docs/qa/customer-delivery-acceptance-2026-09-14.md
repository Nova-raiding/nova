# 客户交付验收记录 · 2026-09-14

结论：隔离环境的客户交付表单链路通过；不等同于共享环境已部署或全部业务交付完成。

## 已验证范围

| 需求 | 运行证据 |
| --- | --- |
| 客户档案 | 真实 OIDC 登录、建档、合同编号/HTTPS 链接、负责人、付款状态/日期、要求上线时间保存与刷新回显 |
| 日期解析 | PostgreSQL DATE 保留日历日期；中国时区 09:00 保存为 01:00Z，刷新仍为 09:00 |
| 系统接入、功能验收 | 10 + 8 个稳定清单键、逐项勾选与证据、批量 JSON 保存、重开回显 |
| 培训 | 主页独立勾选，无详情入口；验收不自动完成培训；勾选不打开抽屉 |
| 阻断 | 未付款不得进入受控环节；不存在/未扫描视频引用返回 409，交付档案仍未完成 |
| 表单隔离 | 新建第二个客户不带入前一客户的合同、负责人或日期 |
| 持久化安全 | 运营角色写入、商家角色拒绝、跨工作区 RLS、并发 revision 冲突、审计旧值及只追加、视频软删除 |

修复包含：运营连接池与权限、审计 UUID、生效时间重算、缺失的干净源码依赖；日期跨日/时区偏移；验收错误联动培训；异步保存重开抽屉；加载/切换表单时的状态保护。移除抽屉内拥挤的步骤条，保留标题和具体表单。

## 测试结果

- 干净源码快照全量 TypeScript 检查通过。
- 定向回归 12 个文件、57 项测试通过（API 授权、MCP JSON 契约、客户端解析、表单辅助逻辑、迁移及运行角色门禁）。
- 隔离 PostgreSQL 17 回归通过，运行时区 `Asia/Shanghai`，全部字段值精确断言。
- 桌面 1440×900、Asia/Shanghai、真实生产构建 UI → 签名 OIDC → API/MCP → PostgreSQL/Redis 测试通过，1 个完整用例，47.8 秒。
- 使用 shot-scraper 实际取消并重新完成培训，生成截图和 WebM；没有保存会话 cookie、密码或原始网络跟踪。
- 仅清理了本次验证自行创建、通过身份校验的临时容器；共享容器及业务数据未修改。

本地证据位于 `artifacts/customer-delivery-acceptance/run-61350d17/`，不作为源码依赖：

- `result.json`：浏览器 RPC 结果与最终状态。
- `postgres-result.json`：数据库回归与临时资源清理结果。
- `runtime.json`：实际持久化/授权环境。
- `profile-fields-reloaded.png`、`customer-delivery-gates.png`：表单与阻断截图。
- `training-confirmed-shot-scraper.png`、`training-inline.webm`：真实培训操作结果。

可复跑（需本地 Docker 测试镜像、Chrome 和 shot-scraper）：

```sh
TZ=Asia/Shanghai node --import tsx scripts/verify-customer-delivery-postgres.ts
node --import tsx scripts/run-ops-oidc-e2e.ts dogfood/chatgpt-all-functions/ops-delivery-isolated.spec.js
```

## 尚未完成的上线条件

1. 客户交付直接文件上传已接入，隔离环境真实合同/视频扫描与登记链路已通过（见下方补验）。仍需在目标部署环境确认对象存储、scanner 配置、真实运营会话与目标企业，不能把本地验收当作生产已部署。
2. “交付已完成”当前仅表示交付档案的清单、培训和视频条件已满足；尚未验证其他业务区域的实际生效联动，不能据此宣称账号/权限已启用，也不能自动恢复被管理员停用的主体。
3. 共享环境的运行版本、迁移 200 和登录后的企业验收尚未在本轮确认。仍需已登录运营会话及明确的测试企业；隔离验收不替代共享部署确认。
4. 本次未调用商业模型、中转或真实支付，因此不构成 ChatGPT 插件五模态、成本/账务及生产发布门禁的全面通过证据。

## 文件引用门禁补验

- 合同素材引用在保存时核对存在性、目标工作区和可信扫描凭据；独立档案完成接口会重新检查已保存的合同引用。
- 视频必须具有可信扫描凭据和视频 MIME 类型，不能用图片或仅有旧 `clean` 标记的素材替代。
- 持久化开启时按工作区读取最新单条资产；数据库不存在或扫描状态失效时不回退到进程缓存。数据库故障不被伪装成普通资产缺失。
- HTTPS 合同链接仍可作为外部凭证登记，不承诺已被平台扫描。页面删除了不执行上传的选文件按钮，并明确当前仅登记已有素材。
- 干净源码快照全量类型检查通过；8 个定向文件、72 项测试通过。其中 9 项 HTTP 测试使用显式合成扫描元数据，只验证登记边界，不代表真实扫描。
- 真实桌面流程已覆盖不存在的合同引用返回 409、未付款阻断、18 项清单回显、培训独立确认、视频拒绝和新档案字段隔离，并保留 shot-scraper 截图与操作录像。
- 所有验证使用本轮独立 PostgreSQL/Redis；仅停止经过身份校验的测试容器，未修改共享容器或业务数据。

最终截图/录像与 RPC 结果：`artifacts/customer-delivery-acceptance/run-df4238a8/`。其中 `video-registration-shot-scraper.png` 展示实际打开的视频登记抽屉，`training-inline.webm` 包含培训取消/完成及打开视频抽屉的真实操作。

## 直接上传与真实扫描补验

2026-09-14 的最终隔离运行 `f6677f9a-ca5b-4a36-86a3-490b6f606dbe` 通过，证据目录为 `artifacts/customer-delivery-acceptance/run-f6677f9a/`。

- 表单支持合同 PDF/DOCX/PNG/JPEG、交付视频 MP4/WebM，单文件不超过 50 MiB；真实读取文件并计算 SHA256。显示上传、安全检查、可使用、失败和取消状态，失败可单独重试；扫描通过仅填入引用，保存后才登记。
- 平台上传为独立非商业安全扫描任务，准入绑定平台授权决策、企业、档案、文件用途和字节版本。商家原有扫描商业门禁不变。该运行无点数授予、预占、结算或账本事件，余额未初始化，如实保留为 unknown/null。
- 桌面真实生产构建 UI → 签名 OIDC → MCP/API → PostgreSQL/隔离对象存储 → 原生 scan worker → ClamAV → 签名回执 → clean 对象 → 合同/两段视频登记及刷新回显，完整用例通过（48.7 秒，不含环境准备）。
- ClamAV `1.4.6`，真实病毒库 `28123`，发布时间 `2026-09-14T06:24:19Z`；普通内容探针和 EICAR 自检通过。未使用 fixture clean、手工扫描回执、共享病毒库或共享容器凭据。
- 只读取证核对 1 份 PDF、1 段 MP4、1 段 WebM 的准入、真实 outbox、durable attempt、已接纳回执、对象字节 SHA256、上传/登记审计和 worker 最终确认。三个任务均一次回调接纳、无先前失败且已完成。
- 保留未扫描素材 409、跨租户/跨档案读取拒绝、普通商家素材不可借交付接口读取、文件摘要/MIME/格式错误、签名篡改/错 worker 角色/nonce 重放等回归。
- 实际关闭待扫描抽屉并切换客户，迟到的真实扫描响应不会污染另一客户；同一运营将同一 clean 合同复用于三份档案后，各自绑定查询均成功，覆盖 PostgreSQL 事件序号冲突修复。
- 网关实际代理并签名 40 MiB 文件的 base64 JSON；MCP 请求体上限与 API 的 70 MiB 传输限额对齐，其他路由维持 50 MiB；文件本体仍限制 50 MiB，并覆盖满额及超额边界。
- 早期独立 ClamAV 启动因并发加载/更新病毒库发生 OOM；测试组件改为先运行真实 freshclam 更新，再启动 clamd。没有降低病毒库新鲜度、关闭签名核验或修改共享服务。
- 所有本轮临时容器按精确 ID 与标签确认后停止；最终 PG、Redis 和 ClamAV 清理结果均 `leftRunning: []`。证据没有保存 cookie、密码、私钥、上传正文或扫描签名。

复跑真实扫描（需要已缓存的固定 ClamAV 镜像、Docker、Chrome 和 shot-scraper）：

```sh
OPS_E2E_DELIVERY_SCAN=true OPS_E2E_BROWSER_TIMEOUT_MS=360000 \
  node --import tsx scripts/run-ops-oidc-e2e.ts dogfood/chatgpt-all-functions/ops-delivery-isolated.spec.js
```

`scan-result.json` 为数据库/对象链路证据，`browser-result.json` 为桌面操作证据；`scanner-readiness.json`、两份 disposal 文件及 shot-scraper PNG/WebM 是对应运行的配套证据。扫描类型识别不等于合同内容语义解析，也不代表真实模型、支付或账号生效联动已验收。

后续工程项：新扫描事件执行查询仍沿用按素材读取有限历史事件的接口，长期大量重扫应改为按事件 ID 精确读取。客户档案完成与账号/权限实际启用仍是独立未验收项；不得据此自动恢复已被管理员停用的主体。
