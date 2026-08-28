-- 039_multi_brand_batch: additive multi-brand, listing and batch primitives.
-- Existing products/brand_profile snapshots remain untouched; callers may
-- backfill these tables in a later, separately reviewed migration.

CREATE UNIQUE INDEX IF NOT EXISTS platform_accounts_workspace_platform_id_key
  ON platform_accounts (workspace_id, platform, id);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_members_workspace_id_id_key
  ON workspace_members (workspace_id, id);

CREATE TABLE IF NOT EXISTS brands (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS brand_store_bindings (
  workspace_id text NOT NULL,
  brand_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  platform_account_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, brand_id, platform_account_id),
  CONSTRAINT brand_store_bindings_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id),
  CONSTRAINT brand_store_bindings_account_platform_fk FOREIGN KEY (workspace_id, platform, platform_account_id)
    REFERENCES platform_accounts (workspace_id, platform, id)
);

CREATE TABLE IF NOT EXISTS brand_access_grants (
  workspace_id text NOT NULL,
  brand_id text NOT NULL,
  member_id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'editor', 'publisher', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, brand_id, member_id),
  CONSTRAINT brand_access_grants_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT brand_access_grants_member_fk FOREIGN KEY (workspace_id, member_id)
    REFERENCES workspace_members (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS canonical_products (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id text NOT NULL,
  title text NOT NULL,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(facts) = 'object'),
  facts_revision integer NOT NULL DEFAULT 1 CHECK (facts_revision > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  legacy_product_id text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT canonical_products_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id),
  CONSTRAINT canonical_products_legacy_product_fk FOREIGN KEY (workspace_id, legacy_product_id)
    REFERENCES products (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS product_listings (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  brand_id text NOT NULL,
  canonical_product_id text NOT NULL,
  platform text NOT NULL CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')),
  platform_account_id text NOT NULL,
  remote_product_id text,
  platform_category text,
  title text,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'active', 'disabled', 'unknown')),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(fields) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT product_listings_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id),
  CONSTRAINT product_listings_canonical_fk FOREIGN KEY (workspace_id, canonical_product_id)
    REFERENCES canonical_products (workspace_id, id),
  CONSTRAINT product_listings_brand_store_fk FOREIGN KEY (workspace_id, brand_id, platform_account_id)
    REFERENCES brand_store_bindings (workspace_id, brand_id, platform_account_id),
  CONSTRAINT product_listings_account_platform_fk FOREIGN KEY (workspace_id, platform, platform_account_id)
    REFERENCES platform_accounts (workspace_id, platform, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS product_listings_remote_identity_key
  ON product_listings (workspace_id, platform, platform_account_id, remote_product_id)
  WHERE remote_product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS product_listings_scope_idx
  ON product_listings (workspace_id, brand_id, platform, platform_account_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS batch_campaigns (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'preflighting', 'ready', 'blocked', 'generating', 'review_required', 'publishing', 'partial', 'completed', 'failed', 'paused', 'unknown', 'manual_attention')),
  idempotency_key text NOT NULL,
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  UNIQUE (workspace_id, id, revision)
);

CREATE TABLE IF NOT EXISTS batch_campaign_items (
  id text NOT NULL,
  workspace_id text NOT NULL,
  campaign_id text NOT NULL,
  brand_id text NOT NULL,
  canonical_product_id text NOT NULL,
  listing_id text NOT NULL,
  task_id text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'blocked', 'generating', 'review_required', 'approved', 'publishing', 'published', 'failed', 'unknown', 'paused', 'manual_attention')),
  input_snapshot_hash text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  error jsonb CHECK (error IS NULL OR jsonb_typeof(error) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, campaign_id, id),
  CONSTRAINT batch_campaign_items_campaign_fk FOREIGN KEY (workspace_id, campaign_id)
    REFERENCES batch_campaigns (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT batch_campaign_items_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id),
  CONSTRAINT batch_campaign_items_canonical_fk FOREIGN KEY (workspace_id, canonical_product_id)
    REFERENCES canonical_products (workspace_id, id),
  CONSTRAINT batch_campaign_items_listing_fk FOREIGN KEY (workspace_id, listing_id)
    REFERENCES product_listings (workspace_id, id),
  CONSTRAINT batch_campaign_items_task_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS batch_campaign_items_state_idx
  ON batch_campaign_items (workspace_id, campaign_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_snapshots (
  id text NOT NULL,
  workspace_id text NOT NULL,
  brand_id text NOT NULL,
  campaign_id text,
  campaign_item_id text,
  canonical_product_id text,
  listing_id text,
  task_id text,
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(versions) = 'object'),
  envelope jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(envelope) = 'object'),
  input_tokens_estimate integer CHECK (input_tokens_estimate IS NULL OR input_tokens_estimate >= 0),
  max_input_tokens integer CHECK (max_input_tokens IS NULL OR max_input_tokens > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, context_hash),
  CONSTRAINT context_snapshots_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id),
  CONSTRAINT context_snapshots_campaign_item_fk FOREIGN KEY (workspace_id, campaign_id, campaign_item_id)
    REFERENCES batch_campaign_items (workspace_id, campaign_id, id),
  CONSTRAINT context_snapshots_canonical_fk FOREIGN KEY (workspace_id, canonical_product_id)
    REFERENCES canonical_products (workspace_id, id),
  CONSTRAINT context_snapshots_listing_fk FOREIGN KEY (workspace_id, listing_id)
    REFERENCES product_listings (workspace_id, id),
  CONSTRAINT context_snapshots_task_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id),
  CONSTRAINT context_snapshots_campaign_pair_check CHECK ((campaign_id IS NULL) = (campaign_item_id IS NULL))
);

CREATE INDEX IF NOT EXISTS context_snapshots_scope_idx
  ON context_snapshots (workspace_id, brand_id, canonical_product_id, listing_id, created_at DESC);

DO $$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['brands', 'brand_store_bindings', 'brand_access_grants', 'canonical_products', 'product_listings', 'batch_campaigns', 'batch_campaign_items', 'context_snapshots']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_workspace_isolation', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', table_name || '_workspace_isolation', table_name);
  END LOOP;
END $$;
