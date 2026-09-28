# ChatGPT App 内 Store Nova 插件真实链路验收（2026-09-29）

## 环境与结论

- 宿主：macOS ChatGPT App 的 Codex 工作区；插件为本地直装、stdio MCP，实际进程运行 `merchant-marketing/mcp/bridge.mjs`。
- 云端：`https://yxsona.com`，工作区 `ws_guirenniaoniao`。已把当前 demo 镜像的 API 双副本文本模型配置热修为 `qwen3.8-flash`，公网 release 为 `release-demo-priced-text-20260929`，API 和运营后台健康探针正常。没有数据库迁移；授权范围代码修复仍未部署。
- **已在 App 中看到真实产出**：`onboarding.status` 返回 1 家人工登记店铺、0 家官方授权店铺；`catalog.search({scope:"workspace",limit:"10"})` 返回 1 件真实商品，并正确提示该商品未绑定店铺。见 [工作区截图](evidence/2026-09-29-chatgpt-app/01-onboarding-success.png)、[商品截图](evidence/2026-09-29-chatgpt-app/02-catalog-success.png)。
- 本地插件已从当前源码重新加入、重建 macOS Keychain helper；重启后的 ChatGPT App 再次调用 `onboarding.status` 成功，见 [更新后 App 截图](evidence/2026-09-29-chatgpt-app/06-updated-plugin-app-success.png)。云端 API 修复仍未部署。
- **文案生成尚不能作为成功交付**：`content.draft.generate` 被错误的品牌范围授权挡住；`merchant.first_value` 的一次模型调用返回成本结算缺失，生成结果未交付，1 点创意点仍处于预留状态。见 [授权阻断](evidence/2026-09-29-chatgpt-app/03-draft-scope-block.png)、[模型阻断](evidence/2026-09-29-chatgpt-app/04-draft-cost-block.png)、[积分账本](evidence/2026-09-29-chatgpt-app/05-points-reserved.png)。
- 配置热修后在 App 中用**新幂等键**验证了一次：`qwen3.8-flash` 返回 341/377 token，但中转价格接口在结算时超过 10 秒超时，仍被 `MODEL_USAGE_COST_MISSING` 阻断；结果未交付。见 [热修后截图](evidence/2026-09-29-chatgpt-app/07-priced-model-cost-timeout.png)。数据库只读核对显示两次尝试各有 1 点 `active` 预留，均未结算；已停止进一步付费生成。
- 已在本地 API 候选加入价格前置检查：先验证当前文本模型的中转价格、计费组与汇率，再预留创意点和调用模型。价格检查失败时返回 `MODEL_PRICING_PREFLIGHT_UNAVAILABLE`，并明确 `provider_executed=false`、`points_reserved=false`。此修复**尚未部署**，不能用它宣称线上生成已恢复。

## 实测覆盖

| 层 | 实测 | 结果 |
| --- | --- | --- |
| 本地 MCP 握手/工具发现 | `initialize`、`tools/list` | 成功发现 131 个商家工具；未暴露 `ops.*`。 |
| MCP UI 资源 | 6 个 `resources/read` | 6/6 返回。资源可读取不等于 App 已展示所有业务组件。 |
| 无前置参数只读调用 | 35 个线上工具调用 | 30 成功、2 个 `INVALID_REQUEST`、3 个 `FORBIDDEN`。后者为商家访问平台工作台能力被拒，权限边界生效，但仍出现在商家工具列表。 |
| ChatGPT App 工作区 | `onboarding.status` | 重新本地登录并完整重启 App 后成功；先前失效凭据返回 `UNAUTHENTICATED`，见 [失效截图](evidence/2026-09-29-chatgpt-app/00-auth-expired.png)。 |
| ChatGPT App 商品 | `catalog.search` 工作区范围 | 返回 1 件未绑定商品；返回的历史店铺名与人工登记店铺不同，不能自动合并归属。 |
| ChatGPT App 内容候选 | `workspace.interactive.confirm` → `content.draft.generate` | 确认成功，生成被 `AUTHZ_SCOPE_MISMATCH` 拦截。 |
| ChatGPT App 中转/账务 | `merchant.first_value(draft=true)` → 积分账本 | 真实调用一次；服务端第一响应为 `MODEL_USAGE_COST_MISSING`，插件错误重试后变成 `MODEL_ACTION_ALREADY_STARTED`。账本显示 1 点预留，未见结算/释放。 |

本轮未覆盖其余需要素材、店铺授权、审核状态或可能发布/扣费的工具的线上写操作；不能宣称“131 个功能全通过”。

