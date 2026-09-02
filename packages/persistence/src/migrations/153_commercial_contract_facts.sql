-- 153_commercial_contract_facts: tenant-scoped V2 order, contract, payment,
-- provider and access-decision facts required by the commercial core.
-- No legacy task/wallet/add-on fact is converted into creative points. Rows
-- that depend on unresolved business policy default to blocked/pending.

ALTER TABLE creative_point_operations DROP CONSTRAINT IF EXISTS creative_point_operations_kind_check;
ALTER TABLE creative_point_operations ADD CONSTRAINT creative_point_operations_kind_check
  CHECK (kind IN ('grant', 'reserve', 'release', 'settle', 'refund', 'reverse', 'expire', 'adjust'));

ALTER TABLE creative_point_allocations DROP CONSTRAINT IF EXISTS creative_point_allocations_allocation_type_check;
ALTER TABLE creative_point_allocations ADD CONSTRAINT creative_point_allocations_allocation_type_check
  CHECK (allocation_type IN ('reserve', 'release', 'settle_adjustment', 'reverse', 'adjustment'));

ALTER TABLE creative_point_ledger_events DROP CONSTRAINT IF EXISTS creative_point_ledger_events_event_type_check;
ALTER TABLE creative_point_ledger_events ADD CONSTRAINT creative_point_ledger_events_event_type_check
  CHECK (event_type IN ('granted', 'reserved', 'released', 'settled', 'refunded', 'reversed', 'expired', 'adjusted'));

CREATE TABLE commercial_orders_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku_id TEXT NOT NULL REFERENCES commercial_catalog_skus(id),
  sku_version_id TEXT NOT NULL,
  amount_fen BIGINT NOT NULL CHECK (amount_fen >= 0),
  currency TEXT NOT NULL CHECK (currency = 'CNY'),
  payment_provider TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed', 'closed', 'refunded', 'reconciliation_required')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_by_actor_id TEXT NOT NULL,
  provider_order_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, provider_order_id),
  CONSTRAINT commercial_orders_v2_sku_version_fk
    FOREIGN KEY (sku_version_id, sku_id)
    REFERENCES commercial_catalog_sku_versions(id, sku_id),
  CHECK ((status = 'paid' AND paid_at IS NOT NULL) OR (status <> 'paid'))
);

CREATE TABLE commercial_order_snapshots_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  sku_id TEXT NOT NULL,
  sku_version_id TEXT NOT NULL,
  catalog_checksum TEXT NOT NULL CHECK (catalog_checksum ~ '^[0-9a-f]{64}$'),
  snapshot JSONB NOT NULL,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, order_id),
  CONSTRAINT commercial_order_snapshots_v2_order_fk
    FOREIGN KEY (workspace_id, order_id)
    REFERENCES commercial_orders_v2(workspace_id, id),
  CONSTRAINT commercial_order_snapshots_v2_sku_version_fk
    FOREIGN KEY (sku_version_id, sku_id)
    REFERENCES commercial_catalog_sku_versions(id, sku_id)
);

CREATE TABLE workspace_subscription_periods_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_snapshot_id TEXT NOT NULL,
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'expired', 'canceled', 'blocked')),
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, order_snapshot_id, period_start, period_end),
  UNIQUE (workspace_id, id, revision),
  CONSTRAINT workspace_subscription_periods_v2_snapshot_fk
    FOREIGN KEY (workspace_id, order_snapshot_id)
    REFERENCES commercial_order_snapshots_v2(workspace_id, id),
  CHECK (period_end > period_start)
);

CREATE TABLE workspace_entitlement_snapshots_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_period_id TEXT NOT NULL,
  subscription_period_revision BIGINT NOT NULL,
  catalog_version_id TEXT NOT NULL,
  rate_card_version_id TEXT REFERENCES creative_point_rate_card_versions_v2(id),
  resolved_benefits JSONB NOT NULL,
  unresolved_blockers JSONB NOT NULL DEFAULT '[]'::jsonb,
  executable BOOLEAN NOT NULL DEFAULT false,
  checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, subscription_period_id, subscription_period_revision),
  CONSTRAINT workspace_entitlement_snapshots_v2_period_fk
    FOREIGN KEY (workspace_id, subscription_period_id, subscription_period_revision)
    REFERENCES workspace_subscription_periods_v2(workspace_id, id, revision),
  CHECK (NOT executable OR unresolved_blockers = '[]'::jsonb)
);

CREATE TABLE private_trial_eligibilities_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  customer_ref TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending_business_approval'
    CHECK (status IN ('pending_business_approval', 'approved', 'rejected', 'expired')),
  approved_by_actor_id TEXT,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  expires_at TIMESTAMPTZ,
  revision BIGINT NOT NULL CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, customer_ref, revision),
  CHECK (status <> 'approved' OR (approved_by_actor_id IS NOT NULL AND evidence <> '{}'::jsonb AND expires_at IS NOT NULL))
);

