-- 043_route_b_expand: additive structures for the gradual unified data path.
-- This migration intentionally does not remove legacy columns or enforce
-- backfill-dependent NOT NULL constraints. Contracting happens only after
-- shadow reads and workspace-level cutover evidence are clean.

ALTER TABLE batch_campaign_items
  ALTER COLUMN canonical_product_id DROP NOT NULL,
  ALTER COLUMN listing_id DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS legacy_product_id text,
  ADD COLUMN IF NOT EXISTS platform text,
  ADD COLUMN IF NOT EXISTS platform_account_id text,
  ADD COLUMN IF NOT EXISTS ordinal integer;

ALTER TABLE batch_campaign_items
  DROP CONSTRAINT IF EXISTS batch_campaign_items_legacy_product_fk,
  ADD CONSTRAINT batch_campaign_items_legacy_product_fk
    FOREIGN KEY (workspace_id, legacy_product_id) REFERENCES products (workspace_id, id),
  DROP CONSTRAINT IF EXISTS batch_campaign_items_account_fk,
  ADD CONSTRAINT batch_campaign_items_account_fk
    FOREIGN KEY (workspace_id, platform_account_id) REFERENCES platform_accounts (workspace_id, id);

CREATE UNIQUE INDEX IF NOT EXISTS batch_campaign_items_ordinal_key
  ON batch_campaign_items (workspace_id, campaign_id, ordinal)
  WHERE ordinal IS NOT NULL;

ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS brand_id text,
  ADD COLUMN IF NOT EXISTS canonical_product_id text,
  ADD COLUMN IF NOT EXISTS listing_id text,
  ADD COLUMN IF NOT EXISTS campaign_id text,
  ADD COLUMN IF NOT EXISTS campaign_item_id text;

