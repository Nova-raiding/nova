# ECS 候选源码门禁容器

受控构建环境使用 `infra/docker/candidate-gates.Dockerfile`（固定 Node 22 Alpine 基础镜像摘要）和 `infra/scripts/build-ecs-candidate-gates-image.sh`。运行 `ECS_CANDIDATE_GIT_SHA=<完整提交SHA> sh infra/scripts/build-ecs-candidate-gates-image.sh`。构建器要求干净的已提交源码，使用 `git archive` 取得仅含该提交的源码并计算 tar SHA-256，通过根目录 `package-lock.json` 执行 `npm ci`，然后核对镜像的 revision 和源码归档摘要标签。工作树未提交、Dockerfile 不在目标提交中或 Docker 不可用时明确失败。此脚本只构建本地镜像；推送、扫描和 registry manifest digest 审查需另行完成。

候选运行器还要求 `ECS_CANDIDATE_SOURCE_SHA256=sha256:<64 hex>` 与构建输出一致。它同时验证固定 registry digest、完整 Git SHA 和源码摘要标签后才启动无网络测试容器。

ECS 宿主目前只有 Docker。构建并审查含完整源码、`npm ci` 安装结果和 Node 工具链的候选门禁镜像，镜像标签 `org.opencontainers.image.revision` 必须是候选的完整 Git SHA。镜像须推送并锁定 `sha256` digest；不能使用 `latest` 或运行时拉取依赖。构建和镜像扫描在受控构建环境完成，宿主只运行已审查镜像。

在 ECS 候选上设置 `ECS_CANDIDATE_GATE_IMAGE=<registry>/<image>@sha256:<64 hex>` 和 `ECS_CANDIDATE_GIT_SHA=<40 hex>`，运行 `sh infra/scripts/run-ecs-candidate-gates-container.sh`。脚本对镜像 revision 标签进行一致性校验，然后在无网络、无额外权限、非 root 用户及无宿主挂载的容器中执行 `typecheck` 和 `test:release-gates`。TypeScript 会写入 `dist` 和 `.tsbuildinfo`，发布测试会生成夹具与 artifacts，因此镜像内 `/workspace` 必须允许 UID 65534 写入。写入只存在于运行时可丢弃的容器层和 `/tmp` tmpfs；`--rm` 会清除容器层，不把数据写回宿主。

此门禁只证明候选代码测试结果。`launch-preflight.sh` 和 `deploy-preflight-ecs.sh` 还需要 Docker API、生产数据库只读验证、固定受保护信任目录、真实证据及 nonce 消费者。不能把 `/var/run/docker.sock` 挂入候选门禁容器；该 socket 等同宿主 root 权限。需要单独审查完整生产预检的执行边界，完成后才运行实际 ECS 发布门禁。此脚本不生成生产 GO，也不启动或切换业务容器。
