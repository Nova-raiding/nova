# 当前上线准备复核（2026-09-25）

本记录是当前复核快照，不覆盖历史 QA 记录。验收口径以当前 `main`、发布 manifest 和运行态接口为准。

## 架构结论

- ChatGPT 只走本地直装 stdio 插件；不需要 ChatGPT Business/Enterprise、远程 OAuth client、回调或 challenge token。
- 六个平台采用 `PLATFORM_OPERATIONS_MODE=manual`：运营建立人工店铺记录、上传商品/规则资料并分配给商家；不读取平台 Cookie、账号密码或 OAuth token，也不自动发布到平台。
- 商家侧只能读取已分配的数据，生成/审核/导出继续通过 Store Nova API 和桌面工作台完成；平台发布由运营在官方后台人工完成并回填回执。

## 已核对

- CodeGraph 索引已同步，当前仓库无未索引文件。
- `main` 工作树在复核时干净，当前本地提交为 `39753c40`。
- `npm run typecheck` 的包构建阶段未发现 TypeScript 错误；若被并行任务终止，必须重新取得退出码为 0 的完整证据后才能记为通过。
- 生产接口已返回 Postgres、Redis、对象存储和支付 provider 的配置状态；六平台状态为人工运营档，自动写入关闭。

## 当前仍阻断上线的证据

1. 线上 `/releasez` 的 release SHA 与当前本地 `main` 不一致，不能把线上旧镜像当作本候选已部署。
2. 线上 capability evidence 与 capacity report 路径不可读；健康接口中的 `productionGate` 通过不能替代这两类正式证据。
3. embedding 模型未配置，因此知识库向量化/检索不能宣称生产可用；必须继续 fail-closed 或补齐真实中转配置与用量/成本证据。
4. 尚需在同一候选 release 上完成桌面运营台真实登录、人工店铺/商品导入、商家分配、插件读取、生成、审核、导出/人工发布回填和账务回执的端到端验收。
5. 发布门禁、全量回归和浏览器验收必须在没有并行写入/重复测试的干净窗口重新执行并保存退出证据。

## 重新验收顺序

```bash
npm run typecheck
npm run test:release-gates
npm test
npm run test:ops-console
npm run build:ops-console
npm run build:merchant-studio
curl -fsS https://yxsona.com/api/healthz
curl -fsS https://ops.yxsona.com/healthz
curl -fsS https://yxsona.com/api/releasez
```

只有当本地候选的 release SHA、manifest、镜像摘要与线上 `/releasez` 一致，且上述测试、健康检查和桌面浏览器验收全部通过，才可进入 ECS 发布 runbook；在此之前不得宣称已上线。
