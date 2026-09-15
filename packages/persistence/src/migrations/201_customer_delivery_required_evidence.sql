-- Persist immutable, scanned evidence references for payment verification and training.
ALTER TABLE workspace_customer_deliveries
  ADD COLUMN IF NOT EXISTS payment_evidence_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN IF NOT EXISTS training_evidence_refs TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE workspace_customer_deliveries
  DROP CONSTRAINT IF EXISTS customer_delivery_paid_evidence_required,
  ADD CONSTRAINT customer_delivery_paid_evidence_required
    CHECK (payment_status <> 'paid' OR (payment_date IS NOT NULL AND cardinality(payment_evidence_refs) > 0)) NOT VALID,
  DROP CONSTRAINT IF EXISTS customer_delivery_training_evidence_required,
  ADD CONSTRAINT customer_delivery_training_evidence_required
    CHECK (NOT training_completed OR cardinality(training_evidence_refs) > 0) NOT VALID;

-- Legacy rows remain readable and visibly incomplete. New writes cannot create
-- paid/training-complete facts without durable evidence references.
DO $customer_delivery_evidence_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, UPDATE (payment_evidence_refs, training_evidence_refs) ON workspace_customer_deliveries TO merchant_ops;
  END IF;
END
$customer_delivery_evidence_acl$;
