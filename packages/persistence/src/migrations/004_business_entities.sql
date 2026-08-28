-- 004_business_entities: durable merchant business entities.
-- Apply after 001-003. Every business table carries workspace_id and is
-- protected by forced RLS plus composite tenant foreign keys.

CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_workspace_id_idx
  ON platform_accounts (workspace_id, id);

CREATE TABLE IF NOT EXISTS products (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  platform text NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  platform_account_id text,
  store_name text NOT NULL DEFAULT '',
  remote_product_id text NOT NULL,
  title text NOT NULL,
  sku_count integer NOT NULL DEFAULT 0 CHECK (sku_count >= 0),
  stock integer NOT NULL DEFAULT 0 CHECK (stock >= 0),
  price numeric(18, 4) CHECK (price IS NULL OR price >= 0),
  category text,
  images jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(images) = 'array'),
  attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(attributes) = 'object'),
  facts_confirmed boolean NOT NULL DEFAULT false,
  source text NOT NULL CHECK (source IN ('official_api', 'csv', 'fixture')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CONSTRAINT products_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT products_workspace_platform_remote_key UNIQUE (workspace_id, platform, remote_product_id),
  CONSTRAINT products_platform_account_workspace_fk FOREIGN KEY (workspace_id, platform_account_id)
    REFERENCES platform_accounts (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  product_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  platform_account_id text,
  state text NOT NULL CHECK (state IN (
    'draft', 'resolving_context', 'blocked_missing_facts', 'blocked_conflict',
    'ready_for_direction', 'direction_selected', 'plan_confirmed', 'generating',
    'review_required', 'changes_requested', 'approved', 'publish_prepared',
    'publishing', 'delivered', 'failed_recoverable', 'failed_terminal', 'canceled'
  )),
  selected_direction_id text,
  current_content_version_id text,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  CONSTRAINT tasks_product_workspace_fk FOREIGN KEY (workspace_id, product_id)
    REFERENCES products (workspace_id, id),
  CONSTRAINT tasks_platform_account_workspace_fk FOREIGN KEY (workspace_id, platform_account_id)
    REFERENCES platform_accounts (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS task_snapshots (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  task_id text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  state text NOT NULL,
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, task_id, version),
  CONSTRAINT task_snapshots_task_workspace_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS content_versions (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  task_id text NOT NULL,
  parent_id text,
  version integer NOT NULL CHECK (version > 0),
  body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
  fact_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fact_version_ids) = 'array'),
  rule_version_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(rule_version_ids) = 'array'),
  state text NOT NULL CHECK (state IN ('draft', 'review_required', 'approved', 'delivered')),
  created_by text NOT NULL,
  reason text NOT NULL DEFAULT '',
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, task_id, version),
  CONSTRAINT content_versions_task_workspace_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id),
  CONSTRAINT content_versions_parent_workspace_fk FOREIGN KEY (workspace_id, parent_id)
    REFERENCES content_versions (workspace_id, id)
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_current_content_version_workspace_fk'
      AND conrelid = 'tasks'::regclass
  ) THEN
    ALTER TABLE tasks
      ADD CONSTRAINT tasks_current_content_version_workspace_fk
      FOREIGN KEY (workspace_id, current_content_version_id)
      REFERENCES content_versions (workspace_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS publish_jobs (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  task_id text NOT NULL,
  content_version_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  platform_account_id text,
  idempotency_key text NOT NULL,
  confirmation_hash text NOT NULL,
  remote_snapshot_hash text NOT NULL,
  confirmation_token_value text,
  state text NOT NULL CHECK (state IN (
    'prepared', 'confirmed', 'queued', 'submitting', 'submitted', 'reviewing',
    'published', 'rejected', 'unknown', 'reconciling', 'manual_attention'
  )),
  attempt integer NOT NULL DEFAULT 1 CHECK (attempt > 0),
  remote_id text,
  request_id text,
  remote_observed_at timestamptz,
  remote_state text CHECK (remote_state IS NULL OR remote_state IN ('submitted', 'published', 'rejected', 'unknown')),
  remote_simulated boolean NOT NULL DEFAULT false,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT publish_jobs_task_workspace_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id),
  CONSTRAINT publish_jobs_content_version_workspace_fk FOREIGN KEY (workspace_id, content_version_id)
    REFERENCES content_versions (workspace_id, id),
  CONSTRAINT publish_jobs_platform_account_workspace_fk FOREIGN KEY (workspace_id, platform_account_id)
    REFERENCES platform_accounts (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS publish_observations (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES workspaces(id),
  publish_job_id text NOT NULL,
  source text NOT NULL CHECK (source IN ('publish', 'reconcile')),
  state text NOT NULL CHECK (state IN ('submitted', 'published', 'rejected', 'unknown')),
  found boolean NOT NULL DEFAULT false,
  remote_id text,
  request_id text,
  simulated boolean NOT NULL DEFAULT false,
  observed_at timestamptz NOT NULL DEFAULT now(),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
  UNIQUE (workspace_id, id),
  CONSTRAINT publish_observations_job_workspace_fk FOREIGN KEY (workspace_id, publish_job_id)
    REFERENCES publish_jobs (workspace_id, id)
);

CREATE INDEX IF NOT EXISTS products_workspace_updated_idx
  ON products (workspace_id, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS products_workspace_platform_idx
  ON products (workspace_id, platform, updated_at DESC);
CREATE INDEX IF NOT EXISTS tasks_workspace_state_idx
  ON tasks (workspace_id, state, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS tasks_workspace_product_idx
  ON tasks (workspace_id, product_id, created_at DESC);
CREATE INDEX IF NOT EXISTS task_snapshots_workspace_task_idx
  ON task_snapshots (workspace_id, task_id, version DESC);
CREATE INDEX IF NOT EXISTS content_versions_workspace_task_idx
  ON content_versions (workspace_id, task_id, version DESC);
CREATE INDEX IF NOT EXISTS content_versions_workspace_state_idx
  ON content_versions (workspace_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS publish_jobs_dispatch_idx
  ON publish_jobs (workspace_id, state, created_at, id)
  WHERE state IN ('confirmed', 'queued', 'submitting', 'unknown', 'reconciling');
CREATE INDEX IF NOT EXISTS publish_jobs_workspace_state_idx
  ON publish_jobs (workspace_id, state, updated_at DESC, id);
CREATE INDEX IF NOT EXISTS publish_jobs_workspace_task_idx
  ON publish_jobs (workspace_id, task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS publish_observations_reconcile_idx
  ON publish_observations (workspace_id, publish_job_id, observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS publish_observations_request_id_idx
  ON publish_observations (workspace_id, request_id)
  WHERE request_id IS NOT NULL;

-- Durable compatibility read model used while aggregate routes migrate away
-- from MerchantService's in-process Maps. It is versioned and tenant-scoped.
CREATE TABLE IF NOT EXISTS business_entity_snapshots (
  workspace_id text NOT NULL REFERENCES workspaces(id),
  entity_type text NOT NULL CHECK (entity_type IN ('product', 'task', 'content_version', 'publish_job', 'platform_account')),
  entity_id text NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version > 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS business_entity_snapshots_workspace_type_idx
  ON business_entity_snapshots (workspace_id, entity_type, updated_at DESC, entity_id);

ALTER TABLE business_entity_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE business_entity_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS business_entity_snapshots_workspace_isolation ON business_entity_snapshots;
CREATE POLICY business_entity_snapshots_workspace_isolation ON business_entity_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE products FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS products_workspace_isolation ON products;
CREATE POLICY products_workspace_isolation ON products
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tasks_workspace_isolation ON tasks;
CREATE POLICY tasks_workspace_isolation ON tasks
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE task_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS task_snapshots_workspace_isolation ON task_snapshots;
CREATE POLICY task_snapshots_workspace_isolation ON task_snapshots
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE content_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_versions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS content_versions_workspace_isolation ON content_versions;
CREATE POLICY content_versions_workspace_isolation ON content_versions
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE publish_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS publish_jobs_workspace_isolation ON publish_jobs;
CREATE POLICY publish_jobs_workspace_isolation ON publish_jobs
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));

ALTER TABLE publish_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE publish_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS publish_observations_workspace_isolation ON publish_observations;
CREATE POLICY publish_observations_workspace_isolation ON publish_observations
  USING (workspace_id = current_setting('app.workspace_id', true))
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true));
