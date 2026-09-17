-- Meter relay embedding calls through the durable usage/cost ledgers.
-- Install and validate replacements before taking the brief lock needed to
-- remove/rename legacy checks. NOT VALID avoids a table scan during ADD while
-- still enforcing the replacement for concurrent writes immediately.
DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'model_usage_ledger'::regclass AND conname = 'model_usage_ledger_modality_embedding_check') THEN
    ALTER TABLE model_usage_ledger ADD CONSTRAINT model_usage_ledger_modality_embedding_check
      CHECK (modality IN ('text','image','image_edit','ocr','video','embedding')) NOT VALID;
  END IF;
END;
$migration$;

ALTER TABLE model_usage_ledger VALIDATE CONSTRAINT model_usage_ledger_modality_embedding_check;

DO $migration$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'modality'
    WHERE c.conrelid = 'model_usage_ledger'::regclass AND c.contype = 'c'
      AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.conname <> 'model_usage_ledger_modality_embedding_check'
  LOOP
    EXECUTE format('ALTER TABLE model_usage_ledger DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'model_usage_ledger'::regclass AND conname = 'model_usage_ledger_modality_check') THEN
    ALTER TABLE model_usage_ledger RENAME CONSTRAINT model_usage_ledger_modality_embedding_check TO model_usage_ledger_modality_check;
  END IF;
END;
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'model_cost_budget_reservations'::regclass AND conname = 'model_cost_budget_reservations_modality_embedding_check') THEN
    ALTER TABLE model_cost_budget_reservations ADD CONSTRAINT model_cost_budget_reservations_modality_embedding_check
      CHECK (modality IN ('text','image','image_edit','ocr','video','embedding')) NOT VALID;
  END IF;
END;
$migration$;

ALTER TABLE model_cost_budget_reservations VALIDATE CONSTRAINT model_cost_budget_reservations_modality_embedding_check;

DO $migration$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT c.conname FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attname = 'modality'
    WHERE c.conrelid = 'model_cost_budget_reservations'::regclass AND c.contype = 'c'
      AND c.conkey = ARRAY[a.attnum]::smallint[]
      AND c.conname <> 'model_cost_budget_reservations_modality_embedding_check'
  LOOP
    EXECUTE format('ALTER TABLE model_cost_budget_reservations DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'model_cost_budget_reservations'::regclass AND conname = 'model_cost_budget_reservations_modality_check') THEN
    ALTER TABLE model_cost_budget_reservations RENAME CONSTRAINT model_cost_budget_reservations_modality_embedding_check TO model_cost_budget_reservations_modality_check;
  END IF;
END;
$migration$;
