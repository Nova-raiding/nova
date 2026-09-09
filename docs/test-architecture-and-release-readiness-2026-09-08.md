# 商家 ChatGPT 插件测试架构与上线 readiness 报告（2026-09-08 更新）

**版本/时间**：2026-09-08（与当前分支与 `release-metadata.json` 同步）
**目标**：以 PM/测试架构视角给出可执行的正/反测试闭环，直到可上线。

> 本文以可复现证据为准；未达门禁即使页面“看起来可用”也不判定上线通过。

## 1. 目标与边界

### 1.1 三层验收边界

1. **商家主链路（ChatGPT 插件）**：
   - `chatgpt` + `apps/plugin/mcp/bridge.mjs` + `/mcp`
   - 覆盖商家会话、任务、素材、发布确认、失败恢复
2. **业务内核（API / MCP / Worker / DB）**：
   - 鉴权、RLS、幂等、审计、状态机、队列与回写
3. **运营后台（ops-console）**：
   - 商家工作区治理、平台运营治理、告警与审计、模型与付费可观察性

### 1.2 不可替代边界

- 本地 fixture、mock、截图演示、空态回退和 UI 友好文案都不构成上线证据。
- `dev:doctor:production` 与 `test:release-gates` 通过前不得宣称上线。
- 任何 `published`、`服务可用`、`支付已就绪`、`平台已打通` 的状态都必须来自真实可验证回执。

---

## 2. 当前状态快照（执行时间点：21:40+，本地主线）

### 2.1 已通过（可复核绿灯）

- `npm run typecheck`
- `npm run release:metadata:validate`
- `npm run test:release-gates`
  - **测试文件：123 passed / 6 skipped**（共 129）
  - **测试条目：559 passed / 13 skipped**（共 572）
- `npm run dev:doctor`
- `npm run test:browser:merchant`
  - **22 passed**
- `npm run test:browser:ops`
  - **8 passed / 1 skipped**
- `node apps/plugin/scripts/verify-installed-bridge.mjs`
  - `tools.count=144`
  - `required`、`missing`、`forbidden` 符合预期

### 2.2 本轮 NO-GO（未关闭）

`npm run dev:doctor:production` 输出：

- `plugin_bridge`：`MERCHANT_MCP_BASE_URL` 与 `MERCHANT_MCP_TOKEN` 未就绪
- `production_config`：`PRODUCTION_CONFIG_PATH` 未配置
- `runtime:api_ready`：`production_ready=false`
- `commercial:payment`：fixture / 证据缺失
- `commercial:platform_oauth`：6 平台 OAuth 未配置
- `commercial:model_relay`：五模态证据未就绪
- `commercial:object_storage`：local 模式（非生产）
- `commercial:scanner`：scanner 未证据化
- `commercial:alerts`：告警 webhook 未配置
- `commercial:production_gate`：`writes=false`、`productionGate=false`
- `runtime:release`：`releasez` 未就绪
- `release:model_relay_evidence`：未提供 `MODEL_RELAY_EVIDENCE_PATH`
- `release:codex_app_error_recovery`：未提供 `CODEX_APP_HOST_EVIDENCE_PATH`

结论：仍为 **NO-GO**。

---

## 3. 测试架构：正向/反向测试矩阵

### 3.1 统一矩阵

| 层级 | 正向测试（通过即放行该层） | 反向测试（必须失败并阻断） | 证据/入口 |
|---|---|---|---|
| 发布与元数据 | `release:metadata:validate`、`test:release-gates` 全绿；迁移链与不可变镜像一致 | 版本不一致 / 映射断链 / schema 不匹配 | `release-metadata.json`、`VERSION`、`release-manifest` |
| 插件入口 | `codex plugin add` + `verify-installed-bridge` `ok:true` + `tools.count` 与 runtime 一致 | 少关键工具（如 `merchant.start`）或多非法工具（`ops.*`） | `apps/plugin/README.md`、桥接脚本 |
| 商家主链路 | merchant 浏览器全流程稳定通过；错误可恢复、重放幂等 | 将错误降级为 fixture、静默“发布成功”、无 idempotency | `dogfood/chatgpt-all-functions/merchant-*.spec.js` |
| 运营后台 | 关键页面可见、无控制台错误、权限失败有明确诊断 | 白屏、分页/滚动崩溃、403 下伪成功、错误态与空态互相伪装 | `dogfood/chatgpt-all-functions/ops*.spec.js` |
| 安全与隔离 | RLS、角色投影、审计链路稳定 | 越权读写、跨工作区数据串读、未审计高风险动作 | `tests/` 中的 DB/RLS/权限测试 |
| 生产发布 | `dev:doctor:production` 无关键 fail + `releasez.ready=true` + evidence path 就绪 | 任一 `FAIL` 项存在即 NO-GO | `dev:doctor:production`、生产 evidence 文件 |

