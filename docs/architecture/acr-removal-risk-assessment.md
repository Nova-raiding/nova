# ACR 移除与风险评估

生产架构不创建或依赖阿里云 ACR。镜像由受控构建机生成，经 SSH/加密归档同步到 101 主机，以本地 Docker image ID 固定运行。

保留 Git SHA、源码摘要、Compose/config 摘要、release identity、`--pull=never`、本地 image ID 校验和回滚 capsule。

主要风险：无集中留存、无托管漏洞扫描、SSH/人工同步失误。缓解措施：构建机与 101 各保留至少两版加密归档；传输后校验 SHA-256/image ID；构建机保存镜像扫描报告；使用 safe-sync 原子目录和回滚锁，禁止直接覆盖现网。

结论：移除 ACR 可避免云资源费用，但分发、留存和扫描责任转移到构建机与 101。无法证明归档、扫描和摘要一致时，发布门禁必须保持 NO-GO。
