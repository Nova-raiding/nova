-- Promote model usage context identity out of metadata. The metadata backfill
-- is one-time compatibility for historical receipts; all new writes are
-- checked by independent columns and the composite foreign key below.
ALTER TABLE model_usage_ledger
  ADD COLUMN IF NOT EXISTS context_link_id text,
  ADD COLUMN IF NOT EXISTS context_hash text;

UPDATE model_usage_ledger usage
SET context_link_id = link.id,
    context_hash = link.context_hash
FROM context_snapshot_links link
WHERE usage.context_link_id IS NULL
  AND usage.context_hash IS NULL
  AND usage.metadata->>'context_link_id' = link.id
  AND usage.metadata->>'context_hash' = link.context_hash
  AND usage.workspace_id = link.workspace_id;

ALTER TABLE model_usage_ledger
  ADD CONSTRAINT model_usage_context_pair_check
    CHECK ((context_link_id IS NULL) = (context_hash IS NULL)) NOT VALID,
  ADD CONSTRAINT model_usage_context_link_hash_fk
    FOREIGN KEY (workspace_id, context_link_id, context_hash)
    REFERENCES context_snapshot_links (workspace_id, id, context_hash) NOT VALID,
  ADD CONSTRAINT model_usage_action_fk
    FOREIGN KEY (workspace_id, action_id)
    REFERENCES action_ledger (workspace_id, action_key) NOT VALID;

CREATE INDEX IF NOT EXISTS model_usage_context_scope_idx
  ON model_usage_ledger (workspace_id, context_link_id, context_hash, observed_at DESC)
  WHERE context_link_id IS NOT NULL;

DROP TRIGGER IF EXISTS model_usage_action_context_link ON model_usage_ledger;
DROP FUNCTION IF EXISTS link_action_ledger_context_from_model_usage();

CREATE OR REPLACE FUNCTION link_action_ledger_context_from_model_usage_columns()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  current_link_id text;
  current_hash text;
BEGIN
  IF NEW.action_id IS NULL OR NEW.context_link_id IS NULL OR NEW.context_hash IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT context_link_id, context_hash
    INTO current_link_id, current_hash
    FROM action_ledger
   WHERE workspace_id = NEW.workspace_id
     AND action_key = NEW.action_id
   FOR UPDATE;
  IF current_link_id IS NOT NULL AND (current_link_id IS DISTINCT FROM NEW.context_link_id OR current_hash IS DISTINCT FROM NEW.context_hash) THEN
    RAISE EXCEPTION 'MODEL_USAGE_ACTION_CONTEXT_CONFLICT' USING ERRCODE = '23514';
  END IF;
  UPDATE action_ledger
     SET context_link_id = NEW.context_link_id,
         context_hash = NEW.context_hash
   WHERE workspace_id = NEW.workspace_id
     AND action_key = NEW.action_id
     AND context_link_id IS NULL
     AND context_hash IS NULL;
  RETURN NEW;
END $$;

CREATE TRIGGER model_usage_action_context_columns
AFTER INSERT OR UPDATE OF action_id, context_link_id, context_hash ON model_usage_ledger
FOR EACH ROW EXECUTE FUNCTION link_action_ledger_context_from_model_usage_columns();
