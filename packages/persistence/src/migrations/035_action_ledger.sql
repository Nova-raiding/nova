CREATE TABLE IF NOT EXISTS action_ledger (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_key text NOT NULL,
  action_kind text NOT NULL CHECK (action_kind IN ('model_text','model_image','model_ocr','model_video','seo','brief','publish','other')),
  settlement text NOT NULL CHECK (settlement IN ('included_quota','wallet','wallet_overage')),
  state text NOT NULL CHECK (state IN ('settled','refunded')),
  units integer NOT NULL CHECK (units > 0),
  amount_fen bigint NOT NULL CHECK (amount_fen >= 0),
  actor_id text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  refunded_at timestamptz,
  refund_reason text,
  UNIQUE (workspace_id, action_key)
);
CREATE INDEX IF NOT EXISTS action_ledger_workspace_created_idx ON action_ledger(workspace_id, created_at DESC);
ALTER TABLE action_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS action_ledger_workspace_isolation ON action_ledger;
CREATE POLICY action_ledger_workspace_isolation ON action_ledger USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
