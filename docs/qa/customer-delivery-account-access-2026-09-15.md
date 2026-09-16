# 单账号交付绑定与准入：owner 验收记录

状态：实现、真实 PG、双账号桌面／密码／OAuth／真实扫描隔离运行验收通过（2026-09-15 13:52 CST）；后续共享 API／worker 版本同步于 14:14 验收通过，见 `local-worker-version-sync-2026-09-15.md`。不表示生产发布或真实商家商业开通。

## 范围

- 明确选择真实商家登录账号，按 workspace + identity 唯一、不可替换绑定；不按公司名或建档人推断，不回填历史档案。
- 所有档案字段、18 项清单、培训和视频证据沿用原交付闭环；实时重验扫描证据，不缓存原始 effective_at 作为准入事实。
- 已绑定未完成返回 `CUSTOMER_DELIVERY_REQUIRED`；读取故障返回 503 `CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE`；未绑定历史身份保持原行为。
- 交付准入与现有管理员停用、成员/角色、企业状态、付款和创意点门禁取交集，不调用启用接口，不发点或订阅。
- 恢复操作精确列举，包括会话、无意图启动、状态、店铺接入和购买恢复；真实业务读取、生成和发布不能因“只读”标签而豁免。

## 已完成的 owner 验证

真实 PostgreSQL 212 升级、真实 merchant_ops / merchant_app 角色、RLS、复合 FK、绑定唯一/不可变、分页、改名回读、审计原子性和并发停用竞争通过：

- `artifacts/isolated-postgres/run-WaO9QG/run-result.json`
- `artifacts/isolated-postgres/run-WaO9QG/vitest.json`
- 2026-09-15 13:01:42–13:02:10 CST，1 个完整运行场景，无跳过；新建独立 PG/Redis，未继承业务数据库，两个精确 owned 容器已清理，leftRunning 为空。

图片执行 `failBeforeProvider` 真实 PG 并发场景通过：`artifacts/isolated-postgres/run-McHBTo/run-result.json` 与 `vitest.json`。验证真实 merchant_app、精确归属 CAS、重复取消只一赢家、与开始/未知状态竞争、不可擦除 request ID、已知失败不得重新领取。首轮 `run-LMn45o` 因新测试数据库漏执行标准角色初始化而失败，补执行实际 `infra/local/ensure-app-role.sql` 后重跑通过，未临时扩大权限；首轮失败证据保留。

已运行受控回归（统计有重叠，不累加为唯一总数）：

- 桌面四文件 112 项，含 Chrome 32 项；测试真实浏览器交互，API 为受控测试适配器，不冒充 PG 全链路。
- 合同导入和契约 101 项；保留前轮七附件真实扫描证据。
- API 入口新增双身份测试、MCP/HTTP、异常 503、待验收状态、会话豁免与禁止前置发点；只读 hydration 的禁止提前重排任务回归已通过。
- worker 最终检查、AI/connector 底层钩子覆盖异步预检、分页、锁和重试；真实请求计数为 0 才可关闭预留图片执行，不将已发送请求标作未发送。
- 全项目类型检查多次通过；新代码整合后仍需最终一次。

2026-09-15 13:29，owner 合并回归 15 个文件、515 项全部通过，报告为 `artifacts/customer-delivery-account-access/owner-final-regression.json`。随后独立复核发现调用前只重读成员状态、未重验成员角色能力的问题，已补当前角色能力检查；这 515 项不作为该后续修复的验证证据，需再次运行。

13:38 owner 在补齐角色能力与精确资源复核、修正身份操作角色契约后，重新执行 6 文件 274 项全部通过，见 `owner-post-review-regression.json`。精确资源复核在原检查成功后登记素材／商品／品牌／任务品牌与最低权限，实际派发前重读当前权限及素材绑定；管理员宽权限路径同样登记，避免等待期间降级后继续使用旧准入。

13:50:51 owner 在审计时间修复后重新运行 **22 文件、616 项全部通过，零跳过**：`artifacts/customer-delivery-account-access/owner-final-with-audit-regression.json`，27.33 秒。包含新增角色降级 2 项、品牌／素材撤权 4 项、平台身份变更角色契约 18 项、审计仓储 24 项，以及 API/MCP、worker、五模态底层钩子与契约回归。上述各轮有重复，不再累加计数。全项目 `npm run typecheck` 同轮退出 0；运营后台生产构建已通过。前端独立四文件 112 项（含 32 项 Chrome）与此分开记录。

复核中已修复：OAuth 未加载权限修订、密码/OAuth UUID 与历史成员登录名映射、一次性 JIT 已消费后的精确复核、会话误入交付门禁、图片快照错误映射、请求 hydration 提前重排自动任务、企业停用后的 worker 执行检查、品牌发布快照上下文。

## 真实运行验收与保留的失败轮次

首轮完整验收 `artifacts/customer-delivery-account-access/run-JhLEa4/run-result.json` 保留为失败：真实七附件扫描、桌面显式绑定/刷新回读，以及 A 被交付拦截、B 保持原状的对照均已执行，但脚本误把 `platform.store.list` 视为必然成功的恢复入口。实际返回 `503 / CREATIVE_POINTS_UNAVAILABLE`，该方法原有商业分类为 `POINT_REQUIRED_NO_CHARGE`；交付豁免不等于免除商业限制。已只修正两个验收文件，补绑定前 A/B 的精确恢复基线与 pending/ready/revoked 对照；不接受任意 503，不改变生产门禁或余额。失败轮 297 份源码指纹未变，独立 fixture 已清理，完整闭环仍待新一轮。

