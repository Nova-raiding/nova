# Codex App 与大麦模型中转站配置

日期：2026-08-26

> 当前校正（2026-08-30）：本地 Docker API 已实际读取到业务 relay 地址、密钥和五类模型配置，且本地 healthz 显示模型配置就绪；这不等于 Codex App 宿主 provider 已切换，也不等于正式生产成本结算和发布证据已完成。当前宿主 `~/.codex/config.toml` 的 `model_provider` 仍需与其 provider section 对齐，生产环境仍必须提供正式配置、签名证据和 settled cost receipt。

> 实际协议探测（2026-08-30）：中转站 `/v1/models` 将 `glm-5.2` 标记为支持 `openai-response`，但使用 Keychain 中的中转凭据发送最小标准 `/v1/responses` 请求时返回 `500 convert_request_failed`（`not implemented`）。因此本机已保留 `damai_relay` provider section，但没有切换宿主顶层 `model_provider`；在供应商实现 Responses 转换并完成真实回归前，不得把宿主 relay 标记为可用。

> 2026-08-31 真实业务 relay 探测：`/chat/completions` 的 text 与 OCR 均返回 HTTP 200，并取得 provider request ID、usage 和 pricing snapshot 成本证据；image、image_edit、video 按脚本的成本保护保持 `not_run_cost_guard`，因此五模态仍不能标记为完整通过。

## 结论

要做到“使用 Codex App 的交互和工具能力，但模型费用全部走自有中转站”，必须同时配置两条彼此独立的模型链路：

1. **Codex Agent 链路**：负责理解用户消息、决定调用哪个 Skill/MCP、组织回复。它由 Codex 的用户级 `model_provider` 控制。
2. **大麦业务模型链路**：负责商品文案、生图、OCR、图片编辑和视频渲染。它由服务端 `MODEL_RELAY_*` 控制。

只配置第二条链路，不能消除 Codex App 自身的模型消耗；只配置第一条链路，也不能证明业务模型、钱包和成本审计都经过大麦服务端。

## 中转站必须提供的能力

| 消费面 | 必需协议/路径 | 用途 |
|---|---|---|
| Codex App/CLI | OpenAI Responses API，`wire_api = "responses"` | 对话编排、工具调用、代码任务 |
| 商品文案与 OCR | `/chat/completions` | 结构化文案、视觉事实候选 |
| 商品图片 | `/images/generations` | 主图候选和图片编辑 |
| 视频 | `POST /video/generations`、`GET /video/generations/{task_id}` | 成片请求和异步状态查询 |

如果中转站只有 Chat Completions、没有 Responses API，它可以承载大麦业务模型，但不能作为 Codex App 的自定义模型 provider。

## Codex 用户级配置

官方配置参考：<https://developers.openai.com/codex/config-reference>

以下内容必须放在用户级 `~/.codex/config.toml`。项目内 `.codex/config.toml` 不能覆盖 `model_provider` 和 `model_providers`。

```toml
model = "REPLACE_WITH_CODEX_COMPATIBLE_MODEL"
model_provider = "damai_relay"

[model_providers.damai_relay]
name = "大麦模型中转（非插件）"
base_url = "https://REPLACE_WITH_RELAY_HOST/v1"
env_key = "DAMAI_CODEX_RELAY_API_KEY"
wire_api = "responses"
requires_openai_auth = false
request_max_retries = 4
stream_max_retries = 5
```

密钥只通过当前用户环境或系统密钥管理注入：

```sh
export DAMAI_CODEX_RELAY_API_KEY="由中转站签发的密钥"
```

不要把真实密钥写进仓库、插件 manifest、MCP 参数或工作区级配置。修改后需要完全退出并重启 Codex App，再用一个新会话验证 provider。

> 该 `name` 是宿主左下角显示的**模型供应商**标签，不是插件名称。大麦插件由 `apps/plugin/.codex-plugin/plugin.json` 的 `interface.displayName` 定义，在聊天中显示为 `@大麦`。两者必须保持可区分，避免把模型出口误认为插件入口。

仓库提供一条 fail-closed 配置路径：先用 `codex:relay:configure` 写入 Codex 用户级 host-model provider，再注入该 provider 的 `env_key`，最后运行 `codex:relay:validate`。验证器同时检查 host-model relay 和业务-model relay；任一缺失或占位值都会返回非零退出码，不能回退到直连模型。

这里的 host-model relay 是 Codex App/CLI 自身的模型出口，唯一由用户级 `model_provider`、provider `base_url`、`wire_api = "responses"` 和 provider `env_key` 定义。业务-model relay 是商家服务端的生成出口，使用独立的 `MODEL_RELAY_BASE_URL`、`MODEL_RELAY_API_KEY` 和业务模型 ID；两套 Key、地址和账单不能互换。

