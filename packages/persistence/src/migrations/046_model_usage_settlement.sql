ALTER TABLE model_usage_ledger
  ADD COLUMN IF NOT EXISTS receipt_key text,
  ADD COLUMN IF NOT EXISTS settlement_status text,
  ADD COLUMN IF NOT EXISTS receipt_hash text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_error jsonb,
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS resolved_by text,
  ADD COLUMN IF NOT EXISTS resolution_reason text,
  ADD COLUMN IF NOT EXISTS resolution_evidence_ref text,
  ADD COLUMN IF NOT EXISTS resolved_at timestamptz,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS claim_owner text,
  ADD COLUMN IF NOT EXISTS claim_expires_at timestamptz;

UPDATE model_usage_ledger
SET receipt_key = COALESCE(NULLIF(trim(provider_request_id), ''), 'legacy:' || id)
WHERE receipt_key IS NULL OR trim(receipt_key) = '';

UPDATE model_usage_ledger
SET receipt_hash = md5(concat_ws('|', workspace_id, receipt_key, COALESCE(action_id, ''), modality, model, COALESCE(provider_request_id, '')))
WHERE receipt_hash IS NULL OR trim(receipt_hash) = '';

UPDATE model_usage_ledger
SET settlement_status = CASE WHEN cost_cny IS NULL THEN 'pending_cost' ELSE 'settled' END
WHERE settlement_status IS NULL;

UPDATE model_usage_ledger
SET next_attempt_at = observed_at
WHERE next_attempt_at IS NULL AND settlement_status IN ('pending_cost', 'pending_wallet');

ALTER TABLE model_usage_ledger
  ALTER COLUMN receipt_key SET NOT NULL,
  ALTER COLUMN settlement_status SET NOT NULL,
  ALTER COLUMN receipt_hash SET NOT NULL,
  ADD CONSTRAINT model_usage_settlement_status_check
    CHECK (settlement_status IN ('pending_cost','pending_wallet','settled','manual_attention','waived')),
  ADD CONSTRAINT model_usage_attempt_count_check CHECK (attempt_count >= 0),
  ADD CONSTRAINT model_usage_revision_check CHECK (revision > 0),
  ADD CONSTRAINT model_usage_receipt_key_nonempty CHECK (length(trim(receipt_key)) > 0),
  ADD CONSTRAINT model_usage_receipt_hash_nonempty CHECK (length(trim(receipt_hash)) > 0),
  ADD CONSTRAINT model_usage_resolution_complete_check CHECK (
    (resolved_at IS NULL AND resolved_by IS NULL AND resolution_reason IS NULL AND resolution_evidence_ref IS NULL AND settlement_status <> 'waived')
    OR
    (resolved_at IS NOT NULL AND length(trim(resolved_by)) > 0 AND length(trim(resolution_reason)) > 0)
  );

CREATE UNIQUE INDEX IF NOT EXISTS model_usage_ledger_workspace_receipt_key
  ON model_usage_ledger (workspace_id, receipt_key);

CREATE INDEX IF NOT EXISTS model_usage_ledger_retry_claim_idx
  ON model_usage_ledger (workspace_id, settlement_status, next_attempt_at, observed_at)
  WHERE settlement_status IN ('pending_cost', 'pending_wallet');
