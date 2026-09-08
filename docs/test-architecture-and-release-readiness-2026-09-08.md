# 商家 ChatGPT 插件测试架构与上线 readiness 报告（2026-09-08 更新）

**版本/时间**：2026-09-08（与当前 `release-metadata.json` 与本地主分支一致）

**用途**：PM + 测试架构师用于“当前功能可用性复核 + 多轮正反面测试 + 上线决策”

**基本口径**：本文件是验收标准，不替代任何代码功能描述。所有上线判定以可复现证据为准，不以演示、fixture 成果或本机假阳性替代。

## 0. 结论（截至 2026-09-08）

**主链路本地复核状态：可复核绿灯**（本地链路与合同测试通过）。

**生产发布状态：NO-GO**（`dev:doctor:production` 仍有 13 项 fail）。

### 当前可确认通过

- `npm run typecheck`
- `npm run release:metadata:validate`
- `npm run test:release-gates`
- `npm run test:browser:merchant`
- `npm run test:browser:ops`
- `npm run dev:doctor`（本地环境）

### 当前明确阻断

`plugin bridge`、`production_config`、`commercial payment/oauth/model relay/object storage/scanner/alerts/production_gate`、`runtime:release`、`model_relay evidence`、`codex app error recovery evidence` 等仍未闭环。

## 1. 测试边界与角色链路图

三条产品线必须同时成立：

1. **商家插件入口（桌面 ChatGPT）**
   - `chatgpt` + `apps/plugin/bridge` + `apps/api /mcp`
2. **业务实现层（API/MCP/Worker）**
   - 鉴权、RLS、幂等、状态机、审计、任务与发布回执
3. **运营后台（ops-console）**
   - 商家工作区治理、平台运营治理、模型与账务可观察性、审计归档

**不允许替代证据的边界**：

- 本地/fixture 演示、mock、截图观感、空接口返回都不构成生产可上线证据。
- 未在真实会话重试/回读闭环的状态，不允许标记成功（尤其发布、支付、平台回执）。

## 2. 测试层级框架（正面/反面）

### E0：发布元数据与不可变性（合约红线）

- 目标：确认构建身份与接口边界不可漂移。
- 工具：
  - `npm run release:metadata:validate`
  - `npm run test:release-gates`
  - `npm run typecheck`
- 正向判定：
  - MCP register / release metadata / plugin manifest / migration 迁移链一致且可验证
  - `merchant-marketing` 插件版本与 release metadata 匹配
- 反向判定：
  - 任何版本不一致、迁移链不匹配、schema不一致直接 fail-closed

### E1：插件安装与工具一致性（链路入口红线）

- 目标：确保 ChatGPT/Codex 可加载正确插件快照。
- 工具：
  - `codex plugin add merchant-marketing@merchant-local`
  - `node apps/plugin/scripts/verify-installed-bridge.mjs`
- 正向：
  - `tools.count`、`required tools` 与 `forbidden tools` 与 expected 一致
  - source 与 installed hash 一致（manifest、bridge、skill、mcp）
- 反向：
  - 工具数偏差、缺失关键工具（如 `merchant.start`）、多余工具（如 `ops.*`）直接阻断

### E2：商家主链路功能与失败回退（正向/反向）

- 工具：`npm run test:browser:merchant`
- 正向：
  - 会话、任务、素材、知识、发布确认/幂等、错误恢复路径成立
- 反向：
  - 500/超时/empty identity/fail category 不得 fallback 到演示数据或旧状态
  - 未经确认不得出现“发布成功”或“已恢复可操作”

### E3：运营后台可用性与安全边界（正向/反向）

- 工具：
  - `npm run test:browser:ops`
  - 页面级专项检查（下文 S1~S3）
- 正向：
  - 会话、用户/租户、权限、审计、账务、模型页可用且状态清晰
- 反向：
  - 空态误判成功、401/403 显示成功、页面交互无错误反馈、滚动/分页导致白屏

