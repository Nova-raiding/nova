# 客户交付验收记录 · 2026-09-14

最新补充（2026-09-15）：只读权限、持久客服角色映射和异步操作隔离已由多 agent 修复并由 owner 进行真实桌面复验，见 [客户交付只读与登录回归](ops-delivery-readonly-2026-09-15.md)。下方七附件通过属于当时版本，不能代替最新代码验证；自动生效、外部合同链接和支付对账发布阻断仍须分别处理。

环境后续调整（2026-09-15 08:58）：按用户“StoryForge 这个先停掉”要求，11 个原 StoryForge 容器已再次停止，完整 ID 复查均为 exited；未删除容器或数据卷。本次保持停止，不自动恢复，后续启动需用户指示。本项目运行服务均 healthy。记录见 `artifacts/ops-resource-window/2026-09-15T00-58/storyforge-stop.json`；这不改变下述交付功能已通过的验收结论。

当前结论：2026-09-15 08:31，客户交付档案与凭证工作流的完整七附件、18 项清单、培训／视频、只读证据收集和真实并发撤销验收已全部通过。owner 与独立 agent 已核对同一运行、源码指纹及清理结果。此前 OOM 阻断在用户批准临时停止 StoryForge 释放资源后解除；本轮通过不等于全插件上线、五模态验证或自动开通账号。以下按时间保留证据，旧失败未删除，旧版本通过也不代替最新代码验收。

## 2026-09-15 08:31 七附件及并发撤销完整通过

- 运行：`67ed92c4-a162-4f40-8fdb-d76fbf1a7faa`；owner CLI 退出 0，Chrome 桌面浏览器 1 项通过（1.6 分钟），无跳过／重试／flaky。真实签名 OIDC、API/MCP enforce、PG17／Redis、worker、ClamAV 链路，使用隔离测试身份、数据库和真实上传的样本文件；不是客户生产业务数据或伪造 clean 回执。
- 完整字段：合同／付款文件、付款日期、负责人、上线时间保存刷新回显；接入 10 项与验收 8 项的勾选、说明、附件、完成者和完成时间持久化；主页独立培训确认及撤回／恢复；MP4／WebM 两段视频登记回显。缺失素材拒绝、取消后切换客户不串数据、受限工作台拒绝和已扫描对象复用均经过浏览器断言。
- 七附件：5 份 PDF + MP4 + WebM，7 个不同 asset/event/正文哈希，六种用途完整绑定同一交付；隔离区和干净区实际字节、MIME、大小及 SHA256 匹配，真实扫描回调每份一次 accepted，worker 均 completed、prior failures=0，上传与登记审计均存在。ClamAV 1.4.6／定义 28123，普通内容和 EICAR 自检通过；未发放或消费创意点数，未进行真实支付。
- 签名口径：真实 API 执行密码学验签和授权门禁；只读 collector 核对持久化签名存在及副本一致，不自称第二次独立验签。collector 的数据库角色均无 bypass-RLS，以只读事务核对账本；不会补造或修复缺失证据。
- 并发反例：锁住本轮真实 clean 的付款附件后，观察到仓储请求等待准确 revoker PID 的素材锁；撤回凭证后原子清空完成时间，revision 10→11，并发修改以 SQLSTATE 23514 拒绝。get/list 均不可见完成，普通修改不能复活，仅新增一条系统撤销审计；保留历史签名，不恢复 clean、不改业务库。
- 稳定性：owner 验收指纹新增 child-monitor 文件；15 个受检源码前后相同，独立 agent 又核对当前文件哈希全部匹配。fixture-ready 与 owner 报告中的 209 个迁移版本匹配。本轮全项目 `npm run typecheck`、脚本 3 文件 116 项回归、scoped diff check 通过。
- 可见证据：owner 已查看 shot-scraper 的培训完成、两段视频登记 PNG；`training-inline.webm` 实际执行培训撤回／重新确认并打开视频登记。页面明确呈现交付已完成、培训已完成、2 段视频及本地完成时间，不将附件扫描视为视频／图片生成能力验收。
- 清理：本轮 scanner、PG、Redis 均 stopped 精确匹配创建 ID，leftRunning=[]；owner 随后对三个完整 ID 复查均不存在。隔离扫描测试没有接触共享业务数据。资源协调另有用户授权：暂时停止了 11 个 StoryForge 原容器，没有删除容器、卷或修改 VM；停启清单与恢复结果见 `artifacts/ops-resource-window/2026-09-15T00-27/storyforge-services.json`。
- 恢复：08:38 再次 inspect 核对 11 个 StoryForge 完整原容器 ID、目录、running、autoRemove=false 及持久卷绑定均相同；10 个有健康检查的服务均 healthy，ZooKeeper 与停用前相同为 running／无健康检查。`storyforge-restoration.json` 为 passed，containersRemoved=0、volumesRemoved=0；本项目所有运行服务的 Docker 健康检查也均 healthy。未提交、推送或发布，HEAD 仍为 dc72e177。

