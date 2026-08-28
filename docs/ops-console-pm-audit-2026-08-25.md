# 运营后台 PM / gstack / CodeGraph 审计记录

日期：2026-08-25  
范围：运营后台现状、新营销能力接入、权限和文档一致性

## 审计方法

- PM 多视角：用户运营、架构、务实交付、风险红队。
- gstack：按 review/文档生成/架构图规范检查实现边界、风险和文档覆盖。
- CodeGraph：读取 `.codegraph/codegraph.db`，核对前端、API、领域模块、持久化和事件关系；由于当前索引对 Node/Vitest 外部符号存在 unresolved references，CodeGraph 仅作为结构关系证据，结论同时用源码和契约核对。

## 结论

当前项目有独立的 Ant Design 运营后台，已覆盖商业化、平台运维和营销能力治理的安全读取投影；真实平台 canary、支付 provider、SSO/OIDC 和多模态生产任务证据仍是上线门禁，不因本地构建通过而放行。

### 已覆盖

- 工作区、套餐、订阅、额度和财务；
- 平台开关、店铺别名、授权/readiness；
- 成员、角色、告警、审计、数据删除审批；
- 模型状态、生产证据、规则草稿和规则状态。

证据：`apps/ops-console/src/App.tsx` 的 `load()`、配置中心、规则中心、平台 readiness、财务和审计卡片；`apps/api/src/server.ts` 的 `ops.*`、`billing.*`、`platform.settings.*` 和 `workspace.health` 路由。

### 当前仍需生产化的部分

API/MCP 已具备、运营台已形成治理投影但仍需继续生产化的能力：

- `knowledge.rule.*`、`knowledge.asset.*` 已接入规则/资产状态展示；
- `knowledge.learning.*` 已接入待确认队列和确认动作；
- `knowledge.competitor.*` 已接入来源和差异化参考展示；
- `multimodal.generate`、`multimodal.image.edit`、`multimodal.video.request`；
- 驳回回执到内容版本、修正版和学习建议的跨页面处理闭环已有三项独立命令：安全重试、回执确认和创建修正版；队列负责人分配已通过 generation/publish job snapshot 与事件持久化，并在队列投影中展示。新增脱敏视觉候选队列和 `ops.marketing.visual.review`，运营可标记归档候选通过/阻断，但不能代替商家选图、内容审核或发布确认。

本轮已完成的安全修正：知识库规则、资产、学习建议和竞品治理接口已补齐运营角色门禁，并记录操作审计；多模态接口属于商家侧共享执行入口，运营队列命令仍需保持独立角色边界，不能把商家执行权限与运营治理权限混为一谈。

后续 gstack 浏览器回归发现运营台此前未解包 MCP 的 `data.result` envelope，导致接口成功但页面显示空数据；现已修复并补充缺失队列字段的默认值，隔离 fixture 页面实测三项队列按钮均可操作。

## 关键风险

本轮新增商业化审计结论：钱包扣款已接入生成、图片/视频和发布确认门禁，生产支付仍必须使用服务商签名回调；测试环境的 fixture 订单不得当作真实到账。平台范围现为六个平台：京东、淘宝、天猫、拼多多保留生产证据门禁，小红书/抖音已接入 fixture/API/运营配置但仍未宣称生产 ready。批量发布已具备可恢复批次、暂停/恢复、失败项重试和运营台投影，但不做无人值守批量提交。

1. 知识库治理接口的运营角色门禁已补齐；队列负责人分配已落地为 `ops.marketing.queue.assign`，视觉候选审查已落地为 `ops.marketing.visual.review`，仍需真实图片 provider 和运营台宿主回归证据。
2. 规则需要区分 shared/global 与工作区私有范围，避免全局规则和客户规则混用。
3. 运营台当前使用 `/ops/{governance|tasks|stores|finance}` 可恢复 URL 导航和服务端角色门禁，同时兼容旧 hash 链接；店铺目录已展示同平台多账号授权/同步状态并支持受控别名修改与撤销；商业、平台、规则编辑控件已按角色进入只读禁用态。
4. 当前演示配置使用浏览器 localStorage 保存 token；生产应升级为 SSO/OIDC、短时会话和 httpOnly cookie。
5. 知识数据虽有事件恢复机制，但长期查询应增加独立 repository、审计表和查询投影。
6. 运营台原先以 `Promise.all` 绑定所有域请求；本轮已改为逐域容错并补充契约测试，低权限角色不会因单个接口拒绝而整页失败。

## 需求决策

- P0：保留现有商业/平台/账务/审计/告警控制面，补齐新能力的安全投影和角色门禁。
- P1：建设知识治理、学习建议、竞品审核、生成任务和驳回修正版队列。
- P2：跨工作区报表、批量知识治理、复杂告警编排和视频成片运营。

## 已同步文档

- 主 PRD：`docs/PRD-merchant-marketing-codex-final.md`，新增 FR-17.6–FR-17.12。
- 目标架构：`docs/ops-console-architecture.md`。
- 架构图：`docs/diagrams/ops-console-architecture.html`。
- 运行手册：`docs/ops-console-runbook.md`。
- 对外架构与能力矩阵：`docs/sales-architecture-and-capability-overview.md`。
- 实现状态和 FR-16 证据：`docs/implementation-status.md`、`docs/fr16-knowledge-context-evidence.md`。
