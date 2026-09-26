# 上线准备只读复核（2026-09-26）

本记录更新 2026-09-25 的快照。核对范围为当前 `main` 工作目录、公开接口、101 主机的容器状态与受保护 evidence 目录文件名，以及本地发布门禁。它不是正式候选的生产验收证明。

## 已解决或不属于本次门禁

- 当前 `main` 的 `85dd26aa170b06f70c44dd8e9ff76c4a4484245d` 已加入 Qwen embedding 中转客户端与合同测试。关键词知识库检索可在向量索引关闭时使用；向量索引继续按 `docs/runbooks/knowledge-embedding-production.md` 的真实鉴权、预算、用量与成本证据门禁启用，不能把旧线上 `model_missing` 解释为当前源码未实现。
- 本次发布允许 `CAPACITY_PROFILE=no_load` 的正式未执行声明，不要求压测或容量承诺。声明仍需绑定当前 release 并进入签名 evidence bundle。
- 告警接收人、paging 和值班演练已明确排除在本次上线门禁之外。
- 公开 `https://yxsona.com/api/healthz`、`/api/readyz` 和运营后台 `/healthz` 在本次检查中返回成功；公开 `/api/releasez` 返回 `release-183fc04e5a62-image`，Git SHA 为 `183fc04e5a6292a63e01e02a3d168ce83ad350fe`。

## 当前实际运行边界

- 公开路由使用 `merchant-demo-85575f9c` Compose 项目的 API 镜像，镜像 revision 为 `183fc04e5a6292a63e01e02a3d168ce83ad350fe`。它不是当前 `main` 候选。
- 101 上另有 `merchant-production-api-replica-1`，仍使用 `storenova-api:qa-merchant-ec3d69e3`，Docker 状态为 `unhealthy`。其日志中的 `/readyz` 返回 503 `SCANNER_NOT_READY`。正式 `merchant-production-worker-scan-1` 的最新心跳显示数据库、API、Redis、ClamAV 定义和 EICAR 正常，但 `scanner_callback_not_capable` 与 `scanner_callback_stale` 仍存在。公开演示路由的 200 不能作为这组正式容器的健康证明。
- 公开健康响应中的 `productionEvidence.capability` 与 `productionEvidence.capacity` 均为 `blocked`，原因分别为 `CAPABILITY_EVIDENCE_PATH cannot be read` 和 `CAPACITY_REPORT_PATH cannot be read`。响应里的 `productionGate=true` 不能替代发布证据门禁。
- 已检查的 `/var/lib/merchant-release-security/evidence` 目录只有旧 release 的证据文件；未见绑定当前 `85dd26aa…` 的证据。旧 `release-20260923-ff4030f3` 的五模态汇总文件还标为 `.blocked`。不能由此断言其他受保护位置绝无证据，正式 preflight 必须以指定路径逐项验证。
- 当前工作树仍有未提交改动，不能运行要求干净提交的候选打包流程。本机 `security find-identity -v -p codesigning` 返回 0 个有效身份；旧 `artifacts/local-plugin/*final.dmg` 经 `codesign --verify` 为未签名，`spctl` 拒绝。正式客户 Mac 包须在具备签名与公证条件的发布机重新构建。

## 本轮本地验证

- `npm run typecheck` 在补丁前后均完整退出 0。
- `npm run test:release-gates` 完整退出 0：Vitest 为 1,124 passed、16 个按清单跳过；随后隔离 nonce、Bridge B、staging 工具链、旧运行环境和支付 callback replay 脚本均通过。
- 人工发布证据采集器补回对矛盾的 `official_api_receipt=true` 报告的拒绝。相关人工证据与公共规则边界定向测试为 29/29 通过，`git diff --check` 通过。
- 上述自动化结果不证明真实 ChatGPT Desktop 15 场景、真实支付闭环、五模态当前 release 用量/成本、备份恢复或生产切流已经完成。

## 进入发布的顺序

1. 复核并提交当前工作树，固定候选 Git SHA、release ID、镜像与 rendered Compose 摘要。
2. 在 101 隔离候选运行时采集并签署同一 release 的人工运营、`no_load` 声明、模型中转、真实 ChatGPT Desktop、支付、对象存储、恢复及 canonical cutover 证据；逐项通过正式 preflight。扫描 callback 须由真实隔离素材产生，不能改写心跳或回执。
3. 核对旧正式容器状态和回滚 capsule，按故障修复发布边界处理旧 `/readyz` 503；不得把公开演示路由当成旧正式环境已恢复。
4. 生成当前源码的正式本地安装包并验证签名、公证和安装；完成桌面商家、运营、API/MCP、数据库/RLS、worker 与账务的同版本验收。
5. 按 `docs/runbooks/ecs-candidate-safe-sync.md` 执行受控部署；切流后核对公开 `/releasez` 四元组、`/readyz`、生产 canary 与真实 ChatGPT Desktop 宿主 smoke。

当前结论：本地发布门禁通过，生产发布仍为 **NO-GO**。关键剩余工作是候选冻结、正式生产扫描 callback、同一 release 的真实证据、客户安装包签名与切流验收。
