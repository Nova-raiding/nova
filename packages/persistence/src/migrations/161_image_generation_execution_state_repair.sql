-- 161_image_generation_execution_state_repair: keep the durable execution
-- state constraint aligned with the provider reservation states introduced by
-- migration 119.  Some installations applied the earlier constraint after
-- the fence migration, which made reserve_provider_operation fail closed.
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