仓库提供配置门禁，可在启动业务服务前同时检查两条链路：

```sh
npm run codex:relay:validate
```

该命令不会打印密钥；缺少有效的 `model_provider`、`base_url`、`wire_api`、`env_key`、host model、业务中转 Key 或任一业务模型 ID 时会失败关闭。它也拒绝占位值、带凭据/查询参数的 URL，以及旧的直连 provider URL/Key 环境变量。

仓库也提供配置生成命令。它只写入 provider、模型和中转地址，不写入 API Key，也不会覆盖其他无关配置：

```sh
CODEX_RELAY_BASE_URL="https://你的中转站/v1" \
CODEX_RELAY_MODEL="你的Responses兼容模型" \
CODEX_RELAY_API_KEY_ENV="DAMAI_CODEX_RELAY_API_KEY" \
npm run codex:relay:configure
```

命令完成后，再通过当前 shell 或系统密钥管理器注入 `DAMAI_CODEX_RELAY_API_KEY`，运行 `npm run codex:relay:validate`。没有真实地址、模型或合法环境变量名时命令会失败，不会写入示例配置。

## 大麦服务端配置

```dotenv
MODEL_RELAY_BASE_URL=https://REPLACE_WITH_RELAY_HOST/v1
MODEL_RELAY_API_KEY=由服务端密钥系统注入
MODEL_RPM_LIMIT=100
MODEL_TPM_LIMIT=100000
MODEL_DAILY_CNY_LIMIT=500
AI_MODEL=REPLACE_WITH_TEXT_MODEL
IMAGE_MODEL=REPLACE_WITH_IMAGE_MODEL
IMAGE_EDIT_MODEL=REPLACE_WITH_IMAGE_EDIT_MODEL
OCR_MODEL=REPLACE_WITH_VISION_MODEL
VIDEO_MODEL=REPLACE_WITH_VIDEO_MODEL
```

仓库内文案、图片、OCR、图片编辑和视频 provider 工厂现已只接受 HTTPS `MODEL_RELAY_BASE_URL`；旧的直连 `AI_BASE_URL`、`IMAGE_BASE_URL`、`VIDEO_BASE_URL` 和供应商 Key 不再启用模型网络出口。

`platform.model.status` 和 `workspace.health.setup` 会分别报告文案、图片、图片编辑、OCR、视频五类 `model_readiness`。缺少模型、密钥、HTTPS 或 provider 装配时会返回对应阻断原因；视频未配置时只能生成无渲染分镜，不会声称已经生成视频；图片编辑未配置时保留原图并阻断编辑请求。

## 验收清单

插件 Skill 不调用 Codex 宿主原生 `image_gen`；主图和图片编辑统一经过大麦业务 relay，以便钱包门禁、usage 计量、退款和审计保持同一条链路。

- 中转站日志能看到 Codex 的 `/responses` 请求，并能按用户/工作区归集输入、输出、缓存和总 token。
- 中转站日志能看到大麦服务端的文案、图片、OCR、编辑和视频请求。
- 断开中转站后，Codex 自定义 provider 和大麦生产生成都 fail-closed，不回退到 OpenAI 会员或直连供应商。
- `content.codex.prepare/commit` 在生产返回 `PLATFORM_GENERATION_REQUIRED`。
- 大麦账务记录中转请求 ID、模型、计量单位、供应商成本、商家收费和退款状态，但不记录原始 Key。
- 重复请求命中同一幂等键，不重复扣费；provider 失败会自动退款。

## 目前还缺什么

当前机器的 Codex 用户配置存在 `model_provider = "openai"`，但没有对应的 `[model_providers.openai]`；实际可见的是其他 provider section，因此宿主校验失败。与此同时，业务 relay 的本地容器配置已经就绪，但宿主进程不会自动继承 Docker Compose 环境。需要将宿主 `model_provider`、对应 provider section 和 `env_key` 对齐，并在正式环境提供 HTTPS 中转站、Responses API 兼容证明、Codex 兼容模型 ID、业务五模态模型 ID，以及可核验的成本结算回执。

## 2026-08-31 当前环境复核

执行 `npm run codex:relay:validate` 按 fail-closed 规则失败，缺少宿主 provider section/base URL/`wire_api=responses`/`env_key`，以及业务 relay URL、Key 和五类模型 ID。该失败是预期的安全阻断，不能迁移到 `doc/done`；未执行真实 canary，也未生成伪造的模型成本证据。
