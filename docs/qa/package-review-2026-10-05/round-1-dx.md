# 套餐与权益包方案：DX 首轮评审

日期：2026-10-05。流程：gstack autoplan Phase 3.5 / plan-devex-review，DX POLISH。审查对象：PRD §1–16.2；源码基准 main `e8c9f98e`（起始审查基准为 `84bbf015`，期间商业文件未变，最终重新读取当前 Bridge）。原生独立评审者为 GPT，不是 Claude；owner 负责修订正文和后续 Codex 独立挑战。本报告不修改业务代码，不创建订单、不核验转账、不部署。已读取 SKILL.md、实际 sections/review-sections.md 和相邻 dx-hall-of-fame.md；共同前言、交互、独立复审和日志汇总按 autoplan 由 owner 管理。

## 0A 开发者画像与范围

主要开发者是接手现有商业能力的后端/平台工程师：需要在同一 main 工作目录扩展 TypeScript 共享契约、MCP/API、PostgreSQL/RLS、worker 及两端桌面界面。次要使用者是技术安装人员和运营支持人员，负责本地 stdio 绑定、客户权限及收款排障。商家是产品用户，不应学习 SKU JSON、nonce、令牌或模型 Key。

画像卡：

| 项 | 内容 |
|---|---|
| Who | 接手套餐变更的后端/平台工程师 |
| Context | 本地插件已交付，商业模块存在，需要可靠修改并验收 |
| Tolerance | 允许有环境准备，但不接受支付结果未知时猜测是否重付 |
| Expects | 真实契约、可执行测试、可定位错误、旧客户兼容与恢复路径 |

产品类型为 API/Service + 本地 stdio 插件 + 部署文档；不是新 SDK 或 Claude Code 产品。沿用用户确认业务规则，不开展市场、移动端或外部平台自动化需求。

## 0B Developer Perspective

我是接手套餐变更的工程师。我打开 README，看到标题“商家营销内容助手（桌面 ChatGPT 插件）”，以及“本地一键启动”的 `npm ci`、`npm run dev:doctor`、`npm run dev:stack`。这些是实际存在的脚本；我知道必须先有 Node 22 和 Docker，不能把启动健康当支付验收。我接着读安装手册，看到工作区由管理员分配、本地 CLI 浏览器登录和 Keychain、重启 ChatGPT 后调用 `onboarding.status`。我不会把网上 OAuth 教程接进这里。

我要修改升级，查共享契约发现 `commercial.order.create` 只收 `purchase_kind`、`sku_code`、幂等键和原因。Bridge 也有独立工具输入 schema 和恢复集合。我担心后端新增报价引用后，旧安装插件还会把 upgrade 直接作为 SKU 全价订单；我需要明确兼容行为，而不是只改后端测试。我看 PRD 已详细定义资金守恒和到期，但安装与使用手册还描述 basic/growth 和固定价格；我需要知道修改完成后更新哪些入口、用什么最短路径验证，以及错误是联系管理员、重新报价还是查询原单。真正让我放心的是同一订单、授予和 access revision 的结果能在两端及真实 stdio 中对应起来。

以上是基于文件的角色扮演，不是实测用户访谈或计时。

## 0C 本地参考 benchmark

本轮按 owner 限定采用已有本地参考，没有进行外部竞争调查；不引用 Hall of Fame 的商业指标或虚构竞品实时 TTHW。

| 参考 | 当前可证实选择 | 本方案采用 |
|---|---|---|
| README 本地启动 | doctor 前置检查、stack 单入口、完整验收另列 | 环境准备与首次成功分开计时 |
| 安装手册 A2/A3/E | 本地包、分配工作区、CLI 登录、只读状态验证、明确排障 | 复用身份安装，不再建 OAuth/Helper 产品 |
| verify-installed-bridge.mjs | 版本/缓存、tools/list、禁止工具、缺配置阻断检查 | 新商业契约进入同一真实安装验真 |
| gstack 本地 DX 参考 | 安全重试、可行动错误、迁移不惊吓、学做结合 | 仅作为设计原则，无外部统计支持 |

当前 TTHW=unknown；没有从新机器完整计时。目标 tier 为可测量的 2–5 分钟范围，但仅从授权环境、合法工作区和已安装绑定的候选均就绪时开始，不把签名打包、Docker 下载或购买转账算进“5分钟必成”。缺角色、绑定、收款配置或服务准备条件时报告 BLOCKED，计入阻断类别及耗时，不造成功结果。

## 0D Magical Moment

