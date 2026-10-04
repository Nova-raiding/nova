# 生产与候选健康端点只读复核（2026-10-04）

## 生产

- `https://yxsona.com/api/healthz`：HTTP 200，`status=ok`；五模态 relay configured，costGate ready，`writesEnabled=false`；embedding 明确为未就绪（knowledge vector indexing disabled / model missing）。
- `https://yxsona.com/api/readyz`：HTTP 200，`status=ok`，与生产运行门禁返回一致。
- `https://yxsona.com/api/releasez`：HTTP 200，`ready=true`；release identity：`release-fa6beb91`，git SHA `fa6beb91fdb81f4ebb2b676be3fa97baa7fb0ed5`，manifest 和 image digest 均由服务端返回。
- `https://ops.yxsona.com/healthz`：HTTP 200，`status=ok`；这是 Ops liveness/readiness 入口，不把它当成 release identity。

## 候选

候选 release 容器标签为 `release-5b1e5a03`，git revision `5b1e5a03fe2f713b47e5ca2aa79a349c72158aa0`。从候选 TLS 容器内部只读访问 `https://127.0.0.1:8443/releasez` 并带 Host `yxsona.com`：HTTP 200，`ready=true`；release identity 为 `release-5b1e5a03`，manifest `5424d64b97ca304d636345e891c86838eebfdca799d2448542fa16c8754af70e`，image digest `sha256:061901db87099f6dcd9accd64a912fa84bf121285e3f5bd585b1245f19a0b966`。

候选 TLS 网关只暴露 `/releasez`、`/mcp` 和 token refresh；从 API 容器 localhost 直接访问 `/api/healthz`、`/api/readyz`、`/api/releasez` 均返回 401，属于 strict auth 保护，未绕过鉴权。候选与生产 release identity 不同，不能把候选 ready 结论代替生产结论。
