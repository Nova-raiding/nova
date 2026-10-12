# 2026-10-12 当前交付验收证据矩阵（owner 最终整合）

唯一目标为 ECS `101 / merchant-demo-85575f9c`。PASS 仅覆盖表内范围；未验证的业务不计通过。10 个 agent 分批完成，owner 复核、整合并重跑检查；CodeGraph 实际只读查询，过期索引由源码补充，gstack 和 pm-verify-feature 用于真实运行验收。

| 验收范围 | 状态 | 当前证据与边界 |
|---|---|---|
| 实际 ChatGPT 本地 stdio 认证读取 | PASS | 正式插件重新绑定后，08:55Z 连续 workspace_health / onboarding_status / workspace_health 成功；业务 needs_input / in_progress。安装版本 `0.1.1+codex.20261012144725`，插件源码 c6d6f771，90文件一致。早期 Background 和宿主失败保留，不推断所有进程上下文均恢复。 |
| 标准重开 ChatGPT | PASS（只读调用） | 标准退出重开后的新会话真实调用 `workspace_health` 成功，返回 `needs_input / provide_materials`；macOS 钥匙串授权由用户在系统窗口完成。证明当前 Aqua 登录域的重启链路，不证明系统重启后的密钥持久恢复或商家资料齐备。见 [收据](../../artifacts/owner-release/2026-10-12-chatgpt-browser/chatgpt-standard-reopen-tool-receipt.json)。 |
| Codex 后台 MCP 连接器 | BLOCKED（宿主凭据） | 本轮只读重试返回 `MCP_CREDENTIAL_SOURCE_TEMPORARILY_UNAVAILABLE`，未向后端发送请求。与上方 ChatGPT 桌面成功调用属于不同宿主上下文。 |
| 宿主中转 Responses | PASS | 实际 deepseek-v4-pro 请求 HTTP200、111 tokens；模型目录403保留。不是商家文本结算/成本证据。 |
| 商家及 Ops 桌面浏览器修复 | PASS | 真实登录后导航、必填校验、零空订单请求、模型验收边界均部署后复测。Ops 真实 platform / ops_admin / rules_admin；企业审计403、平台审计200保持真实 scope。 |
| 风险匹配源码检查 | PASS | 全量 typecheck exit0；环境/模型20、配置24、runner相邻76、财务27及3个浏览器场景、fixture27、目标密码浏览器1；批次重叠不合计。临时容器清理完成。 |
| 唯一 demo 候选部署 | PASS | a36dda6061b3be9f1bc2517083305c8736866469 / release-a36dda60-desktop-ui；共享锁内审查部署，两UI镜像变化，API仅身份刷新。15服务healthy、四探针200；11 canonical及7外部容器保留。 |
| live migration 完整链 | PASS | 全部278条 version/name/checksum 与目标源码逐行匹配，部署前后不变；未迁移。不能代替真实 RLS 测试。 |
| 跨租户/RLS/并发 | 待验证 | 未取得本轮第二租户身份与真实拒绝、并发证据。 |
| worker 业务任务及幂等 | 待验证 | 容器健康通过；未驱动真实任务、回调、产物与结算链。 |
| 五模态商家生成与成本 | 待输入/验证 | 文本、图片、图片编辑、OCR、视频均未执行付费商家业务测试；需测试费用上限、合法素材与可用权益，保留真实鉴权/usage/cost/错误/产物证据。 |
| 规则及清单对账 | 待输入/验证 | 小红书规则配置缺失、对象清单对账未知、商家资料待补；不以静态配置或未知余额计通过。 |

部署候选固定 a36dda60，最终文档提交不改变已部署镜像。本轮修复可以审阅与交付；完整业务验收尚未通过。详见 [运行验收报告](2026-10-12-chatgpt-desktop-backends.md)，收据保存在 `artifacts/owner-release/2026-10-12-chatgpt-browser/`。
