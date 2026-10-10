-- The task row is authoritative. App credentials may mutate it through the
-- lifecycle repository, but cannot append or fabricate audit rows directly.
CREATE OR REPLACE FUNCTION public.append_publish_media_orphan_event_from_task() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog
AS $publish_media_orphan_event_from_task$
BEGIN
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

-- Keep the definer aligned with the protected ledger owner, so a normal
-- merchant_app transaction can write the task and have exactly one event
-- appended without receiving direct INSERT rights on the ledger.
DO $publish_media_orphan_event_owner$
DECLARE
  owner_name text;
  owner_can_login boolean;
  owner_is_superuser boolean;
  owner_can_create_roles boolean;
  owner_can_create_databases boolean;
  owner_inherits boolean;
  owner_bypasses_rls boolean;
BEGIN
  SELECT r.rolname,r.rolcanlogin,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolinherit,r.rolbypassrls
    INTO owner_name,owner_can_login,owner_is_superuser,owner_can_create_roles,owner_can_create_databases,owner_inherits,owner_bypasses_rls
    FROM pg_catalog.pg_roles r WHERE r.rolname='merchant_schema_owner';
  -- The runtime credentials and any role they can assume must never own this
  -- definer. Require the explicitly provisioned, non-login schema owner.
  IF owner_name IS DISTINCT FROM 'merchant_schema_owner'
     OR owner_can_login IS DISTINCT FROM false
     OR owner_is_superuser IS DISTINCT FROM false
     OR owner_can_create_roles IS DISTINCT FROM false
     OR owner_can_create_databases IS DISTINCT FROM false
     OR owner_inherits IS DISTINCT FROM false
     OR owner_bypasses_rls IS DISTINCT FROM false
     OR pg_catalog.pg_has_role('merchant_app',owner_name,'MEMBER')
     OR pg_catalog.pg_has_role('merchant_ops',owner_name,'MEMBER')
     OR pg_catalog.pg_has_role(owner_name,'merchant_app','MEMBER')
     OR pg_catalog.pg_has_role(owner_name,'merchant_ops','MEMBER')
     OR current_user IN ('merchant_app','merchant_ops') THEN
    RAISE EXCEPTION 'publish media event table requires restricted NOLOGIN role merchant_schema_owner and a protected migration executor'
      USING ERRCODE='42501', CONSTRAINT='publish_media_orphan_event_owner';
  END IF;
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA public TO %I',owner_name);
  EXECUTE pg_catalog.format('GRANT CREATE ON SCHEMA public TO %I',owner_name);
  EXECUTE pg_catalog.format('ALTER TABLE public.publish_media_orphan_events OWNER TO %I',owner_name);
  EXECUTE pg_catalog.format('ALTER FUNCTION public.append_publish_media_orphan_event_from_task() OWNER TO %I',owner_name);
  EXECUTE pg_catalog.format('REVOKE CREATE ON SCHEMA public FROM %I',owner_name);
END
$publish_media_orphan_event_owner$;

-- The nested INSERT validator reads the bound task as the definer. Keep that
-- read narrowly scoped; FORCE RLS and the workspace policy remain enabled.
GRANT SELECT ON public.publish_media_orphan_tasks TO merchant_schema_owner;

REVOKE ALL ON FUNCTION public.append_publish_media_orphan_event_from_task() FROM PUBLIC;
DROP TRIGGER IF EXISTS publish_media_orphan_task_event_append ON public.publish_media_orphan_tasks;
CREATE TRIGGER publish_media_orphan_task_event_append
  AFTER INSERT OR UPDATE OF state,receipt,reason ON public.publish_media_orphan_tasks
  FOR EACH ROW EXECUTE FUNCTION public.append_publish_media_orphan_event_from_task();

-- Any direct event insert at trigger depth 1 is rejected. The one legal path
-- is the nested INSERT performed by the task AFTER trigger above.
CREATE OR REPLACE FUNCTION public.enforce_publish_media_orphan_event_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $publish_media_orphan_event_insert_guard$
DECLARE task_state text; task_reason text; task_receipt jsonb;
BEGIN
  IF pg_catalog.pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION 'publish media events are emitted by lifecycle task writes only'
      USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_event_state';
  END IF;
  IF NEW.state NOT IN ('intent','uploaded','orphaned','retained','unknown') THEN
    RAISE EXCEPTION 'publish media history state is invalid'
      USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_event_state';
  END IF;
  SELECT t.state,t.reason,t.receipt INTO task_state,task_reason,task_receipt
    FROM public.publish_media_orphan_tasks t
   WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  IF NOT FOUND OR NEW.state IS DISTINCT FROM task_state
     OR NEW.detail IS DISTINCT FROM pg_catalog.jsonb_build_object('reason',task_reason,'hasReceipt',task_receipt IS NOT NULL) THEN
    RAISE EXCEPTION 'publish media event must reflect its bound task row'
      USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_event_state';
  END IF;
  RETURN NEW;
END
$publish_media_orphan_event_insert_guard$;
REVOKE ALL ON FUNCTION public.enforce_publish_media_orphan_event_insert() FROM PUBLIC;
DROP TRIGGER IF EXISTS publish_media_orphan_events_insert_guard ON public.publish_media_orphan_events;
CREATE TRIGGER publish_media_orphan_events_insert_guard
  BEFORE INSERT ON public.publish_media_orphan_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_publish_media_orphan_event_insert();

REVOKE INSERT ON public.publish_media_orphan_events FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE INSERT ON public.publish_media_orphan_events FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    REVOKE INSERT ON public.publish_media_orphan_events FROM merchant_ops;
  END IF;
END $$;
