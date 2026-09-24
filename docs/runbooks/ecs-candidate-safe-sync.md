# ECS 候选包安全同步

此流程用于比较本地 OSS、授权和发布证据实现与 ECS 上的版本，生成供人工审查的候选包。它不负责部署，也不应直接覆盖现网目录。当前候选明确关闭告警，并排除 Kubernetes/ACK 配置。

## 发布阶段与完成判据

按以下顺序记录每个阶段。**上传和构建候选源码仅算暂存，不能报告为“已部署”或“服务端验收通过”。**

| 阶段 | 必须看到的运行时证据 | 失败时的处理 |
| --- | --- | --- |
| 候选暂存 | 候选归档、完整 Git SHA、源码摘要及镜像构建记录一致 | 修复暂存或构建；不得声称候选服务已启动 |
| 101 隔离候选部署 | 摘要固定的候选镜像、独立数据库和凭据、受保护 Compose/env、候选容器 ID，以及隔离 TLS `/releasez` 的准确身份 | 保留线上路由不变，修复隔离环境；不得把旧公网响应当作候选证据 |
| 候选服务端验收 | 针对该候选运行时采集真实 API/MCP、模型中转、桌面 ChatGPT 宿主、恢复及其他发布门禁证据，并绑定同一候选身份 | 修复失败项后重采；候选身份变化时，旧证据不得复用 |
| 旧环境恢复与接管 | 旧公网 `/readyz` 健康、当前运行容器受目标 Compose 管理、旧镜像/配置/网络/卷及回滚胶囊可复核；Bridge B 在数据库 242 上通过 | 走独立的故障恢复与 legacy→Compose 接管流程；不能跳过健康、归属或回滚检查 |
| 生产切流 | 受保护部署日志确认迁移、候选容器启动和公网 `/releasez` 与候选身份一致 | 按受保护回滚路径处理；不能将脚本预检通过算作切流 |
| 生产验收 | 公网 `/readyz`、真实业务 canary 和切流后的 ChatGPT 宿主场景证据通过 | 按部署器的失败/回滚结果记录，不得宣称上线 |

隔离候选启动与 ChatGPT 宿主取证见 [候选宿主路由](chatgpt-candidate-host-route.md)。正式部署脚本的完整证据预检发生在生产容器启动**之前**；因此“先部署、后验证”在本项目应指先启动 **101 隔离候选运行时**、在该运行时验证，然后生产切流并再次验收。若旧生产 `/readyz` 为 503，或旧容器没有目标 Compose 归属，先处理旧环境恢复与接管；重复暂存候选或重复执行完整生产预检不会解除这两个阻断。Bridge B 的独立过渡要求见 [Bridge B 手册](ecs-bridge-b-transition.md)。

## 生成候选包

发布不依赖 GitHub CLI、PR 或 GitHub 登录。候选包由本地 owner 生成后，通过 SSH/受控文件同步送到 `101`，再由 ECS 主机上的发布执行器完成 staging、preflight 和切换。

```sh
sh infra/scripts/prepare-ecs-candidate-bundle.sh
```

脚本只接受干净且已提交的工作树。产物包含远端比较文件清单、逐文件本地/远端 SHA-256、提交源码归档 `candidate-source.tar`、归档摘要及 `candidate-identity.txt`。源码归档统一排除 `artifacts/`、`screenshots/` 中的历史交付物和验收产物，保留构建、迁移和测试输入，包括发布测试直接依赖的 `dogfood/` 脚本与退役断言记录；这些排除规则必须同时用于候选包、门禁镜像、业务镜像和部署时的源码摘要校验。此操作不删除仓库或服务器上的任何历史文件。身份文件绑定完整 Git SHA、源码归档 SHA-256、比较清单 SHA-256 和同步计划 SHA-256；其中源码摘要必须与候选门禁镜像的 `com.storenova.candidate.source_sha256` OCI 标签一致。脚本对 SSH 目标仅执行 `cd`、文件存在性判断和 `sha256sum`。

审核完成后，不得把归档覆盖解压到现有 checkout。若 `/srv/release-candidates/stage-verified-ecs-release.sh` 是旧的 standalone copy，先按下面的“staging 工具链安装/升级”步骤用候选归档绑定的 staging+lock pair 更新它；不能直接覆盖旧文件，也不能让旧 helper 在共享构建锁之外继续执行。随后在 ECS 主机预创建仓库外、仅发布操作者可写的 releases 根目录，再执行：

