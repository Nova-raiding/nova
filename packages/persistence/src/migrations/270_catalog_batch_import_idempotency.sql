CREATE TABLE catalog_batch_import_idempotency (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation = 'catalog.import.batch.v1'),
  idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'in_progress', 'retryable_failed', 'needs_reconciliation', 'completed')),
  claim_token UUID NOT NULL,
  claim_expires_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, actor_id, operation, idempotency_key),
  CHECK ((status = 'completed') = (result_json IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((status = 'claimed') = (claim_expires_at IS NOT NULL)),
  CHECK ((status IN ('in_progress', 'needs_reconciliation', 'completed')) = (started_at IS NOT NULL))
);
CREATE INDEX catalog_batch_import_idempotency_completed_idx ON catalog_batch_import_idempotency(completed_at) WHERE status='completed';

ALTER TABLE catalog_batch_import_idempotency ENABLE ROW LEVEL SECURITY;
ALTER TABLE catalog_batch_import_idempotency FORCE ROW LEVEL SECURITY;
CREATE POLICY catalog_batch_import_idempotency_workspace_scope
  ON catalog_batch_import_idempotency
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

REVOKE ALL ON catalog_batch_import_idempotency FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON catalog_batch_import_idempotency TO merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE ALL ON catalog_batch_import_idempotency FROM merchant_ops;
  END IF;
END $$;