本地检查：最新前置检查代码经 `npm run typecheck`、`npm run test:release-gates` 通过（Vitest 1387 项通过、16 项跳过，后续 Node/脚本门禁也通过）；前置检查、授权及相关 API 定向测试 18 项通过，其中包含价格超时后不预留积分、不写授权/审计、不调用 provider 的处理器测试。插件 bridge、安装与 manifest 相关 127 项通过。线上 demo 配置热修后 API 双副本均 healthy，公网 `/releasez`、`/api/healthz` 和运营后台 `/healthz` 通过。上述检查不能替代仍被阻断的文案生成验收。

## 根因与已完成的本地修复

1. `content.draft.generate` 只生成未绑定预览，没有品牌 ID，却在 `packages/contracts/src/authz.ts` 被映射为品牌级。已将**该方法**改为工作区级，正式 `content.generate` 仍为品牌级。新增定向授权测试；本地类型检查与 14 个相关 API 测试通过。
2. 线上模型用量账本记录：模型 `qwen3.7-plus`，输入 325、输出 402 token，状态 `pending_cost`，错误 `MODEL_PRICING_MODEL_MISSING`。线上中转 `/api/pricing` 不含该模型；其中 `qwen3.8-flash`、`qwen3.8-max` 有 VIP 组价格。**没有**据此推断本次实际成本，也没有释放预留或重放模型调用。
   - 配置热修的新模型已经列于中转 `/v1/models` 且有 VIP 价格；第二次调用的 `pending_cost` 原因是 `MODEL_PRICING_FETCH_TIMEOUT`。这是价格接口可用性问题，不能把“价格表有模型”误当成整条结算链已通过。
3. 插件将带幂等键的模型写请求收到的 503 当作可重试临时错误，掩盖了成本结算阻断。已在本地 bridge 阻止 `MODEL_USAGE_COST_MISSING`、`MODEL_USAGE_SETTLEMENT_PENDING` 和明确需对账的响应重试，并改为提示用户查账、勿重复生成；新增回归测试通过。
4. App 曾显示笼统 `UNAUTHENTICATED`。失效凭据的刷新端点返回 `MCP_OAUTH_INVALID_GRANT`；本地重新登录并重启 App 后查询成功。已在本地 bridge 为服务端 `UNAUTHENTICATED` 加入明确的本地登录恢复指引和回归测试。
5. 已在本地 `merchant.first_value(draft=true)` / `content.draft.generate` 共用处理器中加入计费前置检查；定向测试覆盖价格缺失、价格超时、有效价格，以及超时后不预留积分、不写授权/审计、不调用 provider。需要按免迁移的兼容候选部署后，在 App 中复验。

## 上线前优化顺序

1. **模型与价格先对齐**：配置热修已切换为价格表覆盖的 `qwen3.8-flash`；本地前置检查代码已完成。下一步以免迁移候选部署并验证；价格接口超时或任一计费依据缺失时，应在 provider 调用及创意点预留前阻断。仍需验证中转价格接口的稳定性和结算后的真实账本。
2. **对账两次请求**：由平台运营分别核对两条 `pending_cost` 的 provider 请求/账单和模型用量，按已有人工对账流程处理两笔各 1 点预留。未拿到权威成本证据前不手工标记成功或退款，也不继续发起付费测试。
3. **部署最小修复**：审计当前线上 API 源码基线与主分支差异。线上 API 为 `bb417660...`，本地主分支为 `a1462b0e...`，两者之间 138 个提交且包含迁移 255；本次授权/bridge 修复不得把主分支整体倒灌到仍在迁移 254 的 demo。按 demo 发布手册冻结兼容候选，只替换 API 双副本及本地插件；不迁移数据库。
4. **App 使用引导**：首次进入先显示当前账号、工作区、人工登记/官方授权店铺数；对未绑定商品提供明确“导入/确认商品事实”入口。`catalog.search(scope=workspace)` 不需要 `platform` 和 `account_id`，修正当前 App 回复中的误导提示。
5. **工具列表与参数契约**：在商家视角隐藏或标注平台专用读工具；对 `support.customer.replies.list` 和 `catalog.image.get` 补齐必填参数 schema 或给出明确缺参提示。上传 Excel/CSV 的入口与导入后未绑定商品状态需用真实桌面和 App 流程单独验收。

验收门槛：新用户在 App 中完成登录 → 读取真实工作区 → 上传/导入资料 → 事实确认 → 生成待审核内容；每一步都能看到服务端真实状态、权限与成本证据，出错时有单一可执行恢复动作。部署后再跑线上 App、桌面浏览器、API/MCP、账务与容器健康的完整回归。
