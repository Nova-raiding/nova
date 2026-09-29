# 最新候选发布测试

2026-09-29 18:01 CST 开始，在主工作目录执行 `npm run test:release-gates`；命令最终退出码为 0。前置隔离 API/worker 254→255 桥和模型用量结算 22 项通过，受保护 255 状态存储检查通过；主发布测试及后续 ECS、nonce、支付和 Node 发布脚本均执行完成。`tests/plugin-manifest.test.ts` 本轮 6 项通过。

此前在同一轮候选上执行 `npm run typecheck`，退出码 0；发布记录面板目标测试 23/23、本地隔离浏览器 3/3 和商家端 TypeScript 检查另有独立记录。浏览器证据见 [本地发布记录说明](local-publish-history/README.md)。

发布测试通过只证明候选本地门禁。线上演示数据库仍为 schema 254，当前代码与发布元数据要求 255；用户要求不迁移数据库。因此云端发布仍为 NO-GO，本轮没有执行部署或迁移，也没有把本地浏览器结果记为真实 ChatGPT App 验收。
