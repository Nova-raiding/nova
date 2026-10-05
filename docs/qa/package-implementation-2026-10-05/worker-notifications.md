# 商业发布通知实施证据

范围：迁移262、PostgresCommercialNotificationRepository及有界通知worker。API/server/worker-main由owner接线；未来套餐点数授予由交易/权益owner处理，本报告不声称已完成该链路。

发布事务写一笔commercial_catalog_publish_outbox（event_id UUID、sku_code、version、visibility、audience_workspace_id、payload、created_at）。同版本重新上架使用新event_id。不可变内容含旧价格/权益；修改仅允许cursor/lease/完成投影。

worker使用merchant_ops pool，每次runCommercialNotificationTick认领60秒租约，fanout最多200收件人。成员创建时间不晚于发布、状态active、关联身份active；event/member唯一，插入与游标推进同事务。失败回滚游标、租约到期恢复。每批成功重置失败计数；连续8次失败停止自动认领，backlog()可见exhausted和最老事件，需授权运营恢复原事件，禁止重建付款/权益事实。私人商品默认拒绝，必须注入真实本地权限authorizer；同authorizer用于读时复核。

读取list(workspaceId,trustedMemberId,{limit,cursor})默认50最大100，稳定published_at/event_id游标。返回items字段id,event_id,sku_code,version,title,body,published_at,payload；next_cursor为对象或null。RLS同时约束workspace及可信app.member_id，merchant_ops只在事务对应workspace内操作。API仍须真实用户鉴权和活跃身份复核，不能让请求自由指定member_id。当前销售状态需API从销售投影补充，历史通知不可冒充仍在售。

最小权限已追加infra/local/ensure-app-role.sql；runtime-db-role核验增加app全局outbox拒绝、通知只读、ops禁止销毁和通知精确RLS验证。两文件写入权已释放owner。

## 当前验证

- 10项单元/worker测试通过（两文件），最后执行11:28，覆盖200硬上限、成员/私有复核、错误回滚、陈旧租约和tick未知结果。
- 独立真实PostgreSQL测试早期两次通过，第二次11:27:36，201成员200+1分批、去重、私有撤权、不可变内容和app无全局outbox读取权限已观察。
- 在加recipient RLS及真实merchant_app跨企业/跨成员读取断言后，11:28与11:29两次测试30秒超时；11:30 pg_stat_activity证据显示仍在CREATE DATABASE阶段，本地Docker VM繁忙。最新新增RLS断言及policy精确文本校验尚未验证通过，必须由owner/QA在隔离PG就绪后重跑；不能用旧结果覆盖最新变更。
- 最初safe launcher按设计移除PG绑定，测试跳过被pending gate拒绝；未计通过。PG入口必须直接Vitest并保留PERSISTENCE_RELEASE_DATABASE_URL，且默认pending allowance需owner添加。
- persistence typecheck曾因并行交易owner尚未创建commercial-transaction-repository.js报错；无通知文件类型错误，不宣称整体typecheck通过。
- sh -n infra/scripts/verify-runtime-db-role.sh与本范围git diff --check通过。完整migration+post-bootstrap+真实API/桌面通知/部署仍待owner集成验收。

## 安全PG重跑

通过Node child_process.execFileSync('docker',['inspect','local-postgres-1'])在内存解析Config.Env，构造127.0.0.1:54329 PostgreSQL URL，以环境PERSISTENCE_RELEASE_DATABASE_URL传给npx vitest run --no-file-parallelism packages/persistence/src/commercial-notification-repository.release.postgres.test.ts --reporter=default，不打印URL/环境凭证。测试仅创建随机commercial_notify_<UUID>隔离数据库，finally关闭池并删除其自身数据库，不修改业务数据库。最新超时时需先只检查该前缀是否遗留，禁止删除其它数据来解决问题。

## gstack工程自查

按review的SQL安全、事务和条件副作用问题审查：发布仅append event；fanout无网络调用、租约与唯一键可重放；权限复核失败不送private；失败无游标提交；新表不扩全局tenant读权限；post-bootstrap blanket grant已覆盖。剩余明确问题是root接线/真实最新RLS与完整门禁未验，不能签clean或称生产完成。

## 实际worker接线（11:47）

apps/worker/src/main.ts新增postCommercialNotificationTick，经现有fetchWorkerApi + workerAuthIntent使用reconcile签名POST /v1/internal/commercial/notifications/tick；secret不会发出，缺api/token/signing/workspace明确错误，响应必须含可信批次计数（scanned≤200、delivered≤scanned、complete布尔、有扫描则eventId必有）。reconcile/all在真实poll轮内对Workspace并行调度已有开通赠点与PostgresCommercialContractRepository.dispatchDueScheduledGrants，每企业/方法上限100。两执行器独立汇总完成/失败/发放/过期/取消，失败会写真实错误日志；通知每poll只执行一笔全局有界tick，失败保留failed/code，不影响合法已售赠点维护。

专属apps/worker/src/commercial-notification-scheduling.test.ts 6测试于11:46:57通过：真实回调鉴权签名方法/路径/workspace/body绑定、secret不直传、缺配置不请求、401/403/503与不合法结果不冒成功、有界调度及同步/异步局部失败不阻断另一执行器。测试为worker本体函数入口、注入HTTP/DB执行器，不替代真实PG/部署worker闭环。

该轮全项目tsc于回收时发现其它整合接口错误：commercial handler/ops purchase把{order,snapshot}当CommercialOrderV2；server Dependencies缺passwordAuthRepository；交易PG测试使用不接受的verified字段。输出仅收集前15条，不据此断言其它文件无误。过滤管道exit0不是tsc通过，owner完整npm typecheck为最终门禁。

