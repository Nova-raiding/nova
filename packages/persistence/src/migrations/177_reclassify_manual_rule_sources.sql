-- 177_reclassify_manual_rule_sources: manual references are internal evidence.
-- They must never be presented as signed official platform imports.
UPDATE rule_pack_versions
   SET source_kind = 'internal',
       updated_at = now()
 WHERE source_kind = 'official'
   AND source_reference LIKE 'manual://%';