证据目录：`artifacts/ops-jit-isolation/2026-09-15T00-29-11.207Z-93f3db44-7789-4c29-a7b6-d154e1b09867/`

- `scan-result.json`：七附件、18 项、回调与登记审计。
- `owner-revocation-result.json`：真实锁等待、原子撤回、拒绝复活、源码／迁移指纹。
- `delivery-1789432191231/result.json`：桌面浏览器字段与错误路径。
- `delivery-1789432191231/training-confirmed-shot-scraper.png`、`video-registration-shot-scraper.png`、`training-inline.webm`：真实页面与交互。

`verify-feature`：上述客户交付档案／凭证验收为 PASS，不再沿用此前扫描 BLOCKED。仍未实现自动开通某个账号／企业（交付档案完成不等于访问授权），没有 OCR 业务字段提取；没有验证五模态调用或宣布生产发布。host 级 scanner lease 仍未实现，本轮由 owner 在资源窗口内只启动一份隔离 scanner。

## 2026-09-15 07:54 多 agent 续修与真实权限复验

- 分工：独立审查 agent 复核 owner runner；另一 agent 仅实现 `ops-e2e-child-monitor.ts` 与对应测试；owner 接线、补失败阶段诊断并重新验证。CodeGraph 已用于核对受影响测试，索引存在待同步文件，新增模块另行直接核对；没有把旧索引当成当前全量证明。
- 长期服务监控：API、两个 UI preview、scan-worker 任意非预期退出（包括退出码 0）、信号退出或 spawn error 均锁存固定失败。构建／服务 readiness／健康检查／浏览器阶段接入运行监控；健康检查的 2 秒上限覆盖响应头与 JSON 正文。后置数据库事务仍等待退出后检查，禁止仅用 Promise.race 在事务未结束时清理。
- 清理：全生命周期 error observer 覆盖监控解除与 disposer 启动之间的空窗；disposer 在 kill 前监听 error／exit，TERM 5 秒后最多升级一次 KILL，再等最多 5 秒。不因子进程失败跳过其他自有资源清理。后置事务原始错误、runtimeErrors、cleanupErrors 并列保存，固定错误码不包含原始凭据；独立 agent 最终复核确认先前发现的两个遗漏消除。
- 扫描故障报告新增 inspect／identity／connectivity 阶段和严格白名单 causeCode。inspect 失败只代表观测不可用，不推断容器已删除或 OOM；PING 仍仅是连接检查，不是扫描通过。
- owner 回归：脚本 3 文件 116 项通过；交付页面与上传组件 2 文件 44 项通过；全项目 `npm run typecheck` 退出 0，scoped diff check 与浏览器脚本语法检查通过。这些数字不包括完整真实扫描验收。
- 轻量真实进程／HTTP 探针：`artifacts/ops-runtime-monitor/42ed0a1f-6b49-44d7-8a4a-405304685bbe/result.json`，7 个场景通过；真实卡住的 JSON 正文在 2005ms 后取消且连接关闭，实际退出 0／7 与找不到 executable 均拒绝，正常 TERM 清理确认。源文件前后哈希相同；这是监控 helper 的实际进程／socket 探针，不是完整 runner／交付流程验收。
- 真实 runner：首次 `fbdfb255-9dce-4e15-bcd6-ff806a806e04` 的登录与双路径 403 已通过，但新 shot-scraper capture 缺失工作区 sessionStorage，未通过截图门禁，原失败保留。修复仅在截图浏览器中设置同一隔离工作区连接配置并重新打开真实路由；没有伪造角色／API 响应，没有保存 cookie 或密码。
- 修复后 `a77d4f5c-8f17-40ac-a833-df7af1c230d0` 完整权限用例通过（6.4 秒），实际签名 OIDC → API/MCP → PG/Redis，Chrome APIRequestContext 与真实同源 fetch 均严格 403 / AUTHZ_WORKBENCH_MISMATCH。证据：`artifacts/ops-jit-isolation/2026-09-14T23-52-29.993Z-7236c220-4e17-4fd5-9adc-59a74907c10f/delivery-auth-boundary-1789429957733/`，包括 result.json、shot-scraper PNG、WebM。owner 已查看 PNG，明确呈现已验证身份与客户交付拒绝；截图时页面仍显示正在刷新，不能据此扩大宣称整站稳定性／整体视觉验收通过。
- 两轮权限验收均未启 ClamAV、没有上传或业务写入，自有 PG/Redis disposal 为 leftRunning=[]；未停止其他项目／业务容器，未修改 VM 配置，未提交推送。07:53 guest available 回升至 2,175,451,136 bytes（约 2.03 GiB），swap 仍为 0；07:46 宿主机 swap 已用约 9.6 GiB。没有发现可确认为闲置且获授权停止的测试服务。恢复的空闲内存不等于已证明能承担重型扫描峰值。