交付载体是已有本地 ChatGPT 插件与桌面财务页的同一事实读取。首次成功是：授权工程师在隔离环境发布一个测试商品，打开商家购买中心看见对应销售版本及通知，再通过真实安装 stdio 查询目录和准入，关联同一 Workspace、版本和请求标识。没有真实付款回执时只可称“目录链路成功”；支付/授予成功另以订单、真实收款、grant 和 access revision 证明。ChatGPT 继续能力与恢复呈现，完整财务明细保留授权桌面商家页，不拓展插件为财务报表产品。

## 0E–0G 九阶段 journey 与 confusion

| 阶段 | 真实入口/行为 | 当前摩擦与处置 |
|---|---|---|
| 1 Discover | README 代码入口→PRD→contracts | 新商品流程需要加入既有手册索引（DX-4） |
| 2 Evaluate | PRD §2 当前实现、§10证据限制 | 已区分fixture/真实证据，无新增问题 |
| 3 Install | 安装手册 A2/A3，本地 stdio | 不改安装路线，版本兼容需补（DX-1） |
| 4 Hello World | `onboarding.status`→`commercial.catalog.get` | 当前耗时unknown，补准确起止测量（DX-4） |
| 5 Integrate | MCP共享契约、Bridge schema及恢复集合 | 新升级不得走旧全价 fallback（DX-1） |
| 6 Debug | DomainError、request/trace、Ops异常对账 | 机器分类及安全恢复需可验证（DX-3） |
| 7 Upgrade | release metadata、安装缓存验真、旧订单履约 | 老插件兼容矩阵需要明确（DX-1） |
| 8 Scale | §16游标/worker/锁顺序/真实容量证据 | 已覆盖容量边界，无新增问题 |
| 9 Migrate | §8/14 expand、销售核对、关闭新写回滚 | 数据迁移已有闭环，接口迁移文档补（DX-1/4） |

模拟 confusion log（非实测时间）：T+0:00 README 已清楚说明产品边界；T+0:30 本地启动命令可发现；T+1:00 安装手册说明工作区和本地登录；T+2:00 查商业 API 发现 upgrade 缺报价引用，担心旧插件错误全价；T+3:00 查失败路径见支付未配置503，必须区分已批准人工转账与未配置任何模式；T+4:00 找到PRD资金状态，但需机器错误与测试映射。解决项为 DX-1–4；不得把模拟日志当 TTHW证据。

## Pass 1 Getting Started

初始 8/10，建议补丁后的计划 9/10。README 已有三步启动且不用全量发布测试阻塞首次运行，安装手册也真实列出本地绑定、重启和只读验证。缺口是新商业功能没有最短验收路径和计时边界；采用 DX-4 将必要环境准备与首次成功分开，并以真实版本/工作区读取作为成功。已有环境中的黄金路径为：①`npm run dev:doctor` 确认当前安全隔离环境与配置（目标≤1分钟）；②在真实绑定的新 ChatGPT 会话调用 `onboarding.status`、`commercial.catalog.get`（目标≤2分钟）；③在授权桌面财务页对照同一销售版本（目标≤2分钟）。这些命令/工具已存在，但新字段和操作未实现，所以预期输出是验收定义而非本轮观察；全新机器准备耗时仍unknown。

## Pass 2 API/CLI/SDK Design

初始 8/10，补丁后的计划 10/10（实现证据待补）。§7 已要求共享 schema、动作权限和状态，§6/16 已要求幂等和事务，符合当前工程师的渐进理解方式。实际 `packages/contracts/src/mcp.ts:739` 和 `apps/plugin/mcp/bridge.mjs:543` 仍接受无报价引用的 upgrade 参数，新增报价不能仅改服务函数。DX-1 要求将新动作、必填引用和响应语义同步进共享 exact registry/Bridge/OpenAPI及客户端；旧请求不能降级到全价套餐。复用现有 MCP 命名，具体新增方法名实施冻结后写文档，不在本报告虚构已可用命令或新 SDK。

## Pass 3 Error Messages & Debugging

初始 8/10，补丁后的计划 10/10（运行输出待验证）。§14 已串联 request/order/quote/receipt/grant，§15 已有业务错误状态和断网恢复；但客户端不能仅凭中文提示判断安全重试或联系谁。DX-3 要求错误契约包含稳定 code、HTTP业务状态/MCP结构、业务原因、字段/阻断项、request_id/trace_id、retryable及获授权下一步；任何样例编号在实施冻结后确认，不虚构现有错误码。以下三路径来自源码读取，不是本轮调用结果：

