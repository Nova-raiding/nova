# 素材单一主状态与恢复提示（局部完成）

## 已完成

- Merchant Studio 素材卡片改用只读状态投影，按安全扫描、内容读取、权益和事实确认的顺序选择唯一主状态。
- 扫描拒绝、解析失败、未知枚举均不会显示为可用；失败状态提供明确的人工处理语义。
- REST 返回的 `readiness` 字段已纳入前端类型；服务端 readiness 阻断时前端 fail-closed。
- 增加纯函数状态矩阵测试，覆盖扫描中、扫描拒绝、未知状态、解析失败、解析中、权益待确认、事实待确认和 ready。
- REST/MCP 素材解析、事实确认、权益和历史偏好变更统一经过可访问素材校验；下载统一要求可信扫描凭据，而不是仅信任 `scanStatus=clean`。
- REST `/v1/assets` 与 MCP `asset.list` 增加只读 `display` 投影，提供统一主状态、原因和下一动作；不落库、不替代服务端授权。
- MCP 素材列表按当前可见素材集合返回，素材解析、事实、权益和偏好变更要求 editor 级品牌权限；`merchant_admin` 纳入工作区级治理角色。
- Bridge 对 `display` 做商家字段裁剪，镜像插件保持同步；解析处理中前端恢复动作改为刷新，不允许重复解析。
- 下载返回前再次比对对象 SHA-256、大小和 MIME 与 Asset 快照，快照不一致时以 `ASSET_BINARY_INTEGRITY_FAILED` 阻断。

## 证据

- [`demo/merchant-studio/src/asset-status.ts`](/Users/lixiaomei/Desktop/code/codexSkills/demo/merchant-studio/src/asset-status.ts)
- [`demo/merchant-studio/src/asset-status.test.ts`](/Users/lixiaomei/Desktop/code/codexSkills/demo/merchant-studio/src/asset-status.test.ts)
- [`demo/merchant-studio/src/App.tsx`](/Users/lixiaomei/Desktop/code/codexSkills/demo/merchant-studio/src/App.tsx)

## 边界与未完成项

这是素材展示与部分 API 安全门禁的局部完成，不代表素材能力达到生产上线标准。服务端仍需继续补齐统一 REST/MCP `next_action` 投影、品牌绑定模型和真实 ChatGPT 宿主及生产存储/扫描证据。原综合待办继续保留在 `doc/todo/plugin/`，未整体迁移。
