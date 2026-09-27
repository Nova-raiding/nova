# 101 快速更新方案

适用对象：现有 ChatGPT 本地 stdio 插件的云端 API/MCP、worker 和桌面后台。日常更新沿用正在服务公网的 Compose 项目。冻结一个目标提交，准备好制品后只更新受影响服务；发布窗口内不增加功能、不升级数据库引擎、不重做发布工具。

本方案的 20–30 分钟是**制品、必需测试和证据准备完成之后**的常规更新目标，不是当前完整 main 的上线承诺。首次准备耗时独立报告。现有正式生产门禁仍须通过；demo 更新遵循已存在的 `ecs-demo-direct-deploy.md` 适用范围，不能把 demo 成功标为正式生产发布成功。

## 1. 一个 owner、一张任务单、一个候选

任务单固定：完整 Git SHA、更新服务列表、各服务现有 Git SHA/镜像 digest、候选 digest、数据库迁移变化、Compose/env 路径与摘要、验证场景、回滚配置。代码继续开发可以留在 main，但本轮始终使用已冻结提交；影响本轮的修复才更换候选并重跑相关检查。最终发布前仍满足项目要求的 typecheck 与 release gates。

先执行只读现状检查：

```sh
npm run deploy:101:status
```

该命令固定读取 SSH `101`、`merchant-demo-85575f9c` 和三个公网探针，输出每个运行服务的真实 Git SHA、镜像引用、镜像 ID、Compose 路径及磁盘可用空间。不输出环境变量和密钥，不修改服务器。退出 2 表示应用更新的前置检查有问题，退出 1 表示检查未完成；退出 0 只代表现状检查通过，**不代表目标版本可发布**。8 GiB 是构建前的保守磁盘检查下限，不代表构建空间足够；完整镜像集仍需独立估算。数据库/Redis 的 tag 引用作为提示记录，常规应用更新保留其当前容器和镜像 ID。

以每个镜像标签的 Git SHA 为基线做 `git diff <component-sha> <target-sha> -- <相关目录>`，不要只与公网 release SHA 比较。共享包、依赖锁文件或迁移有变化时，检查所有依赖组件，不能把“只改 API 入口”当作 API 是唯一受影响组件。

| 变化 | 至少检查/构建 | 更新服务 |
| --- | --- | --- |
| 仅运营前端 | merchant-ops-ui | ops-ui |
| 仅商家前端 | merchant-ui | ui |
| API/MCP | merchant-api；共享包变化同时检查 worker | api、api-replica |
| worker / 共享业务包 | merchant-worker；共享 API 契约同时检查 API | 使用该镜像的全部业务 worker |
| 支付 / 网关 | payment-gateway / pilot-gateway | 对应服务；另验回调或路由 |
| SQL 迁移、数据库引擎或持久化格式 | 迁移专项准备 | 不进入无迁移快速更新 |
| 仅本地插件 | 本地插件包及真实宿主验收 | 无云端变化时不部署 101 |

## 2. 提前完成准备，保留可复用制品

1. 在 main 审阅目标改动，完成类型检查、对应单元/API 测试、发布门禁；保留与冻结 SHA 绑定的结果。
2. 按 `ecs-candidate-safe-sync.md` 生成并校验候选源码，将目标 SHA 暂存一次。上传源码和安装暂存工具不计为部署完成。
3. 仅构建任务单中的镜像。已有通用构建器支持以下选择；未设置 `ECS_RELEASE_COMPONENTS` 时仍构建完整六镜像。

在 **101 上该提交已验证的 release 目录**，使用现有受保护 Node/npm 环境执行，例如仅运营后台：

```sh
ECS_RELEASE_GIT_SHA='<冻结的完整40位SHA>' \
RELEASE_ID='<与.candidate-identity相同的release-id>' \
ECS_RELEASE_IMAGE_REPOSITORY=127.0.0.1:5000/storenova \
ECS_RELEASE_IMAGE_OUTPUT_DIR='/受保护目录/本轮唯一构建输出' \
ECS_RELEASE_COMPONENTS='merchant-ops-ui' \
sh infra/scripts/build-ecs-release-images.sh
```

多个组件用空格分隔，例如 `merchant-api merchant-worker merchant-ops-ui`。该构建器保持共享构建锁、归档摘要验证、镜像标签校验与不可变 digest。未知或重复组件在调用 Docker 前拒绝。部分构建只输出 `component-images.json`，不输出可被误用为完整发布输入的 `release-images.json` / `repository-image-digests.json`。完整生产发布仍需准备完整镜像清单并通过现有校验，不能把部分清单交给正式部署器。

4. 在主机受保护目录准备本轮完整 Compose、env 和回滚 Compose。未变组件保留各自实际镜像 digest 与真实提交；新组件采用刚构建的 digest。由既有发布流程生成与实际完整运行集一致的 release manifest 和 `/releasez` 输入，不手改版本号冒充镜像更新。配置只在主机保存，`docker compose config` 输出可能含密钥，不能回传聊天或提交 Git。
5. 核对运行数据库迁移链与目标代码：版本、名称、checksum 均一致才进入无迁移路径。新增迁移先完成备份、隔离恢复、前向迁移和旧版兼容验证，单独安排窗口；切勿只看迁移数字。数据库不兼容时，旧镜像不能自动回滚。
6. 必需的候选业务验收和发布证据在切流前准备齐。缺一项就列出具体缺口及修复动作，退出准备阶段，不循环重建无关镜像。

