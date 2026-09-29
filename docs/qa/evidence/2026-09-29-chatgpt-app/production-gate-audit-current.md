# 生产版本与发布门禁只读核查

采集时间：2026-09-29 11:48 CST。范围：`main` 工作目录、`101` 主机服务清单、公开健康与发布接口。未写入生产、未操作 ChatGPT 桌面、未执行数据库迁移。CodeGraph 用于定位调用关系；gstack canary 的原则用于区分线上健康观察与候选发布验收。

## 当前可证事实

| 项目 | 只读证据 | 结论 |
| --- | --- | --- |
| 公网 API 与运营页 | `https://yxsona.com/api/healthz`、`/api/readyz` 和 `https://ops.yxsona.com/healthz` 均返回 `status=ok`；`/api/releasez` 返回 `ready=true` | 只能证明当前旧服务响应正常，不能证明新候选通过门禁 |
| 公网 API 身份 | `/api/releasez`：`release-demo-product-code-20260929`，Git SHA `fd1ad6a7bd122a391350c185798ac07e92795f8c` | 不是本地 `main` HEAD `063b0752ee0c6a867ad398c280c7dd64be26096d`，也不包含工作树未提交改动 |
| 101 服务 | `node infra/scripts/ecs-fast-status.mjs` 和 `ssh 101 'docker ps --format ...'`：API/API 副本 `fd1ad6a7`，商家 UI `f48c8454`，运营 UI `fccee758`，worker `ffcda399`，均在运行；状态采集器报告 `application_services_have_mixed_source_revisions`、`release_approved:false` | 宿主服务来自不同修订；状态采集器是只读报告，不是正式发布批准器 |
| 运行能力缺口 | API `healthz` 内 `setup.productionEvidence.capability`、`.capacity` 为 `blocked`，分别提示 `CAPABILITY_EVIDENCE_PATH cannot be read`、`CAPACITY_REPORT_PATH cannot be read`；embedding `ready=false`，原因是向量索引关闭和模型缺失 | `healthz: ok` 不等于能力、容量和向量链路验收完成 |
| 本地候选 | `release-metadata.json` 工作树目标迁移版本 255，插件版本 `0.1.0+codex.20260929114000`、桥接暴露 116 项；本地 `main` 比 `origin/main` 超前 55 个提交，工作树约 115 个待处理路径 | 当前工作树不是可签名的干净生产候选；候选包脚本明确要求 clean committed source tree |

`codegraph status .` 显示索引 2,343 文件、33,762 节点、132,154 边，有 1 个新增和 8 个修改文件待同步。使用 `codegraph explore 'deploy-verified-ecs-compose'` 查找发布链路；图仅帮助定位，最终以当前源码、手册与运行时响应为准。

## 可本地直装的边界

`apps/plugin/scripts/install-local-plugin.mjs` 使用本地 `merchant-local` 源，安装版本化 stdio 包，随后核对安装缓存与源码、构建并校验 macOS Keychain helper；成功输出仍要求重启 ChatGPT。磁盘上已有 `0.1.0+codex.20260929114000` 安装缓存。桥接文案、技能说明、工具可见性等纯本地插件改动可以走这条链路，再在真实 ChatGPT App 中验收。缓存目录存在本身不是本轮 App 调用成功证据。

若插件调用的 API 处理器、数据库、worker 或桌面网页实现也变了，本地直装不会让云端获得这些改动。当前 API、商家 UI 和运营 UI 的新工作树改动仍未作为同一候选部署；不能把本地插件成功安装表述成这些云端改动已上线。

## 生产候选阻断与下一步

1. `docs/runbooks/ecs-candidate-safe-sync.md` 明确：暂存/构建不等于部署；隔离候选必须有摘要固定镜像、独立运行时、TLS `/releasez` 精确身份，以及绑定同一候选的 API/MCP、模型、ChatGPT 宿主、恢复证据，之后才可切流并做生产 canary。
2. 当前工作树未提交且不干净，`infra/scripts/prepare-ecs-candidate-bundle.sh` 第 31 行会拒绝生成候选包。必须先由 owner 复核并整合并行改动，冻结单一提交身份，完成规定的类型、测试和候选审查。
3. 工作树声明目标迁移 255。手册第 172–176 行将旧前缀至 255 的兼容桥、隔离恢复、受保护回滚 capsule 与实测迁移链列为正式切流前置项，且明确当前普通一键路径保持 NO-GO。用户已指定不迁移数据库，因此不能借这条路径把依赖 255 的 API/worker 候选直接切上现网。当前生产实时数据库前缀在本轮未重新采集，不能把历史“254”观察当作新候选证据。
4. 生产健康虽正常，能力和容量证据路径仍不可读；这些阻断需由对应受保护证据链解决。`release_approved:false` 是当前只读状态报告的结论，不能通过修改报告或忽略其值获得发布批准。

结论：**本地插件可继续安装并在 ChatGPT App 做现网 API 支持范围内的验收；API、商家 UI、运营 UI 和 worker 新候选尚未证明部署，正式生产切流未获门禁批准。**
