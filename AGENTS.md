# 项目宪法

本项目是安装在 ChatGPT 内使用的插件。所有实现、验收和上线判断必须围绕真实的 ChatGPT 插件工作流展开：插件入口 → API/MCP → 模型中转 → 商家工作流/桌面运营后台 → 真实数据、权限和上线门禁。

## 硬约束

- 不漂移目标，不为未授权的平台或场景虚构功能和成功证据。
- 本项目只有一个常驻应用环境：ECS `101` 上的 `merchant-demo-85575f9c`，它是唯一 demo 验收和部署目标。不得把历史环境或本地测试栈称作第二个 demo，也不得创建常驻副本。
- `yxsona.com` 与 `ops.yxsona.com` 仅作为唯一 demo 的访问入口；除非用户明确修改本宪法，不访问或部署独立生产环境，也不以生产门禁代替 demo 验收。
- ChatGPT 侧只采用本地直装/本地 stdio 插件链路；不上公开或团队插件市场，插件市场上架不是需求、验收项或上线门禁，也不要求配置真实 ChatGPT OAuth。
- 不要求 Apple Developer ID 签名、公证或 ChatGPT 进程祖先签名/宿主身份认证；这些不作为本地直装/stdio 场景的验收或上线阻断项。商家及运营后台的 API 登录、业务权限和租户隔离仍须真实验证。
- 运营后台是桌面工作台；本项目不把手机、平板适配作为需求、验收项或上线阻断项。
- 模型调用必须通过已配置的中转链路，并保留真实鉴权、请求、用量、成本和错误证据；配置缺失必须明确显示为阻断。
- 商家、运营、API/MCP、数据库/RLS、worker 和发布门禁必须以真实运行环境验证，不以静态代码存在代替功能完成。
- 修改前先查现有实现和测试；修改后运行与风险匹配的类型检查、单元/API 测试、桌面浏览器验收和容器健康检查。
- 并行 agent 只能承担边界清晰的任务；所有结果必须由 owner 复核、整合并重新验证。
- 默认只保留主工作目录一个 Git worktree；确需临时隔离验证时，任务结束前必须复核改动、归档需保留的证据与提交，并移除临时 worktree。
- 日常开发只在 `main` 分支和唯一主工作目录进行；不要新建或切换到功能分支。历史分支先审计差异，已包含/被替代的标记为无需合并，仍有效的改动按最小补丁集成到 `main`，不可将过时分支头整体倒灌。
- 不删除业务数据或容器数据来掩盖问题；清理前必须确认目标、影响和可恢复性。

## 当前优先级

1. ChatGPT 插件真实链路和 MCP 契约。
2. 桌面运营后台的租户、用户、权限、账务、规则、模型和审计能力。
3. 中转模型五模态的配置、鉴权、成本证据和 fail-closed 行为。
4. 多租户隔离、并发稳定性、迁移完整性和唯一 demo 发布门禁。

## Demo Configuration
- Platform: Custom ECS via SSH
- Canonical environment: `merchant-demo-85575f9c` on SSH host alias `101`
- Demo URLs: https://yxsona.com and https://ops.yxsona.com (only while routed to the canonical demo)
- Deploy workflow: Manual demo runbook `docs/runbooks/ecs-demo-direct-deploy.md`
- Deploy status command: `ssh 101 'docker ps --filter name=merchant-demo-85575f9c --format "table {{.Names}}\\t{{.Status}}"'`
- Merge method: deploy only the reviewed candidate to the canonical demo
- Project type: ChatGPT plugin with API/MCP and desktop operations web apps
- Post-deploy health check: demo API `https://yxsona.com/api/healthz` and demo Ops `https://ops.yxsona.com/healthz`

### Demo deploy hooks
- Pre-deploy: `npm run typecheck` plus affected unit/API tests and local desktop-browser checks; follow `docs/runbooks/ecs-demo-direct-deploy.md`.
- Deploy trigger: Manual, following the single-demo runbook and its release checks
- Deploy status: `ssh 101 'docker ps --filter name=merchant-demo-85575f9c --format "table {{.Names}}\\t{{.Status}}"'`
- Health check: check demo URLs only after confirming both resolve to `merchant-demo-85575f9c`

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
