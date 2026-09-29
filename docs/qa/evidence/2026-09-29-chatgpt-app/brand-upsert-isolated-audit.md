# `brand.upsert` 隔离 HTTP/MCP 验收

日期：2026-09-29。运行环境为本地临时 HTTP 服务、内存授权仓库、隔离工作区和商业权益 fixture；没有向生产写入，也没有执行数据库迁移。

```sh
node --import tsx scripts/run-safe-tests.ts --no-file-parallelism apps/api/src/brand-profile-upsert-http-mcp-parity.acceptance.test.ts
```

结果：**1 个测试文件、4/4 用例通过**。新增的精确方法正向用例位于 [brand-profile-upsert-http-mcp-parity.acceptance.test.ts](../../../../apps/api/src/brand-profile-upsert-http-mcp-parity.acceptance.test.ts)：

| 阶段 | 实际断言 |
| --- | --- |
| 第一次 MCP 写入 | `brand.upsert` 返回 HTTP 200、无错误、工作区和品牌事实正确，修订号为 1。 |
| 冲突候选 | 第二次写入把不同定位保留为待处理冲突，修订号为 2，冲突记录包含 `source: qa://brand/candidate-v2`，原定位保持不变。 |
| 人工采纳 | 使用 `conflict_resolutions_json` 选择候选后修订号为 3，`brand.get` 读回已采纳定位且没有待处理冲突。 |
| 跨租户边界 | 同一 Bearer 身份向未授权工作区调用 `brand.upsert` 返回 HTTP 403 / `FORBIDDEN`；外工作区未生成品牌档案，原工作区保持修订号 3。 |
| HTTP/MCP 一致性 | 同文件既有用例比较两个通道的写入事实、相关请求 ID、显式能力拒绝和品牌单元链接。 |

**来源字段的限制：**当前服务把 `source` 写进待处理的字段冲突记录；首次创建与已采纳的最终品牌档案没有独立的来源字段，更新事件载荷也没有来源。因此本轮能证明冲突候选来源，不证明每个已确认品牌字段的持久来源链。生产 ChatGPT App 中的交互写入、读回、审计与数据库持久化仍需单独验收。