`verify-feature`：本轮真实权限拒绝路径通过；七附件扫描及并发撤销仍 BLOCKED，需稳定、充足的验收资源后复跑。host 级 scanner lease 仍未实现；账号生效目标仍未唯一绑定，未擅自恢复企业／成员权限。

## 23:18 多 agent 续修

- 已确认根因：guest kernel journal 分别在 22:21:55 和 22:36:05 明确记录 global_oom，目标是 1919／88dc 两次运行的精确 clamd 容器 ID。证据只保留目标行和资源聚合，见 `artifacts/ops-jit-isolation/2026-09-14T14-33-26.836Z-a07eaca8-032a-4194-8d5e-a3a7690b8f0b/owner-runtime-cause.json`。此前“退出原因未知”已被此证据取代；不能仅因事后 docker events 空或容器已自动删除而排除 OOM。
- 页面测试：React 撤权 render 尚未提交时就完成模拟写入，会使测试看到随后被 abort 的旧读取。前端 agent 仅修改两个用例，先观察撤权警告和禁用按钮，再完成写入；仍严格断言没有新读取／旧租户结果不渲染。agent 连跑 3 次每次 12 项通过，owner 又将即时 isVisible/isDisabled 断言改为显式轮询等待并复跑 12/12。未放宽权限或请求隔离断言。
- owner 接手验收脚本：scanner 返回独立截止时间的 exact-ID／隔离结构／端口检查和 PING，失败记录白名单状态与固定错误码；PING 仅是可用性探针，不代替 freshclam／EICAR／真实扫描。runner 每 5 秒串行探测，构建和浏览器阶段可快速失败，后置验收也检查故障锁存，结束等待在途探测，不以启动就绪作为全程健康。
- 清理修复：scanner 清理报错不再跳过 PG／Redis；网关／子进程清理也独立收集错误。保留原始运行错误和所有清理错误，写本轮 `run-failure.json`，不让最后一个清理错误覆盖最初故障；不输出原始 daemon 错误或凭据。
- 回归：新增 6 项红测（原 helper 不存在／原清理逻辑无保护），实现后增加快速阶段不能抢在首次探测前通过的用例。owner 脚本安全／清理／监控 2 文件共 92/92 通过；全项目 `npm run typecheck` 和 scoped diff check 通过。这些是回归证据，不是 scanner 新版本真实运行通过。
- 当前阻断：23:17 owner 只读刷新 guest 内存为 total 6,197,440,512 bytes、available 151,367,680 bytes（约 144 MiB），swap 为 0，且没有运行中的同用途隔离扫描器。仍不能认为单独启动一份 scanner 必定足够。本轮没有重新启动重型扫描、调整 VM、停止业务容器或删除数据。
- 互斥方案仅完成设计：host 级 lease／存量 scanner 预检尚未落盘，负责实现及后续审查的 agent 触发额度限制。owner 没有把这部分作为已完成。下一步需资源充足、避免并发重型验收的环境，再完成互斥实现与真实七附件／并发撤销复验。

