-- 092_image_generation_executions: durable execution ownership for ordinary image generation.
-- Provider-started rows cannot be reclaimed after a lease expires because the
-- remote outcome may be unknown; reconciliation must resolve them first.
CREATE TABLE IF NOT EXISTS image_generation_executions (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','leased','provider_started','outcome_unknown','completed','failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  owner_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  provider_started_at TIMESTAMPTZ,
  provider_request_id TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, job_id),
  CONSTRAINT image_generation_execution_job_fk FOREIGN KEY (workspace_id,job_id) REFERENCES image_generation_jobs(workspace_id,id),
  CONSTRAINT image_generation_execution_state_check CHECK (
    (state = 'available' AND owner_token IS NULL AND lease_expires_at IS NULL AND provider_started_at IS NULL)
    OR (state = 'leased' AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NULL)
    OR (state = 'provider_started' AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NOT NULL AND provider_request_id IS NOT NULL)
    OR (state IN ('outcome_unknown','completed','failed') AND owner_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT image_generation_execution_error_check CHECK (
    (state IN ('outcome_unknown','failed') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (state NOT IN ('outcome_unknown','failed') AND error_code IS NULL AND error_message IS NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS image_generation_execution_provider_request_idx ON image_generation_executions (workspace_id,provider_request_id) WHERE provider_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_generation_execution_reclaim_idx ON image_generation_executions (workspace_id,lease_expires_at,job_id) WHERE state = 'leased';
ALTER TABLE image_generation_executions ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_generation_executions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS image_generation_execution_workspace_isolation ON image_generation_executions;
CREATE POLICY image_generation_execution_workspace_isolation ON image_generation_executions USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
REVOKE ALL ON TABLE image_generation_executions FROM PUBLIC;
DO $image_generation_execution_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE image_generation_executions TO merchant_app;
    REVOKE DELETE,TRUNCATE ON TABLE image_generation_executions FROM merchant_app;
  END IF;
END
$image_generation_execution_grants$;
