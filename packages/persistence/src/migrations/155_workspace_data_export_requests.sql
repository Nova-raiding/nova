CREATE TABLE workspace_data_export_requests (
  id UUID PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','ready','failed','expired')),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_by TEXT,
  processing_at TIMESTAMPTZ,
  completed_by TEXT,
  completed_at TIMESTAMPTZ,
  artifact_ref TEXT CHECK (artifact_ref IS NULL OR artifact_ref ~ '^workspace-export://[A-Za-z0-9._~/-]+$'),
  artifact_sha256 TEXT CHECK (artifact_sha256 IS NULL OR artifact_sha256 ~ '^[a-f0-9]{64}$'),
  artifact_size_bytes BIGINT CHECK (artifact_size_bytes IS NULL OR artifact_size_bytes > 0),
  artifact_expires_at TIMESTAMPTZ,
  delivery_evidence_ref TEXT,
  failure_code TEXT,
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT workspace_data_export_ready_evidence_check CHECK (
    status <> 'ready' OR (
      artifact_ref IS NOT NULL AND artifact_sha256 IS NOT NULL AND
      artifact_size_bytes IS NOT NULL AND artifact_expires_at IS NOT NULL AND
      delivery_evidence_ref IS NOT NULL AND completed_by IS NOT NULL AND completed_at IS NOT NULL
    )
  )
);

CREATE INDEX workspace_data_export_requests_status_idx
  ON workspace_data_export_requests (workspace_id, status, requested_at DESC, id DESC);

ALTER TABLE workspace_data_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_data_export_requests FORCE ROW LEVEL SECURITY;

CREATE POLICY workspace_data_export_requests_isolation ON workspace_data_export_requests
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

REVOKE ALL ON workspace_data_export_requests FROM PUBLIC;

DO $workspace_data_export_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON workspace_data_export_requests TO merchant_app;
    REVOKE DELETE, TRUNCATE ON workspace_data_export_requests FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT ON workspace_data_export_requests TO merchant_ops;
    REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON workspace_data_export_requests FROM merchant_ops;
  END IF;
END
$workspace_data_export_acl$;
