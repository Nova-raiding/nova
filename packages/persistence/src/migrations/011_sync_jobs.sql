-- 011_sync_jobs: durable catalog sync job snapshots and outbox recovery state.
-- Keep this as a forward migration: 009 is already applied in existing
-- environments and its CHECK constraint must be replaced, not edited in place.
ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_check;

ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_check
  CHECK (entity_type IN ('product', 'task', 'content_version', 'publish_job', 'platform_account', 'generation_job', 'brand_profile', 'asset', 'feedback', 'sync_job'));
