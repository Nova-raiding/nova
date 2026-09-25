# ECS release 镜像构建

`infra/scripts/build-ecs-release-images.sh` 是仓库内六个业务运行镜像的唯一通用生产入口。开发机可从指定的干净 Git 提交创建归档；ECS 构建机则直接消费经过 staging 校验的 `.candidate-source.tar` 与 `.candidate-identity`，不要求服务器保留 Git 工作区。脚本依次构建 API、worker、商家桌面 UI、运营桌面 UI、支付网关和入口网关，推送到显式配置的镜像仓库，然后输出不可变摘要。

脚本只构建和推送镜像，不渲染 Compose、不启动容器、不切流，也不修改数据库。PostgreSQL 迁移镜像与 ClamAV 镜像仍必须由发布配置提供经过审核的上游固定摘要，不能用本脚本输出的六镜像清单冒充完整发布清单。

候选源码归档不是运行镜像：它为发布门禁保留 `apps/plugin` 和 `.codex-marketplace` 的插件契约测试输入，但排除已跟踪的 `artifacts/` 与 `screenshots/` 历史交付物。API、worker 的最终运行镜像只复制各自编译入口和共享包，不复制本地插件的编译树；商家及平台桌面 UI 镜像也各自从独立前端目录构建。因而不能把裸 `git archive HEAD` 的体积、或服务器上供门禁使用的源码目录，等同于实际生产运行镜像内容。若要求服务器连插件源码都不暂存，须先拆分门禁输入与业务源码身份，并同步改造候选包、镜像标签、发布清单及证据校验，不可单方面排除目录。

每次修改候选归档路径或运行镜像拷贝边界后，运行 `npm run test:ecs-source-archive-contract` 核对生产路径契约；该测试不能替代镜像构建与容器内容检查。

staging 和镜像构建共用 `infra/scripts/ecs-build-lock.sh`，避免不同 release 的 TypeScript 编译与 Docker build 同时耗尽宿主内存。ECS 上须预建 root-owned、0700、canonical 的 `/var/lib/merchant-release-security/locks`；默认锁为其中的 `ecs-source-build.lock`，与生产切换 FD9 锁独立。Linux 使用 FD7/flock，退出释放；无 flock 的本地环境使用 mkdir 锁。已有构建时立即拒绝，不等待、不停止其他进程。异常断电留下的 mkdir 锁必须先核对没有构建进程再由 owner 处理，不自动删除。旧版本脚本或其他会话不会自动遵守此锁，首次启用仍须确认它们已结束。

本地构建显式设置 `ECS_BUILD_LOCK_PATH`，其父目录必须预先存在、归当前用户所有、不可被其他用户写入且使用真实路径（macOS 可先用 `pwd -P` 确认）。复制 staging/build 脚本到宿主控制目录时，须同时复制经审核的共用 helper。此锁降低并发峰值，不代替磁盘预算或保证单个构建一定有足够内存；不自动创建 swap、停止业务容器或删卷。

商家 UI 与运营 UI 安装依赖时使用独立 BuildKit npm 缓存挂载，避免后续候选重复从网络下载。默认 registry 为 `https://registry.npmjs.org/`；构建机访问官方源较慢时，可通过 `ECS_NPM_REGISTRY` 指定 HTTPS npm 镜像，例如 `https://registry.npmmirror.com/`。`release-images.json` 会记录实际使用的 registry。不要在 URL 中放凭据；私有仓库认证须通过受保护的构建凭据配置。npm 仍按锁文件的 integrity 校验包内容。

```sh
ECS_RELEASE_GIT_SHA="$(git rev-parse HEAD)" \
RELEASE_ID="release-$(git rev-parse --short=12 HEAD)" \
ECS_RELEASE_IMAGE_REPOSITORY=registry.internal.example/storenova \
ECS_RELEASE_IMAGE_OUTPUT_DIR="$PWD/artifacts/release-images/release-candidate" \
ECS_BUILD_CACHE_KEEP_STORAGE=2GB \
ECS_NPM_REGISTRY=https://registry.npmjs.org/ \
sh infra/scripts/build-ecs-release-images.sh
```

在 `/srv/merchant-releases/release-...` 的已验证 checkout 中执行时，脚本自动读取 `.candidate-source.tar` 和 `.candidate-identity`；也可用 `ECS_RELEASE_SOURCE_ARCHIVE` 与 `ECS_RELEASE_SOURCE_IDENTITY` 显式指定。两者必须同时提供，且 release ID、完整 Git SHA 与源码 SHA-256 必须完全一致，否则在调用 Docker 前失败关闭。

生产运营后台默认使用 `/api` 和 `/ops/`。如环境契约不同，只允许通过 `ECS_OPS_UI_API_BASE`、`ECS_MERCHANT_UI_API_BASE_URL` 和非敏感的 `ECS_MERCHANT_UI_WORKSPACE_ID` 提供构建参数。不得把密钥、令牌或数据库地址作为 Docker build argument。

输出目录包含：

- `release-images.json`：Git SHA、源码归档摘要、六个镜像摘要和不可变仓库引用。
- `repository-image-digests.json`：仅包含仓库自产的六个摘要，供发布编排与 PostgreSQL、ClamAV 的审核摘要合并。

构建前后脚本都会把 BuildKit 缓存压到 `ECS_BUILD_CACHE_KEEP_STORAGE` 上限；无论成功或失败，临时源码、构建上下文和可变本地标签都会清理。已经推送的不可变摘要是交给发布链的唯一镜像身份。构建失败时不输出清单，发布链必须保持关闭。
