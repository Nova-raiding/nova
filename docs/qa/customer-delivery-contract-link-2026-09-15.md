# 合同链接导入：实现与运行验收

状态：合同链接导入代码、业务回归及稳定源码的真实桌面／API／扫描／PG 验收均已通过（2026-09-15 12:32 CST）。首轮指纹门禁失败记录保留。**单个商家账号绑定／生效门禁仍未实现，不是全部客户交付需求完成或生产发布声明。**

## 本轮完成的实现

- 合同字段支持本地文件与公开 HTTPS 直链两种互斥来源。链接仅限合同，不携带运营 Cookie，不支持登录网盘、预览页、重定向或私网地址。
- 服务端先校验身份、能力、目标工作区和档案，再下载；下载后重新验证当前会话与权限。检查所有 DNS 结果并将公网地址固定到实际 TLS 连接；保留证书验证，限制 40 秒、50 MiB、两个并发任务。
- 下载所得字节仍进入既有隔离区、扫描 worker、签名回执和档案用途绑定。裸链接或尚未扫描通过的素材不能保存成合同完成凭证；不新增“默认扫描成功”路径。
- 桌面近字段显示下载／检查／失败状态，提供取消、显式重试和重复点击保护。撤权、卸载、切换目标后的迟到结果不得回填；只有可信 clean 结果会填入素材引用，仍需保存档案。
- MCP 输入校验及声明、OpenAPI、API、客户端和桌面输入契约同步。签名 URL 不进入业务资产元信息及审计正文。

## owner 独立回归

所有回归通过仓库 `scripts/run-safe-tests.ts` 执行，不加载共享业务环境。

| 检查 | 结果 | 范围说明 |
| --- | --- | --- |
| API、MCP、上传、仓储，11 文件 | 400/400 | 包括 112 项下载边界、17 项真实 socket／模拟下载入口；不是实际外站扫描证据 |
| 原生 MCP、HTTP 对齐、页面，5 文件 | 65/65 | 包含 18 项 Section |
| 上传组件、客户端、Section，3 文件 | 88/88 | 包含 8 个真实 Chrome 交互；Section 的 18 项与上一组重复，不重复计数 |
| 表单输入解析、素材及锁错误，3 文件 | 150/150 | 包含 123 项 HTTP 输入校验 |
| 身份生命周期 | 3/3 | 会话撤销、停用与重复操作 |
| 业务回归去重合计 | 688/688 | 22 个文件 |
| 共享七附件扫描核验脚本 | 7/7 | 并行工作流更新，owner 只读复核并重新测试，未把该实现归为本轮所写 |
| 完整 `npm run typecheck` | 通过，最终再次执行退出 0 | 根项目、桌面运营、商家界面；运行后 256 个源／迁移指纹复核无变化 |

## 真实环境证据：首轮，未通过总体门禁

入口：`OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS=300000 node --import tsx scripts/verify-customer-delivery-contract-link.ts`。

- owner 报告：`artifacts/customer-delivery-contract-link/run-OfSOiK/run-result.json`。
- 隔离运行：`artifacts/ops-jit-isolation/2026-09-15T04-22-25.984Z-3c0b0630-60b3-439b-b23f-527b53bdbc27/`。
- Chrome 场景 1/1 通过（50.8 秒）：真实 OIDC 登录、页面建档、shot-scraper 点击链接导入、pending → clean、保存及重开、同会话 API 回读；裸 URL 写入及 loopback URL 导入均返回 400 且档案不变。
- 真实 ClamAV 1.4.6／定义 28123、clean 与 EICAR 自检；旧三附件核验器确认真实文件字节、摘要、签名回执绑定、worker 回调与确认。公开 PDF 为固定 W3C 样本，13,264 字节，SHA256 `3df79d34abbca99308e79cb94461c1893582604d68329a41fd4bec1885e6adb4`。
- 总验收 **failed / CONTRACT_LINK_SOURCE_CHANGED**：运行期间 `scripts/customer-delivery-scan-evidence.ts` 被并行工作流从三附件核验升级成七附件核验。未抹除失败或关闭指纹检查；原浏览器结果不能代替新脚本的整体验收。
- 本轮自建 PG、Redis、ClamAV 的精确容器 ID 均已回收，`leftRunning=[]`，扫描／数据库证据保留。未停用、删除或清空共享业务容器。
- owner 审图发现重开抽屉截图截到了过渡动画；专用验收脚本增加实际滚动及短暂动画稳定等待后再截图，不修改 DOM 来伪造结果。

