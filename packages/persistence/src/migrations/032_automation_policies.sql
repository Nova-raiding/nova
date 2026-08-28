-- 032_automation_policies: durable, workspace-scoped store automation policy snapshots.
ALTER TABLE business_entity_snapshots
  DROP CONSTRAINT IF EXISTS business_entity_snapshots_entity_type_supported_check;

ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_supported_check
  CHECK (entity_type IN ('product','task','content_version','publish_job','publish_batch','platform_account','generation_job','image_generation_job','brand_profile','asset','feedback','sync_job','automation_policy'));
