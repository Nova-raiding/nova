# 当前上线准备只读复核（2026-09-27）

本记录基于提交 `6ab140e0` 推送后的主工作目录，以及同日对 101 和公网健康端点的只读核验。它不是生产发布批准。

## 代码与门禁

- `main` 已与 `origin/main` 对齐，工作树干净。
- 本轮加入 ECS 按组件快速构建、只读 101 状态检查及对应契约测试。
- `npm run test:deploy:fast`、`npm run typecheck` 和 `npm run test:release-gates` 均通过；release gates 为 172 个测试文件、1324 个断言通过，7 个受控文件、16 个断言跳过。

## 真实运行观察

- `npm run deploy:101:status` 在 101 返回 0：应用容器运行且 healthy，公网 `/releasez`、`/api/readyz` 和运营后台 `/healthz` 均为 HTTP 200。
- 101 当前公网 release 为 `release-89c4ce1c`，`ops-ui` 已运行本轮 `89c4ce1c3a5e1da59d6908578bb855b6f0ed0065`；API、worker 和支付网关仍运行旧 `0fa18b78a65de8c5b07f09488f416a6ed08bfe08`，因此这是受限的运营台组件更新，不是完整候选上线。
- `https://yxsona.com/api/healthz` 和 `https://ops.yxsona.com/healthz` 均返回 `status=ok`，但健康不等价于候选发布通过。
- API 与 Ops 响应仍报告 `productionEvidence.capability` 和 `productionEvidence.capacity` 为 `blocked`，原因分别为 `CAPABILITY_EVIDENCE_PATH cannot be read` 与 `CAPACITY_REPORT_PATH cannot be read`。
- embedding 仍为可选 fail-closed 状态，原因包含 `knowledge_vector_indexing_disabled` 和 `model_missing`；词法检索不能被描述成向量检索已上线。

## 当前结论

代码级门禁通过，生产仍为 **NO-GO**。剩余阻断属于真实发布环境：为同一候选生成并签署 capability/capacity、模型中转、支付、对象存储、恢复、ChatGPT host 等 release-bound 证据；构建并验证 `6ab140e0` 对应不可变镜像；完成桌面/ChatGPT 真实链路和受控部署后的业务验收。未获得这些证据前不执行切流，也不把健康端点当作上线批准。
