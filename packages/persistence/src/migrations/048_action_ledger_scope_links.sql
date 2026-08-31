ALTER TABLE context_snapshot_links
  ADD CONSTRAINT context_snapshot_links_identity_hash_key
    UNIQUE (workspace_id, id, context_hash);

ALTER TABLE action_ledger
  ADD COLUMN IF NOT EXISTS context_link_id text,
  ADD COLUMN IF NOT EXISTS context_hash text;

UPDATE action_ledger action
SET task_id = usage.task_id
FROM workspace_usage_ledger usage
WHERE action.workspace_id = usage.workspace_id
  AND action.task_id IS NULL
  AND action.action_key = 'model:' || usage.idempotency_key;

UPDATE action_ledger action
SET campaign_item_id = task.campaign_item_id
FROM tasks task
WHERE action.workspace_id = task.workspace_id
  AND action.task_id = task.id
  AND action.campaign_item_id IS NULL
  AND task.campaign_item_id IS NOT NULL;

WITH context_usage AS (
  SELECT DISTINCT ON (usage.workspace_id, usage.action_id)
    usage.workspace_id,
    usage.action_id,
    link.id AS context_link_id,
    link.context_hash
  FROM model_usage_ledger usage
  JOIN context_snapshot_links link
    ON link.workspace_id = usage.workspace_id
   AND link.id = usage.metadata->>'context_link_id'
   AND link.context_hash = usage.metadata->>'context_hash'
  WHERE usage.action_id IS NOT NULL
  ORDER BY usage.workspace_id, usage.action_id, usage.observed_at DESC, usage.id DESC
)
UPDATE action_ledger action
SET context_link_id = context_usage.context_link_id,
    context_hash = context_usage.context_hash
FROM context_usage
WHERE action.workspace_id = context_usage.workspace_id
  AND action.action_key = context_usage.action_id
  AND action.context_link_id IS NULL
  AND action.context_hash IS NULL;

ALTER TABLE action_ledger
  ADD CONSTRAINT action_ledger_context_pair_check
    CHECK ((context_link_id IS NULL) = (context_hash IS NULL)) NOT VALID,
  ADD CONSTRAINT action_ledger_campaign_requires_task_check
    CHECK (campaign_item_id IS NULL OR task_id IS NOT NULL) NOT VALID,
  ADD CONSTRAINT action_ledger_task_fk
    FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id) NOT VALID,
  ADD CONSTRAINT action_ledger_context_link_hash_fk
    FOREIGN KEY (workspace_id, context_link_id, context_hash)
    REFERENCES context_snapshot_links (workspace_id, id, context_hash) NOT VALID;

CREATE INDEX IF NOT EXISTS action_ledger_task_scope_idx
  ON action_ledger (workspace_id, task_id, created_at DESC)
  WHERE task_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS action_ledger_campaign_item_scope_idx
  ON action_ledger (workspace_id, campaign_item_id, created_at DESC)
  WHERE campaign_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS action_ledger_context_scope_idx
  ON action_ledger (workspace_id, context_link_id, context_hash, created_at DESC)
  WHERE context_link_id IS NOT NULL;

CREATE OR REPLACE FUNCTION enforce_action_ledger_campaign_scope()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  linked_campaign_item_id text;
BEGIN
  IF NEW.campaign_item_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT task.campaign_item_id
    INTO linked_campaign_item_id
    FROM tasks task
   WHERE task.workspace_id = NEW.workspace_id
     AND task.id = NEW.task_id;
  IF linked_campaign_item_id IS DISTINCT FROM NEW.campaign_item_id THEN
    RAISE EXCEPTION 'ACTION_LEDGER_CAMPAIGN_SCOPE_CONFLICT' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS action_ledger_campaign_scope_guard ON action_ledger;
CREATE TRIGGER action_ledger_campaign_scope_guard
BEFORE INSERT OR UPDATE OF workspace_id, task_id, campaign_item_id ON action_ledger
FOR EACH ROW EXECUTE FUNCTION enforce_action_ledger_campaign_scope();

CREATE OR REPLACE FUNCTION link_action_ledger_context_from_model_usage()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.action_id IS NOT NULL
     AND NEW.metadata->>'context_link_id' IS NOT NULL
     AND NEW.metadata->>'context_hash' IS NOT NULL THEN
    UPDATE action_ledger action
    SET context_link_id = link.id,
        context_hash = link.context_hash
    FROM context_snapshot_links link
    WHERE action.workspace_id = NEW.workspace_id
      AND action.action_key = NEW.action_id
      AND action.context_link_id IS NULL
      AND action.context_hash IS NULL
      AND link.workspace_id = NEW.workspace_id
      AND link.id = NEW.metadata->>'context_link_id'
      AND link.context_hash = NEW.metadata->>'context_hash';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS model_usage_action_context_link ON model_usage_ledger;
CREATE TRIGGER model_usage_action_context_link
AFTER INSERT OR UPDATE OF action_id, metadata ON model_usage_ledger
FOR EACH ROW EXECUTE FUNCTION link_action_ledger_context_from_model_usage();

ALTER TABLE action_ledger VALIDATE CONSTRAINT action_ledger_context_pair_check;
ALTER TABLE action_ledger VALIDATE CONSTRAINT action_ledger_campaign_requires_task_check;
ALTER TABLE action_ledger VALIDATE CONSTRAINT action_ledger_task_fk;
ALTER TABLE action_ledger VALIDATE CONSTRAINT action_ledger_context_link_hash_fk;
