-- 102_canonical_backfill_conflicts: human-review queue for safe backfill conflicts.
CREATE TABLE IF NOT EXISTS canonical_backfill_conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL REFERENCES canonical_backfill_runs(id) ON DELETE CASCADE,
  legacy_product_id TEXT NOT NULL,
  code TEXT NOT NULL,
  canonical_ids JSONB NOT NULL CHECK (jsonb_typeof(canonical_ids) = 'array'),
  status TEXT NOT NULL CHECK (status IN ('open','claimed','resolved','dismissed')),
  assignee_id TEXT,
  resolution_note TEXT,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, run_id, legacy_product_id, code)
);
CREATE INDEX IF NOT EXISTS canonical_backfill_conflicts_queue_idx ON canonical_backfill_conflicts(workspace_id, status, updated_at DESC, id ASC);
ALTER TABLE canonical_backfill_conflicts ENABLE ROW LEVEL SECURITY;
ALTER TABLE canonical_backfill_conflicts FORCE ROW LEVEL SECURITY;
CREATE POLICY canonical_backfill_conflicts_workspace_isolation ON canonical_backfill_conflicts USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
REVOKE ALL ON TABLE canonical_backfill_conflicts FROM PUBLIC;
DO $canonical_backfill_conflicts_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE canonical_backfill_conflicts TO merchant_app;
  END IF;
END
$canonical_backfill_conflicts_grants$;
