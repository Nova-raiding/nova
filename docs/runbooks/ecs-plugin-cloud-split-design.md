# 本地插件与 ECS 云端源码的双制品边界（分阶段实施，尚未上线）

状态：**NO-GO**。v2 双制品的打包、签名记录、云端清单、候选归档及云端门禁镜像已在隔离分支实现定向验证，但尚无生产 macOS/Windows 双平台原生安装与真实 ChatGPT host 证据，也没有切换 101。执行云端测试的操作入口是先在可信本地发布机生成、签名并核验双平台制品和测试记录，再于无插件源码的候选归档目录运行 `npm run test:cloud-release-gates`；此命令不能替代本地安装验收。当前 `candidate-source.tar` 约 48.9 MB，已排除已跟踪的 `artifacts/`、`screenshots/`；再排除 `apps/plugin/`、`.codex-marketplace/` 后约 46.7 MB，只节省约 2.2 MB。此变更的主要目的不是解决 101 磁盘占用，而是落实“插件前端只在用户桌面安装”的边界。不能以裸 `git archive HEAD`（约 528 MB）的大小衡量现有生产候选包。

## 现状中的直接依赖

| 消费者 | 当前依赖 | 单边排除后的结果 |
| --- | --- | --- |
| `scripts/release-manifest.ts` | 读取插件 manifest/package/skill/bridge 和镜像 bridge 字节，记录于 v1 `artifacts` | 无法生成清单 |
| `tests/release-manifest-gate.ts` | 重新读取上述本机文件，比较 SHA-256/字节数和 `mcp.bridgeSha256` | ECS preflight 失败 |
| `infra/scripts/deploy-preflight-ecs.sh` 与 `deploy-preflight.sh` | 直接计算 `apps/plugin/mcp/bridge.mjs` SHA-256，供真实 ChatGPT host 证据门禁比较 | 无法验证 host 证据 |
| `infra/docker/candidate-gates.Dockerfile` / `test:release-gates` | 在云端门禁镜像运行包含插件 manifest、MCP surface、release metadata 的测试 | 缺少测试输入；不能静默跳过 |
| 根 `package.json`、`package-lock.json`、`tsconfig.json` | `apps/*` 包含本地插件 workspace；根编译和部分测试含插件测试 | `npm ci`、TypeScript 与源码清单需重验 |
| `apps/plugin/scripts/package-local-plugin.mjs` | 生成 macOS/Windows 本地安装 tar.gz；Windows 仅单独验证 helper Authenticode | 目前没有被独立可信引导程序验证的整包签名 |

CodeGraph 对 `buildReleaseManifest` 的调用关系指向 `tests/release-manifest-gate.test.ts`、`tests/release-manifest.test.ts` 与 `tests/operations-scripts.test.ts`；本表以当前文件内容核对，图索引可能滞后于工作树。API/MCP 的服务端代码仍应保留在云端，不能把服务端契约与本地 stdio bridge 混为一谈。

## 目标身份

1. 在可信本地发布机从**同一干净 Git SHA**生成独立的 macOS/Windows 安装包；安装包须由桌面可信引导程序在提取或执行任何包内脚本之前验证整包签名。Windows helper 的 Authenticode 仅证明该 EXE，不证明 ZIP/tar 内 JS、PowerShell 和 CMD。macOS helper 也需平台签名/公证门禁。发布私钥不进入仓库、101 或安装包。
2. 本地产生规范 JSON `plugin-release/2`，包含完整 Git SHA、release ID、插件版本、操作系统/架构、整包 SHA-256、bridge SHA-256、插件 manifest/skill 摘要、MCP 方法列表摘要、签名 key ID 和签名。使用独立的离线 Ed25519 插件发布私钥签名；101 仅保留受保护公钥。描述符本身不包含插件代码或可执行脚本。
3. 生成 `candidate-identity/2`：`git_sha`、**云端** source SHA-256、`plugin_release_descriptor_sha256`、比较清单 SHA-256、同步计划 SHA-256和 release ID。云端归档统一排除 `artifacts/`、`screenshots/`、`apps/plugin/`、`.codex-marketplace/`；四个归档生产/校验点必须使用同一个固定 pathspec，staging 必须拒绝这些目录重新出现。不可从 v1 身份推断 v2 插件摘要，不接受混合版本。
4. `release-manifest/2` 保留 API、MCP 契约、商家/平台/worker 和网关源码的本地字节校验；插件字段改为引用受签名描述符的**摘要与 bridge/MCP 方法摘要**。云端校验描述符签名、Git SHA、release ID、插件版本、MCP 方法摘要、source identity 和 ChatGPT host 证据中的 bridge SHA-256，且拒绝描述符外的插件源码路径。生产证据 bundle 继续绑定完整 release manifest 字节。
5. 将测试分成两种门禁：本地插件包构建前运行插件 manifest、镜像一致性、MCP surface、macOS/Windows 安装升级与签名验收，产出与整包摘要/Git SHA 绑定的签名测试记录；101 的云端门禁只运行服务端/运营/商家/worker 测试并验证本地签名测试记录，不能把插件测试从总门禁中直接删除。API、worker 和 UI 运行镜像均不得包含插件 bridge、UI、安装器或其编译测试树。

## 迁移顺序和失败关闭

1. 先实现并离线验证本地整包签名与可信引导安装器，包括 Windows 与 macOS 篡改、重放、旧版本、错误平台和签名密钥轮换负例；产出独立制品和 `plugin-release/2`，但不改云端部署。
2. 添加 `release-manifest/2` 和 `candidate-identity/2` 解析器、独立单元/API 测试；v1 发布器继续保持现状，v2 必须以配置显式启用且缺字段时失败关闭。发布私钥只能在本地可信发布机使用，不能借生产 evidence 私钥伪造本地完成记录。
3. 拆根 workspace/TypeScript 与候选门禁测试，使从云端归档抽取的源码能执行 `npm ci`、类型检查、迁移/权限/账务/MCP 契约测试，并能构建六业务镜像。必须保持真正运行环境的 Docker 健康和源清单校验。
4. 再同时切换候选包生成、门禁镜像、六镜像构建、staging、部署摘要校验和两个 ECS preflight 到同一云端 pathspec 与 v2 身份。部署器必须先验证插件描述符签名和包摘要绑定，再允许运行任何前向数据库迁移；任何 v1/v2 混配、缺失插件证明或目录泄漏都中止。
5. 用独立候选链做全流程验证：云端归档不含插件路径；本地已签安装包由真实 ChatGPT macOS/Windows host 安装并走 stdio→API/MCP→模型中转；候选 API/worker/商家/运营 UI 健康；Host 证据、插件签名、云端 Git/镜像/发布清单身份闭环一致。保留可回退的 v1/桥版本，且不得为缩包删除业务数据或旧回滚制品。

上线前缺少上述任一项时，**不得**把排除了插件目录的源码包送到 101，也不得声称插件前端没有暂存于 101。当前可证明的只是运行镜像拷贝边界；现行 v1 staging 源码仍含插件测试输入。
