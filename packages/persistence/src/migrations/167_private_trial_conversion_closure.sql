-- 167_private_trial_conversion_closure: complete the private 1999/7d
-- operations flow without changing public catalog prices or treating an
-- operator action as payment.  The original 153 tables remain the immutable
-- business record; this migration adds the missing correlation and audit facts.

ALTER TABLE private_trial_eligibilities_v2
  DROP CONSTRAINT IF EXISTS private_trial_eligibilities_v2_status_check;
ALTER TABLE private_trial_eligibilities_v2
  ADD CONSTRAINT private_trial_eligibilities_v2_status_check
  CHECK (status IN ('pending_business_approval', 'approved_pending_validation', 'approved', 'rejected', 'expired'));
ALTER TABLE private_trial_eligibilities_v2
  ADD COLUMN IF NOT EXISTS business_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS validation_completed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS trial_order_id TEXT,
  ADD COLUMN IF NOT EXISTS payment_subject_ref TEXT;
ALTER TABLE private_trial_eligibilities_v2
  ADD CONSTRAINT private_trial_eligibilities_v2_trial_order_fk
  FOREIGN KEY (workspace_id, trial_order_id)
  REFERENCES commercial_orders_v2(workspace_id, id);
CREATE UNIQUE INDEX private_trial_eligibilities_v2_trial_order_unique
  ON private_trial_eligibilities_v2(workspace_id, trial_order_id)
  WHERE trial_order_id IS NOT NULL;
ALTER TABLE private_trial_eligibilities_v2
  DROP CONSTRAINT IF EXISTS private_trial_eligibilities_v2_approval_facts_check;
ALTER TABLE private_trial_eligibilities_v2
  ADD CONSTRAINT private_trial_eligibilities_v2_approval_facts_check
  CHECK (
    status = 'pending_business_approval'
    OR (approved_by_actor_id IS NOT NULL AND business_approved_at IS NOT NULL AND evidence <> '{}'::jsonb)
  );
ALTER TABLE private_trial_eligibilities_v2
  ADD CONSTRAINT private_trial_eligibilities_v2_verified_window_check
  CHECK (
    status <> 'approved'
    OR (trial_order_id IS NOT NULL AND payment_subject_ref IS NOT NULL AND validation_completed_at IS NOT NULL AND expires_at IS NOT NULL)
  );

ALTER TABLE private_trial_credits_v2
  ADD COLUMN IF NOT EXISTS eligibility_id TEXT,
  ADD COLUMN IF NOT EXISTS offset_fen BIGINT NOT NULL DEFAULT 199900,
  ADD COLUMN IF NOT EXISTS payable_fen BIGINT NOT NULL DEFAULT 300100,
  ADD COLUMN IF NOT EXISTS payment_subject_ref TEXT,
  ADD COLUMN IF NOT EXISTS accounting_approved_by_actor_id TEXT,
  ADD COLUMN IF NOT EXISTS accounting_approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE private_trial_credits_v2
  ADD CONSTRAINT private_trial_credits_v2_eligibility_fk
  FOREIGN KEY (workspace_id, eligibility_id)
  REFERENCES private_trial_eligibilities_v2(workspace_id, id);
ALTER TABLE private_trial_credits_v2
  ADD CONSTRAINT private_trial_credits_v2_conversion_amounts_check
  CHECK (amount_fen = 500000 AND offset_fen = 199900 AND payable_fen = 300100);
ALTER TABLE private_trial_credits_v2
  ADD CONSTRAINT private_trial_credits_v2_approval_facts_check
  CHECK (
    status NOT IN ('approved', 'applied')
    OR (accounting_approved_by_actor_id IS NOT NULL AND accounting_approved_at IS NOT NULL
      AND payment_subject_ref IS NOT NULL AND expires_at IS NOT NULL AND approval_evidence <> '{}'::jsonb)
  );

ALTER TABLE commercial_payment_events_v2
  ADD COLUMN IF NOT EXISTS payment_subject_ref TEXT;

CREATE TABLE private_trial_eligibility_events_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  eligibility_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('created', 'business_approved', 'validation_bound', 'expired', 'rejected')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, eligibility_id) REFERENCES private_trial_eligibilities_v2(workspace_id, id)
);

CREATE TABLE private_trial_credit_events_v2 (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  credit_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('prepared', 'accounting_approved', 'order_created', 'applied', 'expired', 'rejected')),
  actor_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, credit_id) REFERENCES private_trial_credits_v2(workspace_id, id)
);

DO $private_trial_closure_rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['private_trial_eligibility_events_v2', 'private_trial_credit_events_v2'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', table_name || '_workspace_isolation', table_name);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE OR TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_commercial_contract_fact_mutation()', table_name || '_append_only', table_name);
  END LOOP;
END
$private_trial_closure_rls$;

DO $private_trial_closure_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON private_trial_eligibilities_v2, private_trial_credits_v2 TO merchant_app;
    GRANT SELECT, INSERT ON private_trial_eligibility_events_v2, private_trial_credit_events_v2 TO merchant_app;
    REVOKE UPDATE, DELETE, TRUNCATE ON private_trial_eligibility_events_v2, private_trial_credit_events_v2 FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON private_trial_eligibilities_v2, private_trial_credits_v2, private_trial_eligibility_events_v2, private_trial_credit_events_v2 TO merchant_ops;
  END IF;
END
$private_trial_closure_acl$;
