# ECS 生产 deployment nonce 防重放控制面

`infra/protected/consume-production-evidence-nonce.py` 是受保护程序的审查源码，生产安装位置固定为 `/usr/local/libexec/merchant/consume-production-evidence-nonce`。程序只能由 root 执行，在 `/var/lib/merchant-release-security/production-nonces.sqlite3` 使用 SQLite `BEGIN IMMEDIATE` 与 `(namespace, nonce)` 唯一键原子记录 release ID、镜像、manifest 和 Git SHA，并在同一事务写入 `nonce_owners(namespace, nonce, operation, attempt_id)`。普通发布现有 CLI 不变，省略新增选项时 owner 默认是 `deployment` 和空 attempt；Bridge B 必须显式给出 `--operation bridge-b --attempt-id <signed-attempt-id>`。两张表都以 `(namespace, nonce)` 唯一约束，旧版 ledger 有 consumed row 但缺 owner row 时绝不补领或回填为 Bridge B；这类 nonce 对 Bridge B 是未知来源并必须拒绝。Bridge B 仅可在 journal 绑定完全相同的 `bridge-b` operation 与 attempt ID 时恢复同一 attempt。账本是持久宿主数据，不能随容器或候选目录清理。

安装前核对候选源码与隔离并发测试的 SHA-256。生产机必须具备 Python 3 与 SQLite 支持。在开发机用 `sh tests/run-protected-nonce-consumer-isolated.sh` 执行 root、无网络、无挂载的固定镜像 smoke；该 smoke 核对原普通发布参数仍接受并获得 `deployment` owner，并证明同 release identity 的普通发布 nonce 不能被重新消费为 Bridge B attempt。不要在生产账本上运行 smoke。

### 首次安装（只有目标不存在时）

仅当受保护 executable 和 ledger 都确实不存在时使用首次安装流程。目标 executable 已存在时不得使用本节覆盖；跳到下方“已有环境升级”。不创建空 ledger，不要执行 `touch`。

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

### 已有环境升级（保护旧 consumer 和 ledger）

当固定路径已经有 consumer，或 `/var/lib/merchant-release-security/production-nonces.sqlite3` 已存在时，使用本升级流程。先在隔离容器对精确候选源码运行上述 smoke 并由 reviewer 独立确认新源码 SHA、当前安装 consumer SHA、当前 trust digest 和候选 release。`EXPECTED_OLD_NONCE_CONSUMER_SHA256` 必须来自当前有效的独立审批记录；`REVIEWED_NEW_NONCE_CONSUMER_SHA256` 必须来自候选源码的独立审查。缺少当前 `/run` trust digest（例如重启后尚未由受保护启动流程恢复）时停止，不得以本地计算值自行重建信任。

如果 ledger 已存在但固定 consumer 不存在，或 consumer 存在但当前 trust digest 缺失/不匹配，不能走首次安装或自动修复；保留所有状态并阻断发布，先从独立受保护备份和启动信任源恢复，经 owner 复核后再按升级流程处理。不得根据 ledger 内容推测曾经安装的程序版本。

升级在 root 下持有与部署相同的 FD 9 锁执行。该锁阻止普通发布或 Bridge B 在 consumer 与 digest 更换期间运行。程序和 digest 各自通过同目录临时文件加原子 rename 替换；两者之间的短暂不匹配会使 nonce wrapper fail closed。先保存并校验旧 consumer 和旧 digest 的 root-only 备份，再替换；**整个流程不得打开、迁移、复制覆盖、删除或重建 `production-nonces.sqlite3`**。

```sh
set -eu
umask 077
consumer=/usr/local/libexec/merchant/consume-production-evidence-nonce
trust_dir=/run/release-security/evidence-trust
digest_file="$trust_dir/production-evidence-nonce-consumer-sha256"
history=/var/lib/merchant-release-security/nonce-consumer-upgrades
reviewed_source=/srv/merchant-releases/RELEASE_ID/infra/protected/consume-production-evidence-nonce.py
lock=/var/lib/merchant-release-security/production-deploy.lock

exec 9>>"$lock"
flock -n 9 || { echo 'production deployment lock is busy' >&2; exit 1; }
test -f "$consumer" && test ! -L "$consumer"
test -f "$digest_file" && test ! -L "$digest_file"
old_actual=$(sha256sum "$consumer" | awk '{print $1}')
old_trusted=$(cat "$digest_file")
test "$old_actual" = "$EXPECTED_OLD_NONCE_CONSUMER_SHA256"
test "$old_trusted" = "$EXPECTED_OLD_NONCE_CONSUMER_SHA256"
new_actual=$(sha256sum "$reviewed_source" | awk '{print $1}')
test "$new_actual" = "$REVIEWED_NEW_NONCE_CONSUMER_SHA256"

install -d -o root -g root -m 0700 "$history"
backup="$history/$old_actual.consumer.py"
backup_digest="$history/$old_actual.consumer.sha256"
test ! -e "$backup" && test ! -e "$backup_digest"
install -o root -g root -m 0400 "$consumer" "$backup"
printf '%s\n' "$old_trusted" > "$backup_digest"
chown root:root "$backup_digest"
chmod 0400 "$backup_digest"
test "$(sha256sum "$backup" | awk '{print $1}')" = "$EXPECTED_OLD_NONCE_CONSUMER_SHA256"

consumer_tmp=$(mktemp /usr/local/libexec/merchant/.nonce-consumer.XXXXXX)
digest_tmp=$(mktemp "$trust_dir/.nonce-consumer-digest.XXXXXX")
trap 'rm -f -- "$consumer_tmp" "$digest_tmp"' EXIT HUP INT TERM
install -o root -g root -m 0755 "$reviewed_source" "$consumer_tmp"
printf '%s\n' "$REVIEWED_NEW_NONCE_CONSUMER_SHA256" > "$digest_tmp"
chown root:root "$digest_tmp"
chmod 0600 "$digest_tmp"
mv -f -- "$consumer_tmp" "$consumer"
mv -f -- "$digest_tmp" "$digest_file"
test "$(sha256sum "$consumer" | awk '{print $1}')" = "$(cat "$digest_file")"
trap - EXIT HUP INT TERM
```

此升级兼容已有 SQLite ledger，不对现有记录做 owner 回填。旧 ledger 中已有 `consumed_nonces` 记录但尚无 `nonce_owners` 记录时，Bridge B 必须视为来源未知并拒绝使用；不能因 release/image/manifest/Git SHA 相同就接管。新版本会在下一次新 nonce 消费时事务性创建 `nonce_owners` 表；普通部署仍使用原有参数，默认记录为 `deployment` owner。升级前备份属于 immutable 操作审计，不是 ledger 备份或 ledger 替换。

备份应包含持久 SQLite 账本，并在发布暂停、无并发 consume 的窗口使用 SQLite 一致性备份机制备份，验证可读性和 consumed nonce 行数。恢复不能用旧快照直接覆盖一个更新的账本，因为那会重新允许已经消费的 nonce；恢复前应暂停发布、核对所有已消费记录，并验证恢复集是现有账本的超集。无法证明完整性时保持发布阻断，重新审查信任边界。程序拒绝无效参数、损坏账本、错误权限、symlink 和重复 nonce，故障时不得通过删除账本重试同一发布。
