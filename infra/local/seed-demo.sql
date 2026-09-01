-- Local Compose only: keep the durable demo workspace accessible after the
-- production identity/member boundary is enabled. This seed is idempotent and
-- never ships in the production deployment manifests.
BEGIN;
SELECT pg_advisory_xact_lock(731942853);
SELECT set_config('app.workspace_id', 'ws_demo', true);

INSERT INTO workspaces (id, status, capacity_tier)
VALUES ('ws_demo', 'active', 'pilot_50')
ON CONFLICT (id) DO UPDATE SET status = 'active';

INSERT INTO workspace_members (
  id, workspace_id, external_subject, display_name, role, status, invited_by
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'ws_demo',
  'actor_demo',
  '本地演示工作区所有者',
  'workspace_owner',
  'active',
  'local_compose_seed'
)
ON CONFLICT (workspace_id, external_subject) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = now(),
  revision = workspace_members.revision + 1
WHERE (workspace_members.display_name, workspace_members.role, workspace_members.status)
  IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.role, EXCLUDED.status);

INSERT INTO workspace_members (
  id, workspace_id, external_subject, display_name, role, status, invited_by
)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'ws_demo',
  'support_demo',
  '本地演示支持专员',
  'support',
  'active',
  'local_compose_seed'
)
ON CONFLICT (workspace_id, external_subject) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = now(),
  revision = workspace_members.revision + 1
WHERE (workspace_members.display_name, workspace_members.role, workspace_members.status)
  IS DISTINCT FROM (EXCLUDED.display_name, EXCLUDED.role, EXCLUDED.status);

-- The remaining rows are read-only local fixtures. Fixed IDs and DO NOTHING
-- preserve operator changes and make repeated Compose starts deterministic.
INSERT INTO workspace_commercial_settings (
  workspace_id, plan_code, plan_name, monthly_price_cny, annual_price_cny,
  included_stores, included_tasks, usage_period_start, monthly_tasks_used, updated_by
)
VALUES ('ws_demo','demo_fixture','Local Demo (Fixture)',0,0,6,20,DATE '2026-08-01',3,'local_compose_seed')
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO workspace_subscriptions (
  workspace_id,status,plan_code,plan_name,billing_cycle,price_cny,included_stores,included_tasks,
  current_period_start,current_period_end
)
VALUES ('ws_demo','trialing','demo_fixture','Local Demo (Fixture)','monthly',0,6,20,
  '2026-08-01T00:00:00Z','2026-09-01T00:00:00Z')
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO workspace_platform_settings (workspace_id,platform,enabled,display_name,store_alias,updated_by)
VALUES
 ('ws_demo','jd',true,'京东 · Fixture','京东演示','local_compose_seed'),
 ('ws_demo','taobao',true,'淘宝 · Fixture','淘宝演示','local_compose_seed'),
 ('ws_demo','tmall',true,'天猫 · Fixture','天猫演示','local_compose_seed'),
 ('ws_demo','pinduoduo',true,'拼多多 · Fixture','拼多多演示','local_compose_seed'),
 ('ws_demo','xiaohongshu',false,'小红书 · 未验证 Fixture','小红书演示','local_compose_seed'),
 ('ws_demo','douyin',false,'抖音 · 未验证 Fixture','抖音演示','local_compose_seed')
ON CONFLICT (workspace_id,platform) DO NOTHING;