`verify-feature` 的真实运行验收当前为 BLOCKED，不以本轮回归绿灯声明完整交付。账号生效绑定问题仍保持原边界，未擅自启用账号或企业。

## 22:43 当前运行结论

- 最新 owner 完整运行 `88dc0bd1-a4e1-4f36-a494-c201bfcfafa2`：合同、付款附件真实 clean，档案保存 200、付款日期／中国时区上线时间／两类附件刷新回显通过。接入附件仍 pending，页面未回填、不能完成。14:36 UTC 按该运行 readiness 精确 ID 检查发现扫描器已不存在；当时 PG／Redis 身份相符、running 且无 OOM 标记。稍后本轮 PG 等待聚合未发现活动阻塞。扫描器退出原因未确定，不能推断为代码锁死或宣称已修复环境。
- 新证据位于 `artifacts/ops-jit-isolation/2026-09-14T14-33-26.836Z-a07eaca8-032a-4194-8d5e-a3a7690b8f0b/`。owner 已查看实际 `profile-fields-reloaded.png`，表单能回显，但背景有 3 个数据集刷新失败提示，因此不称整体页面健康。测试最终失败，未执行七附件 collector／并发撤销成功证明。PG／Redis 清理完成；扫描器 22:42 精确复查不存在并补证，未清理任何其他任务或业务容器。
- 上传瞬态读取体验：仅未收到 HTTP 响应的 API_REQUEST_TIMEOUT／API_NETWORK_ERROR 最多连续重试 2 次；成功重置、重试计入原轮询总上限、显示重试提示、保留已有素材，不重试上传。权限／显式 HTTP 拒绝／扫描 blocked／错误素材／主动取消仍立即停止。agent 红测后修复；owner 又新增 401／403／409 即使带超时错误码也不得重试的 3 个红测并修正，最终 32/32 通过。该重试不会使扫描器退出或未知网络错误成为成功证据。
- 22:41 最新全项目 `npm run typecheck` 退出 0。共享 main 在本 owner 可观测检查中一直为 dc72e177，上传两文件原本已是未跟踪；不将子 agent 的旧上下文“HEAD 被切换”作为本轮事实。已保留全部他人工作区修改，未提交、推送或部署。