CREATE TABLE private_trial_credits_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  trial_order_id TEXT NOT NULL,
  onboarding_order_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending_accounting_approval'
    CHECK (status IN ('pending_accounting_approval', 'approved', 'applied', 'rejected', 'expired')),
  amount_fen BIGINT NOT NULL CHECK (amount_fen = 500000),
  approval_evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, trial_order_id),
  UNIQUE (workspace_id, onboarding_order_id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT private_trial_credits_v2_trial_order_fk
    FOREIGN KEY (workspace_id, trial_order_id)
    REFERENCES commercial_orders_v2(workspace_id, id),
  CONSTRAINT private_trial_credits_v2_onboarding_order_fk
    FOREIGN KEY (workspace_id, onboarding_order_id)
    REFERENCES commercial_orders_v2(workspace_id, id),
  CHECK (status <> 'applied' OR (onboarding_order_id IS NOT NULL AND approval_evidence <> '{}'::jsonb AND applied_at IS NOT NULL))
);

CREATE TABLE onboarding_point_grant_schedules_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  onboarding_order_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  points BIGINT NOT NULL CHECK (points = 500),
  due_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  policy_ref TEXT,
  status TEXT NOT NULL DEFAULT 'blocked_policy_unresolved'
    CHECK (status IN ('blocked_policy_unresolved', 'scheduled', 'granted', 'canceled')),
  grant_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, onboarding_order_id, sequence),
  CONSTRAINT onboarding_point_grant_schedules_v2_order_fk
    FOREIGN KEY (workspace_id, onboarding_order_id)
    REFERENCES commercial_orders_v2(workspace_id, id),
  CONSTRAINT onboarding_point_grant_schedules_v2_grant_fk
    FOREIGN KEY (workspace_id, grant_id)
    REFERENCES creative_point_grants(workspace_id, id),
  CHECK (status = 'blocked_policy_unresolved' OR (due_at IS NOT NULL AND expires_at IS NOT NULL AND policy_ref IS NOT NULL)),
  CHECK (status <> 'granted' OR grant_id IS NOT NULL)
);

CREATE TABLE commercial_payment_events_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  event_type TEXT NOT NULL,
  verified BOOLEAN NOT NULL,
  amount_fen BIGINT NOT NULL CHECK (amount_fen >= 0),
  currency TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (provider, provider_event_id),
  UNIQUE (provider, nonce),
  CONSTRAINT commercial_payment_events_v2_order_fk
    FOREIGN KEY (workspace_id, order_id)
    REFERENCES commercial_orders_v2(workspace_id, id)
);

CREATE TABLE creative_point_provider_receipts_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_request_id TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed', 'unknown')),
  usage JSONB,
  cost JSONB,
  receipt_hash TEXT NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (provider, provider_request_id),
  CONSTRAINT creative_point_provider_receipts_v2_operation_fk
    FOREIGN KEY (workspace_id, operation_id)
    REFERENCES creative_point_operations(workspace_id, id),
  CHECK (outcome <> 'succeeded' OR (usage IS NOT NULL AND cost IS NOT NULL AND verified_at IS NOT NULL))
);

CREATE TABLE creative_point_reversals_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  original_reservation_id TEXT NOT NULL,
  reversal_kind TEXT NOT NULL CHECK (reversal_kind IN ('refund', 'reverse')),
  points BIGINT NOT NULL CHECK (points > 0),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, operation_id),
  CONSTRAINT creative_point_reversals_v2_operation_fk
    FOREIGN KEY (workspace_id, operation_id)
    REFERENCES creative_point_operations(workspace_id, id),
  CONSTRAINT creative_point_reversals_v2_reservation_fk
    FOREIGN KEY (workspace_id, original_reservation_id)
    REFERENCES creative_point_reservations(workspace_id, id),
  CHECK (length(trim(reason)) > 0 AND length(trim(actor_id)) > 0 AND evidence <> '{}'::jsonb)
);

CREATE TABLE creative_point_adjustments_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL,
  approval_id TEXT NOT NULL,
  points_delta BIGINT NOT NULL CHECK (points_delta <> 0),
  expected_access_revision BIGINT NOT NULL CHECK (expected_access_revision >= 0),
  access_revision_after BIGINT NOT NULL CHECK (access_revision_after > expected_access_revision),
  reason TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  approved_by_actor_id TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, operation_id),
  UNIQUE (workspace_id, approval_id),
  CONSTRAINT creative_point_adjustments_v2_operation_fk
    FOREIGN KEY (workspace_id, operation_id)
    REFERENCES creative_point_operations(workspace_id, id),
  CHECK (length(trim(reason)) > 0 AND actor_id <> approved_by_actor_id AND evidence <> '{}'::jsonb)
);

