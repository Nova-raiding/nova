-- migrate:no-transaction
-- 242_repair_creative_point_allocation_reservation_index: restore the lookup
-- index omitted by an unverifiable legacy form of migration 144.
CREATE INDEX CONCURRENTLY IF NOT EXISTS creative_point_allocations_reservation_idx
  ON creative_point_allocations (workspace_id, reservation_id, created_at, id);
