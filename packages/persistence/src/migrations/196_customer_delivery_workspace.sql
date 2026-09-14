-- 196_customer_delivery_workspace: durable customer-delivery checklist.
-- This is an operator-facing projection over an existing workspace. It keeps
-- delivery progress separate from business data and never deletes records.

CREATE TABLE IF NOT EXISTS workspace_customer_deliveries (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL CHECK (length(btrim(company_name)) BETWEEN 1 AND 200),
  contract_number TEXT,
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'paid')),
  contract_ref TEXT,
  project_owner TEXT,
  support_owner TEXT,
  payment_date DATE,
  planned_go_live_at TIMESTAMPTZ,
  customer_profile_status TEXT NOT NULL DEFAULT 'incomplete' CHECK (customer_profile_status IN ('incomplete', 'complete')),
  system_integration_status TEXT NOT NULL DEFAULT 'incomplete' CHECK (system_integration_status IN ('incomplete', 'complete')),
  functional_acceptance_status TEXT NOT NULL DEFAULT 'incomplete' CHECK (functional_acceptance_status IN ('incomplete', 'complete')),
  training_completed BOOLEAN NOT NULL DEFAULT false,
  effective_at TIMESTAMPTZ,
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_actor_id TEXT NOT NULL,
  updated_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS workspace_customer_delivery_videos (
  id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  delivery_id TEXT NOT NULL,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
  asset_ref TEXT NOT NULL CHECK (length(btrim(asset_ref)) BETWEEN 1 AND 2000),
  sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  uploaded_by_actor_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT customer_delivery_video_delivery_fk
    FOREIGN KEY (workspace_id, delivery_id)
    REFERENCES workspace_customer_deliveries(workspace_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS customer_deliveries_workspace_updated_idx
  ON workspace_customer_deliveries(workspace_id, updated_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS customer_deliveries_workspace_company_unique_idx
  ON workspace_customer_deliveries(workspace_id, lower(btrim(company_name)));
CREATE INDEX IF NOT EXISTS customer_delivery_videos_delivery_idx
  ON workspace_customer_delivery_videos(workspace_id, delivery_id, sort_order, id);

DO $customer_delivery_rls$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['workspace_customer_deliveries', 'workspace_customer_delivery_videos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))',
      table_name || '_workspace_isolation', table_name
    );
  END LOOP;
END
$customer_delivery_rls$;

DO $customer_delivery_acl$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_app') THEN
    REVOKE ALL ON workspace_customer_deliveries, workspace_customer_delivery_videos FROM merchant_app;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'merchant_ops') THEN
    GRANT SELECT, INSERT, UPDATE ON workspace_customer_deliveries TO merchant_ops;
    GRANT SELECT, INSERT ON workspace_customer_delivery_videos TO merchant_ops;
    REVOKE DELETE, TRUNCATE ON workspace_customer_deliveries, workspace_customer_delivery_videos FROM merchant_ops;
  END IF;
END
$customer_delivery_acl$;
