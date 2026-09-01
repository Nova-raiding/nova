# Codex App 插件 E2E 验收报告

日期：2026-08-25  
插件：`merchant-marketing@merchant-local`  
工作区：`ws_demo`  
环境：Codex CLI 0.149.0 / 本地 fixture API

## 验收范围

本次按商家真实使用路径执行安全 E2E；允许本地素材/商品建档，但不授权、不充值、不发布：

1. Codex 发现并加载插件。
2. 检查工作区健康。
3. 查询商品目录。
4. 查询防晒品类。
5. 生成商品详情。
6. 生成或查询演示主图并展示审核结果。
7. 确认未执行 OAuth、充值和平台发布写入。

## 结果

| 层级 | 结果 | 证据 |
|---|---|---|
| 插件安装 | 通过 | `codex plugin list --marketplace merchant-local --json` 显示已安装、已启用 |
| 插件 manifest | 通过 | 官方 plugin validator 通过 |
| MCP bridge 发现 | 通过 | 安装缓存 `tools/list` 返回 67 个工具，包含素材事实人工确认入口 |
| 素材事实人工确认 | 通过 | 安装缓存 bridge 调用运行中 API 成功；未扫描、畸形 JSON、跨租户和人工确认后自动覆盖均被拒绝，人工事实保持 `manual/succeeded` |
| bridge 品类调用 | 通过 | `catalog.categories` 返回 1312 服装/防晒外套 |
| API 健康 | 通过 | `GET /healthz` 返回 `status: ok` |
| Codex App 会话 | 通过 | 重启 App 后成功调用 `merchant-marketing`，返回商品主图生成结果 |
| 主图文件生成与审核 | 通过 | 返回 2 个 WebP 图片附件，审核结果为通过 |
| Codex App 图片可视化 | 通过 | App 对话已渲染两张商品主图，并提供下载链接 |
| 素材库开发控制台 | 通过 | `/tmp/merchant-studio-asset-library-final.png` 显示 15 个素材、权益/扫描状态和“打开并阅读” |
| 自有商品上传入口 | 通过 | 插件首页第一张操作卡为“上传我的商品图片和资料”；点击后进入新会话并预填建档任务，输入框左下角 `+` 可打开“文件和文件夹”选择入口 |
| 自有商品真实文件上传 | 通过 | Codex App 附加 1,241,925 字节 PNG 后，`asset.upload` 仅传绝对 `file_path`，bridge 在模型边界外读取、校验、计算 SHA-256 并上传；41 秒返回，无终端 Base64 |
| 自有商品建档与可视交付 | 通过 | 已建立“轻云防晒外套 2026”淘宝商品档案，保存 3 个 SKU、价格和库存；App 直接显示原始夹克图、详情文案和规则审核，状态保持待审阅/未批准/未发布 |

## 原始运行证据

## 2026-08-25 本轮增量核验

- 代码变更后的静态/契约/构建核验已通过：根项目 `npm run typecheck` 通过，`npm test` 为 75 个测试文件、453 个测试全部通过；`apps/ops-console` 使用 Node 22 执行 `npm run build` 通过。
- CodeGraph 当前索引统计为 3,180 个节点、13,077 条边、15,503 个 unresolved references；因此本轮仍将 CodeGraph 作为结构关系证据，并用源码、契约和测试交叉核验。
- 本轮未重新执行 Codex App 的可视化点击验收：当前会话没有可调用的 In-App Browser 连接。历史 App 验收证据仍有效地证明既有插件链路，但不能证明本轮运营台改动已在 App 界面重新回归。
- 本轮补做了 Codex CLI 只读插件尝试：`merchant-marketing@merchant-local` 可被 `codex plugin list` 发现并启用，但新的 45 秒 `codex exec` 仍只启动线程、未产生 `workspace.health` 工具调用，随后超时。后续确认本机实际安装的是新版 `/Applications/ChatGPT.app`（26.818.61809，包含 Chat/Work/Codex），但当前代理会话没有可调用的 ChatGPT App/In-App Browser 控制连接，因此仍记为宿主未验证而非成功。
- 本轮新增的运营队列命令已通过服务层、API E2E、MCP 契约和运营台构建核验；由于当前会话仍没有可调用的 Codex App/In-App Browser 连接，尚未取得这些新增按钮的 App 可视化回归证据。
- 随后使用 gstack headless Chromium 启动隔离内存 fixture API（8792）和运营台（5176）完成真实浏览器回归：切换到 `ws_demo` 后显示 2 条队列；“安全重试”点击后从失败队列消失，“确认异常”请求成功，“创建修正版”按钮可发起修正版请求；API 审计确认三项 action 均已写入。该结果证明运营后台真实页面链路可用，但不等价于 Codex App 宿主内的可视化验收。
- 浏览器回归还发现并修复运营台 MCP envelope 解包问题：API 返回 `data.result` 时此前页面静默显示空域；现在兼容 envelope，并对缺失的批量队列字段做安全默认值。
- 插件 bridge 运行时复验通过：`tools/list` 返回 138 个工具，并包含 `ops.marketing.queue`、`ops.marketing.generation.retry`、`ops.marketing.publish.acknowledge` 和 `ops.marketing.revision.create`；通过 bridge 调用队列查询返回 1 条生成任务。该项是 Codex 插件运行时证据，不是 Codex App 宿主 UI 证据。
- 直接 bridge 连接到现有 8787 服务可以返回工具列表；该服务仍暴露旧的六平台 schema，属于远端运行版本落后于当前源码六平台契约的证据，不能用作当前代码的运行验收。

