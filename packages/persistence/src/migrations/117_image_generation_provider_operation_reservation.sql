-- 117_image_generation_provider_operation_reservation: durable provider
-- operation identity reserved before an external image-generation dispatch.
ALTER TABLE image_generation_executions
  ADD COLUMN IF NOT EXISTS provider_operation_key TEXT;

ALTER TABLE image_generation_executions
  DROP CONSTRAINT IF EXISTS image_generation_execution_provider_operation_key_check;
ALTER TABLE image_generation_executions
  ADD CONSTRAINT image_generation_execution_provider_operation_key_check
  CHECK (provider_operation_key IS NULL OR (btrim(provider_operation_key) <> '' AND length(provider_operation_key) <= 255));

CREATE UNIQUE INDEX IF NOT EXISTS image_generation_execution_operation_key_idx
  ON image_generation_executions (workspace_id, provider_operation_key)
  WHERE provider_operation_key IS NOT NULL;

-- The reservation and dispatch fence are explicit states. Existing legacy rows
-- remain valid with a NULL operation key; only newly fenced rows require one.
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

DO $image_generation_operation_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, UPDATE ON TABLE image_generation_executions TO merchant_app;
  END IF;
END
$image_generation_operation_grants$;
