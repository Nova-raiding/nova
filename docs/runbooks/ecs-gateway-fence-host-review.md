# 网关 fence 宿主安装与崩溃恢复审查契约

`infra/protected/ecs-gateway-fence-host-review.mjs` 是只读契约，不包含安装或生产 mutation CLI。它复用现有 `ecs-external-gateway-handoff.mjs` 的受保护路径、FD9 锁与不可变容器身份思路，以及 bridge-254 signed journal 的 durable/CAS 思路；没有复制其会停止公网 80/443 的操作。

安装审查要求当前签名 gateway capsule 与回调清单、完整容器 ID/镜像/网络/80/443 映射、运行配置 SHA、完整 nginx 有效配置 SHA、无 `real_ip` 重写、精确 Docker healthcheck、root-owned 0500 控制器和 watchdog、root-owned 0700 journal 目录，以及 FD9 与生产锁的 device/inode 和 flock owner 完全一致。watchdog 周期不得超过 10 秒。review-only 标记必须关闭生产 mutation；即便全部满足，返回值也仅表示可继续人工审查，`installation_allowed` 和 `production_mutation_allowed` 始终为 false。

崩溃恢复审查要求签名 journal 绑定同一 gateway、原配置 SHA、fence 配置 SHA、capsule 与回调策略 SHA。仅在数据库仍为 242、旧运行集完整且回调可达时，`write_started` / `fenced` 阶段的 fence 配置可得到“在锁下恢复基线并探测”的建议。数据库已前进或 journal 进入 `bridge_mutation_started` 后必须保持隔离并转向正向恢复；若这时发现基线配置已经开放，直接 `hold_and_page`。签名、身份、配置、阶段或数据库观察不一致也一律 `hold_and_page`。建议不是执行授权。

101 当前没有安装受保护 gateway fence 控制器/watchdog，也没有绑定当前网关的签名 capsule、完整回调策略或 durable journal。因此该契约当前会拒绝生产安装。生产实现还需 root-owned 原子 journal 写入/fsync/CAS、独立 watchdog 进程、崩溃后的锁与配置复核、同镜像 nginx 候选/回滚验证，以及真实 provider 回调和 worker drain 证据。
