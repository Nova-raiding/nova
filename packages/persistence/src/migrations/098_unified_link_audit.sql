-- 098_unified_link_audit: workspace-scoped canonical relationship audit projection.
CREATE TABLE IF NOT EXISTS unified_link_audit (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  audit_key TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('product','canonical_product','listing','campaign_item','task','publish_job')),
  entity_id TEXT NOT NULL,
  legacy_product_id TEXT,
  canonical_product_id TEXT,
  listing_id TEXT,
  campaign_item_id TEXT,
  task_id TEXT,
  publish_job_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('verified','legacy_only','conflict','blocked')),
  codes JSONB NOT NULL CHECK (jsonb_typeof(codes) = 'array'),
  check_revision TEXT NOT NULL,
  checksum TEXT NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  last_error TEXT,
  CONSTRAINT unified_link_audit_workspace_key UNIQUE (workspace_id,audit_key)
);
CREATE INDEX IF NOT EXISTS unified_link_audit_workspace_status_idx ON unified_link_audit (workspace_id,status,last_seen_at DESC,audit_key ASC);
ALTER TABLE unified_link_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE unified_link_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS unified_link_audit_workspace_isolation ON unified_link_audit;
CREATE POLICY unified_link_audit_workspace_isolation ON unified_link_audit USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
REVOKE ALL ON TABLE unified_link_audit FROM PUBLIC;
DO $unified_link_audit_grants$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT,INSERT,UPDATE ON TABLE unified_link_audit TO merchant_app;
  END IF;
END
$unified_link_audit_grants$;
