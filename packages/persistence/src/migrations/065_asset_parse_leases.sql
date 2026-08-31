-- Durable, tenant-scoped leases for recoverable asset parsing across API replicas.
CREATE TABLE IF NOT EXISTS asset_parse_leases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('processing', 'succeeded', 'failed')),
  attempts INTEGER NOT NULL CHECK (attempts > 0),
  lease_token TEXT,
  lease_until TIMESTAMPTZ,
  facts JSONB,
  error_code TEXT,
  error_message TEXT,
  retryable BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, asset_id),
  CHECK (btrim(workspace_id) <> '' AND length(workspace_id) <= 255 AND workspace_id !~ '[[:cntrl:]]'),
  CHECK (btrim(asset_id) <> '' AND length(asset_id) <= 255 AND asset_id !~ '[[:cntrl:]]'),
  CHECK (
    (state = 'processing' AND lease_token IS NOT NULL AND btrim(lease_token) <> '' AND lease_until IS NOT NULL
      AND facts IS NULL AND error_code IS NULL AND error_message IS NULL AND retryable)
    OR
    (state = 'succeeded' AND lease_token IS NULL AND lease_until IS NULL
      AND facts IS NOT NULL AND jsonb_typeof(facts) = 'object' AND facts <> '{}'::jsonb
      AND error_code IS NULL AND error_message IS NULL AND NOT retryable)
    OR
    (state = 'failed' AND lease_token IS NULL AND lease_until IS NULL AND facts IS NULL
      AND error_code IS NOT NULL AND btrim(error_code) <> ''
      AND error_message IS NOT NULL AND btrim(error_message) <> '')
  )
);

CREATE INDEX IF NOT EXISTS asset_parse_leases_recovery_idx
  ON asset_parse_leases (workspace_id, lease_until)
  WHERE state = 'processing';

ALTER TABLE asset_parse_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_parse_leases FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS asset_parse_leases_workspace_scope ON asset_parse_leases;
CREATE POLICY asset_parse_leases_workspace_scope ON asset_parse_leases
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON TABLE asset_parse_leases TO merchant_app;
  END IF;
END
$$;
