# 101 运营 UI 与 254→255 隔离恢复验收

## 运营 UI

- 固定候选 `cd7c898bc419a1adb5ff00ebe2a2ccd524ebd8dd` 在 101 的 `merchant-demo-cd7ops` 与 `merchant-ops-review-cd7` 独立项目运行；API、PG17、Redis、Ops UI 和 loopback TLS 网关均健康。候选 `runtime-attestation.json` 标记 `review_only`、`production_go=false`。
- 通过 SSH loopback 和真实桌面 Chrome 登录隔离测试账号：`hyp@sn.com`、`hxd@sn.com` 的“权限与授权”标签可见，`ops.authorization.matrix.get` 均返回 200；普通账号 `devide@sn.com` 不显示标签，直接调用该 MCP 方法返回 403 `FORBIDDEN`。
- 授权页 JIT 目标和签发区在首屏；权限矩阵默认折叠，键盘 Enter 可展开，页面无横向溢出。平台总览显示新绿色布局；平台账号详情在 920 px 抽屉中显示准确空态，无横向溢出。截图保存在验收机 `/tmp/ops-review-hyp-authorization-cd7.png`、`/tmp/ops-review-overview-cd7.png`、`/tmp/ops-review-user-detail-cd7.png`。

## 真实生产源的只读备份与隔离预演

- 公网实际源为 `merchant-demo-85575f9c-postgres-1`，PG16、迁移 254，公网 release `release-f48c8454-dual-e2e`；旧 `merchant-production` 数据库的 242 备份不属于本次源。
- 已在 101 对候选 `release-ab61720a-ops-review-20260928` 的 SQL 1–254 与公网数据库 `schema_migrations` 逐项比对，差异 0，前缀摘要 `26be57bbd61771707ace0eb6626d110094bedeef7eeb829b24e8d083ac0fb847`。
- 固定安装的 plan signer 和备份 collector 来自精确提交 `fd3dbc146459474c8fbbce9814ad284ecef7ab66`，安装摘要读回一致。只读 inspect 的 freeze SHA 为 `6b679d7014a96c5d1d1e4c94f710466bcd3608b0ef56576b36bb248938f9c80f`；签名源计划文件 SHA 为 `8cf5b21ccad40b60e9370157f9f0cab447d29148e6b3dd387987a85b6dc2ce6e`。
- 使用独立 `demo-254-backup` 一次性 nonce 采集的 PG16/254 dump 位于 101 受保护目录 `backups/release-f48c8454-dual-e2e-demo254-demo25410e85c90eb03673d85495fec/`，dump SHA 为 `6c87e4c96591310c83a624714caedbcd373c5c95fc1ee4dcfc47ed063cb94510`。本地独立复核签名计划、v2 attestation、capture manifest 与实际 dump 字节，均一致；业务库没有写入。
- 独立 PG17 预演使用内部 Docker 网络、新卷、无宿主端口，恢复该 dump 后校验完整 1–254 历史，只运行 SHA `3ca08679671e6d427308f19594a987d157efa33639d461cd84339d703ab0c279` 的迁移 255，再校验完整 1–255 历史。首次预演因 PG17 初始化重启期间的短暂 `pg_isready` 竞态失败并隔离保卷；修复已提交 `1a418b56`，新独立卷重跑通过。签名结果位于 101 `preview-restores/demo25410e85c90eb03673d85495fec-isolated-255.json`，结果签名经独立复核，`simulated=false`、`production_deploy_authorized=false`。
- 恢复库实查迁移记录 255 条；`workspaces=1`、`platform_accounts=1` 与源库一致。迁移 255 新增三张表均启用且强制 RLS，三条策略存在。通过后已停止预演 PG17 容器，保留独立卷与证据。

## 生产发布判定

截至本次验收，公网 API 与 Ops 健康接口均为 200；101 根盘可用约 37 GiB。`main` 的类型检查和发布门禁通过，UI 候选及数据库预演通过，但当前公网仍是旧 f48 版本。缺少已上线的 254/255 双前缀桥、受保护的旧组合恢复 capsule、正式生产锁/fence/nonce/journal 和故障注入下的真实 API/worker/ChatGPT 验收。隔离预演明确不授权生产切流；当前发布结论为 **NO-GO**。