- owner 最新 API／授权 6 文件 240 项通过，全项目 `npm run typecheck` 退出 0。前端 agent 全量 95 文件 581 项与生产构建退出 0；定向页面权限撤销测试曾失败一次，复跑通过且测试数量发生变化，工作区有其他 writer，尚不能仅凭复跑排除竞态风险。
- 真实运行 `712425dc-1d1f-4fe5-b3aa-1b128e78cd9e` 的只读诊断显示：合同真实 clean、扫描回执／哈希／大小／用途都匹配，但 `authorization_exists=false`。允许的上传原先使用 mutation 审计策略，而平台授权 helper 仅对 allow_and_deny 写允许决策；SQL 204 登记凭证要求该决策，故拒绝为 23514。修复将仅上传方法单独设为 allow_and_deny，其他方法不变，不放宽 SQL、不补造历史审计；旧附件需重新上传获得当前真实授权。策略和契约改动写入前已由未知并行 writer 落盘，本组保留并复核，另补 helper 回归。
- 对上述精确 `23514 / customer delivery evidence is unavailable` 转为可修复 409；其他数据库异常不吞。401／403、未知错误与扫描拒绝门禁不变。owner 验收指纹加入授权策略及上传／页面／客户端源码。
- 最新真实运行 `1919caad-9657-44a4-b25f-902d7b112267` 已确认新上传授权审计、扫描和绑定诊断全部匹配。页面首个 asset.get 耗时 32.37 秒，超过前端 10 秒超时，留下“失败／重试检查”并停止轮询；同窗口 healthz 503 DATABASE_UNAVAILABLE。因此本次失败是实际运行问题，不能以干净对象存在视为 UI 成功，也不能确定是哪条 SQL 导致慢响应。正在补只读查询的有限瞬态重试，不改上传写入／权限和扫描门禁。
- 本次证据目录：`artifacts/ops-jit-isolation/2026-09-14T14-19-47.432Z-d4810235-6afa-48d8-bb70-1e5fe9a05068/`，包含失败 UI、RPC、只读绑定诊断和清理记录。PG／Redis `leftRunning=[]`；扫描器首次停止未确认，22:30 同一 daemon 精确 ID 复查已不存在，补 `owner-cleanup-recheck.json`，未执行共享清理或伪改历史失败。
- 22:19–22:20 共享只读健康复核：API／replica、6 类 worker、PG／Redis 均 healthy，重启及 failing streak 都为 0。数据库和 API／worker 源码至 207，与彼此对齐；当前工作区已有 208_alert_webhook_receipts 尚未部署。201–207 checksum 均匹配，未执行迁移或重建共享服务。

以下段落为历史时间线；凡与本节不一致，以较新的真实证据为准。

## 本轮 owner 整合（21:35 前）

