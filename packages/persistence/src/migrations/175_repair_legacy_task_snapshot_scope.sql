-- 175_repair_legacy_task_snapshot_scope: repair only legacy task snapshot
-- scope fields that are already authoritative in the normalized tasks row.
-- Do not synthesize publish payloads or visual selections: those fields are
-- intentionally validated and remain fail-closed when their source evidence
-- is unavailable.
UPDATE business_entity_snapshots AS snapshot
SET payload = jsonb_set(
  jsonb_set(
    snapshot.payload,
    '{inputSnapshot,canonicalProductId}',
    to_jsonb(task.canonical_product_id),
    true
  ),
  '{inputSnapshot,listingId}',
  to_jsonb(task.listing_id),
  true
)
FROM tasks AS task
WHERE snapshot.workspace_id = task.workspace_id
  AND snapshot.entity_type = 'task'
  AND snapshot.entity_id = task.id
  AND task.canonical_product_id IS NOT NULL
  AND task.listing_id IS NOT NULL
  AND snapshot.payload ? 'inputSnapshot'
  AND (
    snapshot.payload->'inputSnapshot'->>'canonicalProductId' IS DISTINCT FROM task.canonical_product_id
    OR snapshot.payload->'inputSnapshot'->>'listingId' IS DISTINCT FROM task.listing_id
  );