`/tmp/codex-app-image-filelink-final-2.png`：

```text
主图 1：已直接渲染
主图 2：已直接渲染
文件链接：下载主图1、下载主图2
审核结果：规则检查无阻断
```

`/tmp/codex-upload-menu.png`、`/tmp/codex-upload-file-picker.png`：

```text
插件首要任务：上传我的商品图片和资料，创建商品档案并生成详情和主图
Codex 附件菜单：文件和文件夹
系统文件选择器：已打开，可从桌面、文稿、下载等位置选择商品素材
```

`/tmp/codex-file-path-progress-27s.png`、`/tmp/codex-product-build-39s.png`：

```text
上传文件：merchant-product-main-v3.png
上传方式：绝对 file_path；未运行或传输 base64
素材 ID：asset_70baab94-9b8d-4b96-85f0-2753abfa2eeb
SHA-256：ac8c73ce3c3520687b42057b96e6865515043657582d466ae8dce9538ea00d97
商品：轻云防晒外套 2026（淘宝，3 个 SKU）
商品 ID：prod_taobao_local_4d6f6ca583245f236d94
交付：商品详情、规则审核、原始夹克图片均在 Codex App 内可见
状态：待审阅、未批准、未发布
```

## 附件上传故障与修复

旧版 `asset.upload` 只接受 `content_base64`。1.2 MB PNG 会膨胀为约 165.6 万字符，Codex 必须先在模型上下文中执行和传递 Base64，实测耗时约 6 分钟并出现 `Adjusting chunk size for token limits`。这也是用户选择文件后迟迟看不到产物的直接原因。

现已将参数契约改为 `file_path` 或 `content_base64` 二选一。本地附件必须传绝对 `file_path`；bridge 在模型边界外完成普通文件校验、50 MB 限制、读取、Base64 编码和 SHA-256 校验，再保持原有 API 请求契约转发。相对路径、目录、符号链接、超限文件、双重输入和哈希不匹配都会拒绝。新增 bridge 回归测试证明文件内容和哈希正确转发且不会泄露 `file_path` 到 API。

## 附件解析失败恢复增量（2026-08-31）

- 本地闭环已补齐：API 在解析失败后持久化 `parse_failed`、错误上下文、尝试次数和可重试标记；bridge 现在保留脱敏后的 `next_actions`、`retryable`、`attempts` 和 `request_id`，并明确提示“素材已保留”，引导商家重试解析或人工确认事实。
- bridge 回归测试覆盖失败响应的恢复字段、人工确认入口和敏感解析器错误不外泄；源码 bridge 与 marketplace 安装镜像保持一致。
- 本项仍不迁移到 `doc/done`：当前会话没有可调用的 Codex App/In-App Browser 连接，尚未重新执行真实宿主的“附加文件→解析失败→回到对话→人工补录→恢复任务”点击验收。已有 API/fixture 测试不能替代宿主证据。

## 结论

插件安装、MCP/API 调用、素材库、自有商品上传入口、真实 PNG 上传、商品建档、详情生成和 Codex App 图片展示均已通过。图片同时通过独立 image 内容块和项目产物文件链接交付，避免不同宿主版本对 MCP 图片块渲染不一致。Codex 插件不能在详情页嵌入自定义原生上传控件，因此上传使用宿主会话输入框的 `+` 附件能力；插件首页已提供明确的首要入口和操作引导。

本次素材扫描使用 `fixture://local-demo/...` 演示证据，只能证明本地流程，不代表生产安全扫描；尺寸、清晰度、OCR、平台裁切和淘宝最终审核仍需真实外部服务验收。本次没有调用发布工具。

## 生产外部依赖接入后重跑

后续接入真实图片模型和对象存储后，继续沿用同一交付协议；当前本地 fixture 模式已完成 Codex App 端到端验收。

## 任务恢复与事实安全回归（2026-08-25）

- 修复“继续处理历史任务”实际创建重复任务、自动选择方向、自动确认方案并消耗生成配额的问题；历史任务现在按 `taskId` 原位恢复。
- 新任务创建后停留在“待选创意方向”，商家选择方向后仍需点击“确认制作方案并生成”，未确认前不会创建内容任务。
- 清除详情页固定演示事实：不再默认展示 ¥169、UPF50+、锦纶 88%、168g、云雾白/雾蓝或 1,286 库存。当前商品实际展示 ¥299、浅灰、M/L/XL、库存 120；材质、成分、重量和防晒性能继续显示待确认。
- 空白任务显示内容版本 v0、检查结果 0 和无评分；版本比较、反馈、批准和发布保持不可用。
- 任务列表改为每页 12 条，只显示商品名、平台、中文状态、时间和版本，不向商家暴露 UUID 与内部英文状态。
- 浏览器实测恢复任务仅执行 GET；选择方向仅执行 `POST /directions`，未出现 `POST /v1/tasks`、`plan/confirm` 或 `content-jobs`。全量回归为 61 个测试文件、323 个测试通过。
