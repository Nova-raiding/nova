# Store Nova 上线续验记录 · 2026-09-15

时间：2026-09-15 11:31 +08:00
范围：ChatGPT 插件入口、支付对账 worker、PostgreSQL/RLS、确定性发布门禁、桌面运营后台和共享本地运行状态。

## 判定

**NO-GO。** 本轮已定位真实 ChatGPT 插件权限失败的直接原因并修复四处源码门禁缺口；本地真实运行与隔离数据库复验通过，但当前 ChatGPT 任务仍持有旧令牌，安装缓存未与源码对齐，共享/生产部署、生产支付、知识库生产检索、当前 release 五模态成本证据和最终生产 canary 仍不完整。

## 本轮续验新增结论

- 当前 ChatGPT.app 启动的 Store Nova bridge 子进程仍持有旧令牌；该令牌对同一 MCP 入口和 `ws_demo` 返回 403。launchctl 当前令牌对同一只读引导调用返回 200，状态为 `in_progress`；已安装 bridge 在干净环境中读取当前 launchctl 配置后也能成功。因此直接恢复动作是完全退出并重启 ChatGPT，再在新任务中复验初始化、工具清单、引导和任务历史。当前任务不能热替换 bridge 进程令牌，不能把 one-shot 成功冒充当前宿主通过。
- 已安装商家工具清单和源码清单均为 151 项，包含 `onboarding.status`、`merchant.start`、`merchant.first_value`，无 `ops.*`、无重复；但安装缓存版本与仓库 release metadata 不一致，manifest、README、package 和 bridge 字节也未完全一致，必须刷新安装缓存后用最终 digest 重采真实宿主证据。
- 外部 `/readyz` 实时显示运行模式仍为 `fixture`、六个平台均为 `fixture_ready`、写入关闭、对象存储为本地模式、生产 capability/capacity 证据未要求。该健康响应只证明入口存活，不能作为生产就绪证明。
- 修复运营商业就绪报告遗漏 OCR provider/cost evidence 的问题；五模态门禁现在覆盖 text、image、image_edit、ocr、video。已有真实五模态证据绑定旧 release `f98c69daca2b`，当前源码 release 不匹配时门禁明确拒绝，最终 SHA 冻结后必须重跑 canary。
- 修复客户交付合同引用契约：HTTPS 外链不能证明工作区所有权、交付绑定或 clean scan，MCP 现仅接受上传后的 asset 引用或空值，并由 API/持久化继续做权威校验。
- 扩充审计/错误证据递归脱敏，覆盖 session/reset/bearer/MCP/metrics/webhook/worker/scanner/OIDC token 和 signing/webhook/worker/scanner/OIDC secret。
- 隔离 bridge 测试子进程环境，避免生产 `DEPLOY_ENV` 污染 localhost stub；source 与 marketplace mirror 测试文件已同步。生产 Runbook 的迁移基线从过期的 106 更新为 release metadata 当前声明的 210。

## 本轮已通过

- 当前源码指纹下，真实 API HTTP → 签名 reconcile worker → PostgreSQL application role → Redis 工作区租约的隔离验收通过。覆盖未签名、错误角色、跨租户拒绝、支付只入账一次、退款成功/失败/未知、并发互斥、租约替换后 fail-closed 和持久审计。外部支付边界为本轮独立 localhost 状态 stub，真实支付和真实退款调用均为 0。证据：`artifacts/payment-reconciliation/run-DhXjCp/run-result.json`。
- 支付对账与迁移定向回归在最终复核时为 2 文件、46 项通过；此前发布配置相关定向回归为 9 文件、229 项通过。全项目 `npm run typecheck` 退出 0，`git diff --check` 退出 0。
- `npm run test:release-gates` 退出 0：128 文件、597 项通过。该默认入口中 7 个 PostgreSQL 文件共 14 项按设计跳过，不能作为数据库验收证据。
- 新建隔离 PostgreSQL 17 后，`npm run test:postgres:isolated` 共 20 文件、21 项全部通过，包含迁移 210 的 MCP OAuth 主体绑定、RLS/ACL 最小权限和跨成员商业支付隔离。证据：`artifacts/isolated-postgres/run-Yr6axi/`。
- 当前源码执行桌面 Chrome 验收：原 1440×900 四项继续有效；本轮新增 RBAC 矩阵 5/5 通过，并以隔离 PostgreSQL 17、Redis、签名 OIDC、当前 API/UI 再跑总览、用户和账务页面 2/2 通过。模型状态 503 不误报可用，隔离资源 `leftRunning=[]`。新增证据：`artifacts/ops-jit-isolation/2026-09-15T03-25-57.932Z-f4fa19b4-f18a-410e-a778-048a72a790a0/`。
- 以上隔离验收自建的 PostgreSQL/Redis 容器均已按精确运行标识清理，`leftRunning=[]`；没有触碰共享容器、业务数据、真实支付或真实模型。
- 本轮 owner 对所有新增业务改动重跑 6 文件、280 项定向测试，全部通过。并行专项另通过：Ops 前端 612 项、Ops API/RBAC 54 项、商家链路 332 项、MCP 链 115 项、安全边界 417 项、中转模型多组定向回归及全项目类型检查。
- 迁移审计集合再次在隔离 PostgreSQL 17 上 20 文件、21 项全部通过，证据：`artifacts/isolated-postgres/run-HPQyP2/`。扩展 70 文件集合为 65 passed、3 failed、2 skipped；失败来自本机 PostgreSQL 16.15 客户端与 17.11 服务端不匹配触发 fail-closed，并伴随 teardown 57P01，不能把扩展集合表述为全绿。

## 当前阻断

1. 当前 ChatGPT Store Nova bridge 进程仍使用旧令牌，初始化、引导、工作区健康和历史任务读取均返回权限拒绝。必须完全重启 ChatGPT、新建任务并刷新与源码一致的安装缓存后复验；写操作保持关闭。
2. 共享本地 API、replica、六类 worker、PostgreSQL、Redis、ClamAV 和两个 UI 均为 healthy，但共享数据库迁移尾为 209，当前工作区迁移尾为 210。这只证明旧部署健康，不证明本轮源码已部署。
3. 支付对账 worker 本地链路已修复，但支付宝真实小额支付、签名 callback、查单、退款和对账回执仍缺，不能把 localhost provider stub 当作生产 canary。
4. 知识库生产 PostgreSQL/embedding/index worker/跨副本检索与插件实际消费证据仍缺。
5. 五模态真实中转证据存在但绑定旧 release；当前源码 release 校验明确失败，最终 SHA 冻结后必须重跑真实鉴权、请求、用量、成本和错误 canary，并更新当前 evidence 路径。
6. 当前没有目标生产配置文件，未执行最终 `infra:launch-preflight`、部署后一致性检查和生产 canary。

## GO 前的唯一顺序

先完全重启 ChatGPT 并刷新最终插件安装缓存，在新任务中证明初始化、151 项商家工具清单、引导和任务历史均来自同一最终 digest；随后部署迁移 210 与当前 API/worker 镜像并复核运行版本；再使用批准的测试商家完成支付宝小额闭环、知识库跨副本检索、当前 release 五模态中转成本和商家发布 canary；最后带目标生产配置运行 launch preflight。任何一步未通过都保持 NO-GO。
