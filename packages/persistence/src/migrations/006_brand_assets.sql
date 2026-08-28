-- 006_brand_assets: durable brand profile and asset metadata snapshots.
-- Binary objects remain in the configured object store; this table stores only
-- tenant-scoped metadata, rights and quarantine state.
ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_check;
ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_check
  CHECK (entity_type IN ('product', 'task', 'content_version', 'publish_job', 'platform_account', 'generation_job', 'brand_profile', 'asset'));
