-- A caller-provided reason is not evidence that a remote platform deleted media.
-- Preserve every prior "deleted" receipt as an orphan requiring recovery, and
-- prevent further terminal deletion claims until a verifiable provider receipt
-- contract is installed by a future migration.
-- The migration executor must have BYPASSRLS/superuser privileges. With FORCE
-- RLS enabled on this table, row_security=off makes a lesser role fail closed
-- instead of silently downgrading only a visible subset of legacy rows.
SET LOCAL row_security = off;
DO $publish_media_deletion_preflight$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publish_media_orphan_tasks existing
    WHERE existing.state = 'deleted'
      AND (
        jsonb_typeof(existing.receipt) IS DISTINCT FROM 'object'
        OR jsonb_typeof(existing.receipt->'mediaId') IS DISTINCT FROM 'string'
        OR NULLIF(btrim(existing.receipt->>'mediaId'), '') IS NULL
        OR jsonb_typeof(existing.receipt->'platform') IS DISTINCT FROM 'string'
        OR existing.receipt->>'platform' IS DISTINCT FROM existing.platform
        OR jsonb_typeof(existing.receipt->'visualRef') IS DISTINCT FROM 'string'
        OR existing.receipt->>'visualRef' IS DISTINCT FROM existing.visual_ref
        OR jsonb_typeof(existing.receipt->'role') IS DISTINCT FROM 'string'
        OR existing.receipt->>'role' IS DISTINCT FROM existing.role
        OR jsonb_typeof(existing.receipt->'sha256') IS DISTINCT FROM 'string'
        OR existing.receipt->>'sha256' IS DISTINCT FROM existing.sha256
        OR jsonb_typeof(existing.receipt->'simulated') IS DISTINCT FROM 'boolean'
        OR existing.receipt->>'simulated' IS DISTINCT FROM 'false'
        OR (existing.receipt ? 'url' AND (jsonb_typeof(existing.receipt->'url') IS DISTINCT FROM 'string' OR NULLIF(btrim(existing.receipt->>'url'), '') IS NULL))
      )
  ) THEN
    RAISE EXCEPTION 'publish media deletion migration found an invalid legacy receipt; repair it before retrying'
      USING ERRCODE='23514', CONSTRAINT='publish_media_deletion_preflight';
  END IF;
END $publish_media_deletion_preflight$;

-- The transition guard from 273 would reject this state repair. The migration
-- is transactional and this DDL lock prevents application writes in the gap.
DROP TRIGGER publish_media_orphan_transition_guard ON publish_media_orphan_tasks;
WITH downgraded AS (
  UPDATE publish_media_orphan_tasks
  SET state='orphaned', reason='delete_unverified_legacy_recovery_required', updated_at=now()
  WHERE state='deleted'
  RETURNING id, workspace_id
)
INSERT INTO publish_media_orphan_events(id, workspace_id, task_id, state, detail)
SELECT 'pmoe_m274_' || md5(workspace_id || '/' || id), workspace_id, id, 'orphaned',
       jsonb_build_object('source_state','deleted','migration_version',274,'verification','unverified','recovery_required',true)
FROM downgraded;

CREATE OR REPLACE FUNCTION enforce_publish_media_orphan_transition() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean := false;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'intent' OR NEW.receipt IS NOT NULL THEN
      RAISE EXCEPTION 'publish media lifecycle must begin with an empty intent' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
  ELSE
    IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
      OR NEW.publish_job_id IS DISTINCT FROM OLD.publish_job_id
      OR NEW.event_id IS DISTINCT FROM OLD.event_id
      OR NEW.media_idempotency_key IS DISTINCT FROM OLD.media_idempotency_key
      OR NEW.platform IS DISTINCT FROM OLD.platform
      OR NEW.account_id IS DISTINCT FROM OLD.account_id
      OR NEW.visual_ref IS DISTINCT FROM OLD.visual_ref
      OR NEW.role IS DISTINCT FROM OLD.role
      OR NEW.sha256 IS DISTINCT FROM OLD.sha256 THEN
      RAISE EXCEPTION 'publish media lifecycle identity is immutable' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
    allowed := CASE OLD.state
      WHEN 'intent' THEN NEW.state IN ('uploaded','orphaned','unknown')
      WHEN 'uploaded' THEN NEW.state IN ('uploaded','orphaned','retained','unknown')
      WHEN 'orphaned' THEN NEW.state = 'orphaned'
      WHEN 'retained' THEN NEW.state = 'retained'
      WHEN 'unknown' THEN NEW.state IN ('unknown','uploaded','orphaned','retained')
      ELSE false
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'publish media lifecycle transition is not allowed' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
    IF OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN
      RAISE EXCEPTION 'publish media receipt is immutable once recorded' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
  END IF;
  IF NEW.state = 'deleted' THEN
    RAISE EXCEPTION 'publish media deletion requires independently verifiable provider evidence' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
  END IF;
  IF NEW.state IN ('uploaded','orphaned','retained') OR (NEW.state = 'unknown' AND NEW.receipt IS NOT NULL) THEN
    IF jsonb_typeof(NEW.receipt) IS DISTINCT FROM 'object'
      OR jsonb_typeof(NEW.receipt->'mediaId') IS DISTINCT FROM 'string'
      OR NULLIF(btrim(NEW.receipt->>'mediaId'),'') IS NULL
      OR jsonb_typeof(NEW.receipt->'platform') IS DISTINCT FROM 'string'
      OR NEW.receipt->>'platform' IS DISTINCT FROM NEW.platform
      OR jsonb_typeof(NEW.receipt->'visualRef') IS DISTINCT FROM 'string'
      OR NEW.receipt->>'visualRef' IS DISTINCT FROM NEW.visual_ref
      OR jsonb_typeof(NEW.receipt->'role') IS DISTINCT FROM 'string'
      OR NEW.receipt->>'role' IS DISTINCT FROM NEW.role
      OR jsonb_typeof(NEW.receipt->'sha256') IS DISTINCT FROM 'string'
      OR NEW.receipt->>'sha256' IS DISTINCT FROM NEW.sha256
      OR jsonb_typeof(NEW.receipt->'simulated') IS DISTINCT FROM 'boolean'
      OR NEW.receipt->>'simulated' IS DISTINCT FROM 'false'
      OR (NEW.receipt ? 'url' AND (jsonb_typeof(NEW.receipt->'url') IS DISTINCT FROM 'string' OR NULLIF(btrim(NEW.receipt->>'url'),'') IS NULL)) THEN
      RAISE EXCEPTION 'publish media receipt does not match its lifecycle binding' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publish_media_orphan_transition_guard
  BEFORE INSERT OR UPDATE ON publish_media_orphan_tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_publish_media_orphan_transition();
REVOKE ALL ON FUNCTION enforce_publish_media_orphan_transition() FROM PUBLIC;
