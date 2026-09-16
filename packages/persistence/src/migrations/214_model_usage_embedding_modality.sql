-- Meter relay embedding calls through the durable usage/cost ledgers.
ALTER TABLE model_usage_ledger DROP CONSTRAINT IF EXISTS model_usage_ledger_modality_check;
ALTER TABLE model_usage_ledger ADD CONSTRAINT model_usage_ledger_modality_check CHECK (modality IN ('text','image','image_edit','ocr','video','embedding'));
ALTER TABLE model_cost_budget_reservations DROP CONSTRAINT IF EXISTS model_cost_budget_reservations_modality_check;
ALTER TABLE model_cost_budget_reservations ADD CONSTRAINT model_cost_budget_reservations_modality_check CHECK (modality IN ('text','image','image_edit','ocr','video','embedding'));
