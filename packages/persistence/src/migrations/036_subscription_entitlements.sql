CREATE TABLE IF NOT EXISTS subscription_entitlements (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_no text NOT NULL,
  addon_code text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('platform', 'image_generation', 'bulk_sync')),
  granted_units integer NOT NULL CHECK (granted_units > 0),
  used_units integer NOT NULL DEFAULT 0 CHECK (used_units >= 0 AND used_units <= granted_units),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_no, addon_code)
);
CREATE INDEX IF NOT EXISTS subscription_entitlements_workspace_idx ON subscription_entitlements(workspace_id, created_at DESC);
ALTER TABLE subscription_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_entitlements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_entitlements_workspace_isolation ON subscription_entitlements;
CREATE POLICY subscription_entitlements_workspace_isolation ON subscription_entitlements USING (workspace_id = current_setting('app.workspace_id', true));
