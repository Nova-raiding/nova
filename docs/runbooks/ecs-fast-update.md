# 101 快速更新方案

适用对象：唯一常驻 demo `merchant-demo-85575f9c` 上的 ChatGPT 本地 stdio 插件 API/MCP、worker 和桌面后台。日常更新沿用该 demo 正在服务公网的 Compose 项目。冻结一个目标提交，准备好制品后只更新受影响服务；发布窗口内不增加功能、不升级数据库引擎、不重做发布工具。

本方案的 20–30 分钟是**制品、必需测试和证据准备完成之后**的常规更新目标，不是当前完整 main 的上线承诺。首次准备耗时独立报告。唯一 demo 更新遵循 `ecs-demo-direct-deploy.md`；不运行或要求正式生产门禁，也不把该 demo 描述为另一套生产环境。`NODE_ENV=production` 仅表示加固后的进程配置，目标身份由 `DEMO_RUNTIME_MODE=true` 标识。

## 1. 一个 owner、一张任务单、一个候选

任务单固定：完整 Git SHA、更新服务列表、各服务现有 Git SHA/镜像 digest、候选 digest、数据库迁移变化、Compose/env 路径与摘要、验证场景、回滚配置。代码继续开发可以留在 main，但本轮始终使用已冻结提交；影响本轮的修复才更换候选并重跑相关检查。当前候选须完成 typecheck、受影响单元/API 测试、桌面浏览器验收和 Demo 容器健康检查；不要调用另一环境的发布门禁。

先执行只读现状检查：

本轮唯一 Demo 的 host inventory 返回 `release_approved=false`，且存在尚无 owner 确认分类的运行容器，因此当前必须 **STOP/NO-GO**，不得归档构建、准备部署或执行部署。后续每轮只有在 inventory 对唯一 Demo 返回 `release_approved=true` 且所有观察到的容器均有 owner 确认的分类后才能继续；任一条件不满足、状态缺失或证据过期都停止，不猜分类、不把未分类容器忽略，也不以独立生产门禁替代该 Demo 条件。

```sh
npm run deploy:101:status
```

该命令固定读取 SSH `101`、`merchant-demo-85575f9c` 和四个公网探针，输出每个运行服务的真实 Git SHA、镜像引用、镜像 ID、Compose 路径及磁盘可用空间。不输出环境变量和密钥，不修改服务器。退出 2 表示应用更新的前置检查有问题，退出 1 表示检查未完成；退出 0 只代表现状检查通过，**不代表目标版本可发布**。8 GiB 是构建前的保守磁盘检查下限，不代表构建空间足够；完整镜像集仍需独立估算。数据库/Redis 的 tag 引用作为提示记录，常规应用更新保留其当前容器和镜像 ID。

以每个镜像标签的 Git SHA 为基线做 `git diff <component-sha> <target-sha> -- <相关目录>`，不要只与公网 release SHA 比较。共享包、依赖锁文件或迁移有变化时，检查所有依赖组件，不能把“只改 API 入口”当作 API 是唯一受影响组件。

| 变化 | 至少检查/构建 | 更新服务 |
| --- | --- | --- |
| 仅运营前端 | merchant-ops-ui | ops-ui，加上 api/api-replica 的发布身份环境刷新（API 镜像不变） |
| 仅商家前端 | merchant-ui | ui，加上 api/api-replica 的发布身份环境刷新（API 镜像不变） |
| API/MCP | merchant-api；共享包变化同时检查 worker | api、api-replica（刷新候选发布身份并更新镜像） |
| worker / 共享业务包 | merchant-worker；共享 API 契约同时检查 API | `merchant-worker` 是单一镜像组件，选择后须检查并更新全部六个 worker：worker-automation、worker-generation、worker-publish、worker-reconcile、worker-scan、worker-sync；候选还要刷新 API 发布身份 |
| 支付 / 网关 | 当前适配器不覆盖 | 停止当前快速更新；不能经此适配器部署 |
| SQL 迁移、数据库引擎或持久化格式 | 迁移专项准备 | 不进入无迁移快速更新 |
| 仅本地插件 | 本地插件包及真实宿主验收 | 无云端变化时不部署 101 |

## 2. 提前完成准备，保留可复用制品

1. 在 main 审阅目标改动，完成类型检查、对应单元/API 测试及本地桌面浏览器验收；保留与冻结 SHA 绑定的结果。
2. 从已提交目标 SHA 使用 `git archive` 生成干净源码快照，校验归档内的提交与 SHA-256，再传到 Demo 的受保护候选目录。不得用包含未提交改动的工作目录构建。
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

