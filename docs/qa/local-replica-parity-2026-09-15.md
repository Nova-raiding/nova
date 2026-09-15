# 本地 API 副本配置一致性验收（2026-09-15）

## 结果

本地 `local` 项目已完成 API 主实例与副本的配置对齐，并使用新构建的 API/worker 镜像完成受控重建。StoryForge 未启动；业务数据、数据库、Redis、ClamAV 和挂载卷未删除或重置。

## 根因与修复

- 副本此前缺少中转模型密钥、扫描信任配置及部分模型/限额参数，共 16 个非实例标识配置键与主 API 不一致。
- 常用 `dev:stack:relay:build` 命令遗漏 `api-replica`，已补齐并由 `tests/local-relay-start-contract.test.ts` 锁定。
- 更新脚本对 Compose 插值中的 `$` 做字面量转义，失败时仅输出键名，不回显令牌、连接串或密钥。

## 实际运行证据

- 2 个 API、6 个 worker 均健康；worker 启动后各自产生多次成功轮询，处理数为 0、错误数为 0。
- API 镜像：`sha256:b22abcedc708f450e7936876c1f4c6e8372cf8dd6d2d03e2e206e26734a7a8b4`。
- worker 镜像：`sha256:02cd9e743294f96cc118226bf316b7e94d0f750e42f590d09b20512380917c12`。
- `/mcp` 的 `platform.model.status`：8787 与 8788 均为 `ready`，五模态能力均为 true，状态摘要一致；未发起付费模型请求。
- 无平台权限的 token 仍返回 `FORBIDDEN/AUTHZ_CAPABILITY_MISSING`；未认证商品请求返回 401；未签名扫描回调返回 403。
- 容器源新鲜度门禁通过；`/releasez` 仍为未就绪，表示本地配置不能冒充生产发布。

## 历史扫描死信

`evt_53285c3e-4c90-411f-be1a-f8d748b012f1` 保持原样：商业权限拒绝、不可重试；既有扫描尝试的回执 verdict 为 clean，但回调未被接受。验收前后事件、资产快照、扫描尝试及已接受回执数量指纹一致，未重试、删除、补点或改写业务数据。

## 测试

相关回归：5 个测试文件、112 个测试全部通过。完整运行证据见 [runtime-result.json](../../artifacts/local-replica-parity/run-20260915/runtime-result.json)。