## 稳定源码重跑：通过

专用脚本适配现有七附件核验，不改弱公共核验器：公开 URL 合同、明确标注隔离样本的付款／接入／验收／培训 PDF，加两段不同视频，全部实际扫描后通过授权 MCP 登记。18 项清单的键、用途、引用和数据库回读均检查。

这些只是表单及证据登记的隔离测试数据。它们不证明实际收款、店铺接入、模型五模态执行、客户培训或客户账号已生效；不发积分、不调用模型／支付 provider。`effectiveAt` 仅表示该隔离档案满足当前完成规则。

2026-09-15 12:29:43—12:32:06 CST 运行，进程退出 0，Chrome 场景 1/1 通过（49.1 秒）。

- 总报告：[run-YWCcuP/run-result.json](../../artifacts/customer-delivery-contract-link/run-YWCcuP/run-result.json)，`status=passed`、`stage=complete`、`sourcesUnchanged=true`。owner 随后再次比较当前 256 个源／迁移指纹，`changed=[]`。
- 隔离证据目录：`artifacts/ops-jit-isolation/2026-09-15T04-29-43.971Z-de2aae00-18c1-4c71-89ff-b946147b6bfc/`。`scan-result.json` 确认七份独立文件的真实 ClamAV 扫描、对象字节与摘要、签名回执绑定、`callbackStatus=accepted`、`workerStatus=completed`；均无既往 worker 失败。
- PostgreSQL 的 `merchant_app`／`merchant_ops` 以只读、非 superuser、非 bypass-RLS 事务核验：七次 pending 上传审计均匹配实际操作人；合同来源 `https_download`，其余来源 `file`；18 个清单项键、用途及素材引用匹配；训练和档案完成时间回读一致。
- 扫描器为真实 ClamAV 1.4.6／病毒定义 28123，正常文件和 EICAR 自检均通过；没有伪造扫描回执或临时关闭安全门禁。
- owner 已查看四张 1440×900 PNG（pending、clean、保存、重开）；重开截图已完整显示抽屉和持久合同素材引用，不再截到过渡动画。8.36 秒 VP8 WebM 记录真实交互；另提取第 4 秒画面人工确认实际扫描等待状态，未替换原录像。
- 两个隔离 PG／Redis 容器和一个扫描器容器均按原始精确 ID 回收，两份 disposal 报告 `leftRunning=[]`、未触碰外部容器。回归样本和运行证据保留；无用户业务数据删除。
- 零积分赠送、预留、结算；没有真实模型或支付 provider 调用，不据此标记生产可用。原 13 个项目服务健康，桌面 `/api/readyz` 返回正常 PostgreSQL／Redis readiness，但仍为 fixture、`writesEnabled=false`／`productionGate=false`，不是生产上线证明。原 11 个 StoryForge 容器再次精确检查，全部 exited。

查看：[导入完成截图](../../artifacts/ops-jit-isolation/2026-09-15T04-29-43.971Z-de2aae00-18c1-4c71-89ff-b946147b6bfc/contract-link/contract-clean.png)、[重开回读截图](../../artifacts/ops-jit-isolation/2026-09-15T04-29-43.971Z-de2aae00-18c1-4c71-89ff-b946147b6bfc/contract-link/contract-reread.png)、[操作录像](../../artifacts/ops-jit-isolation/2026-09-15T04-29-43.971Z-de2aae00-18c1-4c71-89ff-b946147b6bfc/contract-link/contract-import.webm)。本轮未提交、推送或部署。

## 剩余范围

原需求七个客户档案字段、十项系统接入、八项功能验收、培训、分段视频的字段／解析／保存路径已存在；本轮补齐的是合同“文件／链接”中缺失的链接路径。单账号生效仍需要显式目标账号绑定、独立实时准入、API/MCP 与 worker 派发前检查，以及双账号／跨租户／停用／撤销证据的运行验收。不得用 `effectiveAt` 或档案完成标签代替。

技能影响：plan-eng-review 将合同与账号门禁拆成可独立核验的范围；ui-ux-pro-max 保留桌面 AntD 工作台并将错误放在字段旁；verify-feature 要求真实下载、扫描、持久化及截图证据，源码指纹改变时不接受整体通过。CodeGraph 当前未提供，未虚构调用或图索引结果。
