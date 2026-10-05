# 商业销售迁移、混跑与兼容回滚门禁

依据：套餐 PRD §14/§17、C6。实现模块 `apps/api/src/commercial-runtime-policy.ts`。本文件及单测不是部署验收记录。

## 已有事实与缺口

260 建立独立销售指针：仅唯一已批准、可执行且已生效版本可初始进入在售；历史歧义保持 unlisted，最近下架保持 off_sale，未自动选择最高批准版本。259 的新订单通过受控销售读取及同事务行锁建单；261 保留收款、分配及源退款事实；262 独立通知 outbox；263 账户激活与付费资格分离。原有事实没有依赖删表回退。

初查未有统一运行模式、人工目录审计证明或混跑实例证明门禁。新增模块提供默认关闭的新写入门禁；owner 必须接实际 HTTP/MCP/worker。实例旧代码若不支持此门禁，不得与开放新写实例同时对外服务，部署层应先摘除其新商业写路由。单进程检查不能阻挡完全不调用门禁的旧实例。

## 目录人工审计

先置 compatibility。应用 expand 迁移及最小权限 bootstrap，保留所有现金、订单、grant、gift、退款意图、审计与 outbox。按每个 sku 对照：历史全部版本、原审批证据、当前指针、visibility/capability、价格/周期/rank、真实消费者政策及权益包冻结引用。歧义、缺原批准证据、未决政策不得人工凭最高 version 放行。修正通过批准新版本与明确发布服务，禁止直接改事实。

形成受控人工审计工件和 SHA256，记录操作人、批准人、候选代码 SHA256、schema SHA256、目录结果及拒绝原因。商品值批准与真实首购/升级/未来续期/收款恢复/通知/权限/赠点/退款/混跑验收分别留证；无批准工件保持阻断。

## 服务端接线契约

`createCommercialRuntimePolicy(input, verifyDeploymentEvidence)` 返回可信服务端只读 policy，未配置默认 compatibility。sale 必须有 approvedEvidenceRef、catalogManualAuditRef/catalogAuditSha256、runtimeAcceptanceRef、fleetEvidenceRef、candidateSha256、schemaSha256，所有 activeInstances 明确同 candidate/schema 与 `commercial.sales.v3`。verifier 必须解析可信部署证据并比较真实当前 fleet；不得将环境布尔或客户端 JSON 当 verifier。fleet 变化需重新验证，失效先关新写。

实际加载使用 `loadCommercialRuntimePolicy(config, observeFleet)`；`commercialRuntimeEvidenceConfig(env)` 读取 `COMMERCIAL_RUNTIME_EVIDENCE_PATH`（绝对路径受控 JSON）、`COMMERCIAL_RUNTIME_EVIDENCE_SHA256`（部署固定文件 hash）、`COMMERCIAL_RUNTIME_CANDIDATE_SHA256`、`COMMERCIAL_RUNTIME_SCHEMA_SHA256`、`COMMERCIAL_RUNTIME_FLEET_ATTESTER_REF`。采用 `readSafeRuntimeEvidenceFile` 的文件限制。JSON 外层为 schema=`commercial.runtime.evidence.v1`、issuedAt、expiresAt、fleetAttesterRef、policy。有效期最多 15 分钟；每次新写前重新加载/观察，不能只缓存启动时观察结果。

`CommercialFleetObserver = () => Promise<readonly {instanceId:string;salesProtocol:string;candidateSha256:string;schemaSha256:string}[]>`，由部署 attester 枚举所有 ingress 活跃商业 API 实例，再获取真实观察结果；不得由 client 选择 URL 集合。模块严格比较完整实例集合，不接受 subset、重复实例、候选/schema 不一致、过期或未固定 hash。hash 固定只证明部署配置所批准的文件完整性，实际批准工件真实性仍由部署配置与受控发布过程承担。旧 API 不执行模块时必须在 ingress 关闭旧新购路由，不能声称模块已阻挡旧实例。

## 部署观察与租约自动续期

`createCommercialFileFleetObserver({path,attesterRef,production:true})` 使用部署写入的观察文件；API 无 Docker socket。生产文件及全部父目录必须 root 拥有、无 group/world 写权限、无 symlink。观察 schema 为 `commercial.fleet.observation.v1`，包含 attesterRef、capturedAt（最多旧 15 秒）、completeInventory=true、inventory（完整实际 hostname 集合）、instances。inventory 与观察实例必须完整一致。挂载整个受控证据目录为只读，避免单文件 bind mount 因原子 rename 固定旧 inode。观察路径由部署配置注入 observer，不取 policy.activeInstances 当实际。

