# 生产 demo 只读观察（2026-09-29 18:13 CST）

范围：公网健康与发布身份、`101` Docker 容器和最近一小时聚合日志。仅执行 GET、`docker ps`/`inspect`/`logs` 及仓库只读状态脚本；没有部署、修改服务器或读取凭据。

## 结果

- `https://yxsona.com/api/healthz` 与 `https://ops.yxsona.com/healthz` 均为 HTTP 200、`status=ok`。`/api/readyz` 为 200、`ready=true`。
- API 与 Ops `/releasez` 均报告 `release-demo-product-code-20260929`、Git `fd1ad6a7bd122a391350c185798ac07e92795f8c`、`ready=true`，与本日已有审计记录相同；没有观察到公网 demo 发布身份变化。
- `node infra/scripts/ecs-fast-status.mjs` 在 `2026-09-29T10:13:30Z` 报告 demo API 双副本、Ops UI、商家 UI、5 个业务 worker、支付/边缘网关、Postgres 和 Redis 均 `running/healthy`。API、API 副本、Ops UI、边缘网关 `docker inspect` 的重启次数均为 0。`release_approved=false`，警告为应用服务混合源码修订以及数据服务使用 tag 保留运行镜像 ID。
- 健康载荷仍报告 `setup.productionEvidence.capability` 和 `capacity` 为 `blocked`，原因分别是 `CAPABILITY_EVIDENCE_PATH cannot be read`、`CAPACITY_REPORT_PATH cannot be read`；embedding `ready=false`（向量索引关闭、模型缺失）。这些与本日已有审计一致，健康 200 不代表发布门禁通过。
- 截至约 18:13 CST 的最近一小时，demo API 主实例结构化日志有 2,972 条带状态的请求，均为 200；API 副本有 1,514 条带状态的请求，其中 9 条为 `503`。9 条发生于 `09:32:54–09:37:36 UTC`（17:32–17:37 CST），均为 `POST /mcp`、事件 `request.failed`、错误码 `CREATIVE_POINTS_UNAVAILABLE`。边缘网关访问日志也记录 9 条 503。该时间窗内还存在预期或业务拒绝类 4xx；本报告没有把它们归为服务故障。日志检查仅聚合状态、路由与错误码，未保存账号、请求体或令牌。

结论：公网 demo 的发布身份未见变化，主要容器健康且无重启；MCP 创意点链路有可观察的 503，且生产证据文件路径仍阻断。当前只读观察不能证明新候选已上线或完整业务链路通过。

## 复核命令

`curl -fsS https://yxsona.com/api/healthz`、`curl -fsS https://ops.yxsona.com/healthz`、两个 `/releasez`、`node infra/scripts/ecs-fast-status.mjs`；`ssh 101` 上 `docker ps`、指定 demo 容器的 `docker inspect` 与 `docker logs --since 1h --tail 10000`。日志在本地仅解析结构化 `status`、`event`、`method`、`route`、`error_code` 与 Docker 时间戳。
