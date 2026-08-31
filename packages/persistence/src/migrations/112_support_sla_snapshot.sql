ALTER TABLE workspace_support_tickets
  ADD COLUMN IF NOT EXISTS sla_snapshot_json JSONB;

ALTER TABLE workspace_support_tickets
  DROP CONSTRAINT IF EXISTS workspace_support_tickets_sla_snapshot_object;
ALTER TABLE workspace_support_tickets
  ADD CONSTRAINT workspace_support_tickets_sla_snapshot_object
  CHECK (sla_snapshot_json IS NULL OR jsonb_typeof(sla_snapshot_json) = 'object');

CREATE OR REPLACE FUNCTION reject_support_sla_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.sla_snapshot_json IS NOT NULL AND NEW.sla_snapshot_json IS DISTINCT FROM OLD.sla_snapshot_json THEN
    RAISE EXCEPTION 'support SLA snapshots are immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS workspace_support_tickets_sla_snapshot_immutable
  ON workspace_support_tickets;
CREATE TRIGGER workspace_support_tickets_sla_snapshot_immutable
BEFORE UPDATE ON workspace_support_tickets
FOR EACH ROW EXECUTE FUNCTION reject_support_sla_snapshot_mutation();

CREATE INDEX IF NOT EXISTS workspace_support_tickets_sla_due_idx
  ON workspace_support_tickets (workspace_id, (sla_snapshot_json->>'resolutionDueAt'));