CREATE UNIQUE INDEX IF NOT EXISTS canonical_products_brand_identity_key
  ON canonical_products (workspace_id, brand_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS product_listings_product_identity_key
  ON product_listings (workspace_id, brand_id, canonical_product_id, id);

ALTER TABLE batch_campaign_items
  DROP CONSTRAINT IF EXISTS batch_campaign_items_brand_canonical_fk,
  ADD CONSTRAINT batch_campaign_items_brand_canonical_fk
    FOREIGN KEY (workspace_id, brand_id, canonical_product_id)
    REFERENCES canonical_products (workspace_id, brand_id, id) NOT VALID,
  DROP CONSTRAINT IF EXISTS batch_campaign_items_product_listing_fk,
  ADD CONSTRAINT batch_campaign_items_product_listing_fk
    FOREIGN KEY (workspace_id, brand_id, canonical_product_id, listing_id)
    REFERENCES product_listings (workspace_id, brand_id, canonical_product_id, id) NOT VALID,
  DROP CONSTRAINT IF EXISTS batch_campaign_items_listing_requires_product_check,
  ADD CONSTRAINT batch_campaign_items_listing_requires_product_check
    CHECK (listing_id IS NULL OR canonical_product_id IS NOT NULL) NOT VALID;

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_brand_fk,
  ADD CONSTRAINT tasks_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_brand_canonical_fk,
  ADD CONSTRAINT tasks_brand_canonical_fk FOREIGN KEY (workspace_id, brand_id, canonical_product_id)
    REFERENCES canonical_products (workspace_id, brand_id, id) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_product_listing_fk,
  ADD CONSTRAINT tasks_product_listing_fk FOREIGN KEY (workspace_id, brand_id, canonical_product_id, listing_id)
    REFERENCES product_listings (workspace_id, brand_id, canonical_product_id, id) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_campaign_item_fk,
  ADD CONSTRAINT tasks_campaign_item_fk FOREIGN KEY (workspace_id, campaign_id, campaign_item_id)
    REFERENCES batch_campaign_items (workspace_id, campaign_id, id) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_campaign_pair_check,
  ADD CONSTRAINT tasks_campaign_pair_check CHECK ((campaign_id IS NULL) = (campaign_item_id IS NULL)) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_listing_requires_product_check,
  ADD CONSTRAINT tasks_listing_requires_product_check CHECK (listing_id IS NULL OR (brand_id IS NOT NULL AND canonical_product_id IS NOT NULL)) NOT VALID;

CREATE INDEX IF NOT EXISTS tasks_unified_scope_idx
  ON tasks (workspace_id, brand_id, canonical_product_id, listing_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS context_blobs (
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_hash text NOT NULL CHECK (context_hash ~ '^[0-9a-f]{64}$'),
  envelope jsonb NOT NULL CHECK (jsonb_typeof(envelope) = 'object'),
  input_tokens_estimate integer NOT NULL CHECK (input_tokens_estimate >= 0),
  max_input_tokens integer NOT NULL CHECK (max_input_tokens > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, context_hash)
);

CREATE TABLE IF NOT EXISTS context_snapshot_links (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_hash text NOT NULL,
  brand_id text NOT NULL,
  campaign_id text,
  campaign_item_id text,
  task_id text,
  canonical_product_id text,
  listing_id text,
  versions jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(versions) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  CONSTRAINT context_snapshot_links_blob_fk FOREIGN KEY (workspace_id, context_hash)
    REFERENCES context_blobs (workspace_id, context_hash),
  CONSTRAINT context_snapshot_links_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id),
  CONSTRAINT context_snapshot_links_campaign_item_fk FOREIGN KEY (workspace_id, campaign_id, campaign_item_id)
    REFERENCES batch_campaign_items (workspace_id, campaign_id, id),
  CONSTRAINT context_snapshot_links_task_fk FOREIGN KEY (workspace_id, task_id)
    REFERENCES tasks (workspace_id, id),
  CONSTRAINT context_snapshot_links_campaign_pair_check CHECK ((campaign_id IS NULL) = (campaign_item_id IS NULL))
);

CREATE INDEX IF NOT EXISTS context_snapshot_links_scope_idx
  ON context_snapshot_links (workspace_id, brand_id, campaign_id, campaign_item_id, created_at DESC);

CREATE TABLE IF NOT EXISTS brand_asset_bindings (
  workspace_id text NOT NULL,
  brand_id text NOT NULL,
  asset_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, brand_id, asset_id),
  CONSTRAINT brand_asset_bindings_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS brand_rule_bindings (
  workspace_id text NOT NULL,
  brand_id text NOT NULL,
  rule_version_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, brand_id, rule_version_id),
  CONSTRAINT brand_rule_bindings_brand_fk FOREIGN KEY (workspace_id, brand_id)
    REFERENCES brands (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT brand_rule_bindings_rule_fk FOREIGN KEY (workspace_id, rule_version_id)
    REFERENCES rule_pack_versions (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS object_storage_orphans (
  id text NOT NULL,
  workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  object_key text NOT NULL,
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'cleaned', 'manual_attention')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error text,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, object_key)
);

ALTER TABLE action_ledger
  ADD COLUMN IF NOT EXISTS campaign_item_id text,
  ADD COLUMN IF NOT EXISTS task_id text,
  ADD COLUMN IF NOT EXISTS provider_request_id text,
  ADD COLUMN IF NOT EXISTS reserved_amount_fen bigint CHECK (reserved_amount_fen IS NULL OR reserved_amount_fen >= 0),
  ADD COLUMN IF NOT EXISTS actual_cost_micros bigint CHECK (actual_cost_micros IS NULL OR actual_cost_micros >= 0),
  ADD COLUMN IF NOT EXISTS multiplier numeric(10,4) CHECK (multiplier IS NULL OR multiplier >= 1),
  ADD COLUMN IF NOT EXISTS settlement_status text NOT NULL DEFAULT 'settled'
    CHECK (settlement_status IN ('authorized', 'pending_receipt', 'settled', 'released', 'refunded', 'manual_attention'));

CREATE UNIQUE INDEX IF NOT EXISTS action_ledger_provider_request_key
  ON action_ledger (workspace_id, provider_request_id)
  WHERE provider_request_id IS NOT NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['context_blobs', 'context_snapshot_links', 'brand_asset_bindings', 'brand_rule_bindings', 'object_storage_orphans']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', table_name || '_workspace_isolation', table_name);
    EXECUTE format('CREATE POLICY %I ON %I USING (workspace_id = current_setting(''app.workspace_id'', true)) WITH CHECK (workspace_id = current_setting(''app.workspace_id'', true))', table_name || '_workspace_isolation', table_name);
  END LOOP;
END $$;