第二轮 `run-8oqGt3` 的桌面两场景全部通过，真实七附件 collector、密码与 OAuth 稳定身份、交付 ready、账户停用／恢复对照通过；成员停用阶段发现生产角色冲突后保留为失败。真实日志显示 `identity.update` 授权 allow 后仍被 handler 旧 `platform_ops` 检查拒绝。修复四个身份管理 handler，使平台工作台内的角色检查从正式 capability contract 派生；未给 fixture 增授角色，未绕过正式 deny／revision／reason／self 保护。脚本增加脱敏操作观测，未放宽断言。此轮 297 份源码指纹未变，owned OAuth 进程和三个 fixture 容器已清理；成员／凭证撤回仍待新一轮验证。

第三轮 `run-GkSdZL` 的桌面 2/2、七附件 collector、密码／OAuth、实际 `ops.user.suspend` 成功及两入口拒绝／B 不变通过；后续 `ops.user.detail` 返回 500，完整运行仍保留失败。定位为审计仓储将 PG 的 `Date` 直接声明为 `string` 返回，第二条成员审计加入后触发 `localeCompare` 排序错误；此前单条记录不触发比较。只修复仓储时间归一化，不移除审计、不跳过详情读取、不用直接 SQL 替代正式运营接口。该轮 302 份指纹未变。

最终通过报告：`artifacts/customer-delivery-account-access/run-Oyv0Cv/run-result.json`，13:50:49–13:52:39 CST，`status=passed / stage=complete / sourcesUnchanged=true`，304 份源码与测试指纹全程一致。

完整证据目录：`artifacts/ops-jit-isolation/2026-09-15T05-50-50.213Z-60cf8c33-8dc3-413b-91ab-61b893ecd71e`。桌面 2/2 场景通过（50.8 秒），未 mock 浏览器 API；7 件附件经真实 ClamAV 1.4.6／病毒库 28123 扫描，EICAR 自检通过。API 实际完成签名验收，collector 核对持久签名一致性、摘要、字节及回执，不导出签名或私钥。素材／审计以 merchant_app、交付以 merchant_ops 只读核验，未使用 RLS bypass。

- 明确选择 A 的真实登录账号并确认绑定；A 待验收被拒绝，同企业 B 保持原基线。完成七附件、18 清单及培训后，A 回到原业务／商业门禁，未自动充值、订阅或改角色。
- 密码与真实 PKCE OAuth 对应相同持久 identity；原生 `tools/call` 与密码 HTTP 均实际调用。正式成员停用、详情回读、恢复均 200，停用时 A 两入口拒绝、B 不变；身份停用后恢复入口同样拒绝。
- 仅对 owned 测试培训素材做 clean→blocked 可用性故障注入，真实扫描回执不变；数据库触发交付失效，同一会话下 A 再次 `CUSTOMER_DELIVERY_REQUIRED`，B 不变。该注入不冒充运营人工操作；实际证据失效审计单独验证。
- 真实 PG 核对：2 个账号成员关系、1 条绑定审计、7 条上传审计、18 项完成清单；成员停用／恢复、证据失效、身份停用审计各 1 条。四张创意点相关表前后均 0，既未发点也未扣点。
- owner 已逐张检查 `account-access/account-selected.png`、`account-bound.png`、`account-reread.png`；界面显示登录账号，不显示账号 UUID。6.44 秒、1440×900 VP8 录像已解析并检查 3 秒帧（`run-Oyv0Cv/account-binding-review-frame.png`），含明确选择、等待、确认及回读。
- owned OAuth 子进程及 PG／Redis／扫描器三个精确容器均已清理，`leftRunning=[]`；证据保留，未触碰共享容器。图片调用前确定性失败 CAS 的独立真实 PG 并发验证也已通过，见上文。

重跑命令（项目根目录）：`OPS_E2E_SCANNER_STARTUP_TIMEOUT_MS=300000 node --import tsx scripts/verify-customer-delivery-account-access.ts`。

边界：本轮没有实际付费模型、店铺写入或真实商家开通；排队／异步预检撤权的模型与 connector 验证使用受控传输，不能当作真实中转成功证据。密码账号状态测试是隔离数据故障注入；成员停用恢复使用正式运营接口。身份停用后的重新激活登录未做真实 PG 验收，不能从 Memory 角色测试推断该链路已通过。

## 共享环境与发布限制

2026-09-15 13:02 发现并于 13:53 再次只读确认：共享 local 的 6 个 worker 不健康；日志明确 `expected ... 211, found ... 212`。当时数据库已升级，运行 worker 仍为旧版，隔离验收轮没有重启共享服务。后续 owner 于 14:10–14:11 保留环境与数据卷，仅同步 2 个 API 和 6 个 worker；14:14 实际运行验收全部健康，完整 212 链、1,036 次无错误轮询、MCP 双副本一致及鉴权拒绝通过。该阻断已关闭，独立证据见 `docs/qa/local-worker-version-sync-2026-09-15.md`，不以隔离测试代替共享环境证据。

StoryForge 的原 11 个精确容器于本轮末只读核实全部 exited，不启动。未提交、推送或发布。使用 verify-feature 的实际桌面／运行证据要求，桌面账号确认沿用现有设计规范；合成支付文件、培训、清单和演示视频仅为测试数据，不证明真实支付、真实模型交付或真实客户培训已经发生。
