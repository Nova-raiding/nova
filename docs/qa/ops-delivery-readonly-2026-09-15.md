# 客户交付只读权限与登录回归 · 2026-09-15

本轮范围是桌面客户交付的查看／填写权限、异步操作隔离、实际登录账号展示和商家 OAuth 边界。StoryForge 保持停止，不扩展手机端、OCR、模型生成、生产发布或自动开通账号。此记录不能替代完整插件上线验收。

## 最新：冻结版本真实桌面 4 项通过

10:31 最终 owner 回归结论：本轮限定修改通过，未提交／推送／部署。运营前端拆为其余 96 文件 586 项与客户交付页 1 文件 20 项，两片均退出 0、无跳过；合计 **97 文件 606 项**。owner 校验两份 JSON 报告与当前源码测试文件集合完全一致、没有重复或遗漏。交付页 20 项包含 18 个真实 Chrome 组件交互，但 RPC 为模拟响应；真实数据库和权限证明使用下面独立隔离运行。全项目类型检查及 scoped diff check 再次通过；仍有现存 AntD deprecated 属性警告，不自称控制台零警告。

报告为 `artifacts/ops-delivery-readonly-20260915/{vitest-ops-rest,vitest-ops-page,vitest-api}.json`，最终源码指纹、精确统计、清理和发布边界汇总为 `owner-final-verification.json`。API／契约 120 项和真实 OAuth／PG 1 项也已通过，但不覆盖文末仍失败的支付对账 worker 用例。

2026-09-15 10:20，owner 对最终迟到读取补丁重新构建并运行三份桌面 spec：4 项通过、49.5 秒，无失败／跳过／重试。两种账号显示、工作台隔离和持久客服角色只读交付在同一隔离运行全部通过；这次不是下方早期“3 过 1 失败”的混合运行。

- 最终目录：`artifacts/ops-jit-isolation/2026-09-15T02-19-35.996Z-6f4eae12-2a70-49fb-b3b9-e8ad38aacb7e/`；run ID `b40b14c2-4a88-457f-a93b-f194435ea04f`。
- owner 已查看此轮两份账号弹层及只读客户档案 PNG，账号均处于“已登录”状态且显示服务端验证的输入登录名。只读档案保留字段和状态、没有写入口；录屏实际执行展开操作。六类直接写入仍在 capability 门禁 403，界面零写入，草稿未变。
- API、Page、Section、角色契约、runner、fixture、真实 spec 和两份 UI 测试共 9 个受检文件的 SHA256 前后全部一致。核心 Page 为 `9af0dbc130591769be8a87d24c182631405c27d9a80599c54c5b619da84d1af8`，Section 为 `ed02be171d2a7fdf8e88f45c00f4a76d5fd66bd79c80f4e68ce14adbb0e8bd73`。
- 两个自有 PG／Redis 的 disposal 为 `leftRunning=[]`，owner 对完整 ID 再次 inspect 均不存在；没有启动扫描器或触碰共享业务数据。
- 最后补丁：视频成功后的 get 绑定发起读取代次，A→B→A、失读、清空目标及卸载后失效；list 统一使用最新读取权限和挂载状态，防止 create／profile／training 的迟到回执重新读取。Section 在布局阶段清理失效详情和挂载状态，防止卸载瞬间继续下一段或迟到创建重新打开详情。仅失去写权限时仍允许合法读取，已成功的服务端写入不回滚。
- 独立 agent 已复核同一 Page／Section 指纹，无本轮 UI 阻断。owner 全项目 `npm run typecheck` 与 scoped diff check 通过。组件 RPC 回归与真实数据库验收分别记录，不将 mock 响应当作服务端鉴权证据。

## 多 agent 分工

- 交付 agent：只修改 CustomerDeliveryPage、CustomerDeliverySection 及对应测试；区分“无读取权限”和“仅无写入权限”，修复视频批量提交及迟到响应。
- 鉴权与独立复核 agent：定位正常工作区 OIDC 会话被 OAuth 防护误拒的问题；独立审查 UI 生命周期和真实只读验收脚本。
- 角色与需求复核 agent：确认 support_agent 持久角色映射、安全边界和支付对账路由回归，不代替 owner 验收。
- owner：实现 canonical 角色映射、真实浏览器和 OAuth／PostgreSQL 反例；整合代码、检查实际截图、重新运行测试、核对源码指纹与隔离容器清理。

