-- 123_commercial_order_snapshots: freeze the commercial intent at order creation.
-- Existing orders are backfilled from their immutable order columns; no business
-- rows are deleted or rewritten.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS commercial_order_snapshots (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL UNIQUE REFERENCES workspace_subscription_orders(id) ON DELETE CASCADE,
  snapshot JSONB NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO commercial_order_snapshots (id, workspace_id, order_id, snapshot, checksum)
SELECT gen_random_uuid(), o.workspace_id, o.id,
       jsonb_build_object(
         'schema_version', 1, 'order_no', o.order_no, 'plan_code', o.plan_code,
         'plan_name', o.plan_name, 'billing_cycle', o.billing_cycle,
         'price_cny', o.price_cny, 'payment_amount_cny', o.payment_amount_cny,
         'included_stores', o.included_stores, 'included_tasks', o.included_tasks,
         'coupon_code', o.coupon_code, 'addon_codes', o.addon_codes,
         'source_channel', o.source_channel, 'payment_provider', o.payment_provider
       ),
       encode(digest(jsonb_build_object(
         'schema_version', 1, 'order_no', o.order_no, 'plan_code', o.plan_code,
         'plan_name', o.plan_name, 'billing_cycle', o.billing_cycle,
         'price_cny', o.price_cny, 'payment_amount_cny', o.payment_amount_cny,
         'included_stores', o.included_stores, 'included_tasks', o.included_tasks,
         'coupon_code', o.coupon_code, 'addon_codes', o.addon_codes,
         'source_channel', o.source_channel, 'payment_provider', o.payment_provider
       )::text, 'sha256'), 'hex')
  FROM workspace_subscription_orders o
 WHERE NOT EXISTS (SELECT 1 FROM commercial_order_snapshots s WHERE s.order_id = o.id);

ALTER TABLE commercial_order_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_order_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS commercial_order_snapshots_isolation ON commercial_order_snapshots;
CREATE POLICY commercial_order_snapshots_isolation ON commercial_order_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_commercial_order_snapshot_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial order snapshots are immutable' USING ERRCODE = '55000';
END;
$$;
DROP TRIGGER IF EXISTS commercial_order_snapshots_immutable ON commercial_order_snapshots;
CREATE TRIGGER commercial_order_snapshots_immutable
  BEFORE UPDATE OR DELETE ON commercial_order_snapshots
  FOR EACH ROW EXECUTE FUNCTION reject_commercial_order_snapshot_mutation();
