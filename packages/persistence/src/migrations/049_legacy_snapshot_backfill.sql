-- 049_legacy_snapshot_backfill: recover compatibility-only product, task and
-- generation-job snapshots into the normalized read model.
--
-- This is deliberately conservative. Snapshot payload remains the recovery
-- source for any row or optional relationship that cannot satisfy the current
-- tenant, enum, FK, uniqueness and Route B constraints. Existing normalized
-- rows are never updated.

-- 1. Products have no normalized parent other than their workspace. Optional
-- account scope is retained only when the account belongs to the same
-- workspace and platform.
INSERT INTO products (
  id, workspace_id, platform, platform_account_id, store_name,
  remote_product_id, title, sku_count, stock, price, category,
  images, attributes, facts_confirmed, source, version, data,
  created_at, updated_at
)
SELECT
  snapshot.entity_id,
  snapshot.workspace_id,
  snapshot.payload->>'platform',
  account.id,
  CASE
    WHEN jsonb_typeof(snapshot.payload->'storeName') = 'string'
      THEN snapshot.payload->>'storeName'
    ELSE ''
  END,
  CASE
    WHEN jsonb_typeof(snapshot.payload->'remoteId') = 'string'
         AND btrim(snapshot.payload->>'remoteId') <> ''
      THEN snapshot.payload->>'remoteId'
    ELSE NULL
  END,
  snapshot.payload->>'title',
  (snapshot.payload->>'skuCount')::integer,
  (snapshot.payload->>'stock')::integer,
  CASE
    WHEN jsonb_typeof(snapshot.payload->'price') = 'number'
      THEN (snapshot.payload->>'price')::numeric(18, 4)
    ELSE NULL
  END,
  CASE
    WHEN jsonb_typeof(snapshot.payload->'category') = 'string'
         AND btrim(snapshot.payload->>'category') <> ''
      THEN snapshot.payload->>'category'
    ELSE NULL
  END,
  CASE WHEN jsonb_typeof(snapshot.payload->'images') = 'array' THEN snapshot.payload->'images' ELSE '[]'::jsonb END,
  CASE WHEN jsonb_typeof(snapshot.payload->'attributes') = 'object' THEN snapshot.payload->'attributes' ELSE '{}'::jsonb END,
  CASE WHEN snapshot.payload->'factsConfirmed' = 'true'::jsonb THEN true ELSE false END,
  snapshot.payload->>'source',
  snapshot.entity_version,
  snapshot.payload,
  snapshot.created_at,
  snapshot.updated_at
FROM business_entity_snapshots snapshot
LEFT JOIN platform_accounts account
  ON account.workspace_id = snapshot.workspace_id
 AND account.platform = snapshot.payload->>'platform'
 AND account.id = NULLIF(btrim(snapshot.payload->>'accountId'), '')
WHERE snapshot.entity_type = 'product'
  AND jsonb_typeof(snapshot.payload->'id') = 'string'
  AND snapshot.payload->>'id' = snapshot.entity_id
  AND jsonb_typeof(snapshot.payload->'workspaceId') = 'string'
  AND snapshot.payload->>'workspaceId' = snapshot.workspace_id
  AND snapshot.payload->>'platform' IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')
  AND jsonb_typeof(snapshot.payload->'title') = 'string'
  AND btrim(snapshot.payload->>'title') <> ''
  AND jsonb_typeof(snapshot.payload->'skuCount') = 'number'
  AND snapshot.payload->>'skuCount' ~ '^[0-9]+$'
  AND (snapshot.payload->>'skuCount')::numeric <= 2147483647
  AND jsonb_typeof(snapshot.payload->'stock') = 'number'
  AND snapshot.payload->>'stock' ~ '^[0-9]+$'
  AND (snapshot.payload->>'stock')::numeric <= 2147483647
  AND (
    snapshot.payload->'price' IS NULL
    OR snapshot.payload->'price' = 'null'::jsonb
    OR (
      jsonb_typeof(snapshot.payload->'price') = 'number'
      AND (snapshot.payload->>'price')::numeric >= 0
      AND (snapshot.payload->>'price')::numeric <= 99999999999999.9999
    )
  )
  AND snapshot.payload->>'source' IN ('official_api', 'csv', 'fixture')
ON CONFLICT DO NOTHING;

