-- 119_image_generation_execution_dispatch_fence: enforce dispatch states and
-- provide the recovery scan index without rewriting migration 117 history.
ALTER TABLE image_generation_executions
  DROP CONSTRAINT IF EXISTS image_generation_execution_state_check;

ALTER TABLE image_generation_executions
  ADD CONSTRAINT image_generation_execution_state_check CHECK (
    (state = 'available' AND owner_token IS NULL AND lease_expires_at IS NULL AND provider_started_at IS NULL AND provider_operation_key IS NULL)
    OR (state = 'leased' AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NULL AND provider_operation_key IS NULL)
    OR (state IN ('provider_reserved','provider_dispatching') AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NULL AND provider_operation_key IS NOT NULL AND btrim(provider_operation_key) <> '')
    OR (state = 'provider_started' AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NOT NULL AND provider_request_id IS NOT NULL AND (provider_operation_key IS NULL OR btrim(provider_operation_key) <> ''))
    OR (state IN ('outcome_unknown','completed','failed') AND owner_token IS NULL AND lease_expires_at IS NULL AND (provider_operation_key IS NULL OR btrim(provider_operation_key) <> ''))
  );

CREATE INDEX IF NOT EXISTS image_generation_execution_dispatch_recovery_idx
  ON image_generation_executions (workspace_id, state, updated_at DESC, job_id ASC)
  WHERE state IN ('provider_reserved','provider_dispatching','outcome_unknown');