### E4：生产门禁与外部可验证证据（上线红线）

- 工具：
  - `npm run dev:doctor:production`
  - 生产端 canary（ChatGPT App、模型、六平台 OAuth、模型成本、对象存储、告警）
- 正向：
  - `runtime:api_ready` 返回 `productionGate=true`
  - 关键商用能力为真实配置，非 fixture 与非本地模式
- 反向：
  - 缺省环境变量、fixture 模式、证据文件缺失、未生成 release evidence 直接 NO-GO

## 3. 多轮测试闭环（每轮必须记录证据）

- **R0 发布/合约基础**
  - `npm run typecheck`
  - `npm run release:metadata:validate`
  - `npm run test:release-gates`
  - `npm run codex:relay:validate`
  - 结果：通过
    - test:release-gates：**123 passed / 6 skipped**，**559 passed / 13 skipped**（572）

- **R1 本地运行与依赖健康**
  - `npm run dev:doctor`
  - 结果：`40 pass / 13 warn / 0 fail`

- **R2 插件主链路 + 主流程+失败态**
  - `npm run test:browser:merchant`
  - 结果：**22 passed**

- **R3 运维台主链路 + 认证/权限矩阵**
  - `npm run test:browser:ops`
  - 结果：**7 passed, 1 skipped**

- **R4 桥接一致性核验**
  - `node apps/plugin/scripts/verify-installed-bridge.mjs --source apps/plugin --installed ...`
  - 结果：`tools.count=144`，`required` 包含 `merchant.start` 等关键方法，`missing=[]`，`forbidden=[]`

- **R5 生产门禁预检**
  - `npm run dev:doctor:production`
  - 结果：**39 pass / 1 warn / 13 fail**（当前仍 NO-GO）

### 轮次门禁规则（必须同时满足）

1. 任何一轮 fail，下一轮不得宣告 GO。
2. 变更后对应轮次重新执行：
   - 相关单测（unit/api/contract）
   - 相关 E2E（merchant/ops）
   - `test:release-gates`（涉及注册表、release、迁移、契约变化时）
3. 生产域 fail 必须在 `dev:doctor:production` 重新清零后，才可进入上线评审。

## 4. 反向用例矩阵（按模块）

| 模块 | 正向用例 | 反向用例（必须失败） | 风险控制
|---|---|---|---|
| 工具发现 | 正常 `tools/list` 显示 144 工具 | tool 注入变化、`merchant.start` 缺失、`ops.*` 出现 | 不允许会话继续，阻断入口 |
| MCP 与 workspace | 首次创建/恢复 workspace 成功 | B workspace、token 被吊销、401/403 | 不返回租户数据，触发恢复 |
| 任务与发布 | 发布 prepare→确认→回读闭环完整 | 发布回执 unknown、receipt 丢失、重复 confirm | unknown 必须保持未验证态，不显示成功 |
| 商业与支付 | 点数、订阅状态真实可读 | `balance_state=unknown` 显示为 0；重复回调重放 | 不展示余额可用，回调需幂等校验 |
| 平台能力 | OAuth 配置正确后展示可用平台 | OAuth 缺失、callback 异常、scope 不足 | 禁止进入发布/同步 |
| 模型与中转 | 五模态可见、成本可追溯 | 503/429/usage 缺失 | 记录 error-recovery，禁止自动重试计费 |
| 运营后台滚动 | 滚动不丢失状态 | 滚动到下方白屏（历史问题） | 列入硬性回归（见 S1） |
| 安全/告警 | 告警与安全路径真实发出 | fixture/本地替代生产 | fail-closed |
| 生产门禁 | releasez.ready=true 且与 manifest 绑定 | productionGate=false | NO-GO |

## 5. 运营后台专项反向测试（包含你提到的白屏问题）

> 历史反馈：`/ops/tasks` 滚动到下方出现白屏，需当作硬性反向场景。