- 并行分工：仓储／事务、API 输入与 MCP、最新迁移运行验证、账号生效闭环审查、共享 worker 健康、独立验收脚本审查。各 agent 的文件范围独立；owner 修改 API 接线并重新运行测试与真实 PG。
- 输入：公司名编辑与新建统一 200 字符限制；profile／培训引用／清单 JSON 的值和键拒绝 PostgreSQL 无法表示的 NUL；深层 JSON 以迭代检查避免递归溢出。保留合法空草稿、换行和字面反斜杠文本。新增日期偏移反例先复现 API 200 与 PG 22009 不一致，再把偏移小时限制为 15，和实际 PostgreSQL 输入边界一致。
- 仓储：五类修改先按素材 ID／用途排序核验并加锁，再以父行 NOWAIT 和版本／完整快照重核；仅父行重核的 55P03 映射可刷新 409，其他数据库异常不吞。get/list 全量核验历史完成凭证，仅明确的不可用证据投影为未完成，不改历史事实或审计。撤回 incomplete 不再验证未改动的旧合同；新写 contractRef／清单 asset_refs 规范化，避免带空格引用漏掉撤销触发器。
- 仓储源码冻结 SHA256：`36f6e767ba1274a5dc5509a943f2a00d84ca828b6bd9082e763188012abda41d`；owner 重跑仓储 106 项及其他 14 文件共 261 项通过。API 3 文件加入 4 个时区反例后 159 项通过（输入 123、上传 33、锁错误 3）。运营前端 95 文件、578 项通过。
- 真实 PG owner 证据：`artifacts/customer-delivery-postgres/run-70q2aD/result.json`，200→207、18 项历史数据、完整旧假凭证 get/list 遮蔽、六用途不存在引用拒绝、原子回滚、版本冲突、RLS、只追加审计、软删除通过；源码前后哈希相同。零 asset／receipt／admission 人造可信证据，因此这不是扫描成功证明。自有 PG／Redis 清理 `leftRunning=[]`。
- 共享健康只读复核：21:04–21:05，sync／publish／reconcile／generation／automation 五个 worker 已 healthy，最近 5 次 healthcheck exit 0；当时容器与工作区迁移尾版本均 206。未重启或重建共享服务；此证据不覆盖随后新增 207 的部署一致性。
- 全项目类型检查曾出现 owner 验证脚本 PoolClient 重载类型错误，已修正；随后商家页三处 props 缺失也已由原修改方补齐。21:35 前局部 `tsc -b` 与运营前端类型检查均通过；21:48 最新全项目检查因本组之外新增 `aliyun-ack-rrsa-credentials.ts` 的环境类型／默认导入构造类型，以及 `production-readiness.e2e.test.ts` 的 possibly undefined 失败。未覆盖这些并行改动，不能将早期通过冒充当前全项目通过。
- 新增 `scripts/verify-customer-delivery-owner.ts`：完整浏览器和只读扫描 collector 通过后，再使用本轮真实扫描付款附件执行并发撤销。绑定 PostgreSQL 阻塞 PID，检查修改原子拒绝、完成时间清空、不重新生效、仅一次撤销审计；不伪造回执、不恢复 clean。同时记录源代码和迁移哈希，强制撤销回调确实执行。尚须真实运行通过才能计入验收。
- 首次 owner 完整运行 `b45a39f2-4747-4113-b08b-c3de008ec0c6` 在创建 ClamAV 容器阶段失败，未进入浏览器。PG／Redis 已清理；扫描器后来发现为本轮精确标签的 Created 容器 `84acd3baaca16b377e36b85dd89bdd7a0a2186f5eac813198c12f3a7b63c842a`，核验镜像、run-id、autoRemove、无挂载和仅 /tmp tmpfs 后，用非强制精确 ID 删除并复查不存在。未删除业务数据。同期 PG 失败运行 `run-RhvbhO` 所报容器 `ba074d…` 经同一 daemon 精确 inspect 已不存在；历史失败记录保留，不追认为成功。
- 第二次完整运行 `52b0cac7-639b-4cb8-aaed-e13e858c511e` 停在 ClamAV 120 秒准备期限：进程 running、无 OOM，freshclam 下载 `daily-28110.cdiff` 超时后仍在验证数据库。全部自有容器清理 `leftRunning=[]`。新增可选 `OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS`，默认 120 秒、最大 300 秒，任何资源创建前拒绝非法输入；不改病毒库新鲜度、EICAR、扫描签名或隔离规则。owner 85 项预算／隔离测试通过，已用 300 秒真实重跑，尚不凭配置修改宣称网络启动问题已解决。

### 仍需产品语义确认的账号生效

交付→工作区→企业已有绑定，但交付→具体登录账号／成员没有绑定；203 仅约束 workspace identity binding 必须有成员。完成仅更新交付档案，不释放商家/API/MCP/worker 访问门禁。需确认按指定账号还是全企业生效，以及后续凭证失效是否阻断新业务。建议独立可审计的 delivery_access 条件与账号／成员／企业停用、商业权益取交集，禁止自动恢复管理员停用；人工付款登记不授商业权益。未确认前不擅自扩展权限。

## 多 agent 优化与最新阻断

