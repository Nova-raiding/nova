-- 170_commercial_refund_events: immutable commercial-order refund evidence.
-- A refund is not inferred from a legacy wallet refund. Every state change
-- requires an append-only event, policy evidence, and an external refund
-- reference before the V2 order can become refunded.

CREATE TABLE commercial_refund_events_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  event_type TEXT NOT NULL CHECK (event_type IN ('requested', 'approved', 'rejected', 'completed', 'reconciliation_required')),
  refund_kind TEXT NOT NULL CHECK (refund_kind IN ('onboarding_pre_deployment', 'monthly_unused_points', 'point_pack_unused_points', 'outage_compensation', 'custom_milestone')),
  amount_fen BIGINT NOT NULL CHECK (amount_fen > 0),
  points_to_revoke BIGINT NOT NULL DEFAULT 0 CHECK (points_to_revoke >= 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  actor_id TEXT NOT NULL CHECK (length(trim(actor_id)) > 0),
  evidence JSONB NOT NULL CHECK (evidence <> '{}'::jsonb),
  external_refund_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_id, revision),
  CONSTRAINT commercial_refund_events_v2_order_fk FOREIGN KEY (workspace_id, order_id)
    REFERENCES commercial_orders_v2(workspace_id, id),
  CHECK (event_type <> 'completed' OR (external_refund_id IS NOT NULL AND length(trim(external_refund_id)) > 0)),
  CHECK (event_type <> 'approved' OR evidence ? 'policy_approval'),
  CHECK (event_type <> 'reconciliation_required' OR evidence ? 'reconciliation')
);

CREATE INDEX commercial_refund_events_v2_latest_idx
  ON commercial_refund_events_v2(workspace_id, request_id, revision DESC);
CREATE INDEX commercial_refund_events_v2_order_idx
  ON commercial_refund_events_v2(workspace_id, order_id, created_at DESC);

ALTER TABLE commercial_refund_events_v2 ENABLE ROW LEVEL SECURITY;
ALTER TABLE commercial_refund_events_v2 FORCE ROW LEVEL SECURITY;
CREATE POLICY commercial_refund_events_v2_workspace_isolation
  ON commercial_refund_events_v2
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

CREATE OR REPLACE FUNCTION reject_commercial_refund_event_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial refund events are append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER commercial_refund_events_v2_append_only
  BEFORE UPDATE OR DELETE ON commercial_refund_events_v2
  FOR EACH ROW EXECUTE FUNCTION reject_commercial_refund_event_mutation();
CREATE TRIGGER commercial_refund_events_v2_no_truncate
  BEFORE TRUNCATE ON commercial_refund_events_v2
  FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_refund_event_mutation();

DO $commercial_refund_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON commercial_refund_events_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT ON commercial_refund_events_v2 TO merchant_ops;
    REVOKE UPDATE, DELETE, TRUNCATE ON commercial_refund_events_v2 FROM merchant_ops;
  END IF;
END
$commercial_refund_acl$;