多个组件用空格分隔，例如 `merchant-api merchant-worker merchant-ops-ui`。该构建器保持共享构建锁、归档摘要验证、镜像标签校验与不可变 digest。未知或重复组件在调用 Docker 前拒绝。部分构建只输出 `component-images.json`，不输出完整运行清单；本 runbook 只服务唯一 Demo `merchant-demo-85575f9c`，不操作、创建或推断任何独立环境。

4. 在主机受保护目录准备本轮完整 Compose、env 和回滚 Compose。未变组件保留各自实际镜像 digest 与真实提交；新组件采用刚构建的 digest。为完整实际运行集准备 release manifest 和 `/releasez` 输入，不手改版本号冒充镜像更新。配置只在 Demo 主机保存，`docker compose config` 输出可能含密钥，不能回传聊天或提交 Git。
5. 核对运行数据库迁移链与目标代码：版本、名称、checksum 均一致才进入无迁移路径。既有 runbook/metadata 记录的 Demo 基线为迁移 1–270，但 2026-10-10 主机观察未读取 live migration chain，故当前 live 基线仍待 DB owner 提供完整逐行链核实。当前源码候选链尾为 272（见 `release-metadata.json`，source=270、target=272，新增 271 和 272）；源码 metadata 不代表 Demo live chain。本仓库当前没有已批准的唯一 Demo 全量 migration 执行入口或迁移窗口；在确认 live chain 前不能批准无迁移快速更新，任何需要应用 271/272 的候选必须停止本快速更新和 `ecs-demo-direct-deploy` 流程。不得手动运行迁移，也不得把 metadata 数字当作部署批准。只有单独审批并具备受保护迁移执行器、备份与隔离恢复证据、前向迁移及旧版兼容/恢复证据后，才可另行开启迁移窗口。数据库不兼容时，旧镜像不能自动回滚。
6. 必需的候选业务验收和发布证据在切流前准备齐。缺一项就列出具体缺口及修复动作，退出准备阶段，不循环重建无关镜像。

### Demo 商家 UI 混合组件身份适配

`infra/scripts/prepare-ecs-demo-component-update.mjs` 的 `prepareDemoComponentUpdate(input)` 是唯一 Demo 的纯配置适配器，没有宿主 CLI，也不读文件、调用 Docker/SSH、构建或切流。它只支持 `merchant-demo-85575f9c`，组件集合限于 `merchant-api`、`merchant-worker`、`merchant-ops-ui`、`merchant-ui`；本轮可选择其中任意非空子集，所有新镜像都必须绑定同一候选提交。`merchant-api` 与 `api`/`api-replica`、`merchant-worker` 与六个业务 worker 分别是不可拆分的更新单元。适配器不授权部署；本 runbook 不包含其他环境。

输入 `schema_version=demo-component-update-input/1` 包含：

- `compose_project` 与 `candidate={release_id,git_sha,source_sha256}`，来自 owner 校验的冻结归档；此适配器不替代归档提交、摘要校验。
- `baseline` 的原始 `compose_text`、`manifest_text` 字节、四个大写 `RELEASE_*` 字段组成的 `identity`/`public_identity`，以及 DB owner 已核实的 live 完整迁移行 `{version,name,checksum}`。既有归档声称版本 1–270，但本轮 host probe 未读取数据库迁移链，不能把它当作已核实 live baseline。`target_migrations` 必须与核实后的 live 基线逐行一致；源码候选目前包含新增 271 和 272，本适配器不接受新增迁移链，也不执行 DDL。旧 manifest 使用现有 `demo-runtime-service-set/1` 格式，文件 SHA、镜像集与去掉发布四字段的配置 SHA 必须一致。
- `baseline.runtime_services` 为当前实际 15 服务的安全投影。每项严格包含 `container_id,reference,image_id,git_sha,source_sha256,running,health,restarts,oom_killed,compose_service_sha256`；后者是 owner 已对照实际容器配置后封存的该 Compose service 的 canonical JSON SHA。Git/source 来自不可变镜像 OCI 标签，上游镜像无标签时为 `null`。不传完整 inspect、Env、Cmd 或密钥。
- `component_images` 的精确组件键集合与 `imported_components` 的精确镜像 inspect 投影集合必须相同；每项投影包含 `reference,image_id,repo_digests,labels,os,architecture`，并绑定同一不可变引用、候选标签与 `linux/amd64`。只更新 `merchant-ui` 时也兼容旧输入字段 `imported_ui`。不能拿本地 OCI index digest 冒充实际导入后的镜像 config ID。
- 旧 Compose 的 API `DEMO_RUNTIME_MODE` 可缺省或为 `true`；显式设置成其他值会被拒绝。候选始终为 `api` 和 `api-replica` 设置 `DEMO_RUNTIME_MODE=true`，确保本轮更新后唯一 Demo 被健康接口识别为 Demo。原始基线 Compose 和回滚字节保持不变。

