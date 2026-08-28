# 商家营销内容助手 Pre-mortem

日期：2026-08-22  
评审对象：`PRD-merchant-marketing-codex-final.md` v1.4  
假设：京东、淘宝、天猫、拼多多四个 schema profile 的应用、测试店铺和目标 scope，以及可完成 500 并发压测的预发布资源和模型/平台配额证据在 Day 0 已就绪；此后投入 9 名全职开发 15 个工作日，交付 Engineering RC 并逐平台 canary。

## 失败场景

假设 Day 15 结束后：插件能演示生成文案，但真实商家授权失败、商品映射不完整或平台写入状态不可信；一次超时造成重复商品，商家不敢再使用；团队又用 500 个空闲登录态和 mock 平台宣称“支持 500 家”，真实高峰却被数据库连接池、队列饥饿和上游 429 打垮。我们从这个失败结果倒推风险。

## Tigers：真实风险

| # | 风险 | 紧迫度 | 触发信号 | 缓解 | Owner | 截止 |
|---:|---|---|---|---|---|---|
| T1 | 四个 profile 的应用、scope、测试店铺或配额不齐 | Launch-blocking | Day 0 任一 CapabilityEvidence 仍 unverified | 不启动 15 日时钟；先完成官方审批和最小 API 探针 | P1/P2/P3/P4/P9 | Day 0 |
| T2 | 统一模型抹平平台必填字段，导致同步可读但发布失败 | Launch-blocking | fixture 无法无损映射；raw value 丢失 | 统一核心字段 + 平台扩展；四组真实 fixture contract tests；未知映射 fail-closed | P2/P3/P4/P5 | Day 2 |
| T3 | 超时、重复确认或 Worker 重启造成重复创建/错误覆盖 | Launch-blocking | 一个 confirmation 产生多个远端对象；unknown 被直接重试 | PublishJob + transactional outbox、唯一约束、平台幂等/发送前查询、unknown 先对账 | P1/P7/P9 | Day 9 |
| T4 | 发布确认后远端商品已变化，旧 diff 覆盖运营同事的新值 | Launch-blocking | 预检 hash 与发送前远端 hash 不同 | confirmation token 绑定内容/远端版本；stale 后强制刷新 diff | P7/P9 | Day 9 |
| T5 | 错 SKU、过期价格或无证据卖点进入 approved/published | Launch-blocking | 黄金集出现 1 次 P0 漏检 | 稳定 ID、事实来源/有效期、任务快照、确定性检查、P0 fail-closed | P5/P8 | Day 11 |
| T6 | OAuth Token、商家数据或对象下载跨工作区泄露 | Launch-blocking | 跨租户 ID 可访问；日志出现 Token | 服务端 workspace 条件、凭证信封加密、短签 URL、日志脱敏、IDOR/回调安全测试 | P1/P7/安全 | Day 11 |
| T7 | 九人并行形成集成悬崖，Day 8 才发现 connector 不兼容 | Launch-blocking | Day 5 仍依赖未验证 mock；公共 schema 每日破坏性变化 | Day 1 fixture、Day 2 contract v1、Day 3 起 P9 每日 E2E、Day 5/9/14 强制合并 | P1/P9 | 每日 |
| T8 | 平台协议、商家责任声明、数据地域或模型供应商未签署 | Launch-blocking | 真实数据进入系统但无书面批准 | 法务/安全为 Day 0–2 门禁；未完成时只允许脱敏样例和 sandbox | 产品/法务/安全 | Day 2 |
| T9 | 首次要求全店同步和多次确认，用户未见价值就退出 | Launch-blocking for pilot | TTFV P50 >15 分钟；授权页退出 >20% | 首屏提供上传/示例；默认同步一个商品；权限用普通语言解释；阻断问题渐进披露 | P5/P6/产品 | Day 6 |
| T10 | 平台规则、类目 schema 或 mapping 漂移后静默继续 | Fast-follow，P0 规则过期时阻断 | API/字段新增、规则超过核验期 | Rule/MappingVersion、来源/有效期、定期核验、未知字段 fail-closed、告警 | P2/P3/P4/P8 | Day 13 起持续 |
| T11 | P1/P9 成为 OAuth/状态机/发布的单人知识点 | Launch-blocking | 只有 Owner 能排障或回滚 | P1↔P5、P9↔P7 backup；结对评审；双人演练 runbook | P1/P5/P7/P9 | Day 14 |
| T12 | 小样本的 95% 被包装成已验证可靠性 | Track | 单平台分母 <20 仍对外宣称达标 | 指标展示分子/分母；小样本只作方向信号；P0 错误仍 1 次即 No-Go | 产品/P8 | 试点报告 |
| T13 | 500 并发只在空闲登录态或 mock 通过，真实负载被连接池、噪声租户或外部配额打垮 | Launch-blocking | 150 RPS 下连接池 >80%、队龄持续增长、其他租户 P95 退化 >20%、模型/平台大量 429 | 无状态 API、四类隔离 Worker、pooler/300 连接预算、公平调度；500 会话 + 500 作业突发 + 6 小时稳定性；真实配额单列签署 | P1/P8/P9 | Day 13 |