| 路径 | 当前可见源码输出 | 目标可行动恢复 |
|---|---|---|
| V2支付模式缺失 | `COMMERCIAL_PAYMENT_PROVIDER_UNAVAILABLE`，503，“V2 商业订单支付渠道尚未配置”，server.ts:3592 | 说明未建单；管理员配置已批准线上/人工模式；商家重试不解除配置阻断；无凭据暴露 |
| 发布权限不足 | `FORBIDDEN`，403，“当前账号没有套餐审批发布权限”，mcp-commercial-ops-catalog.ts:33 | 精确说明获授权动作不足，保留草稿、找管理员核对该动作；不得泄露其他企业/商品 |
| 非法金额字段 | `INVALID_REQUEST`，400，“price_fen 无效”，同handler末段 | errors定位price_fen、合法整数分范围和修正建议，保留其它输入，不自动改0或开启支付 |

新增复审路径是修订冲突、源升级版本变化和已收款结果未知：冲突展示差异重新确认，源变化不自动重算旧已付款，未知先查原意图禁重付。Bridge 当前仅透传白名单错误字段（:1994–2038），新错误字段必须纳入契约安全投影测试，服务端 next_actions 再与 exact registry求交。保留内部堆栈给受控日志，客户只见安全业务摘要和请求标识。

## Pass 4 Documentation & Learning

初始 7/10，补丁后的计划 10/10。README 已提供总文档、安装手册、使用介绍和发布runbook索引，可复用，不需要建外部文档站。但安装/使用文档仍写 basic/growth 及固定初始价，且缺剩余期升级、人工分配、待处置及旧插件兼容流程；这些必须随功能更新而不是上线后猜。DX-4 要求更新 README索引、产品使用介绍、安装手册商业/排障段、commercial-executable-spec.md 与新契约参考，明确“初始价格可改、开通费不含首期、六个月每月500点”和按版本读价。示例从实施后冻结的真实schema产生，并在隔离环境验证同一候选；真实与fixture、权限条件和未配置阻断在示例旁标明，不能给用户生产写测试命令。

## Pass 5 Upgrade & Migration

初始 7/10，补丁后的计划 10/10。数据库迁移/回滚和历史订单保留已在§8/14/16给出，本轮无新的数据迁移要求。新增契约和已安装插件仍可能不同步，尤其旧 `purchase_kind=upgrade` 会缺报价引用；DX-1明确“拒绝缺引用升级，提示更新/使用授权桌面入口，绝不收目标全价”。建立当前服务端/当前插件、当前服务端/仍支持旧插件和回滚兼容服务端/新插件三组矩阵，支持范围在实施release metadata冻结；不支持的能力明确禁新写，仍提供合法旧单查询/核验/履约。升级使用已有签名本地包与缓存验真，重启新会话，不让用户手改缓存；不引入版本市场或假OAuth。

## Pass 6 Developer Environment

初始 9/10，补丁后的计划 9/10。Node22、npm、Docker、doctor、stack、TypeScript共享类型和隔离运行测试已有可核对入口，§16也有真实PG/RLS及worker验收。需要沿用 `docs/runbooks/local-isolated-runtime-test.md` 的独立project/网络/volume/workspace/token安全条件；本轮不启动新的共享栈或操作生产。DX-2是配置语义精确化：`manual_transfer` 在server.ts:546及7392已经作为模式存在，付款provider在3590集中检查；人工转账须独立核实模式、收款配置及核验权限，不依赖未启用的微信/支付宝通道。无任何批准模式仍阻断建单；批准人工模式时不得伪造线上checkout成功。这不是绕过真实配置/权限或新建支付通道。

## Pass 7 Community & Ecosystem

初始 9/10，补丁后的计划 9/10。此项目是交付给明确商家的本地插件，不能用公开社区、开源许可证或外部 SDK覆盖率评价本期套餐需求。已有平台运营/管理员与安装手册排障表是支持入口，§14已有异常负责人和期限；DX-3/4使支持请求带受控请求/订单标识，禁止附密码、token或未脱敏凭证。收费版本、赠点和结果都按事实展示，满足本期价格透明需求。No new issue：不新增Discord、公共市场、外部SDK或贡献流程；这些不是本项目当前授权场景。

## Pass 8 DX Measurement