investigate 技能用于先复现再修根因；verify-feature 要求真实页面截图和点击录屏；UI/UX 技能用于明确只读与不可访问的差异，没有重设计业务规则。

当前工具目录未提供 CodeGraph 连接，本轮影响面以源码调用链、直接检索和测试复核为准，不使用旧索引宣称当前代码覆盖。

## 已确认的根因与修改

1. 页面将 `!canUpdate` 当作整个交付区禁用，导致有读权限的客服也打不开详情。改为由读取权限决定能否查看，写权限单独决定保存、上传、创建和确认入口。只读账号可以检查未付款草稿；受控修改仍受原付款和服务端授权门禁限制。
2. 合同／视频的独立上传入口没有完整服从 readOnly。统一上传入口并去掉只读会话的六类写回调；培训仍能展开查看，但不能上传或确认。批量视频每一段前检查最新权限与请求代次，取消或撤权后不继续提交；已成功部分不伪装成未保存。
3. durable `support_agent` 已存在于平台角色表及权限表，但 canonical 转换漏掉同名映射，真实会话因此丢失读权限。仅补 `support_agent → support_agent`，不新增 capability；成员 `support` 仍是 `workspace_support`，不能提升为平台角色。
4. `ops.session` 的 OAuth 防护误按工作台判断，连正常 workspace OIDC 登录也拒绝。验证 MCP OAuth token 后才设置服务端内部 `credentialSource`，运营方法按该来源拒绝商家 OAuth；浏览器头不能伪造该来源。正常签名 OIDC 工作区会话保留。

## 已完成的真实运行证据

- 只读桌面：`bac906fd-0c71-4495-9045-ad8d746b1286`，1 项通过，13.1 秒，无跳过／重试。真实认证表单 → 签名网关 → API/MCP enforce → PostgreSQL 17／Redis → 生产前端构建、Chrome 1440×900。先通过 API 建一份隔离未付款草稿、给当前测试身份授予 support_agent 并撤销 platform_admin，再实际查看档案、接入、验收、培训、视频五块。
- 接入 10 项、验收 8 项均显示且不可勾选；新草稿 API 没有已保存清单行，不能把 18 个定义控件冒称 18 项已完成。界面交互没有写请求；六类直接写探针分别被 `403 / FORBIDDEN / customer.delivery.update` 拒绝；前后草稿相同。owner 已查看 `readonly-profile-shot-scraper.png`；对应 WebM 实际选择目标工作区并打开客户档案，不只是静态停留。
- 首次通过目录：`artifacts/ops-jit-isolation/2026-09-15T02-08-17.480Z-44d8203e-4446-4086-b4fe-0d0bec618bbb/`。7 个源码 SHA256 前后相同；两个自有 PG／Redis 容器的完整 ID 已精确复查不存在。未启动 scanner、写共享业务数据或保存浏览器凭据。
- API 与契约：6 文件、120 项通过（OIDC 26、OAuth 5、native MCP 13、authz 33、MCP schema 17、上传契约 26），退出 0。报告 `artifacts/ops-delivery-readonly-20260915/vitest-api.json`。另有协议／网关／runner／OIDC 4 文件 132 项此前通过，不能把两批重复计为不同用例。
- 真实 OAuth／PostgreSQL：`6d436913-233e-4687-b056-d05c1a0f65ab`，1 项通过，4.04 秒。两个通过真实授权码＋PKCE 获取的商家 token 均被 ops.session 拒绝；插件 bridge 的购买、已签名支付回调、只入账一次和另一成员不可见仍通过。支付供应商为 fixture，不是真实扣款或生产支付证明。目录 `artifacts/isolated-postgres/run-eS3Cao/`，report 与 disposal 均通过，两个自有容器 owner 精确复查不存在。
- 账号展示：`818191cc-dc5c-41ac-9d1f-e1f3d48e0172` 的两项真实 OIDC 登录与工作台隔离共 3 项通过；同批新增只读测试因草稿清单行数假设错误失败，不能称该整批全绿。owner 核看平台及工作区账号截图：显示实际已验证登录名，不回退 actor UUID；工作区越权访问交付仍拒绝。拒绝页截图显示权限刷新状态，不把它当作整个页面稳定健康的证明。

