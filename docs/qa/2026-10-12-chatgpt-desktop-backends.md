# ChatGPT 与两个桌面后台运行验收（2026-10-12）

唯一目标为 ECS `101 / merchant-demo-85575f9c`，访问入口 `yxsona.com` 与 `ops.yxsona.com`。本轮 10 个 agent 分批执行，owner 复核整合；不新增分支、worktree、常驻应用、权限或业务数据。付费商家生成未执行。

## 实际宿主链路

本机 Keychain 中已有桌面对话中转凭据。旧宿主默认 `openai`；备份用户配置后恢复 `damai_relay / deepseek-v4-pro`，密钥仅传入应用进程环境，没有输出或写入配置。真实 `/v1/responses` 返回 HTTP200、`OK`、111 total tokens 与 response ID；`/models` 返回403，不能用目录接口失败推断 Responses 不可用。

从实际 ChatGPT 窗口会话 `01a12f18-1ee8-7080-be23-b3c91dc455fd` 调用插件。早期观察到临时凭据不可用、UNAUTHENTICATED 和真实 macOS 钥匙串窗口，历史失败保留。随后通过正式本地插件登录流程恢复凭据，浏览器绑定完成，CLI 写入及读回校验成功。08:55Z 三次连续真实读取 `workspace_health → onboarding_status → workspace_health` 均通过认证，业务状态分别为 `needs_input / in_progress / needs_input`。详见 [实际宿主连续读取收据](../../artifacts/owner-release/2026-10-12-chatgpt-browser/chatgpt-final-authenticated-read-receipt.json)。这些业务状态表示待补资料，不是鉴权失败，也不证明付费生成通过。

中转密钥来自既有 Keychain，当前 Aqua 登录域已恢复进程环境。标准方式退出并打开 ChatGPT 后，中转模型可加载；该次重启后的新插件调用尚未取得可归因的收据，不计为通过。没有设置重启系统后的持久密钥副本。

## 两个后台实际只读验收

已登录商家会话完成总览、商品、品牌、素材、回收站、规则与财务导航。素材搜索/分类/空态、规则刷新、财务入口、直接路由和刷新恢复实际可操作；1440px桌面无横向溢出。实际品类读取503，显示余额尚未确认；空资产/订单不作为预览、详情或权益通过证据。

运营会话经服务端 `auth/session` 与 `ops.session` 确认 platform 工作台、`ops_admin / rules_admin`。总览、用户、客户交付、规则、账务和存储读取，以及筛选清除恢复、用户页面硬刷新已实际验证。企业审计403而平台审计200，保留实际企业 scope 拒绝；未授予权限来使测试通过。对象清单对账仍不可验证，小红书规则配置仍缺失。

## 最小修复与回归

- 两后台按真实 demo/production/未知环境呈现验收边界，demo 不再要求独立生产门禁；模型配置就绪仍不等于真实推理、成本或发布身份通过。
- 空订单 ID 查询由错误的“付款提交待确认”改为输入旁必填校验；空白输入不发请求，只读失败不制造新的付款未知状态，已有付款恢复保持。
- Ops 浏览器 runner 固定应用目录并拒绝零测试成功；实际组件已恢复的模型错误摘要由既有浏览器测试验证。
- 宿主中转配置编辑仅更新根 section，保护 profile、拒绝重复键及非法 provider，按字面替换模型名；不继承目录中的额外路由控制。配置/catalog 预准备并逐文件原子替换，失败时恢复旧 catalog；不是跨文件事务。
- fixture 就绪探针仅保留脱敏分类，不改认证、通过条件或等待预算；编辑过的密码登录浏览器用例复跑1/1通过，临时容器清理已验证。

已有证据：环境/模型20项、配置24项、runner相邻76项、财务27项及3个浏览器恢复场景、fixture27项、目标密码浏览器1项。各批有重叠，不相加。新源码桌面截图为明确标记的本地 fixture，不能替代部署后的 demo 复验。

## 发布状态

候选 `a36dda6061b3be9f1bc2517083305c8736866469` 已部署为 `release-a36dda60-desktop-ui`。更新服务为 `api api-replica ops-ui ui`；仅两 UI 镜像变化，API 镜像不变并刷新发布身份。既有共享锁内完成候选校验、部署和验收，随后正常释放；完整回滚材料保存在 ECS 保护目录。15 个 canonical 服务 healthy，四个公开探针200，完整278条迁移 version/name/checksum 不变；11个其余 canonical 服务及7个外部容器保持原 CID/镜像。未执行迁移、回滚、数据删除或权限授予。

部署后已登录桌面浏览器与 shot-scraper 实际验证空订单 ID 必填提示、零订单读取请求、Ops 模型环境边界，以及两后台六个页面导航。上述修复验收通过，不能扩展为全部业务交付。五模态付费生成、跨租户权限拒绝和 worker 真实任务链仍缺当前运行证据；小红书规则配置、对象清单对账和商家待补资料保持未确认。

证据目录：`artifacts/owner-release/2026-10-12-chatgpt-browser/`。CodeGraph 已实际只读查询，过期索引由当前源码补充，不称完全最新。