```sh
env -i PATH=/usr/bin:/bin \
  ECS_CANDIDATE_BUNDLE_DIR=/srv/release-candidates/<candidate> \
  ECS_RELEASES_ROOT=/srv/merchant-releases \
  RELEASE_ID=<release-id> \
  /srv/release-candidates/stage-verified-ecs-release.sh
```

该 staging 入口依赖同目录的 `infra/scripts/ecs-build-lock.sh`。从候选 checkout 运行时，两者必须来自同一个已审查的候选归档；standalone control path 使用下面的 candidate-bound installer 成对安装。缺少 helper 或 helper 是符号链接时，入口会 fail-closed；不得让它回退到可变仓库路径。

### Staging 工具链安装/升级

Standalone staging helper 曾独立复制到 `/srv/release-candidates`，不一定与候选源码同步。安装器 `infra/scripts/install-ecs-staging-toolchain.mjs` 从完整 `candidate-source.tar` 中提取 `stage-verified-ecs-release.sh` 和 `ecs-build-lock.sh`，验证四字段 `candidate-identity.txt`、归档 SHA-256、Git archive 内嵌提交 SHA、tar 路径/成员类型及两份脚本语法。它不接受人工填写的脚本摘要，也不执行生产切换。两份脚本进入同一个只读 generation；稳定 dispatcher 的 `current` symlink 原子切换整对文件。更新会先保存上一个已验证 generation 到 `previous`，`rollback` 在共享构建锁内原子恢复该 pair。旧 standalone 文件只以 root-only 字节备份保留用于审计；它不是安全回滚目标。首次 bootstrap 没有已验证的旧 pair 可回退，若在 dispatcher 安装后、current 指针激活前中断，入口会 fail closed；重新运行同一安装命令即可完成激活。

安装器本身是 bootstrap trust root，不能从未校验的候选执行。owner 在已审查的干净候选提交上，从归档提取安装器并独立核对它与该提交 blob 完全相同：

```sh
candidate_sha=$(sed -n 's/^git_sha=//p' "$BUNDLE/candidate-identity.txt")
tmpdir=$(mktemp -d)
tar -xOf "$BUNDLE/candidate-source.tar" infra/scripts/install-ecs-staging-toolchain.mjs > "$tmpdir/from-archive.mjs"
git show "$candidate_sha:infra/scripts/install-ecs-staging-toolchain.mjs" > "$tmpdir/from-commit.mjs"
cmp "$tmpdir/from-archive.mjs" "$tmpdir/from-commit.mjs"
shasum -a 256 "$tmpdir/from-archive.mjs"
```

只有 `cmp` 成功且摘要记录进候选审查后，才把该 bootstrap 文件放入同一候选目录下一个以其 SHA 命名的新文件；不得覆盖其他候选或历史安装器。候选 bundle、身份文件、归档和 bootstrap 均须 root-owned、0600、父目录 canonical 且不可由 group/other 写入。执行前先人工确认没有正在运行的旧版 staging `npm ci`/build 或 ECS image build；旧 helper 不遵守新共享锁，锁文件本身不能证明旧进程已退出。

`/srv/release-candidates` 必须是 root-owned 0700；`/var/lib/merchant-release-security/locks` 必须是 root-owned 0700，`ecs-source-build.lock` 是 root-owned 0600 普通文件。安装器只使用固定 Node `/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node`，清空继承环境并固定 `PATH=/usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin:/usr/bin:/bin`。它逐项确认固定 Node、`/usr/lib/node_modules/npm/bin/npm-cli.js`、git、python3、shasum、tar 和 flock 的真实目标均 root-owned 且不可由 group/other 写入，并直接用固定 Node 执行 npm CLI 的 `--version` 探针；不执行 `/usr/bin/npm`（其 shebang 使用 Node 20），也不使用 `/usr/local/bin` 中由 uid 1001 所有的 node/npm 链接。

将经过上述摘要核对的 bootstrap 和候选 bundle 放入 `/srv/release-candidates/<candidate>` 后，管理员运行：

