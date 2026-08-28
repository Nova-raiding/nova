-- 047_route_b_task_projection: make Route B task scope queryable and enforceable.
-- 043 added nullable columns and NOT VALID constraints. This migration backfills
-- those columns from the durable compatibility snapshot, adds the full campaign
-- item scope relationship, and validates every task-side Route B constraint.

UPDATE tasks
SET brand_id = COALESCE(brand_id, NULLIF(btrim(data->>'brandId'), '')),
    canonical_product_id = COALESCE(canonical_product_id, NULLIF(btrim(data->>'canonicalProductId'), '')),
    listing_id = COALESCE(listing_id, NULLIF(btrim(data->>'listingId'), '')),
    campaign_id = COALESCE(campaign_id, NULLIF(btrim(data->>'campaignId'), '')),
    campaign_item_id = COALESCE(campaign_item_id, NULLIF(btrim(data->>'campaignItemId'), ''))
WHERE (brand_id IS NULL AND NULLIF(btrim(data->>'brandId'), '') IS NOT NULL)
   OR (canonical_product_id IS NULL AND NULLIF(btrim(data->>'canonicalProductId'), '') IS NOT NULL)
   OR (listing_id IS NULL AND NULLIF(btrim(data->>'listingId'), '') IS NOT NULL)
   OR (campaign_id IS NULL AND NULLIF(btrim(data->>'campaignId'), '') IS NOT NULL)
   OR (campaign_item_id IS NULL AND NULLIF(btrim(data->>'campaignItemId'), '') IS NOT NULL);

CREATE UNIQUE INDEX IF NOT EXISTS batch_campaign_items_task_scope_key
  ON batch_campaign_items (
    workspace_id, campaign_id, id, brand_id, canonical_product_id, listing_id
  );

ALTER TABLE tasks
  DROP CONSTRAINT IF EXISTS tasks_canonical_requires_brand_check,
  ADD CONSTRAINT tasks_canonical_requires_brand_check
    CHECK (canonical_product_id IS NULL OR brand_id IS NOT NULL) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_campaign_scope_complete_check,
  ADD CONSTRAINT tasks_campaign_scope_complete_check
    CHECK (
      campaign_item_id IS NULL
      OR (brand_id IS NOT NULL AND canonical_product_id IS NOT NULL AND listing_id IS NOT NULL)
    ) NOT VALID,
  DROP CONSTRAINT IF EXISTS tasks_campaign_item_scope_fk,
  ADD CONSTRAINT tasks_campaign_item_scope_fk
    FOREIGN KEY (
      workspace_id, campaign_id, campaign_item_id, brand_id, canonical_product_id, listing_id
    )
    REFERENCES batch_campaign_items (
      workspace_id, campaign_id, id, brand_id, canonical_product_id, listing_id
    ) NOT VALID;

CREATE INDEX IF NOT EXISTS tasks_campaign_scope_idx
  ON tasks (workspace_id, campaign_id, campaign_item_id, updated_at DESC)
  WHERE campaign_item_id IS NOT NULL;

ALTER TABLE tasks VALIDATE CONSTRAINT tasks_brand_fk;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_brand_canonical_fk;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_product_listing_fk;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_campaign_item_fk;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_campaign_pair_check;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_listing_requires_product_check;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_canonical_requires_brand_check;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_campaign_scope_complete_check;
ALTER TABLE tasks VALIDATE CONSTRAINT tasks_campaign_item_scope_fk;