### S1 `/ops/tasks` 长列表滚动稳定性（新增必测）

- 场景：
  - 登录后进入 `/ops/tasks`
  - 注入至少 1 页以上数据
  - 依次 `scrollTo(0%,40%,70%,95%,100%)`
- 断言：
  - 页面主标题、过滤区、卡片区域始终可见
  - 无 `pageerror`
  - 无连续空白块（每次滚动后 DOM 节点存在且可见）
  - 底部分页/刷新控件可操作或返回明确“无更多数据”空态
- 失败处理：任一失败回填为 `R3` 回归修复后重跑。

### S2 错误态与空态区分

- 场景：
  - 后端返回错误、空数据、未授权三类响应
- 断言：错误态显示错误块，空态显示“空”，不可互相替代

### S3 跨路由一致性

- 场景：
  - 从 `/ops/tasks` 切到 `/ops/finance`、`/ops/models` 再回到任务
- 断言：
  - 任务状态与滚动位置按预期恢复；不会带着旧快照显示错误页

## 6. 未闭环清单（必须逐项修复后才能 GO）

1. `MERCHANT_MCP_BASE_URL` 与 `MERCHANT_MCP_TOKEN` 与 production 证据链
2. `PRODUCTION_CONFIG_PATH` 与真实 production 配置渲染
3. 六平台 OAuth（jd/taobao/tmall/pinduoduo/xiaohongshu/douyin）生产接入
4. 支付 provider（支付、查询、退款、对账）真实链路与 HTTPS
5. 五模态模型中转（可用性、usage、cost、503）真实 evidence 与绑定
6. 对象存储与 KMS（非 local）
7. Scanner（签名回执、新鲜度、真实入库）
8. 告警真实投递与 secret 配置
9. `releasez` 与不可变 release metadata 绑定，`runtime:release` ready=true
10. `CODEX_APP_HOST_EVIDENCE_PATH`（真实宿主 canary）与 `MODEL_RELAY_EVIDENCE_PATH`
11. 白屏专项回归 S1 在 CI 中长期保留

## 7. 下一轮测试计划（到 GO 的最短闭环）

- **第1轮（生产依赖配置）**：补齐 `production_config + plugin bridge + 生产 API secrets`
  - 重跑：`npm run dev:doctor:production`、`npm run release:metadata:validate`
- **第2轮（支付/OAuth/模型证据）**：补齐支付、平台 OAuth、五模态 canary evidence
  - 重跑：`npm run dev:doctor:production`、相关模型/OAuth 端到端外部验收
- **第3轮（对象存储/扫描/告警）**：上线前必须替换 local 配置并验证真实回执
  - 重跑：`npm run dev:doctor:production`
- **第4轮（release 与宿主）**：补齐 `releasez + CODEX_APP + MODEL_RELAY evidence`
  - 重跑：`npm run test:release-gates`、`npm run dev:doctor:production`
- **第5轮（回归）**：S1 白屏专项 + 全部 merchant/ops 主要回归
  - 重跑：新增/现有 `ops` 滚动用例 + `test:browser:merchant` + `test:browser:ops`

## 8. GO 判定（唯一）

- E0~E4 全部绿
- `npm run dev:doctor:production` 无 fail 且关键 warning 不再阻断
- `test:release-gates` 绿色且与当前 release manifest 一致
- 真实宿主与五模态 canary 提供可复核 evidence
- `/ops/tasks` 滚动白屏专项通过（S1 记录通过）

达不到上述条件前，结论必须保留 **NO-GO**。

## 9. 快速入口

- [release-metadata.json](../release-metadata.json)
- [README](../README.md)
- [商家插件安装与配置说明](../apps/plugin/README.md)
- [插件/bridge 校验脚本](../apps/plugin/scripts/verify-installed-bridge.mjs)
- [运维数据矩阵](../doc/todo/ops/ops-console-page-data-matrix-2026-08-29.md)
