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

DO $$ BEGIN
  ALTER TABLE model_usage_ledger ADD CONSTRAINT model_usage_budget_reservation_fk
    FOREIGN KEY (workspace_id,budget_reservation_key)
    REFERENCES model_cost_budget_reservations(workspace_id,reservation_key)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE model_cost_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_cost_budget_reservations FORCE ROW LEVEL SECURITY;

REVOKE DELETE, TRUNCATE ON model_cost_budget_reservations FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON model_cost_budget_reservations TO merchant_app;
    REVOKE DELETE, TRUNCATE ON model_cost_budget_reservations FROM merchant_app;
  END IF;
END $$;