-- 2. Tasks are considered only after products. Route B columns are projected
-- independently and monotonically: brand -> canonical product -> listing ->
-- campaign item. An unsafe descendant never causes an unsafe ancestor to be
-- written, and the original relationship remains available in data.
WITH task_candidates AS (
  SELECT
    snapshot.*,
    snapshot.payload->>'productId' AS product_id,
    NULLIF(btrim(snapshot.payload->>'accountId'), '') AS requested_account_id,
    NULLIF(btrim(snapshot.payload->>'brandId'), '') AS requested_brand_id,
    NULLIF(btrim(snapshot.payload->>'canonicalProductId'), '') AS requested_canonical_product_id,
    NULLIF(btrim(snapshot.payload->>'listingId'), '') AS requested_listing_id,
    NULLIF(btrim(snapshot.payload->>'campaignId'), '') AS requested_campaign_id,
    NULLIF(btrim(snapshot.payload->>'campaignItemId'), '') AS requested_campaign_item_id
  FROM business_entity_snapshots snapshot
  WHERE snapshot.entity_type = 'task'
    AND jsonb_typeof(snapshot.payload->'id') = 'string'
    AND snapshot.payload->>'id' = snapshot.entity_id
    AND jsonb_typeof(snapshot.payload->'workspaceId') = 'string'
    AND snapshot.payload->>'workspaceId' = snapshot.workspace_id
    AND jsonb_typeof(snapshot.payload->'productId') = 'string'
    AND btrim(snapshot.payload->>'productId') <> ''
    AND snapshot.payload->>'platform' IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin')
    AND snapshot.payload->>'state' IN (
      'draft', 'resolving_context', 'blocked_missing_facts', 'blocked_conflict',
      'ready_for_direction', 'direction_selected', 'plan_confirmed', 'generating',
      'review_required', 'changes_requested', 'approved', 'publish_prepared',
      'publishing', 'delivered', 'failed_recoverable', 'failed_terminal', 'canceled'
    )
), safe_task_scope AS (
  SELECT
    candidate.*,
    account.id AS safe_account_id,
    brand.id AS safe_brand_id,
    canonical.id AS safe_canonical_product_id,
    listing.id AS safe_listing_id,
    campaign_item.campaign_id AS safe_campaign_id,
    campaign_item.id AS safe_campaign_item_id
  FROM task_candidates candidate
  JOIN products product
    ON product.workspace_id = candidate.workspace_id
   AND product.id = candidate.product_id
   AND product.platform = candidate.payload->>'platform'
  LEFT JOIN platform_accounts account
    ON account.workspace_id = candidate.workspace_id
   AND account.platform = candidate.payload->>'platform'
   AND account.id = candidate.requested_account_id
  LEFT JOIN brands brand
    ON brand.workspace_id = candidate.workspace_id
   AND brand.id = candidate.requested_brand_id
  LEFT JOIN canonical_products canonical
    ON canonical.workspace_id = candidate.workspace_id
   AND canonical.brand_id = brand.id
   AND canonical.id = candidate.requested_canonical_product_id
  LEFT JOIN product_listings listing
    ON listing.workspace_id = candidate.workspace_id
   AND listing.brand_id = brand.id
   AND listing.canonical_product_id = canonical.id
   AND listing.id = candidate.requested_listing_id
  LEFT JOIN batch_campaign_items campaign_item
    ON campaign_item.workspace_id = candidate.workspace_id
   AND campaign_item.campaign_id = candidate.requested_campaign_id
   AND campaign_item.id = candidate.requested_campaign_item_id
   AND campaign_item.brand_id = brand.id
   AND campaign_item.canonical_product_id = canonical.id
   AND campaign_item.listing_id = listing.id
)
INSERT INTO tasks (
  id, workspace_id, product_id, platform, platform_account_id,
  brand_id, canonical_product_id, listing_id, campaign_id,
  campaign_item_id, state, selected_direction_id,
  current_content_version_id, version, data, created_at, updated_at
)
SELECT
  candidate.entity_id,
  candidate.workspace_id,
  candidate.product_id,
  candidate.payload->>'platform',
  candidate.safe_account_id,
  candidate.safe_brand_id,
  candidate.safe_canonical_product_id,
  candidate.safe_listing_id,
  CASE WHEN candidate.safe_campaign_item_id IS NOT NULL THEN candidate.safe_campaign_id ELSE NULL END,
  candidate.safe_campaign_item_id,
  candidate.payload->>'state',
  CASE
    WHEN jsonb_typeof(candidate.payload->'selectedDirectionId') = 'string'
         AND btrim(candidate.payload->>'selectedDirectionId') <> ''
      THEN candidate.payload->>'selectedDirectionId'
    ELSE NULL
  END,
  NULL,
  candidate.entity_version,
  candidate.payload,
  candidate.created_at,
  candidate.updated_at
