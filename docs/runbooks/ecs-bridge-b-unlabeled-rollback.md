# B 旧七容器原 ID 回退边界

状态：离线保护已实现，生产仍 **NO-GO**。101 的旧 API 副本和六个 worker 没有 Compose ownership labels，`docker compose ls` 引用的旧配置路径也已失效。因此不能用“反向 Compose up”承诺精确回退。

`create-ecs-bridge-old-map.mjs` 从真实 Docker inspect 只读生成 root-owned、0600 的七服务冻结映射。每项含旧容器名、完整容器 ID、镜像 ID、完整 `Config` 与 `HostConfig` 的 SHA-256、网络名/ID/别名的 SHA-256；不写环境变量、密钥或原始 inspect JSON。工具要求外部网关的完整 ID、现存 80/443 端口绑定及生产 API 网络。受保护恢复 helper 在签名接管快照前重新 inspect 并逐字段比较该映射，再把七个旧/候选原 ID、配置及网关有效 Nginx 路由摘要绑定到签名 journal。

这份“旧容器指纹 capsule”只证明**保留原容器对象**时可以停旧、改名、启动候选，并在任一部分失败后用原 ID 逆序复原名称、网络 DNS 与公网旧身份。它不是旧容器的可重建备份：指纹不能还原环境变量、受保护挂载、密钥、Docker 创建参数或已消失的镜像。如果旧容器被删除、Docker 存储损坏、镜像被清掉或原网络消失，必须依靠另行审核的旧运行 spec/凭据备份和数据恢复流程；没有这些材料即 **NO-GO**，不得通过猜测 Compose 或复制当前密钥值掩盖缺口。

生成/签名之前保持以下硬门禁：旧七容器及外部网关均在运行，旧镜像和网络仍存在，公网 `/releasez` 四元组及 `/readyz` 为旧健康身份，DB 仍为校验过的 242，生产锁和 nonce 未被消费。任何一项不符，不进入 B 接管。生产生成该映射只应输出状态行，不打印 inspect、环境变量或凭据。
