ALTER TABLE model_cost_budget_reservations
  ADD COLUMN IF NOT EXISTS run_key text,
  ADD COLUMN IF NOT EXISTS run_limit_cny numeric(18,12),
  ADD COLUMN IF NOT EXISTS over_budget_reason text;

UPDATE model_cost_budget_reservations
SET run_key = reservation_key,
    run_limit_cny = daily_limit_cny
WHERE run_key IS NULL OR run_limit_cny IS NULL;

ALTER TABLE model_cost_budget_reservations
  ALTER COLUMN run_key SET NOT NULL,
  ALTER COLUMN run_limit_cny SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE model_cost_budget_reservations ADD CONSTRAINT model_cost_budget_run_key_valid
    CHECK (length(btrim(run_key)) BETWEEN 1 AND 512);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE model_cost_budget_reservations ADD CONSTRAINT model_cost_budget_run_limit_valid
    CHECK (run_limit_cny > 0 AND run_limit_cny <= daily_limit_cny);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE model_cost_budget_reservations ADD CONSTRAINT model_cost_budget_overrun_reason_valid
    CHECK (over_budget_reason IS NULL OR over_budget_reason IN ('run','daily','run_and_daily'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS model_cost_budget_workspace_run_idx
  ON model_cost_budget_reservations (workspace_id,run_key,status)
  INCLUDE (estimate_cny,actual_cost_cny,run_limit_cny);

ALTER TABLE model_cost_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_cost_budget_reservations FORCE ROW LEVEL SECURITY;

ALTER TABLE model_usage_ledger
  ADD COLUMN IF NOT EXISTS budget_reservation_key text,
  ADD COLUMN IF NOT EXISTS budget_run_key text;

UPDATE model_usage_ledger usage
SET budget_reservation_key = reservation.reservation_key,
    budget_run_key = reservation.run_key
FROM model_cost_budget_reservations reservation
WHERE usage.workspace_id = reservation.workspace_id
  AND usage.action_id = reservation.reservation_key
  AND usage.budget_reservation_key IS NULL
  AND usage.budget_run_key IS NULL;

DO $$ BEGIN
  ALTER TABLE model_usage_ledger ADD CONSTRAINT model_usage_budget_pair_valid
    CHECK ((budget_reservation_key IS NULL) = (budget_run_key IS NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS model_usage_budget_run_idx
  ON model_usage_ledger (workspace_id,budget_run_key,observed_at)
  WHERE budget_run_key IS NOT NULL;

DO $$ BEGIN
  ALTER TABLE model_usage_ledger ADD CONSTRAINT model_usage_budget_reservation_fk
    FOREIGN KEY (workspace_id,budget_reservation_key)
    REFERENCES model_cost_budget_reservations(workspace_id,reservation_key)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

REVOKE DELETE, TRUNCATE ON model_cost_budget_reservations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON model_cost_budget_reservations TO merchant_app;
    REVOKE DELETE, TRUNCATE ON model_cost_budget_reservations FROM merchant_app;
  END IF;
END $$;
