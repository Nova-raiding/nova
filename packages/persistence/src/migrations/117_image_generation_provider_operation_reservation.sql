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

DO $image_generation_operation_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, UPDATE ON TABLE image_generation_executions TO merchant_app;
  END IF;
END
$image_generation_operation_grants$;