### 3.2 重点反向用例（按问题历史）

1. **白屏回归（硬性）**：`/ops/tasks` 长列表滚动不能出现白屏
2. **fixture 泄露（硬性）**：支付/平台/OAuth/对象存储为 fixture 时不得显示生产可写
3. **发布幻觉（硬性）**：未确认/未回执不得显示 `published`
4. **恢复失败误导（硬性）**：503、timeout、失败 API 不得自动重试扣费
5. **空态伪装（高危）**：空态、错误态、无权限态文本必须可区分

---

## 4. 多轮测试闭环（Round Design）

### 说明

每轮都要记录：
- 使用命令
- 关键输出截图/日志
- 通过门禁项
- 不通过门禁项与下一轮修复项

### R0：合约与基线
- `npm run typecheck`
- `npm run release:metadata:validate`
- `npm run test:release-gates`
- `npm run codex:relay:validate`

### R1：本地运行健康
- `npm run dev:doctor`

### R2：主链路功能
- `npm run test:browser:merchant`

### R3：运营后台与权限链
- `npm run test:browser:ops`

### R4：插件一致性
- `node apps/plugin/scripts/verify-installed-bridge.mjs --source apps/plugin --installed <installed_root>`

### R5：生产就绪门禁
- `npm run dev:doctor:production`

### R6：生产证据闭环（必须补齐并重跑）
- 生产配置/环境变量、`releasez`、runtime release evidence、codex host evidence

### R7：回归再验（问题专项）
- 白屏专项 `S1 /ops/tasks`
- 关键错误恢复、发布回执、告警、容量与成本回看

---

## 5. 关键专项：S1 `/ops/tasks` 滚动白屏反向测试（硬性回归）

> 历史故障要求，已作为每轮上线前必测项。

### 场景定义
- 以运营身份进入 `/ops/tasks`
- 注入足够任务数据（或使用已有工作区真实数据）
- 执行 `scrollTo(0, 400/800/1200/1800/2200)` 或页面滚轮下拉

### 断言
- 每段滚动后关键标题与筛选区仍在可见范围
- 页面主体不出现 `blank/空白页面`（DOM 根可见）
- 不出现 `pageerror` 且接口失败可被重试恢复，不可直接变成空态成功

### 结果记录
- 失败时记录截图、`response` 与 `console`，更新下一轮修复结论

---

## 6. 目前可视化交付清单（上次执行产物）

- 最新 merchant/ops 浏览器证据目录：`artifacts/`
- 关键 UI 清单：`screenshots/ops-console.png`、`screenshots/merchant-interactions/*`

> 产物用于回放与追溯，不直接定义上线结论。

---

## 7. 关闭 NO-GO 的最短执行路径（按优先级）

### P0（必须先行）
1. 填充生产配置：`PRODUCTION_CONFIG_PATH`、生产 secret、`release` 可追踪证据
2. 修复 `plugin_bridge`：设置 root origin 的 `MERCHANT_MCP_BASE_URL` 并由密钥管理器提供 `MERCHANT_MCP_TOKEN`
3. `dev:doctor:production` 重新清零：至少 `plugin_bridge`、`production_config`、`runtime:api_ready`

### P1（平台可用性）
4. 对齐六平台 OAuth 与 API 回调
5. 配置支付 provider（查询/下单/退款/对账）并验签
6. 配置五模态模型中转并补齐 usage/cost/error evidence

### P2（生产能力）
7. 配置对象存储与 KMS，切换 scanner 至真实扫描与签名回执
8. 配置告警链路并验投递

### P3（上线最终）
9. 通过 `releasez` 与 `runtime:release`，填充 `MODEL_RELAY_EVIDENCE_PATH` 与 `CODEX_APP_HOST_EVIDENCE_PATH`
10. 执行 R0~R7 全量复测（新增白屏回归）

---

## 8. GO/NO-GO 判定（唯一）

**仅当以下全部满足，才可宣布 GO：**
- E0~E5 全量通过且 `test:release-gates` 与 `release-metadata` 一致
- `dev:doctor:production` 无关键 fail（仅允许已识别且不阻断的 warn）
- `releasez.ready=true` 且与当前 manifest/镜像 digest/迁移 sha 绑定
- 生产能力门禁（支付/OAuth/模型/存储/告警/scanner）全部非 fixture 且已闭环
- `runtime` 与 ChatGPT host error recovery evidence 全链路留痕
- `/ops/tasks` 白屏专项 S1 通过

任一不满足：**继续 NO-GO**。
