DO $$ BEGIN
  ALTER TABLE model_cost_budget_reservations
    ADD CONSTRAINT model_cost_budget_reservation_run_unique
    UNIQUE (workspace_id,reservation_key,run_key);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE model_usage_ledger
    ADD CONSTRAINT model_usage_budget_reservation_run_fk
    FOREIGN KEY (workspace_id,budget_reservation_key,budget_run_key)
    REFERENCES model_cost_budget_reservations(workspace_id,reservation_key,run_key)
    DEFERRABLE INITIALLY DEFERRED;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
