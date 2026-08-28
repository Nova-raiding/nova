-- 031_social_commerce_platforms: make the two social-commerce platforms
-- durable without promoting them to production-ready connector evidence.
-- The application still fail-closes their real OAuth/API writes until the
-- platform capability contract is supplied.

DO $$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT c.conrelid::regclass::text AS table_name, c.conname AS constraint_name
    FROM pg_constraint c
    WHERE c.contype = 'c'
      AND c.conrelid IN (
        'platform_accounts'::regclass,
        'products'::regclass,
        'tasks'::regclass,
        'publish_jobs'::regclass,
        'workspace_platform_settings'::regclass
      )
      AND pg_get_constraintdef(c.oid) ILIKE '%pinduoduo%'
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', item.table_name, item.constraint_name);
  END LOOP;

  FOR item IN
    SELECT c.conname AS constraint_name
    FROM pg_constraint c
    WHERE c.conrelid = 'business_entity_snapshots'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) ILIKE '%publish_job%'
  LOOP
    EXECUTE format('ALTER TABLE business_entity_snapshots DROP CONSTRAINT %I', item.constraint_name);
  END LOOP;
END $$;

ALTER TABLE platform_accounts
  ADD CONSTRAINT platform_accounts_platform_supported_check
  CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'));

ALTER TABLE products
  ADD CONSTRAINT products_platform_supported_check
  CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'));

ALTER TABLE tasks
  ADD CONSTRAINT tasks_platform_supported_check
  CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'));

ALTER TABLE publish_jobs
  ADD CONSTRAINT publish_jobs_platform_supported_check
  CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'));

ALTER TABLE workspace_platform_settings
  ADD CONSTRAINT workspace_platform_settings_platform_supported_check
  CHECK (platform IN ('jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'));

ALTER TABLE business_entity_snapshots
  ADD CONSTRAINT business_entity_snapshots_entity_type_supported_check
  CHECK (entity_type IN ('product','task','content_version','publish_job','publish_batch','platform_account','generation_job','image_generation_job','brand_profile','asset','feedback','sync_job','automation_policy'));
