# 101 隔离候选端到端验收（2026-09-28）

## 范围与版本

- 由 owner 和九名分工 agent 覆盖商家桌面、运营桌面、API/MCP、插件、店铺代导入、品牌素材、模型成本、发布门禁及文件选择。
- 101 隔离候选 `release-674b7713-full-e2e`，完整提交 `674b7713bef9cedf5663eaf42c7975184ac9c85f`；六个 linux/amd64 OCI 镜像均按 digest 复制、逐层读回。隔离项目 `merchant-demo-674full` 使用独立 PG17/Redis、私网 API/前端、无公网端口；迁移尾号 255。候选运行证明保存在 101 受保护目录的 `merchant-candidate/runtime-attestation.json`，其中 `production_go=false`。
- 浏览器通过本机 SSH loopback 访问候选商家端 `127.0.0.1:18881` 和运营端 `127.0.0.1:18883/ops/`。运营端临时路径代理只为复现公网 `/ops/` 路由；候选 API 单独允许该本机测试 Origin。没有修改生产路由、业务数据库或生产容器。
- 此报告对应固定的 674b 镜像集。之后的 `main` 提交，尤其商家店铺读取修复 `6f157194`，尚未包含在这组镜像中，不能按此报告判作已部署验收。

## 已观察的真实链路

| 路径 | 结果与证据 |
| --- | --- |
| 镜像/运行身份 | 商家 UI、运营 UI 和 `/api/releasez` 一致返回 674b；`manifest_sha256=d73dae00f5c8b0e7bef599e3f821bb0a854ddcc83ce4301fc050fb6e36f849a5`，`image_set_digest=sha256:d0c5de11367fd9119d0b1ec798c836897e6dc65384f953eff91ee82b6f780d92`。候选 API/PG/Redis/UI 均通过容器健康检查。 |
| 商家登录和成员权限 | 隔离账号登录；成员列表读取、邀请、角色调整、停用后重新读取均通过。截图位于 `/private/tmp/storenova-674b7713-local-build/merchant-members-read.png` 与 `merchant-members-suspended.png`。浏览器记录到四个并发 MCP token 请求返回 200。 |
| 店铺和品牌 | 隔离工作区六平台没有店铺记录；京东详情明确显示无店铺。品牌保存被 `STORE_ONBOARDING_REQUIRED` 428 阻止，未写入品牌事实。旧候选空店铺页长期显示“未读取”，已在后续 main 提交 `6f157194` 修复，等待新镜像浏览器复测。 |
| 商家财务 | 钱包 0、无生效套餐符合隔离 fixture；创意点和储存空间配置缺失时显示“未读取”，没有伪造余额。人工发布状态 503、资产配额配置无效。 |
| 插件入口 | 隔离候选显示“连接 ChatGPT 本地插件”禁用、未验证；当前 101 缺可发布的签名/公证 macOS 安装包和本地助手，一键授权整链路未通过。隔离 API/Playwright 50 项通过不能代替实机 ChatGPT 新会话验收。 |
| 运营登录/授权 | 运营桌面静态资源经 `/ops/` 同源代理加载；密码登录和 `ops.session` 成功。未授 durable 角色时正确拒绝总览；通过候选授权仓库写入带 revision、append-only 事件的 `platform_admin` 和 `rules_admin` 后，总览、用户中心、商家工作区、入驻申请、店铺、财务六 SKU、客户交付表单校验、六平台规则、审计及存储空态均经真实浏览器读取。完整页面矩阵和 12 张以上截图在 `/private/tmp/storenova-674b7713-local-build/ops-e2e-report.md`。授权治理正向受指定管理员登录名限制，未覆盖。 |
| 模型计费 | 运营模型页显示 relay、五模态、成本与发布证据不完整；倍率无法读取，保存禁用。已配置中转 token 过期且余额/额度不符合有限正值门禁，真实计费请求未执行。 |
| 店铺代导入 | 独立隔离 Chrome E2E 验证错误来源 XLSX/CSV 拒绝、正确来源 XLSX 导入并由商家读取；未向生产导入。详见 `docs/qa/2026-09-28-store-import-e2e-matrix.md`。 |

## 生产判定

- 公网 `/api/healthz` 和运营 `/healthz` 均 200，但 `/api/releasez` 仍是旧 `f48c8454`；101 公网 demo PG16 迁移尾 254，且 API、worker、运营 UI、支付与网关来自不同提交。101 当前不是上述候选镜像，也不是最新 `main`。
- 254→255 保护桥目前只有测试/隔离验证，没有接入现网生产入口、完整前向切流和恢复；受保护发布判断为 **NO-GO**。不得用普通部署流程直接迁移共享生产库。
- 贵人鸟素材 11 项未扫描，官方店铺缺真实授权凭证；规则与商品归属不能按隔离 fixture 宣称通过。`demo@ys.com` 的现金订单和成长版权益已由 101 只读核验，本轮未改动真实账户。
- 101 主机剩余约 36 GiB；未清理任何业务数据、容器卷或其他 agent 的候选环境。
- 浏览器验收完成后只停止本次 `merchant-demo-674full` 四个常驻容器和 `merchant-ops-674full-private`，保留隔离 PG/Redis 卷及受保护证据；本机测试 tunnel 和路径代理已关闭。
- 在并行桥接文件持续变动期间重跑最新 `main` 的 `npm run typecheck && npm run test:release-gates`：类型检查通过；release gates 的 Vitest 阶段 171 文件通过、7 跳过、2 失败。失败分别是新发布控制目标未更新安装器断言，以及新增 frozen-plan 测试尚未纳入入口清单。日志在 `/private/tmp/storenova-main-release-gates-20260928.log`。这个可变工作树测试不能作为最终固定 SHA 的通过证据。
- 随后补齐发布控制安装器断言及测试入口登记，定向复测 `ecs-release-control-installer` 与 `quality-entrypoints` 共 27/27 通过。全套门禁仍需对桥接工作全部提交后的固定 SHA 重跑。

## 未通过的最终用户目标

真正可用的一键插件授权需要可信安装包、本机协议注册、按钮授权、Keychain 落地、重启 ChatGPT 后新会话调用的完整实机证据；店铺与平台规则需要权威授权和人工核验；模型五模态需要有效中转 token、有限额度及真实成本证据；生产更新需要完成 254→255 受保护桥和恢复演练。以上均未达成，不能宣告全面可用或正式部署完成。
