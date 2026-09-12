-- 191_rule_pack_category: persist the governance category used to separate
-- platform, category, and advertising/publish policies.
ALTER TABLE rule_pack_versions
  ADD COLUMN IF NOT EXISTS category text
  CHECK (category IS NULL OR category IN ('platform', 'category', 'advertising_publish', 'big_promotion'));

CREATE INDEX IF NOT EXISTS rule_pack_versions_workspace_category_idx
  ON rule_pack_versions (workspace_id, category, status, updated_at DESC);
