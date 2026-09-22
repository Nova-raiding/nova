# ECS release 镜像构建

`infra/scripts/build-ecs-release-images.sh` 是仓库内六个业务运行镜像的唯一通用生产入口。开发机可从指定的干净 Git 提交创建归档；ECS 构建机则直接消费经过 staging 校验的 `.candidate-source.tar` 与 `.candidate-identity`，不要求服务器保留 Git 工作区。脚本依次构建 API、worker、商家桌面 UI、运营桌面 UI、支付网关和入口网关，推送到显式配置的镜像仓库，然后输出不可变摘要。

脚本只构建和推送镜像，不渲染 Compose、不启动容器、不切流，也不修改数据库。PostgreSQL 迁移镜像与 ClamAV 镜像仍必须由发布配置提供经过审核的上游固定摘要，不能用本脚本输出的六镜像清单冒充完整发布清单。

```sh
ECS_RELEASE_GIT_SHA="$(git rev-parse HEAD)" \
RELEASE_ID="release-$(git rev-parse --short=12 HEAD)" \
ECS_RELEASE_IMAGE_REPOSITORY=registry.internal.example/storenova \
ECS_RELEASE_IMAGE_OUTPUT_DIR="$PWD/artifacts/release-images/release-candidate" \
ECS_BUILD_CACHE_KEEP_STORAGE=2GB \
sh infra/scripts/build-ecs-release-images.sh
```

在 `/srv/merchant-releases/release-...` 的已验证 checkout 中执行时，脚本自动读取 `.candidate-source.tar` 和 `.candidate-identity`；也可用 `ECS_RELEASE_SOURCE_ARCHIVE` 与 `ECS_RELEASE_SOURCE_IDENTITY` 显式指定。两者必须同时提供，且 release ID、完整 Git SHA 与源码 SHA-256 必须完全一致，否则在调用 Docker 前失败关闭。

生产运营后台默认使用 `/api` 和 `/ops/`。如环境契约不同，只允许通过 `ECS_OPS_UI_API_BASE`、`ECS_MERCHANT_UI_API_BASE_URL` 和非敏感的 `ECS_MERCHANT_UI_WORKSPACE_ID` 提供构建参数。不得把密钥、令牌或数据库地址作为 Docker build argument。

输出目录包含：

- `release-images.json`：Git SHA、源码归档摘要、六个镜像摘要和不可变仓库引用。
- `repository-image-digests.json`：仅包含仓库自产的六个摘要，供发布编排与 PostgreSQL、ClamAV 的审核摘要合并。

构建前后脚本都会把 BuildKit 缓存压到 `ECS_BUILD_CACHE_KEEP_STORAGE` 上限；无论成功或失败，临时源码、构建上下文和可变本地标签都会清理。已经推送的不可变摘要是交给发布链的唯一镜像身份。构建失败时不输出清单，发布链必须保持关闭。
