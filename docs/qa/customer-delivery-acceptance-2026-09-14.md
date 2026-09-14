# 客户交付验收记录 · 2026-09-14

结论：隔离环境的客户交付表单链路通过；不等同于共享环境已部署或全部业务交付完成。

## 已验证范围

| 需求 | 运行证据 |
| --- | --- |
| 客户档案 | 真实 OIDC 登录、建档、合同编号/HTTPS 链接、负责人、付款状态/日期、要求上线时间保存与刷新回显 |
| 日期解析 | PostgreSQL DATE 保留日历日期；中国时区 09:00 保存为 01:00Z，刷新仍为 09:00 |
| 系统接入、功能验收 | 10 + 8 个稳定清单键、逐项勾选与证据、批量 JSON 保存、重开回显 |
| 培训 | 主页独立勾选，无详情入口；验收不自动完成培训；勾选不打开抽屉 |
| 阻断 | 未付款不得进入受控环节；不存在/未扫描视频引用返回 409，仍未生效 |
| 表单隔离 | 新建第二个客户不带入前一客户的合同、负责人或日期 |
| 持久化安全 | 运营角色写入、商家角色拒绝、跨工作区 RLS、并发 revision 冲突、审计旧值及只追加、视频软删除 |

修复包含：运营连接池与权限、审计 UUID、生效时间重算、缺失的干净源码依赖；日期跨日/时区偏移；验收错误联动培训；异步保存重开抽屉；加载/切换表单时的状态保护。移除抽屉内拥挤的步骤条，保留标题和具体表单。

## 测试结果

- 干净源码快照全量 TypeScript 检查通过。
- 定向回归 12 个文件、57 项测试通过（API 授权、MCP JSON 契约、客户端解析、表单辅助逻辑、迁移及运行角色门禁）。
- 隔离 PostgreSQL 17 回归通过，运行时区 `Asia/Shanghai`，全部字段值精确断言。
- 桌面 1440×900、Asia/Shanghai、真实生产构建 UI → 签名 OIDC → API/MCP → PostgreSQL/Redis 测试通过，1 个完整用例，47.8 秒。
- 使用 shot-scraper 实际取消并重新完成培训，生成截图和 WebM；没有保存会话 cookie、密码或原始网络跟踪。
- 仅清理了本次验证自行创建、通过身份校验的临时容器；共享容器及业务数据未修改。

本地证据位于 `artifacts/customer-delivery-acceptance/run-61350d17/`，不作为源码依赖：

- `result.json`：浏览器 RPC 结果与最终状态。
- `postgres-result.json`：数据库回归与临时资源清理结果。
- `runtime.json`：实际持久化/授权环境。
- `profile-fields-reloaded.png`、`customer-delivery-gates.png`：表单与阻断截图。
- `training-confirmed-shot-scraper.png`、`training-inline.webm`：真实培训操作结果。

可复跑（需本地 Docker 测试镜像、Chrome 和 shot-scraper）：

```sh
TZ=Asia/Shanghai node --import tsx scripts/verify-customer-delivery-postgres.ts
node --import tsx scripts/run-ops-oidc-e2e.ts dogfood/chatgpt-all-functions/ops-delivery-isolated.spec.js
```

## 尚未完成的上线条件

1. 真实合同/视频安全上传、扫描及多段视频成功登记未通过真实存储服务验收。当前视频测试验证的是缺扫描证据时正确阻断，不是假造上传成功。
2. “交付生效”当前为交付档案状态；尚未验证其他业务区域的实际生效联动，不能据此宣称账号/权限已启用，也不能自动恢复被管理员停用的主体。
3. 共享环境尚未应用迁移 200、更新运行版本或完成登录后的企业验收。仍需已登录运营会话及明确的测试企业。
4. 本次未调用商业模型、中转或真实支付，因此不构成 ChatGPT 插件五模态、成本/账务及生产发布门禁的全面通过证据。
