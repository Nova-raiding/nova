CREATE TABLE IF NOT EXISTS model_usage_ledger (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_id text,
  modality text NOT NULL CHECK (modality IN ('text','image','image_edit','ocr','video')),
  model text NOT NULL,
  provider_request_id text,
  input_tokens bigint CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens bigint CHECK (output_tokens IS NULL OR output_tokens >= 0),
  total_tokens bigint CHECK (total_tokens IS NULL OR total_tokens >= 0),
  cost_cny numeric(12,6) CHECK (cost_cny IS NULL OR cost_cny >= 0),
  observed_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb,
  UNIQUE (workspace_id, provider_request_id)
);
CREATE INDEX IF NOT EXISTS model_usage_ledger_workspace_observed_idx ON model_usage_ledger(workspace_id, observed_at DESC);
ALTER TABLE model_usage_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_usage_ledger FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_usage_ledger_workspace_isolation ON model_usage_ledger;
CREATE POLICY model_usage_ledger_workspace_isolation ON model_usage_ledger USING (workspace_id = current_setting('app.workspace_id', true)) WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
