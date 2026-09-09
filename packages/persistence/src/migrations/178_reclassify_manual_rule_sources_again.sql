-- 178_reclassify_manual_rule_sources_again: keep bootstrap/manual writes from
-- reintroducing official trust for a manual reference after migration 177.
UPDATE rule_pack_versions
   SET source_kind = 'internal',
       updated_at = now()
 WHERE source_kind = 'official'
   AND source_reference LIKE 'manual://%';
