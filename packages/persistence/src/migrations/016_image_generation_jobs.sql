-- 016_image_generation_jobs: durable, tenant-scoped generated image candidate history.
ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_check;
ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_check
  CHECK (entity_type IN ('product', 'task', 'content_version', 'publish_job', 'platform_account', 'generation_job', 'brand_profile', 'asset', 'feedback', 'sync_job', 'image_generation_job'));

CREATE TABLE IF NOT EXISTS image_generation_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  product_id text NOT NULL,
  task_id text,
  content_version_id text,
  idempotency_key text NOT NULL,
  intent_hash text NOT NULL CHECK (intent_hash ~ '^[0-9a-f]{64}$'),
  source_product_version integer NOT NULL CHECK (source_product_version >= 1),
  direction text NOT NULL,
  requested_count integer NOT NULL CHECK (requested_count BETWEEN 1 AND 6),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed')),
  artifact_role text NOT NULL CHECK (artifact_role = 'candidate'),
  archive_state text NOT NULL CHECK (archive_state IN ('pending', 'archived', 'partial', 'external_unarchived')),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT image_generation_jobs_product_workspace_fk FOREIGN KEY (workspace_id, product_id) REFERENCES products (workspace_id, id),
  CONSTRAINT image_generation_jobs_task_workspace_fk FOREIGN KEY (workspace_id, task_id) REFERENCES tasks (workspace_id, id),
  CONSTRAINT image_generation_jobs_content_workspace_fk FOREIGN KEY (workspace_id, content_version_id) REFERENCES content_versions (workspace_id, id),
  CONSTRAINT image_generation_jobs_binding_check CHECK (content_version_id IS NULL OR task_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS image_generation_jobs_workspace_binding_idx ON image_generation_jobs (workspace_id, content_version_id, created_at DESC);
ALTER TABLE image_generation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE image_generation_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS image_generation_jobs_workspace_isolation ON image_generation_jobs;
CREATE POLICY image_generation_jobs_workspace_isolation ON image_generation_jobs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