输出包含新完整 15 服务 manifest、四个 API `RELEASE_*` 输入、新 Compose、原始回滚 Compose/manifest 字节及旧身份、准备审查摘要。manifest 的候选 SHA 表示本次发布包；`services.*.git_sha/source_sha256/reference/image_id` 表示各组件自己的真实镜像身份。只有所选组件镜像与标签会更新；API、六个 worker、Ops UI、Merchant UI 分别映射到对应服务；API 双实例同时更新发布四字段和 Demo 标记。未选服务的配置、镜像、网络、挂载、healthcheck 与 migrate 声明完全保留。

现有宿主自有 `pilot-gateway` 可使用精确 Docker config ID 引用，但仅当 `reference === image_id` 且值为合法 `sha256:<64hex>`；其他自有服务仍必须使用 `repository@sha256`。旧 manifest 未记录 `source_sha256` 或记录 null 时，owner 仍须从当前容器所绑定的实际镜像 ID 的 `com.storenova.release.source_sha256` 标签采集该字段，同时从同一镜像采集 Git 标签；不得从候选源码、全局发布 SHA 或其他组件推断。pilot/payment 的实际镜像标签均存在合法 source SHA，应填入并输出真实 digest。所有自有镜像（含 pilot）缺少合法 Git/source 标签将被拒绝；旧 manifest 已记录非 null source 时还须逐项相等。上游 Postgres/Redis/ClamAV 无标签时仍允许显式 `null`，并绑定其原 config ID。

迁移行使用数据库/`loadMigrations()` 的逻辑 `Migration.name`，例如 `operation_alert_notifications`，不是 `100_operation_alert_notifications.sql` 文件名；名称限定 `[a-z0-9_]+`，checksum 必须完整 SHA256。既有 270 行基线的 `migrationChecksum` 按既有 Python `sort_keys=True,separators=(',',':'),ensure_ascii=True` 契约序列化后，严格重现已归档摘要 `35ce499eddb68b7a6233f7a86970d2b412ac540d04675b7fc84b79cf36bc38bf`；这是本地源码/既有摘要一致性检查，不能证明 live 数据库当前仍为该版本。当前源码候选链尾为 272，含 271 与 272 新迁移；只有 DB owner 提供的 live 完整链与候选目标逐行一致，才可以评估无迁移组件更新。

API `/releasez` 读取启动环境，不读取 manifest 文件；因此任何组件候选都必须将 `api api-replica` 纳入明确更新/回滚服务，以刷新 API 双副本的发布身份。仅 UI 或 worker 更新时保留 API 镜像不变，只刷新其发布身份环境；API 更新才替换 API 镜像。四组件候选服务列表为 `api api-replica ops-ui ui worker-automation worker-generation worker-publish worker-reconcile worker-scan worker-sync`。不能只重启 UI 或 `docker restart` API。Payment/gateway 不在当前适配器和快速更新 runbook 的可执行范围内；遇到这两类变更应停止当前快速更新。适配器输出始终 `configuration_only=true`、`deploy_authorized=false`，不是切流许可。

