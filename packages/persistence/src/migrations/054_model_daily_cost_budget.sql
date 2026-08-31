CREATE TABLE IF NOT EXISTS model_cost_budget_reservations (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  budget_date date NOT NULL,
  reservation_key text NOT NULL CHECK (length(btrim(reservation_key)) BETWEEN 1 AND 512),
  modality text NOT NULL CHECK (modality IN ('text','image','image_edit','ocr','video')),
  model text NOT NULL CHECK (length(btrim(model)) BETWEEN 1 AND 256),
  estimate_cny numeric(18,12) NOT NULL CHECK (estimate_cny > 0),
  estimate_version text NOT NULL CHECK (length(btrim(estimate_version)) BETWEEN 1 AND 128),
  daily_limit_cny numeric(18,12) NOT NULL CHECK (daily_limit_cny > 0),
  status text NOT NULL CHECK (status IN ('active','settled','released','over_budget')),
  actual_cost_cny numeric(18,12) CHECK (actual_cost_cny IS NULL OR actual_cost_cny >= 0),
  provider_request_id text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id,reservation_key),
  CHECK ((status IN ('settled','over_budget')) = (actual_cost_cny IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS model_cost_budget_workspace_day_idx
  ON model_cost_budget_reservations (workspace_id,budget_date,status);

CREATE INDEX IF NOT EXISTS model_usage_budget_action_day_idx
  ON model_usage_ledger (workspace_id,action_id,observed_at)
  WHERE action_id IS NOT NULL;

ALTER TABLE model_cost_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_cost_budget_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS model_cost_budget_workspace_isolation ON model_cost_budget_reservations;
CREATE POLICY model_cost_budget_workspace_isolation ON model_cost_budget_reservations
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
