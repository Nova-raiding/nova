# 101 demo 部署验收（2026-10-05）

已部署 `release-6ef75bf01a83-demo-ui`。独立检查确认 15 个容器健康，运行镜像及 image ID 逐项匹配发布清单，公网 release 返回 ready，API、readyz 和 Ops 健康检查通过。商家 UI 源码为 `6ef75bf01a83de79ded1c219b5e281c1d36c4ba1`；API、worker 和 Ops UI 源码仍为 `b1beda1be01d5dbe1fccde142ecc09392c12e91b`。统一 release 标识不代表每个组件来自同一提交。

- 清单 SHA-256：`28126f2c3ef78f11d40ac7f33e03b3755f9a22e7c16fb78e42fbe8223df52a80`。
- 镜像集摘要：`sha256:b735d0449443ac6f3e9b5dac04807e3a9da5e64a66ee029b2250ad48a3a5b617`。
- 运行证据：[完整容器及探针检查](evidence/2026-10-05-demo-deployment/postdeploy-verification.json)。

数据库在备份及隔离恢复验证后从 257 升到 258；独立审计确认两个数据库角色看到的完整迁移链一致，142 个工作区表强制 RLS。备份和隔离恢复数据保留，未清理历史 unknown 请求及预留。首次更新时旧配置 `WORKER_WORKSPACES=ws_demo` 被生产校验拒绝；将其改为数据库中实际存在且 active 的两个工作区后恢复，保留首次失败记录。

发布前类型检查通过；release gates 共 1448 项通过、16 项声明为 pending/skipped，后续 Node 检查 234 项通过。首次运行受 300 秒执行器超时影响，续跑退出码为 0；负载下超时的测试单独复测 14 项全部通过。此记录不把 skipped 写作通过。[发布前记录](evidence/2026-10-05-demo-deployment/predeploy-validation.json)。

最后一次小范围更新修复了商家登录标签关联，并将 generation worker 六个模态计价组逐项对齐 API 的 VIP 配置。真实桌面 Chrome 中两个标签均唯一定位且点击后正确聚焦，无页面 JavaScript 错误。[浏览器结果](evidence/2026-10-05-demo-deployment/merchant-label-verification.json)。部署后 worker 文本估价不再报 `GROUP_UNAVAILABLE`，API 五模态报价通过；这些是报价验证，不是付费生成回执。

插件仅本地安装，云端归档及镜像未包含插件。完整业务验收尚未完成：本地绑定重试正在等待商家授权；运营后台真实登录仍待完成；中转日志会话刷新返回 401，稳定令牌创建仍需用户完成身份验证。未以探针、报价或旧版业务结果替代本次本地 stdio → 101 → 中转 → 用量与结算的全流程证据。
