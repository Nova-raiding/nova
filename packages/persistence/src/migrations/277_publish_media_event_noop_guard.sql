-- Keep append-only history aligned with meaningful task changes. PostgreSQL
-- fires UPDATE OF triggers when a column is named in SET even if its value is
-- unchanged, so suppress a no-op before the task-event trigger inserts history.
CREATE OR REPLACE FUNCTION public.append_publish_media_orphan_event_from_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $publish_media_orphan_event_from_task$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.state IS NOT DISTINCT FROM OLD.state
       AND NEW.receipt IS NOT DISTINCT FROM OLD.receipt
       AND NEW.reason IS NOT DISTINCT FROM OLD.reason THEN
      RETURN NEW;
    END IF;
  END IF;

  INSERT INTO public.publish_media_orphan_events(id,workspace_id,task_id,state,detail)
  VALUES (
    'pmoe_' || pg_catalog.gen_random_uuid()::text,
    NEW.workspace_id,
    NEW.id,
    NEW.state,
    pg_catalog.jsonb_build_object('reason',NEW.reason,'hasReceipt',NEW.receipt IS NOT NULL)
  );
  RETURN NEW;
END
$publish_media_orphan_event_from_task$;