owner 将输入输出仅保存在宿主受保护目录，并使用唯一 ECS Compose mutation lock、全新候选目录和不覆盖旧输入的写入策略。在锁内重新确认实际 CID/镜像、配置来源 SHA、挂载/网络、公网四元组、完整迁移链没有漂移，完成 Compose render/no-interpolate 和相同显式服务列表的回滚审查后，才进入 Demo 直接部署步骤。更新后必须实测 15 服务 healthy、未选服务的容器 ID 不变、所有更新镜像的 digest/字节与 API 双实例完整发布四元组准确；另验真实桌面导航及本地 stdio 读链路。配置摘要是 owner 采集证据的绑定，不替代这些实际检查。该模块没有自动收集、写入或执行这些步骤。

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
# 执行前必须从宿主现有受保护部署配置和只读文件元数据证明：此路径是唯一 Demo Compose mutator 共用的既有锁，绝对 canonical、root-owned、regular non-symlink，且所在目录受保护。无法证明时立即停止；不得猜路径、创建锁文件或另开一把锁。
# 在受保护任务证据中记录：SSH host/project；锁路径及其配置来源标识/配置摘要（不记录配置值或秘密）；锁文件的 canonical path、类型、symlink 状态、UID/mode；从锁文件所在目录到根路径的每级目录 canonical path、类型、symlink 状态、UID/mode，并确认无 group/world 写权限；所有可修改此 Demo Compose 的入口名称及各自引用同一锁路径；采集时间和复核人。来源/共享关系/任一级目录权限无法证实时停止。
# /releasez 由 API 启动环境提供，所以任何组件候选都必须刷新 API 双副本的发布身份；非 API 变更时保留 API 镜像不变。
# 这是持久交互 shell 中的命令片段，不是可在短命 SSH 命令或独立脚本中执行完即退出的步骤。
# 保持当前 SSH shell 和 FD9 存活；后续公网/桌面验收以及必要回滚，必须在此 shell 中完成后才退出。
# 若 shell 意外退出，锁已释放；停止后续操作，重新按锁来源和线上基线步骤取得锁并复核后再继续。
set -eu
: "${ECS_DEPLOY_LOCK_PATH:?必须使用宿主现有受保护部署配置中的 Demo Compose mutation lock；来源或共享范围未证实则停止}"
if [ ! -f "$ECS_DEPLOY_LOCK_PATH" ] || [ -L "$ECS_DEPLOY_LOCK_PATH" ]; then
  echo 'Demo deploy lock must be an existing regular non-symlink file; refusing to create or follow another path.' >&2
  exit 1
fi
test "$(realpath -e -- "$ECS_DEPLOY_LOCK_PATH")" = "$ECS_DEPLOY_LOCK_PATH"
test "$(stat -c %u -- "$ECS_DEPLOY_LOCK_PATH")" = 0
exec 9<>"$ECS_DEPLOY_LOCK_PATH"
flock -n 9 || exit 1
docker compose --project-name merchant-demo-85575f9c \
  --env-file "$NEW_ENV" -f "$NEW_COMPOSE" \
  up -d --no-deps --wait --wait-timeout 120 api api-replica ops-ui
```

API 更新必须明确列出 `api api-replica`；worker 更新明确列出六个受影响的业务 worker（若所选组件为 `merchant-worker`，即全部六个）。任何组件变更还要显式包含 API 双副本，以刷新发布身份。不得省略服务名或重建数据库。本 runbook 仅限唯一 Demo，不提供其他环境的发布指引。

`up --wait` 成功后检查公网 release 身份、API `/readyz`、Ops `/healthz`；再用桌面浏览器验证受影响登录/权限/操作。涉及 MCP/模型时由真实本地 stdio 插件完成对应任务并核对 provider request、usage/cost 和账务结果。健康探针不能替代业务验收；付费生成失败不要盲目重放。

无迁移且旧配置兼容时，使用本轮保存的旧 Compose/env 对**相同服务列表**执行同样的 `up --no-deps --wait`，同时恢复配套 manifest/路由，再验旧镜像、公开身份和业务。已经迁移且不兼容时使用事前演练的 Demo 数据恢复方案，不能直接降级镜像或覆盖 Demo 数据。未验证回滚前不应切换。

## 4. 本次实施与证据

已实现：按组件构建；只读 101 状态入口；本操作方案。未实现全自动端到端部署器，不宣称当前 main 已上线或所有正式门禁已通过。

2026-09-27 历史只读快照：当时记录的 release、组件 SHA、13 个容器健康和三个公网探针 HTTP 200 仅代表该日观察，不作为当前 Demo 状态或本轮部署证据；执行更新时必须重新读取。

组件选择和完整清单隔离由 `npm run test:deploy:fast` 验证；构建器测试使用 Docker 替身，不等价于真实镜像构建或切流验收。本轮未切流、未迁移、未修改服务器配置。

历史验证记录：先前某候选的 typecheck、测试、状态脚本和门禁结果不能转用到当前 SHA。当前任务应在候选提交冻结后重新运行风险匹配的检查，并以唯一 Demo 的实际容器、浏览器和业务链路证据判定；status 返回成功不批准发布。