部署 host root 执行 `node --import tsx scripts/commercial-fleet-attester.ts /etc/merchant-commercial/attester-config.json`。该 JSON 必须 rootowned/nonwritable，字段：project（实际 Compose project）、apiPort（实际容器端口）、attesterRef、observationPath、approvalTemplatePath、approvalTemplateSha256、evidencePath、pinPath、candidateSha256、schemaSha256。输出路径放 `/run/merchant-commercial` 等 rootowned 0755 目录；不能放任何可由 API 用户写入的目录。API 配 `COMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH=pinPath`，动态部署 pin 优先静态 hash；保留 candidate/schema/attester 固定预期值。只有部署 attester 可改 pin，API 无写权限。

工具从 `docker ps -a` 的整个 project 库存 inspect 所有 api/api-replica；未知 api-*、未运行 API、空集合均阻断，逐容器 `docker exec` loopback probe，抓取后重新比较实际库存。probe GET `/internal/commercial-runtime-attestation` 的 ApiEnvelope.data 必须返回 `{instanceId:hostname(),salesProtocol:'commercial.sales.v3',manifestSha256,schemaSha256}`，manifest 来自已校验运行 release，schema 来自真实数据库 `SHA256(JSON.stringify(schema_migrations升序rows.map([Number(version),checksum])))`；不是环境声明可替代。旧 API 无此支持即失败。工具不输出 Docker Env 或认证 secret；失败保留旧文件，观察最多 15 秒后自动失效。

批准模板是已批准受控 JSON `{approvedUntil,policy}`，template SHA 固定在部署 config，policy 含原审批/audit/runtime/fleet引用及candidate/schema hash；approvedUntil 是原审批所批准的截止，不得 API 自延长。部署 attester 每次只续 15 分钟短运行 lease，且不超过 original approvedUntil；不能自动延长业务批准。文件与动态 pin 原子替换短窗口可能暂时拒绝新写，不能放宽 hash 验证。

用部署 systemd oneshot service 调上述命令、root User、Timer `OnBootSec=1s`、`OnUnitInactiveSec=5s`、`AccuracySec=1s`、`Persistent=false`，service stdout/stderr仅状态；实际 Node、仓库、config绝对路径由发布runbook填写。timer 只续同一原批准，不需要每15分钟人工重批。原审批到期或观察失败即新写 closed，合法履约保持；正式新批准需替换受控模板和固定templatehash。启动后必须核对全实际 ingress/API库存及反代路由，证明没有跨project/旧实例新购旁路；本工具仅覆盖配置的真实project，不能声称证明外部未纳入的入口。

### 实际 ECS 渲染与 host 准备

生产固定 layers 保持原顺序。`render-ecs-production-compose.sh` 在实际 `docker compose config` 后调用 `apply-commercial-runtime-compose.mjs`，demo candidate renderer 复用同模块，新增显式可选 `--commercial-runtime-env /etc/merchant-commercial/compose-runtime.env` 受控rootowned0600独立配置文件；原 `--root-env` 仍只能包含relay key，不扩宽secret文件。API 与存在的 api-replica 同时注入全部门禁变量。HOST_DIR 空时不创建额外挂载、paths为空，因此普通 local/默认 candidate 不依赖不存在的 host 目录，商业新写 closed，health 不受此配置影响。配置 HOST_DIR 时要求现有 canonical/rootowned/nonwritable 祖先目录，挂 `/run/merchant-commercial` 整目录 read_only、create_host_path=false；不自动创建假证据目录。证据paths必须为挂载目录下的canonical路径。

部署 root 准备步骤（执行前变量必须来自真实候选与原审批工件，不能填假批准）：

```sh
# CANDIDATE_ROOT / NODE_BINARY 是实际受控绝对路径；项目/端口来自实际
# Compose inventory；ORIGINAL_APPROVAL_FILE 必须为真实已批准模板。
# CANDIDATE_SHA256 是真实 verified release manifest SHA256；
# SCHEMA_SHA256 是真实 probe 所示 schema checksum hash，不能只填263。
node "$CANDIDATE_ROOT/infra/scripts/install-commercial-attester.mjs" \
  "$CANDIDATE_ROOT" "$NODE_BINARY" "$COMPOSE_PROJECT" "$API_PORT" \
  "$FLEET_ATTESTER_REF" "$ORIGINAL_APPROVAL_FILE" \
  "$CANDIDATE_SHA256" "$SCHEMA_SHA256"
systemd-analyze verify /etc/systemd/system/merchant-commercial-attester.service \
  /etc/systemd/system/merchant-commercial-attester.timer
systemctl daemon-reload
```