## 历史bridge维护兼容修复（12:45）

owner授权后，main新增verifyCommercialWorkerMaintenanceSchema：旧bridge或真实观察prefix<263仅保持V2维护；新商业schedule和通知tick只在完整当前库存版本、逐项1..tail完整历史、真实非空checksum及verifyAppliedMigrations验证通过后启用。在实际dependencyState核验同轮更新启用状态，原assertBridgeStartupMigrationVersion保持不变。关闭新schedule/tick不关闭合法开通赠点；日志明确commercialMaintenance.enabled/reason，未执行的V3不伪称完成或失败。

onboarding dispatcher在同一tenant事务用shared hasCommercialRelationForVerifiedPrefix（receipt owner提供）判断259 recovery-hold关系：已存在始终保留两处冻结排除；缺时必须用真实schema_migrations完整连续prefix+checksum证明引入259之前的旧schema才走原V2查询；当前263缺表拒绝，SQL失败直接传播，不吞成空结果。

目标单元验证：worker scheduling 8项通过、onboarding gift 13项通过。新增覆盖真实bundled 257历史下原500点仍发放、当前表存在保持冻结排除、当前schema缺表拒绝、查询失败拒绝；worker仅完整checksums可开启新维护，旧bridge不查询V3而赠点仍调用。未启动PG/browser或全项目tsc，由owner统一真实gates复验。

历史worker桥fixture仅将automation tick响应从错误的data.result.executed改为当前真实producer的data.executed，保留原cleanup调用/签名/完整prefix断言。真实producer为http-internal-runtime-routes POST automation分支send({...automation,rule_sync})及automation-runtime直接executed结果；独立同用户automation-envelope严格契约与source未放宽。先前owned worker-255-automation.ready中unknown=1说明旧fixture响应被判非法，导致cleanup不执行，并非应删掉cleanup断言。

## 商业代办结果与通知已读（13:09，264待最终整合）

PRD运营代办完成后商家通知及上架未读/已读由新增264投递投影与append-only read/read-request事实补齐。结果源只读取同一workspace真实已提交的commercial.payment四类outbox；必须与commercial_payment_events_v2中verified paid、原订单金额/币种及provider_event_id一致，订单冻结SKU快照决定标题和版本。active / scheduled / awaiting_dependency / reconciliation_required分别显示立即生效、未来待生效、待依赖、已收款待处置，账户开通/权益包/套餐按真实kind区分。active文案描述该核验事务，不伪称当前仍有效。通知过程不创建付款、合同、资格或点数。

每workspace seed≤200，claim FOR UPDATE SKIP LOCKED，60秒租约，最多8次连续失败；收件人扫描≤200、event/member唯一、cursor与投递同事务，private默认拒绝。result tick通过现有reconcile签名接口明确purchase_result mode，与publication遗漏mode兼容；每真实workspace单独调用、失败计数及日志保留。商家feed合并两种通知，read_at为空表示未读；markRead用trusted member、实时active/visibility复核、每member事务锁和request幂等事实，只返回已提交read_at，同key不同notification拒绝，其他member不可代读。

目标验证于13:09:03运行，24项/3文件通过，git diff --check无错：repository 11、fanout 4、worker scheduling 9。新增result mode签名实际body绑定。上述注入端口单元验证不冒称真实PG运行。

真实PG测试文件现有2 case：原201-member publication/RLS/read测试；新增完整migration+真实rolebootstrap+actual catalog/contract/recordVerifiedPaymentAndGrant四状态→seed/fanout/read链，比较creative_point_grants投递前后不变，验证租户/member隔离与read幂等。按owner冻结要求，本轮未启动PG、浏览器、全项目编译或release gates，需QA后续实际执行；默认pending allowance应由owner改为2，不能把skip记pass。264迁移及post-bootstrap ACL/role verifier需整合冻结后才可宣称角色闭包完成。

### 264 权限闭包冻结（13:16）

owner随后明确授权后，在ensure-app-role.sql COMMIT前新增prefix-safe 264 ACL块：app完全不可访问result queue、result通知只读、自身read/read-request仅SELECT/INSERT；ops queue仅SELECT/INSERT/UPDATE租约及cursor，result通知仅SELECT/INSERT，read事实无权限。历史ACL原样保留。verify-runtime-db-role.sh新增精确member RLS验证（三表仅一条public permissive ALL policy，qual=with_check，workspace且member/self或ops），新增app违规DML/queue和ops不可破坏事实检查；新table只在实际存在时参与，保持历史prefix兼容。

仓储default authorizer限定已注册membership角色且public，未知role拒绝；root仍按contracts canonical capabilities注入实际billing.self.read能力判断，private无真实授权proof拒绝。新增CommercialNotificationError公开code/status，markRead把未知存储异常转为503 STORAGE_UNAVAILABLE，不泄露SQL；not-visible404、会员不可用403、幂等冲突409、输入400、提交结果未知503。

scoped `npx tsc -p packages/persistence/tsconfig.json --noEmit` exit0；三文件24项于13:15:40通过，随后增加未知role和typed storage failure两项后repository 13项于13:15:59通过（最终合计26项：repository13/fanout4/worker9）；bash -n及git diff --check通过。未执行真实PG及全项目门禁，SQL策略实际pg_get_expr与权限需统一QA验证。264 SQL hash仍为ef962eb7ef1cba894f622b32e7b43962b6ccdb121b1ddbba822f404d57fbe83a。