FROM safe_task_scope candidate
ON CONFLICT DO NOTHING;

-- 3. Generation jobs are last. A job is inserted only when its task now
-- exists in the same workspace. Optional content-version scope is retained
-- only when that content version belongs to the same task and workspace.
INSERT INTO generation_jobs (
  id, workspace_id, task_id, idempotency_key, state, attempt,
  content_version_id, error_code, error_message, data,
  created_at, updated_at
)
SELECT
  snapshot.entity_id,
  snapshot.workspace_id,
  task.id,
  snapshot.payload->>'idempotencyKey',
  snapshot.payload->>'state',
  (snapshot.payload->>'attempt')::integer,
  content.id,
  CASE
    WHEN jsonb_typeof(snapshot.payload->'errorCode') = 'string'
         AND btrim(snapshot.payload->>'errorCode') <> ''
      THEN snapshot.payload->>'errorCode'
    ELSE NULL
  END,
  CASE
    WHEN jsonb_typeof(snapshot.payload->'errorMessage') = 'string'
         AND btrim(snapshot.payload->>'errorMessage') <> ''
      THEN snapshot.payload->>'errorMessage'
    ELSE NULL
  END,
  snapshot.payload,
  snapshot.created_at,
  snapshot.updated_at
FROM business_entity_snapshots snapshot
JOIN tasks task
  ON task.workspace_id = snapshot.workspace_id
 AND task.id = snapshot.payload->>'taskId'
LEFT JOIN content_versions content
  ON content.workspace_id = snapshot.workspace_id
 AND content.task_id = task.id
 AND content.id = NULLIF(btrim(snapshot.payload->>'contentVersionId'), '')
WHERE snapshot.entity_type = 'generation_job'
  AND jsonb_typeof(snapshot.payload->'id') = 'string'
  AND snapshot.payload->>'id' = snapshot.entity_id
  AND jsonb_typeof(snapshot.payload->'workspaceId') = 'string'
  AND snapshot.payload->>'workspaceId' = snapshot.workspace_id
  AND jsonb_typeof(snapshot.payload->'taskId') = 'string'
  AND btrim(snapshot.payload->>'taskId') <> ''
  AND jsonb_typeof(snapshot.payload->'idempotencyKey') = 'string'
  AND btrim(snapshot.payload->>'idempotencyKey') <> ''
  AND snapshot.payload->>'state' IN ('queued', 'running', 'succeeded', 'failed')
  AND jsonb_typeof(snapshot.payload->'attempt') = 'number'
  AND snapshot.payload->>'attempt' ~ '^[0-9]+$'
  AND (snapshot.payload->>'attempt')::numeric <= 2147483647
ON CONFLICT DO NOTHING;

-- A narrow legacy repair for events that an old worker definitively rejected
-- before any provider call. The aggregate id and payload job id must both
-- identify the same tenant-scoped generation job. Timeouts, unknown provider
-- outcomes, retryable errors, and every other unknown event remain untouched.
WITH unsupported_generation_events AS (
  SELECT DISTINCT ON (event.workspace_id, event.aggregate_id)
    event.workspace_id,
    event.aggregate_id AS generation_job_id,
    NULLIF(btrim(event.last_error->>'message'), '') AS error_message
  FROM outbox_events event
  WHERE event.event_type = 'generation.requested'
    AND event.unknown_at IS NOT NULL
    AND event.last_error->>'code' = 'UNSUPPORTED_EVENT_TYPE'
    AND event.last_error->'retryable' = 'false'::jsonb
    AND jsonb_typeof(event.payload->'job_id') = 'string'
    AND event.payload->>'job_id' = event.aggregate_id
  ORDER BY event.workspace_id, event.aggregate_id, event.created_at DESC, event.id DESC
)
UPDATE generation_jobs job
SET state = 'failed',
    error_code = 'LEGACY_GENERATION_EVENT_UNRECOVERABLE',
    error_message = COALESCE(
      unsupported.error_message,
      NULLIF(btrim(job.error_message), ''),
      'Legacy generation event was rejected by the worker before provider invocation'
    ),
    updated_at = now()
FROM unsupported_generation_events unsupported
WHERE job.workspace_id = unsupported.workspace_id
  AND job.id = unsupported.generation_job_id
  AND job.state IN ('queued', 'running');