CREATE TABLE commercial_access_decisions_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  operation_key TEXT NOT NULL,
  access_class TEXT NOT NULL CHECK (access_class IN ('RECOVERY_CONTROL', 'POINT_REQUIRED_NO_CHARGE', 'POINT_CHARGED')),
  balance_state TEXT NOT NULL CHECK (balance_state IN ('known', 'unknown')),
  available_points BIGINT,
  reserved_points BIGINT,
  quoted_points BIGINT,
  access_revision BIGINT NOT NULL CHECK (access_revision >= 0),
  rate_card_version TEXT,
  allowed BOOLEAN NOT NULL,
  code TEXT NOT NULL CHECK (code IN ('OK', 'CREATIVE_POINTS_EXHAUSTED', 'CREATIVE_POINTS_INSUFFICIENT', 'CREATIVE_POINTS_UNAVAILABLE', 'RATE_CARD_UNAVAILABLE', 'COMMERCIAL_ACCESS_STALE')),
  next_actions JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  decided_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, request_id, operation_key),
  CHECK ((balance_state = 'unknown' AND available_points IS NULL AND reserved_points IS NULL)
      OR (balance_state = 'known' AND available_points IS NOT NULL AND available_points >= 0 AND reserved_points IS NOT NULL AND reserved_points >= 0)),
  CHECK (quoted_points IS NULL OR quoted_points > 0),
  CHECK ((allowed AND code = 'OK') OR (NOT allowed AND code <> 'OK'))
);

CREATE INDEX commercial_orders_v2_workspace_status_idx ON commercial_orders_v2(workspace_id, status, created_at DESC, id DESC);
CREATE INDEX commercial_periods_v2_workspace_status_idx ON workspace_subscription_periods_v2(workspace_id, status, period_end, id);
CREATE INDEX commercial_access_decisions_v2_statement_idx ON commercial_access_decisions_v2(workspace_id, decided_at DESC, id DESC);
CREATE INDEX creative_point_provider_receipts_v2_operation_idx ON creative_point_provider_receipts_v2(workspace_id, operation_id, created_at, id);

DO $commercial_contract_rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_orders_v2', 'commercial_order_snapshots_v2',
    'workspace_subscription_periods_v2', 'workspace_entitlement_snapshots_v2',
    'private_trial_eligibilities_v2', 'private_trial_credits_v2',
    'onboarding_point_grant_schedules_v2', 'commercial_payment_events_v2',
    'creative_point_provider_receipts_v2', 'creative_point_reversals_v2',
    'creative_point_adjustments_v2', 'commercial_access_decisions_v2'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      table_name || '_workspace_isolation', table_name
    );
  END LOOP;
END
$commercial_contract_rls$;

CREATE OR REPLACE FUNCTION reject_commercial_contract_fact_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'commercial contract fact is append-only' USING ERRCODE = '55000';
END;
$$;

DO $commercial_contract_immutable$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'commercial_order_snapshots_v2', 'workspace_entitlement_snapshots_v2',
    'commercial_payment_events_v2', 'creative_point_provider_receipts_v2',
    'creative_point_reversals_v2', 'creative_point_adjustments_v2',
    'commercial_access_decisions_v2'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_commercial_contract_fact_mutation()', table_name || '_append_only', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_contract_fact_mutation()', table_name || '_no_truncate', table_name);
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM PUBLIC', table_name);
  END LOOP;
END
$commercial_contract_immutable$;

DO $commercial_contract_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON commercial_orders_v2, workspace_subscription_periods_v2,
      private_trial_eligibilities_v2, private_trial_credits_v2,
      onboarding_point_grant_schedules_v2 TO merchant_app;
    GRANT SELECT, INSERT ON commercial_order_snapshots_v2, workspace_entitlement_snapshots_v2,
      commercial_payment_events_v2, creative_point_provider_receipts_v2,
      creative_point_reversals_v2, creative_point_adjustments_v2,
      commercial_access_decisions_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON commercial_order_snapshots_v2,
      workspace_entitlement_snapshots_v2, commercial_payment_events_v2,
      creative_point_provider_receipts_v2, creative_point_reversals_v2,
      creative_point_adjustments_v2, commercial_access_decisions_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON commercial_orders_v2, commercial_order_snapshots_v2,
      workspace_subscription_periods_v2, workspace_entitlement_snapshots_v2,
      private_trial_eligibilities_v2, private_trial_credits_v2,
      onboarding_point_grant_schedules_v2, commercial_payment_events_v2,
      creative_point_provider_receipts_v2, creative_point_reversals_v2,
      creative_point_adjustments_v2, commercial_access_decisions_v2 TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON commercial_order_snapshots_v2,
      workspace_entitlement_snapshots_v2, commercial_payment_events_v2,
      creative_point_provider_receipts_v2, creative_point_reversals_v2,
      creative_point_adjustments_v2, commercial_access_decisions_v2 FROM merchant_ops;
  END IF;
END
$commercial_contract_acl$;
