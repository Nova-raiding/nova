# ECS 候选源码门禁容器

受控构建环境使用 `infra/docker/candidate-gates.Dockerfile` 和 `infra/scripts/build-ecs-candidate-gates-image.sh`。运行 `ECS_CANDIDATE_GIT_SHA=<完整提交SHA> sh infra/scripts/build-ecs-candidate-gates-image.sh`。构建器要求干净的已提交源码，核对 revision 和源码摘要标签。镜像仅保存在受控构建机，通过加密归档同步到 ECS，不依赖付费镜像仓库。

候选运行器还要求 `ECS_CANDIDATE_SOURCE_SHA256=sha256:<64 hex>` 与构建输出一致，并可选校验本地 image ID。它验证完整 Git SHA、本地镜像 ID和源码摘要标签后才启动无网络测试容器。

ECS 宿主目前只有 Docker。构建并审查候选门禁镜像，标签 `org.opencontainers.image.revision` 必须是完整 Git SHA。镜像通过加密归档同步并以本地 image ID 固定；不能使用 `latest` 或运行时拉取依赖。

在 ECS 候选上设置 `ECS_CANDIDATE_GATE_IMAGE=<本地镜像标签>`、`ECS_CANDIDATE_GATE_IMAGE_ID=sha256:<64 hex>` 和 `ECS_CANDIDATE_GIT_SHA=<40 hex>`，运行 `sh infra/scripts/run-ecs-candidate-gates-container.sh`。脚本校验本地镜像 revision 和 image ID，然后在无网络、无额外权限、非 root 用户及无宿主挂载的容器中执行门禁。

此门禁只证明候选代码测试结果。`launch-preflight.sh` 和 `deploy-preflight-ecs.sh` 还需要 Docker API、生产数据库只读验证、固定受保护信任目录、真实证据及 nonce 消费者。不能把 `/var/run/docker.sock` 挂入候选门禁容器；该 socket 等同宿主 root 权限。需要单独审查完整生产预检的执行边界，完成后才运行实际 ECS 发布门禁。此脚本不生成生产 GO，也不启动或切换业务容器。