```sh
env -i PATH=/usr/bin:/bin \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /srv/release-candidates/<candidate>/install-ecs-staging-toolchain.<installer-sha256>.mjs \
  install /srv/release-candidates/<candidate>/candidate-source.tar \
  /srv/release-candidates/<candidate>/candidate-identity.txt \
  /srv/release-candidates \
  <installer-sha256>
```

成功回执绑定 Git SHA、候选归档 SHA、staging helper SHA 与 build-lock helper SHA。若共享锁正被 staging/build 持有，安装会立即拒绝。安装后只允许通过固定入口运行 staging；入口只保留 `ECS_CANDIDATE_BUNDLE_DIR`、`ECS_RELEASES_ROOT`、`RELEASE_ID` 三个非 secret 输入，并清除 `NODE_OPTIONS`/`NODE_PATH`，随后由 generation helper 在同一把构建锁下执行。

更新到新候选后，如 staging 行为需回退，使用新候选目录中另一个已核验的 bootstrap 对 `/srv/release-candidates` 执行 `rollback`：

```sh
env -i PATH=/usr/bin:/bin \
  /usr/local/libexec/merchant/runtime/node-v22.23.2-linux-x64/bin/node \
  /srv/release-candidates/<candidate>/install-ecs-staging-toolchain.<installer-sha256>.mjs \
  rollback /srv/release-candidates <installer-sha256>
```

首次 bootstrap 不会恢复不安全的旧 standalone helper；若没有上一个已验证 generation，回滚会拒绝。该工具链切换只更新仓库外 staging 控制文件，不安装 release、不构建/推送镜像、不启动容器、不迁移数据库、不切换线上流量。安装后仍须完成候选三方审阅、全部生产发布门禁和后续独立部署审批。

staging 执行器会重新校验身份文件中源码归档、比较清单和同步计划的 SHA-256，并核对 Git archive 内嵌提交 SHA；含路径穿越、链接或特殊文件的归档会被拒绝。顶层 `npm ci`、嵌套 `npm` 命令和 `npm run` 都经受保护 Node 22 与受保护 npm CLI 运行；脚本 shell 将私有 npm shim 和受保护 Node 放在 PATH 前面，因此 `tsc` 的 `env node` shebang 也使用 Node 22。它以 `npm ci --ignore-scripts` 从锁文件安装，保留只读的 `.candidate-source.tar` 和 `.candidate-identity` 供部署器重新核验，最后原子改名为全新的 release 目录。目标已存在时拒绝覆盖。生产 `.env`、密钥和运行时凭据不得进入候选包或 release checkout，仍由受保护的主机路径在渲染和部署阶段注入。

## 一键部署与磁盘上限

### 运营后台认证必须前后端一致

运营台镜像构建模式必须与受保护 API 配置中的 `OPS_AUTH_MODE` 完全一致。镜像构建会将 `password` 或 `oidc` 写入摘要固定的 Ops UI 镜像标签；ECS preflight 会读取候选 `OPS_UI_IMAGE_REF` 标签并与 API 模式比较，标签缺失、未知、镜像未固定摘要或模式不一致都会阻断发布。`password` 模式不得配置 SSO 登录 URL；`oidc` 模式要求 HTTPS 登录 URL及 API OIDC 签名密钥。UI/API 身份验证仍由服务端持久配置执行，不使用静态 token 冒充登录。

只有另行配置了真实 OIDC 网关的部署才选择 `oidc`：构建必须提供 `ECS_OPS_UI_LOGIN_URL`，API 必须提供对应签名 secret。签名 secret 本身不等于存在登录网关；不得把未实现的 `/auth/login` 猜作入口。上线验收需从匿名登录页完成真实登录，再验证平台角色、会话和退出，不能用健康端点代替。

一键流程在隐式 staging 前只调用固定 `/srv/release-candidates/stage-verified-ecs-release.sh` dispatcher，并检查 `/srv/release-candidates/staging-toolchain/current` 的 generation Git SHA、归档 SHA 和两份脚本 SHA 必须与当前候选身份完全匹配；它不会调用 checkout 内的 staging 脚本。不匹配时先按上面的流程从该候选归档安装对应 pair。生产镜像、rendered Compose、回滚 capsule 和真实证据准备完毕后，在 ECS 宿主执行一条命令完成安全 staging、受验证切换、健康验收和成功后的空间回收：

