-- Durable control state for bounded canonical-product backfill batches.
CREATE TABLE IF NOT EXISTS canonical_backfill_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('planned','running','paused','completed','failed')),
  dry_run BOOLEAN NOT NULL DEFAULT true,
  batch_limit INTEGER CHECK (batch_limit IS NULL OR (batch_limit >= 1 AND batch_limit <= 5000)),
  cursor_product_id TEXT,
  last_result JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(last_result) = 'object'),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS canonical_backfill_runs_workspace_updated_idx ON canonical_backfill_runs(workspace_id, updated_at DESC, id ASC);
ALTER TABLE canonical_backfill_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_backfill_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY canonical_backfill_runs_workspace_isolation ON canonical_backfill_runs USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
REVOKE ALL ON TABLE canonical_backfill_runs FROM PUBLIC;
DO $canonical_backfill_runs_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE canonical_backfill_runs TO merchant_app;
  END IF;
END
$canonical_backfill_runs_grants$;