构建成功的 digest 可以保留，不因之后的业务验收失败而无条件重建。再次构建只针对实际改动；不得把另一 SHA 的证据重贴到新候选上。构建缓存按现有预算维护，不删除数据库、业务卷或 Registry blob 来腾空间。

## 3. 发布窗口：20–30 分钟目标

| 时间目标 | 动作 | 完成条件 |
| --- | --- | --- |
| 0–3 分钟 | 获取发布锁，复核线上状态和冻结的任务单 | 现网基线未漂移，配置/镜像/回滚输入齐全 |
| 3–10 分钟 | 仅替换明确列出的应用服务 | 容器 healthy，实际镜像 ID/digest 与任务单一致 |
| 10–20 分钟 | 公网、桌面与真实本地插件最小业务验收 | 发布身份、权限、目标业务、中转回执正确 |
| 20–30 分钟 | 归档完成记录，或执行已验证回滚 | 新版验收通过，或旧版恢复并记录失败 |

这是操作时限目标，当前没有脚本替操作者自动保证总时长或自动回滚。发现新缺口立即终止本轮并记录失败阶段；不要在窗口里追加工具开发、反复全量构建。超时的构建任务必须确认进程状态后再重试，不能启动第二个相同任务。

对于当前已授权范围内的 demo 修复，沿用 `ecs-demo-direct-deploy.md` 的明确服务更新。例如只更新运营台（变量由主机受保护任务单设置）：

```sh
# 在 101 执行。NEW_COMPOSE/NEW_ENV 均是已审核的完整受保护配置。
# ECS_DEPLOY_LOCK_PATH 使用现有受保护部署配置中的同一把锁。
# 在同一 shell 内持有 FD9，直到健康验收或回滚全部结束。
: "${ECS_DEPLOY_LOCK_PATH:?必须使用现有生产发布锁路径}"
exec 9>>"$ECS_DEPLOY_LOCK_PATH"
flock -n 9 || exit 1
docker compose --project-name merchant-demo-85575f9c \
  --env-file "$NEW_ENV" -f "$NEW_COMPOSE" \
  up -d --no-deps --wait --wait-timeout 120 ops-ui
```

API 更新必须明确列出 `api api-replica`；worker 更新明确列出实际使用其镜像的业务 worker。不得省略服务名，不启动旧扫描容器或重建数据库。正式生产更新使用现有受保护 `deploy-verified-ecs-compose.sh`，仍执行其预检和回滚契约；此处 demo 命令不是正式门禁旁路。

`up --wait` 成功后检查公网 release 身份、API `/readyz`、Ops `/healthz`；再用桌面浏览器验证受影响登录/权限/操作。涉及 MCP/模型时由真实本地 stdio 插件完成对应任务并核对 provider request、usage/cost 和账务结果。健康探针不能替代业务验收；付费生成失败不要盲目重放。

无迁移且旧配置兼容时，使用本轮保存的旧 Compose/env 对**相同服务列表**执行同样的 `up --no-deps --wait`，同时恢复配套 manifest/路由，再验旧镜像、公开身份和业务。已经迁移且不兼容时使用事前演练的迁移恢复方案，不能直接降级镜像或覆盖生产数据库。未验证回滚前不应切换。

## 4. 本次实施与证据

已实现：按组件构建；只读 101 状态入口；本操作方案。未实现全自动端到端部署器，不宣称当前 main 已上线或所有正式门禁已通过。

2026-09-27 只读实测：当前公网 `release-183fc04e5a62-image`；API/replica/Ops 来自 `183fc04e5a6292a63e01e02a3d168ce83ad350fe`，其他运行中的业务组件来自 `3567df1e2894aaf45974464f2ecad50b187971ab`。13 个该项目运行容器 healthy，三个公网探针 HTTP 200；磁盘剩余约 11.6 GiB。该结果只证明当时现网状态，执行更新时重新检查。

组件选择和完整清单隔离由 `npm run test:deploy:fast` 验证；构建器测试使用 Docker 替身，不等价于真实镜像构建或切流验收。本轮未切流、未迁移、未修改服务器配置。

本次验证结果：`npm run typecheck` 退出 0；`npm run test:deploy:fast` 的 15 项测试全部通过；`npm run test:release-gates` 全命令退出 0，其中 Vitest 为 172 个文件 / 1324 项通过、7 个文件 / 16 项跳过，后续脚本及 Node 门禁也完成。跳过项不算运行时验收证据。`npm run deploy:101:status` 在真实 101 上退出 0，保留数据库/Redis tag 引用提示；它不批准发布。没有业务界面改动，本轮验证了状态脚本和真实容器/公网探针，尚未执行新版部署后的桌面及 ChatGPT 业务验收。