```sh
ECS_CANDIDATE_BUNDLE_DIR=/srv/release-candidates/<candidate> \
ECS_RELEASES_ROOT=/srv/merchant-releases \
RELEASE_ID=<release-id> \
RENDERED_COMPOSE_PATH=/受保护路径/rendered-compose.json \
PRODUCTION_CONFIG_PATH=/etc/merchant/production.yml \
PRODUCTION_API_BASE_URL=https://yxsona.com/api \
sh infra/scripts/ecs-one-click-deploy.sh deploy
```

其余鉴权、数据库、证据、镜像摘要和回滚变量沿用 `deploy-verified-ecs-compose.sh` 的受保护宿主配置。自动化不降低任何发布门禁：只有部署器完整成功后才执行回收；失败候选保留用于诊断。默认保留最近 2 个完整 release 和最近 2 个经身份文件验证的 `/srv/release-candidates` 候选包，并自动保护线上 `/releasez` 返回的当前版本、回滚计划的目标版本、当前候选、含 `.keep` 标记的目录以及 `ECS_PROTECTED_RELEASE_IDS` 指定的版本。候选包用 `candidate-identity.txt` 的完整 Git SHA 与受保护 release/容器关联；未知目录保持不动。release 清理只接受 `.candidate-identity` 与目录名一致的目录。两类清理都拒绝符号链接，不触碰 Docker volume、数据库、对象存储和运行容器引用的镜像。

本机 Registry 必须单独治理。当前自动清理不会运行 `docker image prune`，也不会调用 Registry garbage collection，因为只按磁盘年龄删除 blob 会破坏摘要固定的线上或回滚镜像。先从现网容器、回滚计划与保留 release 的镜像清单生成受保护 digest 集，再通过启用 delete 的 Registry API 删除未保护 manifest，最后在停止写入的维护窗口运行 Registry GC；缺少完整 digest 集时只报告占用，不删除。

部署前可只读查看回收计划：

```sh
PRODUCTION_API_BASE_URL=https://yxsona.com/api \
ECS_RELEASES_ROOT=/srv/merchant-releases \
sh infra/scripts/ecs-one-click-deploy.sh report
```

单独执行清理时必须显式确认；脚本同时把 BuildKit 缓存限制为默认 2GB，但不自动删除任何镜像，避免误删离线回滚仍需的不可变镜像：

```sh
CONFIRM_ECS_STORAGE_CLEANUP=YES \
PRODUCTION_API_BASE_URL=https://yxsona.com/api \
ECS_RELEASES_ROOT=/srv/merchant-releases \
sh infra/scripts/ecs-one-click-deploy.sh cleanup
```

可用 `ECS_RELEASE_KEEP_COUNT`、`ECS_BUILD_CACHE_KEEP_STORAGE` 和 `ECS_BUILD_CACHE_UNTIL` 调整保留策略。推荐值为 `2`、`2GB`、`24h`。这些参数只约束可回收 checkout、候选包和构建缓存，不代表整机磁盘上限：受保护版本、Registry 镜像、数据库、备份和业务素材仍需单独计量和保留策略，不能据此承诺磁盘不再增长。

## 合并原则

生产渲染必须显式设置 `ECS_PRODUCTION_ENV_FILE`，指向仓库外的 canonical、root-owned、`0600` 普通文件；父目录链不得允许其他用户写入。渲染出的 Compose 也含解析后的凭据，必须以 `umask 077` 保存到受保护路径，不打印、不上传、不提交。下面提及的 `.env.example` 仅是变量名模板；默认 `.env` 读取只用于本地测试，不是生产 secret 的存放位置。

当 `secret_provider=ecs-protected-env` 时，配置中 `*_ref` 使用 `ecs-protected-env:VARIABLE_NAME` 标识该发布受保护 env 中的具体键。它是本机配置绑定标识，不是 Vault URI，也不会发起任何远程取密请求。准备配置时必须先确认对应键确实存在且非空，并记录 env 文件的 canonical 路径、SHA-256 和引用键名清单；不能只填写引用来掩盖缺失凭据。生产 Compose 从同一个受保护 env 文件读取实际值，冻结后的 rendered Compose SHA 继续纳入发布身份。原始值与 env 文件不能进入仓库、候选源码包或诊断输出。

