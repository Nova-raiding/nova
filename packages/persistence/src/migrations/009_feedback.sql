-- 009_feedback: tenant-scoped post-delivery feedback.
ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_check;
ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_check
  CHECK (entity_type IN ('product', 'task', 'content_version', 'publish_job', 'platform_account', 'generation_job', 'brand_profile', 'asset', 'feedback'));

CREATE TABLE IF NOT EXISTS task_feedback (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  task_id text NOT NULL,
  content_version_id text,
  rating text NOT NULL CHECK (rating IN ('liked', 'neutral', 'needs_improvement')),
  reason text,
  comment text,
  actor_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS task_feedback_workspace_task_idx ON task_feedback (workspace_id, task_id, created_at DESC, id DESC);
ALTER TABLE task_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_feedback FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_feedback_workspace_isolation ON task_feedback;
CREATE POLICY task_feedback_workspace_isolation ON task_feedback
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
