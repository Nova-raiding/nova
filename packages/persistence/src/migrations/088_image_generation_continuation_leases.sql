-- Durable execution ownership for image-generation continuations. A lease is
-- recoverable only before provider dispatch. Once provider_started is durable,
-- automatic takeover is forbidden because the provider outcome may be unknown.
CREATE TABLE IF NOT EXISTS image_generation_continuation_leases (
  workspace_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('available','leased','provider_started','outcome_unknown','completed','failed')),
  attempt INTEGER NOT NULL CHECK (attempt > 0),
  owner_token TEXT,
  lease_expires_at TIMESTAMPTZ,
  provider_started_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,job_id),
  CONSTRAINT image_generation_continuation_job_fk
    FOREIGN KEY (workspace_id,job_id) REFERENCES image_generation_jobs(workspace_id,id),
  CONSTRAINT image_generation_continuation_lease_state CHECK (
    (state = 'available' AND owner_token IS NULL AND lease_expires_at IS NULL AND provider_started_at IS NULL)
    OR (state = 'leased' AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NULL)
    OR (state = 'provider_started' AND owner_token IS NOT NULL AND btrim(owner_token) <> '' AND lease_expires_at IS NOT NULL AND provider_started_at IS NOT NULL)
    OR (state IN ('outcome_unknown','completed','failed') AND owner_token IS NULL AND lease_expires_at IS NULL)
  ),
  CONSTRAINT image_generation_continuation_error_state CHECK (
    (state IN ('outcome_unknown','failed') AND error_code IS NOT NULL AND error_message IS NOT NULL)
    OR (state NOT IN ('outcome_unknown','failed') AND error_code IS NULL AND error_message IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS image_generation_continuation_reclaim_idx
  ON image_generation_continuation_leases (workspace_id,lease_expires_at,job_id)
  WHERE state = 'leased';

ALTER TABLE image_generation_continuation_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_generation_continuation_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS image_generation_continuation_workspace_isolation ON image_generation_continuation_leases;
CREATE POLICY image_generation_continuation_workspace_isolation ON image_generation_continuation_leases
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

REVOKE ALL ON TABLE image_generation_continuation_leases FROM PUBLIC;
DO $image_generation_continuation_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE image_generation_continuation_leases TO merchant_app;
    REVOKE DELETE,TRUNCATE ON TABLE image_generation_continuation_leases FROM merchant_app;
  END IF;
END
$image_generation_continuation_grants$;