INSERT INTO platform_accounts (
 id,workspace_id,platform,remote_account_id,credential_ref,token_state,granted_scopes,
 credential_refreshable,credential_metadata_observed_at,token_state_updated_at,store_alias,created_at
)
VALUES
 ('fixture-store-ws_demo-taobao','ws_demo','taobao','demo_fixture_taobao_store','fixture://local-demo/taobao','connected',
  '["fixture:catalog.read"]',false,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z','淘宝 Fixture 店','2026-08-29T00:00:00Z'),
 ('fixture-store-ws_demo-xiaohongshu','ws_demo','xiaohongshu','demo_fixture_xhs_store','fixture://local-demo/xiaohongshu','refresh_required',
  '[]',false,'2026-08-29T00:00:00Z','2026-08-29T00:00:00Z','小红书未验证 Fixture','2026-08-29T00:00:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO brands (id, workspace_id, name, status, revision, data)
VALUES ('brand_release_qa', 'ws_demo', 'Release QA Brand', 'active', 1, '{"source":"local_compose_seed"}')
ON CONFLICT (workspace_id, id) DO UPDATE SET
  name = EXCLUDED.name,
  status = EXCLUDED.status,
  data = EXCLUDED.data,
  updated_at = now();

INSERT INTO brand_store_bindings (workspace_id, brand_id, platform, platform_account_id, status, revision)
VALUES ('ws_demo', 'brand_release_qa', 'taobao', 'fixture-store-ws_demo-taobao', 'active', 1)
ON CONFLICT (workspace_id, brand_id, platform_account_id) DO UPDATE SET
  status = EXCLUDED.status,
  updated_at = now();

INSERT INTO products (
 id,workspace_id,platform,platform_account_id,store_name,remote_product_id,title,sku_count,stock,price,
 category,images,attributes,facts_confirmed,source,version,data,created_at,updated_at
)
VALUES ('prod_demo_fixture_1','ws_demo','taobao','fixture-store-ws_demo-taobao','淘宝 Fixture 店','demo_fixture_product_1',
 '本地演示保温杯（Fixture）',2,36,89,'demo_fixture_category','[]',
 '{"provenance":"local_compose_seed"}',true,'fixture',1,
 '{"seed":"local_compose_seed","productionEvidence":false,"sourceAssetIds":[]}',
 '2026-08-29T00:05:00Z','2026-08-29T00:05:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state,version,data,created_at,updated_at)
VALUES
 ('task_demo_review','ws_demo','prod_demo_fixture_1','taobao','fixture-store-ws_demo-taobao','review_required',1,
  '{"seed":"local_compose_seed","productionEvidence":false}','2026-08-29T00:10:00Z','2026-08-29T00:10:00Z'),
 ('task_demo_retry','ws_demo','prod_demo_fixture_1','taobao','fixture-store-ws_demo-taobao','failed_recoverable',1,
  '{"seed":"local_compose_seed","productionEvidence":false}','2026-08-29T00:11:00Z','2026-08-29T00:11:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO business_entity_snapshots (workspace_id,entity_type,entity_id,entity_version,payload,created_at,updated_at)
VALUES
 ('ws_demo','platform_account','fixture-store-ws_demo-taobao',1,
  '{"id":"fixture-store-ws_demo-taobao","workspaceId":"ws_demo","platform":"taobao","remoteAccountId":"demo_fixture_taobao_store","credentialRef":"fixture://local-demo/taobao","tokenState":"connected","storeAlias":"淘宝 Fixture 店","createdAt":"2026-08-29T00:00:00.000Z","revision":1}',
  '2026-08-29T00:00:00Z','2026-08-29T00:00:00Z'),
 ('ws_demo','product','prod_demo_fixture_1',1,
  '{"id":"prod_demo_fixture_1","workspaceId":"ws_demo","platform":"taobao","accountId":"fixture-store-ws_demo-taobao","storeName":"淘宝 Fixture 店","remoteId":"demo_fixture_product_1","title":"本地演示保温杯（Fixture）","skuCount":2,"stock":36,"price":89,"images":[],"attributes":{"provenance":"local_compose_seed"},"factsConfirmed":true,"source":"fixture","updatedAt":"2026-08-29T00:05:00.000Z","version":1}',
  '2026-08-29T00:05:00Z','2026-08-29T00:05:00Z'),
 ('ws_demo','task','task_demo_review',1,
  '{"id":"task_demo_review","workspaceId":"ws_demo","productId":"prod_demo_fixture_1","platform":"taobao","accountId":"fixture-store-ws_demo-taobao","state":"review_required","requestText":"Fixture review demo; not for production","inputSnapshotId":"task:task_demo_review:v1","answers":{},"missingQuestions":[],"deferredQuestionIds":[],"deferredQuestions":[],"version":1,"createdAt":"2026-08-29T00:10:00.000Z"}',
  '2026-08-29T00:10:00Z','2026-08-29T00:10:00Z'),
 ('ws_demo','task','task_demo_retry',1,
  '{"id":"task_demo_retry","workspaceId":"ws_demo","productId":"prod_demo_fixture_1","platform":"taobao","accountId":"fixture-store-ws_demo-taobao","state":"failed_recoverable","requestText":"Fixture retry demo; not for production","inputSnapshotId":"task:task_demo_retry:v1","answers":{},"missingQuestions":[],"deferredQuestionIds":[],"deferredQuestions":[],"version":1,"createdAt":"2026-08-29T00:11:00.000Z"}',
  '2026-08-29T00:11:00Z','2026-08-29T00:11:00Z')
ON CONFLICT (workspace_id,entity_type,entity_id) DO NOTHING;

INSERT INTO rule_pack_versions (
 id,workspace_id,pack_id,name,version,scope,status,source_kind,source_reference,source_checked_at,
 checksum,checks,created_at,updated_at,created_by,revision,severity,action
)
VALUES ('rule_demo_fixture_v1','ws_demo','rule_demo_fixture','本地演示规则（Fixture，不激活）','demo-fixture-v1',
 'global','draft','internal','fixture://local-demo/rules/demo-fixture-v1','2026-08-29T00:00:00Z',repeat('d',64),
 '{"fixture":true,"productionEvidence":false}','2026-08-29T00:00:00Z','2026-08-29T00:00:00Z',
 'local_compose_seed',1,'warning','warn')
ON CONFLICT (workspace_id,id) DO NOTHING;

INSERT INTO workspace_operation_alerts (
 id,workspace_id,alert_key,code,severity,platform,account_id,entity_type,entity_id,title,status,
 observed_at,evidence_json,next_action,updated_at
)
VALUES ('00000000-0000-4000-8000-000000000101','ws_demo','demo:fixture:token-refresh','DEMO_FIXTURE_TOKEN_REFRESH',
 'medium','xiaohongshu','fixture-store-ws_demo-xiaohongshu','platform_account','fixture-store-ws_demo-xiaohongshu',
 '本地 Fixture：授权状态需要查看','open','2026-08-29T00:20:00Z',
 '{"source":"local_compose_seed","fixture":true,"productionEvidence":false}',
 '仅查看本地演示状态，不执行真实授权','2026-08-29T00:20:00Z')
ON CONFLICT (workspace_id,alert_key) DO NOTHING;

INSERT INTO workspace_operation_audit (
 id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason,created_at
)
VALUES ('00000000-0000-4000-8000-000000000201','ws_demo','local_compose_seed','demo.fixture.seeded',
 'workspace','ws_demo','{}','{"fixture":true,"productionEvidence":false}',
 '本地 Fixture，不代表生产证据','2026-08-29T00:21:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_support_tickets (
 id,workspace_id,ticket_number,subject,description,status,priority,customer_id,customer_name,assigned_to,
 related_task_id,tags,revision,create_idempotency_key,created_by,created_at,updated_at
)
VALUES ('00000000-0000-4000-8000-000000000301','ws_demo','DEMO-0001','本地 Fixture：任务状态说明',
 '本地演示工单，不对应真实客户或生产故障。','open','normal','demo_fixture_customer','演示客户（Fixture）',
 'support_demo','task_demo_review',ARRAY['demo','fixture','non-production'],1,'demo-support-ticket-0001',
 'local_compose_seed','2026-08-29T00:22:00Z','2026-08-29T00:22:00Z')
ON CONFLICT (workspace_id,id) DO NOTHING;

INSERT INTO workspace_support_ticket_events (
 id,workspace_id,ticket_id,sequence,event_type,actor_id,idempotency_key,payload_json,created_at
)
VALUES ('00000000-0000-4000-8000-000000000302','ws_demo','00000000-0000-4000-8000-000000000301',1,
 'created','local_compose_seed','demo-support-event-0001',
 '{"fixture":true,"productionEvidence":false}','2026-08-29T00:22:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO ops_incidents (
 id,workspace_id,title,summary,severity,status,commander_id,affected_components,affected_workspace_ids,
 revision,created_by,created_at,updated_at
)
VALUES ('00000000-0000-4000-8000-000000000401','ws_demo','本地 Fixture 演练事件',
 '仅展示事故时间线；不是生产事故。','sev4','monitoring','actor_demo',ARRAY['demo-fixture'],ARRAY['ws_demo'],
 1,'local_compose_seed','2026-08-29T00:23:00Z','2026-08-29T00:23:00Z')
ON CONFLICT (workspace_id,id) DO NOTHING;

INSERT INTO ops_incident_timeline (
 id,workspace_id,incident_id,kind,body,to_status,actor_id,incident_revision,created_at
)
VALUES ('00000000-0000-4000-8000-000000000402','ws_demo','00000000-0000-4000-8000-000000000401',
 'created','本地 Fixture 演练，不代表生产事故。','monitoring','local_compose_seed',1,'2026-08-29T00:23:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO billing_orders (
 id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,idempotency_key,created_at,updated_at
)
VALUES ('billing_demo_fixture_pending','ws_demo','alipay',100,'pending','fixture',
 'fixture://local-demo/payment/not-paid','demo-billing-fixture-pending','2026-08-29T00:24:00Z','2026-08-29T00:24:00Z')
ON CONFLICT (id) DO NOTHING;

INSERT INTO model_usage_ledger (
 id,workspace_id,modality,model,input_tokens,output_tokens,total_tokens,cost_cny,observed_at,metadata,
 receipt_key,settlement_status,receipt_hash,attempt_count,revision
)
VALUES ('model_demo_fixture_pending','ws_demo','text','fixture-model-not-production',12,8,20,NULL,
 '2026-08-29T00:25:00Z','{"source":"local_compose_seed","fixture":true,"productionEvidence":false}',
 'fixture://local-demo/model/pending','pending_cost',repeat('f',64),0,1)
ON CONFLICT (id) DO NOTHING;

-- Disabled globally and for ws_demo: visible to Ops, incapable of enabling a capability.
INSERT INTO platform_feature_flags (
 id,flag_key,environment,description,value_type,value_json,enabled,emergency_disabled,revision,
 created_by,updated_by,created_at,updated_at
)
VALUES ('00000000-0000-4000-8000-000000000501','demo.fixture.ops_readiness','local_demo',
 '本地 Fixture 展示开关；不是生产 evidence。','boolean','false',false,true,1,
 'local_compose_seed','local_compose_seed','2026-08-29T00:26:00Z','2026-08-29T00:26:00Z')
ON CONFLICT (flag_key,environment) DO NOTHING;

INSERT INTO platform_feature_flag_targets (id,flag_id,target_type,target_value,enabled,value_json,created_at)
VALUES ('00000000-0000-4000-8000-000000000502','00000000-0000-4000-8000-000000000501',
 'workspace','ws_demo',false,'false','2026-08-29T00:26:00Z')
ON CONFLICT (flag_id,target_type,target_value) DO NOTHING;

COMMIT;