- 桌面 UI agent：表格列宽合计 1088px，交付状态固定右侧，长公司名省略并保留完整提示；培训确认／收起置顶，凭证和上传左右排布。保持主页独立勾选、全部上传回显和忙碌状态保护。owner 将完成时间由原始 ISO 改为操作者本地日期时间，不改持久化瞬间。该界面修改遵循已读取的 UI/UX skill 的可见反馈与信息层级规则。
- 输入校验 agent：新增 73 项真实 loopback API 边界测试，先复现 4 个公司名称错误类型导致 500、26 个非法字段／状态／日期被保存。owner 新增 `customer-delivery-profile-validation.ts` 并接入更新入口后，73/73 通过；同批上传回归 33/33 通过。保留可空草稿字段，拒绝无时区上线时间、不存在日期和错误枚举，不伪造扫描结论。
- owner 最后复跑：运营前端 95 文件、576 项全部通过，完整 `npm run typecheck` 通过。此前 534 项后端定向测试与 PostgreSQL 200→201→202 的通过记录属于当时基线，不能覆盖之后新增的 204。
- 历史 204 复核曾发现普通修改重新生效和反向锁顺序问题；随后全量凭证核验、205–207 迁移及本轮仓储资产优先／NOWAIT 已发生变化。旧结论不再直接适用于当前代码，最新验证见上节。
- 204 和仓储在复核期间仍被其他任务改写。本组没有覆盖、回退或删除这些变更，已暂停重叠文件写入；已知历史后端／审计／标签 agent 均确认不是当前写入者且已冻结。需协调唯一 writer 后才能继续整合并重新运行最新 PostgreSQL 和七附件完整验收。
- 当前 PG 验收脚本也需适配 204：原合成引用会被新 SQL 门禁拒绝，legacy 数据库只迁移到 202 时缺少新 SQL 函数。不得通过补造扫描回执或削弱 SQL 校验使其变绿。

## 新版字段与凭证集成（本轮 owner 复验）

| 环节 | 字段及解析 | 业务保护 |
| --- | --- | --- |
| 客户档案 | 公司名、合同编号、合同文件／HTTPS 链接、付款状态、付款日期、付款凭证、项目／售后负责人、需求上线时间 | 必填与日期校验；付款凭证核对档案、用途和真实可信扫描，人工付款登记不代表支付已结算 |
| 系统接入 | 固定 10 项，逐项 completed、说明、asset_refs；严格 items_json 解析、批量保存和回显 | 完成项必须有对应接入凭证；禁止普通 patch 或 scalar 直接修改汇总 |
| 功能测试及验收 | 固定 8 项，同样持久化勾选、说明和凭证 | 完成项必须有对应验收凭证；不自动完成培训 |
| 客户培训 | 主页独立勾选、trainingEvidenceRefs；缺凭证时同一行展开上传 | 不进入二级抽屉；上传后还需明确确认；撤回独立审计 |
| 交付视频 | MP4／WebM 多段上传、逐段扫描、登记及回显 | 未扫描素材不得登记；部分成功后重试不重复登记 |

解析范围为字段类型／JSON／日期／素材引用及文件格式、实际字节、SHA256 校验；尚不包含从合同、截图或培训文档自动 OCR／提取业务字段。没有把文件已上传当作内容已解析，也没有用病毒扫描代替功能验收。

本轮修复：多上传组件统一忙碌计数、切换档案后迟到响应隔离、显式清空付款日期、严格拒绝损坏凭证数组；汇总由真实 18 项推导；旧记录缺证据时不再错误显示完成。PG 读取持有父行共享锁，写入持有同一父行更新锁，避免拼接不同提交时点形成假完成。补齐批量更新审计旧清单和普通档案更新审计旧视频；空 patch 不改变 revision。

### 202 基线已通过

- owner 全量 `npm run typecheck` 通过；运营后台 TypeScript／Vite 生产构建通过。
- owner 24 个定向后端／API／worker／契约／迁移测试文件，534 项通过；运营前端全量 95 个文件、572 项通过（包含交付 5 文件 49 项）。
- 真实 PostgreSQL 17、Asia/Shanghai：字段、18 项、并发 revision、RLS、商家角色拒绝、审计只追加、旧视频审计准确、视频软删除通过。
- 在本轮独立 PG 实例内新建唯一临时数据库，真实执行 200→201→202：201 校验和不变；历史付款、培训及原始完成时间保留；读取不改行或审计，缺证据返回未完成；先付款后培训逐组补证成功；缺 18 项仍不能完成；新非法状态通过仓储和 SQL 均原子拒绝。
- 数据库证据：`artifacts/customer-delivery-postgres/run-fY621h/result.json`。该测试中的引用明确为合成仓储夹具，不是扫描证据。本轮临时 PG／Redis 已停止，`leftRunning: []`，未删除共享业务数据。

