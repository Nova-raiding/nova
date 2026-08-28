CREATE TABLE IF NOT EXISTS subscription_entitlement_consumptions (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entitlement_id uuid NOT NULL REFERENCES subscription_entitlements(id) ON DELETE CASCADE,
  idempotency_key text NOT NULL,
  units integer NOT NULL CHECK (units > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS subscription_entitlement_consumptions_workspace_idx ON subscription_entitlement_consumptions(workspace_id, created_at DESC);
ALTER TABLE subscription_entitlement_consumptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscription_entitlement_consumptions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscription_entitlement_consumptions_workspace_isolation ON subscription_entitlement_consumptions;
CREATE POLICY subscription_entitlement_consumptions_workspace_isolation ON subscription_entitlement_consumptions USING (workspace_id = current_setting('app.workspace_id', true));
