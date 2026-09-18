# ECS 生产 deployment nonce 防重放控制面

`infra/protected/consume-production-evidence-nonce.py` 是受保护程序的审查源码，生产安装位置固定为 `/usr/local/libexec/merchant/consume-production-evidence-nonce`。程序只能由 root 执行，在 `/var/lib/merchant-release-security/production-nonces.sqlite3` 使用 SQLite `BEGIN IMMEDIATE` 与 `(namespace, nonce)` 唯一键原子记录 release ID、镜像、manifest 和 Git SHA。账本是持久宿主数据，不能随容器或候选目录清理。

安装前核对候选源码与隔离并发测试的 SHA-256；不要覆盖已有账本或已有不同摘要的保护程序。生产机必须具备 Python 3 与 SQLite 支持。先在隔离 root 候选环境执行 `python3 tests/protected-nonce-consumer-smoke.py infra/protected/consume-production-evidence-nonce.py`，再由 root 执行以下首次安装命令（`test ! -e` 防止覆盖）：

```sh
install -d -o root -g root -m 0755 /usr/local/libexec/merchant
install -d -o root -g root -m 0700 /var/lib/merchant-release-security
test ! -e /usr/local/libexec/merchant/consume-production-evidence-nonce
test ! -e /var/lib/merchant-release-security/production-nonces.sqlite3
install -o root -g root -m 0755 infra/protected/consume-production-evidence-nonce.py /usr/local/libexec/merchant/consume-production-evidence-nonce
sha256sum /usr/local/libexec/merchant/consume-production-evidence-nonce
```

将该摘要以 root-owned `0600` 文件绑定到 `/run/release-security/evidence-trust/production-evidence-nonce-consumer-sha256`，并确认它与保护程序实际字节完全一致。`/run` 是 tmpfs，重启后摘要会消失；信任包必须由受保护的宿主启动流程从独立可信源重新 provision，不能从可变仓库或开发机测试夹具复制。完整发布仍需同目录的真实 Ed25519 公钥、key ID、公钥 fingerprint、受保护 attester 摘要和私钥所在的独立签名边界；缺一项时 `validate-production-evidence-trust.sh` 必须拒绝。

首次成功 consume 后账本由程序创建为 root-owned `0600`；不要为了创建文件而运行 `touch`。发布控制面必须始终以 root 执行，且 `/var`、`/var/lib` 为 root-owned、不可被 group/other 写入，专用账本目录为 root-owned `0700`。程序在 SQLite 打开后再次检查路径、目录、账本所有权与权限，再进入写事务。

备份应包含持久 SQLite 账本，并在发布暂停、无并发 consume 的窗口使用 SQLite 一致性备份机制备份，验证可读性和 consumed nonce 行数。恢复不能用旧快照直接覆盖一个更新的账本，因为那会重新允许已经消费的 nonce；恢复前应暂停发布、核对所有已消费记录，并验证恢复集是现有账本的超集。无法证明完整性时保持发布阻断，重新审查信任边界。程序拒绝无效参数、损坏账本、错误权限、symlink 和重复 nonce，故障时不得通过删除账本重试同一发布。