- `review_required`：必须基于服务器文件进行三方合并，禁止整文件覆盖。
- `missing_remote`：确认是当前候选版本的新增文件后，才可放入隔离发布目录。
- `.env`、密钥、OAuth/支付凭据、告警 Webhook 密钥及签名私钥不得进入候选包。
- `docker-compose.ecs-pilot.yml` 在服务器上可能保留六平台连接器、Vault 和生产安全配置；本地版本不能直接替换它。
- 最终层顺序只由 `infra/local/ecs-production-compose.layers` 定义：基础 Compose → ECS pilot → production API private → OSS cutover → 生产迁移 → HTTPS gateway → release identity。production API private 层清空 `api` 的宿主端口发布；gateway 和 payment-gateway 通过同项目服务名访问 API，因此不需要宿主映射，也不会与本机服务争用端口。HTTPS 层发布宿主 80/443 到容器 8080/8443，并只读挂载受保护证书目录；网关使用同项目服务别名解析 upstream。禁止加入开发用途的 `deploy/runtime/auth-hardening.yml`；最终渲染必须通过 `validate-ecs-production-compose.mjs` 的服务器生产安全校验。OSS overlay 仅包含 `api`、`api-replica` 的存储、生命周期和配额字段，不修改六平台、Vault、支付、证据或告警配置；当前候选不启用 `--profile alerts`。
- 生产证据不得从开发机复制充数，必须绑定最终 release ID、Git SHA、镜像摘要、配置摘要和 deployment nonce，并由服务器信任边界签名。

## 切换前门禁

ECS preflight 会以只读查询分别使用目标 `DATABASE_URL` 和 `OPS_DATABASE_URL` 核对 `schema_migrations`。迁移前允许数据库处于当前候选迁移链的任一不可变前缀：已应用版本必须从 1 连续、名称和 SQL SHA-256 与候选源码一致、不得出现候选之外的超前版本，且两个运行角色必须看到逐行完全相同的历史。随后才执行租户、Ops 的非 superuser／非 BYPASSRLS、表所有权、ACL 和动态 RLS 边界探针。任一凭据连接失败、历史缺口、角色视图差异、未知或超前版本、名称或 checksum 漂移都会阻断发布；不得通过修改生产迁移记录绕过门禁。

部署执行器消费 nonce 后使用固定摘要的 PostgreSQL 17 迁移镜像执行前向迁移；迁移命令成功并不足以切流。执行器必须再次通过 `DATABASE_URL` 和 `OPS_DATABASE_URL` 运行完整链校验，确认两个运行角色都精确包含 1 到 `EXPECTED_MIGRATION_VERSION` 的候选链，才允许重建 API、Worker、UI 或网关容器。完整链校验失败会在业务容器切换前中止并进入受保护回退流程；数据库仍遵循 forward-only 策略，不执行 schema downgrade。

### 242→245 过渡发布阻断条件

当前线上旧 API/Worker 的迁移链止于 242。不能让它们继续承载流量时直接把共享库迁到 245：旧镜像既无法通过完整链校验，也不是合法的 245 回滚目标。候选 C 的普通 `deploy-verified-ecs-compose.sh` 现在会在消费 nonce 前要求回滚 capsule 的目标镜像迁移链精确覆盖 C 的 `EXPECTED_MIGRATION_VERSION`，并为从计划中的实时版本到目标版本的每个中间前缀提供受审查摘要；若要升级数据库，还要求公网 `/releasez` 已经显示回滚桥 B 的完整身份。预部署签名观测中的数据库版本也必须与计划值相同。任一条件失败均为 NO-GO，不得编辑计划版本或迁移记录以绕过。

正确的发布顺序是：在隔离的 PG17 恢复库验证旧业务代码加 243/244/245 迁移元数据的桥 B 能分别运行于 242 和 245；在生产库仍为 242 时，用独立受保护的“只切代码、不运行迁移”步骤安装 B 并验明公网身份；再以 B@245 的镜像、完整迁移前缀摘要和受保护回滚 capsule 发布 C，迁移 242→245 后才切 C。桥 B 的安装、独立阶段日志和故障恢复执行器尚未完成真实运行验收，因此本说明不是批准对 101 执行过渡发布。未具备这三项时保持现网，不得把普通一键部署当作桥 B 的第一阶段。

