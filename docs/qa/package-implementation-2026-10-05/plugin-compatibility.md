# 本地 stdio 插件兼容与安装核验

日期：2026-10-05。验证范围区分源码 Bridge、项目本地源镜像、真实已安装 cache 和 ChatGPT 宿主。

## 已证明

- release metadata 实测当前 MCP 方法 380、商家 tools/list 131。只修改 count；仓库/插件版本及迁移 263 身份未重定。
- `npm run release:metadata:validate` 通过。source Bridge 与 `.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs` 对比仅包含本次后续商业方法遗漏，无用户独立修改，因此完成该项目源镜像同步。这里的目录名称不代表公开/团队市场发布。
- plugin-surface-validation.log：5 文件 68 测试通过，覆盖真实 source/项目镜像 tools/list、release counts、隐藏 Ops、精确恢复顺序及 API/OpenAPI 表面覆盖。
- 修复 source Bridge 恢复注册顺序与共享注册表不同；覆盖检测现在认可服务器实际 dispatch 的 exact exported method Set，不能用孤立字符串冒充路由。skill 明确禁止的工具须实际不可达，测试不再把禁止句误判为调用建议。
- plugin-stdio-compatibility.log：3 测试通过。启动实际 `apps/api/src/server.ts` 隔离 test-memory API、真实 Workspace 成员与鉴权，用真实子进程 stdio 验证当前源码 Bridge 与 git HEAD 历史 Bridge 均可读取真实 API 的空商业目录；历史无 quote 升级实际收到 INVALID_REQUEST，HTTP 旁路同样 400。历史 entrypoint/manifest 从 git HEAD 原字节恢复到临时目录，兼容辅助模块来自当前候选；不是独立完整旧发行包验收。

## 安装事实与缺失

项目 `.codex/plugins/merchant-marketing` 不存在。实际本地直装 cache 是 `/Users/lixiaomei/.codex/plugins/cache/merchant-local/merchant-marketing/0.1.0+codex.20261005113527`。只读运行 verify-installed-bridge 后 `ok=false`：安装包为 qa-broker profile、源码为 unpackaged development，且已安装 Bridge 122 tools，候选131 tools，缺9个本次商业方法。报告 `plugin-installed-verification.json` 保留原检查结果。未覆盖已安装 cache。

`plugin-installed-stdio.log` 单独显式环境运行安装 cache stdio 测试（默认 safe-test runner 会移除该安装路径环境变量）。这只是实际已安装文件在隔离 API 下的进程验证；不能称 ChatGPT.app 当前会话加载了候选插件。

三版本矩阵目前有当前服务器+当前源码插件、当前服务器+历史 entrypoint 的安全读取/旧升级拒绝证据；回滚兼容服务器+新插件没有实际运行候选证据，不能称三版本完整通过。隔离 memory API 测试不证明 PostgreSQL/RLS 购买授予，也不证明生产付款、ChatGPT宿主及真实模型中转。

## 收款恢复追加

新增7个 exact Ops 收款/分配/返款原请求恢复与未匹配款返款方法，共享 schema 禁止用户指定actor，未匹配款返款明确拒绝 target_workspace_id，不创建假 Workspace。read/record/return 独立 capability 不混用。receipt-recovery-contract-tests.log：2 文件42测试通过；实际 actor SQL 限定由仓储 owner 实现，仍需其真实 PostgreSQL 验收证据。

安装 cache 单独运行结果：`plugin-installed-stdio.log` 1文件4测试全部通过，含真实已安装 Bridge 文件对真实隔离 API 的 catalog 安全读取。安装完整性核验失败仍成立；安全旧读可用不能证明9个新商业方法已安装。
