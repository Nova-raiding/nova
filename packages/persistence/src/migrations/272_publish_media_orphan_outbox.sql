-- Durable record of media uploaded for a publish attempt. This is a recovery
-- ledger: it does not imply that a platform supports deleting the object.
CREATE UNIQUE INDEX IF NOT EXISTS outbox_events_workspace_aggregate_id_unique ON outbox_events(workspace_id,aggregate_id,id);
CREATE TABLE IF NOT EXISTS publish_media_orphan_tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  publish_job_id text NOT NULL,
  event_id text NOT NULL,
  media_idempotency_key text NOT NULL,
  platform text NOT NULL,
  account_id text NOT NULL,
  visual_ref text NOT NULL,
  role text NOT NULL CHECK (role IN ('main','secondary')),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  state text NOT NULL CHECK (state IN ('intent','uploaded','orphaned','retained','unknown','deleted')),
  receipt jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, publish_job_id, media_idempotency_key),
  UNIQUE (workspace_id,id),
  FOREIGN KEY (workspace_id, publish_job_id) REFERENCES publish_jobs (workspace_id,id),
  FOREIGN KEY (workspace_id, publish_job_id, event_id) REFERENCES outbox_events (workspace_id,aggregate_id,id)
);
-- The event must be the durable publish request that authorizes this job's
-- external media work. The composite FK binds its aggregate; this trigger
-- also rejects unrelated event types from the same aggregate.
CREATE OR REPLACE FUNCTION enforce_publish_media_orphan_event_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events e
    WHERE e.workspace_id=NEW.workspace_id
      AND e.aggregate_id=NEW.publish_job_id
      AND e.id=NEW.event_id
      AND e.event_type='publish.requested'
  ) THEN
    RAISE EXCEPTION 'publish media recovery event must be the job publish request'
      USING ERRCODE='23514', CONSTRAINT='publish_media_orphan_event_binding';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER publish_media_orphan_event_binding
  BEFORE INSERT OR UPDATE OF workspace_id,publish_job_id,event_id ON publish_media_orphan_tasks
  FOR EACH ROW EXECUTE FUNCTION enforce_publish_media_orphan_event_binding();
CREATE TABLE IF NOT EXISTS publish_media_orphan_events (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  task_id text NOT NULL,
  state text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, task_id) REFERENCES publish_media_orphan_tasks (workspace_id,id)
);
ALTER TABLE publish_media_orphan_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_media_orphan_tasks FORCE ROW LEVEL SECURITY;
ALTER TABLE publish_media_orphan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_media_orphan_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS publish_media_orphan_tasks_workspace_isolation ON publish_media_orphan_tasks;
CREATE POLICY publish_media_orphan_tasks_workspace_isolation ON publish_media_orphan_tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
DROP POLICY IF EXISTS publish_media_orphan_events_workspace_isolation ON publish_media_orphan_events;
CREATE POLICY publish_media_orphan_events_workspace_isolation ON publish_media_orphan_events
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
CREATE INDEX IF NOT EXISTS publish_media_orphan_tasks_workspace_state_idx
  ON publish_media_orphan_tasks (workspace_id,state,updated_at);
CREATE OR REPLACE FUNCTION reject_publish_media_orphan_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $publish_media_orphan_event_immutable$
BEGIN RAISE EXCEPTION 'publish media recovery history is append-only' USING ERRCODE = '55000'; END;
$publish_media_orphan_event_immutable$;
DROP TRIGGER IF EXISTS publish_media_orphan_events_append_only ON publish_media_orphan_events;
CREATE TRIGGER publish_media_orphan_events_append_only BEFORE UPDATE OR DELETE ON publish_media_orphan_events
  FOR EACH ROW EXECUTE FUNCTION reject_publish_media_orphan_event_mutation();
REVOKE ALL ON FUNCTION reject_publish_media_orphan_event_mutation() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    GRANT SELECT, INSERT, UPDATE ON publish_media_orphan_tasks TO merchant_app;
    GRANT SELECT, INSERT ON publish_media_orphan_events TO merchant_app;
  END IF;
END $$;
