-- Enforce the durable publish-media state machine below the application layer.
-- Migration 272 predates this guard, so this forward migration also protects
-- databases where its table is already present.
-- Do not install a stricter writer guard over legacy rows that it would
-- strand. The migration runner applies this file transactionally, so this
-- preflight fails without leaving a partial trigger behind.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM publish_media_orphan_tasks existing
    WHERE (existing.state = 'intent' AND existing.receipt IS NOT NULL)
      OR ((existing.state IN ('uploaded','orphaned','retained','deleted') OR (existing.state = 'unknown' AND existing.receipt IS NOT NULL)) AND (
        jsonb_typeof(existing.receipt) IS DISTINCT FROM 'object'
        OR jsonb_typeof(existing.receipt->'mediaId') IS DISTINCT FROM 'string'
        OR NULLIF(btrim(existing.receipt->>'mediaId'),'') IS NULL
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
        OR (existing.receipt ? 'url' AND (jsonb_typeof(existing.receipt->'url') IS DISTINCT FROM 'string' OR NULLIF(btrim(existing.receipt->>'url'),'') IS NULL))
      ))
      OR (existing.state = 'deleted' AND existing.reason IS DISTINCT FROM 'discard_adapter_confirmed_delete')
  ) THEN
    RAISE EXCEPTION 'publish media lifecycle migration found legacy rows incompatible with the new guard; repair them before retrying'
      USING ERRCODE='23514', CONSTRAINT='publish_media_lifecycle_preflight';
  END IF;
END $$;
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
      WHEN 'intent' THEN NEW.state IN ('uploaded','unknown')
      WHEN 'uploaded' THEN NEW.state IN ('uploaded','orphaned','retained','unknown','deleted')
      WHEN 'orphaned' THEN NEW.state IN ('orphaned','deleted')
      WHEN 'retained' THEN NEW.state = 'retained'
      WHEN 'unknown' THEN NEW.state IN ('unknown','uploaded','orphaned','retained')
      WHEN 'deleted' THEN NEW.state = 'deleted'
      ELSE false
    END;
    IF NOT allowed THEN
      RAISE EXCEPTION 'publish media lifecycle transition is not allowed' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
    IF OLD.receipt IS NOT NULL AND NEW.receipt IS DISTINCT FROM OLD.receipt THEN
      RAISE EXCEPTION 'publish media receipt is immutable once recorded' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
  END IF;
  IF NEW.state IN ('uploaded','orphaned','retained','deleted') OR (NEW.state = 'unknown' AND NEW.receipt IS NOT NULL) THEN
    IF jsonb_typeof(NEW.receipt) <> 'object'
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
  IF NEW.state = 'deleted' THEN
    IF TG_OP <> 'UPDATE' THEN
      RAISE EXCEPTION 'publish media deletion requires an existing uploaded receipt' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
    IF (OLD.state IN ('uploaded','orphaned') AND (NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.reason IS DISTINCT FROM 'discard_adapter_confirmed_delete'))
      OR (OLD.state = 'deleted' AND (NEW.receipt IS DISTINCT FROM OLD.receipt OR NEW.reason IS DISTINCT FROM OLD.reason))
      OR OLD.state NOT IN ('uploaded','orphaned','deleted') THEN
      RAISE EXCEPTION 'publish media deletion requires the existing receipt and cleanup confirmation' USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_transition';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS publish_media_orphan_transition_guard ON publish_media_orphan_tasks;
CREATE TRIGGER publish_media_orphan_transition_guard
  BEFORE INSERT OR UPDATE ON publish_media_orphan_tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_publish_media_orphan_transition();
REVOKE ALL ON FUNCTION enforce_publish_media_orphan_transition() FROM PUBLIC;