阶段源码、PG 测试统计和清理结果另存 `artifacts/ops-delivery-readonly-20260915/owner-phase1-verification.json`；该记录明确是后续迟到读取补丁之前的通过版本。

## 失败与证据完整性

保留最初角色映射失败及验收脚本失败：新草稿应返回 0 个已保存清单行；Ant Design 的必填字段可访问名称含星号；中文关闭按钮为“关闭”；shot-scraper 严格选择器必须唯一匹配。修正脚本后重新完整运行，没有跳过权限断言或把失败改成通过。截图失败时业务断言虽然已过，仍不计完整 UI PASS。

最后一个 503 回读组件用例曾出现确定失败，不能用之前的单跑通过掩盖。失败现场确认抽屉打开、表单 `aria-busy=false`、按钮已启用且无 loading 类，但透明零宽的 CSSMotion 离场图标仍使可访问名称为 `loading 保存当前环节`；祖先无 aria-hidden／inert。只修改测试为当前可访问 dialog 内唯一原生 submit，确认非忙碌再正常点击，保留空素材提示与写入恰好一次断言；无 sleep／force／跳过。临时诊断和五次参数化已移除，owner 最终完整 Page 20 项通过。真实桌面通过后仅这一测试定位发生变化，生产源码及真实 spec 保持原指纹。

截图失败诊断先收集完整字符串并脱敏 cookie，再限制输出；超过安全缓冲上限整段丢弃，防止截断后留下凭据片段。浏览器认证状态始终通过 stdin，不写到证据目录。

同一工作区有本轮之外的并发 writer，期间改变代码并删除过刚生成的 `run-2A9YYO` PostgreSQL 证据。owner 未回滚／覆盖其修改或删除；该已删除目录不作为可交付证据，另以新隔离运行补证。没有执行提交、推送或部署本轮修改。

## 需求边界与发布阻断

| 需求 | 当前判断 |
| --- | --- |
| 档案 7 类字段、10 项接入、8 项验收、独立培训、多段视频 | 已有实现；完整七附件／18 项填写及持久化的历史真实通过见客户交付验收记录，本轮新证据主要覆盖只读和权限边界。 |
| 字段解析 | 日期／时区、JSON、素材引用、MIME／大小／哈希及扫描绑定有校验；不等于合同内容 OCR 自动提取。 |
| 合同“文件／链接” | 已完成安全扫描上传文件路径；任意外部合同链接仍不支持，不能称原需求全部闭环。 |
| “全部完成后该用户生效” | 交付档案只有目标工作区，没有唯一客户账号绑定；自动开放指定账号还是整个企业未确认，当前不自动开通、更不恢复管理员停用。 |
| 支付对账 worker | 仍为发布阻断：worker 继续调用 `/v1/internal/billing/reconciliation`，但 API 路由被其他合并删除；已有安全用例失败。不能降低断言或只换错误码冒充修复。 |
| 五模态与全插件上线 | 本轮未调用模型、未收集生产中转成本证据，也未完成生产发布门禁。 |

StoryForge 的 11 个原容器再次按完整 ID 核对均 exited，未删除容器、数据卷或业务数据。共享服务没有部署本轮变更；测试全部使用自有隔离 fixture。

共享只读健康复查：13 个本项目服务均 healthy，18082 `/api/readyz` 返回 200；响应仍为 fixture 模式、`writesEnabled=false`、`productionGate=false`。配置就绪字段不等于真实模型调用／生产能力证明。另一个会话的隔离扫描器保持原状，owner 未停止它或删除其数据。
