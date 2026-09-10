-- 180_remove_creative_point_allocation_granularity_constraint
-- A reservation may allocate and later reverse points against the same grant.
-- Keeping one row per (reservation, grant) incorrectly blocks the append-only
-- negative release/settle-adjustment allocation required by the ledger.
ALTER TABLE creative_point_allocations
  DROP CONSTRAINT IF EXISTS creative_point_allocations_workspace_id_reservation_id_gran_key;