初始 7/10，补丁后的计划 10/10。§16记录业务耗时与backlog，尚未定义首次接手人员怎样证明文档可用。DX-4要求从满足预条件到同一Workspace/销售版本的首次只读成功计时，记录候选SHA、插件版本、环境、步骤、失败/求助次数、成功或blocked、阻断责任人及耗时；未知绝不填写0。实施后由一次未参与开发的安装/支持人员照文档完成目录验证和错误排障，并对3条错误路径测恢复，不需线上行为采集或新分析平台。TTHW目标≤5分钟只适用已准备环境；真实转账、模型调用和授予是独立验收，不能为达标虚构付费成功。

## 关键发现与最小正文补丁建议

**DX-1（P1，§7/8）**：新能力需要契约与旧插件兼容，特别是旧升级请求。建议正文加入：

> 新商业动作、输入/响应版本、报价转单引用和恢复查询须同步到共享MCP exact registry、HTTP/OpenAPI、Bridge工具schema及类型客户端，禁止商家发现ops方法。升档订单必须关联有效服务端报价及源权益版本；旧客户端仅传purchase_kind=upgrade和SKU时明确拒绝并给更新/授权桌面入口，不映射普通套餐全价。固定支持版本矩阵，兼容窗口内保留合法旧单查询和履约；未知响应版本阻断新写，不猜字段。恢复类方法逐项注册并复核next_actions，零点/未知余额仍允许获授权首购、目录/查单恢复，不开放commercial.*通配或豁免身份/RBAC/RLS。使用实际安装包完成tools/list/schema及三组新旧兼容测试，更新包后按原安装手册重启新会话。

**DX-2（P1，§13.2）**：人工转账模式与线上支付未配置分开。建议正文加入：

> 服务端明确选择批准的线上支付或manual_transfer模式，订单冻结该模式。人工转账仅依赖该模式的已核实收款配置、真实流水及授权核验，不以未启用线上provider的配置缺失拒绝合法代购；不生成假线上支付链接。任何模式均未配置/批准、收款账户无效或核验策略缺失时停止该路径并列出管理员需补项，不允许任意provider字符串或sandbox在生产开通。

**DX-3（P1，§7/14）**：错误可行动且可由客户端安全解析。建议正文加入：

> 商业错误采用稳定机器code及HTTP/MCP对应语义，返回安全业务原因、字段/阻断项、request_id/trace_id、retryable和获授权下一步；文档将code映射原因、责任人、恢复入口与是否已产生订单/收款/授予。Bridge白名单保留必要恢复字段、不透传秘密，next_actions与服务端exact registry求交。类型/契约测试验证缺配置、动作越权、字段错误、修订冲突、已收款结果未知；只有先查原意图确认未完成才安全重试，不能把所有503当新建/重付。

**DX-4（P2，§8/9）**：文档及计时闭环。建议正文加入：

> 文档随候选交付：更新README索引、产品使用介绍、安装手册商业/排障段及commercial-executable-spec.md，提供首购、改价、包购买、剩余期升级、代购/分配、待处置和旧插件兼容示例，全部引用实施冻结schema且隔离验真。已具备授权环境和绑定插件后，首次目录/准入读取及桌面同版本验证目标≤5分钟，当前unknown；准备耗时及缺配置/权限blocked单独记实，不以fixture/健康证明付款。记录版本、工作区、阶段耗时及求助/失败，实施后独立人员照文档复测。

## Scorecard

下列分数评估需求完整度，after仅表示owner采用以上补丁后计划，不代表实现通过；没有同scope旧DX评分可比较，prior/trend为N/A。

| Dimension | Before | After suggested patch | Evidence |
|---|---:|---:|---|
| Getting Started | 8 | 9 | README/安装手册 + DX-4边界 |
| API/CLI/SDK | 8 | 10 | contracts/Bridge + DX-1 |
| Error Messages | 8 | 10 | 3路径与白名单 + DX-3 |
| Documentation | 7 | 10 | 既有文档更新入口 + DX-4 |
| Upgrade Path | 7 | 10 | §14迁移 + DX-1旧请求拒绝 |
| Dev Environment | 9 | 9 | doctor/隔离环境 + DX-2 |
| Community/Support | 9 | 9 | 现有运营管理员支持，无额外社区 |
| DX Measurement | 7 | 10 | unknown实事记录 + DX-4 |
| Overall | 7.9 | 9.6 | 计划质量，非运行评级 |

TTHW当前unknown，目标就绪环境≤5分钟；competitive tier为本期内部目标非市场排名；magical moment已设计未验收。零摩擦、学做结合、行动错误、默认+受控恢复、上下文示例、事实一致首次成功均在补丁后覆盖。8pass已完整检查，无未做的适用pass。

