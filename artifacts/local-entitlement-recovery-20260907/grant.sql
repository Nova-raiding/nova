BEGIN;
SELECT pg_advisory_xact_lock(hashtext('local-entitlement-ws_be87dca95d714bc1bbdb6c21'));
INSERT INTO commercial_orders_v2 (
  id, workspace_id, sku_id, sku_version_id, amount_fen, currency,
  payment_provider, status, idempotency_key, request_hash, created_by_actor_id
)
SELECT
  'order_local_acceptance_20260907_subscription', 'ws_be87dca95d714bc1bbdb6c21', s.id, v.id, 0, 'CNY',
  'local_fixture', 'pending', 'authorized-local-entitlement-20260907', '0cf97359f4ab22d408b06bd9c26a45a7de5f5e47614563a8521d4b40869aa27b',
  'user_authorized_local_acceptance_20260907'
FROM commercial_catalog_skus s
JOIN commercial_catalog_sku_versions v ON v.sku_id = s.id
WHERE s.code = 'basic' AND v.version = 1
ON CONFLICT (workspace_id, id) DO NOTHING;

INSERT INTO commercial_order_snapshots_v2 (
  id, workspace_id, order_id, sku_id, sku_version_id, catalog_checksum,
  snapshot, checksum
)
SELECT
  'order_snapshot_local_acceptance_20260907_subscription', o.workspace_id, o.id,
  o.sku_id, o.sku_version_id, v.checksum,
  jsonb_build_object('source', 'user_authorized_local_acceptance_20260907', 'productionEvidence', false),
  '69fab533dc2a27e55ae7a82d9977a36939886ba51ccddd17ab9929241e336a3b'
FROM commercial_orders_v2 o
JOIN commercial_catalog_sku_versions v ON v.id = o.sku_version_id
WHERE o.workspace_id = 'ws_be87dca95d714bc1bbdb6c21' AND o.id = 'order_local_acceptance_20260907_subscription'
ON CONFLICT (workspace_id, id) DO NOTHING;

INSERT INTO workspace_subscription_periods_v2 (
  id, workspace_id, order_snapshot_id, period_start, period_end, status, revision
)
VALUES (
  'subscription_period_local_acceptance_20260907', 'ws_be87dca95d714bc1bbdb6c21',
  'order_snapshot_local_acceptance_20260907_subscription',
  date_trunc('month', now()), date_trunc('month', now()) + interval '1 month',
  'active', 1
)
ON CONFLICT (workspace_id, id) DO NOTHING;

INSERT INTO workspace_entitlement_snapshots_v2 (
  id, workspace_id, subscription_period_id, subscription_period_revision,
  catalog_version_id, resolved_benefits, unresolved_blockers, executable,
  checksum
)
SELECT
  'entitlement_snapshot_local_acceptance_20260907', 'ws_be87dca95d714bc1bbdb6c21',
  'subscription_period_local_acceptance_20260907', 1, v.id,
  '[{"code":"max_brands","quantity":1},{"code":"max_stores","quantity":5}]'::jsonb,
  '[]'::jsonb, true, '4d2ff8bec792c57df243fa846db7c5eedd13c5b735d85b4aa4cdef0d1ae9ba68'
FROM commercial_catalog_sku_versions v
JOIN commercial_catalog_skus s ON s.id = v.sku_id
WHERE s.code = 'basic' AND v.version = 1
ON CONFLICT (workspace_id, id) DO NOTHING;


INSERT INTO workspace_operation_audit(id,workspace_id,actor_id,action,resource_type,resource_id,before_json,after_json,reason)
VALUES ('eb9619f1-3536-48f3-8d88-ec74bc0ec5d0','ws_be87dca95d714bc1bbdb6c21','workspace_admin_demo','local_acceptance.entitlement.grant','subscription_period','subscription_period_local_acceptance_20260907',
'{"v2_entitlement_count":0}','{"local_fixture":true,"productionEvidence":false,"paymentMade":false,"pointsChanged":false,"source":"infra/local/seed-demo.sql","userApproval":"允许"}',
'用户明确允许为现有本地验收工作区补齐测试套餐权益；非生产证据，不代表付款或正式订阅。');
COMMIT;
