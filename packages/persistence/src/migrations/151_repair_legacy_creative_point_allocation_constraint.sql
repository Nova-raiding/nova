-- 151_repair_legacy_creative_point_allocation_constraint: migration 150
-- preserves the legacy positive-only check when it renames `points`. Replace
-- that check with the signed allocation contract used by release and settle.

ALTER TABLE creative_point_allocations
  DROP CONSTRAINT IF EXISTS creative_point_allocations_points_check;

DO $creative_point_allocation_constraint$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'creative_point_allocations'::regclass
       AND conname = 'creative_point_allocations_points_delta_check'
  ) THEN
    ALTER TABLE creative_point_allocations
      ADD CONSTRAINT creative_point_allocations_points_delta_check
      CHECK (points_delta <> 0);
  END IF;
END
$creative_point_allocation_constraint$;