### 浏览器复验记录

- 首次新版运行 `51011f4c-e7ed-42c4-b81d-6e3cb78616e7`：合同、付款、接入、验收和培训五份 PDF 真实上传扫描并回显；脚本在培训“收 起”按钮精确文字匹配失败，未宣称七附件完整通过。
- 修正按钮选择器后，第二次运行 `2e18bea0-ca41-4b99-8b4d-67afe0fcc1ee` 停在 Chrome CDP 读取上传响应正文（`Network.getResponseBody: No data found`）。正在将脚本取证改为同一页面实际 fetch 响应副本与请求 ID 关联，不 mock 响应，不跳过上传／扫描断言。
- 新增独立 owner 验收脚本，使用真实 fetch 响应副本按 JSON-RPC ID、方法和状态关联；刷新前与结束时检查捕获失败、待完成和非预期取消均为零，不导出 cookie、上传正文或扫描签名。
- 运行 `bfb0b4e4-b1fb-4e1c-bc39-6b98c44f5a9f` 因扫描器启动及 Docker 查询超时未进入浏览器。PG／Redis 清理完成；扫描器精确 ID 随后在同一 daemon `inspect` 返回不存在、`ps -a` 无匹配，补充了 `owner-cleanup-recheck.json`，未执行共享容器清理。
- 运行 `940c3252-2430-4dee-bacd-f0a7dd91326b` 已完成七份真实附件的页面上传扫描回显、18 项、培训、两段视频、shot-scraper PNG／WebM、取消隔离与三次复用；最后 workspace 反向 API 断言因该次编译快照缺少 `x-workspace-id` 而返回 401，整体仍判失败，未执行最终只读扫描持久化 collector。证据保留在 `artifacts/ops-jit-isolation/2026-09-14T11-43-13.890Z-82845890-d325-44f2-a58f-28198f6e009c/`，不能以部分浏览器成功冒充完整通过。
- 补齐工作区头后，小型真实权限验收 `f1390f7b-fd7d-4247-ac5d-2b9044e81dca` 通过（6.5 秒）：独立 workspace 账号真实登录，APIRequestContext 和浏览器同源 fetch 均严格返回 403／`AUTHZ_WORKBENCH_MISMATCH`。未放宽服务端权限，也没有上传或扫描。证据在 `artifacts/ops-jit-isolation/2026-09-14T11-56-55.882Z-310e7631-c7dd-43af-bd6f-6aa44cb7510b/`。
- 共享环境另观察到数据库到 202、旧 worker 镜像到 201，严格版本门禁曾使六类 worker unhealthy；随后发生外部受控停止／重建。owner 没有重启或改写共享服务，不能把独立验收作为其当前部署健康证据。

## 初始基线已验证范围

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
node --import tsx scripts/run-ops-password-e2e.ts dogfood/chatgpt-all-functions/ops-delivery-isolated.spec.js
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
- 此阶段 HTTPS 合同链接仅作为外部凭证登记，不承诺已被平台扫描；当时移除了不执行上传的选文件按钮。后续直接上传已接入，见下方补验。
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
  node --import tsx scripts/run-ops-password-e2e.ts dogfood/chatgpt-all-functions/ops-delivery-isolated.spec.js
```

`scan-result.json` 为数据库/对象链路证据，`browser-result.json` 为桌面操作证据；`scanner-readiness.json`、两份 disposal 文件及 shot-scraper PNG/WebM 是对应运行的配套证据。扫描类型识别不等于合同内容语义解析，也不代表真实模型、支付或账号生效联动已验收。

后续工程项：新扫描事件执行查询仍沿用按素材读取有限历史事件的接口，长期大量重扫应改为按事件 ID 精确读取。客户档案完成与账号/权限实际启用仍是独立未验收项；不得据此自动恢复已被管理员停用的主体。
