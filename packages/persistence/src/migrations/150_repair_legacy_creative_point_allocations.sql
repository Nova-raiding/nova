-- 150_repair_legacy_creative_point_allocations: converge databases that
-- applied the immutable legacy migration 144 with `points` before the current
-- `points_delta` allocation contract was published. Fresh databases already
-- have `points_delta`, so this migration is intentionally a no-op for them.

DO $creative_point_allocation_column$
DECLARE
  has_points BOOLEAN;
  has_points_delta BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'creative_point_allocations'
       AND column_name = 'points'
  ) INTO has_points;
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = 'creative_point_allocations'
       AND column_name = 'points_delta'
  ) INTO has_points_delta;

  IF has_points AND NOT has_points_delta THEN
    ALTER TABLE creative_point_allocations RENAME COLUMN points TO points_delta;
  ELSIF has_points AND has_points_delta THEN
    RAISE EXCEPTION 'creative point allocations contain conflicting points columns'
      USING ERRCODE = '23514';
  ELSIF NOT has_points_delta THEN
    RAISE EXCEPTION 'creative point allocations lack the points_delta column'
      USING ERRCODE = '23514';
  END IF;

  ALTER TABLE creative_point_allocations
    ADD COLUMN IF NOT EXISTS allocation_type TEXT NOT NULL DEFAULT 'reserve'
      CHECK (allocation_type IN ('reserve', 'release', 'settle_adjustment'));
  ALTER TABLE creative_point_allocations ALTER COLUMN allocation_type DROP DEFAULT;
END
$creative_point_allocation_column$;
