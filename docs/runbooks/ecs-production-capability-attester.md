# ECS 受保护能力证据签名器

源码位于 `infra/protected/attest-capability-evidence.mjs`。它只用于构建 root-owned、不可由应用容器访问的固定宿主程序 `/usr/local/libexec/merchant/attest-capability-evidence`。不得从工作树直接执行签名器，也不得在仓库、容器镜像或部署 runner 中存放 Ed25519 私钥。

## 当前上线阻断

ECS 宿主目前没有 Node 运行时。脚本使用 Node 内置 `crypto` 的 Ed25519 签名和 `O_NOFOLLOW` 安全文件读取，因此在宿主安装并保护 Node 运行时之前不能部署这个签名器。`run-production-canary.sh` 的 admission stop 仍在任何服务商 I/O 前拒绝旧 CLI：真实 OAuth 换码、每能力负面路径探测、协议证据采集尚未实现。签名器代码和离线测试通过不代表生产证据已生成。

平台 canary CLI 现在在 provider I/O 前要求基础证据的 `release_id` 严格等于 `RELEASE_ID`，并要求 `PLATFORM_CANARY_OAUTH_STATE` 与单独提供的 `PLATFORM_CANARY_OAUTH_PENDING_STATE` 相等。这只校验两份操作输入的一致性；操作者仍须保存真实 OAuth 授权发起记录和回调记录，证明待确认状态来自同一个会话。CLI 会先预留权限为 0600 的响应 journal，每个实际 HTTP 响应同步落盘；远端写入若已成功而 journal 落盘失败，必须按服务商请求 ID 核对，不能直接重试。现有 admission stop 不因这些代码门禁而解除。

## 受保护边界配置

由独立受保护流程在宿主配置可信 Node 二进制及其依赖，固定路径、root 所有、组/其他不可写，并校验二进制摘要；不要让 `/usr/bin/env node` 从用户可写的 `PATH` 选取运行时。推荐将脚本 shebang 固定为受保护 Node 的绝对路径后，再计算最终部署字节的 SHA-256。最终可执行文件及父目录必须 root-owned、不可被组/其他写入且非 symlink。将该最终字节摘要写入 `/run/release-security/evidence-trust/production-capability-attester-sha256`，与 `validate-production-evidence-trust.sh` 的组织 Ed25519 公钥、key ID、公钥 fingerprint、nonce consumer 摘要一起由独立宿主启动过程重建。`/run` 是 tmpfs，重启后缺失信任包时必须拒绝发布。

私钥由独立密钥管理流程配置在 `/var/lib/merchant-release-security/production-capability-private.pem`，只允许 root-owned `0600` 常规文件。公钥位于 `/run/release-security/evidence-trust/production-evidence-public.pem`。脚本验证私钥推导公钥与受保护公钥字节一致，不生成密钥。生产签名器实际执行前，部署 wrapper 必须完成信任目录、签名器摘要和运行时摘要验证。

签名器读取未签名候选和同目录的六平台 transcript sidecar，要求 SHA-256 引用、release/租户绑定、六项成功请求和每能力对应的失败请求证据。候选生成时间必须处于签名前 24 小时内且最多允许 5 分钟时钟偏差；每个平台的交互时间必须单调递增、不得晚于候选生成时间，也必须落在候选生成前 24 小时内。随后签名器绑定 release ID、镜像集摘要、manifest SHA-256、Git SHA、一次性部署 nonce 和 key ID。输出通过 hard link 独占创建为 `0600`，不会覆盖已有证据。随后必须用仓库的 `capability-evidence-gate --require-signed-production` 和完整 release gate 复核。签名只证明受保护流程接受了这些输入；sidecar 可由作者自行造出，因此真实服务商来源仍需独立采集/审计，不能把自哈希文件当作生产成功证据。

## 离线验证

`npx vitest run tests/protected-attester.test.ts` 用临时测试密钥验证签名与现有 verifier 一致，并拒绝私钥不匹配、sidecar 篡改和失败路径证据不匹配。测试密钥只存在临时测试内存，不可用于 ECS 信任包。