1. 在独立目录解包并完成三方合并。
2. 对合并结果运行类型检查、OSS/证据/生产配置测试及 `pilot-compose-preflight.sh`。
   合并后的 Compose 必须通过清单驱动的唯一渲染入口生成；不得手写或重排 `-f` 参数：

   ```sh
   umask 077
   ECS_COMPOSE_PROJECT=merchant-production \
   ECS_PRODUCTION_ENV_FILE=/var/lib/merchant-release-security/config/production.env \
     sh infra/scripts/render-ecs-production-compose.sh \
     > /var/lib/merchant-release-security/config/rendered-compose.json
   node infra/scripts/validate-ecs-production-compose.mjs \
     /var/lib/merchant-release-security/config/rendered-compose.json
   ```

   `ECS_COMPOSE_PROJECT` is frozen into rendered network and volume names. It must exactly match the project passed to deploy/rollback; candidate sidecars must use a distinct reviewed project. The renderer rejects unsafe names rather than inheriting a project name from the checkout or ambient `.env`.

   渲染前必须先备齐 release 层的八个固定镜像引用。`infra/local/docker-compose.ecs-pilot-release.yml` 以 `${VAR:?}` 强校验 `MIGRATION_IMAGE_REF`、`API_IMAGE_REF`、`WORKER_IMAGE_REF`、`UI_IMAGE_REF`、`OPS_UI_IMAGE_REF`、`PAYMENT_GATEWAY_IMAGE_REF`、`PILOT_GATEWAY_IMAGE_REF`、`CLAMAV_IMAGE_REF`；生产渲染器用 `--env-file "$ECS_PRODUCTION_ENV_FILE"` 读取受保护配置，缺任一项都会非零退出，而 Compose 最多报告 91 条插值错误，base 层的错误会掩盖 release 层自己的那条。这八个变量的生产者是 `infra/scripts/deploy-preflight-ecs.sh` 的必需清单与 `.env.example` 模板，两者缺一不可。同一条规则覆盖全部五个层（`infra/local/ecs-production-compose.layers`）：任一层里被 `${VAR:?}` 强校验的变量都必须同时出现在这两处，否则 `render-ecs-production-compose.sh` 会在 base 层就非零退出。闭环由 `tests/ecs-compose-release-gate.test.ts` 静态保证（digest 清单要求的每个服务都必须被固定，全部五个层的每个 `${VAR:?}` 变量都必须有这两处生产者），并由 `tests/release-env-closure.invariant.test.ts` 用真实 `docker compose config` 渲染整条链来验证。

   其中六个仓库自产镜像由 `infra/scripts/build-ecs-release-images.sh` 从同一受保护候选源码构建并输出固定摘要；`MIGRATION_IMAGE_REF` 与 `CLAMAV_IMAGE_REF` 仍必须由发布配置提供经过审核的上游固定摘要。运维需要把八个 `repository@sha256:<digest>` 合并进 `IMAGE_DIGESTS_JSON`（`validate-ecs-compose-release.rb` 会要求它们与 release 层引用逐字节一致）。缺任何一项时发布链在渲染阶段中止，没有“先用宿主手工构建的镜像顶一下”的降级路径；部署与回滚都使用 `up -d --no-build`。