installer 先完整检查所有目标再写，生成 rootowned config、env片段、systemd unit/timer及 tmpfiles，不启服务、不改 live Compose、不生成业务批准。任何已有目标在写入前阻断；写入失败按 inode 回滚本次新建文件/目录，保留原有配置与身份已变化的对象，输出 stage/created/preserved/rollbackErrors 供恢复审计。出现 preserved 或 rollbackErrors 不得直接重跑/删除配置，应先核对每个对象与阶段报告。审核 `/etc/merchant-commercial/compose-runtime.env` 后按现有受控生产 env 更新流程合并到真实 root-env，render 与部署兼容代码（新写仍closed）并核对两个实例只读挂载及真实 probe。由于无观察文件时新写closed，兼容代码可先启动；禁止用 dummy lease 强行开启。

```sh
systemctl start merchant-commercial-attester.service
systemctl enable --now merchant-commercial-attester.timer
systemctl status merchant-commercial-attester.timer --no-pager
```

先单次服务返回成功，再核验实际观察库存与批准工件、剩余 lease 与 old API ingress fence，最后按原发布授权开放。timer失效超过15秒即closed，不能通过修改时间/虚构fleet修复。重启 host 后tmpfiles恢复目录、timer继续同一原批准截止；候选/原批准更新需受控替换config与env并重新验证，不能无限续旧批准。

同候选新审批换代不重跑首次 installer、不覆写原业务审批工件：先停止 timer 和正在运行 attester，核验观察失效且所有入口禁新写；将旧 deployment config/env/unit与hash归档到 rootowned受控审计目录，保留现金/订单/grant/gift/退款事实。新真实审批以独立版本文件保存，核对 candidate/schema/原审计引用和 approvedUntil；准备新 config 指向该新文件及其固定 SHA，不能延长旧文件日期。通过受控发布流程比较旧 config SHA、防并发变更，然后在同目录以rootowned0600临时文件 fsync+atomic rename更换配置与env，并记录前后hash。原审批文件始终只读保留。候选不变时无需改systemd unit；候选路径改变时同步审核新unit、daemon-reload及兼容部署。最后单次真实 attester/probe/fleet/反代检查通过才启timer并开放，失败保持closed、恢复已归档旧配置亦须满足旧批准未过期及完整fleet条件，不能用回退配置绕过批准期限。

在实际执行前调用 `assertCommercialRuntimeOperation(policy, operation, persistedIntentEvidence)`，每个 HTTP/MCP/worker 支路均覆盖。persistedIntentEvidence 必须由服务端读取既有事实构造。

| operation | 应覆盖动作 | compatibility/rollback |
|---|---|---|
| new_purchase | 首购组合/新订单/续购/点包，包括 Ops 代购 | 拒绝 |
| new_upgrade | 新升级订单/创建新升级意图 | 拒绝 |
| new_quote | 新升级报价创建；原报价查询属 read | 拒绝 |
| catalog_publish | catalog mutate action=publish，独立包销售发布及产生新的发布通知 | 拒绝 |
| read | 目录/已购/未来/订单/收款/报价/账本查询 | 保留原授权查询 |
| record_cash | receipt.record、receipt.unmatched.record；真实流水记录及核验 | 保留；不自动建单或授予 |
| existing_fulfillment | 原存在冻结合法订单核验、收款分配及已付授予 | 需既有 intent id 与原合法履约有效证明 |
| existing_worker | 已有未来 grant 生效、赠点、到期、已有 outbox 重放 | 需既有 intent id 与合法 obligation 证明 |
| approved_refund_recovery | 已批准源退款/收款退回的外部执行或待同步恢复 | 需既有 intent id 与持久化 approval id |

草稿编辑/提交/审批/下架等目录管理仍走原权限，不能产生新订单或发布事件。新退款审批、替代新购、未知商业写入不应被归类为恢复；须明确独立策略，否则阻断。合法旧订单重复幂等请求可查询既有结果；不得以回放名义创建新合同。所有现有权限、到期、资金守恒与冻结源限制继续生效，门禁不授予额外权限。

## 开放与回滚

先部署兼容代码关闭新写，完成目录人工审计、全链及真实 fleet 验收，核对可信审批后允许 sale。回滚先所有入口同步切 rollback，核实没有旁路旧实例接受新单，再换兼容候选；保留 schema 与所有不可变业务事实。继续核验合法原单、已付授予、已有赠点/到期及批准退款恢复，不删除数据/容器、不清余额、不复制订单。外部返款结果未知只查询原意图，已成功本地未提交只恢复同事实。

验证必须包含：旧实例协议出现时所有新写拒绝；未配批准证据拒绝；回滚时现金可记录但新订单拒绝；原单履约/未来grant/赠点继续；批准退款待同步重放不二次返款。模块 8 单测含真实受控临时文件 hash/过期/fleet 集合加载测试，仅证明策略判定，运行证据由 owner 实际接线和环境验收补充。