## 复用与不在范围

复用 README doctor/stack、既有平台包与CLI登录、Keychain/Windows凭据边界、exact registry、DomainError与Bridge安全投影、release metadata/verify-installed-bridge、TypeScript契约、隔离PG/runtime测试、Ops对账和现有发布门禁。不创建SDK、开发者控制台、外部文档站、公开社区、公开/团队市场或ChatGPT OAuth；手机平板不作为门禁。不添加线上行为追踪、自动续费或未批准免费商业路径。

## Implementation Tasks

- [ ] **DX-T1（P1，human约1–2天 / CC约2–4小时）** — 同步商业契约与安装插件兼容矩阵，拒绝旧无报价升级请求；对应DX-1。Files：packages/contracts/src/mcp.ts、packages/contracts/src/commercial-access.ts、apps/api/src/server.ts、apps/plugin/mcp/bridge.mjs、apps/plugin/scripts/verify-installed-bridge.mjs、相关契约/宿主测试。Verify：新旧请求矩阵、zero/unknown恢复、实际安装tools/list和schema；具体新测试命令实施登记。
- [ ] **DX-T2（P1，human约4–8小时 / CC约1–2小时）** — 固定批准manual_transfer模式与readiness，隔离线上provider缺失；对应DX-2。Files：apps/api/src/server.ts、支付readiness、CommercialOperationsWorkspace、commercialOperationsClient及相关测试。Verify：manual配置完整成功建单、缺配置阻断、线上缺配置不伪造支付、生产sandbox拒绝。
- [ ] **DX-T3（P1，human约1天 / CC约2小时）** — 为商业错误与授权恢复增加共享安全契约及三路径/未知结果测试；对应DX-3。Files：packages/contracts/src/mcp.ts、apps/api/src/mcp-commercial-ops-catalog.ts、apps/api/src/server.ts、apps/plugin/mcp/bridge.mjs、两端client和相关测试。Verify：错误无secret、字段定位、权限动作、503非通用重付、恢复only exact。
- [ ] **DX-T4（P2，human约4–8小时 / CC约1小时，独立人工复测另计）** — 更新既有交付文档并测首次成功与排障；对应DX-4。Files：README.md、docs/product-usage-guide.md、docs/store-nova-chatgpt-plugin-install-manual.md、docs/commercial-executable-spec.md、本期QA证据。Verify：schema真实示例、已就绪环境≤5分钟或实际blocked记录，真实版本绑定。

估时为本次计划粗估而非已用时；依赖CEO/Design/Eng任务的统一商业服务，owner聚合去重，不另起平行实现。

## DX implementation checklist

- [ ] 就绪环境TTHW≤5分钟且总准备时间另记；缺配置/权限明确blocked。
- [ ] 已有本地安装/doctor/stack入口复用，无secret命令/日志；首次读取同一Workspace真实版本。
- [ ] 新旧API/Bridge schema、恢复逐项registry、报价引用与拒绝全价降级完成测试。
- [ ] 当前套餐/待授予/未来合同及access revision一致，不把paid称已生效。
- [ ] manual_transfer已批准、receiver配置与核验权限有效；没有任何模式时fail closed。
- [ ] 错误说明发生了什么、原因、如何恢复、文档位置；原订单/幂等键恢复，无重复付款。
- [ ] 文档与候选版本绑定、真实schema、隔离例子可执行，安装重启新会话可发现。
- [ ] 迁移/回滚保留旧单履约，不改/删真实数据或容器数据。
- [ ] 独立支持人员复测首次目录验证与三路径排障，证据链接由owner归档。

单命令新安装、免费tier、公共社区、自动codemod不是本期要求；没有因为通用DX清单要求而新造功能。

## Completion / 未决与学习

DONE_WITH_CONCERNS：完整8pass评审完成，4条精确需求补丁与任务已提交owner；owner尚需落实正文并做独立复审。没有新的价格/赠点/周期政策待用户选择，实际具体商品值依§11填入批准发布配置。初始score7.9/10，建议补丁后9.6/10；当前TTHW及实现质量unknown，后续真实安装/支付/worker/桌面验收仍是上线门禁。各角色日志和最终GSTACK REVIEW REPORT由owner统一注入，不能把本报告代替最终清单。

Durable learning：商业MCP恢复分类、Bridge工具schema/安全投影与已安装缓存是独立契约层，只改API服务会留下旧升级全价/恢复死锁风险；本结论来自当前contracts和Bridge直接读取（observed），非跨模型结论。