3. 以旁路容器验证 `/healthz`、`/readyz`、RAM Role 临时凭证、OSS 写读删和持久管理员授权。先在候选 API 容器的同一环境内执行 `node infra/scripts/verify-oss-access.mjs`，只读取 `merchant-assets` 前缀中的至多一个对象；ECS 模式只接受 `ASSET_STORAGE_CREDENTIAL_PROVIDER=aliyun_ecs_ram_role` 和实例角色，拒绝静态 AccessKey。不要打印容器环境或凭据。然后按 `OBJECT_STORAGE_CANARY_CONFIRM=true` 的正式对象存储 canary 流程写入随机探针、核对精确 VersionId、读取 SHA-256 与加密状态、按该 VersionId 删除；权限缺失或清理失败均阻断切换。对旁路 API 的 `/healthz` 运行 `curl -fsS "$CANDIDATE_API_BASE_URL/healthz" | node infra/scripts/verify-ecs-oss-runtime.mjs`；即使容器健康，fixture、本地存储或禁写状态也必须拒绝切换。当前候选不启动或验收告警投递。

   六平台人工运营证据须在这台旁路 API 上采集。旁路实例使用候选固定摘要 API 镜像、同一份受保护生产环境及实际生产数据库，不发布宿主端口，不启用 fixture。先只读核对容器的完整 Docker ID 和固定摘要镜像引用。运行 `capture-manual-operations-evidence.sh` 时设置 `MANUAL_OPERATIONS_CANDIDATE_CONTAINER_ID`（64 位完整 ID）与 `MANUAL_OPERATIONS_CANDIDATE_API_IMAGE_REF`（与审核通过的 `API_IMAGE_REF` 逐字节相同），并分别提供 `MANUAL_OPERATIONS_EXPECTED_RELEASE_GIT_SHA`、`MANUAL_OPERATIONS_EXPECTED_MANIFEST_SHA256`、`MANUAL_OPERATIONS_EXPECTED_IMAGE_SET_DIGEST`、`RELEASE_ID`、已验证的只读 canary Bearer 凭据与目标/隔离 workspace、真实人工发布报告 ID、`MANUAL_OPERATIONS_EVIDENCE_OUTPUT` 和 `MANUAL_OPERATIONS_VERIFIED_BY`。脚本固定使用宿主 `/var/run/docker.sock`，逐次核对精确容器 ID、运行状态和镜像 ID，再通过 `docker exec` 在该容器内连接 `127.0.0.1:8787`。它在发送 Bearer 凭据前核对 `/releasez` 的完整候选身份，随后读取报告及跨租户拒绝响应，独占写入 unsigned 0600 JSON。旧的 `MANUAL_OPERATIONS_CANDIDATE_API_BASE_URL` 模式已拒绝使用，因为宿主端口可能被其他进程抢占。候选证据必须随后经受保护签名器绑定镜像集、manifest、Git SHA 和部署 nonce；签名文件与原始采集文件分开保存。公网 `/releasez` 在切流前仍属于旧版本，不能作为候选证据来源。旁路容器停止后，仍需按正式部署器完成切流后 `/releasez` 和业务 canary 验证。若旁路实例因发布证据挂载而无法启动，记录阻断，不得用旧实例响应或手填 JSON 代替。
4. 保存现网 Compose、镜像摘要、配置摘要、对象存储模式和本地卷挂载作为回滚点。回滚只恢复原 Compose 与镜像并验证 API 健康；本地对象卷和 OSS 版本都保留，不做删除或清空。切换后的新对象写入必须记录并在回滚前核对，不能假定回滚到本地模式会自动显示这些对象。
5. 只有上述证据全部属于同一候选版本时，才能安排切换。

## ECS Compose 回滚

### 已有独立公网网关的首次接管

如果 80/443 由目标 Compose project 外的旧网关占用，部署器默认拒绝继续。先只读核验容器完整 ID、镜像、端口、只读证书挂载及网络，再在受保护发布配置中明确设置 `ECS_EXTERNAL_GATEWAY_ID` 和 `ECS_EXTERNAL_GATEWAY_PROJECT`。只有确认旧容器确实没有任何 Compose project/service 标签时，后者才设置为 `legacy-unmanaged`；这不是允许忽略已有标签的开关。

部署器还会在 nonce/迁移前检查候选 Compose 的所有固定宿主端口，与 `docker ps` 中其他项目的绑定及宿主 `ss` 监听交叉核对，并在 runtime cutover 前复查。只有本次明确替换的同项目服务，以及已通过快照身份核验的外部网关 80/443 绑定会被视为可释放端口。其他本机容器或进程占用（例如 `127.0.0.1:8787`）会在数据库迁移和切流前 fail-closed；不得通过停止不属于发布项目的容器来绕过。

部署器在同一生产锁内保存 root-only 快照，记录配置与证书内容摘要而非原始凭据。迁移完成后才停止这个精确旧容器，再启动候选服务。旧容器不删除、不重建。启动失败时，仅在候选网关的 project/service/release/image 身份全部一致后停止候选网关，然后核对快照并启动原旧容器。

