# ECS 候选源码门禁容器

受控构建环境使用 `infra/docker/candidate-gates.Dockerfile` 和 `infra/scripts/build-ecs-candidate-gates-image.sh`。运行 `ECS_CANDIDATE_GIT_SHA=<完整提交SHA> sh infra/scripts/build-ecs-candidate-gates-image.sh`。构建器要求干净的已提交源码，核对 revision 和源码摘要标签。镜像仅保存在受控构建机，通过加密归档同步到 ECS，不依赖付费镜像仓库。

候选运行器还要求 `ECS_CANDIDATE_SOURCE_SHA256=sha256:<64 hex>` 与构建输出一致，并可选校验本地 image ID。它验证完整 Git SHA、本地镜像 ID和源码摘要标签后才启动无网络测试容器。

ECS 宿主目前只有 Docker。构建并审查候选门禁镜像，标签 `org.opencontainers.image.revision` 必须是完整 Git SHA。镜像通过加密归档同步并以本地 image ID 固定；不能使用 `latest` 或运行时拉取依赖。

在 ECS 候选上设置 `ECS_CANDIDATE_GATE_IMAGE=<本地镜像标签>`、`ECS_CANDIDATE_GATE_IMAGE_ID=sha256:<64 hex>` 和 `ECS_CANDIDATE_GIT_SHA=<40 hex>`，运行 `sh infra/scripts/run-ecs-candidate-gates-container.sh`。脚本校验本地镜像 revision 和 image ID，然后在无网络、无额外权限、非 root 用户及无宿主挂载的容器中执行门禁。

staged release checkout 是 Git archive 的展开目录，预期没有 `.git`；不要为测试而在 101 初始化 Git 仓库，也不要直接在宿主机运行其中的 `node_modules`。身份以只读的 `.candidate-identity` 和 `.candidate-source.tar` 为准。测试 checkout 前核对：

```sh
CANDIDATE=/srv/merchant-releases/<release-id>
test -d "$CANDIDATE" && test ! -L "$CANDIDATE"
test ! -e "$CANDIDATE/.git"
git_sha=$(sed -n 's/^git_sha=//p' "$CANDIDATE/.candidate-identity")
source_sha=$(sed -n 's/^source_sha256=//p' "$CANDIDATE/.candidate-identity")
archive_sha="sha256:$(sha256sum "$CANDIDATE/.candidate-source.tar" | awk '{print $1}')"
printf '%s' "$git_sha" | grep -Eq '^[0-9a-f]{40}$'
[ "$source_sha" = "$archive_sha" ]
```

完整类型检查和 release-gate 测试应通过上面的候选门禁镜像运行器执行：镜像 revision、源码摘要及本地 image ID 均须绑定到同一个候选。没有 `.git` 不构成阻断；候选归档摘要是源码身份的校验依据。

### 宿主原生模块不兼容时的只读定向测试

如果在 101 宿主机直接运行测试遇到 `argon2`/glibc 加载错误，不要重装或重编译宿主 `node_modules`，也不要把失败忽略。针对不加载 `argon2` 的单个测试，可使用本地固定的 Alpine API image 提供 Node/musl runtime，将 staged checkout 只读挂载；该镜像的 Node 版本和 image ID 必须先核验。示例 image 是本次记录的 `storenova-api:qa-merchant-ec3d69e3`，image ID `sha256:c2f6636062b067489b4db18edd11df834f4bf3cecd6e48b0464d2c01fe687a79`，Node `v22.23.2`。image ID 不匹配时停止，不拉取或替换镜像。

先比对镜像 ID 与候选源码身份，再执行一个已确认不导入原生 `argon2` 的定向测试。下面示例对应 101 上候选 `ecs-00154548` 的 `apps/api/src/scanner-health.test.ts`；容器通过显式 `node` 入口运行候选 checkout 中的 `tsx`/测试代码，而不是启动镜像内旧版 API 服务。`/app` 是只读 bind mount，唯一明确可写的项目缓存位置是 tmpfs；容器网络为 `none`，不挂 Docker socket、数据库凭据或生产配置。

```sh
CANDIDATE=/srv/merchant-releases/<release-id>
API_IMAGE=storenova-api:qa-merchant-ec3d69e3
EXPECTED_API_IMAGE_ID=sha256:c2f6636062b067489b4db18edd11df834f4bf3cecd6e48b0464d2c01fe687a79
actual_image_id=$(docker image inspect --format '{{.Id}}' "$API_IMAGE")
[ "$actual_image_id" = "$EXPECTED_API_IMAGE_ID" ] || { echo 'API test image identity mismatch' >&2; exit 1; }
docker run --rm --pull=never --network none --user 0:0 \
  --entrypoint node \
  --tmpfs /app/node_modules/.vite-temp:rw,nosuid,nodev,size=64m \
  --mount "type=bind,src=$CANDIDATE,dst=/app,readonly" \
  --workdir /app "$API_IMAGE" \
  --import tsx scripts/run-safe-tests.ts apps/api/src/scanner-health.test.ts
```

The candidate path must be the canonical, root-owned staged release with its verified identity and archive hash; root inside this disposable container is used only so it can read the root-only checkout. The mount remains read-only. This test is deliberately narrow: a test that imports host-built native addons can still fail on ABI mismatch. Run such tests in the exact candidate-gates Alpine image whose dependencies were installed during image build, or mark them blocked; do not infer they passed from the scanner-health result. The recorded run for the example test reported 9/9 passed.

此门禁只证明候选代码测试结果。`launch-preflight.sh` 和 `deploy-preflight-ecs.sh` 还需要 Docker API、生产数据库只读验证、固定受保护信任目录、真实证据及 nonce 消费者。不能把 `/var/run/docker.sock` 挂入候选门禁容器；该 socket 等同宿主 root 权限。需要单独审查完整生产预检的执行边界，完成后才运行实际 ECS 发布门禁。此脚本不生成生产 GO，也不启动或切换业务容器。