## Paper Tigers：被高估的担忧

- “四平台必须在一次任务中同时发”：独立子任务更安全；共享一个发布状态才是风险。
- “没有最终设计图就没有价值”：事实可追溯的详情结构、文案和设计 Brief 已能减少运营/设计返工。
- “500 家并发必须上微服务/Kafka”：无状态模块化单体多副本、隔离 Worker 和托管队列足够；微服务只会增加三周联调面。
- “自动发布必须无人值守”：用户二次确认后的一键写入已完成自动化闭环；定时/批量无人值守需要独立审批模型。
- “版本管理必须像 Git 一样任意分支合并”：P0 的线性不可变版本、候选版本、diff 和恢复已满足商家审计。

## Elephants：团队容易避而不谈

- 这个产品长期更像“电商集成与规则运营平台”，连接器和规则维护成本可能高于 AI 内容生成成本。
- 商家是否愿意持续确认事实、为降低返工/风险付费，目前没有强证据。
- 平台是否允许目标自动化用法、审批政策是否变化，需要长期协议 Owner，而不是一次性接口开发。
- 发布驳回、账号撤权和平台事故会产生客服/on-call 负担，9 名开发之外需要明确运营支持。
- 商家资料进入模型供应商后的数据地域、留存和训练使用边界，可能改变供应商与部署选择。
- 成功后用户会立刻要求批量、多商品、价格/库存联动和审批流，若没有商业优先级会迅速拖垮团队。

## Go/No-Go 行动计划

1. Day 0 逐格签署四个 profile 的 CapabilityEvidence；缺一格不启动对应 15 日承诺。
2. Day 2 以前用真实 fixture 冻结 Connector contract、PlatformWritePolicy 和 CommerceProduct；未定义写字段禁止进入开发。
3. Day 5 前完成一个已就绪 profile 的授权→同步→事实确认纵向薄切，同时另外三个 adapter 保持 contract tests 绿。
4. Day 9 前完成 transactional outbox、幂等、远端 hash、驳回和 unknown 对账故障注入。
5. Day 11 前完成 50 个样例及安全测试；P0 漏检、重复创建、跨租户访问任一发生即 No-Go。
6. Day 13 前完成 500 活跃工作区、150/300 RPS、500 作业突发、噪声租户和 6 小时稳定性；丢作业、重复发布或跨租户泄漏任一发生即 No-Go。
7. Day 14 由非 Owner 按 runbook 完成撤权、平台 429/5xx、API/Worker 崩溃、数据库池满、写 kill switch 和回滚演练。
8. Day 15 按 JD、Taobao、Tmall、Pinduoduo 独立给出 Ready/Conditional/Blocked，不用总平均掩盖单平台失败；真实商家按 10/50/100/250/500 分波放量。

本 Pre-mortem 在首次 production canary 前必须复核一次；每个 Launch-blocking Tiger 只有在附上测试/运行证据后才能关闭。
