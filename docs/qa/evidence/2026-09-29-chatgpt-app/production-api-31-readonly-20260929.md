# 生产 QA 工作区 31 项无必填参数只读 MCP API 调用

时间：2026-09-29T09:32:55.205Z。账号 demo@sn.com；唯一会话工作区 ws_57fd2361ed5b44c7891f3d37。生产商家密码登录、会话核对及正式 /api/v1/auth/mcp-token 签发均 HTTP 200。认证材料仅在测试进程内存；未输出或保存密码、Cookie、访问及刷新令牌。

证据层级：**生产 HTTPS /api/mcp 的 API/MCP 层**。不是本地 stdio 桥接器或真实 ChatGPT App 宿主调用，也不证明业务正向闭环。请求全部为矩阵中 READ_ONLY 且最小参数 `{}`；无写入、上传、生成或订单操作。

响应是项目 API envelope，故 `isError` 表示 `error` 字段非空；工作区取响应顶层 `workspace_id`。

| 方法 | HTTP | request_id | 工作区一致 | isError | 错误码 |
| --- | ---: | --- | --- | --- | --- |
| `commercial.access.get` | 200 | `req_622d82d1-d9a8-4bdb-9cdb-9613c1de1160` | 是 | false | `—` |
| `subscription.get` | 200 | `req_495a19b8-7428-4432-be89-27ee46fcf3ad` | 是 | false | `—` |
| `canonical.product.consistency` | 200 | `req_566194bd-cd1e-4883-8ad7-21cf87a98537` | 是 | false | `—` |
| `onboarding.status` | 200 | `req_e2815aab-9b54-41ac-a2dc-f7a2d9f074f5` | 是 | false | `—` |
| `brand-unit.list` | 428 | `req_6a003893-5bb4-462a-9a51-a4eacd17edc1` | 是 | true | `STORE_ONBOARDING_REQUIRED` |
| `brand-unit.listing.list` | 428 | `req_e587b0c5-eb5c-441a-add0-6b908f63162c` | 是 | true | `STORE_ONBOARDING_REQUIRED` |
| `campaign.batch.list` | 428 | `req_67498881-7232-4df1-bfd1-f87bedbda1c7` | 是 | true | `STORE_ONBOARDING_REQUIRED` |
| `workspace.health` | 200 | `req_65033f03-0e05-45c4-9c90-733a5ba0e051` | 是 | false | `—` |
| `workspace.invitations.list` | 403 | `req_4757d4c5-d8a3-4287-92c1-56ddeb82eb52` | 是 | true | `FORBIDDEN` |
| `workspace.metrics` | 200 | `req_faf5ac84-a0bc-45eb-b333-d0be75626a4c` | 是 | false | `—` |
| `commercial.catalog.get` | 200 | `req_ac7de4f3-d2bb-453a-9a88-342e3dcf711f` | 是 | false | `—` |
| `creative-points.balance.get` | 200 | `req_a9ac44ed-8caa-4f93-84bd-d6fa70b4f501` | 是 | false | `—` |
| `creative-points.statement.list` | 200 | `req_7550f178-5381-4e57-a972-d1ac010c0159` | 是 | false | `—` |
| `subscription.orders.list` | 200 | `req_2fd8c860-e5f8-4549-a0ec-0c2b565d5a93` | 是 | false | `—` |
| `billing.export` | 200 | `req_4ae6b3b1-9647-4cfa-81f8-caf438a85fa0` | 是 | false | `—` |
| `billing.status` | 402 | `req_0c75642f-ac99-4758-8166-62cc04a758c2` | 是 | true | `COMMERCIAL_ENTITLEMENT_REQUIRED` |
| `billing.model-usage.statement` | 200 | `req_fd5dcaa6-caa9-45a1-9069-31f332acd2b6` | 是 | false | `—` |
| `billing.recharge.list` | 200 | `req_c348700d-65cc-4377-941b-8522fe761a59` | 是 | false | `—` |
| `billing.transactions` | 200 | `req_dee65619-a1b8-474c-bc33-9c527127f5a2` | 是 | false | `—` |
| `catalog.categories` | 503 | `req_c5c9aabf-a36e-49c9-9243-759f5a8209eb` | 是 | true | `CREATIVE_POINTS_UNAVAILABLE` |
| `rule.list` | 200 | `req_01d4f861-1f30-4995-9829-07cbc66ca4dc` | 是 | false | `—` |
| `rule.sync.status` | 200 | `req_de9f3c47-23c6-43b9-a176-ce40a5d7987e` | 是 | false | `—` |
| `asset.list` | 503 | `req_ea91cea5-8254-4961-98bd-451d04c3f19c` | 是 | true | `CREATIVE_POINTS_UNAVAILABLE` |
| `brand.extract` | 428 | `req_3c1f87e2-2203-46c3-97cd-88d5967768d6` | 是 | true | `STORE_ONBOARDING_REQUIRED` |
| `deliverable.list` | 503 | `req_518adae7-5bd9-4e00-97e0-2fbbb37ee532` | 是 | true | `CREATIVE_POINTS_UNAVAILABLE` |
| `task.history` | 503 | `req_cd78e19c-e827-442b-993d-faa330cf6e26` | 是 | true | `CREATIVE_POINTS_UNAVAILABLE` |
| `knowledge.rule.list` | 200 | `req_9ccae93f-f369-47b8-8b74-c6e34883f98a` | 是 | false | `—` |
| `knowledge.asset.list` | 200 | `req_ab57ea8c-17f4-42f7-a318-9bb4b4ad4f40` | 是 | false | `—` |
| `knowledge.brand.preference.get` | 200 | `req_d9d06051-4620-4593-87f3-190655ba3ec2` | 是 | false | `—` |
| `knowledge.learning.list` | 200 | `req_2e646f3f-7c54-4188-b392-c10c5ef158c4` | 是 | false | `—` |
| `knowledge.competitor.list` | 200 | `req_7e6c5a04-2a0a-4458-9eea-2159ba068318` | 是 | false | `—` |

统计：调用 31/31；HTTP 200 且无 API 错误 21 项；API 错误 10 项。错误、空态与权限门禁只按实际响应记录，不计为功能正向通过。
