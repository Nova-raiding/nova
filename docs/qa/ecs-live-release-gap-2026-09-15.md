# ECS 真实发布差距复核

2026-09-15，owner 通过 SSH alias `101` 只读检查正在运行的 ECS。

## 实际结果

- API Compose 使用基础配置、ECS pilot overlay 和服务器 auth-hardening overlay。
- `/releasez` 返回 `ready: false`；release ID、Git SHA、manifest SHA-256、image-set digest 均为空。
- `/readyz` 返回 `status: ok`，但 setup 为 `fixture`，存储为 `local`，productionGate 为 false。此响应只能证明当前模式的健康，不能证明生产交付。
- 支付 readiness 为未配置，原因 `provider_refund_query_api_must_use_https`。
- 数据库迁移实际尾部为 209；201 名称为 `customer_delivery_required_evidence`，未发现此前担忧的 201 名称冲突。
- 远端不存在 migration 210 源文件。
- 固定生产 trust bundle 的 public key 和 key ID 文件不存在。

## 本轮修改验证

- 当前工作区类型检查通过。
- 插件 managed token、安装、manifest、上传契约：72/72 通过。
- 独立 agent 复核合同 URL 下载：166/166 通过；涵盖 SSRF、身份撤销、断连和隔离扫描入口。下载传输使用 mock，尚未证明真实公网下载与生产 worker 联合链路。

## 后续顺序

先完成当前工作区验证和版本固化，再在隔离候选目录合并服务器配置。完成迁移 210、真实存储/支付配置、可信发布身份及运行证据后，才切换现网服务。不要用 fixture readiness 或候选镜像标签替代正式发布证据。告警和 Kubernetes 不属于本轮需求。

判定：NO-GO。此次检查未改变生产文件、容器或业务数据。
