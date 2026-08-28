-- 005_generation_jobs: durable asynchronous model-generation jobs.
ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_check;
ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_check
  CHECK (entity_type IN ('product', 'task', 'content_version', 'publish_job', 'platform_account', 'generation_job'));

CREATE TABLE IF NOT EXISTS generation_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  task_id text NOT NULL,
  idempotency_key text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  content_version_id text,
  error_code text,
  error_message text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT generation_jobs_task_workspace_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT generation_jobs_content_workspace_fk FOREIGN KEY (workspace_id, content_version_id) REFERENCES content_versions (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS generation_jobs_workspace_state_idx ON generation_jobs (workspace_id, state, created_at);
ALTER TABLE generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE generation_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS generation_jobs_workspace_isolation ON generation_jobs;
CREATE POLICY generation_jobs_workspace_isolation ON generation_jobs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