快照还要求旧网关已经连接候选 API 与网关共享的 production network；不能只依据旧网关曾经通过 demo network 访问旧 API 就认为回退可达。按 Compose 重建 API 会丢失手工添加的旧网络 attachment。缺少共同网络时部署在 nonce 消费和停机之前阻断，先审查并准备可恢复的过渡网络拓扑，再重新捕获快照。

恢复旧公网监听不等于恢复旧业务版本。API/worker 仍走原有 signed rollback 和 release identity 核验；失败会明确保留现场，不绕过身份门禁。此接管模式的回滚 Compose 不得发布宿主 80/443，以免与恢复的旧监听争用端口。必须按真实旧拓扑准备回滚输入，不能为了通过检查删改一个本应发布这些端口的回滚定义。接管前还需验证候选 nginx 配置、证书、upstream 与内部 HTTPS healthcheck；快照成功不能替代这些验证。

现网只有 ECS/Docker Compose 环境时使用 `infra/scripts/rollback-ecs-compose.sh`，不要使用 Kubernetes `rollback.sh`。回滚输入必须是发布前保存并审核的单一渲染 Compose、其完整镜像摘要 JSON 和回滚计划。计划格式如下；四个身份字段必须来自切换前 `/releasez` 和目标发布的 ECS release gate，不能现场猜测或改写：

```json
{
  "schema_version": "1",
  "kind": "ecs-compose-rollback-capsule",
  "created_at": "2026-09-16T04:00:00.000Z",
  "expires_at": "2026-09-17T04:00:00.000Z",
  "compose_project": "merchant-production",
  "current": { "release_id": "current", "git_sha": "40位SHA", "manifest_sha256": "64位SHA", "image_set_digest": "sha256:64位SHA" },
  "target": { "release_id": "previous", "git_sha": "40位SHA", "manifest_sha256": "64位SHA", "image_set_digest": "sha256:64位SHA", "compose_sha256": "64位SHA", "env_sha256": "64位SHA", "image_digests_sha256": "64位SHA" },
  "database": { "strategy": "forward_only", "live_migration_version": 214, "target_migration_tail": 214, "schema_downgrade": false },
  "volumes": { "preserve": true }
}
```

先设置 `ECS_ROLLBACK_PLAN_PATH`、`ECS_ROLLBACK_COMPOSE_PATH`、`ECS_ROLLBACK_ENV_FILE`、`ECS_ROLLBACK_IMAGE_DIGESTS_JSON`、`ECS_ROLLBACK_STATE_PATH`、`ECS_DEPLOY_LOCK_PATH`、`PRODUCTION_API_BASE_URL` 和只读检查所用的 `DATABASE_URL`，最后显式设置 `CONFIRM_ECS_ROLLBACK=YES` 执行。rollback capsule 最长有效 24 小时，并同时绑定旧 release、Compose、环境文件、镜像摘要 JSON、固定 Compose project 和执行前/目标 release 身份。部署执行器自动回退时必须保存并传递这些冻结输入，不能从当前可变工作目录重新生成。部署与回滚共同使用 repo 外 canonical `ECS_DEPLOY_LOCK_PATH` 和 `ECS_COMPOSE_PROJECT`（默认 `merchant-production`），避免两个进程同时修改唯一生产环境。脚本在启动目标服务前完成以下核对：目标 Compose SHA-256、目标镜像和发布身份、当前线上身份没有发生并发变化、实时数据库版本仍等于审核计划、目标镜像包含实时数据库的完整迁移链。数据库只允许前向兼容，不执行 schema downgrade；回滚的 `compose up` 不重新运行 migrate。

脚本不会执行 `docker compose down/rm`、`--volumes` 或删除数据库数据。`ECS_ROLLBACK_HEALTH_TIMEOUT_SECONDS` 只接受 30 到 900 秒的整数。健康检查超时会在 `ECS_ROLLBACK_STATE_PATH` 原子写入 `health_failed` 和 `requires_manual_recovery: true`；此时保留容器、卷和数据库现场，按状态文件及 Docker 日志人工恢复，不得通过清空卷重试。状态路径必须位于 repo 外、由执行用户拥有且组/其他用户不可写的 canonical 目录中，并使用新的安全 `.json` 文件名。
